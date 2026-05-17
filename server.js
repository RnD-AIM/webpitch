import express from 'express';
import { randomUUID } from 'crypto';
import { runPipeline } from './pipeline.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Job slot limiter — max 1 concurrent pipeline
let _jobRunning = false;
app.use(express.json());

app.use('/output', express.static('/opt/webpitch/output'));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/analyze', (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { url, email, telegramUser } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL format' }); }

    const recipientEmail = email || process.env.DEFAULT_EMAIL;
    if (_jobRunning) {
        return res.status(429).json({ error: 'Pipeline busy. Try again in ~40 minutes.', retryAfterSeconds: 2400 });
    }
    _jobRunning = true;
    const jobId = randomUUID();

    runPipeline(jobId, url, recipientEmail, telegramUser || {}).then(() => { _jobRunning = false; }).catch(err => {
        console.error(`Pipeline failed for job ${jobId}:`, err.message);
        _jobRunning = false;
    });

    console.log(`[${jobId}] Started pipeline for ${url} → ${recipientEmail}`);

    res.json({
        jobId,
        status: 'processing',
        message: `Analysis started for ${url}. Results will be emailed to ${recipientEmail}.`,
        logUrl: `http://104.131.20.10:3001/output/${jobId}/pipeline.log`,
    });
});

export { app };
export function _resetJobState() { _jobRunning = false; }

const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`Webpitch server running on port ${PORT}`);
    });
}
