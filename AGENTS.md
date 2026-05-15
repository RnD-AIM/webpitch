# AGENTS.md — Webpitch

This file is for AI agents picking up this project cold. Read it before touching any code.

---

## What this system does

Webpitch is an automated website redesign pipeline. A user sends a URL via Telegram. The system:

1. Crawls the site with a real browser (Playwright), following nav links, capturing per-page content
2. Analyzes the business with Claude (type, audience, strengths/weaknesses, recommended features)
3. Builds a sitemap based on what pages were actually crawled — not a generic template
4. Enriches all section copy with GPT-4o-mini (one call for all pages, grounded in crawled content)
5. Generates 3 complete multi-page HTML/CSS redesigns with AI hero images
6. Generates an HTML proposal document
7. Emails everything via n8n → Gmail SMTP
8. Logs the job to Supabase

---

## Live infrastructure

| Resource | Value |
|---|---|
| Server | DigitalOcean droplet, Ubuntu 22.04, `104.131.20.10` |
| Port | 3001 |
| App path | `/opt/webpitch/` |
| Process manager | PM2, app name: `webpitch` |
| n8n instance | `aimkt.app.n8n.cloud` |
| Supabase project | `lsmiknqpuruvgsnttihq` (project: `assistant`) |

**Before touching anything:** `curl http://104.131.20.10:3001/health` — if it returns `{"status":"ok"}` you're good.

**After any code change:** `scp file root@104.131.20.10:/opt/webpitch/path && ssh root@104.131.20.10 "pm2 restart webpitch --update-env"`

**After `.env` changes:** Always restart with `--update-env`. Without it, PM2 will NOT pick up the new values.

---

## File map

```
/opt/webpitch/
├── server.js               Express HTTP server. POST /api/analyze triggers pipeline async.
│                           Reads: url, email, telegramUser from body.
│                           Auth: X-Webhook-Secret header checked against WEBHOOK_SECRET env.
│
├── pipeline.js             Orchestrates all 6 steps in sequence. Writes pipeline.log per job.
│                           Calls: crawlSite → analyzeContent → generateDesigns → generateProposal
│                                  → sendResultEmail → logJobComplete
│                           All output written to /opt/webpitch/output/{jobId}/
│
├── storage.js              Supabase client. Functions: logJobStart, logJobComplete, logJobError.
│                           Table: webpitch_jobs
│
├── crawler/crawl.js        Playwright Chromium crawler.
│                           Loads homepage → extracts full data (colors, fonts, nav, headings, etc.)
│                           Then follows nav links (up to 5 inner pages, 15s timeout each).
│                           Thin pages (< 2 headings + paragraphs) get a viewport screenshot
│                           for vision fallback in section design.
│                           Returns: { ...homepageData, crawledPages: [{ navLabel, path, headings, paragraphs, ctas, screenshot? }] }
│
├── analyze/analyze.js      Claude Sonnet — analyzes crawl data → structured JSON.
│                           Has Cloudflare 403 retry logic (60s, 120s waits).
│                           Returns: { businessName, businessType, targetAudience, primaryOfferings,
│                                      competitiveAdvantage, tone, currentStrengths, currentWeaknesses,
│                                      recommendedFeatures, contentGaps, location, colorPersonality, ... }
│
├── design/generate.js      Main design generation. See DESIGN PIPELINE below.
│
├── proposal/generate.js    Claude Sonnet — generates HTML proposal document.
│                           Has Cloudflare 403 retry logic.
│                           Links to design-N/index.html (multi-page structure).
│
├── email/send.js           POSTs { to, businessName, jobId, html } to N8N_EMAIL_WEBHOOK.
│                           Links use ${d.dir}/index.html pattern.
│
└── ui-ux-pro-max/          Design intelligence database (Python + CSV).
    ├── scripts/search.py   BM25 search CLI: python3 search.py "<query>" --domain <domain> -n <n>
    │                       Domains: color, typography, style, ux, landing, chart, product
    ├── scripts/core.py     BM25 + regex search engine
    ├── scripts/design_system.py   Design system generator
    ├── data/               CSV databases — NOT in repo (too large). Install via:
    │                       npm install -g uipro-cli && cp -rL $(npm root -g)/uipro-cli/assets/data ui-ux-pro-max/data
    └── SKILL.md            Full skill documentation
```

