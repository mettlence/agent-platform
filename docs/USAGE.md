# Usage — Discord bot (for CS and operators)

Audience: CS team members and on-call operators. If you're a developer or an AI
agent extending the platform, read `docs/AGENT_GUIDE.md` instead.

The bot lives in the configured CS Discord channel. It only responds inside the
guilds and channels listed in `DISCORD_GUILD_IDS` / `DISCORD_CS_CHANNEL_IDS`
(and threads under those channels). Anywhere else it ignores you.

## What the bot does

You give it a customer complaint ("paid but no access"). It:

1. Verifies the ClickBank receipt.
2. Finds the right customer record (even when the payment email differs from
   the optin email, or when the customer has multiple records).
3. Drafts a fix in a Discord thread — no writes yet.
4. Waits for your ✅ before touching the project DB.
5. On ✅, marks the order paid (if needed), regenerates the reading, and posts
   the access link back in the thread.

It never messages the customer. That's still your job — the bot hands you a
working link to paste into LiveAgent.

## Starting an investigation

Two entry points, use whichever is faster.

### 1. Mention the bot (natural form)

```
@bot ABC12345
@bot jane@example.com
@bot ABC12345 jane@example.com asksabrina
@bot fix this          (as a reply to a customer message)
```

The bot infers what it can from what you give it:

- **Receipt only** — derives brand + payment email from ClickBank.
- **Email only** — if the customer exists on exactly one brand, uses that
  brand. If on multiple, asks you to pick.
- **Reply with `fix this`** — reads the message you're replying to plus recent
  thread history for context.

### 2. Explicit `!cs` command

```
!cs <ticket-id> email=jane@example.com
!cs 12345 email=jane@example.com receipt=ABC12345
!cs 12345 email=jane@example.com project=asksabrina complaint="paid via paypal, no email"
```

Use this when you want the ticket ID pinned to the audit log or when the
mention form is ambiguous. Project auto-detects from the receipt when
provided.

Type `!help` in a CS channel for the short reference.

## What happens next

The bot creates (or reuses) a thread and posts a **draft** that looks like:

```
🎫 Ticket: 12345 · Project: asksabrina
👤 Customer: Jane Doe <jane@example.com>

🔍 Investigation
- Order lookup: found (paymentStatus=0)
- ClickBank verify: SALE, $47, vendor=sabrinapsy
- Gates passed: transaction-type, amount, vendor→project, identity(email)

📝 Proposed action
Mark order ORD-abc123 paid + regenerate reading.

🔧 Changes
- paymentStatus: 0 → 1
- payment_meta: (attached from receipt)

React ✅ to execute, ❌ to skip, 💬 to ask a question.
```

Your options:

- **✅** — the bot re-verifies the gates (in case something changed since the
  draft), executes the action, and posts the reading link in the thread.
- **❌** — action is cancelled, logged, nothing touches the DB.
- **💬** — reply in the thread with your question or extra context. The bot
  re-investigates using the new info.

Any authenticated Discord member in the allowlisted channel can approve today.
Per-role gating is not yet wired.

## Follow-ups in the same thread

Just @-mention the bot again inside the existing thread. It picks up the
prior context — no need to repeat the receipt or email.

Common follow-ups:

- **"link doesn't work for the customer"** → bot re-checks and proposes a
  re-generation.
- **"payment date should be X"** → bot proposes updating `payment_meta.date`.
- **"actually refund this"** → bot refuses. Refunds route to CS/finance
  manually — that's by design.
- **"what did you do?"** → bot summarises from the immutable action log.

If the bot goes silent on a follow-up, check the thread for an error — it
never fails silently.

## When the bot escalates

If a gate fails, the ticket is >60 days old, or the customer looks fragmented
in a way the bot can't safely resolve, it posts an **escalation summary**
tagged with the CS lead role instead of a draft. The summary always contains
enough info (customer id, receipt, both emails, existing reading/download
URLs) that you can respond to the customer without re-querying anything.

Common escalation causes:

- Receipt has no `cId` and no matching customer record — likely a Maropost
  funnel that predates the current identity bridge.
- Receipt is refunded or charged back at ClickBank — refund policy owns this.
- Ticket age > 60 days.
- More than one distinct `cId` under the same email, and the bot can't tell
  which record the complaint refers to (rare — usually the summary lists all
  records and asks you to pick).

## Reading the "Done" message

After ✅ and successful execution:

```
✅ Done.
- Action ID: 66f3...
- Reading: https://...
- Download: https://...

Send to customer or paste into LiveAgent reply.
```

If you see `(reading generation still running — job JOBID...)`, the DB write
succeeded but the reading is still being generated. Re-run `!cs <ticket>` in
a few minutes to fetch the link once ready.

If you see `❌ Execution failed`, the pre-execution gate re-check caught a
change between draft and approval (usually a refund that landed in between).
The action was not applied — that's the safety design working.

## Troubleshooting

- **Bot didn't reply to my mention** → check the channel is in
  `DISCORD_CS_CHANNEL_IDS`. If it's a thread, the parent channel must be
  allowlisted.
- **"Project auto-detect failed"** → pass `project=asksabrina` (or the right
  brand) explicitly with `!cs`.
- **"Customer has no orders"** but you know they paid → the bot should have
  fetched their full ClickBank history and either drafted `create_order` or
  escalated. If it stops at "no orders", ping the on-call dev — that's a bug
  in the skill, not user error.
- **Reading link 404s after ✅** → job may still be running; wait 2–3 minutes
  and re-run `!cs <ticket>`. If still broken, escalate.
- **Bot posted a draft in the wrong thread** → don't ✅. Ping the dev — the
  approval is keyed by Discord message ID so nothing has been executed yet.

## Monitoring pending order generation

The bot can also run a scheduled check for paid orders whose reading has
not been generated yet. Useful when you want to catch stuck generation
without polling the admin panel yourself.

### Start a monitor

Natural form:

```
@bot monitor pending asksabrina every 4h for 24h
@bot cronjob check pending both per 2h selama 12 jam
```

Explicit command form:

```
!monitor asksabrina every 4h for 24h
!monitor both every 4h for 24h
```

Bounds: interval 1h–24h, duration 1h–7d, duration ≥ one interval. Projects
recognized: `asksabrina`, `astroloversketch`, or `both`/`semua`/`all`.

The bot creates a thread, posts a preview of what it's about to schedule
(projects, interval, total ticks, expiry), and waits for ✅.

### What each tick reports

On ✅, the first tick fires immediately (baseline). Subsequent ticks fire
every N hours. Each report shows, per project:

- **Total pending** now, and the delta since last tick (`+3 new`, `-1 resolved`)
- **⚠️ Stuck** — items that stayed pending across ticks and have been paid
  for more than 30 minutes. This is your action list.
- **✨ New this tick** — items that just showed up. Usually fine — the
  generation queue is picking them up. Watch them across ticks.
- **✅ Resolved** — items that were pending last tick and are now gone.

The next check timestamp is included at the bottom (`<t:...>` renders as a
localized time in Discord).

### Stopping early

Inside the monitor thread:

```
!stop-monitor
```

The bot confirms and stops firing further ticks. Auto-stop also happens
when the duration elapses.

### One monitor per thread

Only one active monitor per Discord thread. If you try to start a second
one in the same thread, the bot rejects it and points you at
`!stop-monitor` first. Start a fresh thread for a different schedule
(different interval, different projects).

## What the bot will not do

- Talk to the customer.
- Issue refunds.
- Modify an order for a product from a different brand than the ticket states.
- Act on tickets older than 60 days.
- Execute anything without a ✅.

Anything in that list will be politely refused with a short reason.
