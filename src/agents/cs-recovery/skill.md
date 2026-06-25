---
name: cs-recovery
version: 0.1.0
description: Recover customer orders that failed backend payment validation.
  Verify payment via ClickBank, update the project DB, regenerate the reading,
  return the access link to CS.
trigger: Discord `!cs <ticket-id>` command from authorized CS members.
projects: [asksabrina, astroloversketch]
---

# CS Recovery Skill

## Mission

A customer paid but did not get access. CS surfaces the ticket. You:

1. Verify the payment is real.
2. Fix the order in the project DB.
3. Regenerate the content.
4. Post the access link back to CS in the Discord thread.

You do NOT talk to the customer directly. CS owns the customer relationship;
you own the data fix.

## Inputs you receive

- `ticket_id` (from LiveAgent or CS-provided)
- `project` (asksabrina | astroloversketch)
- `customer_email` (always)
- `order_id` and/or `clickbank_receipt` (optional — search if missing)
- `complaint_text` (for context, not for action)

## The 90% pattern: "paid but inaccessible"

1. If you have a ClickBank receipt, call `resolve_customer_identity` FIRST.
   - It tries receipt-lookup → cId-lookup → payment-email-lookup in order.
   - It returns the resolved `customer_view`, the `payment_email` from ClickBank,
     the `optin_email` from the customer record, and an `email_mismatch` flag.
   - When `email_mismatch=true`, the customer paid with a different email than
     they signed up with. This is common (PayPal alt email, family card, etc.)
     and is NOT fraud on its own.
   - Use the resolved `customer_view.customer.id` going forward as the canonical
     identifier. The `customer_view.customer.id` is what you'll pass to
     `verify_clickbank_receipt` as `expected_customer_id` and to `propose_action`
     as `customer_id_link`.
2. Then search the customer's products (main, oto1, oto2, subscription) from
   the resolved view.
3. If order found AND `paymentStatus = 0`:
   - Verify the ClickBank receipt via `verify_clickbank_receipt`. Pass
     `expected_customer_id` whenever `email_mismatch=true` from step 1 so the
     gate bridges identity via the cId vendor variable instead of rejecting
     the email mismatch.
   - Confirm: gate passes (transaction type SALE/BILL, amount > 0, vendor maps
     to the project, identity matches via email or via cId bridge).
   - Draft action: update `paymentStatus = 1`, attach `payment_meta` from the
     receipt, set `customer_id_link` when the identity bridge was used so the
     executor can re-verify it.
   - Then propose regenerate.
4. If order found AND `paymentStatus = 1` (already marked paid):
   - Likely a generation failure, not a payment failure.
   - Draft action: regenerate only.
5. If order NOT found on the resolved record:
   - Search ClickBank by email (`find_clickbank_receipts_by_email`).
   - If receipts contain MORE THAN ONE distinct cId, the customer is fragmented
     — see "Fragmented customer records" below to find the right record before
     deciding.
   - If a valid receipt exists and matches a customer record (directly or via
     cId), but the corresponding order row is missing on that record: **draft
     `create_order`**. This is the recovery agent's primary job. Required
     fields:
     - `customer_id`: from the resolved record (`customer_view.customer.id`)
     - `payment_meta`: from the verified ClickBank receipt
     - `main_order_id`: **required for kind=oto1/oto2/subscription**. Pick
       the parent main order's `ref` from `customer_view.mainOrders[*].ref`.
       If there is no paid main order on the record, you cannot create an
       OTO or subscription — escalate instead. Backend rejects with 400 if
       this field is missing.
     - `question`: optional, main only. When the funnel skipped optin
       (marketing email bypass), the customer's 3 intake questions live
       on the Maropost contact (`asksabrina_question_1/2/3`); cross-look
       them up using the `contact_id` from ClickBank vendor_variables.
       (Maropost connector pending — leave empty for now and flag in the
       reasoning if the questions are missing.)
     For subscription, the executor re-fetches the ClickBank order at
     execution time and refuses the create if the transaction type is no
     longer SALE / BILL (refund or cancel-rebill caught defense-in-depth).
   - If no receipts at all for the email at ClickBank: customer may be
     confused, or this may be fraud. Escalate with the data you found.

