import type { Tool } from '@/shared/llm/client.js'

/**
 * Tool surface for the cs-recovery agent.
 *
 * Lookup tools are read-only and safe to call freely. The only mutation-shaped
 * tools are `propose_action` and `escalate_to_human`, both of which post to
 * Discord for human approval — neither writes to a project DB directly.
 */
export const csRecoveryTools: Tool[] = [
  {
    name: 'resolve_customer_identity',
    description:
      'Given a ClickBank receipt, resolve the asksabrina customer record even when the payment email differs from the optin email. Tries in order: (1) lookup by receipt at the project, (2) ClickBank vendorVariables.cId → lookup by customer id, (3) lookup by ClickBank payment email. Returns the customer view, matched_via, payment_email, optin_email, customer_id (cId), contact_id (Maropost), vendor_variables, and email_mismatch flag. Use this BEFORE verify_clickbank_receipt whenever the customer email in the ticket may be wrong or the receipt is the only reliable identifier.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        receipt: { type: 'string' },
      },
      required: ['project', 'receipt'],
    },
  },
  {
    name: 'lookup_customer',
    description:
      'Fuzzy customer lookup against the project. Pass an email, ClickBank receipt, internal orderId, or Mongo _id. Returns the customer view with all products (main / oto1 / oto2 / subscription), payment status, and ready-or-not state for each reading. Always call this first.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        query: { type: 'string', description: 'email | clickbank receipt | orderId | mongo _id' },
      },
      required: ['project', 'query'],
    },
  },
  {
    name: 'verify_clickbank_receipt',
    description:
      'Fetch a ClickBank order by receipt ID and run it through the payment gate. Returns { order, gate } where gate.passed indicates whether all conditions are met (transaction type SALE/BILL, identity match, amount > 0, vendor maps to expected project). Pass expected_customer_id (from resolve_customer_identity) when the payment email legitimately differs from the optin email — the gate will bridge identity via the ClickBank cId vendor variable. When ClickBank carries no cId AND identity was resolved by looking up the receipt email in the project DB (resolve_customer_identity returned matched_via="payment_email"), also pass identity_via_receipt_email=true to enable the last-resort bridge. Never propose mark-paid without calling this first.',
    input_schema: {
      type: 'object',
      properties: {
        receipt: { type: 'string' },
        expected_customer_id: {
          type: 'string',
          description:
            'Optional. asksabrina customer.id obtained from resolve_customer_identity. When provided, an email mismatch becomes a warning instead of a failure if order.customer_id (vendorVariables.cId) matches.',
        },
        identity_via_receipt_email: {
          type: 'boolean',
          description:
            'Optional. Set true ONLY when (a) resolve_customer_identity returned matched_via="payment_email", (b) ClickBank vendor_variables has no cId, and (c) you are also passing expected_customer_id. The gate accepts this as a 3rd identity bridge (receipt billing email → DB customer lookup) and emits a warning naming both emails so the approver sees the discrepancy. Do NOT set this when the cId bridge already works — that path is preferred.',
        },
      },
      required: ['receipt'],
    },
  },
  {
    name: 'find_clickbank_receipts_by_email',
    description:
      'Search ClickBank for orders matching a customer email under the given project vendor. Use when the customer claims to have paid but no order is on file in our DB. Returns an array of orders (may be empty).',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        email: { type: 'string' },
      },
      required: ['project', 'email'],
    },
  },
  {
    name: 'find_all_customer_records',
    description:
      'Discover ALL asksabrina customer records sharing one email. Use when find_clickbank_receipts_by_email returns receipts with more than one distinct cId — the backend creates a new customer record per funnel pass, so lookup_customer(email) only surfaces ONE of them. This tool fetches every cId-linked record AND the email-matched record, groups receipts by cId so you see which record owns which purchase, and flags fragmentation. Returns { records, receipts_by_cid, receipts_without_cid, receipts_unresolved, total_receipts, fragmentation_warning }.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        email: { type: 'string' },
      },
      required: ['project', 'email'],
    },
  },
  {
    name: 'check_regeneration_job',
    description:
      'Check the status of a reading-regeneration job by jobId. Use to see if a previously-triggered regeneration finished, failed, or is still running.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        job_id: { type: 'string' },
      },
      required: ['project', 'job_id'],
    },
  },
  {
    name: 'propose_action',
    description:
      'Draft an action for human approval. Posts the proposal in the Discord thread; a human reacts ✅ to execute or ❌ to skip. Use this for any DB mutation: update_order (mark-paid an existing order), regenerate (re-run delivery), or create_order (insert a missing order when ClickBank has a valid receipt but the asksabrina row was never written). All three execute automatically on ✅; gates re-run at execution time. Do NOT execute directly.',
    input_schema: {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          enum: ['update_order', 'regenerate', 'create_order'],
        },
        project: { type: 'string', enum: ['asksabrina', 'astroloversketch'] },
        ref: {
          type: 'string',
          description:
            'Required for update_order and regenerate — mongo _id of the existing order. Omit for create_order (no row exists yet); use customer_id instead.',
        },
        customer_id: {
          type: 'string',
          description:
            'Required for create_order — the target asksabrina customer.id from resolve_customer_identity or find_all_customer_records. For update_order it is OPTIONAL and acts as an identity bridge: when set, the gate tolerates a payment/optin email mismatch as long as ClickBank.vendorVariables.cId matches (cId bridge), OR identity_via_receipt_email is also set (receipt-email bridge).',
        },
        identity_via_receipt_email: {
          type: 'boolean',
          description:
            'Optional. Mirror of the verify_clickbank_receipt input — set true when the customer was resolved via receipt-email lookup AND ClickBank has no cId. The executor re-runs the gate with this flag at execution time. When true, the reasoning MUST explicitly call out: (a) the ticket/optin email, (b) the receipt billing email, (c) the DB customer the receipt resolves to, and (d) why the approver should still believe this is the same person. The audit log captures the flag so the trust chain is reviewable later.',
        },
        main_order_id: {
          type: 'string',
          description:
            'REQUIRED for create_order kind=oto1 | oto2 | subscription — the mongo _id of the parent main Order this row links to. Pick it from the resolved customer view (customer_view.mainOrders[*].ref). Omit for kind=main. Backend rejects with 400 if missing.',
        },
        billing_email: {
          type: 'string',
          description:
            'Optional for create_order. Snapshot of the ClickBank billing email for audit; backend falls back to customer.email when omitted. Useful when payment email differs from optin email.',
        },
        engine_version: {
          type: 'string',
          enum: ['v1', 'v2'],
          description:
            'Optional for create_order kind=main. Defaults to v2 server-side. Use v1 only when explicitly recovering a legacy funnel order.',
        },
        question: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional for create_order kind=main. The customer\'s 3 intake questions. When the funnel skipped optin (marketing email bypass), these can be sourced from Maropost contact fields asksabrina_question_1/2/3 via the contact_id in ClickBank vendor_variables. Leave empty array if unrecoverable — reading will generate without personalized prompts.',
        },
        order_kind: {
          type: 'string',
          enum: ['main', 'oto1', 'oto2', 'subscription'],
        },
        payment_meta: {
          type: 'object',
          description:
            'Required for update_order AND create_order. Source these fields from the verified ClickBank order: { clickbankReceipt, amount, currency, transactionDate, vendor, productSku }',
          properties: {
            clickbankReceipt: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string' },
            transactionDate: { type: 'string' },
            vendor: { type: 'string' },
            productSku: { type: 'string' },
          },
        },
        before: {
          type: 'object',
          description: 'Snapshot of the order state before the proposed change (for audit log). Null for create_order.',
        },
        after: {
          type: 'object',
          description: 'Expected order state after the proposed change.',
        },
        reasoning: {
          type: 'string',
          description: 'One paragraph explaining WHY this action is safe to take: which gates passed, what evidence matched, and (if applicable) why an email mismatch was acceptable.',
        },
        gates_passed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Named gates that returned passed=true (e.g. "clickbank.transaction_type_ok", "clickbank.identity_via_email", "clickbank.identity_via_cId", "clickbank.identity_via_receipt_email", "clickbank.subscription_active").',
        },
      },
      required: ['action_type', 'project', 'order_kind', 'reasoning', 'gates_passed'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Escalate the ticket to a human. Use when gates fail, edge cases appear (e.g. order not found in our DB but customer paid; refund request; order older than 60 days), or you hit any hard stop.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'one-line summary of why' },
        summary: {
          type: 'string',
          description:
            'What you investigated and what you found. Format as readable Discord markdown following the escalation template in your skill: bold field labels, one line per field. ALWAYS include both readingUrl AND downloadUrl when they exist on the resolved product — CS workflows differ on which one to send.',
        },
        suggested_next_step: { type: 'string', description: 'optional: what a human should do next' },
      },
      required: ['reason', 'summary'],
    },
  },
]
