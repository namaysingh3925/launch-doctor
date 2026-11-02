import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Options } from './types.js';

export interface SourceFile {
  /** Path relative to the project root, always with forward slashes. */
  path: string;
  content: string;
}

export interface Match {
  file: SourceFile;
  index: number;
  line: number;
  match: RegExpExecArray;
}

export type FileFilter = (file: SourceFile) => boolean;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  'venv',
  '__pycache__',
  'generated',
  'Pods',
  'bower_components',
]);

const CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.astro', '.html', '.htm',
  '.py', '.rb', '.php', '.go',
]);

const TEXT_EXT = new Set([
  ...CODE_EXT,
  '.json', '.toml', '.yaml', '.yml', '.sql', '.rules', '.prisma', '.md', '.mdx', '.txt', '.xml',
]);

const SPECIAL_NAMES = new Set(['firestore.rules', 'storage.rules', 'database.rules.json', '.gitignore', 'dockerfile', 'procfile']);

const SKIP_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json',
  'launch_fixes.md',
]);

const MAX_FILES = 20_000;
const MAX_FILE_SIZE = 1_000_000;

export function isCodeFile(file: SourceFile | string): boolean {
  const p = typeof file === 'string' ? file : file.path;
  return CODE_EXT.has(extname(p).toLowerCase());
}

export function isEnvPath(p: string): boolean {
  const name = basename(p).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

export function isExampleEnvPath(p: string): boolean {
  return isEnvPath(p) && /(example|sample|template|defaults|dist|schema|tpl)$/i.test(basename(p));
}

export function isRealEnvPath(p: string): boolean {
  return isEnvPath(p) && !isExampleEnvPath(p);
}

export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|spec|e2e|cypress|fixtures|mocks?|__mocks__|stories)\//i.test(p) ||
    /\.(test|spec|stories)\.[a-z]+$/i.test(p)
  );
}

function shouldRead(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_FILES.has(lower)) return false;
  if (isEnvPath(lower) || SPECIAL_NAMES.has(lower)) return true;
  if (lower.endsWith('.min.js') || lower.endsWith('.map')) return false;
  return TEXT_EXT.has(extname(lower));
}

