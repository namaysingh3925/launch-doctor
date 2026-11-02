import type { Check } from '../types.js';
import { uniqueBy } from '../util.js';
import { appCode, at, emptyOutput, notApplicable, serverCode, where } from './common.js';

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

export const paymentsCheck: Check = {
  id: 'payments',
  name: 'Payments',
  icon: '💳',
  weight: 3,
  run(ctx) {
    const server = serverCode(ctx);
    const stripeServer = ctx.uses('stripe');
    const stripeClient = ctx.usesAny(['@stripe/stripe-js', '@stripe/react-stripe-js']);
    const stripeLinks = ctx.find(/https:\/\/buy\.stripe\.com\//, appCode, 1).length > 0;
    const razorpay = ctx.uses('razorpay') || ctx.find(/checkout\.razorpay\.com/, appCode, 1).length > 0;
    const others = [...new Set(Object.entries(OTHER_PROVIDERS).filter(([pkg]) => ctx.uses(pkg)).map(([, name]) => name))];

    if (!stripeServer && !stripeClient && !stripeLinks && !razorpay && !others.length) {
      return notApplicable('No payment provider found');
    }
    const out = emptyOutput();

    // ---- Stripe ----
    if (stripeServer || stripeClient || stripeLinks) {
      const verified = ctx.find(/webhooks\.constructEvent(?:Async)?\s*\(/, server);
      const eventHints = ctx.find(STRIPE_EVENTS_RE, server);

      if (verified.length) {
        out.passed.push('Stripe webhooks check the signature, so fake "payment succeeded" messages are rejected');
        for (const v of uniqueBy(verified, (m) => m.file.path)) {
          const parsesJson = /\b(?:req|request)\.json\s*\(\s*\)/.test(v.file.content);
          const pagesApiWithParser = /(^|\/)pages\/api\//.test(v.file.path) && !/bodyParser\s*:\s*false/.test(v.file.content);
          if (parsesJson || pagesApiWithParser) {
            out.findings.push({
              id: 'stripe-webhook-parsed-body',
              severity: 'warning',
              title: 'Stripe webhook reads the body as JSON before checking the signature',
              why: 'The signature check needs the exact raw text Stripe sent. If the body is parsed as JSON first, every real webhook fails — customers pay, but your app never finds out.',
              location: at(v),
              fixPrompt:
                `In ${where(at(v))} my Stripe webhook parses the request body as JSON before calling stripe.webhooks.constructEvent. ` +
                `Please change it to read the raw body (for Next.js App Router: "const body = await req.text()"; for Pages Router: disable bodyParser and read the raw buffer; for Express: use express.raw({ type: "application/json" }) on this route only) ` +
                `and pass that raw body to constructEvent. Then show me how to test it with "stripe listen --forward-to".`,
            });
          }
        }
      } else if (eventHints.length) {
        const m = eventHints[0]!;
        out.findings.push({
          id: 'stripe-webhook-unverified',
          severity: 'critical',
          title: "Your Stripe webhook doesn't check that messages really come from Stripe",
          why: 'Anyone can send a fake "payment succeeded" message to your webhook URL and get your product for free. Stripe signs every webhook; your code has to verify that signature.',
          location: at(m),
          fixPrompt:
            `My Stripe webhook handler (${where(at(m))}) does not verify the Stripe signature. Please update it to:\n` +
            `1. Read the raw request body (not parsed JSON).\n` +
            `2. Verify it with stripe.webhooks.constructEvent(rawBody, the "stripe-signature" header, process.env.STRIPE_WEBHOOK_SECRET).\n` +
            `3. Return a 400 error if verification fails, and only handle the event after it passes.\n` +
            `4. Make the handler safe if Stripe sends the same event twice (check whether the order was already processed).\n` +
            `Tell me where to find the webhook signing secret in the Stripe dashboard and how to test with the Stripe CLI.`,
        });
      } else {
        out.findings.push({
          id: 'stripe-no-webhook',
          severity: 'warning',
          title: 'No Stripe webhook found',
          why: "If you unlock features from the \"thank you\" page, customers who close the tab after paying get nothing, and people who cancel or whose card fails keep access. Webhooks tell your server what really happened.",
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
        ctx.find(/validateWebhookSignature|validatePaymentVerification/, server, 1).length > 0 ||
        ctx.files.some((f) => server(f) && /razorpay_signature|x-razorpay-signature/i.test(f.content) && /createHmac/.test(f.content));
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
