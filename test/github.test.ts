import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addedLines,
  changedFiles,
  explainGitHubError,
  GitHubError,
  MAX_INLINE,
  type PrContext,
  placeFindings,
  postPrFeedback,
  prContextFromEnv,
  renderInlineComment,
  renderPrComment,
  SUMMARY_MARKER,
} from '../src/github.js';
import { runDoctor } from '../src/index.js';
import type { Finding, Report } from '../src/types.js';
import { fakeKey, makeProject } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** A small app with a live Stripe key on line 2 of src/pay.ts. */
async function leakyReport(): Promise<{ dir: string; report: Report }> {
  const dir = makeProject({
    'package.json': '{"name":"pr-app","dependencies":{"react":"^19","vite":"^7","stripe":"^18"}}',
    'src/pay.ts': `// payments\nexport const k = "${fakeKey('sk_' + 'live_', 24)}";\n`,
    'index.html': '<title>Vite + React</title>',
  });
  return { dir, report: await runDoctor(dir, { offline: true, useGit: false }) };
}

const ctx = (over: Partial<PrContext> = {}): PrContext => ({
  apiUrl: 'https://api.github.test',
  serverUrl: 'https://github.test',
  repo: 'octo/app',
  number: 7,
  headSha: 'abcdef1234567890',
  token: 'test-token',
  prefix: '',
  ...over,
});

const keyFinding = (r: Report): Finding => {
  const f = r.categories.flatMap((c) => c.findings).find((x) => x.location?.file === 'src/pay.ts');
  assert.ok(f, 'expected a finding in src/pay.ts');
  return f;
};

test('addedLines reads the new-file line numbers of added rows', () => {
  const patch = [
    '@@ -1,3 +1,4 @@',
    ' unchanged',
    '-removed',
    '+added two',
    '+added three',
    ' context four',
    '@@ -20,2 +21,2 @@ function x() {',
    '-old',
    '+new twenty-one',
    '\\ No newline at end of file',
  ].join('\n');
  assert.deepEqual([...addedLines(patch)], [2, 3, 21]);
});

test('changedFiles skips removed files and treats a new file with no patch as all added', () => {
  const m = changedFiles([
    { filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'big.ts', status: 'added' },
    { filename: 'gone.ts', status: 'removed' },
    { filename: 'renamed.ts', status: 'renamed' },
  ]);
  assert.deepEqual([...(m.get('a.ts') as Set<number>)], [1]);
  assert.equal(m.get('big.ts'), 'all');
  assert.equal(m.has('gone.ts'), false);
  assert.equal((m.get('renamed.ts') as Set<number>).size, 0);
});

test('placeFindings puts findings on added lines in the pull request, and the rest elsewhere', async () => {
  const { report } = await leakyReport();
  const key = keyFinding(report);

  const onLine = placeFindings(report, new Map([['src/pay.ts', new Set([key.location!.line!])]]), '');
  assert.deepEqual(
    onLine.inPr.map((i) => [i.path, i.line]),
    [['src/pay.ts', key.location!.line]],
  );
  assert.equal(onLine.inPr[0]!.key, key.fingerprint);
  assert.ok(!onLine.elsewhere.includes(key));

  const otherLine = placeFindings(report, new Map([['src/pay.ts', new Set([99])]]), '');
  assert.equal(otherLine.inPr.length, 0);
  assert.ok(otherLine.elsewhere.includes(key));

  // Scanned from ./web: the pull request's paths start with web/.
  const nested = placeFindings(report, new Map([['web/src/pay.ts', 'all']]), 'web');
  assert.equal(nested.inPr[0]?.path, 'web/src/pay.ts');

  key.baseline = true;
  const withBaseline = placeFindings(report, new Map([['src/pay.ts', 'all']]), '');
  assert.equal(withBaseline.baseline, 1);
  assert.ok(!withBaseline.elsewhere.includes(key));
  assert.equal(withBaseline.inPr.length, 0);
});

test('inline comments carry a marker, the fix prompt in a safe fence, and the ignore hint', async () => {
  const { report } = await leakyReport();
  const f = { ...keyFinding(report), fixPrompt: 'Use ```this``` carefully' };
  const body = renderInlineComment({ finding: f, path: 'src/pay.ts', line: 2, key: 'abc123' });
  assert.match(body, /^<!-- launch-doctor:finding abc123 -->/);
  assert.match(body, /\[CRITICAL\]/);
  assert.match(body, /````text\nUse ```this``` carefully\n````/);
  assert.match(body, new RegExp(`launch-doctor-ignore ${f.id}`));
});

test('the summary comment links findings to the pull request commit', async () => {
  const { report } = await leakyReport();
  const placement = placeFindings(report, new Map([['src/pay.ts', 'all']]), '');
  const body = renderPrComment(report, placement, ctx());
  assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.match(body, new RegExp(`grade ${report.grade}`));
  assert.match(body, /on lines this pull request adds/);
  assert.match(body, /https:\/\/github\.test\/octo\/app\/blob\/abcdef1234567890\/src\/pay\.ts#L2/);
  assert.match(body, /\| Category \| Grade \|/);
  assert.match(body, /Updated for abcdef1/);

  const clean = renderPrComment(report, placeFindings(report, new Map(), ''), ctx());
  assert.match(clean, /No problems in the lines this pull request adds/);
  assert.match(clean, /Already in the project: \d+ critical/);
});

test('prContextFromEnv explains why it skips, and finds the pull request when there is one', () => {
  const dir = makeProject({ 'web/index.html': '' });
  assert.match(prContextFromEnv(dir, {}) as string, /not running on GitHub Actions/);
  assert.match(
    prContextFromEnv(dir, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }) as string,
    /started by "push"/,
  );
  assert.match(
    prContextFromEnv(dir, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }) as string,
    /GITHUB_TOKEN is not set/,
  );

  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 12, head: { sha: 'f00' } } }));
  const found = prContextFromEnv(join(dir, 'web'), {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'octo/app',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: dir,
  });
  assert.equal(typeof found, 'object');
  const c = found as PrContext;
  assert.equal(c.number, 12);
  assert.equal(c.headSha, 'f00');
  assert.equal(c.prefix, 'web');
  assert.equal(c.apiUrl, 'https://api.github.com');
});