---

## Design pipeline (design/generate.js) — detailed

This is the most complex file. Here is the exact call sequence:

```
generateDesigns(analysis, crawlData, outputDir)
│
├── queryUXPro() ×4 in parallel        python3 ui-ux-pro-max/scripts/search.py
│   domains: color, typography,         Outputs injected into CSS + HTML prompts
│   style, ux
│
├── suggestPalettes()                   Gemini 1.5 Flash via OpenAI-compatible endpoint
│   fallback: DEFAULT_PALETTES          If Gemini fails, 3 hardcoded palettes used
│
├── generateSitemap(analysis, crawlData)
│   ├── decidePagesStructure()          Claude — maps crawled pages to page list (~300 tokens out)
│   │   Input: crawledPages array        Returns: [{ id, filename, title, navLabel, purpose, sourcePath }]
│   │   (from crawler output)
│   └── generatePageSections() ×N      Claude — sections for ONE page (~1000 tokens out each)
│       Input: page + crawled content   Returns: full page JSON with typed sections
│       Vision: if crawledContent.screenshot exists, attached as image to Claude message
│
├── enrichContent()                     GPT-4o-mini — fills all section text in one call
│   Input: sitemap + analysis + crawl   Saved to content.json in job outputDir
│   Output: same sitemap but with       Falls back to abstract sitemap if fails
│   real copy replacing abstractions
│
└── [×3 design variants]:
    ├── generateHeroImage()             gpt-image-1 (primary) → Gemini Imagen 3 (fallback)
    │   Returns base64 JPEG             Saved as hero.jpg. Both fail → CSS gradient used
    │
    ├── generateDesignSystem()          Claude — shared design.css
    │   Receives: uxIntel (color,       All pages in this variant reference this CSS file
    │   typography, style data)
    │
    └── generatePageHTML() ×N pages     Claude — HTML for one page at a time, 16k tokens
        Receives: pre-written content   Layout-only — no copy writing, just HTML structure
        + uxIntel.ux guidelines         References ../design.css (not embedded)
```

### Token strategy

The single biggest past failure was token truncation. Current approach:

- **Sitemap**: Split into 2 phases. Phase A (page list) → 1024 max_tokens. Phase B (sections per page) → 2048 max_tokens per page. No single call accumulates across pages.
- **Content enrichment**: GPT-4o-mini, 4096 max_tokens. One call fills everything.
- **CSS**: 6000 max_tokens. One file per design.
- **HTML**: 16000 max_tokens. One page per call, layout only (content pre-supplied).

Never raise max_tokens as a fix for truncation — split the call instead.

---

## n8n workflows

### `dcB3sel7sjKGRM6S` — Webpitch — Telegram Bot (ACTIVE)

Flow: Telegram message → Extract URL (Code node) → IF has URL → POST /api/analyze → Telegram reply

The Extract URL node extracts `telegramUser: { id, username, first_name, last_name }` and passes it to the POST body.

### `2X6tNjbSvS7zxQeg` — Webpitch — Email Sender (ACTIVE)

Flow: Webhook `/webhook/webpitch-job-complete` → emailSend node (Gmail SMTP credential `VKPAqik6o9PxquYa`)

