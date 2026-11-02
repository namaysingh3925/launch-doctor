import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDemoProject } from '../src/demo.js';
import { renderFixes } from '../src/fixes.js';
import { runDoctor } from '../src/index.js';
import { renderReport } from '../src/report.js';

const EMOJI = /\p{Extended_Pictographic}/u;

function assertNoEmoji(label: string, text: string) {
  const lines = text.split('\n');
  const bad = lines.findIndex((l) => EMOJI.test(l));
  assert.equal(bad, -1, `${label} has an emoji on line ${bad + 1}: ${lines[bad]}`);
}

test('the demo report has no emojis in terminal, LAUNCH_FIXES.md or JSON output', async () => {
  const report = await runDoctor(createDemoProject(), { offline: true, useGit: false });
  assertNoEmoji('terminal report', renderReport(report, { fixFile: 'LAUNCH_FIXES.md' }));
  assertNoEmoji('LAUNCH_FIXES.md', renderFixes(report));
  assertNoEmoji('JSON report', JSON.stringify(report, null, 2));
});

test('--help has no emojis', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const res = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assertNoEmoji('--help', res.stdout);
});

test('the docs have no emojis', () => {
  for (const doc of ['README.md', 'CONTRIBUTING.md']) {
    assertNoEmoji(doc, readFileSync(new URL(`../../${doc}`, import.meta.url), 'utf8'));
  }
});
