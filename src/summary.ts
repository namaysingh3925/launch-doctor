import { shortWhere } from './checks/common.js';
import type { Finding, Report } from './types.js';

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function findingLine(f: Finding): string {
  const where = f.location ? ` (\`${shortWhere(f.location)}\`)` : '';
  return `- ${escapeCell(f.title)}${where}`;
}

/**
 * Markdown for the GitHub Actions job summary page (the GITHUB_STEP_SUMMARY file):
 * the grade, a category table, and the critical and warning titles with file:line.
 */
export function renderStepSummary(report: Report): string {
  const all = report.categories.flatMap((c) => c.findings);
  const critical = all.filter((f) => f.severity === 'critical');
  const warnings = all.filter((f) => f.severity === 'warning');

  const out: string[] = [
    `## Launch Doctor: grade ${report.grade}`,
    '',
    `**${escapeCell(report.verdict)}** · ${report.projectName} · ${report.filesScanned} files checked`,
    '',
    '| Category | Grade | Critical | Warnings | To check |',
    '|---|:---:|---:|---:|---:|',
  ];
  for (const c of report.categories) {
    if (c.skipped || !c.applicable) {
      out.push(`| ${c.name} | - | | | ${c.skipped ? 'skipped' : escapeCell(c.note ?? 'not used')} |`);
      continue;
    }
    const crit = c.findings.filter((f) => f.severity === 'critical').length;
    const warn = c.findings.filter((f) => f.severity === 'warning').length;
    out.push(`| ${c.name} | ${c.grade ?? '-'} | ${crit} | ${warn} | ${c.manual.length} |`);
  }
  out.push('');

  if (critical.length) {
    out.push(`### Critical (${critical.length})`, '', ...critical.map(findingLine), '');
  }
  if (warnings.length) {
    out.push(`### Warnings (${warnings.length})`, '', ...warnings.map(findingLine), '');
  }
  if (!critical.length && !warnings.length) out.push('No problems found.', '');
  return out.join('\n');
}
