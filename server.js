require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const OpenAI = require('openai');

const app = express();
const https = require('https');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'coder-model';

// Qwen OAuth constants (from CLI source @ cli.js#L144567)
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token';
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const DEFAULT_DASHSCOPE_BASE_URL =
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
const CLI_VERSION = '0.10.1';

// Middleware
app.use(express.json({ limit: '10mb' }));

// ─── OAuth Token Management ─────────────────────────────────────────────────
// Matches CLI's SharedTokenManager (cli.js#L143666) + QwenOAuth2Client (cli.js#L144567)

let credentials = null; // Full credential object
let refreshLock = null; // Prevent concurrent refresh

function readCredentials() {
    try {
        if (!CREDENTIALS_PATH || !fs.existsSync(CREDENTIALS_PATH)) return null;
        credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        return credentials;
    } catch (e) {
        console.error('⚠️ Failed to read credentials:', e.message);
        return null;
    }
}

function writeCredentials(creds) {
    try {
        fs.writeFileSync(
            CREDENTIALS_PATH,
            JSON.stringify(creds, null, 2),
            'utf-8',
        );
        credentials = creds;
        console.log('  ✅ Credentials saved to', CREDENTIALS_PATH);
    } catch (e) {
        console.error('⚠️ Failed to write credentials:', e.message);
    }
}

function getAccessToken() {
    if (!credentials) readCredentials();
    if (!credentials) return null;

    // Check if token needs refresh (5 min buffer, matches CLI cli.js#L144810)
    const now = Date.now();
    if (now >= (credentials.expiry_date || 0) - 300000) {
        // Token expired or about to — caller should refresh
        return null;
    }
    return credentials.access_token;
}

// Resolve API base URL from resource_url in credentials
// Matches CLI logic at cli.js#L144783:
//   getCurrentEndpoint(resourceUrl) → normalize to https://...../v1
function getApiBaseUrl() {
    if (!credentials) readCredentials();
    const resourceUrl = credentials?.resource_url;
    if (!resourceUrl) return DEFAULT_DASHSCOPE_BASE_URL;
    const normalized = resourceUrl.startsWith('http')
        ? resourceUrl
        : `https://${resourceUrl}`;
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

// Direct OAuth token refresh via HTTP (replaces CLI spawn)
// Matches cli.js#L144687-L144728
async function refreshToken() {
    // Prevent concurrent refreshes
    if (refreshLock) return refreshLock;

    refreshLock = (async () => {
        try {
            if (!credentials) readCredentials();
            if (!credentials?.refresh_token) {
                console.error('⚠️ No refresh token available. Run: qwen login');
                return null;
            }

            console.log('🔄 Refreshing OAuth token directly...');

            const response = await axios({
                method: 'POST',
                url: QWEN_OAUTH_TOKEN_ENDPOINT,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                data: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: credentials.refresh_token,
                    client_id: QWEN_OAUTH_CLIENT_ID,
                }).toString(),
                timeout: 30000,
            });

            const tokenData = response.data;
            const newCreds = {
                access_token: tokenData.access_token,
                token_type: tokenData.token_type || 'Bearer',
                refresh_token:
                    tokenData.refresh_token || credentials.refresh_token,
                resource_url:
                    tokenData.resource_url || credentials.resource_url,
                expiry_date: Date.now() + (tokenData.expires_in || 3600) * 1000,
            };

            writeCredentials(newCreds);
            console.log(
                `  ✅ Token refreshed. Expires: ${new Date(newCreds.expiry_date).toISOString()}`,
            );
            return newCreds.access_token;
        } catch (e) {
            const status = e.response?.status;
            const errMsg = e.response?.data?.error_description || e.message;
            console.error(`⚠️ Token refresh failed (${status}): ${errMsg}`);

            // If refresh token is revoked/expired, user must re-login
            if (status === 400 || status === 401) {
                console.error(
                    '❌ Refresh token expired. Please run: qwen login',
                );
            }
            return null;
        } finally {
            refreshLock = null;
        }
    })();

    return refreshLock;
}

