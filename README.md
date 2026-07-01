# agent-platform

Multi-project agent service. First agent: `cs-recovery` — recovers customer orders that failed backend payment validation. Triggered on-demand by CS team via Discord.

**Docs:**
- [`docs/USAGE.md`](docs/USAGE.md) — for CS + operators using the Discord bot day-to-day.
- [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) — for a dev or AI agent extending the platform.

## Status

MVP scaffold. Ready for local dev once `.env` is filled. EC2 deploy via Docker. Discord bot connects on startup; first command to try: `!help`.

## Architecture

```
Discord !cs <ticket-id> email=...
   ↓
discord-bot/router  →  agents/cs-recovery
                         ↓
                       shared/llm (Claude)
                       shared/connectors (ClickBank, asksabrina, ...)
                       shared/gates (payment-verify)
                       shared/state (threads, actions, approvals, lessons)
                         ↓
                       MongoDB (agent_platform DB)
                         ↓
                       Discord thread: draft posted → human ✅/❌
                         ↓ (on ✅)
                       agents/cs-recovery/executor
                         ↓
                       re-verify gate → asksabrina /mark-paid → ensure-reading
                         ↓
                       Discord thread: link posted
```

Designed multi-project from day 1. Adding a new project = new connector + new vendor mapping in `config/env.ts`, no rebuild.

## Setup

```bash
pnpm install
cp .env.example .env
# fill in env vars
pnpm typecheck      # confirm compile clean
pnpm test           # run gate tests
pnpm dev            # local dev with hot reload
```

## Deploy (CI/CD via GitHub Actions → EC2)

The workflow `.github/workflows/deploy.yml` runs on every push to `main`:
1. **Test** — `npm ci`, `tsc --noEmit`, `vitest`
2. **Build** — Docker image built + pushed to `ghcr.io/mettlence/agent-platform:latest`
3. **Deploy** — SSH to EC2, `docker compose pull && up -d`, health check

### One-time EC2 setup

On the fresh EC2 host:

```bash
ssh -i agent.mettlence.com.pem ubuntu@<ec2-host>
curl -fsSL https://raw.githubusercontent.com/mettlence/agent-platform/main/scripts/ec2-bootstrap.sh | bash
# log out + back in so docker group takes effect
```

Copy `.env` (one-time, manual — secrets never go through the repo):

```bash
scp -i agent.mettlence.com.pem .env ubuntu@<ec2-host>:/opt/agent-platform/.env
```

Setup HTTPS (one-time, after DNS `agent.mettlence.com` → EC2 is live):

```bash
ssh -i agent.mettlence.com.pem ubuntu@<ec2-host>
cd /opt/agent-platform && sudo bash scripts/setup-https.sh
```

The script is idempotent: issues a Let's Encrypt cert via webroot challenge, installs the nginx site config, and enables `certbot.timer` for auto-renewal. Override `DOMAIN=` / `EMAIL=` to use a different host.

### Required GitHub repo secrets

Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `EC2_HOST` | `ec2-54-158-25-23.compute-1.amazonaws.com` |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | full contents of `agent.mettlence.com.pem` (incl. headers) |

`GITHUB_TOKEN` is auto-provided per run — no manual setup.

### Trigger a deploy

- Push to `main` → auto deploy
- Or: Actions tab → "Deploy to EC2" → Run workflow

### Logs on EC2

```bash
ssh -i agent.mettlence.com.pem ubuntu@<ec2-host>
cd /opt/agent-platform && docker compose logs -f
```

### Local docker dev (optional)

```bash
docker compose -f docker-compose.dev.yml up --build
```

## Conventions

- `shared/llm` is the only place that imports `@anthropic-ai/sdk`. Everything else calls through `LLMClient` interface — keeps the door open to swap providers later.
- All payment-touching writes go through `shared/gates/payment-verify` — twice. Once at draft time (so the agent's proposal makes sense) and once inside `executor.ts` immediately before the mutation (so a refund issued between draft and ✅ blocks execution).
- Every executed action writes an immutable record to `agent_actions` (no updates, no deletes).
- Conversation context lives in `agent_threads`, keyed by Discord thread ID. Follow-ups in the same thread resume context.
- Pending approvals carry `customer_email` so the executor doesn't need to re-fetch.
- Idempotency keys prevent double-execute when ✅ is reacted twice or two people react simultaneously.

## Vendor → Project map

ClickBank vendors map to internal projects in `src/config/env.ts`:

```
sabrinapsy   → asksabrina
astrosketc   → astroloversketch
```

Add new project = add vendor mapping + new connector under `src/shared/connectors/`.

## MongoDB collections

| Collection | Purpose | Retention |
|---|---|---|
| `agent_threads` | Per-Discord-thread conversation state | 30d TTL on `last_active_at` |
| `agent_actions` | Immutable audit log of every executed action | forever |
| `pending_approvals` | Draft actions awaiting human ✅ | 7d TTL on `expires_at` |
| `idempotency_keys` | Prevent double-execute | 24h TTL on `ttl_at` |
| `agent_lessons` | Project-specific patterns/rules read into prompts | forever (curate manually) |

Create indexes (run once against the dedicated DB):

```js
db.agent_threads.createIndex({ ticket_id: 1, project: 1 })
db.agent_threads.createIndex({ last_active_at: 1 }, { expireAfterSeconds: 2592000 })
db.agent_actions.createIndex({ ticket_id: 1 })
db.agent_actions.createIndex({ executed_at: -1 })
db.agent_actions.createIndex({ thread_id: 1 })
db.pending_approvals.createIndex({ discord_message_id: 1 })
db.pending_approvals.createIndex({ status: 1, expires_at: 1 })
db.idempotency_keys.createIndex({ ttl_at: 1 }, { expireAfterSeconds: 0 })
db.agent_lessons.createIndex({ project: 1, agent: 1, active: 1 })
```

## What's wired

- LLM client abstraction (Claude impl, swappable)
- MongoDB connection + state collections (threads, actions, approvals, idempotency, lessons)
- ClickBank connector (real v1.3 API — `Authorization: API-XXX`)
- AskSabrina connector against the existing `/api/agent/*` endpoints (lookup, ensure-reading, jobs, mark-paid)
- Payment-verify gate (transaction type / email / amount / vendor→project)
- CS-recovery agent loop (investigate → draft → propose)
- Executor with re-verify (gate re-runs at execution time)
- Discord bot: `!cs` command + reaction-based approval (✅ / ❌)
- HTTP API: `POST /cs-recovery/trigger`, `GET /health`
- Tests for the payment gate (vitest)

## What's not wired (TODO)

- `astroloversketch` connector (stub only — clone asksabrina shape once that API exists)
- `!cs-job <jobId>` command to check long-running regeneration jobs
- Lessons-extraction (auto-add a lesson when a thread surfaces a new edge case)
- Metrics / dashboards
- Slack mirror (if needed)
- Per-user role gating on Discord (currently any non-bot can ✅)

## Server-side dependency

The asksabrina agent API now ships a `POST /mark-paid` handler — added in this PR cycle to `asksabrina/api/src/routers/agent-router.js`. The agent platform calls it via the connector in `src/shared/connectors/asksabrina.ts`. If you deploy agent-platform before that endpoint is live, `executeUpdateOrder` will fail.
