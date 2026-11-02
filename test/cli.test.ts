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

test('--sarif writes SARIF 2.1.0 with one rule per finding id and one result per finding', () => {
  const dir = leaky();
  const sarifPath = join(dir, 'out.sarif');
  const res = run([dir, '--offline', '--no-file', '--sarif', sarifPath]);
  assert.equal(res.status, 0, res.stderr);
  const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  const runEntry = sarif.runs[0];
  assert.equal(runEntry.tool.driver.name, 'Launch Doctor');
  const ruleIds = runEntry.tool.driver.rules.map((r: { id: string }) => r.id);
  assert.equal(new Set(ruleIds).size, ruleIds.length, 'rule ids are unique');

  const report = JSON.parse(run([dir, '--offline', '--json']).stdout);
  const findings = report.categories.flatMap((c: { findings: unknown[] }) => c.findings);
  assert.equal(runEntry.results.length, findings.length);

  const key = runEntry.results.find((r: { ruleId: string }) => r.ruleId === 'stripe-live-key');
  assert.equal(key.level, 'error');
  assert.equal(key.locations[0].physicalLocation.artifactLocation.uri, 'src/pay.ts');
  assert.equal(key.locations[0].physicalLocation.region.startLine, 1);
  assert.equal(runEntry.tool.driver.rules[key.ruleIndex].id, 'stripe-live-key');
  const rule = runEntry.tool.driver.rules[key.ruleIndex];
  assert.match(rule.shortDescription.text, /Stripe live secret key/);
  assert.match(rule.help.text, /Prompt to paste/);
  assert.ok(runEntry.results.some((r: { level: string }) => r.level === 'warning'));
  for (const r of runEntry.results) assert.ok(r.locations[0].physicalLocation.artifactLocation.uri, 'every result has a location');
  assert.match(run(['--help']).stdout, /--sarif <file>/);
});

test('--update-baseline records findings; later runs only fail on new ones', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = leaky();
  const update = run([dir, '--offline', '--no-file', '--update-baseline']);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Saved \d+ findings to \.launchdoctor-baseline\.json/);
  const saved = JSON.parse(readFileSync(join(dir, '.launchdoctor-baseline.json'), 'utf8'));
  assert.ok(saved.findings.length > 0);
  assert.ok(saved.findings.every((f: { fingerprint: string }) => /^[a-z0-9-]+\|[^|]*\|[0-9a-f]{16}$/.test(f.fingerprint)));

  // Same problems: CI passes, findings are marked and collapsed.
  assert.equal(run([dir, '--offline', '--ci']).status, 0);
  const json = JSON.parse(run([dir, '--offline', '--json']).stdout);
  const key = json.categories.flatMap((c: { findings: { id: string; baseline?: boolean }[] }) => c.findings).find((f: { id: string }) => f.id === 'stripe-live-key');
  assert.equal(key.baseline, true);
  assert.ok(json.counts.baseline > 0);
  assert.match(run([dir, '--offline', '--no-file']).stdout, /existing issues? \(baseline\)/);

  // The key moves down two lines: still the same finding.
  const pay = readFileSync(join(dir, 'src/pay.ts'), 'utf8');
  writeFileSync(join(dir, 'src/pay.ts'), `// payments\n\n${pay}`);
  assert.equal(run([dir, '--offline', '--ci']).status, 0, 'moved lines still match the baseline');

  // A new critical problem fails CI again.
  writeFileSync(join(dir, 'src/new.ts'), `export const k2 = "${'sk_' + 'live_' + 'Zx8Kq2Wm5Np7Rt3Vb6Yc9Hd4'}";\n`);
  assert.equal(run([dir, '--offline', '--ci']).status, 1);

  // --no-baseline ignores the file entirely.
  writeFileSync(join(dir, 'src/new.ts'), '');
  assert.equal(run([dir, '--offline', '--ci']).status, 0);
  assert.equal(run([dir, '--offline', '--ci', '--no-baseline']).status, 1);
  assert.match(run(['--help']).stdout, /--update-baseline[\s\S]*--no-baseline/);
});

test('init creates the starter files once and never overwrites them', async () => {
  const { WORKFLOW_TEMPLATE } = await import('../src/init.js');
  const { writeFileSync } = await import('node:fs');
  const dir = makeProject({ 'package.json': '{}' });
  const first = run(['init', dir]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /created\s+\.launchdoctorignore/);
  assert.match(first.stdout, /created\s+\.github\/workflows\/launch-doctor\.yml/);
  assert.equal(readFileSync(join(dir, '.github/workflows/launch-doctor.yml'), 'utf8'), WORKFLOW_TEMPLATE);
  assert.match(readFileSync(join(dir, '.launchdoctorignore'), 'utf8'), /^# \.launchdoctorignore/);

  writeFileSync(join(dir, '.launchdoctorignore'), 'my-own-rules\n');
  const second = run(['init', dir]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /skipped\s+\.launchdoctorignore/);
  assert.match(second.stdout, /skipped\s+\.github\/workflows\/launch-doctor\.yml/);
  assert.equal(readFileSync(join(dir, '.launchdoctorignore'), 'utf8'), 'my-own-rules\n', 'existing file untouched');
  assert.equal(run(['init', dir, '--force']).status, 2);
  assert.match(run(['--help']).stdout, /launch-doctor init/);
});

test('the init workflow matches the README CI example', async () => {
  const { WORKFLOW_TEMPLATE } = await import('../src/init.js');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(WORKFLOW_TEMPLATE.trimEnd()), 'README CI example and init template drifted apart');
});
