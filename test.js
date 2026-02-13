const OpenAI = require('openai');
const fs = require('fs');

const CREDENTIALS_PATH = '/home/rahmandayub/.qwen/oauth_creds.json';
const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

const client = new OpenAI({
    apiKey: creds.access_token,
    baseURL: 'https://portal.qwen.ai/v1',
});

async function main() {
    try {
        console.log('Sending request to portal.qwen.ai...');
        const completion = await client.chat.completions.create({
            messages: [{ role: 'user', content: 'Say hello' }],
            model: 'qwen3-coder-plus',
        });

        console.log(completion.choices[0]);
    } catch (e) {
        console.error('Error:', e);
    }
}

main();
