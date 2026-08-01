# Handoff: Tala → Poseidon

Audience: whoever maintains Tala's instructions, plus CS (Leo) so everyone
knows what changed and who still signs off.

## Answers to the four review items

Revision 2. If you reviewed the first version, these are the only parts that
changed — the rest is unmodified.

1. **Login / account lockouts** — correct, no capability, and now an explicit
   carve-out under *What Poseidon will NOT take*. They stay on the human path.
   One thing worth checking before you route one: most "I can't get in"
   tickets turn out to be "I lost my link", which **is** handled.
2. **The 60-day cutoff** — the first version overstated this and would have
   led you to add a filter that bounces valid tickets. It is enforced on
   exactly one operation (flipping an existing order to paid), not on tickets
   in general. See *The 60-day rule is narrower than it sounds*. An age check
   on your side is only worth it for the payment-recovery case.
3. **Dual-brand regeneration** — answered under *Brands*. Short version: the
   agent runs no generation logic of its own, it asks each brand's backend,
   so the two pipelines cannot be crossed. There is a separate config caveat
   for AstroLoverSketch flagged in that section — please read it before
   sending an ALS ticket.
4. **Leo's visibility** — yes, keep tagging Leo. That was a real gap and it
   has been fixed on our side too: whoever you tag on the way in is now
   @-mentioned on the outcome message, so Leo is pinged when the link is
   ready instead of having to watch the channel.

## What changes

Today, when Leo hits a technical problem in LiveAgent — a profile that needs
correcting, an order that can't be found, a customer asking for their link —
Tala mentions **rohmaddj** and a human picks it up by hand.

From now on Tala mentions **@poseidon** instead.

Nothing else about the escalation path changes. **rohmaddj is still the last
gate.** Poseidon investigates and drafts a fix, but it cannot write anything
to a production database on its own: every change waits for rohmaddj's
explicit ✅, delivered privately over DM. A ❌ discards it. No approval, no
write — there is no override and no timeout that auto-approves.

So the practical difference is only *who does the investigation*. The
decision stays with a human.

## What Poseidon can take

| Case | What it does |
|---|---|
| **Profile change** | Wrong birthdate, misspelled name, wrong zodiac / gender / city. Patches the customer record and, when the field feeds the reading, regenerates it. |
| **Order not found** | Customer was charged but has no order on our side. Verifies the receipt at ClickBank first, then backfills the order and generates the reading. |
| **Request link** | "Where's my reading / download link?" Resolves the customer and returns the live URLs. Regenerates if the reading was never built. |

## What Poseidon will NOT take

It escalates back to a human instead of guessing. Don't route these to it:

- **Refunds or chargebacks** — never. Human decision.
- **Email address changes** — deliberately not editable; it breaks Maropost
  sync and customer login.
- **Login / account lockouts** — no capability at all. Poseidon can read and
  patch profile data, but it cannot touch credentials, reset a password, or
  unlock an account; no such endpoint is exposed to it. These stay on the
  existing human path.
  **But check what the customer actually means first.** Most "I can't get in"
  tickets are really "I lost the link from my email" — that *is* the *request
  link* case above and Poseidon handles it. Only a genuine credential problem
  needs a human.
- **Complaints with no email and no receipt** — it has nothing to look up.

### The 60-day rule is narrower than it sounds

The hard block lives on **one** operation: flipping an existing order to paid.
Both brand APIs refuse that outright past 60 days, because an order that old
has usually been disputed or charged back already.

It is **not** a general age filter on tickets:

| Case | Older than 60 days? |
|---|---|
| Profile change | Fine. No age limit. |
| Request link | Fine. No age limit. |
| Order not found / paid-but-no-access | Will be refused or escalated. |

So an age check on Tala's side is only worth adding for the payment-recovery
case. Applying it to all three would bounce perfectly valid tickets — a
customer asking for a link to a reading they bought last year is normal, and
Poseidon resolves it without complaint.

## Brands

Both **AskSabrina** and **AstroLoverSketch** are supported. Poseidon picks the
brand from the receipt, or from the email when the customer exists on only one
side. Name the brand in the message when the customer might exist on both.

On regeneration specifically: Poseidon does **not** run any generation logic
itself. It asks the brand's own backend to do it, and that backend runs its
own pipeline with its own worker. The two brands' pipelines differ and always
have — the split happens at the point Poseidon chooses which brand to call, so
there is no shared "one universal regen path" that could be applied to the
wrong brand. The same is true of the editable-field list, which differs per
brand and is enforced by each brand's API rather than by Poseidon.

⚠️ **Before the first live AstroLoverSketch ticket**, confirm with Rohmad that
the ALS credentials are configured on the agent host. The code path is
complete, but the connection details were still blank as of this writing, and
an ALS ticket sent before they're filled in fails immediately rather than
degrading gracefully. AskSabrina is configured and live.

