# Webpitch

Send a URL via Telegram. Get 3 complete multi-page website redesigns + a proposal document emailed back within ~15 minutes.

Built for pitching website redesign services — drop a client's URL, walk away, come back to a full proposal ready to send.

---

## What it produces

For any URL submitted:

1. **Site analysis** — business type, audience, weaknesses, competitive advantage, recommended features
2. **Sitemap** — 3–5 pages chosen based on the actual business (a pizzeria gets Home + Menu + About + Contact, not a generic Services page)
3. **Content** — GPT-4o-mini rewrites and enriches all copy, grounded in crawled content
4. **3 design variants**, each with:
   - `design.css` — shared design system (typography, colors, layout utilities, components)
   - `index.html`, `menu.html`, `about.html`, `contact.html` (or whatever pages fit)
   - `hero.jpg` — AI-generated hero background (gpt-image-1, Gemini Imagen 3 fallback, CSS gradient last resort)
5. **Proposal HTML** — professional redesign pitch with links to all 3 designs
6. **Email** via n8n SMTP — proposal + design links delivered to inbox

---

## Architecture

```
Telegram message (URL)
  → n8n "Webpitch — Telegram Bot" workflow
      → POST /api/analyze  (Express server, port 3001)
          → pipeline.js (orchestrates all steps)
              1. crawlSite()          crawler/crawl.js       Playwright, follows nav links, vision fallback for image pages
              2. analyzeContent()     analyze/analyze.js     Claude Sonnet — business analysis JSON
              3. generateDesigns()    design/generate.js     See design pipeline below
              4. generateProposal()   proposal/generate.js   Claude Sonnet — HTML proposal doc
              5. sendResultEmail()    email/send.js          POST to n8n email webhook
              6. logJobComplete()     storage.js             Supabase webpitch_jobs table
  → n8n "Webpitch — Email Sender" workflow
      → emailSend node (Gmail SMTP) → inbox
```

### Design pipeline (design/generate.js)

```
queryUXPro()        4x parallel Python calls to ui-ux-pro-max search.py
                    → color palette, typography, UI style, UX guidelines for this business type

suggestPalettes()   Gemini 1.5 Flash → 3 color palette suggestions (fallback: DEFAULT_PALETTES)

generateSitemap()   Two-phase, no token overflow risk:
  decidePagesStructure()   Claude — maps crawled pages to new page list (~300 token output)
  generatePageSections()   Claude — sections for ONE page at a time (~1000 token output each)

enrichContent()     GPT-4o-mini — fills all section text across all pages in one call
                    → saved as content.json (reusable, inspectable)

[×3 design variants]:
  generateHeroImage()      gpt-image-1 → Gemini Imagen 3 → CSS gradient fallback
  generateDesignSystem()   Claude — shared CSS with ux-pro-max intelligence injected
  generatePageHTML() ×N    Claude — layout-only (content pre-written), 16k tokens each
```

---

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js ESM, Express, PM2 |
| Browser automation | Playwright (Chromium) |
| LLMs | Claude Sonnet 4.6 (analysis, design, proposal), GPT-4o-mini (content), Gemini 1.5 Flash (palettes) |
| Image generation | OpenAI gpt-image-1 (primary), Gemini Imagen 3 (fallback) |
| Design intelligence | ui-ux-pro-max (Python, BM25 search over 67 styles / 161 palettes / 57 font pairings) |
| Email | n8n cloud → Gmail SMTP |
| Job logging | Supabase (`webpitch_jobs` table) |
| Infrastructure | DigitalOcean droplet (Ubuntu 22.04), 104.131.20.10, port 3001 |

---

## Prerequisites

- Node.js 20+ (project uses ESM throughout)
- Python 3.x (for ui-ux-pro-max design intelligence — no pip dependencies)
- Playwright Chromium: `npx playwright install chromium`
- PM2: `npm install -g pm2`
- A running n8n instance (cloud or self-hosted) with two workflows configured (see n8n Setup)
- Supabase project with `webpitch_jobs` table (see Database Setup)

---

## Installation

```bash
git clone https://github.com/YOUR_ORG/webpitch.git /opt/webpitch
cd /opt/webpitch

npm install
npx playwright install chromium

cp .env.example .env
# Fill in all values in .env

# Install ui-ux-pro-max data (the CSV datasets are not in the repo — fetch via npm)
npm install -g uipro-cli
cp -rL $(npm root -g)/uipro-cli/assets/data ui-ux-pro-max/data

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
```

### Verify

```bash
curl http://localhost:3001/health
# → {"status":"ok","timestamp":"..."}
```

---

## Environment variables

See `.env.example` for all required variables with descriptions.

**Critical notes:**
- `BASE_URL` must be the publicly accessible URL of the server (used in email links)
- `WEBHOOK_SECRET` must match what n8n sends in the `X-Webhook-Secret` header
- PM2 loads env via `node --env-file=/opt/webpitch/.env server.js` — always restart with `--update-env` after `.env` changes

---

## n8n Setup

Two workflows are required. Import them manually or recreate from the specs below.

### Workflow 1: Webpitch — Telegram Bot

