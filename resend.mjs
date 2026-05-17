import { readFile } from 'fs/promises';
import axios from 'axios';

const JOB_ID = '39c571ca-6de3-4fc2-975d-dbc501e73a34';
const BASE_URL = 'http://104.131.20.10:3001';
const N8N_WEBHOOK = process.env.N8N_EMAIL_WEBHOOK;

const analysis = JSON.parse(await readFile(`/opt/webpitch/output/${JOB_ID}/analysis.json`, 'utf8'));

const designs = [
    { index: 1, name: 'Modern & Clean', filename: 'design-1.html', palette: { name: 'Brand Refresh' } },
    { index: 2, name: 'Bold & Dynamic', filename: 'design-2.html', palette: { name: 'Bold & Vibrant' } },
    { index: 3, name: 'Elegant & Trustworthy', filename: 'design-3.html', palette: { name: 'Elegant Minimal' } },
];

const proposalUrl = `${BASE_URL}/output/${JOB_ID}/proposal.html`;
const designLinks = designs.map(d =>
    `<li><a href="${BASE_URL}/output/${JOB_ID}/${d.filename}" style="color:#2563eb">Design ${d.index}: ${d.name}</a> — ${d.palette.name} palette</li>`
).join('');

const weaknesses = analysis.currentWeaknesses.slice(0, 5);
const features = analysis.recommendedFeatures.filter(f => f.priority === 'high').map(f => f.feature);
const contentGaps = analysis.contentGaps.slice(0, 6);

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333}
.header{background:#1e293b;color:white;padding:24px;border-radius:8px 8px 0 0}
.body{background:#f8fafc;padding:24px;border:1px solid #e2e8f0}
.cta{display:inline-block;background:#2563eb;color:white!important;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0}
ul{padding-left:20px}li{margin:6px 0}
.section{background:white;border-radius:6px;padding:16px;margin:12px 0;border:1px solid #e2e8f0}
h3{margin:0 0 8px;color:#1e293b}
</style></head><body>
<div class="header"><h2 style="margin:0">🎨 Webpitch — Proposal Ready</h2><p style="margin:8px 0 0;opacity:0.8">${analysis.businessName} · ${analysis.businessType}</p></div>
<div class="body">
  <p>Your redesign proposal for <strong>${analysis.businessName}</strong> is ready.</p>
  <a href="${proposalUrl}" class="cta">View Full Proposal →</a>
  <div class="section"><h3>📐 3 Design Proposals</h3><ul>${designLinks}</ul></div>
  <div class="section"><h3>🔍 Key Opportunities</h3><ul>${weaknesses.map(w => `<li>${w}</li>`).join('')}</ul></div>
  <div class="section"><h3>⭐ Recommended Features</h3><ul>${features.map(f => `<li>${f}</li>`).join('')}</ul></div>
  <div class="section"><h3>📝 Content Client Needs to Provide</h3><ul>${contentGaps.map(g => `<li>${g}</li>`).join('')}</ul></div>
  <p style="color:#64748b;font-size:13px;margin-top:24px">Job ID: ${JOB_ID} · Webpitch</p>
</div></body></html>`;

const resp = await axios.post(N8N_WEBHOOK, {
    to: 'er@ndi.mx',
    businessName: analysis.businessName,
    jobId: JOB_ID,
    html,
});
console.log('Sent:', resp.status, resp.data);