// Get a valid token, refreshing if needed
async function ensureValidToken() {
    let token = getAccessToken();
    if (token) return token;

    // Token expired → refresh
    token = await refreshToken();
    return token;
}

async function checkAuthStatus() {
    try {
        readCredentials();
        if (!credentials?.access_token) {
            console.error('⚠️ No credentials found at:', CREDENTIALS_PATH);
            return false;
        }
        const now = Date.now();
        if (now >= (credentials.expiry_date || 0) - 300000) {
            console.log('  Token expires soon, pre-refreshing...');
            await refreshToken();
        }
        return !!credentials?.access_token;
    } catch (error) {
        return false;
    }
}

// ─── OpenAI SDK Client ──────────────────────────────────────────────────────
// Matches CLI's DashScope provider (cli.js#L141534-L141545)

function buildUserAgent() {
    return `QwenCode/${CLI_VERSION} (${process.platform}; ${process.arch})`;
}

function createOpenAIClient(token) {
    const baseURL = getApiBaseUrl();
    const userAgent = buildUserAgent();

    return new OpenAI({
        apiKey: token,
        baseURL: baseURL,
        timeout: 120000, // 2 min (matches CLI: DEFAULT_TIMEOUT = 120000)
        maxRetries: 3, // matches CLI: DEFAULT_MAX_RETRIES = 3
        defaultHeaders: {
            // DashScope headers (cli.js#L141522-L141533)
            'User-Agent': userAgent,
            'X-DashScope-CacheControl': 'enable',
            'X-DashScope-UserAgent': userAgent,
            'X-DashScope-AuthType': 'qwen-oauth',
        },
    });
}

// ─── Session Management ─────────────────────────────────────────────────────

const SESSION_ID = crypto.randomUUID();

// ─── DashScope Prompt Caching ───────────────────────────────────────────────
// The CLI adds cache_control annotations to optimize DashScope prompt caching
// (cli.js#L141610-L141650). This reduces repeated prompt processing costs.

function addCacheControl(messages, tools, isStreaming) {
    if (!isStreaming) return { messages, tools };

    const msgsCopy = messages.map((m) => ({ ...m }));
    const toolsCopy = tools ? tools.map((t) => ({ ...t })) : undefined;

    // Add cache_control to system message content
    for (const msg of msgsCopy) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string') {
                msg.content = [
                    {
                        type: 'text',
                        text: msg.content,
                        cache_control: { type: 'ephemeral' },
                    },
                ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                msg.content = msg.content.map((part, i) =>
                    i === 0
                        ? { ...part, cache_control: { type: 'ephemeral' } }
                        : part,
                );
            }
            break; // Only first system message
        }
    }

    // Add cache_control to last user message content
    for (let i = msgsCopy.length - 1; i >= 0; i--) {
        if (msgsCopy[i].role === 'user') {
            const msg = msgsCopy[i];
            if (typeof msg.content === 'string') {
                msg.content = [
                    {
                        type: 'text',
                        text: msg.content,
                        cache_control: { type: 'ephemeral' },
                    },
                ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                const last = msg.content.length - 1;
                msg.content = msg.content.map((part, i) =>
                    i === last
                        ? { ...part, cache_control: { type: 'ephemeral' } }
                        : part,
                );
            }
            break;
        }
    }

    // Add cache_control to last tool definition
    if (toolsCopy && toolsCopy.length > 0) {
        const lastIdx = toolsCopy.length - 1;
        toolsCopy[lastIdx] = {
            ...toolsCopy[lastIdx],
            cache_control: { type: 'ephemeral' },
        };
    }

    return { messages: msgsCopy, tools: toolsCopy };
}

// ─── Request Handler ────────────────────────────────────────────────────────
// Unified handler for ALL requests (replaces hybrid CLI/API routing).
// Uses OpenAI SDK with DashScope headers — same as Qwen CLI internally.

