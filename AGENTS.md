# AGENTS.md — Webpitch

This file is for AI agents picking up this project cold. Read it before touching any code.

---

## What this system does

Webpitch is an automated website redesign pipeline. A user sends a URL via Telegram. The system:

1. Crawls the site with a real browser (Playwright) — homepage + up to 5 inner pages
2. Analyzes the business with Claude Sonnet (type, audience, strengths/weaknesses, recommended features)
3. Builds a sitemap based on pages actually crawled — not a generic template
4. Enriches all section copy with Claude Haiku (one call per page, grounded in crawled content)
5. Generates 3 complete multi-page HTML/CSS redesigns with AI hero images (Gemini Imagen 4)
6. Generates an HTML proposal document
7. Emails everything via n8n → Gmail SMTP
8. Logs the job to Supabase; duplicate URL detection prevents redundant runs

---

## Live infrastructure

| Resource | Value |
|---|---|
| Server | DigitalOcean droplet, Ubuntu 22.04, `104.131.20.10` |
| Port | 3001 |
| App path | `/opt/webpitch/` |
| Process manager | PM2, app name: `webpitch` |
| Public URL | `https://era.ndi.mx` (reverse proxied to port 3001) |
| n8n instance | `aimkt.app.n8n.cloud` |
| Supabase project | `lsmiknqpuruvgsnttihq` (project: `assistant`) |

**Before touching anything:** `curl http://104.131.20.10:3001/health`

**After any code change:** `scp file root@104.131.20.10:/opt/webpitch/path && ssh root@104.131.20.10 "pm2 restart webpitch --update-env"`

**After `.env` changes only:** `pm2 restart webpitch --update-env`. Plain restart does NOT reload env.

---

## File map

```
/opt/webpitch/
├── server.js               Express HTTP server. See API ENDPOINTS below.
├── pipeline.js             Orchestrates all steps. Writes pipeline.log per job.
│                           Output: /opt/webpitch/output/{jobId}/
├── storage.js              Supabase client. Table: webpitch_jobs.
│                           Functions: logJobStart, logJobComplete, logJobError,
│                                      findCompletedJobByUrl, findRunningJobByUrl,
│                                      listRecentJobs, deleteJobRecord
├── crawler/crawl.js        Playwright Chromium — homepage + multi-page crawl
├── analyze/analyze.js      Claude Sonnet — business analysis → structured JSON
├── design/generate.js      Main design generation. See DESIGN PIPELINE below.
├── proposal/generate.js    Claude Sonnet — two-call: CSS pass + body pass
├── email/send.js           POSTs to N8N_EMAIL_WEBHOOK; n8n sends via Gmail SMTP
└── ui-ux-pro-max/          Design intelligence database (Python + CSV)
    ├── scripts/search.py   BM25 search: python3 search.py "<query>" --domain <d> -n <n>
    │                       Domains: color, typography, style, ux, landing
    └── data/               CSV databases — NOT in repo. Install via:
                            npm install -g uipro-cli && cp -rL $(npm root -g)/uipro-cli/assets/data ui-ux-pro-max/data
```

---

## API endpoints

### `POST /api/analyze`
Auth: `X-Webhook-Secret` header. Body: `{ url, email?, telegramUser? }`

- New job → `{ jobId, status:"processing", existing:false, message, logUrl }`
- Duplicate (URL already completed) → `{ jobId, existing:true, links:{design1,design2,design3,proposal,log}, message }`
- Same URL currently running → HTTP 429 `{ error, jobId, logUrl, message }`
- Pipeline busy → HTTP 429 `{ error, retryAfterSeconds:2400 }`

**Duplicate detection**: queries Supabase for completed job with same URL before starting. Use `/del [shortId]` to force reprocessing.

### `GET /api/jobs?limit=N`
Auth: `X-Webhook-Secret`. Returns recent jobs: `{ jobs: [{ job_id, shortId, url, business_name, status, completed_at, links }] }`

### `DELETE /api/jobs/:jobId`
Auth: `X-Webhook-Secret`. Deletes output directory + Supabase record. Accepts full UUID or 8-char short ID.
Response: `{ success:true, jobId, message }`

---

## Crawler (crawler/crawl.js)

- Loads homepage, waits for networkidle, scrolls full-page to trigger lazy-loading
- Expanded heading selector: `h1, h2, h3, h4, .h1, .h2, .h3, [class*="section-title" i], [class*="entry-title" i], ...`
- Extracts from homepage: title, metaDesc, headings, paragraphs, CTAs, colors (CSS rules + inline), fonts, navLinks, socialLinks, testimonials, imageUrls (up to 15), logoUrl
- Follows internal nav links (up to 5 pages, 15s timeout, skips PDFs/images/hashes)
- Thin inner pages (0 headings AND <3 paragraphs) get a viewport screenshot for Claude vision fallback
- Returns: `{ ...homepageData, screenshot:base64, crawledPages:[...], logoUrl, imageUrls, testimonials }`

