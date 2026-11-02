import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type KeyPattern, matchKeys } from './checks/secrets.js';
import { gitArgs, isRealEnvPath, type ProjectContext } from './project.js';
import type { Finding } from './types.js';
import { mask } from './util.js';

export const DEFAULT_HISTORY_DEPTH = 500;
/** Stop reading git output after this many bytes, so huge repos don't take forever. */
export const HISTORY_BYTE_CAP = 64 * 1024 * 1024;

interface HistoryHit {
  pattern: KeyPattern;
  value: string;
  commit: string;
  path: string;
}

export interface HistoryResult {
  findings: Finding[];
  commitsScanned: number;
  truncated: boolean;
}

/**
 * Look for API keys that were added in past commits and are no longer in the code.
 * Only added lines ("+" in the diff) are checked. Keys that are still in the working tree are
 * left out, because the normal scan already reports them.
 */
export async function scanHistory(ctx: ProjectContext, depth = DEFAULT_HISTORY_DEPTH): Promise<HistoryResult> {
  if (!ctx.gitRoot) return { findings: [], commitsScanned: 0, truncated: false };

  const args = gitArgs([
    'log',
    '-p',
    '--all',
    '--no-color',
    '-U0',
    `--max-count=${depth}`,
    '--pretty=format:commit %H',
    '--no-ext-diff',
  ]);
  const child = spawn('git', args, { cwd: ctx.root, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const hits = new Map<string, HistoryHit>();
  let commit = '';
  let path = '';
  let commits = 0;
  let bytes = 0;
  let truncated = false;

  for await (const line of lines) {
    bytes += line.length + 1;
    if (bytes > HISTORY_BYTE_CAP) {
      truncated = true;
      child.kill();
      break;
    }
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 47);
      commits++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = line.startsWith('+++ b/') ? line.slice(6) : '';
      continue;
    }
    if (!line.startsWith('+') || !path) continue;
    for (const k of matchKeys(line.slice(1))) {
      // git log runs newest first, so overwriting keeps the commit that first added the key.
      hits.set(k.value, { pattern: k.pattern, value: k.value, commit, path });
    }
  }
  await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('close', resolve)));

  // What's in the code today is reported by the normal scan (real .env files are meant to hold keys).
  const current = ctx.files
    .filter((f) => !isRealEnvPath(f.path))
    .map((f) => f.content)
    .join('\n');
  const findings: Finding[] = [];
  for (const hit of hits.values()) {
    if (current.includes(hit.value)) continue;
    if (findings.length >= 10) break;
    findings.push(historyFinding(hit));
  }
  return { findings, commitsScanned: commits, truncated };
}

function historyFinding(hit: HistoryHit): Finding {
  const short = hit.commit.slice(0, 7);
  const shown = hit.pattern.id === 'private-key' ? '-----BEGIN … PRIVATE KEY-----' : mask(hit.value);
  return {
    id: 'secret-in-history',
    severity: 'critical',
    title: `Secret still in git history: ${hit.pattern.name} (commit ${short}, ${hit.path})`,
    why: `This ${hit.pattern.name} (${shown}) was removed from your code, but it's still in commit ${short}. Anyone who can clone the repo can dig it out, so it has to be treated as leaked.`,
    location: { file: hit.path },
    fixPrompt:
      `Commit ${short} in my git history added a ${hit.pattern.name} (it starts with "${shown}") to ${hit.path}. The code no longer has it, but the history does. Please:\n` +
      `1. Walk me through revoking this key and creating a new one (${hit.pattern.rotate}), and make sure the new one lives only in an environment variable.\n` +
      `2. Optionally, explain how to remove it from the history with git filter-repo (for example "git filter-repo --replace-text replacements.txt"), what that means for everyone else who has a clone, and that I'll need to force-push.\n` +
      `Rotating the key matters most: rewriting history doesn't help if someone already copied it.`,
  };
}
