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
      'Fetch a ClickBank order by receipt ID and run it through the payment gate. Returns { order, gate } where gate.passed indicates whether all conditions are met (transaction type SALE/BILL, identity match, amount > 0, vendor maps to expected project). Pass expected_customer_id (from resolve_customer_identity) when the payment email legitimately differs from the optin email — the gate will bridge identity via the ClickBank cId vendor variable. Never propose mark-paid without calling this first.',
    input_schema: {
      type: 'object',
      properties: {
        receipt: { type: 'string' },
        expected_customer_id: {
          type: 'string',
          description:
            'Optional. asksabrina customer.id obtained from resolve_customer_identity. When provided, an email mismatch becomes a warning instead of a failure if order.customer_id (vendorVariables.cId) matches.',
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
      'Draft an action for human approval. Posts the proposal in the Discord thread; a human reacts ✅ to execute or ❌ to skip. Use this for any DB mutation: update_order (mark-paid), regenerate, or create_order. Do NOT execute directly.',
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
          description: 'Mongo _id of the order to act on (use the ref from lookup_customer)',
        },
        order_kind: {
          type: 'string',
          enum: ['main', 'oto1', 'oto2', 'subscription'],
        },
        payment_meta: {
          type: 'object',
          description:
            'Required for update_order. Source these fields from the verified ClickBank order: { clickbankReceipt, amount, currency, transactionDate, vendor, productSku }',
          properties: {
            clickbankReceipt: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string' },
            transactionDate: { type: 'string' },
            vendor: { type: 'string' },
            productSku: { type: 'string' },
          },
        },
        customer_id_link: {
          type: 'string',
          description:
            'Optional. The asksabrina customer.id used to bridge identity when the ClickBank payment email differs from the optin email. The executor re-runs the gate with this value so the email mismatch is tolerated only when ClickBank.vendorVariables.cId matches.',
        },
        before: {
          type: 'object',
          description: 'Snapshot of the order state before the proposed change (for audit log).',
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
          description: 'Named gates that returned passed=true (e.g. "clickbank.transaction_type_ok", "clickbank.identity_via_cId").',
        },
      },
      required: ['action_type', 'project', 'ref', 'order_kind', 'reasoning', 'gates_passed'],
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
        summary: { type: 'string', description: 'what you investigated and what you found' },
        suggested_next_step: { type: 'string', description: 'optional: what a human should do next' },
      },
      required: ['reason', 'summary'],
    },
  },
]
