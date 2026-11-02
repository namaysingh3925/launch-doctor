import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = (file: string) => new URL(`../../${file}`, import.meta.url);
const cliSource = readFileSync(root('src/cli.ts'), 'utf8');
const readme = readFileSync(root('README.md'), 'utf8');
const help = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--help'], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
}).stdout;

/** Every flag the argument parser accepts, read from the source. */
const parsedFlags = [
  ...new Set(
    [...cliSource.matchAll(/a === '(-{1,2}[a-z-]+)'|a\.startsWith\('(--[a-z-]+)='\)/g)].map((m) => (m[1] ?? m[2])!),
  ),
].sort();

test('the parser accepts the flags we expect', () => {
  assert.ok(parsedFlags.length >= 19, parsedFlags.join(' '));
  assert.ok(parsedFlags.includes('--history-depth'));
});

test('every flag is listed in --help', () => {
  for (const flag of parsedFlags) {
    assert.match(help, new RegExp(`(^|[\\s,])${flag}(\\s|,|$)`, 'm'), `${flag} is missing from --help`);
  }
});

test('every flag is in the README CLI reference table', () => {
  const table = readme.slice(readme.indexOf('## CLI reference'), readme.indexOf('**Exit codes**'));
  for (const flag of parsedFlags) {
    assert.ok(table.includes(`\`${flag}`), `${flag} is missing from the README CLI table`);
  }
});

test('--help and the README do not mention flags that do not exist', () => {
  const known = new Set(parsedFlags);
  const helpFlags = [...help.matchAll(/(?:^|\s)(--[a-z][a-z-]+)/gm)].map((m) => m[1]!);
  const table = readme.slice(readme.indexOf('## CLI reference'), readme.indexOf('**Exit codes**'));
  const readmeFlags = [...table.matchAll(/`(--[a-z][a-z-]+)/g)].map((m) => m[1]!);
  for (const flag of [...helpFlags, ...readmeFlags]) assert.ok(known.has(flag), `${flag} is documented but not parsed`);
});

test('--help option descriptions line up in one column', () => {
  const block = help.slice(help.indexOf('Options'), help.indexOf('Categories'));
  const rows = block.split('\n').filter((l) => /^\s{4}-/.test(l));
  // "    --flag <value>    Description" or "    -h, --help    Description": where does the description start?
  const descStart = new Set(rows.map((l) => /^(\s*-\S*(?: -\S+)?(?: <[^>]+>)?\s+)/.exec(l)?.[1]?.length ?? -1));
  assert.equal(rows.length >= 17, true);
  assert.equal(descStart.size, 1, `descriptions start at different columns: ${[...descStart].join(', ')}`);
});
