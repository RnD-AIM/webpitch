import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { crawlSite } from './crawler/crawl.js';
import { analyzeBusiness } from './analyze/analyze.js';
import { generateDesigns } from './design/generate.js';
import { generateProposal } from './proposal/generate.js';
import { sendResultEmail } from './email/send.js';
import { logJobStart, logJobComplete, logJobError } from './storage.js';

const OUTPUT_DIR = '/opt/webpitch/output';
const BASE_URL = process.env.BASE_URL || 'http://104.131.20.10:3001';

export async function runPipeline(jobId, url, recipientEmail, telegramUser = {}) {
    const jobDir = path.join(OUTPUT_DIR, jobId);
    await mkdir(jobDir, { recursive: true });

    const log = (msg) => {
        console.log(`[${jobId}] ${msg}`);
        appendLog(jobDir, msg);
    };

    // Log job start to Supabase (non-blocking — errors are swallowed inside)
    await logJobStart({
        jobId,
        url,
        telegramUserId: telegramUser.id,
        telegramUsername: telegramUser.username,
        telegramFirstName: telegramUser.first_name,
    });

    try {
        log(`Starting pipeline for ${url}`);

        // Step 1: Crawl
        log('Step 1/5: Crawling site...');
        const crawlData = await crawlSite(url);
        await writeFile(path.join(jobDir, 'crawl.json'), JSON.stringify(crawlData, null, 2));
        if (crawlData.screenshot) {
            await writeFile(path.join(jobDir, 'screenshot-original.png'), Buffer.from(crawlData.screenshot, 'base64'));
            delete crawlData.screenshot;
        }
        log(`  Crawled: ${crawlData.title} — ${crawlData.headings.length} headings, ${crawlData.paragraphs.length} paragraphs`);

        // Step 2: Analyze
        log('Step 2/5: Analyzing business...');
        const analysis = await analyzeBusiness(crawlData);
        await writeFile(path.join(jobDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
        log(`  Business: ${analysis.businessName} (${analysis.businessType})`);

        // Step 3: Generate designs
        log('Step 3/5: Generating 3 designs...');
        const designs = await generateDesigns(analysis, crawlData, jobDir);
        log(`  Generated ${designs.length} designs`);

        // Step 4: Generate proposal
        log('Step 4/5: Writing proposal...');
        const proposalHTML = await generateProposal(analysis, designs, crawlData, jobId, BASE_URL);
        await writeFile(path.join(jobDir, 'proposal.html'), proposalHTML);
        log('  Proposal written');

        // Step 5: Email
        log('Step 5/5: Sending email...');
        await sendResultEmail({
            to: recipientEmail,
            businessName: analysis.businessName,
            businessType: analysis.businessType,
            jobId,
            baseUrl: BASE_URL,
            designs,
            weaknesses: analysis.currentWeaknesses,
            features: analysis.recommendedFeatures.filter(f => f.priority === 'high').map(f => f.feature),
            contentGaps: analysis.contentGaps,
        });

        const proposalUrl = `${BASE_URL}/output/${jobId}/proposal.html`;
        await logJobComplete({
            jobId,
            businessName: analysis.businessName,
            businessType: analysis.businessType,
            proposalUrl,
            emailSentTo: recipientEmail,
        });

        log('Pipeline complete!');
        return { success: true, jobId };

    } catch (err) {
        log(`ERROR: ${err.message}\n${err.stack}`);
        await logJobError({ jobId, error: err.message });
        return { success: false, jobId, error: err.message };
    }
}

async function appendLog(jobDir, msg) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
        const { appendFile } = await import('fs/promises');
        await appendFile(path.join(jobDir, 'pipeline.log'), line);
    } catch {}
}
