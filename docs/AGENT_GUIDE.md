# Agent Guide — extending the platform

Audience: an AI agent (Claude Code session, coding sub-agent) or a human dev
picking up work on this repo. If you're a CS operator, read `docs/USAGE.md`.

Read this end-to-end **before** you edit anything. The platform is small but
the safety pattern (draft → human ✅ → re-verified execute) is load-bearing —
casual refactors here can silently break the guarantee that no mutation
happens without approval.

## Mental model (10 seconds)

```
Discord message
  → router.ts
    → handler (mention | !cs | thread-continue | reaction)
      → agents/cs-recovery/index.ts        (LLM loop: skill.md + tools.ts)
        → shared/connectors/*              (ClickBank, project APIs, Discord)
        → shared/gates/*                   (payment-verify)
        → shared/state/*                   (MongoDB collections)
      → propose_action  → pending_approvals + Discord draft
      → ✅ reaction     → executor.ts → re-verify gate → project API write
      → agent_actions   (immutable audit)
```

Only `executor.ts` writes to project databases. Only `shared/llm` imports the
Anthropic SDK. Everything else calls through interfaces.

## Repo map

```
src/
  index.ts                    startup: DB, LLM, Discord bot, HTTP server
  config/env.ts               env schema (zod) + vendor→project map
  api/routes/cs-recovery.ts   POST /cs-recovery/trigger, GET /health
  discord-bot/
    router.ts                 message dispatch (guild + channel allowlist)
    handlers/
      cs-command.ts           !cs command
      mention-command.ts      @bot fresh mention
      thread-continue.ts      @bot inside an existing recovery thread
      reaction.ts             ✅ / ❌ on draft messages
  agents/cs-recovery/
    skill.md                  LLM system prompt (source of truth for behavior)
    prompt.ts                 assembles the prompt (skill + runtime context)
    tools.ts                  tool schemas the LLM sees
    index.ts                  the agent loop (tool dispatch, budget checks)
    executor.ts               post-approval mutations + re-verify
  shared/
    llm/client.ts             LLMClient interface + Claude impl
    connectors/
      clickbank.ts            ClickBank v1.3 (API-XXX auth)
      asksabrina.ts           /api/agent/* on the asksabrina backend
      astroloversketch.ts     stub — clone asksabrina shape when API exists
      discord.ts              thin discord.js wrapper
    gates/                    payment-verify (twice: draft + execute)
    state/                    MongoDB accessors per collection
    extractors.ts             receipt/email heuristics for the mention parser
```

Files you'll edit most often: `skill.md`, `tools.ts`, `executor.ts`,
`shared/connectors/*`.

## The LLM loop (how a ticket flows)

1. `runCsRecovery(input)` in `agents/cs-recovery/index.ts` opens or resumes
   an `agent_threads` record keyed by Discord thread id.
2. `prompt.ts` builds the system prompt: `skill.md` + any active
   `agent_lessons` for this brand + the runtime ticket context.
3. The loop hands the LLM the tools from `tools.ts`. Read-only tools
   (`resolve_customer_identity`, `lookup_customer`, `verify_clickbank_receipt`,
   `find_clickbank_receipts_by_email`, `find_all_customer_records`,
   `check_regeneration_job`) can be called freely.
4. Two mutation-**shaped** tools exist: `propose_action` and
   `escalate_to_human`. Neither writes to a project DB. They post to Discord
   and (for `propose_action`) create a `pending_approvals` row.
5. On ✅, `handleReactionAdd` in `discord-bot/handlers/reaction.ts` calls
   `executeApprovedAction(...)` in `executor.ts`. The executor re-runs the
   payment-verify gate with fresh ClickBank data, then hits the project API.
6. Every executed action writes one row to `agent_actions`. No updates,
   no deletes.

Budget stops are enforced in the loop: 100k tokens or 25 tool calls per
ticket. Cross either and the loop halts with an escalation.

## Adding a new brand

Say we're adding `newbrand`:

