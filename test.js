#!/usr/bin/env node
/**
 * test.js — Qwen Router Stress Test
 *
 * Membuktikan hipotesis: 429 "Free allocated quota exceeded" terjadi karena
 * berat request (jumlah tools + panjang messages), bukan karena jumlah request.
 *
 * Test Scenarios:
 *   1. Lightweight burst    — 5x request ringan berturut-turut (tanpa tools)
 *   2. Medium tool request  — 1 tool, short messages
 *   3. Heavy tool request   — 22 tools (seperti OpenClaw), short messages
 *   4. Heavy messages only  — 0 tools, 20+ long messages
 *   5. Maximum payload      — 22 tools + 20 long messages (worst case)
 *   6. Interleaved          — Heavy → Light → Heavy → Light (pola real-world)
 *   7. Concurrent fire      — 3 heavy requests sekaligus (parallel)
 *
 * Usage:
 *   node test.js                    # Run all tests
 *   node test.js --scenario 3       # Run specific scenario
 *   node test.js --base-url http://localhost:4000  # Custom URL
 *   node test.js --api-key sk-xxx   # Custom API key
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ─── Configuration ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = getArg('--base-url', 'http://localhost:4000');
const API_KEY = getArg('--api-key', 'sk-ra171106');
const SPECIFIC_SCENARIO = getArg('--scenario', null);
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// Read OAuth token for direct API tests
const CREDS_PATH = getArg(
    '--creds',
    `${process.env.HOME}/.qwen/oauth_creds.json`,
);
let QWEN_TOKEN = null;
let QWEN_API_BASE = 'https://portal.qwen.ai/v1';
try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
    QWEN_TOKEN = creds.access_token;
    const ru = creds.resource_url;
    if (ru) QWEN_API_BASE = ru.startsWith('http') ? ru : `https://${ru}`;
    if (!QWEN_API_BASE.endsWith('/v1')) QWEN_API_BASE += '/v1';
} catch {}

// ─── Colors ─────────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
};

// ─── Test Data Generators ───────────────────────────────────────────────────

// 22 tools identik dengan yang dikirim OpenClaw
const OPENCLAW_TOOLS = [
    { name: 'read', desc: 'Read file contents from the filesystem' },
    { name: 'edit', desc: 'Edit an existing file by replacing text' },
    { name: 'write', desc: 'Write content to a new or existing file' },
    { name: 'exec', desc: 'Execute a shell command and return output' },
    { name: 'process', desc: 'Manage system processes (list, kill, etc)' },
    { name: 'browser', desc: 'Control a headless browser for web automation' },
    { name: 'canvas', desc: 'Create and manipulate canvas drawings' },
    { name: 'nodes', desc: 'Manage workflow nodes and connections' },
    { name: 'cron', desc: 'Schedule and manage cron jobs' },
    { name: 'message', desc: 'Send messages to users or channels' },
    { name: 'tts', desc: 'Convert text to speech audio' },
    { name: 'gateway', desc: 'Manage API gateway routes and endpoints' },
    { name: 'agents_list', desc: 'List all available AI agents' },
    { name: 'sessions_list', desc: 'List all active chat sessions' },
    { name: 'sessions_history', desc: 'Get chat history for a session' },
    { name: 'sessions_send', desc: 'Send a message to a specific session' },
    { name: 'sessions_spawn', desc: 'Create a new chat session' },
    { name: 'session_status', desc: 'Get status of a specific session' },
    { name: 'web_search', desc: 'Search the web using a query string' },
    { name: 'web_fetch', desc: 'Fetch content from a URL' },
    { name: 'memory_search', desc: 'Search through stored memory entries' },
    { name: 'memory_get', desc: 'Retrieve a specific memory entry by ID' },
];

function makeTool(name, description) {
    return {
        type: 'function',
        function: {
            name,
            description,
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: `Input for ${name}` },
                    options: {
                        type: 'object',
                        description: 'Additional options',
                        properties: {
                            timeout: {
                                type: 'number',
                                description: 'Timeout in ms',
                            },
                            format: {
                                type: 'string',
                                enum: ['json', 'text', 'binary'],
                            },
                            recursive: {
                                type: 'boolean',
                                description: 'Enable recursive mode',
                            },
                        },
                    },
                },
                required: ['input'],
            },
        },
    };
}

function makeTools(count) {
    return OPENCLAW_TOOLS.slice(0, count).map((t) => makeTool(t.name, t.desc));
}

function makeShortMessages(count) {
    const msgs = [{ role: 'system', content: 'You are a helpful assistant.' }];
    for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
            msgs.push({ role: 'user', content: `Short question ${i + 1}` });
        } else {
            msgs.push({ role: 'assistant', content: `Short answer ${i + 1}` });
        }
    }
    msgs.push({ role: 'user', content: 'Say OK in one word.' });
    return msgs;
}

function makeLongMessages(count) {
    const longText = `This is a detailed paragraph that contains multiple sentences to simulate a real conversation with substantial context. It includes technical details about software architecture, API design patterns, error handling strategies, and performance optimization techniques. The purpose is to increase the token count significantly so we can measure how the API handles larger payloads compared to shorter ones. Each message in this conversation history contributes to the overall prompt size that the model must process.`;

    const msgs = [
        {
            role: 'system',
            content:
                'You are an expert software engineer. You help with code reviews, architecture decisions, debugging, and implementation. You follow best practices and write clean, maintainable code. Always explain your reasoning step by step.',
        },
    ];
    for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
            msgs.push({
                role: 'user',
                content: `Question ${i + 1}: ${longText} Please analyze this in detail and provide comprehensive feedback with code examples.`,
            });
        } else {
            msgs.push({
                role: 'assistant',
                content: `Response ${i + 1}: ${longText} Here is my detailed analysis with step-by-step reasoning and implementation suggestions.`,
            });
        }
    }
    msgs.push({
        role: 'user',
        content: 'Summarize everything above in one sentence.',
    });
    return msgs;
}

// ─── Direct Qwen API Client (bypasses router) ──────────────────────────────

function sendDirectRequest(body, { sessionId, headers: extraHeaders } = {}) {
    return new Promise((resolve) => {
        const url = new URL(`${QWEN_API_BASE}/chat/completions`);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Inject metadata with sessionId
        const payload = JSON.stringify({
            ...body,
            metadata: {
                sessionId: sessionId || crypto.randomUUID(),
                promptId: crypto.randomUUID(),
                channel: 'SDK',
            },
        });
        const startTime = Date.now();

        const reqHeaders = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${QWEN_TOKEN}`,
            'User-Agent': 'QwenCode/0.10.1 (linux; x64)',
            'X-DashScope-CacheControl': 'enable',
            'X-DashScope-UserAgent': 'QwenCode/0.10.1 (linux; x64)',
            'X-DashScope-AuthType': 'qwen-oauth',
            ...extraHeaders,
        };

        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: reqHeaders,
                timeout: 30000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    const elapsed = Date.now() - startTime;
                    let parsed = null;
                    try {
                        parsed = JSON.parse(data);
                    } catch {}
                    resolve({
                        status: res.statusCode,
                        elapsed,
                        data: parsed,
                        raw: data,
                        payloadBytes: Buffer.byteLength(payload),
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        rateLimited: res.statusCode === 429,
                    });
                });
            },
        );
        req.on('error', (err) => {
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                data: null,
                raw: err.message,
                payloadBytes: 0,
                ok: false,
                rateLimited: false,
                error: err.message,
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({
                status: 0,
                elapsed: 0,
                data: null,
                raw: 'TIMEOUT',
                payloadBytes: 0,
                ok: false,
                rateLimited: false,
                error: 'timeout',
            });
        });
        req.write(payload);
        req.end();
    });
}

// Direct request WITHOUT metadata and WITHOUT DashScope headers (plain OpenAI style)
function sendDirectRequestRaw(body) {
    return new Promise((resolve) => {
        const url = new URL(`${QWEN_API_BASE}/chat/completions`);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const payload = JSON.stringify(body); // No metadata injected
        const startTime = Date.now();

        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    Authorization: `Bearer ${QWEN_TOKEN}`,
                    // No DashScope headers, no custom User-Agent
                },
                timeout: 30000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    const elapsed = Date.now() - startTime;
                    let parsed = null;
                    try {
                        parsed = JSON.parse(data);
                    } catch {}
                    resolve({
                        status: res.statusCode,
                        elapsed,
                        data: parsed,
                        raw: data,
                        payloadBytes: Buffer.byteLength(payload),
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        rateLimited: res.statusCode === 429,
                    });
                });
            },
        );
        req.on('error', (err) => {
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                data: null,
                raw: err.message,
                payloadBytes: 0,
                ok: false,
                rateLimited: false,
                error: err.message,
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({
                status: 0,
                elapsed: 0,
                data: null,
                raw: 'TIMEOUT',
                payloadBytes: 0,
                ok: false,
                rateLimited: false,
                error: 'timeout',
            });
        });
        req.write(payload);
        req.end();
    });
}

// ─── HTTP Client ────────────────────────────────────────────────────────────

function sendRequest(body) {
    return new Promise((resolve) => {
        const url = new URL(`${BASE_URL}/v1/chat/completions`);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;

        const payload = JSON.stringify(body);
        const startTime = Date.now();

        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    Authorization: `Bearer ${API_KEY}`,
                },
                timeout: 120000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    const elapsed = Date.now() - startTime;
                    let parsed = null;
                    try {
                        // For streaming, collect the last meaningful data line
                        if (body.stream) {
                            const lines = data
                                .split('\n')
                                .filter(
                                    (l) =>
                                        l.startsWith('data: ') &&
                                        l !== 'data: [DONE]',
                                );
                            if (lines.length > 0) {
                                // Get first chunk for model info, count total chunks
                                const firstChunk = JSON.parse(
                                    lines[0].slice(6),
                                );
                                parsed = {
                                    ...firstChunk,
                                    _stream_chunks: lines.length,
                                    _stream: true,
                                };
                            }
                        } else {
                            parsed = JSON.parse(data);
                        }
                    } catch {}

                    resolve({
                        status: res.statusCode,
                        elapsed,
                        data: parsed,
                        raw: data,
                        payloadBytes: Buffer.byteLength(payload),
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        rateLimited: res.statusCode === 429,
                    });
                });
            },
        );

        req.on('error', (err) => {
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                data: null,
                raw: err.message,
                payloadBytes: Buffer.byteLength(payload),
                ok: false,
                rateLimited: false,
                error: err.message,
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                data: null,
                raw: 'TIMEOUT',
                payloadBytes: 0,
                ok: false,
                rateLimited: false,
                error: 'Request timed out',
            });
        });

        req.write(payload);
        req.end();
    });
}

// ─── Result Formatting ──────────────────────────────────────────────────────

function formatResult(label, result) {
    const statusColor = result.ok
        ? C.green
        : result.rateLimited
          ? C.yellow
          : C.red;
    const statusIcon = result.ok ? '✅' : result.rateLimited ? '⚠️ ' : '❌';
    const statusText = result.rateLimited
        ? '429 RATE LIMITED'
        : `${result.status}`;

    const payloadKB = (result.payloadBytes / 1024).toFixed(1);
    const elapsed = (result.elapsed / 1000).toFixed(1);

    let extras = '';
    if (result.data?.usage) {
        const u = result.data.usage;
        const cached = u.prompt_tokens_details?.cached_tokens || 0;
        extras += `  tokens: ${u.prompt_tokens}→${u.completion_tokens}`;
        if (cached > 0) extras += ` (${cached} cached)`;
    }
    if (result.data?.choices?.[0]) {
        const choice = result.data.choices[0];
        const reason =
            choice.finish_reason || choice.delta?.finish_reason || '...';
        extras += `  finish: ${reason}`;
        if (choice.message?.tool_calls) {
            extras += `  tool_calls: ${choice.message.tool_calls.length}`;
        }
    }
    if (result.data?._stream) {
        extras += `  chunks: ${result.data._stream_chunks}`;
    }
    if (result.error) {
        extras += `  error: ${result.error}`;
    }

    console.log(
        `  ${statusIcon} ${C.bold}${label}${C.reset}` +
            `  ${statusColor}${statusText}${C.reset}` +
            `  ${C.dim}${elapsed}s  ${payloadKB}KB${C.reset}` +
            `${C.cyan}${extras}${C.reset}`,
    );

    if (VERBOSE && result.rateLimited) {
        console.log(`     ${C.dim}${result.raw.slice(0, 200)}${C.reset}`);
    }

    return result;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

const scenarios = [];

// Scenario 1: Lightweight burst — 5 rapid requests, no tools
scenarios.push({
    id: 1,
    name: 'Lightweight Burst (5x no tools, rapid)',
    description: 'Buktikan request ringan bisa rapid-fire tanpa 429',
    async run() {
        const results = [];
        for (let i = 0; i < 5; i++) {
            const r = await sendRequest({
                model: 'coder-model',
                messages: [{ role: 'user', content: `Say "${i + 1}" only.` }],
            });
            results.push(formatResult(`Light #${i + 1}`, r));
            // NO delay — rapid fire
        }
        return results;
    },
});

// Scenario 2: Medium tool request — 1 tool
scenarios.push({
    id: 2,
    name: 'Single Tool Request',
    description: '1 tool + short messages — seharusnya masih ringan',
    async run() {
        const r = await sendRequest({
            model: 'coder-model',
            messages: [
                { role: 'user', content: 'What is the weather in Jakarta?' },
            ],
            tools: makeTools(1),
        });
        return [formatResult('1 tool', r)];
    },
});

// Scenario 3: Heavy tool request — 22 tools (OpenClaw style)
scenarios.push({
    id: 3,
    name: 'Heavy Tool Request (22 tools — OpenClaw)',
    description: '22 tools + short messages — ini yang bikin 429',
    async run() {
        const r = await sendRequest({
            model: 'coder-model',
            messages: makeShortMessages(4),
            tools: makeTools(22),
        });
        return [formatResult('22 tools', r)];
    },
});

// Scenario 4: Heavy messages only — 0 tools, 20 long messages
scenarios.push({
    id: 4,
    name: 'Heavy Messages Only (20 long messages, 0 tools)',
    description:
        'Banyak messages panjang tanpa tools — test apakah token count juga trigger 429',
    async run() {
        const r = await sendRequest({
            model: 'coder-model',
            messages: makeLongMessages(20),
        });
        return [formatResult('20 long msgs', r)];
    },
});

// Scenario 5: Maximum payload — 22 tools + 20 long messages
scenarios.push({
    id: 5,
    name: 'Maximum Payload (22 tools + 20 long messages)',
    description: 'Worst case: tools + messages besar — pasti berat',
    async run() {
        const r = await sendRequest({
            model: 'coder-model',
            messages: makeLongMessages(20),
            tools: makeTools(22),
        });
        return [formatResult('22 tools + 20 msgs', r)];
    },
});

// Scenario 6: Interleaved — Heavy → Light → Heavy → Light
scenarios.push({
    id: 6,
    name: 'Interleaved (Heavy → Light → Heavy → Light)',
    description:
        'Simulasi real-world: OpenClaw (berat) + client lain (ringan) bergantian',
    async run() {
        const results = [];

        // Heavy (22 tools) — like OpenClaw
        let r = await sendRequest({
            model: 'coder-model',
            messages: makeShortMessages(8),
            tools: makeTools(22),
        });
        results.push(formatResult('Heavy #1 (22 tools)', r));

        // Light — immediately after
        r = await sendRequest({
            model: 'coder-model',
            messages: [{ role: 'user', content: 'Say hi.' }],
        });
        results.push(formatResult('Light #1 (no tools)', r));

        // 3s pause
        await sleep(3000);

        // Heavy again
        r = await sendRequest({
            model: 'coder-model',
            messages: makeShortMessages(8),
            tools: makeTools(22),
        });
        results.push(formatResult('Heavy #2 (22 tools)', r));

        // Light — immediately after
        r = await sendRequest({
            model: 'coder-model',
            messages: [{ role: 'user', content: 'Say bye.' }],
        });
        results.push(formatResult('Light #2 (no tools)', r));

        return results;
    },
});

// Scenario 7: Concurrent fire — 3 heavy requests in parallel
scenarios.push({
    id: 7,
    name: 'Concurrent Heavy (3x 22-tool requests in parallel)',
    description: 'OpenClaw kadang fire multiple requests sekaligus',
    async run() {
        const promises = [1, 2, 3].map((i) =>
            sendRequest({
                model: 'coder-model',
                messages: makeShortMessages(6),
                tools: makeTools(22),
            }).then((r) => formatResult(`Concurrent #${i}`, r)),
        );
        return await Promise.all(promises);
    },
});

// Scenario 8: Gradual tool escalation — 1, 5, 10, 15, 22 tools
scenarios.push({
    id: 8,
    name: 'Tool Escalation (1 → 5 → 10 → 15 → 22 tools)',
    description: 'Cari threshold: berapa tools yang mulai trigger 429?',
    async run() {
        const counts = [1, 5, 10, 15, 22];
        const results = [];
        for (const count of counts) {
            const r = await sendRequest({
                model: 'coder-model',
                messages: makeShortMessages(4),
                tools: makeTools(count),
            });
            results.push(formatResult(`${count} tools`, r));
            await sleep(2000); // Small gap to not compound rate limits
        }
        return results;
    },
});

// Scenario 9: Streaming vs Non-streaming comparison
scenarios.push({
    id: 9,
    name: 'Streaming vs Non-Streaming (22 tools)',
    description: 'Apakah streaming mempengaruhi rate limit behavior?',
    async run() {
        const results = [];

        // Non-streaming
        let r = await sendRequest({
            model: 'coder-model',
            stream: false,
            messages: makeShortMessages(4),
            tools: makeTools(22),
        });
        results.push(formatResult('Non-stream (22 tools)', r));

        await sleep(3000);

        // Streaming
        r = await sendRequest({
            model: 'coder-model',
            stream: true,
            messages: makeShortMessages(4),
            tools: makeTools(22),
        });
        results.push(formatResult('Stream (22 tools)', r));

        return results;
    },
});

// Scenario 10: Recovery time — after 429, how long until API accepts again?
scenarios.push({
    id: 10,
    name: 'Recovery Time (after 429)',
    description: 'Setelah kena 429, berapa detik sampai API mau lagi?',
    async run() {
        const results = [];

        // Trigger 429 with heavy request
        console.log(
            `  ${C.dim}Triggering rate limit with heavy request...${C.reset}`,
        );
        let r = await sendRequest({
            model: 'coder-model',
            messages: makeLongMessages(10),
            tools: makeTools(22),
        });
        results.push(formatResult('Trigger (heavy)', r));

        if (!r.rateLimited) {
            // If the heavy request didn't get 429'd, fire another immediately
            r = await sendRequest({
                model: 'coder-model',
                messages: makeLongMessages(10),
                tools: makeTools(22),
            });
            results.push(formatResult('Trigger #2 (heavy)', r));
        }

        // Now probe with light requests at increasing intervals
        const intervals = [2, 5, 10, 15, 20, 30];
        for (const wait of intervals) {
            console.log(
                `  ${C.dim}Waiting ${wait}s before probing...${C.reset}`,
            );
            await sleep(wait * 1000);

            r = await sendRequest({
                model: 'coder-model',
                messages: [{ role: 'user', content: 'Say OK.' }],
            });
            results.push(formatResult(`Probe @ +${wait}s (light)`, r));

            if (r.ok) {
                console.log(
                    `  ${C.green}${C.bold}→ API recovered after ~${wait}s${C.reset}`,
                );
                break;
            }
        }

        return results;
    },
});

// Scenario 11: Session ID hypothesis — is rate limit per sessionId?
// Bypasses router, hits Qwen API directly with controlled metadata.
scenarios.push({
    id: 11,
    name: 'Session ID Hypothesis (direct API)',
    description:
        'Test apakah rate limit per sessionId. Kirim 3 request same session, lalu 3 request beda session.',
    async run() {
        if (!QWEN_TOKEN) {
            console.log(
                `  ${C.red}No OAuth token found at ${CREDS_PATH}. Skip.${C.reset}`,
            );
            return [];
        }
        console.log(`  ${C.dim}Direct API: ${QWEN_API_BASE}${C.reset}`);

        const results = [];
        const FIXED_SESSION = crypto.randomUUID();
        const body = {
            model: 'coder-model',
            messages: [{ role: 'user', content: 'Say 1.' }],
        };

        // Part A: Same sessionId — fire 5 rapid requests
        console.log(
            `\n  ${C.bold}Part A: SAME sessionId (${FIXED_SESSION.slice(0, 8)}...)${C.reset}`,
        );
        for (let i = 0; i < 5; i++) {
            const r = await sendDirectRequest(
                {
                    ...body,
                    messages: [{ role: 'user', content: `Say ${i + 1}.` }],
                },
                { sessionId: FIXED_SESSION },
            );
            results.push(formatResult(`Same-session #${i + 1}`, r));
        }

        // Small pause
        console.log(`  ${C.dim}(5s pause)${C.reset}`);
        await sleep(5000);

        // Part B: Different sessionId per request — fire 5 rapid requests
        console.log(
            `\n  ${C.bold}Part B: UNIQUE sessionId per request${C.reset}`,
        );
        for (let i = 0; i < 5; i++) {
            const r = await sendDirectRequest(
                {
                    ...body,
                    messages: [{ role: 'user', content: `Say ${i + 1}.` }],
                },
                { sessionId: crypto.randomUUID() }, // Fresh each time
            );
            results.push(formatResult(`Unique-session #${i + 1}`, r));
        }

        // Analysis
        const partA = results.slice(0, 5);
        const partB = results.slice(5);
        const a429 = partA.filter((r) => r.rateLimited).length;
        const b429 = partB.filter((r) => r.rateLimited).length;

        console.log(`\n  ${C.bold}Results:${C.reset}`);
        console.log(`  Same session:   ${C.yellow}${a429}/5 got 429${C.reset}`);
        console.log(`  Unique session: ${C.yellow}${b429}/5 got 429${C.reset}`);

        if (a429 > b429 + 1) {
            console.log(
                `\n  ${C.bgYellow}${C.bold} HYPOTHESIS CONFIRMED ${C.reset} Rate limit IS per sessionId!`,
            );
            console.log(
                `  ${C.yellow}Fix: Use unique sessionId per request in the router.${C.reset}`,
            );
        } else if (b429 > a429 + 1) {
            console.log(
                `\n  ${C.bgRed}${C.bold} UNEXPECTED ${C.reset} Unique sessions got MORE 429s?!`,
            );
        } else {
            console.log(
                `\n  ${C.bgGreen}${C.bold} NO DIFFERENCE ${C.reset} Rate limit is NOT per sessionId.`,
            );
            console.log(
                `  ${C.dim}Likely per-token or per-IP/account based.${C.reset}`,
            );
        }

        return results;
    },
});

// Scenario 12: No metadata at all — does removing metadata help?
scenarios.push({
    id: 12,
    name: 'No Metadata (direct API)',
    description: 'Kirim request tanpa metadata sama sekali vs dengan metadata.',
    async run() {
        if (!QWEN_TOKEN) {
            console.log(`  ${C.red}No OAuth token found. Skip.${C.reset}`);
            return [];
        }
        console.log(`  ${C.dim}Direct API: ${QWEN_API_BASE}${C.reset}`);

        const results = [];

        // With metadata (like our router sends)
        console.log(`\n  ${C.bold}Part A: WITH metadata${C.reset}`);
        for (let i = 0; i < 3; i++) {
            const r = await sendDirectRequest(
                {
                    model: 'coder-model',
                    messages: [{ role: 'user', content: `Say ${i}.` }],
                },
                { sessionId: 'fixed-test-session-12' },
            );
            results.push(formatResult(`With metadata #${i + 1}`, r));
        }

        console.log(`  ${C.dim}(5s pause)${C.reset}`);
        await sleep(5000);

        // Without metadata — raw request like a plain OpenAI client
        console.log(`\n  ${C.bold}Part B: WITHOUT metadata${C.reset}`);
        for (let i = 0; i < 3; i++) {
            const r = await sendDirectRequestRaw({
                model: 'coder-model',
                messages: [{ role: 'user', content: `Say ${i}.` }],
            });
            results.push(formatResult(`No metadata #${i + 1}`, r));
        }

        const partA = results.slice(0, 3);
        const partB = results.slice(3);
        const a429 = partA.filter((r) => r.rateLimited).length;
        const b429 = partB.filter((r) => r.rateLimited).length;

        console.log(`\n  ${C.bold}Results:${C.reset}`);
        console.log(
            `  With metadata:    ${C.yellow}${a429}/3 got 429${C.reset}`,
        );
        console.log(
            `  Without metadata: ${C.yellow}${b429}/3 got 429${C.reset}`,
        );

        return results;
    },
});

// Scenario 13: DashScope headers test — do headers affect rate limiting?
scenarios.push({
    id: 13,
    name: 'Headers Comparison (direct API)',
    description: 'Same request: dengan DashScope headers vs tanpa.',
    async run() {
        if (!QWEN_TOKEN) {
            console.log(`  ${C.red}No OAuth token found. Skip.${C.reset}`);
            return [];
        }

        const results = [];
        const body = {
            model: 'coder-model',
            messages: [{ role: 'user', content: 'Say hi.' }],
        };

        // With DashScope headers (like our router)
        console.log(`\n  ${C.bold}Part A: WITH DashScope headers${C.reset}`);
        for (let i = 0; i < 3; i++) {
            const r = await sendDirectRequest(
                { ...body, messages: [{ role: 'user', content: `DS ${i}.` }] },
                { sessionId: crypto.randomUUID() },
            );
            results.push(formatResult(`DashScope headers #${i + 1}`, r));
        }

        console.log(`  ${C.dim}(5s pause)${C.reset}`);
        await sleep(5000);

        // Without DashScope headers — plain OpenAI style
        console.log(
            `\n  ${C.bold}Part B: WITHOUT DashScope headers (plain)${C.reset}`,
        );
        for (let i = 0; i < 3; i++) {
            const r = await sendDirectRequestRaw({
                ...body,
                messages: [{ role: 'user', content: `Plain ${i}.` }],
            });
            results.push(formatResult(`Plain headers #${i + 1}`, r));
        }

        const partA = results.slice(0, 3);
        const partB = results.slice(3);
        const a429 = partA.filter((r) => r.rateLimited).length;
        const b429 = partB.filter((r) => r.rateLimited).length;

        console.log(`\n  ${C.bold}Results:${C.reset}`);
        console.log(
            `  DashScope headers: ${C.yellow}${a429}/3 got 429${C.reset}`,
        );
        console.log(
            `  Plain headers:     ${C.yellow}${b429}/3 got 429${C.reset}`,
        );

        return results;
    },
});

// Scenario 14: Token Escalation — prove rolling TPM bucket with graduated payloads
// Sends requests from tiny → huge with recovery waits between each.
// Each request reports estimated token count and whether it succeeded.
// If the API is a rolling TPM bucket, small requests recover faster than large ones.
scenarios.push({
    id: 14,
    name: 'Token Escalation (graduated payload sizes)',
    description:
        'Buktikan rate limit = rolling TPM: small tokens pulih cepat, heavy tokens butuh waktu lama.',
    async run() {
        if (!QWEN_TOKEN) {
            console.log(`  ${C.red}No OAuth token found. Skip.${C.reset}`);
            return [];
        }
        console.log(`  ${C.dim}Direct API: ${QWEN_API_BASE}${C.reset}`);
        console.log(
            `  ${C.dim}Each level waits for quota recovery before sending.${C.reset}\n`,
        );

        const results = [];

        // Define payload tiers — estimated prompt token counts in parentheses
        const tiers = [
            {
                label: '1. Tiny (~20 tokens)',
                messages: [{ role: 'user', content: 'Hi.' }],
                tools: null,
                waitBefore: 60, // Wait 60s first to start clean
            },
            {
                label: '2. Small (~80 tokens)',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    {
                        role: 'user',
                        content: 'What is 2+2? Reply with just the number.',
                    },
                ],
                tools: null,
                waitBefore: 15,
            },
            {
                label: '3. Medium (~300 tokens)',
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an expert software engineer who helps with code reviews, debugging, and architecture decisions. Keep answers concise.',
                    },
                    {
                        role: 'user',
                        content:
                            'I have a Node.js Express server that handles authentication via OAuth2. The token refresh logic sometimes fails under concurrent requests. What is the best pattern to handle this? Consider mutex locks, promise deduplication, and queue-based approaches.',
                    },
                    {
                        role: 'assistant',
                        content:
                            'Use promise deduplication: store the ongoing refresh promise and return it to all concurrent callers. Only one refresh HTTP call happens, and others await the same promise. Clear the promise reference in a finally block.',
                    },
                    {
                        role: 'user',
                        content: 'Show me a code example. Reply in 1 line.',
                    },
                ],
                tools: null,
                waitBefore: 15,
            },
            {
                label: '4. Medium+ (~800 tokens)',
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an expert software engineer who helps with code reviews, debugging, architecture decisions, performance optimization, and security auditing. You follow SOLID principles and write clean, maintainable, well-tested code. Always explain your reasoning step by step with code examples.',
                    },
                    {
                        role: 'user',
                        content:
                            'I am building a rate-limiting middleware for an Express.js API. The requirements are: 1) Token bucket algorithm with configurable burst size and refill rate. 2) Support for per-IP and per-API-key limits. 3) Redis-backed for distributed deployments. 4) Graceful degradation if Redis is down. 5) Proper Retry-After headers. What is the best approach?',
                    },
                    {
                        role: 'assistant',
                        content:
                            'I recommend using a sliding window counter in Redis with MULTI/EXEC for atomicity. For graceful degradation, keep a local in-memory fallback using a Map with TTL. The middleware should check Redis first, fall back to local on connection error, and always set Retry-After headers on 429 responses. Use ioredis with sentinel support for HA.',
                    },
                    {
                        role: 'user',
                        content:
                            'Good approach. Now also consider: How do we handle the case where multiple Node.js instances have different local counters during Redis downtime? And how do we reconcile when Redis comes back? Also, what about WebSocket connections — should they count against the rate limit differently?',
                    },
                    {
                        role: 'assistant',
                        content:
                            'For multi-instance divergence: accept eventual consistency during Redis downtime. Each instance tracks locally, and when Redis recovers, do a best-effort sync by writing the higher of local vs Redis count. For WebSockets: rate-limit the initial upgrade request normally, then use a separate message-rate limiter (e.g., 60 messages/minute) for the connection lifetime.',
                    },
                    {
                        role: 'user',
                        content:
                            'Summarize the full architecture in one sentence.',
                    },
                ],
                tools: null,
                waitBefore: 20,
            },
            {
                label: '5. Heavy (~2000 tokens)',
                messages: makeShortMessages(4),
                tools: makeTools(10),
                waitBefore: 25,
            },
            {
                label: '6. Very Heavy (~3700 tokens)',
                messages: makeShortMessages(8),
                tools: makeTools(22),
                waitBefore: 30,
            },
        ];

        console.log(
            `  ${C.bold}Phase 1: Exhaust quota, then test recovery per tier${C.reset}\n`,
        );

        // First, exhaust the quota to start from a known state
        console.log(
            `  ${C.dim}Exhausting quota with rapid requests...${C.reset}`,
        );
        for (let i = 0; i < 3; i++) {
            const r = await sendDirectRequest(
                {
                    model: 'coder-model',
                    messages: makeShortMessages(8),
                    tools: makeTools(22),
                },
                { sessionId: crypto.randomUUID() },
            );
            formatResult(`Exhaust #${i + 1}`, r);
            if (r.rateLimited) break; // Already exhausted
        }

        // Now test each tier: wait → send → measure
        console.log(
            `\n  ${C.bold}Phase 2: Test each token tier with recovery wait${C.reset}\n`,
        );

        for (const tier of tiers) {
            console.log(
                `  ${C.dim}Waiting ${tier.waitBefore}s for quota recovery...${C.reset}`,
            );
            await sleep(tier.waitBefore * 1000);

            const body = { model: 'coder-model', messages: tier.messages };
            if (tier.tools) body.tools = tier.tools;

            const r = await sendDirectRequest(body, {
                sessionId: crypto.randomUUID(),
            });
            const result = formatResult(tier.label, r);
            results.push(result);
        }

        // Summary analysis
        console.log(`\n  ${C.bold}Analysis:${C.reset}`);
        const tierLabels = tiers.map((t) => t.label);
        let lastOk = -1;
        let firstFail = -1;
        for (let i = 0; i < results.length; i++) {
            if (results[i].ok && lastOk < i) lastOk = i;
            if (results[i].rateLimited && firstFail === -1) firstFail = i;
        }

        const okCount = results.filter((r) => r.ok).length;
        const failCount = results.filter((r) => r.rateLimited).length;

        if (okCount > 0 && failCount > 0 && lastOk < firstFail) {
            console.log(
                `  ${C.bgYellow}${C.bold} CONFIRMED ${C.reset} ${C.yellow}Small tokens recover faster than heavy tokens.${C.reset}`,
            );
            console.log(
                `  ${C.yellow}Last OK: "${tierLabels[lastOk]}" | First 429: "${tierLabels[firstFail]}"${C.reset}`,
            );
            console.log(
                `  ${C.yellow}→ Rolling TPM bucket: small requests fit in partial recovery, heavy ones don't.${C.reset}`,
            );
        } else if (okCount === results.length) {
            console.log(
                `  ${C.bgGreen}${C.bold} ALL PASSED ${C.reset} ${C.green}Quota recovered enough for all tiers (waits were sufficient).${C.reset}`,
            );
            console.log(
                `  ${C.dim}Try reducing waitBefore values to find the threshold.${C.reset}`,
            );
        } else if (failCount === results.length) {
            console.log(
                `  ${C.bgRed}${C.bold} ALL FAILED ${C.reset} ${C.red}Even tiny requests got 429. Quota window may be longer than expected.${C.reset}`,
            );
            console.log(
                `  ${C.dim}Try running again after a full 60s wait.${C.reset}`,
            );
        } else {
            console.log(
                `  ${C.bgYellow}${C.bold} MIXED ${C.reset} Results don't show a clean threshold.`,
            );
            console.log(
                `  ${C.dim}This suggests the rate limit has some randomness or uses a different metric.${C.reset}`,
            );
        }

        return results;
    },
});

// ─── Runner ─────────────────────────────────────────────────────────────────

function printHeader() {
    console.log(`
${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗
║            Qwen Router — Rate Limit Stress Test             ║
╚══════════════════════════════════════════════════════════════╝${C.reset}

  Target    : ${C.bold}${BASE_URL}${C.reset}
  API Key   : ${C.dim}${API_KEY.slice(0, 6)}...${C.reset}
  Verbose   : ${VERBOSE}
  Scenario  : ${SPECIFIC_SCENARIO || 'ALL'}
`);
}

function printSummary(allResults) {
    const total = allResults.length;
    const ok = allResults.filter((r) => r.ok).length;
    const limited = allResults.filter((r) => r.rateLimited).length;
    const failed = allResults.filter((r) => !r.ok && !r.rateLimited).length;
    const totalBytes = allResults.reduce((s, r) => s + r.payloadBytes, 0);

    console.log(`
${C.bold}${C.cyan}══════════════════════════════════════════════════════════════${C.reset}
${C.bold}  SUMMARY${C.reset}
${C.cyan}══════════════════════════════════════════════════════════════${C.reset}
  Total Requests    : ${total}
  ${C.green}✅ Success${C.reset}        : ${ok}
  ${C.yellow}⚠️  Rate Limited${C.reset}  : ${limited}
  ${C.red}❌ Failed${C.reset}         : ${failed}
  Total Payload     : ${(totalBytes / 1024).toFixed(1)} KB
`);

    if (limited > 0) {
        // Analyze which requests got 429'd
        const limitedResults = allResults.filter((r) => r.rateLimited);
        const avgPayload =
            limitedResults.reduce((s, r) => s + r.payloadBytes, 0) /
            limitedResults.length;
        const okResults = allResults.filter((r) => r.ok);
        const avgOkPayload =
            okResults.length > 0
                ? okResults.reduce((s, r) => s + r.payloadBytes, 0) /
                  okResults.length
                : 0;

        console.log(`  ${C.bold}Analisis 429:${C.reset}`);
        console.log(
            `  Avg payload yang kena 429  : ${C.yellow}${(avgPayload / 1024).toFixed(1)} KB${C.reset}`,
        );
        console.log(
            `  Avg payload yang berhasil  : ${C.green}${(avgOkPayload / 1024).toFixed(1)} KB${C.reset}`,
        );

        if (avgPayload > avgOkPayload * 1.5) {
            console.log(
                `\n  ${C.bgYellow}${C.bold} KESIMPULAN ${C.reset} ${C.yellow}Request berat (payload besar / banyak tools) LEBIH SERING kena 429.${C.reset}`,
            );
            console.log(
                `  ${C.yellow}Hipotesis TERBUKTI: Quota dihitung berdasarkan token, bukan jumlah request.${C.reset}`,
            );
        } else {
            console.log(
                `\n  ${C.bgRed}${C.bold} KESIMPULAN ${C.reset} ${C.red}Rate limit tampaknya BUKAN murni berdasarkan berat request.${C.reset}`,
            );
            console.log(
                `  ${C.red}Kemungkinan: time-based rate limit atau kombinasi keduanya.${C.reset}`,
            );
        }
    } else {
        console.log(
            `  ${C.bgGreen}${C.bold} KESIMPULAN ${C.reset} ${C.green}Tidak ada 429 sama sekali. API quota masih cukup.${C.reset}`,
        );
        console.log(
            `  ${C.dim}Coba jalankan lagi atau tambah load untuk trigger rate limit.${C.reset}`,
        );
    }

    console.log();
}

async function runScenario(scenario) {
    console.log(
        `\n${C.bold}${C.magenta}━━━ Scenario ${scenario.id}: ${scenario.name} ━━━${C.reset}`,
    );
    console.log(`  ${C.dim}${scenario.description}${C.reset}\n`);

    try {
        const results = await scenario.run();
        return results;
    } catch (err) {
        console.error(`  ${C.red}Scenario failed: ${err.message}${C.reset}`);
        return [];
    }
}

async function main() {
    printHeader();

    // Health check
    console.log(`${C.dim}Checking server health...${C.reset}`);
    try {
        const healthResult = await sendRequest({
            model: 'coder-model',
            messages: [{ role: 'user', content: 'Ping' }],
        });
        if (!healthResult.ok && !healthResult.rateLimited) {
            console.error(
                `${C.red}Server not reachable: ${healthResult.error || healthResult.status}${C.reset}`,
            );
            console.error(`Make sure the server is running: node server.js`);
            process.exit(1);
        }
        console.log(
            `${C.green}Server OK${C.reset} (${healthResult.elapsed}ms)\n`,
        );
    } catch (e) {
        console.error(
            `${C.red}Cannot connect to ${BASE_URL}: ${e.message}${C.reset}`,
        );
        process.exit(1);
    }

    const allResults = [];

    if (SPECIFIC_SCENARIO) {
        const id = parseInt(SPECIFIC_SCENARIO, 10);
        const scenario = scenarios.find((s) => s.id === id);
        if (!scenario) {
            console.error(
                `${C.red}Scenario ${id} not found. Available: ${scenarios.map((s) => s.id).join(', ')}${C.reset}`,
            );
            process.exit(1);
        }
        const results = await runScenario(scenario);
        allResults.push(...results);
    } else {
        for (const scenario of scenarios) {
            const results = await runScenario(scenario);
            allResults.push(...results);

            // Brief pause between scenarios to reduce noise
            if (scenario.id < scenarios.length) {
                console.log(`  ${C.dim}(3s pause between scenarios)${C.reset}`);
                await sleep(3000);
            }
        }
    }

    printSummary(allResults);
}

main().catch((err) => {
    console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
    process.exit(1);
});
