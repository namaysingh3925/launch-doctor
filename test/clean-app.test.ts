import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import { category, ids, makeProject, manualIds } from './helpers.js';

// A Next.js app that did its homework.
const files: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'acme-notes',
    dependencies: {
      next: '^16.0.0',
      react: '^19.0.0',
      stripe: '^18.0.0',
      '@sentry/nextjs': '^10.0.0',
      '@supabase/supabase-js': '^2.0.0',
      '@supabase/ssr': '^0.6.0',
      openai: '^5.0.0',
      '@upstash/ratelimit': '^2.0.0',
      resend: '^4.0.0',
    },
    scripts: { build: 'next build', 'db:migrate': 'supabase db push' },
  }),
  '.gitignore': '.env*\n!.env.example\nnode_modules\n.next\n',
  '.env.example': 'STRIPE_SECRET_KEY=\nOPENAI_API_KEY=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n',
  'app/layout.tsx':
    "export const metadata = { title: 'Acme Notes', description: 'Notes that organise themselves for busy teams.', openGraph: { images: ['/og.png'] } };\nexport default function RootLayout({ children }: any) { return <html><body>{children}<footer><a href=\"/privacy\">Privacy</a></footer></body></html>; }\n",
  'app/page.tsx': 'export default function Home() { return <main>Hi</main>; }\n',
  'app/error.tsx': "'use client';\nexport default function Error({ reset }: any) { return <button onClick={reset}>Try again</button>; }\n",
  'app/not-found.tsx': 'export default function NotFound() { return <p>Not found</p>; }\n',
  'app/privacy/page.tsx': 'export default function Privacy() { return <p>Privacy policy</p>; }\n',
  'app/terms/page.tsx': 'export default function Terms() { return <p>Terms</p>; }\n',
  'app/refund/page.tsx': 'export default function Refund() { return <p>Refunds</p>; }\n',
  'app/contact/page.tsx': 'export default function Contact() { return <a href="mailto:hi@acme-notes.app">Email us</a>; }\n',
  'app/robots.ts': 'export default function robots() { return { rules: { userAgent: "*" }, sitemap: "/sitemap.xml" }; }\n',
  'app/sitemap.ts': 'export default function sitemap() { return []; }\n',
  'app/login/page.tsx':
    "'use client';\nimport { createBrowserClient } from '@supabase/ssr';\nconst supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);\nexport default function Login() { return <button onClick={() => supabase.auth.signInWithPassword({ email: '', password: '' })}>Log in</button>; }\n",
  'app/settings/page.tsx': "export default function Settings() { return <form action=\"/api/delete-account\"><button>Delete account</button></form>; }\n",
  'app/api/webhook/route.ts':
    "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nexport async function POST(req: Request) {\n  const body = await req.text();\n  const event = stripe.webhooks.constructEvent(body, req.headers.get('stripe-signature')!, process.env.STRIPE_WEBHOOK_SECRET!);\n  if (event.type === 'checkout.session.completed') {}\n  return new Response('ok');\n}\n",
  'app/api/chat/route.ts':
    "import OpenAI from 'openai';\nimport { Ratelimit } from '@upstash/ratelimit';\nimport { createServerClient } from '@supabase/ssr';\nconst openai = new OpenAI();\nexport async function POST(req: Request) {\n  const supabase = createServerClient('', '', { cookies: {} as any });\n  const { data: { user } } = await supabase.auth.getUser();\n  if (!user) return new Response('no', { status: 401 });\n  const r = await openai.chat.completions.create({ model: 'gpt-5', messages: [], max_tokens: 500 });\n  return Response.json(r);\n}\n",
  'lib/email.ts':
    "import { Resend } from 'resend';\nconst resend = new Resend(process.env.RESEND_API_KEY);\nexport const send = (to: string) => resend.emails.send({ from: 'Acme <hello@acme-notes.app>', to, subject: 'Welcome', html: '' });\n",
  'supabase/migrations/001_init.sql':
    'create table notes (id uuid primary key, user_id uuid, body text);\nalter table notes enable row level security;\ncreate policy "own notes" on notes for all using (auth.uid() = user_id);\n',
};

test('a well-prepared app has no critical issues and no warnings', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  assert.deepEqual(ids(report), [], `unexpected findings: ${ids(report).join(', ')}`);
  assert.equal(report.counts.critical, 0);
  assert.equal(report.grade, 'A');
  assert.match(report.verdict, /ready to launch/);
});

test('passed checks are reported so people see what they got right', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  const passed = report.categories.flatMap((c) => c.passed).join('\n');
  assert.match(passed, /Stripe webhooks check the signature/);
  assert.match(passed, /Row Level Security is on for all 1 table/);
  assert.match(passed, /Error tracking is set up \(Sentry\)/);
  assert.match(passed, /Rate limiting is in place/);
  assert.match(passed, /AI endpoints check who is calling/);
});

test('things we cannot verify end up on the checklist', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  const manual = manualIds(report);
  for (const id of ['backups', 'live-test-purchase', 'spending-limits', 'email-dns', 'supabase-smtp', 'uptime-monitor']) {
    assert.ok(manual.includes(id), `expected checklist item ${id}`);
  }
});

test('the stack is detected for the report header', async () => {
  const report = await runDoctor(makeProject(files), { offline: true, useGit: false });
  assert.equal(report.projectName, 'acme-notes');
  assert.ok(report.stack.includes('Next.js'));
  assert.ok(report.stack.includes('Supabase'));
  assert.ok(report.stack.includes('Stripe'));
});

test('categories that do not apply are skipped, not failed', async () => {
  const report = await runDoctor(
    makeProject({ 'package.json': '{"name":"tiny","dependencies":{"react":"^19"}}', 'src/App.jsx': 'export default () => <h1>Hi</h1>;\n' }),
    { offline: true, useGit: false },
  );
  for (const id of ['payments', 'database', 'costs', 'email']) {
    const c = category(report, id);
    assert.equal(c.applicable, false, `${id} should not apply`);
    assert.equal(c.grade, null);
  }
});
