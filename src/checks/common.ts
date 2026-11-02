import { isCodeFile, isTestPath, type Match, type ProjectContext, type SourceFile } from '../project.js';
import type { CheckOutput, Location } from '../types.js';

export function emptyOutput(): CheckOutput {
  return { applicable: true, findings: [], passed: [], manual: [] };
}

export function notApplicable(note: string): CheckOutput {
  return { applicable: false, note, findings: [], passed: [], manual: [] };
}

export function at(m: Match): Location {
  return { file: m.file.path, line: m.line };
}

/** "src/app.ts (line 4)": for sentences and prompts. */
export function where(loc?: Location): string {
  if (!loc) return '';
  return loc.line ? `${loc.file} (line ${loc.line})` : loc.file;
}

/** "src/app.ts:4": for lists and headings (clickable in most editors). */
export function shortWhere(loc?: Location): string {
  if (!loc) return '';
  return loc.line ? `${loc.file}:${loc.line}` : loc.file;
}

/** App code we care about: real source files, not tests. */
export const appCode = (f: SourceFile): boolean => isCodeFile(f) && !isTestPath(f.path);

/** Does this file handle HTTP requests (an API route, server action, edge function, Express/Flask route)? */
export function isRouteLike(f: SourceFile): boolean {
  return (
    /(^|\/)(api|routes?|functions|server|actions?|trpc|handlers?)\//.test(f.path) ||
    /(^|\/)route\.(t|j)s$|\+server\.(t|j)s$|\.server\.(t|j)s$|(^|\/)actions?\.(t|j)s$/.test(f.path) ||
    /["']use server["']/.test(f.content) ||
    /\b(?:app|router)\.(?:post|get|all)\s*\(|Deno\.serve\s*\(|\bserve\s*\(\s*async/.test(f.content)
  );
}

/** App code that runs on the server. */
export function serverCode(ctx: ProjectContext) {
  return (f: SourceFile): boolean => appCode(f) && !ctx.isClient(f);
}

/** App code that runs in the browser. */
export function clientCode(ctx: ProjectContext) {
  return (f: SourceFile): boolean => appCode(f) && ctx.isClient(f);
}
