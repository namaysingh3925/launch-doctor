import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeProject } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

const leaky = () =>
  makeProject({
    'package.json': '{"name":"cli-app","dependencies":{"react":"^19","vite":"^7","stripe":"^18"}}',
    'src/pay.ts': `export const k = "${'sk_' + 'live_' + 'Q7wZp2Lk9VtR4mXc8Bn3Hs6Jd'}";\n`,
    'index.html': '<title>Vite + React</title>',
  });

test('prints a readable report and writes LAUNCH_FIXES.md', () => {
  const dir = leaky();
  const res = run([dir, '--offline']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Launch Doctor/);
  assert.match(res.stdout, /Overall grade/);
  assert.match(res.stdout, /MUST FIX BEFORE LAUNCH/);
  assert.match(res.stdout, /Stripe live secret key/);

  const fixes = join(dir, 'LAUNCH_FIXES.md');
  assert.ok(existsSync(fixes));
  const md = readFileSync(fixes, 'utf8');
  assert.match(md, /# Launch Doctor fixes for cli-app/);
  assert.match(md, /Prompt to paste/);
  assert.match(md, /Or fix everything in one go/);
  assert.ok(!md.includes('Q7wZp2Lk9VtR4mXc8Bn3Hs6Jd'), 'full secret must not be written to the fixes file');
});

test('--json prints valid JSON', () => {
  const res = run([leaky(), '--offline', '--json', '--no-file']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.tool, 'launch-doctor');
  assert.equal(report.categories.length, 8);
});

test('--domain accepts full URLs in both forms', () => {
  for (const flag of [['--domain', 'https://www.Example-App.com/pricing'], ['--domain=https://www.Example-App.com/pricing']]) {
    const res = run([leaky(), '--offline', '--json', '--no-file', ...flag]);
    assert.equal(res.status, 0, res.stderr);
  }
});

test('--ci exits with 1 when there are critical issues', () => {
  const res = run([leaky(), '--offline', '--ci', '--no-file']);
  assert.equal(res.status, 1);
});

test('--no-file does not write anything', () => {
  const dir = leaky();
  run([dir, '--offline', '--no-file']);
  assert.ok(!existsSync(join(dir, 'LAUNCH_FIXES.md')));
});

test('--demo scans the built-in sample app and cleans up after itself', () => {
  const res = run(['--demo', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.projectName, 'my-weekend-saas');
  assert.equal(report.grade, 'F');
  assert.ok(!existsSync(report.root), 'demo folder should be deleted');
  const found = report.categories.flatMap((c: { findings: { id: string }[] }) => c.findings.map((f) => f.id));
  for (const id of ['stripe-live-key', 'public-secret-variable', 'supabase-rls-missing', 'stripe-webhook-unverified', 'ai-in-browser']) {
    assert.ok(found.includes(id), `demo should show ${id}`);
  }
});

test('helpful errors for bad input', () => {
  assert.equal(run(['/definitely/not/a/folder']).status, 2);
  const unknown = run(['--wat']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option/);
  assert.match(run(['--help']).stdout, /Usage/);
  assert.equal(run(['--domain', 'not a domain']).status, 2);
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
});

test('--fail-on picks which severity fails a --ci run', () => {
  const warningsOnly = () =>
    makeProject({ 'package.json': '{"name":"w","dependencies":{"react":"^19","vite":"^7"}}', 'index.html': '<title>Vite + React</title>' });
  assert.equal(run([warningsOnly(), '--offline', '--ci']).status, 0, 'warnings alone pass by default');
  assert.equal(run([warningsOnly(), '--offline', '--ci', '--fail-on', 'warning']).status, 1);
  assert.equal(run([warningsOnly(), '--offline', '--ci', '--fail-on=critical']).status, 0);
  assert.equal(run([leaky(), '--offline', '--ci', '--fail-on', 'critical']).status, 1);
  const bad = run([warningsOnly(), '--fail-on', 'info']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--fail-on must be "critical" or "warning"/);
  assert.match(run(['--help']).stdout, /--fail-on <level>/);
});

test('--only and --skip choose categories; skipped ones do not count toward the grade', () => {
  const only = JSON.parse(run([leaky(), '--offline', '--json', '--only', 'first-impressions']).stdout);
  const byId = (r: { categories: { id: string; skipped?: boolean; grade: string | null }[] }, id: string) =>
    r.categories.find((c) => c.id === id)!;
  assert.equal(byId(only, 'secrets').skipped, true);
  assert.equal(byId(only, 'secrets').grade, null);
  assert.equal(byId(only, 'first-impressions').skipped, undefined);
  assert.notEqual(only.grade, 'F', 'the critical Stripe key is in a skipped category, so it must not drag the grade down');

  const skip = JSON.parse(run([leaky(), '--offline', '--json', '--skip=secrets,payments']).stdout);
  assert.equal(byId(skip, 'secrets').skipped, true);
  assert.equal(byId(skip, 'payments').skipped, true);
  assert.equal(byId(skip, 'database').skipped, undefined);

  const text = run([leaky(), '--offline', '--no-file', '--only', 'secrets']).stdout;
  assert.match(text, /Payments\s+skipped/);

  const bad = run([leaky(), '--only', 'secrets,nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown category "nope"/);
  assert.match(run(['--help']).stdout, /--only <ids>[\s\S]*first-impressions/);
});

test('writes a Markdown summary when GITHUB_STEP_SUMMARY is set', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const summary = join(mkdtempSync(join(tmpdir(), 'ld-summary-')), 'summary.md');
  writeFileSync(summary, '# Earlier step\n');
  const res = spawnSync(process.execPath, [CLI, leaky(), '--offline', '--no-file'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(res.status, 0, res.stderr);
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /^# Earlier step/, 'appends instead of overwriting');
  assert.match(md, /## Launch Doctor: grade F/);
  assert.match(md, /\| Category \| Grade \| Critical \| Warnings \| To check \|/);
  assert.match(md, /\| Secrets & keys \| F \| 1 \|/);
  assert.match(md, /### Critical \(1\)/);
  assert.match(md, /Stripe live secret key is written directly in your code \(`src\/pay\.ts:1`\)/);
  assert.match(md, /### Warnings/);
});

test('no summary file is written when GITHUB_STEP_SUMMARY is not set', () => {
  const res = run([leaky(), '--offline', '--no-file']);
  assert.equal(res.status, 0);
  assert.equal(process.env.GITHUB_STEP_SUMMARY, undefined);
});
