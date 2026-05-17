// resume.mjs — resumes a partially-completed webpitch pipeline job.
// Usage: node --env-file=/opt/webpitch/.env /opt/webpitch/resume.mjs <jobId> [email]
//
// Reads analysis.json + crawl.json from the job output directory, then runs:
//   generateDesigns → generateProposal → sendResultEmail → logJobComplete
// All design stages skip files that already exist on disk (cache-first logic in generate.js).

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { generateDesigns } from './design/generate.js';
import { generateProposal } from './proposal/generate.js';
import { sendResultEmail } from './email/send.js';
import { logJobComplete } from './storage.js';

const BASE_URL = process.env.BASE_URL || 'http://104.131.20.10:3001';
const jobId = process.argv[2];
const recipientEmail = process.argv[3] || process.env.DEFAULT_EMAIL || 'er@ndi.mx';

if (!jobId) {
    console.error('Usage: node --env-file=/opt/webpitch/.env resume.mjs <jobId> [email]');
    process.exit(1);
}

const outputDir = path.join('/opt/webpitch/output', jobId);

console.log(`\nResuming job ${jobId}`);
console.log(`Output dir: ${outputDir}`);
console.log(`Email: ${recipientEmail}\n`);

let analysis, crawlData;
try {
    analysis = JSON.parse(await readFile(path.join(outputDir, 'analysis.json'), 'utf8'));
    crawlData = JSON.parse(await readFile(path.join(outputDir, 'crawl.json'), 'utf8'));
} catch (err) {
    console.error(`Failed to load analysis/crawl data: ${err.message}`);
    process.exit(1);
}

console.log(`Business: ${analysis.businessName} (${analysis.businessType})`);
console.log(`Site: ${crawlData.url}`);

// Step 1: designs (cache-first — skips any files already on disk)
console.log('\n--- Step 1/3: Generating designs (cache-first) ---');
const designs = await generateDesigns(analysis, crawlData, outputDir);

// Step 2: proposal
console.log('\n--- Step 2/3: Generating proposal ---');
const proposalPath = path.join(outputDir, 'proposal.html');
let proposalHTML;
try {
    proposalHTML = await readFile(proposalPath, 'utf8');
    console.log('  Proposal cached, skipping.');
} catch {
    proposalHTML = await generateProposal(analysis, designs, crawlData, jobId, BASE_URL);
    await writeFile(proposalPath, proposalHTML);
    console.log('  Proposal generated and written.');
}

// Step 3: email
console.log(`\n--- Step 3/3: Sending email to ${recipientEmail} ---`);
await sendResultEmail({
    to: recipientEmail,
    businessName: analysis.businessName,
    businessType: analysis.businessType,
    jobId,
    baseUrl: BASE_URL,
    designs,
    weaknesses: analysis.currentWeaknesses,
    features: (analysis.recommendedFeatures || []).filter(f => f.priority === 'high').map(f => f.feature),
    contentGaps: analysis.contentGaps,
});
console.log('  Email sent.');

// Mark complete in Supabase
const proposalUrl = `${BASE_URL}/output/${jobId}/proposal.html`;
try {
    await logJobComplete({
        jobId,
        businessName: analysis.businessName,
        businessType: analysis.businessType,
        proposalUrl,
        emailSentTo: recipientEmail,
    });
    console.log('  Job logged as complete in Supabase.');
} catch (err) {
    console.log(`  Supabase log failed (${err.message?.slice(0, 60)}) — continuing.`);
}

console.log('\nDone! Pipeline complete.');