interface Call {
  method: string;
  path: string;
  body?: { body?: string; comments?: { path: string; line: number; body: string }[] };
}

/** A pretend GitHub API: a pull request that adds the line with the key. */
function fakeGitHub(state: {
  reviewComments?: { body: string }[];
  issueComments?: { id: number; body: string }[];
  reviewStatus?: number;
  files?: unknown[];
}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-token');
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/pulls/7/files'))
      return json(
        state.files ?? [{ filename: 'src/pay.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n // payments\n+export' }],
      );
    if (u.pathname.endsWith('/pulls/7/comments')) return json(state.reviewComments ?? []);
    if (u.pathname.endsWith('/issues/7/comments') && method === 'GET') return json(state.issueComments ?? []);
    if (u.pathname.endsWith('/pulls/7/reviews'))
      return state.reviewStatus ? json({ message: 'Unprocessable' }, state.reviewStatus) : json({ id: 1 });
    if (method === 'POST' || method === 'PATCH') return json({ html_url: 'https://github.test/octo/app/pull/7#c' });
    return json({ message: 'Not Found' }, 404);
  };
  return { calls, fetchImpl };
}

test('first run posts an inline review and creates the summary comment', async () => {
  const { report } = await leakyReport();
  const gh = fakeGitHub({});
  const r = await postPrFeedback(report, ctx(), gh.fetchImpl);
  assert.equal(r.posted, 1);
  assert.equal(r.summary, 'created');

  const review = gh.calls.find((c) => c.path.endsWith('/reviews'));
  assert.equal(review?.method, 'POST');
  assert.deepEqual(
    review?.body?.comments?.map((c) => [c.path, c.line]),
    [['src/pay.ts', 2]],
  );
  const summary = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/7/comments'));
  assert.ok(summary?.body?.body?.startsWith(SUMMARY_MARKER));
});

test('later runs edit the summary and do not repeat inline comments', async () => {
  const { report } = await leakyReport();
  const key = keyFinding(report).fingerprint!;
  const gh = fakeGitHub({
    reviewComments: [{ body: `<!-- launch-doctor:finding ${key} -->\nold` }],
    issueComments: [
      { id: 1, body: 'LGTM' },
      { id: 55, body: `${SUMMARY_MARKER}\n## Launch Doctor: grade F` },
    ],
  });
  const r = await postPrFeedback(report, ctx(), gh.fetchImpl);
  assert.equal(r.posted, 0);
  assert.equal(r.alreadyPosted, 1);
  assert.equal(r.summary, 'updated');
  assert.ok(!gh.calls.some((c) => c.path.endsWith('/reviews')));
  assert.ok(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/comments/55')));
});

test('a rejected review still leaves the summary comment', async () => {
  const { report } = await leakyReport();
  const gh = fakeGitHub({ reviewStatus: 422 });
  const r = await postPrFeedback(report, ctx(), gh.fetchImpl);
  assert.equal(r.posted, 0);
  assert.match(r.inlineError ?? '', /422/);
  assert.equal(r.summary, 'created');
});

test(`no more than ${MAX_INLINE} inline comments per run`, async () => {
  const { report } = await leakyReport();
  const key = keyFinding(report);
  // The secrets check stops at 10 keys, so copy one finding into many files.
  const copies = Array.from({ length: MAX_INLINE + 5 }, (_, i) => ({
    ...key,
    location: { file: `src/k${i}.ts`, line: 1 },
    fingerprint: `fp-${i}`,
  }));
  report.categories[0]!.findings.push(...copies);
  const files = copies.map((c) => ({ filename: c.location.file, status: 'added' }));
  const gh = fakeGitHub({ files });
  const r = await postPrFeedback(report, ctx(), gh.fetchImpl);
  assert.equal(r.posted, MAX_INLINE);
  assert.equal(r.overLimit, 5);
  const review = gh.calls.find((c) => c.path.endsWith('/reviews'));
  assert.equal(review?.body?.comments?.length, MAX_INLINE);
});

test('permission errors are explained in plain words', () => {
  assert.match(explainGitHubError(new GitHubError(403, 'POST x returned 403')), /pull-requests: write/);
  assert.match(explainGitHubError(new Error('socket hang up')), /socket hang up/);
});

test('the CLI skips --pr-comment outside a pull request and writes step outputs', async () => {
  const { dir } = await leakyReport();
  const outputs = join(dir, 'outputs.txt');
  writeFileSync(outputs, '');
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', GITHUB_OUTPUT: outputs };
  delete env.GITHUB_ACTIONS;
  const res = spawnSync(process.execPath, [CLI, dir, '--offline', '--no-file', '--pr-comment'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /--pr-comment: skipped, not running on GitHub Actions/);
  const written = readFileSync(outputs, 'utf8');
  assert.match(written, /^grade=[A-F]$/m);
  assert.match(written, /^critical=\d+$/m);
  assert.match(written, /^warnings=\d+$/m);
});
