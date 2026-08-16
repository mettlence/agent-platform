---
name: agent-platform
description: How the cross-brand agent service works — the Discord-driven bot that recovers failed orders and watches stuck readings for AskSabrina and AstroLoversKetch. Covers the cs-recovery and pending-monitor agents, the human approval gate, the connector/vendor mapping, and the `/api/agent/*` surface it calls on each brand. Use when a question or plan touches CS recovery, stuck or pending readings, orders marked paid outside the normal webhook, or anything reaching a brand through `/api/agent/*`.
---

# agent-platform — the cross-brand agent service

A multi-project agent service driven from Discord. It reaches into the brand backends to fix customer-facing failures that the normal purchase flow left behind. Deployed separately (GitHub Actions → `ghcr.io/mettlence/agent-platform` → EC2 on every push to `main`); brand repos never import it.

The README describes the project as an **MVP scaffold**. Treat capability claims as "built", not necessarily "battle-tested in production".

## Two agents

**`cs-recovery`** — recovers orders that failed backend payment validation. A CS person mentions the bot in Discord with a receipt or email; it looks the customer up, runs the payment-verify gate, and posts a draft.

**`pending-monitor`** — watches for readings that are stuck rather than waiting on a human (`src/agents/pending-monitor/`: `tick.ts`, `loop.ts`, `ensure-stuck.ts`).

## The human gate is the whole design

```
Discord @bot <receipt|email>   (mention-only)
  → discord-bot/router → agents/cs-recovery
  → shared/gates/payment-verify + shared/connectors
  → draft posted in a Discord thread
  → human ✅ or ❌                       ← nothing executes before this
  → executor: re-verify gate → /mark-paid → ensure-reading
  → link posted back to the thread
```

The gate re-verifies **after** approval, not only before drafting. When reasoning about what this bot can do unattended, the answer is: draft and propose, nothing else.

## Which brands it covers — and which it does not

`src/config/env.ts:73` maps ClickBank vendor nicknames to internal project keys:

```
sabrinapsy  → asksabrina
astrosketc  → astroloversketch
```

Connectors exist for `asksabrina`, `astroloversketch`, `clickbank` and `discord` (`src/shared/connectors/`). **There is no Votive connector, and Votive is not in the vendor map** — Votive sells through Stripe, not ClickBank, so this recovery path does not apply to it. Do not assume cross-brand means all three.

Adding a brand is a connector plus a vendor-map entry, not a rebuild.

## What it calls on the brand side

Each brand exposes an agent API (`api/src/routers/agent-router.js`) that this service drives:

| Endpoint | Used for |
|---|---|
| `GET /lookup` | find the customer/order from a receipt or email |
| `GET /pending-readings` | pending-monitor's queue |
| `GET /jobs/:jobId` | generation job status |
| `POST /ensure-reading` | make sure the reading exists / regenerate |
| `POST /mark-paid` | flip an order to paid after verification |
| `POST /create-order` | create an order that never landed |
| `POST /cleanup-customer` | remove bad customer state |

**`/mark-paid` and `/create-order` matter beyond this repo.** They are two of the paths that set `paymentStatus: 1` outside the ClickBank webhook, so anything reasoning about "how does an order become paid" — refunds, email triggers, revenue counts — has to include this bot, not just the webhook. Recorded in the brand-side work as MET-4 and MET-5.

## Where to look next

- `docs/USAGE.md` — day-to-day Discord usage for CS and operators
- `docs/AGENT_GUIDE.md` — extending the platform with a new agent or connector
- `docs/TALA_HANDOFF.md` — message format for the partner CS bot relaying tickets in
- `src/config/env.ts` — vendor mapping and per-brand API bases
