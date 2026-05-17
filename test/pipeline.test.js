import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

vi.mock('../crawler/crawl.js', () => ({ crawlSite: vi.fn() }));
vi.mock('../analyze/analyze.js', () => ({ analyzeBusiness: vi.fn() }));
vi.mock('../design/generate.js', () => ({ generateDesigns: vi.fn() }));
vi.mock('../proposal/generate.js', () => ({ generateProposal: vi.fn() }));
vi.mock('../email/send.js', () => ({ sendResultEmail: vi.fn() }));
vi.mock('../storage.js', () => ({
    logJobStart: vi.fn(),
    logJobComplete: vi.fn(),
    logJobError: vi.fn(),
}));

import { runPipeline } from '../pipeline.js';
import { crawlSite } from '../crawler/crawl.js';
import { analyzeBusiness } from '../analyze/analyze.js';
import { generateDesigns } from '../design/generate.js';
import { generateProposal } from '../proposal/generate.js';
import { sendResultEmail } from '../email/send.js';
import { logJobStart, logJobComplete, logJobError } from '../storage.js';

const FAKE_CRAWL = { title: 'Test Site', headings: [], paragraphs: [], pages: [] };
const FAKE_ANALYSIS = {
    businessName: 'Test Co',
    businessType: 'Service',
    currentWeaknesses: [],
    recommendedFeatures: [],
    contentGaps: [],
};
const FAKE_DESIGNS = [{ name: 'Design 1', dir: 'design-1' }];

beforeEach(() => {
    vi.clearAllMocks();
    crawlSite.mockResolvedValue(FAKE_CRAWL);
    analyzeBusiness.mockResolvedValue(FAKE_ANALYSIS);
    generateDesigns.mockResolvedValue(FAKE_DESIGNS);
    generateProposal.mockResolvedValue('<html>proposal</html>');
    sendResultEmail.mockResolvedValue(undefined);
    logJobStart.mockResolvedValue(undefined);
    logJobComplete.mockResolvedValue(undefined);
    logJobError.mockResolvedValue(undefined);
});

describe('runPipeline() happy path', () => {
    it('calls logJobStart and logJobComplete, not logJobError', async () => {
        const jobId = randomUUID();
        const result = await runPipeline(jobId, 'https://example.com', 'test@example.com');
        expect(logJobStart).toHaveBeenCalledOnce();
        expect(logJobComplete).toHaveBeenCalledOnce();
        expect(logJobError).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
});

describe('runPipeline() crawl failure', () => {
    it('calls logJobError when crawlSite throws', async () => {
        crawlSite.mockRejectedValue(new Error('Network timeout'));
        const jobId = randomUUID();
        const result = await runPipeline(jobId, 'https://example.com', 'test@example.com');
        expect(logJobError).toHaveBeenCalledOnce();
        expect(logJobError).toHaveBeenCalledWith({ jobId, error: 'Network timeout' });
        expect(result.success).toBe(false);
    });
});

describe('runPipeline() email failure', () => {
    it('calls logJobError when sendResultEmail throws', async () => {
        sendResultEmail.mockRejectedValue(new Error('SMTP error'));
        const jobId = randomUUID();
        const result = await runPipeline(jobId, 'https://example.com', 'test@example.com');
        expect(logJobError).toHaveBeenCalledOnce();
        expect(logJobError).toHaveBeenCalledWith({ jobId, error: 'SMTP error' });
        expect(result.success).toBe(false);
    });
});
