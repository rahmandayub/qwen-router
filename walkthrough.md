# Qwen Router — Implementation Walkthrough

## Overview

Qwen Router is an Express.js server that exposes an **OpenAI-compatible API** (`/v1/chat/completions`) backed by the Qwen/DashScope API. It replicates the exact HTTP behavior of the Qwen Code CLI (`@qwen-code/qwen-code`) — including DashScope headers, prompt caching, retry logic, and OAuth token management — but runs as a standalone HTTP server that any OpenAI-compatible client (e.g. OpenClaw, Continue, Cursor) can connect to.

---

## Problem Statement

The Qwen Code CLI (`qwen -p "prompt"`) supports chat but **cannot forward tool/function definitions** to the API. The CLI wraps the `-p` argument inside its own ChatML template, so injecting `<tools>` XML tags into the prompt text becomes literal text — the model never receives structured tool definitions.

**Solution:** Bypass the CLI entirely. Use the **OpenAI SDK** to talk to the same DashScope API endpoint (`portal.qwen.ai/v1`) with the same headers and auth that the CLI uses internally. This gives us:

- Native OpenAI tool/function calling support
- DashScope prompt caching (reduces token costs)
- Automatic retry with exponential backoff
- Direct OAuth2 token refresh (no CLI subprocess)

---

## Architecture

```
┌─────────────────────┐
│  OpenAI Client      │  (OpenClaw, curl, any OpenAI SDK)
│  POST /v1/chat/     │
│    completions      │
└─────────┬───────────┘
          │  Bearer sk-router-secret
          ▼
┌─────────────────────┐
│  Qwen Router        │  Express.js @ :4000
│  (server.js)        │
│                     │
│  ┌───────────────┐  │
│  │ Auth Layer    │  │  Validates ROUTER_API_KEY
│  └───────┬───────┘  │
│          ▼          │
│  ┌───────────────┐  │
│  │ Token Manager │  │  Reads ~/.qwen/oauth_creds.json
│  │               │  │  Auto-refreshes via OAuth2 endpoint
│  └───────┬───────┘  │
│          ▼          │
│  ┌───────────────┐  │
│  │ Cache Control │  │  Adds DashScope cache annotations
│  └───────┬───────┘  │
│          ▼          │
│  ┌───────────────┐  │
│  │ OpenAI SDK    │──┼──► portal.qwen.ai/v1/chat/completions
│  │ + DashScope   │  │    (with DashScope headers)
│  │   Headers     │  │
│  └───────────────┘  │
└─────────────────────┘
```

**Key difference from the old hybrid approach:** Previously, requests without tools went through the CLI subprocess and requests with tools went through a direct axios call. Now **all requests** go through the OpenAI SDK with DashScope headers — matching exactly what the CLI does internally.

---

## File Structure

```
qwen-router/
├── server.js          # Main server — all logic in one file
├── proxy.js           # HTTP CONNECT proxy (port 8081, separate concern)
├── .env               # Configuration
├── package.json       # Dependencies
├── walkthrough.md     # This file
└── README.md          # Usage instructions
```

---

## Implementation Details

### 1. Configuration (`server.js` lines 1–28)

```js
const PORT = process.env.PORT || 4000;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const ROUTER_API_KEY = process.env.ROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'coder-model';
```

| Variable                         | Purpose                            | Default       |
| -------------------------------- | ---------------------------------- | ------------- |
| `PORT`                           | Server listen port                 | `4000`        |
| `CREDENTIALS_PATH`               | Path to `~/.qwen/oauth_creds.json` | —             |
| `ROUTER_API_KEY`                 | API key clients must send          | —             |
| `DEFAULT_MODEL`                  | Model when none specified          | `coder-model` |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | Optional TLS                       | —             |

**Hardcoded constants** (extracted from CLI source):

| Constant                     | Value                                               | CLI Source       |
| ---------------------------- | --------------------------------------------------- | ---------------- |
| `QWEN_OAUTH_TOKEN_ENDPOINT`  | `https://chat.qwen.ai/api/v1/oauth2/token`          | `cli.js#L144567` |
| `QWEN_OAUTH_CLIENT_ID`       | `f0304373b74a44d2b584a3fb70ca9e56`                  | `cli.js#L144567` |
| `DEFAULT_DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `cli.js#L141534` |
| `CLI_VERSION`                | `0.10.1`                                            | Package version  |

---

### 2. OAuth Token Management (lines 32–169)

The token lifecycle mirrors the CLI's `SharedTokenManager` (`cli.js#L143666`) and `QwenOAuth2Client` (`cli.js#L144567`).

#### Credential Storage

Credentials are read from `~/.qwen/oauth_creds.json`:

