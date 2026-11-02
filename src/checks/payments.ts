import type { Check, Finding, Location } from '../types.js';
import { uniqueBy } from '../util.js';
import { appCode, at, emptyOutput, isRouteLike, notApplicable, serverCode, where } from './common.js';

const OTHER_PROVIDERS: Record<string, string> = {
  '@lemonsqueezy/lemonsqueezy.js': 'Lemon Squeezy',
  '@paddle/paddle-node-sdk': 'Paddle',
  '@paddle/paddle-js': 'Paddle',
  '@polar-sh/sdk': 'Polar',
  dodopayments: 'Dodo Payments',
  '@paypal/paypal-js': 'PayPal',
  '@paypal/react-paypal-js': 'PayPal',
  '@paypal/checkout-server-sdk': 'PayPal',
  'cashfree-pg': 'Cashfree',
  '@cashfreepayments/cashfree-js': 'Cashfree',
};

const STRIPE_EVENTS_RE =
  /checkout\.session\.completed|invoice\.paid|invoice\.payment_succeeded|customer\.subscription\.(?:created|updated|deleted)|payment_intent\.succeeded|stripe-signature/i;

const VERIFY_RE = /webhooks\.constructEvent(?:Async)?\s*\(/;
const READS_BODY =
  /\b(?:req|request|c\.req)\.(?:text|json|arrayBuffer|body|rawBody|raw|on)\b|\brawBody\b|\bbuffer\s*\(\s*req\b/;
const SIGNATURE_PASSED = 'Stripe webhooks check the signature, so fake "payment succeeded" messages are rejected';

function parsesJsonFirst(path: string, content: string): boolean {
  const parsesJson = /\b(?:req|request)\.json\s*\(\s*\)/.test(content);
  const pagesApiWithParser = /(^|\/)pages\/api\//.test(path) && !/bodyParser\s*:\s*false/.test(content);
  return parsesJson || pagesApiWithParser;
}

function unverifiedFinding(loc: Location): Finding {
  return {
    id: 'stripe-webhook-unverified',
    severity: 'critical',
    title: "Your Stripe webhook doesn't check that messages really come from Stripe",
    why: 'Anyone can send a fake "payment succeeded" message to your webhook URL and get your product for free. Stripe signs every webhook; your code has to verify that signature.',
    location: loc,
    fixPrompt:
      `My Stripe webhook handler (${where(loc)}) does not verify the Stripe signature. Please update it to:\n` +
      `1. Read the raw request body (not parsed JSON).\n` +
      `2. Verify it with stripe.webhooks.constructEvent(rawBody, the "stripe-signature" header, process.env.STRIPE_WEBHOOK_SECRET).\n` +
      `3. Return a 400 error if verification fails, and only handle the event after it passes.\n` +
      `4. Make the handler safe if Stripe sends the same event twice (check whether the order was already processed).\n` +
      `Tell me where to find the webhook signing secret in the Stripe dashboard and how to test with the Stripe CLI.`,
  };
}

const GLOBAL_JSON_PARSER = /\.use\s*\(\s*(?:["'`][^"'`]*["'`]\s*,\s*)?(?:express|bodyParser)\.json\s*\(/;

function parsedBodyFinding(loc: Location, globalParser = false): Finding {
  return {
    id: 'stripe-webhook-parsed-body',
    severity: 'warning',
    title: globalParser
      ? 'A global JSON body parser runs before your Stripe webhook'
      : 'Stripe webhook reads the body as JSON before checking the signature',
    why: 'The signature check needs the exact raw text Stripe sent. If the body is parsed as JSON first, every real webhook fails — customers pay, but your app never finds out.',
    location: loc,
    fixPrompt: globalParser
      ? `In ${where(loc)} my Express app parses every request body as JSON (app.use(express.json())), so my Stripe webhook never gets the raw body it needs for stripe.webhooks.constructEvent. ` +
        `Please register the webhook route with express.raw({ type: "application/json" }) BEFORE the global express.json() line (or skip JSON parsing for that path), ` +
        `pass the raw body to constructEvent, and show me how to test it with "stripe listen --forward-to".`
      : `In ${where(loc)} my Stripe webhook parses the request body as JSON before calling stripe.webhooks.constructEvent. ` +
        `Please change it to read the raw body (for Next.js App Router: "const body = await req.text()"; for Pages Router: disable bodyParser and read the raw buffer; for Express: use express.raw({ type: "application/json" }) on this route only) ` +
        `and pass that raw body to constructEvent. Then show me how to test it with "stripe listen --forward-to".`,
  };
}

export const paymentsCheck: Check = {
  id: 'payments',
  name: 'Payments',
  weight: 3,
  ids: [
    'stripe-webhook-unverified',
    'stripe-webhook-parsed-body',
    'stripe-no-webhook',
    'razorpay-unverified',
    'other-provider-webhooks',
    'live-test-purchase',
    'failed-and-cancelled',
  ],
  run(ctx) {
    const server = serverCode(ctx);
    const stripeServer = ctx.uses('stripe');
    const stripeClient = ctx.usesAny(['@stripe/stripe-js', '@stripe/react-stripe-js']);
    const stripeLinks = ctx.find(/https:\/\/buy\.stripe\.com\//, appCode, 1).length > 0;
    const razorpay = ctx.uses('razorpay') || ctx.find(/checkout\.razorpay\.com/, appCode, 1).length > 0;
    const others = [
      ...new Set(
        Object.entries(OTHER_PROVIDERS)
          .filter(([pkg]) => ctx.uses(pkg))
          .map(([, name]) => name),
      ),
    ];

    if (!stripeServer && !stripeClient && !stripeLinks && !razorpay && !others.length) {
      return notApplicable('No payment provider found');
    }
    const out = emptyOutput();

    // ---- Stripe ----
    if (stripeServer || stripeClient || stripeLinks) {
      const verified = ctx.findCode(VERIFY_RE, server);
      const eventHints = ctx.find(STRIPE_EVENTS_RE, server);

      // Helpers that wrap constructEvent (e.g. lib/stripe.ts exporting verifyStripeWebhook) count as verification
      // when a route calls them.
      const helperNames = new Set<string>();
      const helperFiles = uniqueBy(verified, (m) => m.file.path)
        .map((m) => m.file)
        .filter((f) => !isRouteLike(f));
      for (const f of helperFiles) {
        for (const h of ctx.codeOf(f).matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=/g)) {
          helperNames.add((h[1] ?? h[2])!);
        }
      }
      const helperRe = helperNames.size ? new RegExp(`\\b(?:${[...helperNames].join('|')})\\s*\\(`) : null;
      const isVerified = (content: string) => VERIFY_RE.test(content) || (helperRe?.test(content) ?? false);

      // Every route that reads a request body and talks about Stripe events is checked on its own.
      const webhookRoutes = uniqueBy(eventHints, (m) => m.file.path).filter(
        (m) => isRouteLike(m.file) && READS_BODY.test(m.file.content),
      );

      if (webhookRoutes.length) {
        const unverified = webhookRoutes.filter((m) => !isVerified(ctx.codeOf(m.file)));
        for (const m of unverified) out.findings.push(unverifiedFinding(at(m)));
        for (const m of webhookRoutes) {
          if (unverified.includes(m)) continue;
          if (parsesJsonFirst(m.file.path, ctx.codeOf(m.file))) out.findings.push(parsedBodyFinding(at(m)));
        }
        if (!unverified.length) out.passed.push(SIGNATURE_PASSED);
      } else if (verified.length) {
        out.passed.push(SIGNATURE_PASSED);
        for (const v of uniqueBy(verified, (m) => m.file.path)) {
          if (parsesJsonFirst(v.file.path, ctx.codeOf(v.file))) out.findings.push(parsedBodyFinding(at(v)));
        }
      } else if (eventHints.length) {
        out.findings.push(unverifiedFinding(at(eventHints[0]!)));
      }

      // A global JSON body parser (Express) eats the raw body before any webhook route sees it.
      if (verified.length || eventHints.length) {
        const globalJson = ctx.find(GLOBAL_JSON_PARSER, server)[0];
        const rawUsed = ctx.find(/\b(?:express|bodyParser)\.raw\s*\(/, server, 1).length > 0;
        if (globalJson && !rawUsed) out.findings.push(parsedBodyFinding(at(globalJson), true));
      }

      if (!verified.length && !eventHints.length) {
        out.findings.push({
          id: 'stripe-no-webhook',
          severity: 'warning',
          title: 'No Stripe webhook found',
          why: 'If you unlock features from the "thank you" page, customers who close the tab after paying get nothing, and people who cancel or whose card fails keep access. Webhooks tell your server what really happened.',
          fixPrompt:
            `My app takes payments with Stripe but has no webhook. Please add a webhook endpoint that: verifies the signature with stripe.webhooks.constructEvent using the raw body and STRIPE_WEBHOOK_SECRET; ` +
            `handles checkout.session.completed (give the customer access), customer.subscription.updated / customer.subscription.deleted (change or remove access) and invoice.payment_failed; ` +
            `and is safe if the same event arrives twice. Move any "unlock the feature" logic from the success page into this webhook. Explain how to register it in the Stripe dashboard.`,
        });
      }
    }

    // ---- Razorpay ----
    if (razorpay) {
      const verified =
        ctx.findCode(/validateWebhookSignature|validatePaymentVerification/, server, 1).length > 0 ||
        ctx.files.some(
          (f) =>
            server(f) &&
            /razorpay_signature|x-razorpay-signature/i.test(ctx.codeOf(f)) &&
            /createHmac/.test(ctx.codeOf(f)),
        );
      if (verified) {
        out.passed.push('Razorpay payments are verified on the server');
      } else {
        const m = ctx.find(/razorpay_payment_id|razorpay/i, appCode, 1)[0];
        out.findings.push({
          id: 'razorpay-unverified',
          severity: 'critical',
          title: "Razorpay payments aren't verified on your server",
          why: "Without checking Razorpay's signature on your server, someone can fake a successful payment from their browser and get your product without paying.",
          location: m ? at(m) : undefined,
          fixPrompt:
            `My app uses Razorpay but never verifies payments on the server. Please: after checkout, send razorpay_order_id, razorpay_payment_id and razorpay_signature to a server route ` +
            `and verify them with validatePaymentVerification from "razorpay/dist/utils/razorpay-utils" (or an HMAC-SHA256 of "order_id|payment_id" using RAZORPAY_KEY_SECRET). ` +
            `Only mark the order as paid if it matches. Also add a webhook route that checks the X-Razorpay-Signature header with validateWebhookSignature and RAZORPAY_WEBHOOK_SECRET.`,
        });
      }
    }

    if (others.length) {
      out.manual.push({
        id: 'other-provider-webhooks',
        title: `Make sure your ${others.join(' / ')} webhooks verify their signature`,
        how: 'Every payment provider signs its webhooks. Your server must check that signature before giving anyone access, or payments can be faked.',
      });
    }

    out.manual.push(
      {
        id: 'live-test-purchase',
        title: 'Make one real purchase in live mode, then refund it',
        how: 'Test mode hides problems with live keys, live webhooks and tax settings. Buy your own product with a real card once after deploying.',
      },
      {
        id: 'failed-and-cancelled',
        title: 'Check what happens when a payment fails or a subscription is cancelled',
        how: 'Use test cards that decline (e.g. 4000 0000 0000 0002 on Stripe) and cancel a test subscription. The user should lose access, and nothing should crash.',
      },
    );

    return out;
  },
};
