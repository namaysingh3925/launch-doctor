import type { ProjectContext } from './project.js';

export type Severity = 'critical' | 'warning';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface Location {
  file: string;
  line?: number;
}

/** Something wrong that we found in the code. */
export interface Finding {
  id: string;
  severity: Severity;
  /** Short, plain-English headline. */
  title: string;
  /** Why it matters, written for someone who can't read code. */
  why: string;
  location?: Location;
  /** A prompt the user can paste into Claude Code, Cursor, Lovable, Bolt... */
  fixPrompt: string;
}

/** Something we can't see from the code, so the user has to check it. */
export interface ManualCheck {
  id: string;
  title: string;
  how: string;
}

export interface CheckOutput {
  applicable: boolean;
  /** Shown when the category doesn't apply, e.g. "No payment provider found". */
  note?: string;
  findings: Finding[];
  passed: string[];
  manual: ManualCheck[];
}

export interface Check {
  id: string;
  name: string;
  icon: string;
  /** How much this category counts towards the overall grade. */
  weight: number;
  run(ctx: ProjectContext): CheckOutput | Promise<CheckOutput>;
}

export interface CategoryResult extends CheckOutput {
  id: string;
  name: string;
  icon: string;
  weight: number;
  score: number | null;
  grade: Grade | null;
}

export interface Report {
  tool: 'launch-doctor';
  version: string;
  root: string;
  projectName: string;
  stack: string[];
  filesScanned: number;
  truncated: boolean;
  /** Findings and checklist items silenced by .launchdoctorignore. */
  ignored: number;
  score: number;
  grade: Grade;
  verdict: string;
  counts: { critical: number; warning: number; manual: number };
  categories: CategoryResult[];
  generatedAt: string;
}

export interface Options {
  /** Skip network checks (email DNS). */
  offline?: boolean;
  /** Domain you send email from, e.g. "myapp.com". Auto-detected when possible. */
  domain?: string;
  /** Set to false to ignore git (used by tests). Default true. */
  useGit?: boolean;
  /** Stop reading after this many files (default 20,000). */
  maxFiles?: number;
}
