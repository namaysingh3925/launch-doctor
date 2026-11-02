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
  /** Stable id for baselines: finding id + file + hash of the matched line. Set by runDoctor. */
  fingerprint?: string;
  /** True when this finding is in .launchdoctor-baseline.json (an existing, accepted issue). */
  baseline?: boolean;
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
  /** How much this category counts towards the overall grade. */
  weight: number;
  /** Every finding and checklist id this check can produce (used to spot typos in .launchdoctorignore). */
  ids: readonly string[];
  run(ctx: ProjectContext): CheckOutput | Promise<CheckOutput>;
}

export interface CategoryResult extends CheckOutput {
  id: string;
  name: string;
  weight: number;
  /** True when the category was left out with --only / --skip. */
  skipped?: boolean;
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
  /** Findings and checklist items silenced by .launchdoctorignore or inline launch-doctor-ignore comments. */
  ignored: number;
  /** Ids in .launchdoctorignore that no check can produce (probably typos). */
  unknownIgnoreIds: string[];
  score: number;
  grade: Grade;
  verdict: string;
  /** baseline: how many findings matched .launchdoctor-baseline.json. */
  counts: { critical: number; warning: number; manual: number; baseline: number };
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
  /** Run only these category ids. */
  only?: string[];
  /** Skip these category ids. */
  skip?: string[];
  /** Load .launchdoctor-baseline.json if present (default true). */
  baseline?: boolean;
  /** Also scan git history for removed keys (opt-in). depth = how many commits. */
  history?: { depth: number };
}
