import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import { category, fakeJwt, fakeKey, ids, makeProject } from './helpers.js';

// A typical "first weekend" Vite + Supabase app with every classic mistake.
const stripeLive = fakeKey('sk_' + 'live_', 28);
const openaiKey = fakeKey('sk-' + 'proj-', 40, 3);
const serviceRole = fakeJwt({ iss: 'supabase', role: 'service_role', iat: 1700000000 });

const files: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'leaky-app',
    dependencies: {
      react: '^19.0.0',
      vite: '^7.0.0',
      '@supabase/supabase-js': '^2.0.0',
      stripe: '^18.0.0',
      openai: '^5.0.0',
      resend: '^4.0.0',
      firebase: '^11.0.0',
    },
  }),
  '.env': `VITE_SUPABASE_URL=https://abc.supabase.co\nVITE_OPENAI_API_KEY=${openaiKey}\n`,
  '.gitignore': 'node_modules\ndist\n*.local\n',
  'index.html':
    '<!doctype html><html><head><link rel="icon" href="/vite.svg" /><title>Vite + React + TS</title></head><body><div id="root"></div></body></html>',
  'src/lib/pay.ts': `export const stripeKey = "${stripeLive}";\n`,
  'src/lib/supabase.ts': `import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient("https://abc.supabase.co", "${serviceRole}");\n`,
  'src/ai.ts': `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_API_KEY, dangerouslyAllowBrowser: true });\nexport const ask = (q: string) => client.chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: q }] });\n`,
  'src/Signup.tsx': `import { supabase } from './lib/supabase';\nexport function Signup() { return <button onClick={() => supabase.auth.signUp({ email: 'a', password: 'b' })}>Sign up</button>; }\n`,
  'src/api.ts': `export const load = () => fetch('http://localhost:3000/api/items');\n`,
  'api/webhook.ts': `export default async function handler(req: any) {\n  const event = req.body;\n  if (event.type === 'checkout.session.completed') { /* unlock */ }\n}\n`,
  'api/email.ts': `import { Resend } from 'resend';\nconst resend = new Resend(process.env.RESEND_API_KEY);\nexport const send = () => resend.emails.send({ from: 'onboarding@resend.dev', to: 'x@y.com', subject: 'hi', html: '' });\n`,
  'supabase/migrations/001_init.sql':
    'create table public.profiles (id uuid primary key, name text);\ncreate table todos (id serial primary key);\nalter table todos enable row level security;\ncreate policy "anyone can do anything" on todos for all using (true);\n',
  'firestore.rules':
    "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if request.time < timestamp.date(2026, 12, 1);\n    }\n  }\n}\n",
};

test('finds the classic launch mistakes in a leaky app', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  const found = ids(report);

  for (const expected of [
    'stripe-live-key',
    'supabase-service-role-key',
    'public-secret-variable',
    'env-not-ignored',
    'stripe-webhook-unverified',
    'supabase-rls-missing',
    'supabase-open-policy',
    'firebase-open-rules',
    'ai-in-browser',
    'no-rate-limit',
    'no-error-tracking',
    'no-error-boundary',
    'email-test-sender',
    'no-privacy-policy',
    'no-account-deletion',
    'default-title',
    'default-favicon',
    'hardcoded-localhost',
  ]) {
    assert.ok(found.includes(expected), `expected finding "${expected}", got: ${found.join(', ')}`);
  }

  assert.equal(report.grade, 'F');
  assert.ok(report.counts.critical >= 6, `expected many critical issues, got ${report.counts.critical}`);
  assert.match(report.verdict, /Not ready to launch/);
});

test('reports the exact table without RLS, not the one that has it', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  const rls = category(report, 'database').findings.find((f) => f.id === 'supabase-rls-missing')!;
  assert.match(rls.title, /profiles/);
  assert.doesNotMatch(rls.title, /todos/);
  assert.equal(rls.location?.file, 'supabase/migrations/001_init.sql');
  assert.equal(rls.location?.line, 1);
});

test('never prints a full secret in the report', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  const text = JSON.stringify(report);
  assert.ok(!text.includes(stripeLive), 'Stripe key leaked into the report');
  assert.ok(!text.includes(openaiKey), 'OpenAI key leaked into the report');
  assert.ok(!text.includes(serviceRole), 'service_role key leaked into the report');
});

test('a frontend secret is critical even when the key type is normally a warning', async () => {
  const testKey = fakeKey('sk_' + 'test_', 28, 11);
  const report = await runDoctor(
    makeProject({
      'package.json': JSON.stringify({ dependencies: { vite: '^7', react: '^19' } }),
      'src/checkout.ts': `const key = "${testKey}";\n`,
      'server/pay.ts': `const key = "${fakeKey('sk_' + 'test_', 28, 12)}";\n`,
    }),
    { offline: true, useGit: false },
  );
  const keys = category(report, 'secrets').findings.filter((f) => f.id === 'stripe-test-key');
  assert.equal(keys.find((f) => f.location?.file === 'src/checkout.ts')?.severity, 'critical');
  assert.equal(keys.find((f) => f.location?.file === 'server/pay.ts')?.severity, 'warning');
});

test('placeholder keys in .env.example are not reported', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': '{"name":"x"}',
      '.env.example': `STRIPE_SECRET_KEY=${'sk_' + 'live_' + 'x'.repeat(24)}\nOPENAI_API_KEY=sk-your-key-here-your-key-here-1234\n`,
      'index.js': 'console.log("hi")\n',
    }),
    { offline: true, useGit: false },
  );
  assert.deepEqual(category(report, 'secrets').findings, []);
});
