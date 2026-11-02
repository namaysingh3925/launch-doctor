import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from './project.js';
import type { Finding, Report } from './types.js';

export const BASELINE_FILE = '.launchdoctor-baseline.json';

interface BaselineEntry {
  fingerprint: string;
  id: string;
  file?: string;
}

interface BaselineFile {
  tool: 'launch-doctor';
  version: 1;
  generatedAt: string;
  findings: BaselineEntry[];
}

/**
 * A stable fingerprint: finding id + file + a hash of the trimmed text of the matched line.
 * It doesn't include the line number, so it survives lines moving up or down.
 */
export function fingerprint(ctx: ProjectContext, f: Finding): string {
  const file = f.location?.file ?? '';
  let text = '';
  if (file && f.location?.line) {
    const content = ctx.file(file)?.content;
    if (content) text = content.split(/\r?\n/)[f.location.line - 1]?.trim() ?? '';
  }
  if (!text) text = f.title;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  return `${f.id}|${file}|${hash}`;
}

/** Fingerprints in the project's baseline file, or null if there is none (or it can't be read). */
export function loadBaseline(root: string): Set<string> | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, BASELINE_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<BaselineFile>;
    return new Set((data.findings ?? []).map((e) => e.fingerprint).filter((f): f is string => typeof f === 'string'));
  } catch {
    return null;
  }
}

/** Save every current finding as the new baseline. Returns how many were saved. */
export function writeBaseline(root: string, report: Report): number {
  const findings = report.categories.flatMap((c) => c.findings).filter((f) => f.fingerprint);
  const data: BaselineFile = {
    tool: 'launch-doctor',
    version: 1,
    generatedAt: report.generatedAt,
    findings: findings.map((f) => ({
      fingerprint: f.fingerprint!,
      id: f.id,
      ...(f.location ? { file: f.location.file } : {}),
    })),
  };
  writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(data, null, 2)}\n`);
  return findings.length;
}

/** Mark findings that are in the baseline. Returns how many matched. */
export function applyBaseline(report: Report, baseline: Set<string>): number {
  let matched = 0;
  for (const c of report.categories) {
    for (const f of c.findings) {
      if (f.fingerprint && baseline.has(f.fingerprint)) {
        f.baseline = true;
        matched++;
      } else {
        delete f.baseline;
      }
    }
  }
  report.counts.baseline = matched;
  return matched;
}
