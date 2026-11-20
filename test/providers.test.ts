import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import type { Finding, Report } from '../src/types.js';
import { category, fakeJwt, fakeKey, ids, makeProject } from './helpers.js';

const opts = { offline: true, useGit: false };

const scan = (files: Record<string, string>) => runDoctor(makeProject(files), opts);
const find = (report: Report, id: string): Finding | undefined =>
  report.categories.flatMap((c) => c.findings).find((f) => f.id === id);
const manualIds = (report: Report) => report.categories.flatMap((c) => c.manual.map((m) => m.id));

/** A random-looking hex string built at runtime (Appwrite keys are hex). */
function fakeHex(length: number, seed: number): string {
  let x = seed >>> 0 || 1;
  let out = '';
  while (out.length < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += '0123456789abcdef'[x % 16];
  }
  assert.ok(!/abcdef|123456|0{6,}/.test(out), 'seed makes a placeholder-looking key; pick another');
  return out;
}

const server = (deps: Record<string, string>) => JSON.stringify({ name: 'provider-app', dependencies: deps });

// ---------------- keys ----------------

test('Clerk secret keys are told apart from Stripe keys', async () => {
  const live = fakeKey('sk_' + 'live_', 40, 11);
  const byName = await scan({
    'package.json': server({ next: '16', stripe: '18', '@clerk/nextjs': '6' }),
    'lib/clerk.ts': `export const CLERK_SECRET_KEY = "${live}";\n`,
  });
  assert.equal(find(byName, 'clerk-secret-key')?.severity, 'critical');
  assert.ok(!ids(byName).includes('stripe-live-key'), 'the CLERK_ name on the line wins');
  assert.match(find(byName, 'clerk-secret-key')!.fixPrompt, /CLERK_SECRET_KEY/);

  const clerkOnly = await scan({
    'package.json': server({ next: '16', '@clerk/nextjs': '6' }),
    'lib/keys.ts': `export const key = "${fakeKey('sk_' + 'test_', 40, 12)}";\n`,
  });
  assert.equal(find(clerkOnly, 'clerk-test-secret-key')?.severity, 'warning');

  const stripeApp = await scan({
    'package.json': server({ next: '16', stripe: '18', '@clerk/nextjs': '6' }),
    'lib/keys.ts': `export const key = "${live}";\n`,
  });
  assert.ok(ids(stripeApp).includes('stripe-live-key'), 'with Stripe installed, a bare sk_live_ key stays Stripe');
});

test('Paddle, Convex, Appwrite and Lemon Squeezy keys in code are found', async () => {
  const report = await scan({
    'package.json': server({ express: '5', 'node-appwrite': '14' }),
    'server/paddle.ts': `export const live = "${fakeKey('pdl_' + 'live_apikey_', 40, 21)}";\n`,
    'server/paddle-test.ts': `export const sandbox = "${fakeKey('pdl_' + 'sdbx_apikey_', 40, 22)}";\n`,
    'server/deploy.ts': `export const k = "${'prod' + ':happy-otter-123|'}${fakeKey('', 48, 23)}";\n`,
    'server/appwrite.ts': `client.setEndpoint(url).setProject(id).setKey("${fakeHex(128, 24)}");\n`,
    'server/lemon.ts': `const LEMONSQUEEZY_API_KEY = "${fakeJwt({ aud: 'x', sub: '1', scopes: [] })}";\n`,
  });
  assert.equal(find(report, 'paddle-live-key')?.severity, 'critical');
  assert.equal(find(report, 'paddle-sandbox-key')?.severity, 'warning');
  assert.equal(find(report, 'convex-deploy-key')?.severity, 'critical');
  assert.equal(find(report, 'appwrite-api-key')?.severity, 'critical');
  assert.equal(find(report, 'lemonsqueezy-api-key')?.severity, 'critical');
});

test('provider secrets behind public variable prefixes are flagged, public tokens are not', async () => {
  const report = await scan({
    'package.json': server({ next: '16' }),
    'app/page.tsx':
      'const a = process.env.NEXT_PUBLIC_LEMONSQUEEZY_API_KEY;\nconst b = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;\nconst c = process.env.NEXT_PUBLIC_CONVEX_URL;\n',
  });
  const flagged = report.categories
    .flatMap((c) => c.findings)
    .filter((f) => f.id === 'public-secret-variable')
    .map((f) => f.title);
  assert.equal(flagged.length, 1, flagged.join(' | '));
  assert.match(flagged[0]!, /NEXT_PUBLIC_LEMONSQUEEZY_API_KEY/);
});

// ---------------- Lemon Squeezy and Paddle webhooks ----------------

const lemonRoute = (body: string) => ({
  'package.json': server({ next: '16', '@lemonsqueezy/lemonsqueezy.js': '4' }),
  'app/api/webhooks/lemon/route.ts': body,
});

