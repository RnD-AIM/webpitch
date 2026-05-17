import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const JOB_ID = '39c571ca-6de3-4fc2-975d-dbc501e73a34';
const OUTPUT_DIR = `/opt/webpitch/output/${JOB_ID}`;

const analysis = JSON.parse(await readFile(path.join(OUTPUT_DIR, 'analysis.json'), 'utf8'));
const crawlData = JSON.parse(await readFile(path.join(OUTPUT_DIR, 'crawl.json'), 'utf8'));

// Import generateDesigns from the updated module
const { generateDesigns } = await import('/opt/webpitch/design/generate.js');

console.log('Regenerating designs for:', analysis.businessName);
const designs = await generateDesigns(analysis, crawlData, OUTPUT_DIR);

console.log('Done. Checking file sizes:');
for (const d of designs) {
    const content = await readFile(path.join(OUTPUT_DIR, d.filename), 'utf8');
    const divCount = (content.match(/<div/g) || []).length;
    console.log(`  ${d.filename}: ${content.length} bytes, ${divCount} divs`);
}
