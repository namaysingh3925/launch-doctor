import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripComments } from '../src/comments.js';
import { runDoctor } from '../src/index.js';
import { category, ids, makeProject } from './helpers.js';

const opts = { offline: true, useGit: false };

test('comments become spaces; length and newlines are unchanged', () => {
  const src = 'const a = 1; // note\n/* block\n   comment */ const b = 2;\n';
  const out = stripComments(src, 'x.ts');
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes('note'));
  assert.ok(!out.includes('block'));
  assert.ok(out.includes('const b = 2;'));
  assert.equal(out.indexOf('const b'), src.indexOf('const b'));
});

test('// inside strings, template literals and URLs is not a comment', () => {
  const src = [
    "const a = 'see // not a comment';",
    'const b = "http://example.com/x";',
    'const c = `line one // still text',
    'line two`;',
    '<a>Visit https://example.com today</a>',
    "const d = 'it\\'s // fine';",
  ].join('\n');
  assert.equal(stripComments(src, 'x.tsx'), src);
});

test('hash, HTML and SQL comments are stripped for their file types', () => {
  assert.equal(stripComments('x = "#not"  # gone\n', 'a.py'), 'x = "#not"        \n');
  assert.equal(stripComments('<p>hi</p><!-- gone -->', 'a.html'), '<p>hi</p>             ');
  assert.equal(stripComments("select '--x' -- gone\n", 'a.sql'), "select '--x'        \n");
  // Vue/Svelte: both HTML comments in the template and JS comments in the script.
  assert.equal(stripComments('<!-- a --><script>// b\n</script>', 'C.vue'), '          <script>    \n</script>');
});

test('commented-out code does not count as protection', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': JSON.stringify({ dependencies: { next: '16', react: '19', stripe: '18', openai: '5' } }),
      'app/page.tsx': 'export default function Home() { return null; }\n',
      'app/layout.tsx':
        '// TODO: wrap in <ErrorBoundary>\nexport default function L({ children }) { return children; }\n',
      'app/api/webhook/route.ts':
        "import Stripe from 'stripe';\nexport async function POST(req: Request) {\n  const body = await req.text();\n  // const event = stripe.webhooks.constructEvent(body, sig, secret);\n  const event = JSON.parse(body);\n  if (event.type === 'checkout.session.completed') {}\n  return new Response('ok');\n}\n",
      'app/api/chat/route.ts':
        "import OpenAI from 'openai';\nconst openai = new OpenAI();\n/* const session = await getServerSession(); */\n// const rl = new Ratelimit({ limiter: Ratelimit.slidingWindow(10, '1 m') });\nexport async function POST() {\n  return Response.json(await openai.chat.completions.create({ model: 'gpt-5', messages: [] }));\n}\n",
    }),
    opts,
  );
  const found = ids(report);
  for (const id of ['stripe-webhook-unverified', 'ai-endpoint-no-auth', 'no-rate-limit']) {
    assert.ok(found.includes(id), `${id} should be reported: ${found.join(', ')}`);
  }
});

test('real code next to a URL string is still found', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': JSON.stringify({ dependencies: { next: '16', openai: '5' } }),
      'app/api/chat/route.ts':
        "import OpenAI from 'openai';\nconst docs = 'https://upstash.com/docs'; const rl = new Ratelimit({});\nexport const x = new OpenAI();\n",
    }),
    opts,
  );
  assert.ok(!ids(report).includes('no-rate-limit'), ids(report).join(', '));
  assert.ok(category(report, 'costs').passed.some((p) => /Rate limiting/.test(p)));
});

test('secret scanning still looks inside comments', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': '{}',
      'server/a.ts': `// old key: ${'sk_' + 'live_' + 'Q7wZp2Lk9VtR4mXc8Bn3Hs6Jd'}\n`,
    }),
    opts,
  );
  assert.ok(ids(report).includes('stripe-live-key'));
});