test('a Lemon Squeezy webhook that never checks X-Signature is critical', async () => {
  const report = await scan(
    lemonRoute(
      `export async function POST(req: Request) {\n  const body = await req.json();\n  if (body.meta.event_name === "order_created") await grantAccess(body);\n  return new Response("ok");\n}\n`,
    ),
  );
  const f = find(report, 'lemonsqueezy-webhook-unverified');
  assert.equal(f?.severity, 'critical');
  assert.equal(f?.location?.file, 'app/api/webhooks/lemon/route.ts');
  assert.match(f!.fixPrompt, /X-Signature/);
});

test('a Lemon Squeezy webhook that checks the HMAC of the raw body passes', async () => {
  const report = await scan(
    lemonRoute(
      `import crypto from "node:crypto";\nexport async function POST(req: Request) {\n  const raw = await req.text();\n  const digest = crypto.createHmac("sha256", process.env.LEMONSQUEEZY_WEBHOOK_SECRET!).update(raw).digest("hex");\n  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(req.headers.get("x-signature") ?? ""))) return new Response("bad", { status: 401 });\n  const body = JSON.parse(raw);\n  if (body.meta.event_name === "order_created") await grantAccess(body);\n  return new Response("ok");\n}\n`,
    ),
  );
  assert.ok(!ids(report).some((id) => id.startsWith('lemonsqueezy-')), ids(report).join(', '));
  assert.ok(category(report, 'payments').passed.some((p) => /Lemon Squeezy webhooks check the signature/.test(p)));
});

test('signing JSON.stringify(body) instead of the raw body is a warning', async () => {
  const report = await scan(
    lemonRoute(
      `import crypto from "node:crypto";\nexport async function POST(req: Request) {\n  const body = await req.json();\n  const digest = crypto.createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");\n  if (digest !== req.headers.get("x-signature")) return new Response("bad", { status: 401 });\n  if (body.meta.event_name === "order_created") await grantAccess(body);\n  return new Response("ok");\n}\n`,
    ),
  );
  assert.equal(find(report, 'lemonsqueezy-webhook-parsed-body')?.severity, 'warning');
  assert.ok(!ids(report).includes('lemonsqueezy-webhook-unverified'));
});

test('Lemon Squeezy checkout with no webhook is a warning', async () => {
  const report = await scan({
    'package.json': server({ next: '16', '@lemonsqueezy/lemonsqueezy.js': '4' }),
    'app/api/checkout/route.ts':
      'import { createCheckout } from "@lemonsqueezy/lemonsqueezy.js";\nexport async function POST() { return Response.json(await createCheckout(store, variant)); }\n',
  });
  assert.equal(find(report, 'lemonsqueezy-no-webhook')?.severity, 'warning');
});

const paddleRoute = (body: string, extra: Record<string, string> = {}) => ({
  'package.json': server({ next: '16', '@paddle/paddle-node-sdk': '3' }),
  'app/api/paddle/route.ts': body,
  ...extra,
});

test('a Paddle webhook that never verifies Paddle-Signature is critical', async () => {
  const report = await scan(
    paddleRoute(
      `import { EventName } from "@paddle/paddle-node-sdk";\nexport async function POST(req: Request) {\n  const event = await req.json();\n  if (event.event_type === EventName.TransactionCompleted) await grantAccess(event);\n  return new Response("ok");\n}\n`,
    ),
  );
  assert.equal(find(report, 'paddle-webhook-unverified')?.severity, 'critical');
  assert.match(find(report, 'paddle-webhook-unverified')!.fixPrompt, /webhooks\.unmarshal/);
});

test('a Paddle webhook verified through a helper in lib/ passes', async () => {
  const report = await scan(
    paddleRoute(
      `import { verifyPaddleWebhook } from "@/lib/paddle";\nexport async function POST(req: Request) {\n  const event = await verifyPaddleWebhook(await req.text(), req.headers.get("paddle-signature") ?? "");\n  if (event.eventType === "transaction.completed") await grantAccess(event);\n  return new Response("ok");\n}\n`,
      {
        'lib/paddle.ts':
          'import { Paddle } from "@paddle/paddle-node-sdk";\nconst paddle = new Paddle(process.env.PADDLE_API_KEY!);\nexport async function verifyPaddleWebhook(raw: string, signature: string) {\n  return paddle.webhooks.unmarshal(raw, process.env.PADDLE_WEBHOOK_SECRET!, signature);\n}\n',
      },
    ),
  );
  assert.ok(!ids(report).some((id) => id.startsWith('paddle-')), ids(report).join(', '));
});

