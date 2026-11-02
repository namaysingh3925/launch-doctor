#!/usr/bin/env node
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createDemoProject } from './demo.js';
import { renderFixes } from './fixes.js';
import { runDoctor } from './index.js';
import { bold, dim, renderReport } from './report.js';
import { version } from './version.js';

const HELP = `
  ${bold('🩺 Launch Doctor')} — a pre-launch checkup for vibe-coded apps

  ${bold('Usage')}
    npx launch-doctor [folder] [options]

  ${bold('Options')}
    --domain <domain>   Domain you send email from (checks SPF / DKIM / DMARC)
    --out <file>        Where to save the fix prompts (default: LAUNCH_FIXES.md in the project)
    --no-file           Don't write the fix prompts file
    --json              Print the full report as JSON
    --offline           Skip network checks
    --ci                Exit with code 1 if there are critical issues
    --demo              Try it on a sample app full of mistakes
    -h, --help          Show this help
    -v, --version       Show the version

  ${bold('Examples')}
    npx launch-doctor
    npx launch-doctor ./my-app --domain myapp.com
    npx launch-doctor --ci --no-file
`;

interface Args {
  path?: string;
  domain?: string;
  out?: string;
  writeFile: boolean;
  json: boolean;
  offline: boolean;
  ci: boolean;
  demo: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { writeFile: true, json: false, offline: false, ci: false, demo: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) fail(`${a} needs a value`);
      return v!;
    };
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a === '--json') args.json = true;
    else if (a === '--offline') args.offline = true;
    else if (a === '--ci') args.ci = true;
    else if (a === '--demo') args.demo = true;
    else if (a === '--no-file') args.writeFile = false;
    else if (a === '--domain') args.domain = value().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    else if (a.startsWith('--domain=')) args.domain = a.slice(9).toLowerCase();
    else if (a === '--out') args.out = value();
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('-')) fail(`Unknown option ${a}. Run with --help to see the options.`);
    else if (!args.path) args.path = a;
    else fail(`Unexpected argument ${a}`);
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`launch-doctor: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }

  if (args.demo) {
    if (args.path) fail('--demo scans a built-in sample app, so leave out the folder');
    args.path = createDemoProject();
    args.offline = true;
    if (!args.out) args.writeFile = false;
    if (!args.json) process.stdout.write(`\n  ${dim('Demo: scanning a sample app with the usual weekend-project mistakes…')}\n`);
  }

  const root = resolve(args.path ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`Folder not found: ${root}`);

  const report = await runDoctor(root, { offline: args.offline, domain: args.domain });
  if (args.demo) rmSync(root, { recursive: true, force: true });

  if (report.filesScanned === 0) {
    fail(`No project files found in ${root}. Run this inside your app's folder.`);
  }

  let fixFile: string | undefined;
  const hasSomething = report.counts.critical + report.counts.warning + report.counts.manual > 0;
  if (args.writeFile && hasSomething) {
    const target = args.out ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)) : join(root, 'LAUNCH_FIXES.md');
    try {
      writeFileSync(target, renderFixes(report));
      const rel = relative(process.cwd(), target);
      fixFile = rel && !rel.startsWith('..') ? rel : target;
    } catch (err) {
      process.stderr.write(`${dim(`Couldn't write ${target}: ${(err as Error).message}`)}\n`);
    }
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderReport(report, { fixFile }));

  if (args.ci && report.counts.critical > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`launch-doctor crashed: ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
