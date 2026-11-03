import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import { matcherCovers, urlPathOf } from '../src/routes.js';
import { ids, makeProject } from './helpers.js';

const opts = { offline: true, useGit: false };
const pkg = (extra: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: { next: '14', react: '18', openai: '4', ...extra } });

const AI_HELPER =
  "import OpenAI from 'openai';\nconst o = new OpenAI();\nexport const gen = (p: string) =>\n  o.chat.completions.create({ model: 'x', messages: [{ role: 'user', content: p }] });\n";

async function run(files: Record<string, string>) {
  return ids(await runDoctor(makeProject(files), opts));
}

test('A: a route that reaches the AI call through a helper is checked', async () => {
  const found = await run({
    'package.json': pkg(),
    'src/lib/ai.ts': AI_HELPER,
    'src/app/api/chat/route.ts':
      "import { gen } from '@/lib/ai';\nexport async function POST(r: Request) {\n  const b = await r.json();\n  return Response.json(await gen(b.p));\n}\n",
  });
  assert.ok(found.includes('ai-endpoint-no-auth'));
});

test('A (negative): the same route is fine when it rejects signed-out callers', async () => {
  const found = await run({
    'package.json': pkg(),
    'src/lib/ai.ts': AI_HELPER,
    'src/app/api/chat/route.ts':
      "import { gen } from '@/lib/ai';\nimport { auth } from '@/auth';\nexport async function POST(r: Request) {\n  const s = await auth();\n  if (!s) return new Response('no', { status: 401 });\n  return Response.json(await gen('x'));\n}\n",
  });
  assert.ok(!found.includes('ai-endpoint-no-auth'));
});

test('B: a rate limiter on another route does not cover the AI route', async () => {
  const found = await run({
    'package.json': pkg({ '@upstash/ratelimit': '1' }),
    'src/app/api/login/route.ts':
      "import { Ratelimit } from '@upstash/ratelimit';\nconst l = new Ratelimit({});\nexport async function POST() {\n  await l.limit('x');\n  return Response.json({});\n}\n",
    'src/app/api/chat/route.ts':
      "import OpenAI from 'openai';\nimport { auth } from '@/auth';\nconst o = new OpenAI();\nexport async function POST() {\n  const s = await auth();\n  if (!s) return new Response('no', { status: 401 });\n  return Response.json(await o.chat.completions.create({ model: 'x', messages: [] }));\n}\n",
  });
  assert.ok(found.includes('no-rate-limit'));
});

test('B (negative): a limiter reached through an imported helper counts', async () => {
  const found = await run({
    'package.json': pkg({ '@upstash/ratelimit': '1' }),
    'src/lib/limit.ts': "import { Ratelimit } from '@upstash/ratelimit';\nexport const limiter = new Ratelimit({});\n",
    'src/app/api/chat/route.ts':
      "import OpenAI from 'openai';\nimport { auth } from '@/auth';\nimport { limiter } from '@/lib/limit';\nconst o = new OpenAI();\nexport async function POST() {\n  const s = await auth();\n  if (!s) return new Response('no', { status: 401 });\n  await limiter.limit(s.user.id);\n  return Response.json(await o.chat.completions.create({ model: 'x', messages: [] }));\n}\n",
  });
  assert.ok(!found.includes('no-rate-limit'));
});

test('C: auth in GET does not protect the paid POST in the same file', async () => {
  const found = await run({
    'package.json': pkg(),
    'src/app/api/chat/route.ts':
      "import OpenAI from 'openai';\nimport { auth } from '@/auth';\nconst o = new OpenAI();\nexport async function GET() {\n  const s = await auth();\n  if (!s) return new Response('no', { status: 401 });\n  return Response.json(s);\n}\nexport async function POST() {\n  return Response.json(await o.chat.completions.create({ model: 'x', messages: [] }));\n}\n",
  });
  assert.ok(found.includes('ai-endpoint-no-auth'));
});

test('calling auth() without acting on the result is not protection', async () => {
  const found = await run({
    'package.json': pkg(),
    'src/app/api/chat/route.ts':
      "import OpenAI from 'openai';\nimport { auth } from '@/auth';\nconst o = new OpenAI();\nexport async function POST() {\n  const s = await auth();\n  return Response.json(await o.chat.completions.create({ model: 'x', messages: [] }));\n}\n",
  });
  assert.ok(found.includes('ai-endpoint-no-auth'));
});

test('a circular import between helpers does not loop', async () => {
  const found = await run({
    'package.json': pkg(),
    'src/lib/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
    'src/lib/b.ts': "import { a } from './a';\nexport const b = () => a();\n",
    'src/app/api/x/route.ts':
      "import { a } from '@/lib/a';\nexport async function POST() {\n  return Response.json(a());\n}\n",
  });
  assert.ok(!found.includes('ai-endpoint-no-auth'));
});

test('urlPathOf and matcherCovers', () => {
  assert.equal(urlPathOf('src/app/api/chat/route.ts'), '/api/chat');
  assert.equal(urlPathOf('app/(site)/api/users/[id]/route.ts'), '/api/users/:id');
  assert.equal(urlPathOf('pages/api/chat.ts'), '/api/chat');
  assert.equal(urlPathOf('src/lib/ai.ts'), null);
  assert.equal(matcherCovers(['/api/:path*'], '/api/chat'), true);
  assert.equal(matcherCovers(['/dashboard/:path*'], '/api/chat'), false);
  assert.equal(matcherCovers(null, '/api/chat'), true);
});