---

## Design pipeline (design/generate.js)

```
generateDesigns(analysis, crawlData, outputDir)
│
├── suggestPalettes()              axios.post to Gemini Flash (OpenAI-compat endpoint)
│   fallback: DEFAULT_PALETTES     Sends crawlData.colors for site-specific palette derivation
│
├── queryUXPro() x4 parallel       python3 ui-ux-pro-max/scripts/search.py
│   domains: color, typography,    Results injected into CSS + HTML prompts
│   style, ux
│
├── generateSitemap()
│   ├── decidePagesStructure()     Claude — maps crawled pages to new page list (1024 tokens max)
│   └── generatePageSections() xN  Claude — sections for ONE page (2048 tokens max each)
│       Vision: screenshot attached if inner page was thin
│
├── enrichContent()                Claude Haiku — fills section copy, one call per page (4000 tokens)
│   Saved: content.json            Falls back to abstract sitemap on failure
│
└── [x3 design variants]:
    ├── generateHeroImage()        Gemini Imagen 4 (imagen-4.0-fast-generate-001)
    │   Saved: hero.jpg            On failure → CSS gradient (no external fallback needed)
    │
    ├── generateDesignSystem()     Claude — design.css base styles (no @media) (6000 tokens)
    │   + deterministic append:    microinteraction CSS (card/btn hover, focus ring, link opacity)
    │
    ├── generateResponsiveCSS()    Claude — responsive.css (@media only) (4000 tokens)
    │   + deterministic append:    guaranteed hamburger nav CSS
    │
    └── generatePageHTML() xN     Claude — HTML template with {{placeholders}} (8000 tokens)
        → renderTemplate()         Node.js: injects content from content.json sections
        → GSAP CDN in <head>       gsap.min.js + ScrollTrigger.min.js (defer, cdnjs)
        → buildGallerySection()    index.html only: CSS Grid gallery + <dialog> lightbox
        → buildAnimationScript()   Deterministic GSAP block per section type (see table below)
        → mobile nav JS            Hamburger toggle always injected from Node.js
```

### Template + injection

LLM returns `{{hero.headline}}`, `{{features_grid.items.0.title}}` etc.
`renderTemplate(html, sections)` resolves dot-notation paths from `content.json`.
LLM writes structure only. Content comes from `enrichContent()`.

### GSAP animations (buildAnimationScript)

| Section type | Animation |
|---|---|
| All `section[id^="section-"]` | Fade-in + y:48 slide on scroll enter |
| `hero` + hero.jpg present | backgroundPositionY parallax scrub |
| `features_grid`, `services_cards`, `portfolio_grid`, `team_grid` | Stagger card entrance (scale + y) |
| `story_split` | Text x:-70 left, image x:+70 right |
| `testimonials_grid` | Scale + fade stagger |
| `process_steps` | Sequential x:-40 cascade |
| `stats_band`, `hero` | Counter on `[data-count]` elements |
| `pricing_cards` | back.out easing pop-in |
| `faq_accordion` | Cascade fade on `<details>` |

LLM prompt requires: `id="section-{type}"` on every `<section>`. Stats use `<span data-count="150">150</span>` pattern.

### Gallery (buildGallerySection)

Injected before `<footer>` on index.html when `crawlData.imageUrls.length >= 4`.
Images from the existing site. CSS Grid auto-fill + native `<dialog>` lightbox. No external library.

### Design styles (DESIGN_STYLES in generate.js)

1. **Split Corporate** — White base. 55/45 split hero (text left, hero.jpg right). Alternating feature rows, no cards. Blockquote testimonials. Giant stat numbers (6rem) on dark band.
2. **Dark Statement** — Near-black base. Full-viewport dark hero (hero.jpg at 10% opacity texture). Numbered stacked feature rows (01/02/03 in 5rem accent). Centered testimonial with decorative 8rem open-quote. Light breakout for stats.
3. **Editorial Minimal** — Off-white #fafaf9, Georgia/serif. Pure typography hero (no image in viewport). Numbered table feature rows (thin 1px rules). hero.jpg placed below fold as 16:9 image. 120px section padding.

### Section library (no icons, no emojis)

`hero` · `page_hero` · `trust_strip` (text labels only) · `features_grid` (title+body, no icon) · `stats_band` · `testimonials_grid` · `cta_strip` · `services_cards` · `menu_grid` · `portfolio_grid` · `process_steps` · `team_grid` · `story_split` · `faq_accordion` · `gallery_grid` · `pricing_cards` · `contact_split` · `hours_info`

### Token budgets

| Call | Model | max_tokens |
|---|---|---|
| decidePagesStructure | Sonnet | 1024 |
| generatePageSections | Sonnet | 2048 |
| enrichContent | Haiku | 4000 |
| generateDesignSystem | Sonnet | 6000 |
| generateResponsiveCSS | Sonnet | 4000 |
| generatePageHTML | Sonnet | 8000 |
| generateProposalCSS | Sonnet | 4000 |
| generateProposalBody | Sonnet | 7000 |

