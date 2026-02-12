require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// Konfigurasi via .env
const PORT = process.env.PORT || 4000;
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const QWEN_API_URL =
    process.env.QWEN_API_URL || 'https://portal.qwen.ai/v1/chat/completions';
const ROUTER_API_KEY = process.env.ROUTER_API_KEY; // Optional, jika diset maka request harus bawa Bearer ini

const REFRESH_COMMAND = 'qwen -p "ping"';
const REFRESH_BUFFER_MS =
    parseInt(process.env.REFRESH_BUFFER_MS) || 5 * 60 * 1000;
const CHECK_INTERVAL_MS =
    parseInt(process.env.CHECK_INTERVAL_MS) || 30 * 60 * 1000;

let isRefreshing = false;

/**
 * Fungsi untuk membaca kredensial dari file lokal secara real-time
 */
function getCredentials() {
    try {
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            throw new Error(`File tidak ditemukan di ${CREDENTIALS_PATH}`);
        }
        const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ Error membaca file credentials:', error.message);
        return null;
    }
}

/**
 * Fungsi untuk melakukan refresh token menggunakan CLI
 */
function refreshToken() {
    return new Promise((resolve, reject) => {
        if (isRefreshing) {
            console.log('⏳ Refresh sedang berlangsung, menunggu...');
            // Simple exponential backoff or just wait a bit could be better,
            // but for now we'll just wait 2s and assume it finishes.
            // In production, a proper queue/mutex would be better.
            setTimeout(() => {
                resolve(getCredentials());
            }, 2000);
            return;
        }

        isRefreshing = true;
        console.log(
            `[${new Date().toLocaleTimeString()}] 🔄 Token kadaluwarsa atau hampir habis. Melakukan refresh...`,
        );

        exec(REFRESH_COMMAND, { timeout: 30000 }, (error, stdout, stderr) => {
            isRefreshing = false;

            if (error) {
                console.error(`❌ Gagal refresh token: ${error.message}`);
                console.error(`Stderr: ${stderr}`);
                return reject(error);
            }

            console.log('✅ Token berhasil di-refresh via CLI.');
            resolve(getCredentials());
        });
    });
}

/**
 * Middleware/Helper untuk memastikan token valid sebelum request
 */
async function ensureValidToken() {
    let creds = getCredentials();

    if (!creds) return null;

    // Cek apakah token expired atau mendekati expired
    // expiry_date dalam ms
    if (
        creds.expiry_date &&
        Date.now() + REFRESH_BUFFER_MS > creds.expiry_date
    ) {
        console.log(
            `⚠️ Token expiry: ${new Date(creds.expiry_date).toLocaleTimeString()}. Refreshing...`,
        );
        try {
            creds = await refreshToken();
        } catch (e) {
            console.error(
                '❌ Gagal auto-refresh, mencoba menggunakan token lama sebisa mungkin...',
            );
        }
    }

    return creds;
}

/**
 * Background Service untuk cek token secara berkala
 */
setInterval(async () => {
    console.log(`[Background] Mengecek status token...`);
    await ensureValidToken();
}, CHECK_INTERVAL_MS);