```json
{
    "access_token": "ey...",
    "token_type": "Bearer",
    "refresh_token": "rt-...",
    "resource_url": "portal.qwen.ai",
    "expiry_date": 1770970098349
}
```

#### Token Expiry Check

```js
function getAccessToken() {
    // 5-minute buffer before expiry (matches CLI cli.js#L144810)
    if (now >= (credentials.expiry_date || 0) - 300000) {
        return null; // Triggers refresh
    }
    return credentials.access_token;
}
```

The 300,000ms (5 min) buffer ensures we refresh **before** the token actually expires, avoiding mid-request failures.

#### Direct Token Refresh

Instead of spawning `qwen --version` (old approach), we call the OAuth2 token endpoint directly:

```
POST https://chat.qwen.ai/api/v1/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=f0304373b74a44d2b584a3fb70ca9e56
```

This is faster and doesn't depend on the CLI binary. The refreshed credentials are written back to `oauth_creds.json` so all consumers (including the CLI itself) see the updated token.

#### Concurrency Guard

```js
let refreshLock = null;

async function refreshToken() {
    if (refreshLock) return refreshLock;  // Return existing promise
    refreshLock = (async () => { ... })();
    return refreshLock;
}
```

If multiple requests hit a 401 simultaneously, only one refresh executes. Others await the same promise.

#### Dynamic Base URL

```js
function getApiBaseUrl() {
    const resourceUrl = credentials?.resource_url; // e.g. "portal.qwen.ai"
    // → https://portal.qwen.ai/v1
}
```

The `resource_url` field in credentials determines the API endpoint. This matches the CLI's `getCurrentEndpoint()` at `cli.js#L144783`. If missing, falls back to `dashscope.aliyuncs.com`.

---

### 3. OpenAI SDK Client (lines 171–200)

```js
function createOpenAIClient(token) {
    return new OpenAI({
        apiKey: token,
        baseURL: getApiBaseUrl(), // https://portal.qwen.ai/v1
        timeout: 120000, // 2 min
        maxRetries: 3, // Exponential backoff 0.5s→8s
        defaultHeaders: {
            'User-Agent': 'QwenCode/0.10.1 (linux; x64)',
            'X-DashScope-CacheControl': 'enable',
            'X-DashScope-UserAgent': 'QwenCode/0.10.1 (linux; x64)',
            'X-DashScope-AuthType': 'qwen-oauth',
        },
    });
}
```

**Why these specific headers?**

| Header                             | Purpose                                                             | CLI Source       |
| ---------------------------------- | ------------------------------------------------------------------- | ---------------- |
| `X-DashScope-CacheControl: enable` | Enables DashScope server-side prompt caching                        | `cli.js#L141522` |
| `X-DashScope-UserAgent`            | DashScope-specific client identification                            | `cli.js#L141526` |
| `X-DashScope-AuthType: qwen-oauth` | Tells DashScope this is an OAuth-authenticated request (vs API key) | `cli.js#L141530` |
| `User-Agent`                       | Standard HTTP identification                                        | `cli.js#L141533` |

**Retry behavior** (built into OpenAI SDK v6):

- 3 max retries
- Exponential backoff: 0.5s → 1s → 2s → 4s → 8s
- 25% jitter
- Honors `Retry-After` header from 429 responses

This matches the CLI's retry configuration at `cli.js#L141538`.

---

### 4. DashScope Prompt Caching (lines 207–263)

The `addCacheControl()` function annotates messages with `cache_control: { type: "ephemeral" }` to enable DashScope's prompt caching optimization. This is **only applied when streaming** (matching CLI behavior).

**What gets cached:**

1. **System message** — first system message's content gets `cache_control`
2. **Last user message** — the most recent user message gets `cache_control`
3. **Last tool definition** — the last entry in the `tools[]` array gets `cache_control`

**How it works:**

String content is converted to structured content array format:

```js
// Before:
{ role: "system", content: "You are a helpful assistant" }

// After:
{ role: "system", content: [
    { type: "text", text: "You are a helpful assistant",
      cache_control: { type: "ephemeral" } }
]}
```

**Why this matters:** DashScope's server-side caching can skip re-processing cached prompt segments on subsequent requests. For long system prompts or repeated tool definitions, this significantly reduces latency and token usage. The `prompt_tokens_details.cached_tokens` field in responses shows how many tokens were served from cache.

---

### 5. Request Handler (lines 269–430)

`handleChatCompletion()` is the unified handler for all requests.

#### Flow

```
1. ensureValidToken()     → Get/refresh OAuth token
2. createOpenAIClient()   → Build SDK client with DashScope headers
3. addCacheControl()      → Annotate messages for caching
4. Build requestParams    → Model, messages, tools, metadata
5. executeWithRetry()     → Call API with auth error retry
```