1. **Config** — `src/config/env.ts`: add the vendor → project mapping and
   env vars (`NEWBRAND_API_BASE`, `NEWBRAND_AGENT_KEY`). Follow the shape of
   the existing `ASKSABRINA_*` block.
2. **Connector** — copy `src/shared/connectors/asksabrina.ts` to
   `newbrand.ts`. Match the function surface — `lookupCustomer`,
   `ensureReading`, `markPaid`, `createOrder`, `getJob`. Any deviation from
   that surface will cascade into `tools.ts` and `executor.ts`.
3. **Backend contract** — the brand's backend must expose the same
   `/api/agent/*` endpoints asksabrina does. Auth is `X-API-Key`. If the
   backend can't be extended today, stop and coordinate — the connector is
   the cheap part.
4. **Tools + skill** — extend the `project` enum in every tool schema in
   `tools.ts` and add a "SKU → kind mapping" section in `skill.md` for the
   new brand. The LLM will not infer this from anything else.
5. **Executor dispatch** — add the brand branch inside
   `executeApprovedAction` in `executor.ts`. This is where the connector
   choice happens.
6. **.env** — add the new keys locally and to the EC2 `.env`. Don't commit
   them.
7. **Test** — send a `!cs` for a known-good ticket in a staging channel
   before opening the allowlist for the real CS channel.

Do NOT add cross-brand logic. Each brand branch is independent by design —
that keeps blast radius small when a single brand's backend changes shape.

## Adding a new tool

1. Add the schema in `tools.ts`. The `description` is what the LLM reads —
   spell out when to call it and when NOT to. Be concrete; the LLM will not
   guess subtle preconditions.
2. Add the dispatch case in the agent loop (`agents/cs-recovery/index.ts`).
   Read-only tools return their result and continue. Mutation-shaped tools
   must go through the propose/execute split; do not add a new tool that
   writes directly.
3. If the tool is brand-specific, gate it on `project` inside the handler,
   don't create N variants.
4. If the tool changes gate assumptions (e.g. adds a new identity bridge),
   update `shared/gates/payment-verify` in the same PR. Skew between the
   gate and the skill's claimed guarantees is the #1 way this platform
   breaks safely-but-uselessly.
5. Update `skill.md` to teach the LLM when to use it. Prefer a short "when
   to call" clause plus one example over a long prose description.

## Safety invariants (do not break)

- **No writes without ✅.** The only path to a project-DB mutation is
  `executor.ts` on an approved `pending_approvals` row. Any new mutation
  tool must go through the same split.
- **Re-verify at execute time.** The executor re-fetches the ClickBank
  order and re-runs the gate. This catches refunds/chargebacks that landed
  between draft and approval. Don't cache the draft's gate result.
- **Immutable audit.** `agent_actions` is append-only. If you need to
  "correct" a prior action, write a new row with `parent_action_id`.
- **Idempotency.** `idempotency_keys` prevents double-execute on double-✅
  or racing reactors. Every mutation path derives a key deterministically
  from ticket + action shape; keep that pattern.
- **60-day cutoff.** Tickets older than 60 days must escalate, not execute.
  ClickBank refund/dispute windows make older mutations dangerous.
- **Never talk to the customer.** The bot posts in the CS Discord thread
  only. There is no customer-facing surface, and there should not be one.

## Editing `skill.md`

`skill.md` is the LLM's system prompt — treat it like production code, not
documentation.

- Small, concrete rules beat prose. "SKU `abdt-basic` → kind=main" is better
  than "figure out the right kind based on the product."
- Every rule should include the failure mode it prevents. That's why the
  "Repeat purchases" and "Fragmented customer records" sections exist —
  they encode real past incidents.
- Test changes with a spread of past tickets before shipping. Regression
  usually shows up as the LLM proposing the wrong `order_kind` or skipping
  `find_clickbank_receipts_by_email`.