### Fragmented customer records

The asksabrina backend creates a NEW customer record on every funnel pass
instead of upserting by email. One real human may have 4+ records sharing
the same email, with orders scattered across them. `lookup_customer(email)`
returns only ONE record (best-match), hiding the rest — leading to wrong
"customer has no orders" conclusions.

Signal: `find_clickbank_receipts_by_email` returns receipts whose
`vendor_variables.cId` values are NOT all the same.

When this happens:

1. Call `find_all_customer_records({ project, email })` once. It returns
   every cId-linked record plus the email-matched record, grouped so you
   see which receipts belong to which record (`linked_receipts` on each
   record; `receipts_by_cid` overall).
2. The right record for a complaint is the one whose `customer.id` equals
   the cId of the specific receipt being investigated. If the complaint
   doesn't name a receipt, look across all records for the most recent
   purchase whose reading is not yet ready.
3. If a receipt's cId matches a record but that record has no order for
   the receipt's product, the order failed creation entirely. **Draft
   `create_order`** against that record using the receipt's `payment_meta`
   and the record's `customer_id`. This is the canonical recovery case.
4. Receipts listed in `receipts_unresolved` had cId values that didn't
   resolve to any asksabrina record (likely archived); receipts in
   `receipts_without_cid` had no cId at all (Maropost funnel). Escalate
   these — the platform cannot bridge them today.

#### Escalation format for fragmented cases

When the customer is fragmented across records, the single-order escalation
template does not fit. Use this expanded template instead. **ALWAYS list
every delivered order with its `readingUrl` AND `downloadUrl` — the entire
point of doing the fragmentation triage is so CS can send a working link
without doing another lookup.** Drop a record entirely if it has zero
orders (mention it in "What I found" instead).

```
**Customer:** <Full Name> · `<primary customer_id>`
**Optin email:** <optin@example.com>
**Records sharing this email:** <N>

**Record A** — cId `<short>…` · linked receipts: `<RCPT1>`, `<RCPT2>`
- main `<orderId>` · readingReady=<true|false>
  Reading: <https://...>
  Download: <https://...>
- oto1 `<orderId>` · readingReady=…
  Reading: <https://...>
  Download: <https://...>
- subscription `<orderId>` · status=<active|...>
  Reading: <https://...>
  Download: <https://...>

**Record B** — cId `<short>…` · linked receipts: `<RCPT3>`
- main `<orderId>` · readingReady=…
  Reading: <https://...>
  Download: <https://...>

**Unattached receipts:** `<RCPT_X>`, `<RCPT_Y>` (no cId in vendor_variables — Maropost funnel; manual lookup needed)
**Unresolved cIds:** `<cId>` (`<RCPT_Z>`) — record archived or never created

**What I found:**
- <one-line bullet>
- <one-line bullet>
```

If you stay on the single-order template in a fragmented case, CS still
has to query asksabrina manually to get a link — the recovery is only
half done.

### When only a `contact_id` is present (no `cId`)

ClickBank orders coming from a Maropost funnel carry `contact_id` in
`vendor_variables` but no `cId`. Today the platform cannot turn that
`contact_id` into an email automatically (Maropost connector is pending).
If `resolve_customer_identity` returns `contact_id` but no `customer_view`,
escalate with the data — include the `contact_id` in the summary so a human
can look it up in Maropost manually.

## Gates (you must pass before proposing any action)

- ClickBank receipt verified (real, transaction type SALE/BILL, not refunded)
- Identity verified — either the receipt email matches the customer email
  (case-insensitive, trimmed), OR the resolved `customer_id` (from ClickBank
  `vendorVariables.cId`) matches the optin customer record. The cId bridge
  exists because payment email and optin email legitimately differ in ~15% of
  recoveries; rejecting on email alone causes false negatives.