## Message format

One mention = one customer. Everything goes in a single message in the CS
channel.

**The one hard requirement: include an email address, a ClickBank receipt, or
both.** Without at least one of those, Poseidon replies asking for it and
stops.

**Keep tagging Leo** (or whoever owns the ticket) alongside @poseidon, exactly
as WF5 does today. Extra mentions don't interfere with parsing — they're
stripped before the message is read — and Poseidon now carries them through:
whoever was tagged on the way in gets @-mentioned on the outcome message, so
Leo is pinged when the link is ready rather than having to watch the channel.

### Minimum — will work

```
@poseidon @leo jane@example.com
@poseidon @leo ABC12345
```

Poseidon figures out the brand and pulls the customer's full history itself.
Use this when Tala genuinely has nothing else.

### Recommended — what Leo should aim for

Add, in plain words, what's wrong and what it should become:

```
@poseidon @leo jane@example.com — birthdate is wrong, should be 1990-05-14
@poseidon @leo jane@example.com — paid but no order, receipt ABC12345
@poseidon @leo jane@example.com — asking for her link, never got the email
```

The free text matters. Without it Poseidon only knows *who*, not *what*, and
tends to conclude nothing is broken.

### Rich — best case

```
@poseidon @leo ticket=LA-88421 jane@example.com ABC12345 asksabrina — customer
says her birthdate was entered wrong at checkout, should be 1990-05-14
(currently 1990-04-15). Reading already delivered.
```

`ticket=LA-88421` pins the LiveAgent ticket id into the audit log, so the
action can be traced back to the original conversation later. Without it,
Poseidon generates its own id from the Discord message.

### What each case actually needs

| Case | Required | Strongly recommended |
|---|---|---|
| Profile change | email | the field **and** its new value, in plain words |
| Order not found | **receipt** (ClickBank must verify it) | email, amount, purchase date |
| Request link | email *or* receipt | which product — main reading, upsell, subscription |

For "order not found" the receipt is not optional in practice: Poseidon
refuses to create an order that ClickBank can't confirm, so a mention without
one just becomes an escalation.

## Rules Tala must follow

These come from how the message is parsed. Breaking them causes a bad read,
not a crash — which is worse, because it's quiet.

1. **One receipt per message.** Two or more and Poseidon refuses and asks
   which one. Separate customers → separate mentions.
2. **Don't write in ALL CAPS.** ClickBank receipts are uppercase, so a word
   like `SKETCH` or `URGENT` can be mistaken for one. Normal sentence case is
   fine — `Scorpio` and `Jane Doe` parse correctly.
3. **`ticket=` takes no spaces.** `ticket=LA-88421`, not `ticket = LA 88421`.
   Letters, digits, `-` and `_` only.
4. **Put the new value in the message, spelled out.** "should be 1990-05-14"
   works. "fix her birthday" gives Poseidon nothing to apply.
5. **Brand name is optional** — `asksabrina` / `astrolover` (and the obvious
   variants). Include it when the customer might exist on both brands;
   otherwise Poseidon resolves it from the receipt or the email.
6. **Mention in the CS channel, not in a DM.** A DM between Tala and a person
   is invisible to Poseidon — it isn't a participant in that conversation and
   will never receive the message. This is a Discord limitation, not a
   setting.

## What Tala should expect back

In the channel, exactly two messages per ticket:

1. **Immediately:** `🤖 Processing <ticket> for <email> — sending to
   @rohmaddj for confirmation.`
2. **After rohmaddj decides** — addressed to whoever Tala tagged, so Leo is
   pinged directly — one of:
   - `✅ @rohmaddj approved — <ticket> is done.` plus the reading / download
     link, which Leo can paste straight into the LiveAgent reply.
   - `❌ @rohmaddj rejected the change for <ticket> — nothing was modified.`
   - `⚠️ Couldn't handle <ticket> automatically — escalated to a human.` with
     the reason.
   - `ℹ️ <ticket> — no action needed.` when nothing was actually broken.

Everything between those two messages happens in a thread and in rohmaddj's
DM, so the channel stays readable.

**Tala should not re-send a ticket that's already in flight.** There's no
fixed turnaround — it depends on when rohmaddj sees the DM. Re-sending
creates a second investigation and a second approval for the same customer.
If something looks stuck, check the thread under the original message.

## The approval, stated plainly

For anyone reviewing this: Poseidon has read access to ClickBank and to both
brand databases, and can propose writes. It cannot execute one. The write
path runs only after a ✅ from rohmaddj specifically — a reaction from anyone
else on the same draft is ignored — and the payment checks are re-run at that
moment, not reused from when the draft was written, so a refund landing in
between blocks the change.

Every executed action is written to an append-only audit log with who
approved it, when, and why.
