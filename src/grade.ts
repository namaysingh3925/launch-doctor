import type { CategoryResult, CheckOutput, Finding, Grade, Report, Severity } from './types.js';
import { plural } from './util.js';

const CRITICAL_COST = 50;
const WARNING_COST = 15;
/** Highest score allowed when there is any critical issue: always an F. */
const CRITICAL_CAP = 39;

export function scoreCategory(out: CheckOutput): number {
  const critical = out.findings.filter((f) => f.severity === 'critical').length;
  const warning = out.findings.filter((f) => f.severity === 'warning').length;
  const score = Math.max(0, 100 - CRITICAL_COST * critical - WARNING_COST * warning);
  // Any critical problem is an F. Without one, lots of small issues bottom out at D.
  return critical > 0 ? Math.min(score, CRITICAL_CAP) : Math.max(score, 40);
}

export function toGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function overall(categories: CategoryResult[]) {
  const scored = categories.filter((c) => c.applicable && c.score !== null);
  const totalWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  let score = totalWeight
    ? Math.round(scored.reduce((sum, c) => sum + (c.score ?? 0) * c.weight, 0) / totalWeight)
    : 100;

  const all = categories.flatMap((c) => c.findings);
  const critical = all.filter((f) => f.severity === 'critical').length;
  const warning = all.filter((f) => f.severity === 'warning').length;
  const manual = categories.reduce((sum, c) => sum + c.manual.length, 0);

  // Any critical issue means "not ready" (an F), whatever the average says.
  // An A means nothing left to fix.
  if (critical > 0) score = Math.min(score, CRITICAL_CAP);
  else if (warning > 0) score = Math.min(score, 89);

  const verdict =
    critical > 0
      ? `Not ready to launch: fix ${plural(critical, 'critical issue')} first`
      : warning > 0
        ? `Almost ready: ${plural(warning, 'thing')} to improve`
        : 'Looks ready to launch';

  return { score, grade: toGrade(score), verdict, counts: { critical, warning, manual, baseline: 0 } };
}

/** New findings at or above a severity level: the ones that should fail a CI run. Baseline findings don't count. */
export function failingFindings(report: Report, failOn: Severity): Finding[] {
  return report.categories
    .flatMap((c) => c.findings)
    .filter((f) => !f.baseline && (f.severity === 'critical' || failOn === 'warning'));
}