**Rule: never raise max_tokens as a fix for truncation. Split the call instead.**

---

## n8n workflows

### `dcB3sel7sjKGRM6S` — Webpitch — Telegram Bot (ACTIVE)

Commands:
- **URL** → `POST /api/analyze` → relay `message` field from response (works for new, existing, busy)
- **`/status`** → `GET /api/jobs?limit=8` → Code node formats → Telegram reply
- **`/del [8charId]`** → `DELETE /api/jobs/:id` → relay `message` from response
- **Anything else** → help text with command list

### `2X6tNjbSvS7zxQeg` — Webpitch — Email Sender (ACTIVE)

Webhook `/webhook/webpitch-job-complete` → emailSend node via "Gmail SMTP" credential (`VKPAqik6o9PxquYa`).

Critical params (confirmed working — do not change):
- `emailFormat: "html"` (not `options.emailType`)
- `html: "={{ $json.body.html }}"` (not `message:`)
- `responseMode: "onReceived"` on the webhook (not `"immediately"`)

---

## Supabase — webpitch_jobs table

```
job_id TEXT UNIQUE        — UUID generated in server.js
url TEXT                  — submitted URL (duplicate detection key)
business_name TEXT        — from analysis step
business_type TEXT        — from analysis step
telegram_user_id TEXT
telegram_username TEXT
telegram_first_name TEXT
proposal_url TEXT         — full URL to proposal.html
email_sent_to TEXT
status TEXT               — 'running' | 'complete' | 'error'
error TEXT                — error message if status='error'
completed_at TIMESTAMPTZ
```

---

## API keys

| Key | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet (analysis, sitemap, CSS, HTML, proposal) + Claude Haiku (enrichment) |
| `GEMINI_API_KEY` | Gemini Flash (palettes, OpenAI-compat endpoint) + Gemini Imagen 4 (hero images) |

`OPENAI_API_KEY` — billing exhausted, not used. Do not add new OpenAI calls.

---

## Known gotchas

**Cloudflare 403 on Anthropic API** — DigitalOcean IPs get intermittently 403'd. `callClaude()` wrapper with exponential backoff is in analyze.js, design/generate.js, and proposal/generate.js. Any new file calling Claude must use this wrapper.

**DigitalOcean blocks outbound SMTP** — ports 25/465/587 blocked. Email goes through n8n cloud.

**Gemini model names (working 2026-05-17)** — palettes: `gemini-flash-latest` on compat endpoint. Images: `imagen-4.0-fast-generate-001`. Other variants 404.

**Hero image in prompt** — do NOT embed base64 in generatePageHTML prompt (caused 3.2M token error). hero.jpg is on disk; HTML references `./hero.jpg`.

**Claude org rate limit** — 4,000 output tokens/min. Do not parallelize HTML page generation.

**PM2 env** — always `pm2 restart webpitch --update-env`.

---

## How to test without Telegram

```bash
# Submit URL
curl -X POST http://104.131.20.10:3001/api/analyze \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: j2bd3xchy6hkckkckhhqtmxmg" \
  -d '{"url":"https://example.com","email":"you@email.com"}'

# List recent jobs
curl http://104.131.20.10:3001/api/jobs \
  -H "X-Webhook-Secret: j2bd3xchy6hkckkckhhqtmxmg"

# Delete a job
curl -X DELETE http://104.131.20.10:3001/api/jobs/388d1b5f \
  -H "X-Webhook-Secret: j2bd3xchy6hkckkckhhqtmxmg"

# Watch logs
ssh root@104.131.20.10 "pm2 logs webpitch --lines 100"
```

---

## Output structure per job

```
/opt/webpitch/output/{jobId}/
├── crawl.json            raw crawler output
├── analysis.json         business analysis
├── sitemap.json          page structure (pre-enrichment)
├── content.json          enriched copy (all pages/sections)
├── pipeline.log          step-by-step with timestamps
├── screenshot-original.png
├── design-1/             Split Corporate
│   ├── design.css + responsive.css + hero.jpg
│   └── index.html, *.html (GSAP + gallery injected)
├── design-2/             Dark Statement
└── design-3/             Editorial Minimal
    └── proposal.html
```

Public access: `https://era.ndi.mx/output/{jobId}/design-1/index.html`

---

## What still needs work

- [ ] `enrichContent` uses homepage-level context for all pages — inner pages could use per-page crawled content for better copy
- [ ] No cleanup of old output directories — grows forever; add cron to delete jobs older than N days
- [ ] `resend.mjs` and `regen.mjs` have hardcoded job IDs — generalize or delete
- [ ] Race condition: two different URLs submitted within milliseconds can both start (BullMQ needed for Phase 2)
