#!/usr/bin/env node
import { appendFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createDemoProject } from './demo.js';
import { renderFixes } from './fixes.js';
import { failingFindings } from './grade.js';
import { CATEGORY_IDS, runDoctor } from './index.js';
import { bold, dim, renderReport } from './report.js';
import { renderStepSummary } from './summary.js';
import type { Severity } from './types.js';
import { version } from './version.js';

const HELP = `
  ${bold('Launch Doctor')} - a pre-launch checkup for vibe-coded apps

  ${bold('Usage')}
    npx launch-doctor [folder] [options]

  ${bold('Options')}
    --domain <domain>   Domain you send email from (checks SPF / DKIM / DMARC)
    --out <file>        Where to save the fix prompts (default: LAUNCH_FIXES.md in the project)
    --no-file           Don't write the fix prompts file
    --json              Print the full report as JSON (no fix file unless --out is given)
    --offline           Skip network checks
    --ci                Exit with code 1 if there are critical issues (no fix file unless --out)
    --fail-on <level>   With --ci, the lowest severity that fails: critical (default) or warning
    --only <ids>        Run only these categories (comma-separated)
    --skip <ids>        Skip these categories (comma-separated)
    --demo              Try it on a sample app full of mistakes
    -h, --help          Show this help
    -v, --version       Show the version

  ${bold('Categories')}
    ${CATEGORY_IDS().join(', ')}

  ${bold('Ignoring findings')}
    .launchdoctorignore            one finding id or path per line
    // launch-doctor-ignore <id>   comment on (or above) a line to silence one finding there

  ${bold('GitHub Actions')}
    When GITHUB_STEP_SUMMARY is set, a Markdown summary is added to the job summary page.

  ${bold('Examples')}
    npx launch-doctor
    npx launch-doctor ./my-app --domain myapp.com
    npx launch-doctor --ci --fail-on warning
`;

interface Args {
  path?: string;
  domain?: string;
  out?: string;
  writeFile: boolean;
  json: boolean;
  offline: boolean;
  ci: boolean;
  failOn: Severity;
  only?: string[];
  skip?: string[];
  demo: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    writeFile: true, json: false, offline: false, ci: false, failOn: 'critical', demo: false, help: false, version: false,
  };
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
    else if (a === '--domain') args.domain = cleanDomain(value());
    else if (a.startsWith('--domain=')) args.domain = cleanDomain(a.slice(9));
    else if (a === '--fail-on') args.failOn = severityArg(value());
    else if (a.startsWith('--fail-on=')) args.failOn = severityArg(a.slice(10));
    else if (a === '--only') args.only = categoriesArg(a, value());
    else if (a.startsWith('--only=')) args.only = categoriesArg('--only', a.slice(7));
    else if (a === '--skip') args.skip = categoriesArg(a, value());
    else if (a.startsWith('--skip=')) args.skip = categoriesArg('--skip', a.slice(7));
    else if (a === '--out') args.out = value();
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('-')) fail(`Unknown option ${a}. Run with --help to see the options.`);
    else if (!args.path) args.path = a;
    else fail(`Unexpected argument ${a}`);
  }
  // Machine-readable and CI runs shouldn't leave files behind unless asked to.
  if ((args.json || args.ci) && !args.out) args.writeFile = false;
  return args;
}

function categoriesArg(flag: string, input: string): string[] {
  const ids = input.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !CATEGORY_IDS().includes(id));
  if (!ids.length || unknown.length) {
    fail(`${flag}: unknown category "${unknown.join('", "') || input}". Use: ${CATEGORY_IDS().join(', ')}`);
  }
  return ids;
}

function severityArg(input: string): Severity {
  if (input === 'critical' || input === 'warning') return input;
  fail(`--fail-on must be "critical" or "warning", not "${input}"`);
}

/** "https://www.MyApp.com/pricing" -> "myapp.com" */
function cleanDomain(input: string): string {
  const domain = input.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/^www\./i, '').toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`"${input}" doesn't look like a domain (example: myapp.com)`);
  return domain;
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

  let report;
  try {
    report = await runDoctor(root, { offline: args.offline, domain: args.domain, only: args.only, skip: args.skip });
  } finally {
    // The demo project lives in a temp folder; always clean it up, even if the scan throws.
    if (args.demo) rmSync(root, { recursive: true, force: true });
  }

  if (report.filesScanned === 0) {
    fail(`No project files found in ${root}. Run this inside your app's folder.`);
  }

  let fixFile: string | undefined;
  const hasSomething = report.counts.critical + report.counts.warning + report.counts.manual > 0;
  const target = args.out ? (isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out)) : join(root, 'LAUNCH_FIXES.md');
  // Rewrite an existing file even when everything passes, so old problems don't linger in it.
  if (args.writeFile && (hasSomething || existsSync(target))) {
    try {
      writeFileSync(target, renderFixes(report));
      const rel = relative(process.cwd(), target);
      fixFile = rel && !rel.startsWith('..') ? rel : target;
    } catch (err) {
      process.stderr.write(`${dim(`Couldn't write ${target}: ${(err as Error).message}`)}\n`);
    }
  }

  // On GitHub Actions, add a summary to the job's summary page.
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      appendFileSync(stepSummary, `${renderStepSummary(report)}\n`);
    } catch (err) {
      process.stderr.write(`${dim(`Couldn't write the GitHub step summary: ${(err as Error).message}`)}\n`);
    }
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderReport(report, { fixFile }));

  if (args.ci && failingFindings(report, args.failOn).length > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`launch-doctor crashed: ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