**Trigger:** Telegram webhook  
**Nodes:**
1. **Telegram Trigger** — receives messages
2. **Extract URL** (Code node) — parses URL from message text, extracts `telegramUser` object `{ id, username, first_name, last_name }`
3. **IF has URL** — branches on `hasUrl`
4. **Call Webpitch** (HTTP Request) — `POST ${BASE_URL}/api/analyze`, body: `{ url, email: "your@email.com", telegramUser }`
5. **Reply to Telegram** — sends job ID confirmation back

### Workflow 2: Webpitch — Email Sender

**Trigger:** Webhook at `/webhook/webpitch-job-complete`, `responseMode: "onReceived"`  
**Nodes:**
1. **emailSend** (SMTP, v2.1+) — credential type `smtp`, params:
   - `fromEmail`: your sender address
   - `toEmail`: `={{ $json.body.to }}`
   - `emailFormat`: `"html"`
   - `html`: `={{ $json.body.html }}`
   - `subject`: `={{ 'Webpitch — ' + $json.body.businessName }}`

**Known n8n gotcha:** `responseMode: "immediately"` is invalid in current n8n — use `"onReceived"`.

---

## Database Setup (Supabase)

```sql
CREATE TABLE webpitch_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    business_name TEXT,
    business_type TEXT,
    telegram_user_id TEXT,
    telegram_username TEXT,
    telegram_first_name TEXT,
    proposal_url TEXT,
    email_sent_to TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
```

---

## API

### `POST /api/analyze`

Starts a pipeline job. Returns immediately with a job ID; pipeline runs async.

**Headers:** `X-Webhook-Secret: <WEBHOOK_SECRET>`

**Body:**
```json
{
  "url": "https://example.com",
  "email": "recipient@example.com",
  "telegramUser": { "id": 123, "username": "handle", "first_name": "Name" }
}
```

**Response:**
```json
{ "jobId": "uuid", "status": "processing", "message": "Pipeline started" }
```

### `GET /health`

Returns `{ "status": "ok", "timestamp": "..." }`.

---

## Output structure

Each job writes to `/opt/webpitch/output/{jobId}/`:

```
output/{jobId}/
├── crawl.json          Raw crawler output (all pages, colors, fonts, nav links)
├── analysis.json       Claude business analysis
├── content.json        GPT-4o-mini enriched copy for all pages/sections
├── pipeline.log        Step-by-step log with timestamps
├── proposal.html       Full redesign proposal document
├── design-1/
│   ├── design.css      Shared CSS design system (Modern & Bold)
│   ├── index.html
│   ├── [page2].html
│   ├── ...
│   └── hero.jpg        AI-generated hero background (if successful)
├── design-2/           (Dark & Dramatic)
└── design-3/           (Editorial & Warm)
```

All files are served statically at `http://{BASE_URL}/output/{jobId}/`.

---

## PM2 management

```bash
pm2 status
pm2 logs webpitch --lines 50
pm2 restart webpitch --update-env   # required after .env changes
pm2 stop webpitch
```

The ecosystem config uses `node --env-file=/opt/webpitch/.env server.js` — do not switch to PM2's `env_file` option (it was unreliable in testing).

---

## Cloudflare 403 on Anthropic API

DigitalOcean droplet IPs are intermittently blocked by Cloudflare when accessing `api.anthropic.com`. Retry logic is built into `analyze/analyze.js` and `design/generate.js` (60s wait on first retry, 120s on second). **Not yet added to `proposal/generate.js`** — add if you see 403s there.

---

## ui-ux-pro-max design intelligence

The `ui-ux-pro-max/` directory contains a Python BM25 search engine over CSV databases of:
- 67 UI styles (glassmorphism, brutalism, editorial, etc.) with CSS keywords and AI prompts
- 161 industry-specific color palettes
- 57 typography pairings with Google Fonts imports
- UX guidelines and anti-patterns by product type

Called 4× per job (color, typography, style, UX domains) before CSS/HTML generation. Results are injected into Claude prompts to ground designs in industry-appropriate decisions.

The CSV data files are not in this repo (too large). Install them:
```bash
npm install -g uipro-cli
cp -rL $(npm root -g)/uipro-cli/assets/data ui-ux-pro-max/data
```

Or clone the full skill repo: `git clone https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Email arrives empty (270 bytes) | emailSend node wrong params | Use `emailFormat: "html"` + `html:` not `message:` |
| n8n webhook 500 on trigger | `responseMode: "immediately"` invalid | Change to `"onReceived"` |
| Designs white/no body content | Claude hit token limit before `<body>` | max_tokens is 16000 — check prompt size |
| Gemini palettes 404 | Wrong model name | Use `gemini-1.5-flash` not `gemini-2.0-flash` |
| Hero image fails silently | gpt-image-1 access / Imagen access | Check API key permissions; CSS gradient kicks in automatically |
| Sitemap JSON truncated | Output too large for one call | Sitemap is split into decidePagesStructure + per-page calls — should not happen |
| PM2 env vars not loading | Restarted without `--update-env` | Always `pm2 restart webpitch --update-env` |
| SSH connection refused (intermittent) | DigitalOcean rate-limits SSH | Wait 30–60s and retry |
