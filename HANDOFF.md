# HANDOFF.md — Webpitch session handoff

Last updated: 2026-05-15

---

## Current state

The pipeline is deployed and running on `104.131.20.10:3001`. All 6 steps execute end-to-end. Email delivery is confirmed working.

The architecture was overhauled significantly during this session. If you're reading this to understand what changed and why, this document has the full context.

---

## What was built this session (in order)

### 1. Email delivery (fixed)
The pipeline was completing but emails were either not arriving or arriving empty.

Three bugs fixed:
- n8n webhook `responseMode: "immediately"` is invalid — changed to `"onReceived"`
- Gmail OAuth credential was broken — replaced with SMTP emailSend node using "Gmail SMTP" credential (`VKPAqik6o9PxquYa`)
- emailSend node params were wrong (`message:` → `html:`, `options.emailType` → `emailFormat: "html"`)

### 2. Design quality overhaul (design/generate.js rewrite)
The original approach generated a single HTML file per design. Claude was running out of tokens before reaching the `<body>` tag — designs came back as CSS-only files with 0 div elements.

New architecture:
- **Sitemap-first**: page structure decided before any HTML is written
- **Multi-page**: each design is 3–5 separate HTML files + shared CSS
- **Content-first**: GPT-4o-mini writes all copy once, Claude handles layout only
- **Chunked sitemap**: sitemap generation split into two phases to avoid token overflow
- **Crawler-grounded**: sitemap derived from pages the crawler actually found, not invented

### 3. Crawler upgraded (crawler/crawl.js)
Original: crawled only the homepage.

New: follows internal nav links (up to 5 pages, 15s timeout each). Per inner page: headings, paragraphs, CTAs. Image-heavy pages (thin text) get a viewport screenshot for Claude vision.

Returns `crawledPages[]` — used by sitemap generation to understand existing site structure.

### 4. Design intelligence integration (ui-ux-pro-max)
Skill from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill installed on droplet at `/opt/webpitch/ui-ux-pro-max/`.

4 parallel Python calls per job query the BM25 search engine for:
- Industry-specific color palette
- Typography pairings matching business tone
- UI style guidance with CSS keywords
- UX guidelines and anti-patterns

Results injected into CSS generation and HTML generation prompts.

### 5. gpt-image-1 for hero images
The original code used DALL-E 3 (key didn't have access). Switched to `gpt-image-1` as primary (returns `b64_json`), Gemini Imagen 3 as fallback, CSS gradient as last resort.

### 6. Supabase job logging
All jobs logged to `webpitch_jobs` table in Supabase project `lsmiknqpuruvgsnttihq`. Fields: job_id, url, business identifiers, telegram user, proposal URL, status, error.

---

## Architecture decisions made (and why)

### Why GPT-4o-mini for content enrichment
Claude Sonnet was being asked to both write copy AND design layout in each HTML call. Splitting these concerns means: one cheap GPT-4o-mini call writes all copy across all pages; Claude HTML calls are layout-only and shorter. Better quality, lower cost.

### Why two-phase sitemap (decidePagesStructure + generatePageSections)
A single call generating the full sitemap for a 4-5 page site was hitting 4096 token output limits and getting cut off mid-JSON. Splitting into phase A (page list, ~300 tokens) and phase B (sections per page, ~1000 tokens each) makes it impossible to overflow regardless of site size. **Never increase max_tokens to fix truncation — split the call instead.**

### Why crawler-driven sitemap
Previously Claude invented the page structure. Now the crawler tells us what pages actually exist, and Claude maps them to the new design. A pizzeria gets Home + Menu + About + Contact, not a generic Services page.

### Why ui-ux-pro-max at runtime
The Python search engine has 161 industry-specific palettes, 67 UI styles, 57 typography pairings — queried with the actual business type. This grounds design decisions in industry conventions rather than Claude's generic sense of "professional." The Python calls are cheap (~50ms each, 4 in parallel).

### Why email goes through n8n instead of directly
DigitalOcean blocks outbound SMTP (ports 25/465/587) on their droplets. n8n cloud acts as the email relay. The server POSTs a webhook payload to n8n, which sends the email via Gmail SMTP.

---

## Files modified this session (all on droplet)

| File | What changed |
|---|---|
| `design/generate.js` | Complete rewrite — sitemap-first, multi-page, content enrichment, ux-pro-max integration, gpt-image-1, vision support |
| `crawler/crawl.js` | Added multi-page crawling, thin-page screenshot capture |
| `proposal/generate.js` | Links updated to `design-N/index.html`; added Cloudflare retry logic; uses `palette.concept` |
| `email/send.js` | Links updated from `d.filename` to `${d.dir}/index.html` |
| `server.js` | Accepts `telegramUser` in webhook body |
| `pipeline.js` | Accepts and passes `telegramUser`; calls Supabase logging |
| `storage.js` | New file — Supabase logging (logJobStart, logJobComplete, logJobError) |

---

## Open items (prioritized)

### High — affects output quality
1. **`enrichContent` uses only homepage content** — the function passes `crawlData.paragraphs` (homepage) to GPT-4o-mini but crawled inner pages have per-page paragraphs in `crawlData.crawledPages[].paragraphs`. Should pass per-page content to the enricher for better copy on inner pages.

2. **Cloudflare retry not in `proposal/generate.js`** — add the same `callClaude()` wrapper that's in `design/generate.js` and `analyze/analyze.js`.

### Medium — operational improvements
3. **No job status endpoint** — the pipeline runs async and there's no way to poll for completion. Add `GET /api/status/:jobId` that reads from Supabase.

4. **No concurrency control** — if two URLs arrive simultaneously, both pipelines run in parallel, potentially exhausting API rate limits. Add a simple queue (p-queue or similar).

5. **`resend.mjs` and `regen.mjs` have hardcoded job IDs** — these were one-off scripts. Either generalize them to accept a job ID argument or delete them.

### Low — nice to have
6. **Hero image URL in HTML is relative** — `hero.jpg` is referenced relatively in the HTML. If the output directory structure ever changes, the link breaks. Embed as base64 or use absolute URL.

7. **No cleanup of old output directories** — `/opt/webpitch/output/` grows forever. Add a cron to delete jobs older than N days.

8. **Proposal links to design pages** — proposal.html has hardcoded links. If regenerating only the proposal (not the designs), links still need to resolve correctly.

---

## Environment variables (reference)

All set in `/opt/webpitch/.env` on the droplet. See `.env.example` in the repo for full list with descriptions.

Key values:
- `WEBHOOK_SECRET=j2bd3xchy6hkckkckhhqtmxmg`
- `DEFAULT_EMAIL=er@ndi.mx`
- `BASE_URL=http://104.131.20.10:3001`
- `N8N_EMAIL_WEBHOOK=https://aimkt.app.n8n.cloud/webhook/webpitch-job-complete`

---

## How to continue

1. Confirm server is up: `curl http://104.131.20.10:3001/health`
2. Read `AGENTS.md` for full technical context
3. Test a job: send a URL via Telegram or use the curl command in AGENTS.md
4. Watch logs: `ssh root@104.131.20.10 "pm2 logs webpitch --lines 100"`
5. After any code change: `scp <file> root@104.131.20.10:/opt/webpitch/<path> && ssh root@104.131.20.10 "pm2 restart webpitch --update-env"`
