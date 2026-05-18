import express from 'express';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { runPipeline } from './pipeline.js';
import {
    findCompletedJobByUrl,
    findRunningJobByUrl,
    listRecentJobs,
    deleteJobRecord,
} from './storage.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = '/opt/webpitch/output';
const app = express();

// Job slot limiter — max 1 concurrent pipeline
let _jobRunning = false;
app.use(express.json());

app.use('/output', express.static('/opt/webpitch/output'));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Helper: build output URLs for a jobId ────────────────────────────────────
function jobLinks(jobId) {
    const b = process.env.BASE_URL;
    return {
        design1: `${b}/output/${jobId}/design-1/index.html`,
        design2: `${b}/output/${jobId}/design-2/index.html`,
        design3: `${b}/output/${jobId}/design-3/index.html`,
        proposal: `${b}/output/${jobId}/proposal.html`,
        log: `${b}/output/${jobId}/pipeline.log`,
    };
}

// ── POST /api/analyze ────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { url, email, telegramUser } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL format' }); }

    const recipientEmail = email || process.env.DEFAULT_EMAIL;

    // Duplicate detection — return existing links immediately if URL already completed
    const existing = await findCompletedJobByUrl(url);
    if (existing) {
        const links = jobLinks(existing.job_id);
        const when = existing.completed_at
            ? new Date(existing.completed_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'antes';
        return res.json({
            jobId: existing.job_id,
            existing: true,
            businessName: existing.business_name,
            businessType: existing.business_type,
            completedAt: existing.completed_at,
            links,
            message: `Este sitio ya fue procesado el ${when}.\n\nNegocio: ${existing.business_name || url}\n\nDiseno 1: ${links.design1}\nDiseno 2: ${links.design2}\nDiseno 3: ${links.design3}\nPropuesta: ${links.proposal}\n\nPara reprocesarlo: /del ${existing.job_id.slice(0, 8)}`,
        });
    }

    // Check for a job currently running on the same URL
    const running = await findRunningJobByUrl(url);
    if (running) {
        const links = jobLinks(running.job_id);
        return res.status(429).json({
            error: `Este sitio ya esta siendo procesado. Job: ${running.job_id.slice(0, 8)}`,
            jobId: running.job_id,
            logUrl: links.log,
            message: `Este sitio ya esta siendo procesado.\n\nSigue el progreso: ${links.log}`,
        });
    }

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
    const links = jobLinks(jobId);

    res.json({
        jobId,
        status: 'processing',
        existing: false,
        message: `Iniciando analisis de ${url}. Los resultados llegaran al correo ${recipientEmail}.\n\nJob: ${jobId.slice(0, 8)}\nLog: ${links.log}`,
        logUrl: links.log,
    });
});

// ── GET /api/jobs ─────────────────────────────────────────────────────────────
// Returns recent jobs. Used by Telegram /status command via n8n.
app.get('/api/jobs', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const jobs = await listRecentJobs(limit);
    const formatted = jobs.map(j => ({
        ...j,
        shortId: j.job_id.slice(0, 8),
        links: j.status === 'complete' ? jobLinks(j.job_id) : null,
    }));
    res.json({ jobs: formatted });
});

// ── DELETE /api/jobs/:jobId ───────────────────────────────────────────────────
// Deletes output directory + Supabase record so the URL can be reprocessed.
// Accepts either full UUID or the first 8 chars as a short ID.
app.delete('/api/jobs/:jobId', async (req, res) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const raw = req.params.jobId.trim();
    // Validate: alphanumeric + hyphens only (prevents path traversal)
    if (!/^[0-9a-f-]{8,36}$/i.test(raw)) {
        return res.status(400).json({ error: 'Invalid jobId format' });
    }

    // If short ID (8 chars), resolve to full UUID by looking up recent jobs
    let jobId = raw;
    if (raw.length === 8) {
        const recent = await listRecentJobs(20);
        const match = recent.find(j => j.job_id.startsWith(raw));
        if (!match) return res.status(404).json({ error: `No job found starting with "${raw}"` });
        jobId = match.job_id;
    }

    const outputDir = path.join(OUTPUT_DIR, jobId);
    try {
        await rm(outputDir, { recursive: true, force: true });
    } catch (err) {
        console.warn(`Could not delete output dir for ${jobId}:`, err.message);
    }
    await deleteJobRecord(jobId);

    console.log(`[${jobId}] Deleted (output dir + Supabase record).`);
    res.json({
        success: true,
        jobId,
        message: `Job ${jobId.slice(0, 8)} eliminado. Manda la URL de nuevo para reprocesar.`,
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
