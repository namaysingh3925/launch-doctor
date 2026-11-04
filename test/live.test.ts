import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIVE_IDS, parseTarget, runLiveScan } from '../src/live.js';
import type { Report } from '../src/types.js';
import { fakeJwt, fakeKey } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

type Handler = (
  path: string,
) => { status?: number; type?: string; body: string; headers?: Record<string, string> } | undefined;

async function withSite<T>(handler: Handler, fn: (url: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    const r = handler(req.url ?? '/') ?? { status: 404, body: 'not found', type: 'text/plain' };
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html', ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const found = (r: Report) => r.categories.flatMap((c) => c.findings.map((f) => f.id));
const GOOD_HEADERS = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

test('parseTarget accepts bare domains and rejects other schemes', () => {
  assert.equal(parseTarget('myapp.com').href, 'https://myapp.com/');
  assert.equal(parseTarget('http://localhost:3000/x#y').href, 'http://localhost:3000/x');
  assert.throws(() => parseTarget('ftp://myapp.com'));
  assert.throws(() => parseTarget('not a url'));
});

test('a single-page app that answers 200 for every path is not flagged', async () => {
  await withSite(
    () => ({ body: '<html><body><div id="root"></div></body></html>', headers: GOOD_HEADERS }),
    async (url) => {
      const report = await runLiveScan(url);
      assert.deepEqual(found(report), []);
      assert.equal(report.mode, 'live');
    },
  );
});

test('finds exposed .env, .git, source maps and keys in the bundle', async () => {
  const stripe = fakeKey(`sk_${'live_'}`, 28);
  await withSite(
    (path) => {
      if (path === '/') return { body: '<html><script src="/app.js"></script></html>', headers: GOOD_HEADERS };
      if (path === '/app.js')
        return { type: 'text/javascript', body: `const k="${stripe}";\n//# sourceMappingURL=app.js.map` };
      if (path === '/app.js.map')
        return {
          type: 'application/json',
          body: JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['x'], mappings: '' }),
        };
      if (path === '/.env') return { type: 'text/plain', body: 'DATABASE_URL=postgres://u:p@h/db\nFOO=bar\n' };
      if (path === '/.git/HEAD') return { type: 'text/plain', body: 'ref: refs/heads/main\n' };
      return undefined;
    },
    async (url) => {
      const ids = found(await runLiveScan(url));
      for (const id of ['live-exposed-env', 'live-exposed-git', 'live-source-maps', 'live-secret-in-bundle']) {
        assert.ok(ids.includes(id), `missing ${id}: ${ids}`);
      }
      assert.ok(!ids.includes('live-exposed-backup'));
    },
  );
});

test('flags missing headers on a plain page', async () => {
  await withSite(
    () => ({ body: '<html></html>' }),
    async (url) => {
      const ids = found(await runLiveScan(url));
      assert.deepEqual(ids.sort(), ['live-missing-basic-headers', 'live-missing-csp']);
    },
  );
});

test('Supabase: reports tables that return rows to the anon key, never the rows', async () => {
  const anon = fakeJwt({ role: 'anon', iss: 'supabase' });
  const service = fakeJwt({ role: 'service_role', iss: 'supabase' });
  const project = 'abcdefghijklmnopqrst';
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const u = String(input);
    if (!u.includes('.supabase.co')) return fetch(input, init);
    calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u.endsWith('/rest/v1/')) return Response.json({ paths: { '/': {}, '/profiles': {}, '/posts': {} } });
    if (u.includes('/rest/v1/profiles')) return Response.json([{ email: 'private@example.com' }]);
    return Response.json([]);
  };
  await withSite(
    (path) => {
      if (path === '/') return { body: '<html><script src="/a.js"></script></html>', headers: GOOD_HEADERS };
      if (path === '/a.js')
        return {
          type: 'text/javascript',
          body: `createClient("https://${project}.supabase.co","${anon}");sb.from("tasks");const s="${service}"`,
        };
      return undefined;
    },
    async (url) => {
      const report = await runLiveScan(url, { fetch: fakeFetch });
      const ids = found(report);
      assert.ok(ids.includes('live-supabase-open-table'));
      assert.ok(ids.includes('live-supabase-service-role'));
      const open = report.categories.flatMap((c) => c.findings).find((f) => f.id === 'live-supabase-open-table');
      assert.match(open?.title ?? '', /profiles/);
      assert.doesNotMatch(JSON.stringify(report), /private@example\.com/);
      assert.ok(
        calls.some((c) => c.includes('/rest/v1/tasks')),
        'tables named in code are tested too',
      );
      assert.ok(calls.every((c) => c.startsWith('GET ')));

      const skipped = await runLiveScan(url, { fetch: fakeFetch, skipDatabase: true });
      assert.ok(!found(skipped).includes('live-supabase-open-table'));
    },
  );
});

test('an unreachable site is an error, not a grade', async () => {
  await assert.rejects(runLiveScan('http://127.0.0.1:1', { timeoutMs: 2000 }), /Couldn't reach/);
});

test('LIVE_IDS has no duplicates', () => {
  assert.equal(new Set(LIVE_IDS).size, LIVE_IDS.length);
});

test('scan command: --json and --ci exit code', async () => {
  await withSite(
    (path) => (path === '/.env' ? { type: 'text/plain', body: 'SECRET_THING=abc123\n' } : { body: '<html></html>' }),
    async (url) => {
      // The site runs in this process, so the CLI must be spawned asynchronously.
      const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((ok) => {
        const child = spawn(process.execPath, [CLI, 'scan', url, '--json', '--ci'], {
          env: { ...process.env, NO_COLOR: '1' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('close', (status) => ok({ status, stdout, stderr }));
      });
      assert.equal(res.status, 1, res.stderr);
      const report = JSON.parse(res.stdout) as Report;
      assert.equal(report.mode, 'live');
      assert.ok(found(report).includes('live-exposed-env'));
    },
  );
});
