# webpitch TODOS

## Ready to work (no gate)

### Enrich inner pages with per-page content
- **What**: Pass `crawledPages[n].paragraphs` to `enrichContent()` for each page instead of only homepage paragraphs
- **Why**: Inner page copy (Servicios, Nosotros, etc.) is currently grounded in homepage text. Per-page crawled content would produce better, more specific copy.
- **Where**: `design/generate.js` → `enrichContent()` → `businessCtx` construction; also update `generatePageSections()` which already receives `crawledContent` per page

### Output directory cleanup cron
- **What**: Cron job (or PM2 cron) to delete jobs older than 30 days from `/opt/webpitch/output/` and Supabase
- **Why**: Output directory grows forever; no current cleanup mechanism
- **How**: `find /opt/webpitch/output -maxdepth 1 -mtime +30 -type d -exec rm -rf {} +` + Supabase delete

### Generalize resend.mjs / regen.mjs
- **What**: Accept `--jobId` argument instead of hardcoded IDs
- **Why**: Currently one-off scripts tied to specific job IDs — useless as-is for future runs
- **Low effort**: 5 min change

---

## Phase 2 Gate (requires 5 paying customers first)

### BullMQ job queue
- **What**: Replace in-process pipeline with BullMQ + Redis; workers in separate processes
- **Why**: Current `_jobRunning` boolean has a race condition on simultaneous submissions; no retries on failure; no job status visibility beyond `pipeline.log`
- **Context**: BullMQ on same droplet, Redis ~30MB RAM. Phase 1 `_jobRunning` slot is throwaway.

### Signed output URLs with expiry
- **What**: Time-limited signed tokens on `/output/{jobId}/` — validated by Express middleware before serving static files
- **Why**: Phase 2 delivers URLs after payment. If URL leaks (forwarded email), paywall disappears.
- **How**: `?token=...&expires=...` query param, HMAC-signed with WEBHOOK_SECRET

### Stripe integration
- **What**: Stripe payment link → n8n webhook on `payment_intent.succeeded` → email output URL
- **Why**: Phase 1 uses manual SPEI. Phase 2 needs automated payment + automated URL delivery.

### Cost reduction (Haiku HTML generation)
- **What**: Switch `generatePageHTML()` from Sonnet to Haiku; reduce to 3 pages/design; 2 designs total
- **Why**: Current cost ~$4-17/run. Phase 2 target: <$1/run. Margin matters at $49 price point.
- **Context**: Keep Sonnet for analysis + proposal. Template+injection architecture makes this viable — LLM writes structure only.

### Full test suite
- **What**: Vitest integration tests — mocked LLM/image APIs, real pipeline flow, regression tests per LLM boundary
- **Why**: Phase 2 ships to paying customers without manual review. CI catches regressions.
- **When**: Write AFTER cost-reduction refactor stabilizes (avoids throwaway test rewriting)

### CI/CD via GitHub Actions
- **What**: `checkout → npm ci → vitest → scp → pm2 restart` on merge to main
- **Why**: Current deploys are manual SSH — bottleneck as codebase grows
- **Requires**: GitHub Actions secrets (DO_SSH_KEY, .env values)