- Do NOT ask the CS operator to spell out patterns in every ticket — the
  bar is that the bot derives them itself. If you catch yourself writing
  "the operator will tell you when it's an OTO", stop and teach the pattern
  instead.

## MongoDB collections

| Collection          | Purpose                                              | Retention |
|---------------------|------------------------------------------------------|-----------|
| `agent_threads`     | Per-thread conversation state, keyed by Discord tid  | 30d TTL   |
| `agent_actions`     | Immutable audit log of every executed action         | forever   |
| `pending_approvals` | Drafts awaiting ✅ (carry `customer_email`)          | 7d TTL    |
| `idempotency_keys`  | Prevent double-execute                               | 24h TTL   |
| `agent_lessons`     | Brand-specific rules injected into the prompt        | forever   |

Indexes are listed in `README.md` — run them once per dedicated DB.

## Local dev checklist

```bash
cp .env.example .env
# fill: MONGODB_URI, ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN,
#       DISCORD_GUILD_IDS, DISCORD_CS_CHANNEL_IDS, DISCORD_CS_LEAD_ROLE_ID,
#       CLICKBANK_API_KEY, ASKSABRINA_API_BASE, ASKSABRINA_AGENT_KEY
npm run typecheck
npm test              # gate tests (vitest)
npm run dev           # hot reload; connects Discord + Mongo on boot
```

Point the bot at a **staging** Discord channel and a **staging** Mongo DB
during dev. Never point local dev at production — the `pending_approvals`
collection is shared state and a stray ✅ from the wrong bot instance will
execute against the real project APIs.

## HTTP surface

- `POST /cs-recovery/trigger` — programmatic trigger; same input the Discord
  handlers assemble. Useful for cron/replay.
- `GET /health` — used by the deploy healthcheck.

Anything else does not exist. Don't add public routes without a threat model —
the ClickBank + project API keys sit behind this process.

## Common pitfalls (patterns already burned)

- **Drafting `create_order` without calling `find_clickbank_receipts_by_email`
  first.** Misses repeat purchases and fragmented records. Fix in `skill.md`,
  not by adding a code check.
- **Deriving `order_kind` from what the customer already has.** It's a
  property of the SKU. See "SKU → kind mapping" in `skill.md`.
- **Adding an env var for a value that doesn't differ per environment.**
  Hardcode it. `productId` is the canonical example — mirror the funnel.
- **Skipping the executor re-verify.** The draft's gate is stale by
  definition. Never trust it for the actual mutation.
- **Trying to talk to the customer.** The bot's surface is CS Discord only.

## When to escalate vs. keep going

Escalate (via `escalate_to_human`) when:

- The gate fails and you can't recover after two retries.
- Data required to draft cleanly is missing and no tool can fetch it (e.g.
  `contact_id` only, no `cId`, Maropost bridge not wired).
- Two distinct plausible actions exist and the choice affects the customer
  (e.g. multiple candidate main orders for a create_order parent).

Keep going when:

- A single tool call failed transiently — retry once.
- The customer view is missing a field you can derive from another tool.
- The receipt is refunded — that's still an actionable outcome (post a
  short "refunded — nothing to recover" and stop; don't escalate empty).

## Where to look when something breaks

- Bot silent on a mention → `discord-bot/router.ts` allowlist check.
- Draft posted but ✅ does nothing → `handlers/reaction.ts` — check
  `findByMessageId` returned the approval row.
- Execution failed with "gate failure" → look at the gate re-run inside
  `executor.ts`. Something changed at ClickBank between draft and ✅.
- Wrong customer resolved → `resolve_customer_identity` in the connector +
  the identity-bridge logic in `shared/gates/payment-verify`.
- "Reading link 404" reported by CS → the async regen job. Look at
  `check_regeneration_job` and the project's job endpoint.

## What NOT to build here

- Customer-facing anything.
- A general workflow engine or DAG runner.
- A per-brand config-file abstraction — the direct-code branch per brand
  is intentional. When there are 4+ brands, revisit.
- A retry queue for approvals — human ✅ is the trigger by design.