async function handleChatCompletion(reqBody, requestId, res) {
    // Ensure valid token
    const token = await ensureValidToken();
    if (!token) {
        return res.status(500).json({
            error: {
                message: 'No valid OAuth token. Run: qwen login',
                type: 'auth_error',
            },
        });
    }

    const client = createOpenAIClient(token);
    const stream = !!reqBody.stream;
    const promptId = crypto.randomUUID();

    // Map model — 'coder-model' is the CLI default, API resolves it server-side
    const model = reqBody.model || DEFAULT_MODEL;

    // Build request body matching CLI's pipeline (cli.js#L141951-L141967)
    const { messages: cachedMsgs, tools: cachedTools } = addCacheControl(
        reqBody.messages || [],
        reqBody.tools || null,
        stream,
    );

    const requestParams = {
        model: model,
        messages: cachedMsgs,
        // Metadata (cli.js#L141557-L141602)
        metadata: {
            sessionId: SESSION_ID,
            promptId: promptId,
            channel: 'SDK',
        },
    };

    // Forward all OpenAI-compatible params
    if (cachedTools) requestParams.tools = cachedTools;
    if (reqBody.functions) requestParams.functions = reqBody.functions;
    if (reqBody.tool_choice) requestParams.tool_choice = reqBody.tool_choice;
    if (reqBody.function_call)
        requestParams.function_call = reqBody.function_call;
    if (reqBody.max_tokens) requestParams.max_tokens = reqBody.max_tokens;
    if (reqBody.temperature !== undefined)
        requestParams.temperature = reqBody.temperature;
    if (reqBody.top_p !== undefined) requestParams.top_p = reqBody.top_p;
    if (reqBody.stop) requestParams.stop = reqBody.stop;
    if (reqBody.presence_penalty !== undefined)
        requestParams.presence_penalty = reqBody.presence_penalty;
    if (reqBody.frequency_penalty !== undefined)
        requestParams.frequency_penalty = reqBody.frequency_penalty;

    console.log(`  → API: ${client.baseURL} (model: ${model})`);

    // Wrap in credential management (cli.js#L144810-L144830)
    const executeWithRetry = async (isRetry = false) => {
        try {
            if (stream) {
                // Stream options (cli.js#L141951)
                requestParams.stream = true;
                requestParams.stream_options = { include_usage: true };

                const streamResponse =
                    await client.chat.completions.create(requestParams);

                // Set SSE headers
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                // Pipe SSE chunks to response
                for await (const chunk of streamResponse) {
                    const sseData = {
                        id: chunk.id || requestId,
                        object: 'chat.completion.chunk',
                        created: chunk.created || Math.floor(Date.now() / 1000),
                        model: chunk.model || model,
                        choices: chunk.choices || [],
                        ...(chunk.usage ? { usage: chunk.usage } : {}),
                    };
                    res.write(`data: ${JSON.stringify(sseData)}\n\n`);
                }

                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                const response =
                    await client.chat.completions.create(requestParams);

                // Pass through the response — it's already OpenAI-compatible
                const data = {
                    id: response.id || requestId,
                    object: 'chat.completion',
                    created: response.created || Math.floor(Date.now() / 1000),
                    model: response.model || model,
                    choices: response.choices || [],
                    usage: response.usage || {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                    },
                    system_fingerprint: response.system_fingerprint || null,
                };
                res.json(data);
            }
        } catch (error) {
            // Auth error → refresh and retry once (cli.js#L144810-L144830)
            if (!isRetry && isAuthError(error)) {
                console.log('  → Auth error, refreshing token...');
                const newToken = await refreshToken();
                if (newToken) {
                    // Update client credentials
                    client.apiKey = newToken;
                    client.baseURL = getApiBaseUrl();
                    console.log('  → Retrying with refreshed token...');
                    return executeWithRetry(true);
                }
            }

            // Handle other errors
            const status = error.status || error.response?.status || 500;
            const errMsg = error.message || 'Unknown error';

            console.error(`  → API Error (${status}): ${errMsg}`);

            if (!res.headersSent) {
                if (status === 429) {
                    const retryAfter = error.headers?.['retry-after'];
                    if (retryAfter) res.setHeader('Retry-After', retryAfter);
                }
                res.status(status).json({
                    error: {
                        message: errMsg,
                        type: error.type || 'api_error',
                        code: error.code || null,
                    },
                });
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    };

    // Handle client disconnect
    let aborted = false;
    res.on('close', () => {
        if (!res.writableEnded) aborted = true;
    });

    return executeWithRetry();
}

function isAuthError(error) {
    const status = error.status || error.response?.status;
    return status === 401 || status === 403;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    if (!credentials) readCredentials();
    const baseUrl = getApiBaseUrl();
    const tokenOk = !!getAccessToken();
    res.json({
        status: 'online',
        server_time: new Date().toISOString(),
        credentials_path: CREDENTIALS_PATH,
        token_available: tokenOk,
        token_expires: credentials?.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : null,
        api_base: baseUrl,
        user_agent: buildUserAgent(),
        session_id: SESSION_ID,
    });
});

app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: 'coder-model',
                object: 'model',
                created: 1677610602,
                owned_by: 'qwen',
            },
            {
                id: 'vision-model',
                object: 'model',
                created: 1677610602,
                owned_by: 'qwen',
            },
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
    });
});