// Endpoint Health Check
app.get('/health', (req, res) => {
    const creds = getCredentials();
    const status = {
        status: 'online',
        server_time: new Date().toISOString(),
        token_exists: !!creds,
        token_expiry:
            creds && creds.expiry_date
                ? new Date(creds.expiry_date).toISOString()
                : null,
        token_valid:
            creds && creds.expiry_date ? Date.now() < creds.expiry_date : false,
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

/**
 * Endpoint Utama: OpenAI Compatible Proxy
 */
app.post('/v1/chat/completions', async (req, res) => {
    // 0. Cek API Key jika diset di .env
    if (ROUTER_API_KEY) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token !== ROUTER_API_KEY) {
            return res
                .status(401)
                .json({ error: 'Unauthorized: Invalid Router API Key' });
        }
    }

    // 1. Pastikan token valid sebelum request
    const creds = await ensureValidToken();

    if (!creds || !creds.access_token) {
        return res
            .status(500)
            .json({ error: 'Gagal mengambil access_token dari lokal.' });
    }

    console.log(
        `[${new Date().toLocaleTimeString()}] Memproses request untuk model: ${req.body.model}`,
    );

    const makeRequest = async (token) => {
        const controller = new AbortController();

        // Batalkan request ke Qwen jika client disconnect
        req.on('close', () => {
            console.log(
                `[${new Date().toLocaleTimeString()}] ⚠️ Client disconnected. Aborting upstream request...`,
            );
            controller.abort();
        });

        return axios({
            method: 'post',
            url: QWEN_API_URL,
            data: req.body,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                // Forward original User-Agent if available for better tracing
                'User-Agent': req.headers['user-agent'] || 'Qwen-Router/1.0',
            },
            responseType: req.body.stream ? 'stream' : 'json',
            signal: controller.signal,
        });
    };

    try {
        const response = await makeRequest(creds.access_token);
        handleResponse(req, res, response);
    } catch (error) {
        // Jika 401 Unauthorized, coba refresh sekali lagi
        if (error.response && error.response.status === 401) {
            console.warn(
                '⚠️ Mendapat 401 Unauthorized. Mengupdate token dan mencoba ulang...',
            );
            try {
                const newCreds = await refreshToken();
                if (newCreds && newCreds.access_token) {
                    const retryResponse = await makeRequest(
                        newCreds.access_token,
                    );
                    handleResponse(req, res, retryResponse);
                    return;
                }
            } catch (refreshError) {
                console.error('❌ Gagal refresh token saat retry 401.');
            }
        }

        await handleError(res, error);
    }
});

function handleResponse(req, res, response) {
    // Penanganan Mode Streaming
    if (req.body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        response.data.pipe(res);

        response.data.on('end', () => {
            console.log('✅ Stream selesai.');
        });

        // Handle error handling in stream
        response.data.on('error', (err) => {
            if (err.name === 'AbortError' || err.message === 'canceled') {
                console.log('⚠️ Stream aborted by client.');
            } else {
                console.error('❌ Stream error:', err.message);
            }
        });
    }
    // Penanganan Mode Normal (Non-Streaming)
    else {
        res.json(response.data);
        console.log('✅ Request sukses.');
    }
}

async function handleError(res, error) {
    if (axios.isCancel(error) || error.name === 'AbortError') {
        console.log('⚠️ Request dibatalkan oleh user (Abort).');
        if (!res.headersSent) {
            return res.status(499).json({ error: 'Client Closed Request' });
        }
        return;
    }

    const status = error.response ? error.response.status : 500;
    let errorData = error.response
        ? error.response.data
        : { error: error.message };

    // Handle Stream Error Response (Axios returns stream in data if responseType is stream)
    if (
        error.response &&
        error.response.data &&
        typeof error.response.data.read === 'function'
    ) {
        try {
            const chunks = [];
            for await (const chunk of error.response.data) {
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks).toString('utf8');
            try {
                errorData = JSON.parse(body);
            } catch (e) {
                errorData = { error: body };
            }
        } catch (e) {
            errorData = {
                error: 'Could not read error stream',
                details: e.message,
            };
        }
    }

    // Gunakan ref log errorData langsung (node akan handle circular ref di console.error)
    // JANGAN JSON.stringify sembarangan jika object kompleks/circular
    console.error(`❌ API Error (${status}):`, errorData);

    if (!res.headersSent) {
        try {
            res.status(status).json(errorData);
        } catch (e) {
            // Fallback jika errorData circular/tidak bisa di-json
            res.status(status).json({
                error: 'Upstream Error',
                details: error.message,
            });
        }
    }
}

// Menjalankan Server
app.listen(PORT, async () => {
    console.log(`
  🚀 Qwen Local Router Aktif!
  ---------------------------------------------------
  URL Endpoint : http://localhost:${PORT}/v1
  API Key       : (Bebas / sk-any)
  Model         : qwen3-coder-plus
  File Path     : ${CREDENTIALS_PATH}
  Background Refresh: Setiap ${CHECK_INTERVAL_MS / 60000} menit
  ---------------------------------------------------
  Tekan CTRL+C untuk berhenti.
    `);

    // Cek token saat startup
    await ensureValidToken();
});
