import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { categoryTable, escapeCell } from './summary.js';
import type { Finding, Report } from './types.js';

/** Marks our one summary comment on a pull request, so later runs edit it instead of adding another. */
export const SUMMARY_MARKER = '<!-- launch-doctor:summary -->';
const FINDING_MARKER = /<!-- launch-doctor:finding (\S+) -->/;

/** At most this many inline comments per run, so a big pull request isn't buried. */
export const MAX_INLINE = 20;
/** At most this many findings per list in the summary comment (GitHub caps a comment at 65,536 characters). */
const MAX_LISTED = 50;

export interface PrContext {
  apiUrl: string;
  serverUrl: string;
  /** "owner/name" */
  repo: string;
  number: number;
  headSha: string;
  token: string;
  /** Where the scanned folder sits inside the repository ("" for the repository root, "web" for ./web). */
  prefix: string;
}

/**
 * Work out which pull request we're running for from the GitHub Actions environment.
 * Returns a reason string instead when there's nothing to comment on.
 */
export function prContextFromEnv(root: string, env: NodeJS.ProcessEnv = process.env): PrContext | string {
  if (env.GITHUB_ACTIONS !== 'true') return 'not running on GitHub Actions';
  const event = env.GITHUB_EVENT_NAME ?? '';
  if (event !== 'pull_request' && event !== 'pull_request_target') {
    return `this run was started by "${event || 'unknown'}", not by a pull request`;
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token)
    return 'GITHUB_TOKEN is not set (give the step the workflow token as a GITHUB_TOKEN environment variable)';
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !env.GITHUB_EVENT_PATH) return 'GITHUB_REPOSITORY or GITHUB_EVENT_PATH is missing';

  let payload: { pull_request?: { number?: number; head?: { sha?: string } } };
  try {
    payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch (err) {
    return `couldn't read the event file: ${(err as Error).message}`;
  }
  const number = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (typeof number !== 'number' || typeof headSha !== 'string') return 'the event has no pull request in it';

  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const rel = relative(workspace, root).replace(/\\/g, '/');
  const prefix = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? '' : rel;

  return {
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    serverUrl: (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, ''),
    repo,
    number,
    headSha,
    token,
    prefix,
  };
}

/** Line numbers (in the new version of the file) that a unified diff patch adds. */
export function addedLines(patch: string): Set<number> {
  const out = new Set<number>();
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (line === 0 || row.startsWith('-') || row.startsWith('\\')) continue;
    if (row.startsWith('+')) out.add(line);
    line++;
  }
  return out;
}

/** What a pull request changed in one file: the added lines, or 'all' for a new file GitHub sent no patch for. */
export type ChangedLines = Set<number> | 'all';

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
}

export function changedFiles(files: PrFile[]): Map<string, ChangedLines> {
  const out = new Map<string, ChangedLines>();
  for (const f of files) {
    if (f.status === 'removed') continue;
    if (f.patch !== undefined) out.set(f.filename, addedLines(f.patch));
    else if (f.status === 'added') out.set(f.filename, 'all');
    else out.set(f.filename, new Set());
  }
  return out;
}

export interface InlineFinding {
  finding: Finding;
  /** Path from the repository root. */
  path: string;
  line: number;
  key: string;
}

export interface Placement {
  /** Findings on lines this pull request adds. These get inline comments. */
  inPr: InlineFinding[];
  /** Everything else: older code, files the pull request didn't touch, project-wide findings. */
  elsewhere: Finding[];
  /** Findings left out because they're in .launchdoctor-baseline.json. */
  baseline: number;
}

export function repoPath(prefix: string, file: string): string {
  return prefix ? `${prefix}/${file}` : file;
}

