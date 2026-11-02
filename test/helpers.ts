import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Report } from '../src/types.js';

// Tests spawn the CLI with process.env. On GitHub Actions that would write test runs into the real job summary.
delete process.env.GITHUB_STEP_SUMMARY;

/** Create a throwaway project folder from a { path: content } map. */
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'launch-doctor-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/**
 * Build a realistic-looking fake key at runtime, so no secret-shaped string
 * is ever committed to this repo (GitHub push protection would block it).
 */
export function fakeKey(prefix: string, length = 32, seed = 7): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let x = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += chars[x % chars.length];
  }
  return prefix + out;
}

export function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.${fakeKey('', 43, 99)}`;
}

export function ids(report: Report): string[] {
  return report.categories.flatMap((c) => c.findings.map((f) => f.id));
}

export function manualIds(report: Report): string[] {
  return report.categories.flatMap((c) => c.manual.map((m) => m.id));
}

export function category(report: Report, id: string) {
  const c = report.categories.find((x) => x.id === id);
  if (!c) throw new Error(`no category ${id}`);
  return c;
}

export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