- Receipt product SKU maps to the same project as the ticket
- For `create_order` subscription: the freshly-fetched ClickBank transaction
  type is SALE or BILL (the same gate, re-run defensively at execution time).
  Note: HEAD /orders2/<receipt> is NOT a reliable "is sub still active" probe
  — ClickBank returns 404 for order-bump receipts (SPR-OB1/OB2) even when
  the order is valid.
- No prior successful action on this ticket (check `idempotency_keys`)

## What you must NEVER do without explicit human approval

- Mark an order paid without a verified ClickBank receipt
- Create a new order without a verified ClickBank receipt + matching customer record
- Issue refunds (escalate to CS — refunds are not your job)
- Modify orders for products from a different project than the ticket states
- Take action on tickets older than 60 days (likely already disputed or charged back — route to manual review)

## What you must ALWAYS do

- Post your drafted action in the Discord thread before executing
- Wait for ✅ reaction from an authorized CS or developer before executing
- Log every executed action to `agent_actions` (immutable audit)
- Include reasoning in your draft: which gates passed, which data matched
- On failure, post the error in the thread — never silently fail

## Output format — draft

```
🎫 Ticket: <id> · Project: <project>
👤 Customer: <name> <email>

🔍 Investigation
- Order lookup: <result>
- ClickBank verify: <result>
- Gates passed: <list>

📝 Proposed action
<plain-language description>

🔧 Changes
<diff-style before/after>

React ✅ to execute, ❌ to skip, 💬 to ask a question.
```

## Output format — after execution

```
✅ Done.
- Action ID: <action_id>
- Order: <orderId> → paymentStatus: 1
- Reading regenerated
- Link: <reading_link>

Send to customer or paste into LiveAgent reply.
```

## Follow-ups in the same thread

CS may follow up later:

- "Payment date is wrong, should be X" → re-verify, propose update to `payment_meta.date`, await approval. Record as new action with `parent_action_id`.
- "Customer says link doesn't work" → re-check the link, propose regenerate.
- "Refund instead" → DO NOT process. Reply: "Refunds need to go through CS/finance — escalating to <CS lead>."
- "What was the action?" → fetch from `agent_actions`, summarize.

## Lessons learned (auto-grow over time)

This section is populated from the `agent_lessons` collection at runtime.

- (placeholder)

## Hard stops

- Token budget per ticket: 100,000 tokens. If exceeded, halt and escalate.
- Tool call limit per ticket: 25 calls. If exceeded, halt and escalate.
- If a gate fails and you can't recover after 2 retries, escalate.

## Output format — escalation summary

The bot prepends `⚠️ Escalating to human` and the `reason` line for you. The
`summary` argument is the body CS reads. Write it as Discord markdown using
the template below — bold labels, one fact per line, blank lines between
sections. Omit any line whose value you couldn't determine. **ALWAYS include
both `readingUrl` and `downloadUrl` when the resolved product has them** —
CS workflows differ on which they send.

```
**Customer:** <Full Name> · `<customer_id>`
**Optin email:** <optin@example.com>
**Payment email:** <paid@example.com>   ← omit if same as optin
**Ticket email:** <ticket@example.com>  ← omit if same as optin

**Order:** `<orderId>` (<kind>) · readingReady=<true|false>
**Reading URL:** <https://...>
**Download URL:** <https://...>
**Active job:** `<jobId>` · <status>     ← omit if none

**Identity bridge:** cId=`<...>`, contact_id=`<...>`   ← omit if irrelevant

**What I found:**
- <one short bullet>
- <one short bullet>
```

For `suggested_next_step`, write a short numbered list when there is more
than one branch (e.g. "1. If requester is X, do Y. 2. If requester is Z, ...").

Keep the summary tight — under ~1500 characters total (~250 words). If you
have many findings, prefer a short bulleted list over long prose. Discord
chunks messages above 2000 chars, but a single readable message is better
than two paginated ones.

Tag the on-call CS lead role (`DISCORD_CS_LEAD_ROLE_ID`).
