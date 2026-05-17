# webpitch TODOS

## Phase 2 Gate (required before self-serve launch)

### Job Queue (BullMQ + Redis)
- **What**: Replace in-process pipeline with BullMQ job queue + Redis; workers in separate processes
- **Why**: Self-serve means untrusted concurrent jobs. In-process pipeline OOMs with 2+ concurrent runs
- **Context**: Current A2 slot limiter is throwaway for Phase 1. Phase 2 needs real concurrency, retries, job status visibility. BullMQ on same droplet, Redis ~30MB RAM. Depends on: Phase 2 gate (5 paying customers).
- **Depends on**: Phase 2 gate

### Output URL Auth/Expiry
- **What**: Signed URL tokens with 7-day expiry on /output/{jobId}/
- **Why**: Phase 2 automates URL delivery after payment. If URL leaks (forwarded email), 9 gate disappears
- **Context**: Best option: time-limited signed query param (?token=...&expires=...) validated by Express middleware before serving static files. Alternatives: basic auth, authenticated download endpoint.
- **Depends on**: Phase 2 gate + Stripe integration

### Stripe Integration
- **What**: Stripe payment link + n8n webhook → automated URL delivery after payment
- **Why**: Phase 1 uses SPEI manual flow. Phase 2 needs automated payment + automated URL email
- **Context**: Stripe → n8n webhook on payment_intent.succeeded → send output URL email. Replaces manual SPEI monitoring. Was deferred in CEO plan. Needs Stripe account setup.
- **Depends on**: Phase 2 gate

### Cost Reduction (Haiku HTML generation)
- **What**: Switch generatePageHTML() from Claude Sonnet to Haiku; reduce to 3 pages per design; 2 designs
- **Why**: Current cost ~4-17/run. Phase 2 target: </run. At 9 price point, margin matters at scale
- **Context**: From design doc cost math: Haiku at ~/bin/bash.03-0.05/page × 6 calls = ~/bin/bash.25 vs Sonnet ~1-14. Keep Sonnet for analysis + proposal. This is the Phase 2 architecture refactor.
- **Depends on**: Phase 2 gate

## Phase 2: Test Infrastructure
- **What**: Full Vitest test suite written alongside the Phase 2 cost-reduction refactor
- **Why**: Phase 2 delivers to paying customers without manual review. Regressions must be caught by CI, not by angry email
- **Context**: TR1 accepted basic integration tests for Phase 1 (auth, URL validation, pipeline boundaries). Phase 2 needs: full pipeline integration tests with mocked APIs, CI/CD pipeline, regression tests for each LLM call boundary. Write tests AFTER Phase 2 architecture stabilizes (Haiku, 3 pages, 2 designs) to avoid throwaway test rewriting.
- **Depends on**: Phase 2 gate + cost-reduction refactor

## Phase 2: CI/CD Pipeline
- **What**: GitHub Actions workflow for automated deploy to droplet on merge to main
- **Why**: Currently all deploys are manual SSH. As codebase grows this becomes a bottleneck and a source of deployment errors
- **Context**: Workflow: checkout → npm ci → vitest run → ssh deploy (scp + pm2 restart). Requires: GitHub repository, GitHub Actions secrets (DO_SSH_KEY, .env values).
- **Depends on**: Phase 2 gate + test infrastructure
