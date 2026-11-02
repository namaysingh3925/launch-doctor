import { applyBaseline, fingerprint, loadBaseline } from './baseline.js';
import { costsCheck } from './checks/costs.js';
import { databaseCheck } from './checks/database.js';
import { emailCheck } from './checks/email.js';
import { firstImpressionsCheck } from './checks/first-impressions.js';
import { legalCheck } from './checks/legal.js';
import { monitoringCheck } from './checks/monitoring.js';
import { paymentsCheck } from './checks/payments.js';
import { secretsCheck } from './checks/secrets.js';
import { overall, scoreCategory, toGrade } from './grade.js';
import { scanHistory } from './history.js';
import { plural } from './util.js';
import { ProjectContext } from './project.js';
import type { CategoryResult, Check, CheckOutput, Finding, Options, Report } from './types.js';
import { version } from './version.js';

function notRun(note: string): CheckOutput {
  return { applicable: false, note, findings: [], passed: [], manual: [] };
}

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

const INLINE_IGNORE = /(?:\/\/|#|\/\*|<!--|--)\s*launch-doctor-ignore\s+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/g;

/** Is there a launch-doctor-ignore comment for this finding on its line or the line just above? */
export function isInlineIgnored(ctx: ProjectContext, f: Finding): boolean {
  const loc = f.location;
  if (!loc?.line) return false;
  const file = ctx.file(loc.file);
  if (!file) return false;
  const lines = file.content.split(/\r?\n/);
  for (const text of [lines[loc.line - 1], lines[loc.line - 2]]) {
    if (!text) continue;
    for (const m of text.matchAll(INLINE_IGNORE)) {
      if (m[1]!.split(/\s*,\s*/).includes(f.id)) return true;
    }
  }
  return false;
}

/** Category ids accepted by --only / --skip. */
export const CATEGORY_IDS = (): string[] => CHECKS.map((c) => c.id);

export async function runDoctor(root: string, options: Options = {}): Promise<Report> {
  const unknown = [...(options.only ?? []), ...(options.skip ?? [])].filter((id) => !CATEGORY_IDS().includes(id));
  if (unknown.length) throw new Error(`Unknown category: ${unknown.join(', ')}. Use one of: ${CATEGORY_IDS().join(', ')}`);
  const ctx = new ProjectContext(root, options);
  const categories: CategoryResult[] = [];
  let ignored = 0;

  for (const check of CHECKS) {
    const wanted = (!options.only || options.only.includes(check.id)) && !options.skip?.includes(check.id);
    if (!wanted) {
      categories.push({
        ...notRun('skipped'),
        id: check.id,
        name: check.name,
        weight: check.weight,
        skipped: true,
        score: null,
        grade: null,
      });
      continue;
    }
    let out: CheckOutput;
    try {
      out = await check.run(ctx);
    } catch (err) {
      out = notRun(`This check crashed: ${(err as Error).message}`);
    }
    // Opt-in: keys that were removed from the code but are still in old commits.
    if (check.id === 'secrets' && options.history && out.applicable) {
      if (!ctx.gitRoot) {
        out.passed.push('Git history not checked (this folder is not a git repo)');
      } else {
        const history = await scanHistory(ctx, options.history.depth);
        out.findings.push(...history.findings);
        if (!history.findings.length) {
          out.passed.push(`No removed keys found in the last ${plural(history.commitsScanned, 'commit')} of git history`);
        }
        if (history.truncated) out.passed.push('Git history scan stopped early because the history is very large');
      }
    }
    // Inline: a "launch-doctor-ignore <id>" comment on the finding's line or the line above.
    const inline = out.findings.filter((f) => isInlineIgnored(ctx, f));
    if (inline.length) {
      out = { ...out, findings: out.findings.filter((f) => !inline.includes(f)) };
      ignored += inline.length;
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
      weight: check.weight,
      score,
      grade: score === null ? null : toGrade(score),
    });
  }

  for (const c of categories) for (const f of c.findings) f.fingerprint = fingerprint(ctx, f);

  const summary = overall(categories);
  const knownIds = new Set(CHECKS.flatMap((c) => c.ids));
  const unknownIgnoreIds = [...ctx.ignoredIds].filter((id) => !knownIds.has(id)).sort();
  const report: Report = {
    tool: 'launch-doctor',
    version: version(),
    root: ctx.root,
    projectName: ctx.name,
    stack: ctx.stack(),
    filesScanned: ctx.files.length,
    truncated: ctx.truncated,
    ignored,
    unknownIgnoreIds,
    ...summary,
    categories,
    generatedAt: new Date().toISOString(),
  };

  if (options.baseline !== false) {
    const baseline = loadBaseline(ctx.root);
    if (baseline) applyBaseline(report, baseline);
  }
  return report;
}

export { ProjectContext } from './project.js';
export { renderReport } from './report.js';
export { renderFixes } from './fixes.js';
export type * from './types.js';