#### Request Metadata

```js
metadata: {
    sessionId: SESSION_ID,    // Per-server-instance UUID
    promptId: promptId,       // Per-request UUID
    channel: 'SDK',           // Identifies as SDK client
}
```

This matches CLI's metadata injection at `cli.js#L141557-L141602`.

#### Parameter Forwarding

All standard OpenAI parameters are forwarded:

- `tools`, `tool_choice`, `functions`, `function_call`
- `max_tokens`, `temperature`, `top_p`, `stop`
- `presence_penalty`, `frequency_penalty`

#### Streaming

For streaming requests:

- `stream: true` and `stream_options: { include_usage: true }` are added
- Response chunks are forwarded as SSE (`text/event-stream`)
- Each chunk is re-wrapped to ensure consistent `id` and `object` fields
- Ends with `data: [DONE]`

#### Auth Error Recovery

```js
if (!isRetry && isAuthError(error)) {
    const newToken = await refreshToken();
    if (newToken) {
        client.apiKey = newToken;
        return executeWithRetry(true); // Retry once
    }
}
```

On 401/403, the handler refreshes the token and retries **once**. This matches the CLI's credential management pattern at `cli.js#L144810-L144830`.

#### Rate Limit Handling

On 429 responses, the `Retry-After` header is forwarded to the client. The OpenAI SDK's built-in retry mechanism also handles 429s automatically (up to 3 retries with backoff).

---

### 6. Endpoints (lines 432–510)

#### `GET /health`

Returns server status including token validity, API base URL, session ID.

#### `GET /v1/models`

Returns a static model list:

- `coder-model` — Default, API resolves to current recommended coder model
- `vision-model` — Multimodal model
- `qwen3-coder-plus` — Explicit model name
- `qwen3-coder-flash` — Faster/cheaper variant

#### `POST /v1/chat/completions`

Main endpoint. Validates `ROUTER_API_KEY`, logs request details, delegates to `handleChatCompletion()`.

---

### 7. Server Startup (lines 512–585)

Supports optional HTTPS via `SSL_KEY_PATH`/`SSL_CERT_PATH`. On startup:

1. Loads SSL certs (if configured)
2. Starts listening on `PORT`
3. Pre-validates OAuth token (triggers refresh if expiring soon)
4. Prints configuration summary

---

## How It Differs from the CLI

| Aspect       | Qwen CLI (`qwen -p`)        | Qwen Router              |
| ------------ | --------------------------- | ------------------------ |
| Tool calling | ❌ Not forwarded            | ✅ Native OpenAI format  |
| Transport    | Subprocess + stdio          | HTTP server              |
| Auth refresh | Spawns `qwen --version`     | Direct OAuth2 HTTP call  |
| API client   | OpenAI SDK (internal)       | OpenAI SDK (same config) |
| Headers      | DashScope headers           | Same DashScope headers   |
| Caching      | `cache_control` annotations | Same annotations         |
| Retry        | 3x exponential backoff      | Same (via SDK)           |
| Rate limits  | No special bypass           | Same behavior            |

**Key insight:** The CLI has no special rate-limit bypass. It uses the same API endpoint with the same auth. The only advantages are proper retry logic, prompt caching headers, and a well-formed User-Agent — all of which this router replicates.

---

## Usage

### Start the server

```bash
node server.js
```

### Test tool calling

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-router-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coder-model",
    "messages": [{"role": "user", "content": "What is the weather in Jakarta?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {"type": "string"}
          },
          "required": ["location"]
        }
      }
    }]
  }'
```

Expected response includes `finish_reason: "tool_calls"` with a `tool_calls` array.

### Test regular chat

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-router-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coder-model",
    "messages": [{"role": "user", "content": "Say hello"}]
  }'
```

### Test streaming

```bash
curl -N -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-router-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "coder-model",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to 5"}]
  }'
```

### Connect from OpenClaw / other clients

Set the API base URL to `http://localhost:4000/v1` and the API key to `sk-router-secret`.

---

## Dependencies

| Package   | Version | Purpose                                      |
| --------- | ------- | -------------------------------------------- |
| `express` | ^5.2.1  | HTTP server                                  |
| `openai`  | ^6.21.0 | OpenAI SDK — API client with retry/streaming |
| `axios`   | ^1.13.5 | OAuth token refresh HTTP calls               |
| `dotenv`  | ^17.2.4 | Environment variable loading                 |

`@qwen-code/qwen-code` is no longer used at runtime — only needed for initial `qwen login` to create `oauth_creds.json`.
