import { posix } from 'node:path';
import type { ProjectContext, SourceFile } from './project.js';

/** One exported HTTP handler of a route file, e.g. `export async function POST(...)`. */
export interface RouteHandler {
  file: SourceFile;
  method: string;
  /** URL path derived from the file location ("/api/chat"), or null when it can't be derived. */
  urlPath: string | null;
  /** Source text from the `export` keyword to the closing brace of the handler body. */
  text: string;
  /** Text before the body: where wrappers such as `withAuth(` live. */
  head: string;
  /** 1-based line of the `export` keyword. */
  line: number;
  /** Code of local modules this handler can reach through imports (bounded depth). */
  reached: SourceFile[];
  /** The rest of the file outside every handler (module-level limiters, auth helpers). */
  shared: string;
  /** True when an import could not be resolved to a project file, so absence of evidence is weak. */
  hasUnresolved: boolean;
}

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const HANDLER_RE = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b|export\\s+const\\s+(${METHODS})\\b|export\\s+default\\s+(?:async\\s+)?function\\b`,
  'g',
);
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '/index.ts', '/index.tsx', '/index.js'];
const MAX_DEPTH = 2;

// ---------- small scanners (strings are skipped, comments are already blanked) ----------

function skipString(code: string, i: number): number {
  const q = code[i]!;
  let j = i + 1;
  while (j < code.length) {
    if (code[j] === '\\') j += 2;
    else if (code[j] === q) return j + 1;
    else j++;
  }
  return code.length;
}

/** Index of the bracket that closes the one at `open`, or -1. Works for () and {}. */
export function matchBracket(code: string, open: number): number {
  const o = code[open]!;
  const c = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i) - 1;
    } else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `{` that opens the handler body, starting the search at `from`. */
function bodyOpen(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i) - 1;
    } else if (code.startsWith('function', i) && /\W/.test(code[i + 8] ?? ' ')) {
      // function (...) [: Type] {   -> skip the parameter list, then take the next "{"
      const paren = code.indexOf('(', i);
      const close = paren === -1 ? -1 : matchBracket(code, paren);
      return close === -1 ? -1 : code.indexOf('{', close);
    } else if (ch === '=' && code[i + 1] === '>') {
      const rest = /^\s*\{/.exec(code.slice(i + 2));
      return rest ? i + 2 + rest[0].length - 1 : -1; // expression-bodied arrow: no block to scan
    }
  }
  return -1;
}

// ---------- URL path from the file location ----------

export function urlPathOf(file: string): string | null {
  let m = /(?:^|\/)app\/(.*)\/route\.[a-z]+$/i.exec(file);
  if (!m) m = /(?:^|\/)pages\/(api\/.*?)(?:\/index)?\.[a-z]+$/i.exec(file);
  if (!m) return null;
  const parts = m[1]!
    .split('/')
    .filter((s) => !/^\(.*\)$/.test(s)) // route groups
    .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]\]?$/, ':$1*').replace(/^\[(\w+)\]$/, ':$1'));
  return `/${parts.join('/')}`;
}

// ---------- imports ----------

interface ImportRef {
  spec: string;
  names: string[];
}

function importsOf(code: string): ImportRef[] {
  const out: ImportRef[] = [];
  const re =
    /import\s+(?!type\b)([^'"]*?)\s*from\s*["']([^"']+)["']|(?:const|let|var)\s+([\w${},\s:]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const clause = m[1] ?? m[3] ?? '';
    const spec = m[2] ?? m[4] ?? '';
    const names = [...clause.matchAll(/(?:\bas\s+)?([A-Za-z_$][\w$]*)/g)]
      .map((x) => x[1]!)
      .filter((n) => n !== 'as' && n !== 'type');
    out.push({ spec, names });
  }
  return out;
}

/** Resolve a local import ("./x", "../lib/ai", "@/lib/ai", "~/lib/ai") to a project file. */
export function resolveImport(ctx: ProjectContext, from: SourceFile, spec: string): SourceFile | null {
  const bases: string[] = [];
  if (spec.startsWith('.')) bases.push(posix.join(posix.dirname(from.path), spec));
  else if (spec.startsWith('@/') || spec.startsWith('~/')) bases.push(`src/${spec.slice(2)}`, spec.slice(2));
  else return null;
  for (const base of bases) {
    for (const ext of EXTENSIONS) {
      const f = ctx.file(posix.normalize(base) + ext);
      if (f) return f;
    }
  }
  return null;
}

/** Local modules reachable from `text` (a handler body) through imports of `from`, up to MAX_DEPTH hops. */
function reach(ctx: ProjectContext, from: SourceFile, text: string): { files: SourceFile[]; unresolved: boolean } {
  const seen = new Set<string>([from.path]);
  const files: SourceFile[] = [];
  let unresolved = false;
  const visit = (file: SourceFile, used: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const imp of importsOf(ctx.codeOf(file))) {
      const isLocal = imp.spec.startsWith('.') || imp.spec.startsWith('@/') || imp.spec.startsWith('~/');
      if (!isLocal) continue;
      if (!imp.names.some((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\b`).test(used))) continue;
      const target = resolveImport(ctx, file, imp.spec);
      if (!target) {
        unresolved = true;
        continue;
      }
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      files.push(target);
      visit(target, ctx.codeOf(target), depth + 1); // barrel files and helpers: follow what the module itself imports
    }
  };
  visit(from, text, 1);
  return { files, unresolved };
}

