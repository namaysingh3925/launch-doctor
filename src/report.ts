import type { CategoryResult, Finding, Grade, Report } from './types.js';
import { plural } from './util.js';
import { shortWhere } from './checks/common.js';

const useColor = !process.env.NO_COLOR && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY);
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = paint('1');
export const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

function gradeColor(grade: Grade): (s: string) => string {
  if (grade === 'A' || grade === 'B') return green;
  if (grade === 'C') return yellow;
  return red;
}

function badge(grade: Grade | null): string {
  if (!grade) return dim('-');
  return bold(gradeColor(grade)(grade));
}

function wrap(text: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (current && current.length + 1 + word.length > width) {
      lines.push(indent + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(indent + current);
  return lines;
}

function categorySummary(c: CategoryResult): string {
  if (c.skipped) return dim('skipped');
  if (!c.applicable) return dim(c.note ?? 'not used');
  const critical = c.findings.filter((f) => f.severity === 'critical').length;
  const warning = c.findings.filter((f) => f.severity === 'warning').length;
  const parts: string[] = [];
  if (critical) parts.push(red(`${critical} critical`));
  if (warning) parts.push(yellow(`${warning} to fix`));
  if (c.manual.length) parts.push(dim(`${c.manual.length} to check`));
  if (!critical && !warning) parts.unshift(green('all good'));
  return parts.join(dim(' · '));
}

const DETAIL_INDENT = '      ';

function findingBlock(f: Finding, width: number): string[] {
  const label = f.severity === 'critical' ? bold(red('[CRITICAL]')) : bold(yellow('[WARN]'));
  const lines = [`  ${label} ${bold(f.title)}`];
  if (f.location) lines.push(`${DETAIL_INDENT}${cyan(shortWhere(f.location))}`);
  lines.push(...wrap(f.why, width - DETAIL_INDENT.length, DETAIL_INDENT));
  lines.push('');
  return lines;
}

export function renderReport(report: Report, opts: { fixFile?: string } = {}): string {
  const width = Math.max(60, Math.min(100, process.stdout.columns || 80));
  const lines: string[] = [''];

  lines.push(`  ${bold('Launch Doctor')} ${dim(`v${report.version}`)}`);
  const stack = report.stack.length ? ` · ${report.stack.join(', ')}` : '';
  lines.push(`  ${dim(`Checked ${report.projectName} · ${plural(report.filesScanned, 'file')}${stack}`)}`);
  if (report.truncated) lines.push(`  ${yellow('Very large project: only the first 20,000 files were checked.')}`);
  lines.push('');
  lines.push(`  ${bold('Overall grade')}  ${badge(report.grade)}   ${report.verdict}`);
  lines.push('');

  const nameWidth = Math.max(...report.categories.map((c) => c.name.length)) + 2;
  for (const c of report.categories) {
    lines.push(`  ${badge(c.grade)}  ${c.name.padEnd(nameWidth)}${categorySummary(c)}`);
  }
  lines.push('');

  // Baseline findings (already known and accepted) are collapsed into one line.
  const all = report.categories.flatMap((c) => c.findings);
  const fresh = all.filter((f) => !f.baseline);
  const existing = all.length - fresh.length;
  const critical = fresh.filter((f) => f.severity === 'critical');
  const warnings = fresh.filter((f) => f.severity === 'warning');

  if (critical.length) {
    lines.push(`  ${bold(red(`MUST FIX BEFORE LAUNCH (${critical.length})`))}`, '');
    for (const f of critical) lines.push(...findingBlock(f, width));
  }
  if (warnings.length) {
    lines.push(`  ${bold(yellow(`SHOULD FIX (${warnings.length})`))}`, '');
    for (const f of warnings) lines.push(...findingBlock(f, width));
  }
  if (existing) {
    lines.push(`  ${dim(`${plural(existing, 'existing issue')} (baseline) not shown. Use --no-baseline to list them.`)}`, '');
  }

  const passed = report.categories.flatMap((c) => c.passed);
  if (passed.length) {
    lines.push(`  ${bold(green(`LOOKS GOOD (${passed.length})`))}`);
    for (const p of passed) lines.push(`  ${green('[PASS]')} ${p}`);
    lines.push('');
  }

  const manual = report.categories.flatMap((c) => c.manual);
  if (manual.length) {
    lines.push(`  ${bold(`CHECK YOURSELF (${manual.length})`)}  ${dim("- things we can't see from your code")}`);
    for (const m of manual) {
      lines.push(`  [ ] ${m.title}`);
      lines.push(...wrap(m.how, width - DETAIL_INDENT.length, DETAIL_INDENT).map(dim));
    }
    lines.push('');
  }

  if (report.ignored) {
    lines.push(`  ${dim(`${plural(report.ignored, 'item')} hidden by .launchdoctorignore or launch-doctor-ignore comments`)}`, '');
  }
  if (report.unknownIgnoreIds.length) {
    for (const id of report.unknownIgnoreIds) {
      lines.push(`  ${dim(`Warning: "${id}" in .launchdoctorignore doesn't match any check (typo?)`)}`);
    }
    lines.push('');
  }

  if (opts.fixFile) {
    lines.push(`  ${bold('Fix prompts saved to')} ${cyan(opts.fixFile)}`);
    lines.push(`  ${dim('Paste them one at a time into Claude Code, Cursor, Lovable or Bolt, then run launch-doctor again.')}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
