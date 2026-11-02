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
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
});
