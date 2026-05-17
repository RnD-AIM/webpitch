import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';

vi.mock('../pipeline.js', () => ({
    runPipeline: vi.fn(() => new Promise(() => {})), // never resolves — keeps slot open
}));

import { app, _resetJobState } from '../server.js';

const request = supertest(app);
const SECRET = 'test-secret';

beforeEach(() => {
    _resetJobState();
    vi.clearAllMocks();
});

describe('GET /health', () => {
    it('returns 200 with status:ok', async () => {
        const res = await request.get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

describe('POST /api/analyze — auth', () => {
    it('returns 401 with no secret header', async () => {
        const res = await request.post('/api/analyze').send({ url: 'https://example.com' });
        expect(res.status).toBe(401);
    });

    it('returns 401 with wrong secret', async () => {
        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', 'wrong')
            .send({ url: 'https://example.com' });
        expect(res.status).toBe(401);
    });
});

describe('POST /api/analyze — URL validation', () => {
    it('returns 400 when url is missing', async () => {
        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('url is required');
    });

    it('returns 400 when url is malformed', async () => {
        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({ url: 'not-a-url' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid URL format');
    });

    it('accepts a valid http URL and returns jobId + processing status', async () => {
        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({ url: 'http://example.com' });
        expect(res.status).toBe(200);
        expect(res.body.jobId).toBeTruthy();
        expect(res.body.status).toBe('processing');
    });

    it('accepts a valid https URL', async () => {
        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({ url: 'https://example.com' });
        expect(res.status).toBe(200);
        expect(res.body.jobId).toBeTruthy();
    });
});

describe('POST /api/analyze — slot limiter', () => {
    it('returns 429 when a job is already running', async () => {
        // Acquire the slot (mock never resolves)
        await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({ url: 'https://example.com' });

        const res = await request
            .post('/api/analyze')
            .set('X-Webhook-Secret', SECRET)
            .send({ url: 'https://other.com' });
        expect(res.status).toBe(429);
        expect(res.body.retryAfterSeconds).toBe(2400);
    });
});