// Unified handler — all requests use direct API via OpenAI SDK
app.post('/v1/chat/completions', async (req, res) => {
    // API Key Validation
    if (ROUTER_API_KEY) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token !== ROUTER_API_KEY) {
            return res
                .status(401)
                .json({
                    error: { message: 'Unauthorized: Invalid Router API Key' },
                });
        }
    }

    const { messages, stream, model, tools, functions, tool_choice } = req.body;
    const requestId = `chatcmpl-${crypto.randomUUID()}`;

    console.log(`\n[${new Date().toLocaleTimeString()}] Request ${requestId}`);
    console.log(
        `  → Model: ${model || DEFAULT_MODEL}, Stream: ${!!stream}, Messages: ${(messages || []).length}`,
    );

    if (Array.isArray(tools) && tools.length > 0) {
        const toolNames = tools.map((t) => t.function?.name).filter(Boolean);
        console.log(`  → Tools: ${toolNames.join(', ')}`);
    }
    if (tool_choice)
        console.log(`  → Tool Choice: ${JSON.stringify(tool_choice)}`);

    return handleChatCompletion(req.body, requestId, res);
});

// ─── Server Startup ─────────────────────────────────────────────────────────

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
        const tokenOk = await checkAuthStatus();
        const baseUrl = getApiBaseUrl();
        console.log(`
  🚀 Qwen Router Active!
  ---------------------------------------------------
  Endpoint       : ${protocol}://localhost:${PORT}/v1
  API Key        : ${ROUTER_API_KEY ? '(Protected)' : '(Public/Open)'}
  Qwen API Base  : ${baseUrl}
  OAuth Token    : ${tokenOk ? '✅ Valid' : '❌ Missing/Invalid'}
  Token Expires  : ${credentials?.expiry_date ? new Date(credentials.expiry_date).toISOString() : 'N/A'}
  Default Model  : ${DEFAULT_MODEL}
  User-Agent     : ${buildUserAgent()}
  Session ID     : ${SESSION_ID}
  ---------------------------------------------------
  Uses OpenAI SDK with DashScope headers (same as Qwen CLI)
  • Auto retries: 3x with exponential backoff (0.5s→8s)
  • Auto token refresh via direct OAuth2 (no CLI spawn)
  • DashScope prompt caching enabled for streaming
  • Native tool/function calling support
  ---------------------------------------------------
  Press CTRL+C to stop.
        `);
    });
}

startServer();