// ---------- handlers ----------

/** Per-handler view of a file, for Next.js-style route files. Empty for files with no exported handlers. */
export function handlersOf(ctx: ProjectContext, file: SourceFile): RouteHandler[] {
  const code = ctx.codeOf(file);
  const urlPath = urlPathOf(file.path);
  const out: RouteHandler[] = [];
  const spans: [number, number][] = [];
  HANDLER_RE.lastIndex = 0;
  for (let m = HANDLER_RE.exec(code); m; m = HANDLER_RE.exec(code)) {
    const after = m.index + m[0].length;
    let open: number;
    if (/\bfunction\b/.test(m[0])) {
      // "export async function POST(req, { params }: { params: P }) {": skip the parameter list first
      const paren = code.indexOf('(', after);
      const end = paren === -1 ? -1 : matchBracket(code, paren);
      open = end === -1 ? -1 : code.indexOf('{', end);
    } else {
      open = bodyOpen(code, after);
    }
    if (open === -1) continue;
    const close = matchBracket(code, open);
    if (close === -1) continue;
    const text = code.slice(m.index, close + 1);
    const { files, unresolved } = reach(ctx, file, text);
    out.push({
      file,
      method: m[1] ?? m[2] ?? 'DEFAULT',
      urlPath,
      text,
      head: code.slice(m.index, open),
      line: ctx.lineOf(file, m.index),
      shared: '',
      reached: files,
      hasUnresolved: unresolved,
    });
    spans.push([m.index, close + 1]);
  }
  if (out.length) {
    const chars = code.split('');
    for (const [a, b] of spans) {
      for (let i = a; i < b; i++) if (chars[i] !== '\n') chars[i] = ' ';
    }
    const shared = chars.join('');
    for (const h of out) h.shared = shared;
  }
  return out;
}

// ---------- evidence ----------

/** Something that actually turns a request away. */
const REJECTS = /\b401\b|\b403\b|unauthori[sz]ed|\bforbidden\b|redirect\s*\(|\bthrow\b|notFound\s*\(|\.protect\s*\(/i;
/** Wrappers that put a check around a whole handler. */
const AUTH_WRAPPER = /\b(?:with[A-Z]\w*Auth\w*|withAuth\w*|requireAuth\w*|authenticated\w*|auth)\s*\(/;

export interface HandlerEvidence {
  /** Handler text plus the text of the modules it reaches: used to decide whether it makes a paid call. */
  calls: string;
  /** `calls` plus the module-level code of the same file: used to look for auth and rate limiting. */
  scope: string;
  wrapped: boolean;
}

export function evidenceOf(ctx: ProjectContext, h: RouteHandler): HandlerEvidence {
  const calls = [h.text, ...h.reached.map((f) => ctx.codeOf(f))].join('\n');
  return { calls, scope: `${calls}\n${h.shared}`, wrapped: AUTH_WRAPPER.test(h.head) };
}

export function authIsUsed(authRe: RegExp, ev: HandlerEvidence): boolean {
  if (ev.wrapped) return true;
  return authRe.test(ev.scope) && REJECTS.test(ev.scope);
}

// ---------- middleware matcher against a concrete URL path ----------

/** Turn one Next.js matcher string into a RegExp, or null if we can't understand it. */
export function matcherToRegExp(entry: string): RegExp | null {
  try {
    const src = entry
      .replace(/:(\w+)\*/g, '.*')
      .replace(/:(\w+)\+/g, '.+')
      .replace(/:(\w+)\?/g, '[^/]*')
      .replace(/:(\w+)/g, '[^/]+');
    return new RegExp(`^${src}$`);
  } catch {
    return null;
  }
}

/** Does any matcher entry cover this URL path? `undefined` means "could not tell". */
export function matcherCovers(entries: string[] | null, urlPath: string | null): boolean | undefined {
  if (entries === null) return true; // no matcher: middleware runs on every route
  if (urlPath === null) return undefined;
  let unknown = false;
  for (const e of entries) {
    const re = matcherToRegExp(e);
    if (!re) unknown = true;
    else if (re.test(urlPath)) return true;
  }
  return unknown ? undefined : false;
}
