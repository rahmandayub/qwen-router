require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();

// Konfigurasi via .env
const PORT = process.env.PORT || 4000;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const QWEN_CLI_PATH = process.env.QWEN_CLI_PATH || 'qwen';
const CHECK_INTERVAL_MS = process.env.CHECK_INTERVAL_MS || 1800000; // 30 menit
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const https = require('https');

// Middleware
// ... (middleware code unchanged)

// Middleware
app.use(express.json());

// Token validation is now handled by the CLI itself, but we can keep the file check
async function checkAuthStatus() {
    try {
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            console.error('⚠️ Credentials file not found:', CREDENTIALS_PATH);
            return false;
        }
        return true;
    } catch (error) {
        return false;
    }
}

// Convert OpenAI messages format to a single prompt string
function formatPrompt(messages) {
    let prompt = '';
    for (const msg of messages) {
        // Simple format: Role: Content
        // Qwen CLI usually handles raw text well, but let's try to be structured.
        // We use a simplified chat format.
        if (msg.role === 'system') {
            prompt += `<|im_start|>system\n${msg.content}<|im_end|>\n`;
        } else if (msg.role === 'user') {
            prompt += `<|im_start|>user\n${msg.content}<|im_end|>\n`;
        } else if (msg.role === 'assistant') {
            prompt += `<|im_start|>assistant\n${msg.content}<|im_end|>\n`;
        } else {
            prompt += `\n${msg.role}: ${msg.content}\n`;
        }
    }
    // Append prompt for assistant to start
    prompt += '<|im_start|>assistant\n';
    return prompt;
}

// Endpoint Health Check
app.get('/health', (req, res) => {
    const status = {
        status: 'online',
        server_time: new Date().toISOString(),
        cli_path: QWEN_CLI_PATH,
        credentials_path: CREDENTIALS_PATH,
    };
    res.json(status);
});

// Endpoint List Models (OpenAI Compatible)
app.get('/v1/models', (req, res) => {
    const models = {
        object: 'list',
        data: [
            {
                id: 'qwen3-coder-plus',
                object: 'model',
                created: 1677610602,
                owned_by: 'qwen',
            },
            {
                id: 'qwen3-coder-flash',
                object: 'model',
                created: 1677610602,
                owned_by: 'qwen',
            },
        ],
    };
    res.json(models);
});

