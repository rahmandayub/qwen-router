# Qwen Router

A lightweight, self-healing local proxy for the Qwen API. It seamlessly handles OAuth token refreshing by integrating with the `qwen` CLI, ensuring your long-running applications never face authentication interruptions.

## Features

- **Automatic Token Refresh**: Proactively checks and refreshes Qwen OAuth tokens using the `qwen` CLI.
- **Smart Retries**: Automatically retries requests on `401 Unauthorized` errors after refreshing credentials.
- **OpenAI Compatible**: Provides a `/v1/chat/completions` endpoint compatible with OpenAI client libraries.
- **Background Health Checks**: Periodically verifies token validity in the background.
- **Secure**: Optional API Key protection for router endpoints.

## Prerequisites

- Node.js (v18+)
- [Qwen CLI](https://github.com/QwenLM/qwen-code) installed and authenticated (`qwen login` or `qwen` interactive login).

## Installation

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd qwen-router
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables:
   Copy `.env.example` to `.env` (or create `.env`):
   ```ini
   PORT=4000
   ROUTER_API_KEY=sk-qwen-router-secret
   # CREDENTIALS_PATH=/path/to/oauth_creds.json (optional)
   # QWEN_API_URL=https://portal.qwen.ai/v1/chat/completions (optional)
   # REFRESH_BUFFER_MS=300000 (optional, default 5 mins)
   # CHECK_INTERVAL_MS=1800000 (optional, default 30 mins)
   ```

## Usage

### Manual Start
```bash
node server.js
```

### Systemd Service (Auto-start)
The router can be managed as a user-level systemd service.

1. Create the service file (already provided in `~/.config/systemd/user/qwen-router.service`):
   ```ini
   [Unit]
   Description=Qwen Router Service
   After=network.target

   [Service]
   Type=simple
   WorkingDirectory=/home/rahmandayub/Tools/qwen-router
   ExecStart=/usr/bin/node server.js
   Restart=always
   Environment=NODE_ENV=production

   [Install]
   WantedBy=default.target
   ```

2. Reload and enable:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now qwen-router
   systemctl --user status qwen-router
   ```

## API Endpoints

- **POST `/v1/chat/completions`**: OpenAI-compatible chat completion endpoint.
  - Requires `Authorization: Bearer <ROUTER_API_KEY>` header if configured.
- **GET `/v1/models`**: List available models for compatibility.
- **GET `/health`**: Check server and token status.

Example Health Check:
```bash
curl http://localhost:4000/health
```