test('Paddle in the browser only, with no webhook, is a warning', async () => {
  const report = await scan({
    'package.json': server({ next: '16', '@paddle/paddle-js': '1' }),
    'app/pricing/page.tsx':
      '"use client";\nimport { initializePaddle } from "@paddle/paddle-js";\nexport default function Pricing() { return null; }\n',
  });
  assert.equal(find(report, 'paddle-no-webhook')?.severity, 'warning');
  assert.ok(!manualIds(report).includes('other-provider-webhooks'), 'Paddle gets real checks now, not the reminder');
});

// ---------------- Convex ----------------

const convexApp = (functions: string, deps: Record<string, string> = { '@clerk/clerk-react': '5' }) => ({
  'package.json': server({ react: '19', vite: '7', convex: '1', ...deps }),
  'convex/messages.ts': functions,
  'convex/_generated/server.d.ts': 'export declare const mutation: any;\n',
});

test('public Convex mutations that never check the caller are a warning', async () => {
  const report = await scan(
    convexApp(
      `import { mutation, internalMutation } from "./_generated/server";\nexport const send = mutation({\n  args: {},\n  handler: async (ctx, args) => { await ctx.db.insert("messages", args); },\n});\nexport const remove = mutation({\n  handler: async (ctx, { id }) => {\n    const identity = await ctx.auth.getUserIdentity();\n    if (!identity) throw new Error("Not signed in");\n    await ctx.db.delete(id);\n  },\n});\nexport const cleanup = internalMutation({ handler: async (ctx) => {} });\n`,
    ),
  );
  const f = find(report, 'convex-public-mutation');
  assert.equal(f?.severity, 'warning');
  assert.match(f!.title, /1 Convex function anyone can call without signing in: send$/);
  assert.equal(f?.location?.line, 2);
});

test('Convex functions in an app without accounts are not flagged', async () => {
  const report = await scan(
    convexApp(
      `import { mutation } from "./_generated/server";\nexport const sign = mutation({ handler: async (ctx, args) => { await ctx.db.insert("guestbook", args); } });\n`,
      {},
    ),
  );
  assert.ok(!ids(report).includes('convex-public-mutation'));
});

test('Convex mutations that all check the caller pass', async () => {
  const report = await scan(
    convexApp(
      `import { mutation } from "./_generated/server";\nimport { getAuthUserId } from "@convex-dev/auth/server";\nexport const send = mutation({ handler: async (ctx, args) => { const userId = await getAuthUserId(ctx); if (!userId) throw new Error("x"); } });\n`,
    ),
  );
  assert.ok(!ids(report).includes('convex-public-mutation'));
  assert.ok(category(report, 'database').passed.includes('Convex mutations check who is calling'));
});

// ---------------- Appwrite ----------------

test('Appwrite permissions for anyone are flagged by how open they are', async () => {
  const report = await scan({
    'package.json': server({ react: '19', vite: '7', appwrite: '16' }),
    'src/notes.ts':
      'await db.createDocument(DB, NOTES, ID.unique(), data, [\n  Permission.read(Role.any()),\n  Permission.update(Role.any()),\n  Permission.delete(Role.users()),\n]);\nawait db.createDocument(DB, CONTACT, ID.unique(), msg, [Permission.create(Role.guests())]);\n',
  });
  const open = report.categories.flatMap((c) => c.findings).filter((f) => f.id === 'appwrite-open-permission');
  assert.deepEqual(open.map((f) => f.severity).sort(), ['critical', 'warning']);
  assert.equal(find(report, 'appwrite-signed-in-write')?.severity, 'warning');
});

test('appwrite.json collection permissions are read too', async () => {
  const report = await scan({
    'package.json': server({ 'node-appwrite': '14' }),
    'appwrite.json': JSON.stringify({
      collections: [{ $id: 'orders', $permissions: ['read("users")', 'update("any")'] }],
    }),
  });
  assert.equal(find(report, 'appwrite-open-permission')?.severity, 'critical');
  assert.equal(find(report, 'appwrite-open-permission')?.location?.file, 'appwrite.json');
});

test('Appwrite with no permissions in the code gets a checklist item', async () => {
  const report = await scan({
    'package.json': server({ react: '19', vite: '7', appwrite: '16' }),
    'src/db.ts': 'export const db = new Databases(client);\n',
  });
  assert.ok(manualIds(report).includes('appwrite-permissions-console'));
  assert.match(category(report, 'database').manual.find((m) => m.id === 'backups')!.how, /Appwrite Console/);
});

// ---------------- Clerk ----------------

test('apps using Clerk are reminded to switch to a production instance', async () => {
  const report = await scan({
    'package.json': server({ next: '16', '@clerk/nextjs': '6' }),
    'app/layout.tsx': 'export default function Layout({ children }) { return children; }\n',
  });
  assert.ok(manualIds(report).includes('clerk-production-instance'));
});