// Handler request chat completion
app.post('/v1/chat/completions', async (req, res) => {
    // 1. API Key Validation
    if (ROUTER_API_KEY) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (token !== ROUTER_API_KEY) {
            return res
                .status(401)
                .json({ error: 'Unauthorized: Invalid Router API Key' });
        }
    }

    const { messages, stream, model } = req.body;
    const requestId = crypto.randomUUID();

    console.log(`[${new Date().toLocaleTimeString()}] Request ${requestId}`);
    console.log(`  → Model: ${model}`);

    const prompt = formatPrompt(messages || []);
    console.log(`  → Input Prompt Length: ${prompt.length} chars`);

    // Setup headers for SSE if streaming
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
    } else {
        res.setHeader('Content-Type', 'application/json');
    }

    const controller = new AbortController();

    // Spawn Qwen CLI
    // Usage: qwen -p "PROMPT" --auth-type qwen-oauth --output-format stream-json
    // We use --no-interaction or similar if implied by -p?
    // Based on help: "use -p/--prompt for non-interactive mode"
    const args = [
        '-p',
        prompt,
        '--auth-type',
        'qwen-oauth', // Ensure we use OAuth
        '--output-format',
        'stream-json',
    ];

    if (model) {
        // args.push('--model', model); // Only if user provided model is valid Qwen model ID
        // For safety, let's stick to default or configured model in CLI, or use valid map.
        // But CLI defaults to 'coder-model' which behaves well.
        // Uncomment to pass model: args.push('--model', model);
    }

    console.log(`  → Spawning: ${QWEN_CLI_PATH} ${args.join(' ')}`);

    const child = spawn(QWEN_CLI_PATH, args, {
        signal: controller.signal,
        env: process.env, // Inherit env (PATH, etc)
    });

    let collectedText = '';
    let sentRole = false;

    let buffer = '';

    child.stdout.on('data', (data) => {
        buffer += data.toString();

        let boundary = buffer.indexOf('\n');
        while (boundary !== -1) {
            const line = buffer.substring(0, boundary).trim();
            buffer = buffer.substring(boundary + 1);
            boundary = buffer.indexOf('\n');

            if (!line) continue;

            if (process.env.DEBUG === 'true') {
                console.log(`[CLI RAW]: ${line}`);
            }

            try {
                const json = JSON.parse(line);

                let contentChunk = '';

                if (
                    json.type === 'assistant' &&
                    json.message &&
                    json.message.content
                ) {
                    for (const part of json.message.content) {
                        if (part.type === 'text') {
                            contentChunk += part.text;
                        }
                    }
                } else if (
                    json.type === 'message' &&
                    json.role === 'assistant'
                ) {
                    // Potential alternative format
                    contentChunk += json.content;
                }

                if (contentChunk) {
                    collectedText += contentChunk;

                    if (stream) {
                        const chunkData = {
                            id: requestId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: model,
                            choices: [
                                {
                                    index: 0,
                                    delta: { content: contentChunk },
                                    finish_reason: null,
                                },
                            ],
                        };
                        res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
                    }
                }
            } catch (e) {
                console.log(`[Parse Error]: ${e.message} on line: ${line}`);
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`  [CLI STDERR]: ${data}`);
    });

    child.on('close', (code) => {
        console.log(`  → CLI exited with code ${code}`);
        if (stream) {
            res.write(`data: [DONE]\n\n`);
            res.end();
        } else {
            // Non-streaming response
            res.json({
                id: requestId,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: collectedText },
                        finish_reason: 'stop',
                    },
                ],
                usage: { total_tokens: 0 }, // Dummy usage
            });
        }
    });

    child.on('error', (err) => {
        console.error('  → Failed to start CLI:', err);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to spawn Qwen CLI',
                details: err.message,
            });
        }
    });

    // Close stdin to ensure CLI doesn't wait for input
    child.stdin.end();

    // Handle Client Disconnect
    res.on('close', () => {
        if (child && !child.killed && typeof child.kill === 'function') {
            console.log('⚠️ Cliet disconnected. Killing CLI process...');
            child.kill();
        }
    });
});

// Menjalankan Server
async function startServer() {
    let server;
    let protocol = 'http';

    if (
        SSL_KEY_PATH &&
        SSL_CERT_PATH &&
        fs.existsSync(SSL_KEY_PATH) &&
        fs.existsSync(SSL_CERT_PATH)
    ) {
        try {
            const options = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH),
            };
            server = https.createServer(options, app);
            protocol = 'https';
            console.log('🔒 SSL Certificates loaded successfully.');
        } catch (e) {
            console.error(
                '⚠️ Failed to load SSL certificates, falling back to HTTP:',
                e.message,
            );
            server = require('http').createServer(app);
        }
    } else {
        server = require('http').createServer(app);
    }

    server.listen(PORT, async () => {
        console.log(`
  🚀 Qwen Local Router Aktif!
  ---------------------------------------------------
  URL Endpoint : ${protocol}://localhost:${PORT}/v1
  API Key       : ${ROUTER_API_KEY ? '(Protected)' : '(Public/Open)'}
  Model         : qwen3-coder-plus
  API Base      : (CLI Wrapper Mode)
  Default API   : (Managed by CLI)
  File Path     : ${CREDENTIALS_PATH}
  Background Refresh: (Managed by CLI)
  ---------------------------------------------------
  Tekan CTRL+C untuk berhenti.
        `);

        // Cek token saat startup
        await checkAuthStatus();
    });
}

startServer();