**Critical params on emailSend node:**
- Node type: `emailSend`, version 2.1+
- Credential type: `smtp` (not Gmail OAuth — OAuth was broken)
- `emailFormat: "html"` (not `options.emailType`)
- `html: "={{ $json.body.html }}"` (not `message:`)
- `responseMode: "onReceived"` on the webhook (not `"immediately"` — that's invalid in current n8n)

---

## Supabase

Table `webpitch_jobs` in project `lsmiknqpuruvgsnttihq`:

```
job_id TEXT UNIQUE       — UUID generated in server.js
url TEXT                 — submitted URL
business_name TEXT       — from analysis step
business_type TEXT       — from analysis step
telegram_user_id TEXT    — from Telegram user object
telegram_username TEXT
telegram_first_name TEXT
proposal_url TEXT        — full URL to proposal.html
email_sent_to TEXT
status TEXT              — 'pending' | 'complete' | 'error'
error TEXT               — error message if status='error'
created_at TIMESTAMPTZ
completed_at TIMESTAMPTZ
```

---

## Known issues / gotchas

### Cloudflare 403 on Anthropic API
DigitalOcean IPs get intermittently 403'd by Cloudflare when calling `api.anthropic.com`. Retry logic (60s, 120s) is in `analyze/analyze.js` and `design/generate.js`. **Not yet added to `proposal/generate.js`** — if you see 403s there, add the same `callClaude()` wrapper.

### DigitalOcean blocks outbound SMTP
Ports 25, 465, 587 are blocked on the droplet. Email is routed through n8n cloud instead — never try to send SMTP directly from the server.

### SSH connection refused (intermittent)
The droplet sometimes refuses SSH connections for 30–60s after heavy use. Ping will succeed. Just wait and retry.

### PM2 env not loading
Always restart with `pm2 restart webpitch --update-env`. Without `--update-env`, PM2 uses the cached env from the last restart.

### Gemini model names
`gemini-2.0-flash` → 404. Use `gemini-1.5-flash` for text. Use `imagen-3.0-generate-001` for images.

### n8n responseMode
`responseMode: "immediately"` is not valid in current n8n cloud. Use `"onReceived"`.

### emailSend node params
The correct parameters (confirmed working) are `emailFormat: "html"` and `html:`. Using `message:` or `options.emailType: "html"` produces empty emails.

---

## API keys and what each is used for

| Key | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Sonnet — analysis, sitemap, CSS, HTML pages, proposal |
| `OPENAI_API_KEY` | gpt-image-1 (hero images), gpt-4o-mini (content enrichment) |
| `GEMINI_API_KEY` | Gemini 1.5 Flash (color palettes), Gemini Imagen 3 (hero image fallback) |

---

## How to test without Telegram

```bash
curl -X POST http://104.131.20.10:3001/api/analyze \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: j2bd3xchy6hkckkckhhqtmxmg" \
  -d '{"url":"https://example.com","email":"your@email.com"}'
```

Then watch logs: `ssh root@104.131.20.10 "pm2 logs webpitch --lines 100"`

---

## Output files you can inspect after a job

```bash
ls /opt/webpitch/output/{jobId}/
cat /opt/webpitch/output/{jobId}/pipeline.log      # step-by-step with timestamps
cat /opt/webpitch/output/{jobId}/crawl.json        # raw crawler output
cat /opt/webpitch/output/{jobId}/analysis.json     # business analysis
cat /opt/webpitch/output/{jobId}/content.json      # enriched copy (all pages/sections)
```

Designs are at `http://104.131.20.10:3001/output/{jobId}/design-1/index.html` etc.

---

## Design style constants (DESIGN_STYLES in design/generate.js)

Three fixed design variants, always in this order:

1. **Modern & Bold** — clean white base, gradient hero with clip-path, bold sans-serif, stat numbers in accent color, dark footer
2. **Dark & Dramatic** — near-black base, gradient-clipped headline text, frosted glass cards, neon-border buttons, electric accent glows
3. **Editorial & Warm** — off-white, serif headings, generous whitespace, thin hairline borders, asymmetric editorial grid

Each has `css_personality` (fed to CSS generation) and `layout_patterns` (fed to HTML generation).

---

## Section type vocabulary (SECTION_LIBRARY)

Used in sitemap generation to describe page structure. The HTML generator receives typed sections and renders them:

`hero` · `page_hero` · `trust_strip` · `features_grid` · `stats_band` · `testimonials_grid` · `cta_strip` · `services_cards` · `menu_grid` · `portfolio_grid` · `process_steps` · `team_grid` · `story_split` · `faq_accordion` · `gallery_grid` · `pricing_cards` · `contact_split` · `hours_info`

---

## What still needs work

- [ ] Cloudflare retry logic not yet added to `proposal/generate.js`
- [ ] `enrichContent` uses only homepage content (`crawlData.paragraphs`) — should use per-page crawled content
- [ ] No job status endpoint — client can't poll for completion
- [ ] No queue/rate limiting — concurrent jobs will run simultaneously
- [ ] DALL-E / gpt-image-1 hero images not embedded in HTML (referenced as relative `hero.jpg`) — if files move, link breaks
- [ ] `resend.mjs` and `regen.mjs` are one-off scripts with hardcoded job IDs — clean up or generalize
