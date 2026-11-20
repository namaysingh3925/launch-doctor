import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { shortWhere } from './checks/common.js';
import { DEFAULT_HISTORY_DEPTH } from './history.js';
import { CHECKS, runDoctor } from './index.js';
import { runLiveScan } from './live.js';
import { nestedReposNote } from './report.js';
import type { Finding, ManualCheck, Report } from './types.js';
import { plural } from './util.js';
import { version } from './version.js';

/**
 * A Model Context Protocol server over stdio, so AI coding tools (Claude Code, Cursor, ...)
 * can run Launch Doctor themselves. One JSON-RPC 2.0 message per line on stdin and stdout.
 * Nothing else may be written to stdout: it is the protocol channel.
 */

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Offered when a client asks for a version this server doesn't know. */
const DEFAULT_PROTOCOL = '2025-06-18';
/** Findings and checklist items listed per section in a tool result. */
const MAX_LISTED = 50;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const UNKNOWN_METHOD = Symbol('unknown method');

/** The tools this server offers, with JSON Schemas for their arguments. */
export function mcpTools() {
  const categories = CHECKS.map((c) => c.id);
  return [
    {
      name: 'scan_project',
      title: 'Check a project before launch',
      description:
        'Runs Launch Doctor on a project folder and grades it A to F on secrets and API keys, database safety, payments, AI and API costs, email delivery, error tracking, legal pages and first impressions. ' +
        'Returns every problem with its file and line, why it matters, and a fix prompt that describes the change to make, plus a checklist of things to verify outside the code. It only reads files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Project folder to check: absolute, or relative to the folder the server started in (the default).',
          },
          only: {
            type: 'array',
            items: { type: 'string', enum: categories },
            description: 'Check only these categories.',
          },
          skip: {
            type: 'array',
            items: { type: 'string', enum: categories },
            description: 'Leave out these categories.',
          },
          offline: {
            type: 'boolean',
            description: 'Skip the email DNS lookups (SPF, DKIM, DMARC). Default false.',
          },
          domain: { type: 'string', description: "Domain the app sends email from, if the code doesn't show it." },
          history: {
            type: 'boolean',
            description: 'Also look for API keys that are still in git history. Slower. Default false.',
          },
          includeBaseline: {
            type: 'boolean',
            description: 'Also list findings accepted in .launchdoctor-baseline.json. Default false.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'scan_url',
      title: 'Check a deployed site',
      description:
        'Checks a live website from the outside, the way an attacker would: downloadable .env, .git and backup files, public source maps, API keys in the JavaScript, Supabase tables readable with the public key, and HTTPS and security headers. ' +
        'Sends ordinary GET requests only.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The site to check, for example https://myapp.com.' },
          skipDatabase: {
            type: 'boolean',
            description: "Don't test Supabase tables with the public key found in the page. Default false.",
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'list_checks',
      title: 'List the checks',
      description:
        'Lists the categories and every finding and checklist id, for the only and skip options and for .launchdoctorignore.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

// ---------- tool results ----------

function indent(text: string, by = '   '): string {
  return text
    .split('\n')
    .map((l) => (l ? by + l : l))
    .join('\n');
}

function findingEntry(n: number, f: Finding): string {
  const where = f.location ? ` (${shortWhere(f.location)})` : '';
  const known = f.baseline ? ' [in baseline]' : '';
  return [
    `${n}. ${f.title}${where} · id: ${f.id}${known}`,
    indent(`Why it matters: ${f.why}`),
    indent(`Fix prompt:\n${indent(f.fixPrompt, '  ')}`),
  ].join('\n');
}

function listSection<T>(title: string, items: T[], entry: (item: T, n: number) => string): string[] {
  if (!items.length) return [];
  const out = ['', `${title} (${items.length})`, ''];
  for (const [i, item] of items.slice(0, MAX_LISTED).entries()) out.push(entry(item, i + 1));
  if (items.length > MAX_LISTED) out.push(`...and ${items.length - MAX_LISTED} more.`);
  return out;
}

/** Plain-text summary of a report, written for an AI assistant that will act on it. */
export function reportText(report: Report, includeBaseline = false): string {
  const all = report.categories.flatMap((c) => c.findings);
  const shown = includeBaseline ? all : all.filter((f) => !f.baseline);
  const hiddenBaseline = all.length - shown.length;
  const manual = report.categories.flatMap((c) => c.manual);
  const unit = report.mode === 'live' ? 'request' : 'file';

  const lines = [
    `Launch Doctor ${report.version}: grade ${report.grade} (${report.score}/100) for ${report.projectName}. ${plural(report.filesScanned, unit)} checked.`,
    report.verdict,
  ];
  if (report.nestedRepos?.length) lines.push(nestedReposNote(report.nestedRepos));
  if (report.truncated) lines.push('Very large project: only the first 20,000 files were checked.');

  lines.push(
    ...listSection(
      'Critical',
      shown.filter((f) => f.severity === 'critical'),
      (f, n) => findingEntry(n, f),
    ),
    ...listSection(
      'Warnings',
      shown.filter((f) => f.severity === 'warning'),
      (f, n) => findingEntry(n, f),
    ),
    ...listSection(
      'Check by hand, outside the code',
      manual,
      (m: ManualCheck, n) => `${n}. ${m.title} · id: ${m.id}\n${indent(m.how)}`,
    ),
  );
  if (!shown.length) lines.push('', 'No problems found.');

  lines.push(
    '',
    `Scorecard: ${report.categories.map((c) => `${c.name} ${c.skipped ? 'skipped' : c.applicable ? (c.grade ?? '-') : 'not used'}`).join(' · ')}`,
  );
  if (hiddenBaseline) {
    lines.push(
      `${plural(hiddenBaseline, 'known finding')} in .launchdoctor-baseline.json not listed (set includeBaseline to see them).`,
    );
  }
  if (report.ignored) {
    lines.push(`${plural(report.ignored, 'item')} silenced by .launchdoctorignore or launch-doctor-ignore comments.`);
  }
  return lines.join('\n');
}

/** The same report as data, for clients that read structured tool output. */
export function reportData(report: Report, includeBaseline = false): Record<string, unknown> {
  return {
    grade: report.grade,
    score: report.score,
    verdict: report.verdict,
    projectName: report.projectName,
    counts: report.counts,
    ...(report.nestedRepos?.length ? { nestedRepos: report.nestedRepos } : {}),
    categories: report.categories.map((c) => ({
      id: c.id,
      name: c.name,
      grade: c.grade,
      applicable: c.applicable,
      skipped: Boolean(c.skipped),
    })),
    findings: report.categories.flatMap((c) =>
      c.findings
        .filter((f) => includeBaseline || !f.baseline)
        .map((f) => ({
          id: f.id,
          category: c.id,
          severity: f.severity,
          title: f.title,
          file: f.location?.file,
          line: f.location?.line,
          why: f.why,
          fixPrompt: f.fixPrompt,
          baseline: Boolean(f.baseline),
        })),
    ),
    manual: report.categories.flatMap((c) =>
      c.manual.map((m) => ({ id: m.id, category: c.id, title: m.title, how: m.how })),
    ),
  };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function reportResult(report: Report, includeBaseline: boolean): ToolResult {
  return {
    content: [{ type: 'text', text: reportText(report, includeBaseline) }],
    structuredContent: reportData(report, includeBaseline),
  };
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Checks the arguments by hand (no schema library), so a bad call gets a message the model can act on. */
function badArgs(
  args: Record<string, unknown>,
  shape: Record<string, 'string' | 'boolean' | 'string[]'>,
): string | null {
  for (const key of Object.keys(args)) if (!(key in shape)) return `Unknown argument "${key}".`;
  for (const [key, type] of Object.entries(shape)) {
    const v = args[key];
    if (v === undefined) continue;
    const ok = type === 'string[]' ? isStringArray(v) : typeof v === type;
    if (!ok) return `"${key}" must be ${type === 'string[]' ? 'a list of strings' : `a ${type}`}.`;
  }
  return null;
}

async function scanProject(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const problem = badArgs(args, {
    path: 'string',
    only: 'string[]',
    skip: 'string[]',
    offline: 'boolean',
    domain: 'string',
    history: 'boolean',
    includeBaseline: 'boolean',
  });
  if (problem) return toolError(problem);
  const root = resolve(cwd, (args.path as string | undefined) ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) return toolError(`Folder not found: ${root}`);
  const domain = (args.domain as string | undefined)
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '');
  let report: Report;
  try {
    report = await runDoctor(root, {
      offline: args.offline === true,
      domain: domain || undefined,
      only: args.only as string[] | undefined,
      skip: args.skip as string[] | undefined,
      history: args.history === true ? { depth: DEFAULT_HISTORY_DEPTH } : undefined,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
  if (report.filesScanned === 0) return toolError(`No project files found in ${root}.`);
  return reportResult(report, args.includeBaseline === true);
}

async function scanUrl(args: Record<string, unknown>): Promise<ToolResult> {
  const problem = badArgs(args, { url: 'string', skipDatabase: 'boolean' });
  if (problem) return toolError(problem);
  if (typeof args.url !== 'string' || !args.url.trim())
    return toolError('"url" is required, for example https://myapp.com.');
  try {
    return reportResult(await runLiveScan(args.url, { skipDatabase: args.skipDatabase === true }), false);
  } catch (err) {
    return toolError((err as Error).message);
  }
}

function listChecks(): ToolResult {
  const categories = CHECKS.map((c) => ({ id: c.id, name: c.name, ids: [...c.ids] }));
  const text = categories.map((c) => `${c.id} (${c.name}): ${c.ids.join(', ')}`).join('\n');
  return { content: [{ type: 'text', text }], structuredContent: { categories } };
}

/** Run one tool. Unknown tool names are a protocol error; bad arguments are a tool error the model can fix. */
export async function callTool(name: unknown, args: unknown, cwd = process.cwd()): Promise<ToolResult> {
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) return toolError('Arguments must be an object.');
  const params = a as Record<string, unknown>;
  if (name === 'scan_project') return scanProject(params, cwd);
  if (name === 'scan_url') return scanUrl(params);
  if (name === 'list_checks') return listChecks();
  throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
}

// ---------- JSON-RPC ----------

function negotiate(params: Record<string, unknown>) {
  const asked = params.protocolVersion;
  const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'launch-doctor', title: 'Launch Doctor', version: version() },
    instructions:
      'Use scan_project before a launch or a big release to find leaked keys, open databases, unverified payment webhooks, unprotected AI endpoints and missing legal pages. ' +
      'Each finding has a fix prompt: apply fixes one at a time, critical first, then run scan_project again. Use scan_url on the deployed site after deploying.',
  };
}

async function dispatch(method: string, params: Record<string, unknown>, cwd: string): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return negotiate(params);
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: mcpTools() };
    case 'tools/call':
      return callTool(params.name, params.arguments, cwd);
    default:
      return UNKNOWN_METHOD;
  }
}

const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

async function handleOne(msg: unknown, cwd: string): Promise<object | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = msg as RpcMessage;
  // A message without an id is a notification (like notifications/initialized): never answered.
  const notification = id === undefined;
  const replyId = id ?? null;
  if (typeof method !== 'string') return notification ? null : rpcError(replyId, -32600, 'Invalid Request');
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    return notification ? null : rpcError(replyId, -32602, 'params must be an object');
  }
  try {
    const result = await dispatch(method, (params ?? {}) as Record<string, unknown>, cwd);
    if (notification) return null;
    if (result === UNKNOWN_METHOD) return rpcError(replyId, -32601, `Method not found: ${method}`);
    return { jsonrpc: '2.0', id: replyId, result };
  } catch (err) {
    if (notification) return null;
    if (err instanceof RpcError) return rpcError(replyId, err.code, err.message);
    return rpcError(replyId, -32603, `Internal error: ${(err as Error).message}`);
  }
}

/** Handle one parsed message (or a batch). Returns what to send back, or null for nothing. */
export async function handleMessage(msg: unknown, cwd = process.cwd()): Promise<object | null> {
  if (Array.isArray(msg)) {
    if (!msg.length) return rpcError(null, -32600, 'Invalid Request');
    const replies = (await Promise.all(msg.map((m) => handleOne(m, cwd)))).filter((r) => r !== null);
    return replies.length ? replies : null;
  }
  return handleOne(msg, cwd);
}

/** Serve MCP on stdin/stdout until stdin closes. */
export function runMcpServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  cwd = process.cwd(),
): Promise<void> {
  const send = (msg: object) => output.write(`${JSON.stringify(msg)}\n`);
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, 'Parse error'));
      return;
    }
    const job = handleMessage(msg, cwd).then((reply) => {
      if (reply) send(reply);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return new Promise((done) => {
    lines.on('close', () => {
      void Promise.allSettled([...pending]).then(() => done());
    });
  });
}
