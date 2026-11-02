import { costsCheck } from './checks/costs.js';
import { databaseCheck } from './checks/database.js';
import { emailCheck } from './checks/email.js';
import { firstImpressionsCheck } from './checks/first-impressions.js';
import { legalCheck } from './checks/legal.js';
import { monitoringCheck } from './checks/monitoring.js';
import { paymentsCheck } from './checks/payments.js';
import { secretsCheck } from './checks/secrets.js';
import { overall, scoreCategory, toGrade } from './grade.js';
import { ProjectContext } from './project.js';
import type { CategoryResult, Check, CheckOutput, Options, Report } from './types.js';
import { version } from './version.js';

export const CHECKS: Check[] = [
  secretsCheck,
  databaseCheck,
  paymentsCheck,
  costsCheck,
  emailCheck,
  monitoringCheck,
  legalCheck,
  firstImpressionsCheck,
];

export async function runDoctor(root: string, options: Options = {}): Promise<Report> {
  const ctx = new ProjectContext(root, options);
  const categories: CategoryResult[] = [];
  let ignored = 0;

  for (const check of CHECKS) {
    let out: CheckOutput;
    try {
      out = await check.run(ctx);
    } catch (err) {
      out = {
        applicable: false,
        note: `This check crashed: ${(err as Error).message}`,
        findings: [],
        passed: [],
        manual: [],
      };
    }
    if (ctx.ignoredIds.size) {
      const before = out.findings.length + out.manual.length;
      out = {
        ...out,
        findings: out.findings.filter((f) => !ctx.ignoredIds.has(f.id)),
        manual: out.manual.filter((m) => !ctx.ignoredIds.has(m.id)),
      };
      ignored += before - out.findings.length - out.manual.length;
    }
    const score = out.applicable ? scoreCategory(out) : null;
    categories.push({
      ...out,
      id: check.id,
      name: check.name,
      icon: check.icon,
      weight: check.weight,
      score,
      grade: score === null ? null : toGrade(score),
    });
  }

  const summary = overall(categories);
  return {
    tool: 'launch-doctor',
    version: version(),
    root: ctx.root,
    projectName: ctx.name,
    stack: ctx.stack(),
    filesScanned: ctx.files.length,
    truncated: ctx.truncated,
    ignored,
    ...summary,
    categories,
    generatedAt: new Date().toISOString(),
  };
}

export { ProjectContext } from './project.js';
export { renderReport } from './report.js';
export { renderFixes } from './fixes.js';
export type * from './types.js';