/** Split the report's findings into "added by this pull request" and "already there". */
export function placeFindings(report: Report, changed: Map<string, ChangedLines>, prefix: string): Placement {
  const placement: Placement = { inPr: [], elsewhere: [], baseline: 0 };
  const order = (f: Finding) => (f.severity === 'critical' ? 0 : 1);
  const all = report.categories.flatMap((c) => c.findings).sort((a, b) => order(a) - order(b));
  for (const f of all) {
    if (f.baseline) {
      placement.baseline++;
      continue;
    }
    const loc = f.location;
    const lines = loc ? changed.get(repoPath(prefix, loc.file)) : undefined;
    if (loc?.line && lines && (lines === 'all' || lines.has(loc.line))) {
      const path = repoPath(prefix, loc.file);
      placement.inPr.push({ finding: f, path, line: loc.line, key: f.fingerprint ?? `${f.id}:${path}:${loc.line}` });
    } else {
      placement.elsewhere.push(f);
    }
  }
  return placement;
}

const label = (f: Finding) => (f.severity === 'critical' ? '[CRITICAL]' : '[WARN]');

/** The body of one inline review comment: what's wrong, why, the fix prompt, and how to silence it. */
export function renderInlineComment(item: InlineFinding): string {
  const f = item.finding;
  return [
    `<!-- launch-doctor:finding ${item.key} -->`,
    `**${label(f)} ${f.title}**`,
    '',
    f.why,
    '',
    '<details><summary>Fix prompt (paste into Claude Code, Cursor, Lovable or Bolt)</summary>',
    '',
    fence(f.fixPrompt),
    '',
    '</details>',
    '',
    `<sub>Not a problem here? Add a \`launch-doctor-ignore ${f.id}\` comment on this line or the line above.</sub>`,
  ].join('\n');
}

/** A code fence that can't be closed early by backticks inside the text. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

function listItems<T>(items: T[], line: (item: T) => string): string[] {
  const out = items.slice(0, MAX_LISTED).map(line);
  if (items.length > MAX_LISTED) out.push(`- ...and ${items.length - MAX_LISTED} more`);
  return out;
}

function countText(findings: Finding[]): string {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const warn = findings.length - crit;
  const parts = [];
  if (crit) parts.push(`${crit} critical`);
  if (warn) parts.push(`${warn} warning${warn === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** The one summary comment on the pull request, edited in place on every run. */
