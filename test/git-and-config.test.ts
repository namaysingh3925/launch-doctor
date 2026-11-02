import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import { category, git, hasGit, ids, makeProject } from './helpers.js';

const base = {
  'package.json': '{"name":"git-app"}',
  'index.js': 'console.log(process.env.API_TOKEN)\n',
  '.env': 'API_TOKEN=abc123realvalue\n',
};

test('.env that git would upload is critical inside a repo', { skip: !hasGit() }, async () => {
  const dir = makeProject(base);
  git(dir, 'init', '-q');
  const report = await runDoctor(dir, { offline: true });
  const f = category(report, 'secrets').findings.find((x) => x.id === 'env-not-ignored');
  assert.equal(f?.severity, 'critical');
});

test('.env listed in .gitignore passes', { skip: !hasGit() }, async () => {
  const dir = makeProject({ ...base, '.gitignore': '.env\n' });
  git(dir, 'init', '-q');
  const report = await runDoctor(dir, { offline: true });
  assert.ok(!ids(report).some((id) => id.startsWith('env-')));
  assert.ok(category(report, 'secrets').passed.some((p) => /kept out of git/.test(p)));
});

test('.env already committed is critical even if it is ignored now', { skip: !hasGit() }, async () => {
  const dir = makeProject({ ...base, '.gitignore': '.env\n' });
  git(dir, 'init', '-q');
  git(dir, 'add', '-f', '.env');
  const report = await runDoctor(dir, { offline: true });
  assert.ok(ids(report).includes('env-committed'));
});

test('.launchdoctorignore silences findings by id and skips paths', async () => {
  const dir = makeProject({
    'package.json': '{"name":"x","dependencies":{"react":"^19","vite":"^7"}}',
    'index.html': '<title>Vite + React</title>',
    'src/App.tsx': 'export default () => null;\n',
    'legacy/old.ts': `const k = "${'sk_' + 'live_' + 'Q7wZp2Lk9VtR4mXc8Bn3Hs6Jd'}";\n`,
  });
  const before = await runDoctor(dir, { offline: true, useGit: false });
  assert.ok(ids(before).includes('no-error-tracking'));
  assert.ok(ids(before).includes('stripe-live-key'));

  writeFileSync(join(dir, '.launchdoctorignore'), '# not needed for this demo\nno-error-tracking\nlegacy/\n');
  const after = await runDoctor(dir, { offline: true, useGit: false });
  assert.ok(!ids(after).includes('no-error-tracking'));
  assert.ok(!ids(after).includes('stripe-live-key'));
  assert.ok(after.ignored >= 1);
});

test('Python projects are understood too', async () => {
  const report = await runDoctor(
    makeProject({
      'requirements.txt': 'flask==3.0\nsupabase>=2.0\nopenai\nsentry-sdk[flask]\n',
      'app.py':
        'from flask import Flask\nfrom supabase import create_client\nimport openai\napp = Flask(__name__)\n@app.post("/api/ask")\ndef ask():\n    return openai.chat.completions.create(model="gpt-5", messages=[])\n',
      'schema.sql': 'create table users (id uuid primary key, email text);\n',
    }),
    { offline: true, useGit: false },
  );
  const found = ids(report);
  assert.ok(found.includes('supabase-rls-missing'), found.join(', '));
  assert.ok(found.includes('ai-endpoint-no-auth'), found.join(', '));
  assert.ok(category(report, 'monitoring').passed.some((p) => /Sentry/.test(p)));
});