/** Turn an import specifier into a package name ("@scope/pkg/sub@1" -> "@scope/pkg"). */
export function packageNameOf(spec: string): string | null {
  let s = spec
    .replace(/^npm:/, '')
    .replace(/^jsr:/, '')
    .replace(/^https?:\/\/(?:esm\.sh|cdn\.skypack\.dev|cdn\.jsdelivr\.net\/npm|unpkg\.com)\//, '')
    .replace(/[?#].*$/, '');
  if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('node:') || /^[a-z]+:/i.test(s)) return null;
  const parts = s.split('/');
  s = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  s = s.replace(/(?<=.)@.*$/, '');
  return s || null;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'\n]+)["']/gm;
const PY_IMPORT_RE = /^[ \t]*(?:from|import)[ \t]+([A-Za-z_][\w.]*)/gm;

/** Python package/module names mapped to the npm names the checks look for. */
const PY_ALIASES: Record<string, string> = {
  supabase: '@supabase/supabase-js',
  stripe: 'stripe',
  openai: 'openai',
  anthropic: '@anthropic-ai/sdk',
  razorpay: 'razorpay',
  sentry_sdk: '@sentry/python',
  'sentry-sdk': '@sentry/python',
  resend: 'resend',
  twilio: 'twilio',
  firebase_admin: 'firebase-admin',
  'firebase-admin': 'firebase-admin',
  pymongo: 'mongodb',
  motor: 'mongodb',
  psycopg2: 'pg',
  'psycopg2-binary': 'pg',
  psycopg: 'pg',
  asyncpg: 'pg',
  sqlalchemy: 'sqlalchemy',
  sqlite3: 'sqlite3',
  'google.generativeai': '@google/generative-ai',
  'google-generativeai': '@google/generative-ai',
  'google.genai': '@google/genai',
  'google-genai': '@google/genai',
  groq: 'groq-sdk',
  mistralai: '@mistralai/mistralai',
  replicate: 'replicate',
  sendgrid: '@sendgrid/mail',
  posthog: 'posthog-node',
  langchain: 'langchain',
  flask_limiter: 'limiter',
  'flask-limiter': 'limiter',
  slowapi: 'limiter',
  'django-ratelimit': 'limiter',
};

function pythonDep(name: string): string | null {
  const lower = name.toLowerCase();
  return PY_ALIASES[lower] ?? PY_ALIASES[lower.split('.').slice(0, 2).join('.')] ?? PY_ALIASES[lower.split('.')[0]!] ?? null;
}

export class ProjectContext {
  readonly root: string;
  readonly name: string;
  readonly options: Options;
  /** Every file path we saw, including images and other binaries. */
  readonly paths: string[] = [];
  /** Text files we read. */
  readonly files: SourceFile[] = [];
  truncated = false;
  readonly deps = new Set<string>();
  readonly imports = new Set<string>();
  readonly scripts: string[] = [];
  readonly gitRoot: string | null;
  readonly isSpa: boolean;
  /** Finding / checklist ids silenced in .launchdoctorignore. */
  readonly ignoredIds = new Set<string>();
  private ignoredPathRules = '';
  private readonly tracked: Set<string> | null;
  private readonly byPath = new Map<string, SourceFile>();
  private readonly clientCache = new Map<string, boolean>();
  private readonly lineStarts = new Map<string, number[]>();

  private readonly maxFiles: number;

  constructor(root: string, options: Options = {}) {
    this.root = resolve(root);
    this.options = options;
    this.maxFiles = options.maxFiles ?? MAX_FILES;
    this.readIgnoreFile();
    this.walk();
    this.readPackages();
    this.collectImports();

    let name = basename(this.root);
    const rootPkg = this.byPath.get('package.json');
    if (rootPkg) {
      try {
        const pkgName = JSON.parse(rootPkg.content).name;
        if (typeof pkgName === 'string' && pkgName) name = pkgName;
      } catch {
        // ignore broken package.json
      }
    }
    this.name = name;

    this.gitRoot = options.useGit === false ? null : findGitRoot(this.root);
    this.tracked = this.gitRoot ? gitLsFiles(this.root) : null;

    const fullStack = [
      'next', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/node', '@remix-run/react',
      '@react-router/node', '@react-router/serve', '@tanstack/react-start', '@tanstack/start', 'vike',
    ];
    this.isSpa = (this.uses('vite') || this.uses('react-scripts')) && !fullStack.some((p) => this.uses(p));
  }

  // ---------- reading the project ----------

  /**
   * .launchdoctorignore: one entry per line.
   *   no-error-tracking   -> a plain id silences that finding or checklist item
   *   legacy/             -> anything with "/", "*" or "." is a path pattern to skip
   *   scripts             -> a bare word that names an existing file or folder is a path too
   */
  private readIgnoreFile(): void {
    let text: string;
    try {
      text = readFileSync(join(this.root, '.launchdoctorignore'), 'utf8');
    } catch {
      return;
    }
    const pathRules: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      // A bare word is a finding id, unless a file or folder with that name exists (then it's a path).
      if (/^[a-z0-9-]+$/.test(line) && !existsSync(join(this.root, line))) this.ignoredIds.add(line);
      else pathRules.push(line);
    }
    this.ignoredPathRules = pathRules.join('\n');
  }

  private isIgnoredPath(relPath: string): boolean {
    return this.ignoredPathRules !== '' && matchesGitignore(this.ignoredPathRules, relPath);
  }

  private walk(): void {
    const stack: string[] = [''];
    scan: while (stack.length) {
      const rel = stack.pop()!;
      const abs = rel ? join(this.root, rel) : this.root;
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (this.isIgnoredPath(relPath)) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.github') continue;
          stack.push(relPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (this.paths.length >= this.maxFiles) {
          this.truncated = true;
          break scan; // still sort below
        }
        this.paths.push(relPath);
        if (!shouldRead(entry.name)) continue;
        try {
          const full = join(abs, entry.name);
          if (statSync(full).size > MAX_FILE_SIZE) continue;
          // Strip the byte-order mark some Windows editors add, or JSON.parse fails.
          const file = { path: relPath, content: readFileSync(full, 'utf8').replace(/^﻿/, '') };
          this.files.push(file);
          this.byPath.set(relPath, file);
        } catch {
          // unreadable file, skip
        }
      }
    }
    this.paths.sort();
    this.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private readPackages(): void {
    for (const file of this.files) {
      const name = basename(file.path);
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(file.content);
          for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            for (const dep of Object.keys(pkg[field] ?? {})) this.deps.add(dep);
          }
          for (const script of Object.values(pkg.scripts ?? {})) {
            if (typeof script === 'string') this.scripts.push(script);
          }
        } catch {
          // ignore
        }
      } else if (/^requirements.*\.txt$/i.test(name)) {
        for (const line of file.content.split(/\r?\n/)) {
          const m = /^\s*([A-Za-z0-9_.-]+)/.exec(line);
          const dep = m && !line.trim().startsWith('#') && !line.trim().startsWith('-') ? pythonDep(m[1]!) : null;
          if (dep) this.deps.add(dep);
        }
      } else if (name === 'pyproject.toml') {
        for (const m of file.content.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!;].*?)?["']/g)) {
          const dep = pythonDep(m[1]!);
          if (dep) this.deps.add(dep);
        }
      } else if (name === 'deno.json' || name === 'import_map.json') {
        try {
          const json = JSON.parse(file.content);
          for (const value of Object.values(json.imports ?? {})) {
            const pkg = typeof value === 'string' ? packageNameOf(value) : null;
            if (pkg) this.deps.add(pkg);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private collectImports(): void {
    for (const file of this.files) {
      if (!isCodeFile(file)) continue;
      if (file.path.endsWith('.py')) {
        for (const m of file.content.matchAll(PY_IMPORT_RE)) {
          const dep = pythonDep(m[1]!);
          if (dep) this.imports.add(dep);
        }
        continue;
      }
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(file.content))) {
        const pkg = packageNameOf(m[1]!);
        if (pkg) this.imports.add(pkg);
      }
    }
  }

  // ---------- questions checks can ask ----------

  /** Is this package a dependency or imported anywhere? A name ending in "/" matches a scope prefix. */
  uses(name: string): boolean {
    if (name.endsWith('/')) {
      for (const d of this.deps) if (d.startsWith(name)) return true;
      for (const d of this.imports) if (d.startsWith(name)) return true;
      return false;
    }
    return this.deps.has(name) || this.imports.has(name);
  }

  usesAny(names: string[]): boolean {
    return names.some((n) => this.uses(n));
  }

  /** Is this package actually imported in code (not just listed in package.json)? "/" suffix matches a scope. */
  imported(name: string): boolean {
    if (name.endsWith('/')) {
      for (const d of this.imports) if (d.startsWith(name)) return true;
      return false;
    }
    return this.imports.has(name);
  }

  file(path: string): SourceFile | undefined {
    return this.byPath.get(path);
  }

  hasPath(re: RegExp): boolean {
    return this.paths.some((p) => re.test(p));
  }

  /** Find every regex match across files (optionally filtered). */
  find(re: RegExp, filter?: FileFilter, limit = 500): Match[] {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const g = new RegExp(re.source, flags);
    const out: Match[] = [];
    for (const file of this.files) {
      if (filter && !filter(file)) continue;
      g.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = g.exec(file.content))) {
        out.push({ file, index: m.index, line: this.lineOf(file, m.index), match: m });
        if (out.length >= limit) return out;
        if (m[0].length === 0) g.lastIndex++;
      }
    }
    return out;
  }

  /** 1-based line number of a character index, using cached line starts and a binary search. */
  lineOf(file: SourceFile, index: number): number {
    let starts = this.lineStarts.get(file.path);
    if (!starts) {
      starts = [0];
      const text = file.content;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      this.lineStarts.set(file.path, starts);
    }
    // Largest start <= index.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Best guess: does this file end up in the browser? */
  isClient(file: SourceFile): boolean {
    const cached = this.clientCache.get(file.path);
    if (cached !== undefined) return cached;
    const result = this.computeIsClient(file);
    this.clientCache.set(file.path, result);
    return result;
  }

  private computeIsClient(file: SourceFile): boolean {
    const p = file.path;
    if (!isCodeFile(p) || /\.(py|rb|php|go)$/i.test(p)) return false;
    if (/\.html?$/i.test(p)) return !/(^|\/)(server|api|templates?|emails?)\//i.test(p);
    if (/^\s*["']use client["'];?\s*$/m.test(file.content.slice(0, 400))) return true;
    if (/(^|\/)public\//.test(p)) return true;
    if (this.uses('next') && /(^|\/)pages\//.test(p) && !/(^|\/)pages\/api\//.test(p)) return true;
    if (
      this.isSpa &&
      /(^|\/)src\//.test(p) &&
      !/(^|\/)(server|api|backend|functions|scripts)\//.test(p) &&
      !/(^|\/)(server|api|backend|worker)\.[jt]s$/i.test(p) &&
      !/\.(server|config)\.[a-z]+$/i.test(p) &&
      !looksLikeServerCode(file.content)
    ) {
      return true;
    }
    return false;
  }

  isTracked(path: string): boolean {
    return this.tracked?.has(path) ?? false;
  }

  /** Which of these paths would git ignore? */
  ignoredAmong(paths: string[]): Set<string> {
    if (!paths.length) return new Set();
    if (this.gitRoot) {
      const fromGit = gitCheckIgnore(this.root, paths);
      if (fromGit) return fromGit;
    }
    const gitignore = this.byPath.get('.gitignore')?.content ?? '';
    return new Set(paths.filter((p) => matchesGitignore(gitignore, p)));
  }

  /** Short list of the main tools this project uses, for the report header. */
  stack(): string[] {
    const labels: [string, string][] = [
      ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'],
      ['@remix-run/react', 'Remix'], ['vite', 'Vite'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'],
      ['express', 'Express'], ['hono', 'Hono'], ['fastify', 'Fastify'],
      ['@supabase/supabase-js', 'Supabase'], ['firebase', 'Firebase'], ['@prisma/client', 'Prisma'],
      ['drizzle-orm', 'Drizzle'], ['mongoose', 'MongoDB'], ['convex', 'Convex'],
      ['stripe', 'Stripe'], ['razorpay', 'Razorpay'], ['@clerk/nextjs', 'Clerk'], ['next-auth', 'NextAuth'],
      ['openai', 'OpenAI'], ['@anthropic-ai/sdk', 'Anthropic'], ['ai', 'Vercel AI SDK'],
    ];
    const out: string[] = [];
    for (const [pkg, label] of labels) {
      if (this.uses(pkg) && !out.includes(label)) out.push(label);
      if (out.length >= 7) break;
    }
    if (!out.includes('Prisma') && this.uses('prisma') && out.length < 7) out.push('Prisma');
    return out;
  }
}

/** Code that only makes sense on a server, even if it sits in a frontend folder. */
function looksLikeServerCode(content: string): boolean {
  return (
    /(?:from\s*|require\s*\(\s*)["'](?:node:)?(express|fastify|hono|koa|http|https|fs|child_process|@hono\/node-server)["']/.test(content) ||
    /\.listen\s*\(\s*(?:\d|port|process\.env)/i.test(content)
  );
}

// ---------- git helpers ----------

/**
 * Every git call goes through here. core.fsmonitor=false stops a scanned folder's .git/config
 * from making git run a command of its choosing (fsmonitor can be set to any program).
 */
export function gitArgs(args: string[]): string[] {
  return ['-c', 'core.fsmonitor=false', ...args];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', gitArgs(args), {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function findGitRoot(root: string): string | null {
  const out = git(root, ['rev-parse', '--show-toplevel']);
  if (!out) return null;
  const top = out.trim();
  // A git repo at the home folder is almost always an accident; don't treat it as the project's repo.
  if (samePath(top, homedir())) return null;
  return top;
}

function gitLsFiles(root: string): Set<string> | null {
  const out = git(root, ['ls-files', '-z']);
  if (out === null) return null;
  return new Set(out.split('\0').filter(Boolean));
}

function gitCheckIgnore(root: string, paths: string[]): Set<string> | null {
  try {
    // -z keeps unusual file names (spaces, accents) unquoted in the output.
    const out = execFileSync('git', gitArgs(['check-ignore', '-z', '--', ...paths]), {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return new Set(out.split('\0').filter(Boolean));
  } catch (err) {
    const e = err as { status?: number };
    // Exit code 1 means "none of these are ignored".
    if (e.status === 1) return new Set();
    return null;
  }
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Minimal .gitignore matching, used when git isn't available. */
export function matchesGitignore(gitignore: string, path: string): boolean {
  let ignored = false;
  const name = basename(path);
  for (const raw of gitignore.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    line = line.replace(/\/+$/, '');
    // "**/x" means "x in any folder".
    let anyDepth = false;
    while (line.startsWith('**/')) {
      line = line.slice(3);
      anyDepth = true;
    }
    const anchored = line.startsWith('/') || line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    const re = globToRegex(line);
    const segments = path.split('/');
    let hit: boolean;
    if (!anchored) hit = re.test(name) || segments.some((seg) => re.test(seg));
    else if (anyDepth) hit = segments.some((_, i) => re.test(segments.slice(i).join('/')));
    else hit = re.test(path);
    if (hit) ignored = !negate;
  }
  return ignored;
}