export function renderPrComment(report: Report, placement: Placement, ctx: PrContext): string {
  const link = (path: string, line?: number) =>
    `${ctx.serverUrl}/${ctx.repo}/blob/${ctx.headSha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;
  const where = (path: string, line?: number) => `[\`${line ? `${path}:${line}` : path}\`](${link(path, line)})`;

  const out = [
    SUMMARY_MARKER,
    `## Launch Doctor: grade ${report.grade}`,
    '',
    `**${escapeCell(report.verdict)}** · ${report.filesScanned} files checked`,
    '',
    '### This pull request',
    '',
  ];

  if (placement.inPr.length) {
    out.push(
      `${countText(placement.inPr.map((i) => i.finding))} on lines this pull request adds. Each one has an inline comment with a fix prompt.`,
      '',
      ...listItems(
        placement.inPr,
        (i) => `- ${label(i.finding)} ${escapeCell(i.finding.title)} (${where(i.path, i.line)})`,
      ),
    );
  } else {
    out.push('No problems in the lines this pull request adds.');
  }
  out.push('');

  if (placement.elsewhere.length) {
    out.push(
      `<details><summary>Already in the project: ${countText(placement.elsewhere)}</summary>`,
      '',
      ...listItems(placement.elsewhere, (f) => {
        const loc = f.location ? ` (${where(repoPath(ctx.prefix, f.location.file), f.location.line)})` : '';
        return `- ${label(f)} ${escapeCell(f.title)}${loc}`;
      }),
      '',
      '</details>',
      '',
    );
  }

  out.push('<details><summary>Scorecard</summary>', '', ...categoryTable(report), '', '</details>', '');

  const notes: string[] = [];
  if (placement.baseline) {
    notes.push(
      `${placement.baseline} known finding${placement.baseline === 1 ? ' is' : 's are'} in .launchdoctor-baseline.json and not shown.`,
    );
  }
  if (report.counts.manual) {
    notes.push(`${report.counts.manual} thing${report.counts.manual === 1 ? '' : 's'} to check by hand before launch.`);
  }
  notes.push(
    `Run \`npx launch-doctor\` locally for every fix prompt in LAUNCH_FIXES.md. Updated for ${ctx.headSha.slice(0, 7)}.`,
  );
  out.push(`<sub>${notes.join(' ')}</sub>`);
  return out.join('\n');
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

class GitHub {
  constructor(
    private readonly ctx: PrContext,
    private readonly fetchImpl: FetchLike,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.ctx.apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.ctx.token}`,
        'user-agent': 'launch-doctor',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        res.status,
        `${method} ${path} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      );
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** Read every page of a list endpoint (up to 3,000 items). */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 30; page++) {
      const items = await this.request<T[]>('GET', `${path}?per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
}

export interface PrResult {
  inPr: number;
  elsewhere: number;
  /** New inline comments posted this run. */
  posted: number;
  /** Inline comments left out: already posted on an earlier run. */
  alreadyPosted: number;
  /** Inline comments left out because of MAX_INLINE. */
  overLimit: number;
  /** Why the inline comments couldn't be posted, when they couldn't. */
  inlineError?: string;
  summary: 'created' | 'updated';
  summaryUrl?: string;
}

/**
 * Post Launch Doctor's results to a pull request:
 * one summary comment (edited on later runs) and an inline review comment on each new finding.
 */
export async function postPrFeedback(
  report: Report,
  ctx: PrContext,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<PrResult> {
  const gh = new GitHub(ctx, fetchImpl);
  const base = `/repos/${ctx.repo}`;

  const files = await gh.list<PrFile>(`${base}/pulls/${ctx.number}/files`);
  const placement = placeFindings(report, changedFiles(files), ctx.prefix);

  // Inline comments: skip findings we already commented on in an earlier run.
  const reviewComments = await gh.list<{ body?: string }>(`${base}/pulls/${ctx.number}/comments`);
  const seen = new Set(reviewComments.map((c) => FINDING_MARKER.exec(c.body ?? '')?.[1]).filter(Boolean));
  const fresh = placement.inPr.filter((i) => !seen.has(i.key));
  const toPost = fresh.slice(0, MAX_INLINE);
  let inlineError: string | undefined;
  if (toPost.length) {
    // Best effort: if the review is rejected (say the commit moved on), still post the summary.
    try {
      await gh.request('POST', `${base}/pulls/${ctx.number}/reviews`, {
        commit_id: ctx.headSha,
        event: 'COMMENT',
        body: `Launch Doctor found ${countText(toPost.map((i) => i.finding))} in this change.`,
        comments: toPost.map((i) => ({ path: i.path, line: i.line, side: 'RIGHT', body: renderInlineComment(i) })),
      });
    } catch (err) {
      inlineError = explainGitHubError(err);
    }
  }

  // The summary comment: edit ours if it's there, otherwise add it.
  const body = renderPrComment(report, placement, ctx);
  const issueComments = await gh.list<{ id: number; body?: string; html_url?: string }>(
    `${base}/issues/${ctx.number}/comments`,
  );
  const mine = issueComments.find((c) => (c.body ?? '').startsWith(SUMMARY_MARKER));
  const saved = mine
    ? await gh.request<{ html_url?: string }>('PATCH', `${base}/issues/comments/${mine.id}`, { body })
    : await gh.request<{ html_url?: string }>('POST', `${base}/issues/${ctx.number}/comments`, { body });

  return {
    inPr: placement.inPr.length,
    elsewhere: placement.elsewhere.length,
    posted: inlineError ? 0 : toPost.length,
    inlineError,
    alreadyPosted: placement.inPr.length - fresh.length,
    overLimit: fresh.length - toPost.length,
    summary: mine ? 'updated' : 'created',
    summaryUrl: saved?.html_url,
  };
}

/** Explain a failed GitHub call in plain words. */
export function explainGitHubError(err: unknown): string {
  if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
    return `GitHub refused the comment (${err.status}). The workflow needs "permissions: pull-requests: write". Pull requests from forks only get a read-only token, so they can't be commented on; the job summary still has the results.`;
  }
  if (err instanceof GitHubError && err.status === 422) {
    return `GitHub rejected the comment (422). ${err.message}`;
  }
  return `Couldn't comment on the pull request: ${(err as Error).message}`;
}
