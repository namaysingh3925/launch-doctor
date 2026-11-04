import { emptyOutput, notApplicable } from './checks/common.js';
import { matchKeys } from './checks/secrets.js';
import { overall, scoreCategory, toGrade } from './grade.js';
import type { CategoryResult, CheckOutput, Finding, Report } from './types.js';
import { decodeJwtPayload, mask, plural } from './util.js';
import { version } from './version.js';

/** Ids of every finding a live scan can produce (for docs and tests). */
export const LIVE_IDS = [
  'live-unreachable-https',
  'live-no-https',
  'live-http-no-redirect',
  'live-exposed-env',
  'live-exposed-git',
  'live-exposed-backup',
  'live-source-maps',
  'live-secret-in-bundle',
  'live-supabase-service-role',
  'live-supabase-open-table',
  'live-missing-hsts',
  'live-missing-csp',
  'live-missing-basic-headers',
] as const;

export interface LiveOptions {
  /** Per-request timeout in milliseconds (default 10,000). */
  timeoutMs?: number;
  /** Largest response body we read, in bytes (default 3 MB). */
  maxBytes?: number;
  /** Don't send the anonymous-key requests to Supabase (default false). */
  skipDatabase?: boolean;
  /** Replacement for fetch (used by tests to fake a Supabase project). */
  fetch?: typeof fetch;
}

interface Reply {
  url: string;
  status: number;
  headers: Headers;
  body: string;
}

const MAX_SCRIPTS = 20;
const MAX_TABLES = 25;
const USER_AGENT = `launch-doctor/${version()} (+https://github.com/namaysingh3925/launch-doctor)`;

/** "myapp.com" or "https://myapp.com/x" -> a URL object. Throws a friendly error for anything else. */
export function parseTarget(input: string): URL {
  const text = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" doesn't look like a web address (example: https://myapp.com)`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Only http:// and https:// addresses can be scanned, not ${url.protocol}`);
  }
  url.hash = '';
  return url;
}

function isLocal(url: URL): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(url.hostname);
}

class Fetcher {
  requests = 0;
  constructor(private opts: Required<Pick<LiveOptions, 'timeoutMs' | 'maxBytes'>> & { fetch: typeof fetch }) {}

  /** One GET. Returns null when the site can't be reached. Never throws. */
  async get(url: string, init: { headers?: Record<string, string>; follow?: boolean } = {}): Promise<Reply | null> {
    this.requests++;
    try {
      const res = await this.opts.fetch(url, {
        method: 'GET',
        redirect: init.follow === false ? 'manual' : 'follow',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...init.headers },
      });
      return {
        url: res.url || url,
        status: res.status,
        headers: res.headers,
        body: await readCapped(res, this.opts.maxBytes),
      };
    } catch {
      return null;
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isHtml = (r: Reply) => /html/i.test(r.headers.get('content-type') ?? '') || /^\s*<(!doctype|html)/i.test(r.body);

function finding(f: Omit<Finding, 'fixPrompt'> & { fixPrompt: string }): Finding {
  return f;
}

// ---------------------------------------------------------------------------
// Category 1: security headers and HTTPS
// ---------------------------------------------------------------------------

async function headersCheck(fetcher: Fetcher, target: URL, home: Reply): Promise<CheckOutput> {
  const out = emptyOutput();
  const local = isLocal(target);
  const finalUrl = new URL(home.url);
  const secure = finalUrl.protocol === 'https:';

  if (!secure && !local) {
    out.findings.push(
      finding({
        id: 'live-no-https',
        severity: 'critical',
        title: 'Your site is served over plain http, not https',
        why: 'Anything visitors type (passwords, emails, card details) travels in the open and can be read or changed by anyone on the same network. Browsers also show a "Not secure" warning.',
        location: { file: finalUrl.origin },
        fixPrompt:
          `My site ${finalUrl.origin} is served over http without HTTPS. Please help me turn on HTTPS: ` +
          `explain how to get a free certificate on my hosting provider (Vercel, Netlify, Render, Cloudflare, Fly.io...), ` +
          `make the site redirect every http:// request to https://, and tell me how to test it.`,
      }),
    );
  } else if (secure) {
    out.passed.push('The site is served over HTTPS');
    // Does plain http redirect to https?
    const plain = new URL(finalUrl.href);
    plain.protocol = 'http:';
    const res = await fetcher.get(plain.href, { follow: false });
    if (res) {
      const location = res.headers.get('location') ?? '';
      const redirects = res.status >= 300 && res.status < 400 && /^https:/i.test(new URL(location, plain).href);
      if (redirects) out.passed.push('http:// visitors are redirected to https://');
      else if (res.status < 400) {
        out.findings.push(
          finding({
            id: 'live-http-no-redirect',
            severity: 'warning',
            title: 'The http:// version of your site does not redirect to https://',
            why: 'Anyone who types your address without "https://" (or follows an old link) uses the unprotected version, where their traffic can be read or changed.',
            location: { file: plain.origin },
            fixPrompt:
              `${plain.origin} answers over plain http instead of redirecting to ${finalUrl.origin}. ` +
              `Please configure my hosting so every http:// request gets a permanent (301/308) redirect to https://, ` +
              `and tell me how to check it with: curl -I ${plain.origin}`,
          }),
        );
      }
    }
  }

  const h = home.headers;
  if (secure && !local) {
    if (h.get('strict-transport-security')) out.passed.push('HSTS header is set');
    else {
      out.findings.push(
        finding({
          id: 'live-missing-hsts',
          severity: 'warning',
          title: 'No Strict-Transport-Security (HSTS) header',
          why: 'Without it, a browser that has visited you before can still be tricked into using the insecure http:// version, for example on public Wi-Fi.',
          location: { file: finalUrl.origin },
          fixPrompt:
            `My site ${finalUrl.origin} does not send a Strict-Transport-Security header. ` +
            `Please add "Strict-Transport-Security: max-age=63072000; includeSubDomains" to all responses using my framework's or host's header configuration ` +
            `(for example the headers() option in next.config, vercel.json, netlify.toml or _headers), then tell me how to verify it with curl -I.`,
        }),
      );
    }
  }

  const csp = h.get('content-security-policy');
  if (csp) out.passed.push('Content-Security-Policy header is set');
  else {
    out.findings.push(
      finding({
        id: 'live-missing-csp',
        severity: 'warning',
        title: 'No Content-Security-Policy header',
        why: "A CSP tells the browser which scripts may run on your pages. Without one, a single injected script (from a comment box, a bad dependency or an ad) can steal your visitors' sessions.",
        location: { file: finalUrl.origin },
        fixPrompt:
          `My site ${finalUrl.origin} sends no Content-Security-Policy header. Please add one that fits my app: ` +
          `start in report-only mode ("Content-Security-Policy-Report-Only"), list the exact script, style, image and connect sources my pages use ` +
          `(my own domain, Stripe, analytics, Supabase and so on), avoid 'unsafe-eval', then switch to enforcing once nothing breaks. Explain each directive in plain English.`,
      }),
    );
  }

  const missing: string[] = [];
  if (!/nosniff/i.test(h.get('x-content-type-options') ?? '')) missing.push('X-Content-Type-Options: nosniff');
  if (!h.get('x-frame-options') && !/frame-ancestors/i.test(csp ?? ''))
    missing.push('X-Frame-Options: DENY (or a CSP frame-ancestors rule)');
  if (!h.get('referrer-policy')) missing.push('Referrer-Policy: strict-origin-when-cross-origin');
  if (missing.length) {
    out.findings.push(
      finding({
        id: 'live-missing-basic-headers',
        severity: 'warning',
        title: `Missing basic security headers (${missing.length})`,
        why: 'These headers stop other sites from putting yours inside a hidden frame (clickjacking), stop browsers from guessing file types, and stop your private URLs from leaking to other sites in the Referer header.',
        location: { file: finalUrl.origin },
        fixPrompt:
          `My site ${finalUrl.origin} is missing these response headers:\n${missing.map((m) => `- ${m}`).join('\n')}\n` +
          `Please add them to every response using my framework's or host's header configuration (next.config headers(), vercel.json, netlify.toml, _headers or my server middleware), ` +
          `and tell me how to check them with curl -I.`,
      }),
    );
  } else out.passed.push('Basic security headers are set (nosniff, frame protection, referrer policy)');

  return out;
}

// ---------------------------------------------------------------------------
// Category 2: exposed files, source maps and keys in the JavaScript
// ---------------------------------------------------------------------------

interface Probe {
  path: string;
  id: 'live-exposed-env' | 'live-exposed-git' | 'live-exposed-backup';
  what: string;
  /** True only when the body really is that file (single-page apps answer 200 for every path). */
  valid: (body: string) => boolean;
}

const PROBES: Probe[] = [
  { path: '/.env', id: 'live-exposed-env', what: 'your .env file', valid: looksLikeEnv },
  { path: '/.env.local', id: 'live-exposed-env', what: 'your .env.local file', valid: looksLikeEnv },
  { path: '/.env.production', id: 'live-exposed-env', what: 'your .env.production file', valid: looksLikeEnv },
  {
    path: '/.git/config',
    id: 'live-exposed-git',
    what: 'your git settings (.git/config)',
    valid: (b) => /^\s*\[core\]/m.test(b),
  },
  {
    path: '/.git/HEAD',
    id: 'live-exposed-git',
    what: 'your git folder (.git/HEAD)',
    valid: (b) => /^ref:\s*refs\//.test(b.trim()),
  },
  { path: '/backup.sql', id: 'live-exposed-backup', what: 'a database backup (backup.sql)', valid: looksLikeSql },
  { path: '/dump.sql', id: 'live-exposed-backup', what: 'a database backup (dump.sql)', valid: looksLikeSql },
  { path: '/database.sql', id: 'live-exposed-backup', what: 'a database backup (database.sql)', valid: looksLikeSql },
];

function looksLikeEnv(body: string): boolean {
  if (/^\s*<(!doctype|html)/i.test(body)) return false;
  const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const assignments = lines.filter((l) => /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(l.trim()));
  return assignments.length >= 1 && assignments.length >= lines.length / 2;
}

function looksLikeSql(body: string): boolean {
  return !/^\s*<(!doctype|html)/i.test(body) && /\b(CREATE TABLE|INSERT INTO|COPY\s+\w+.*FROM stdin)\b/i.test(body);
}

interface Page {
  html: string;
  scripts: { url: string; body: string }[];
  /** Text of the page plus all its scripts, for searching. */
  text: string;
}

function scriptUrls(html: string, base: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    try {
      urls.add(new URL(m[1]!.replace(/&amp;/g, '&'), base).href);
    } catch {
      // not a usable address
    }
  }
  // Next.js, Vite and others also preload chunks.
  for (const m of html.matchAll(
    /<link\b[^>]*\brel\s*=\s*["'](?:modulepreload|preload)["'][^>]*\bhref\s*=\s*["']([^"']+\.m?js[^"']*)["']/gi,
  )) {
    try {
      urls.add(new URL(m[1]!.replace(/&amp;/g, '&'), base).href);
    } catch {
      // not a usable address
    }
  }
  return [...urls];
}

async function loadPage(fetcher: Fetcher, home: Reply): Promise<Page> {
  const urls = scriptUrls(home.body, home.url).slice(0, MAX_SCRIPTS);
  const replies = await Promise.all(urls.map((u) => fetcher.get(u)));
  const scripts = replies
    .map((r, i) => (r && r.status === 200 && !isHtml(r) ? { url: urls[i]!, body: r.body } : null))
    .filter((s): s is { url: string; body: string } => s !== null);
  return { html: home.body, scripts, text: [home.body, ...scripts.map((s) => s.body)].join('\n') };
}

async function exposureCheck(fetcher: Fetcher, home: Reply, page: Page): Promise<CheckOutput> {
  const out = emptyOutput();
  const origin = new URL(home.url).origin;

  // 1. Files that should never be public
  const found = new Set<string>();
  const replies = await Promise.all(PROBES.map((p) => fetcher.get(`${origin}${p.path}`)));
  PROBES.forEach((p, i) => {
    const r = replies[i];
    if (r?.status !== 200 || isHtml(r) || !p.valid(r.body)) return;
    found.add(p.id);
    const fix =
      p.id === 'live-exposed-env'
        ? 'It contains my secret keys. Treat every key in it as stolen: tell me how to rotate each one (database, Stripe, AI providers, email), then make sure my build and hosting never publish this file (keep .env out of the public/static folder and out of Docker images).'
        : p.id === 'live-exposed-git'
          ? 'Anyone can download my source code and its history, including old secrets. Make my hosting stop serving dotfiles and the .git folder, deploy only the built output, and tell me how to check my git history for keys that need rotating.'
          : 'It contains my data. Remove it from my public folder and my hosting, tell me how to confirm it is gone, and help me decide whether I have to tell the people whose data it holds.';
    out.findings.push(
      finding({
        id: p.id,
        severity: 'critical',
        title: `${capitalize(p.what)} can be downloaded by anyone`,
        why:
          p.id === 'live-exposed-env'
            ? 'Anyone who types this address into a browser gets your secret keys: database passwords, payment keys, AI keys. Bots scan for this constantly.'
            : p.id === 'live-exposed-git'
              ? 'Your whole project, including its history and any old passwords, can be rebuilt from this folder. Bots scan for it constantly.'
              : 'A copy of your data is downloadable by anyone who guesses this address.',
        location: { file: `${origin}${p.path}` },
        fixPrompt: `${origin}${p.path} returns ${p.what} to anyone on the internet. ${fix}`,
      }),
    );
  });
  if (!found.size) out.passed.push('No .env, .git folder or database backup is downloadable');

  // 2. Source maps
  const mapped: string[] = [];
  await Promise.all(
    page.scripts
      .filter((s) => s.url.split('?')[0]!.endsWith('.js') || /\.m?js(\?|$)/.test(s.url))
      .slice(0, 8)
      .map(async (s) => {
        const ref = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/.exec(s.body.slice(-2000));
        const mapUrl =
          ref && !ref[1]!.startsWith('data:') ? new URL(ref[1]!, s.url).href : `${s.url.split('?')[0]}.map`;
        const r = await fetcher.get(mapUrl);
        if (r?.status !== 200 || isHtml(r)) return;
        try {
          const map = JSON.parse(r.body) as { sources?: unknown; sourcesContent?: unknown };
          if (Array.isArray(map.sources) && Array.isArray(map.sourcesContent)) mapped.push(mapUrl);
        } catch {
          // not a source map
        }
      }),
  );
  if (mapped.length) {
    out.findings.push(
      finding({
        id: 'live-source-maps',
        severity: 'warning',
        title: `Your original source code is public (${plural(mapped.length, 'source map')})`,
        why: 'Source maps let anyone read your real, un-minified code with comments, file names and logic. That makes it much easier for others to find weak spots or copy your work.',
        location: { file: mapped[0]! },
        fixPrompt:
          `My site publishes JavaScript source maps (for example ${mapped[0]}) that contain my full source code. ` +
          `Please turn off public source maps in my production build (Next.js: productionBrowserSourceMaps: false; Vite: build.sourcemap: false; ` +
          `or upload them privately to my error tracker instead), redeploy, and tell me how to confirm the .map files now return 404.`,
      }),
    );
  } else if (page.scripts.length) out.passed.push('JavaScript source maps are not public');

  // 3. Keys inside the JavaScript every visitor downloads
  const seen = new Set<string>();
  for (const s of [{ url: origin, body: home.body }, ...page.scripts]) {
    for (const m of matchKeys(s.body)) {
      const key = `${m.pattern.id}|${m.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 10) break;
      const shown = m.pattern.id === 'private-key' ? '-----BEGIN … PRIVATE KEY-----' : mask(m.value);
      out.findings.push(
        finding({
          id: 'live-secret-in-bundle',
          severity: 'critical',
          title: `${capitalize(m.pattern.name)} is visible in your live website`,
          why: `The key (${shown}) is inside a file every visitor downloads (${s.url}). Anyone can copy it and use your account.`,
          location: { file: s.url },
          fixPrompt:
            `My live site ships a ${m.pattern.name} (it starts with "${shown}") inside ${s.url}. Please:\n` +
            `1. Find where my code reads it and move that code to the server (an API route, server action or edge function), reading ${m.pattern.envName} from environment variables there.\n` +
            `2. Make sure no NEXT_PUBLIC_/VITE_ variable holds it.\n` +
            `3. Redeploy and confirm the key no longer appears in the built JavaScript.\n` +
            `Then tell me how to revoke this key and create a new one (${m.pattern.rotate}), because it is already public.`,
        }),
      );
    }
  }
  if (!seen.size && page.scripts.length) out.passed.push('No API keys found in your live JavaScript');

  return out;
}

// ---------------------------------------------------------------------------
// Category 3: Supabase tables that anyone can read
// ---------------------------------------------------------------------------

const SUPABASE_URL_RE = /https:\/\/([a-z0-9]{15,30})\.supabase\.co/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PUBLISHABLE_RE = /\bsb_publishable_[A-Za-z0-9_-]{20,}/g;
const FROM_RE = /\.from\(\s*["'`]([a-z_][a-z0-9_]{0,62})["'`]\s*\)/gi;

async function databaseCheck(fetcher: Fetcher, page: Page, opts: LiveOptions): Promise<CheckOutput> {
  const projects = [...new Set([...page.text.matchAll(SUPABASE_URL_RE)].map((m) => m[1]!))];
  if (!projects.length) return notApplicable('No Supabase project found in the page');
  const out = emptyOutput();

  const anonKeys: string[] = [];
  for (const m of page.text.matchAll(JWT_RE)) {
    const role = decodeJwtPayload(m[0])?.role;
    if (role === 'service_role') {
      out.findings.push(
        finding({
          id: 'live-supabase-service-role',
          severity: 'critical',
          title: 'Your Supabase service_role key is visible in your live website',
          why: 'The service_role key skips every database security rule. Anyone who copies it from your page can read, change and delete all of your data.',
          location: {
            file: new URL(projects.length ? `https://${projects[0]}.supabase.co` : 'https://supabase.co').origin,
          },
          fixPrompt:
            `My live site ships a Supabase service_role key (it starts with "${mask(m[0])}") in its JavaScript. Please remove it from all frontend code: the browser may only use the anon/publishable key. ` +
            `Move any feature that needs admin access into server-only code (API route or Edge Function) that reads SUPABASE_SERVICE_ROLE_KEY from environment variables, redeploy, ` +
            `and tell me how to rotate the JWT secret / service_role key in Supabase, because it is already public.`,
        }),
      );
    } else if (role === 'anon' && !anonKeys.includes(m[0])) anonKeys.push(m[0]);
  }
  for (const m of page.text.matchAll(PUBLISHABLE_RE)) if (!anonKeys.includes(m[0])) anonKeys.push(m[0]);

  if (opts.skipDatabase) {
    out.passed.push('Database check skipped (--no-db)');
    return out;
  }
  const key = anonKeys[0];
  if (!key) {
    if (!out.findings.length) out.passed.push('A Supabase project was found, but no public key to test with');
    return out;
  }

  for (const project of projects.slice(0, 2)) {
    const base = `https://${project}.supabase.co/rest/v1`;
    const headers = { apikey: key, authorization: `Bearer ${key}` };
    // Table names: from the API's own listing when it is allowed, plus .from('x') calls in the code.
    const tables = new Set<string>();
    const spec = await fetcher.get(`${base}/`, { headers });
    if (spec && spec.status === 200) {
      try {
        const paths = Object.keys((JSON.parse(spec.body) as { paths?: Record<string, unknown> }).paths ?? {});
        for (const p of paths) if (/^\/[a-z_][a-z0-9_]*$/i.test(p)) tables.add(p.slice(1));
      } catch {
        // not JSON
      }
    }
    for (const m of page.text.matchAll(FROM_RE)) tables.add(m[1]!);

    const open: string[] = [];
    await Promise.all(
      [...tables].slice(0, MAX_TABLES).map(async (t) => {
        // limit=1: we only need to know whether any row comes back. Row contents are never kept or shown.
        const r = await fetcher.get(`${base}/${encodeURIComponent(t)}?select=*&limit=1`, { headers });
        if (r?.status !== 200) return;
        try {
          const rows = JSON.parse(r.body) as unknown;
          if (Array.isArray(rows) && rows.length > 0) open.push(t);
        } catch {
          // not JSON
        }
      }),
    );
    if (open.length) {
      open.sort();
      out.findings.push(
        finding({
          id: 'live-supabase-open-table',
          severity: 'critical',
          title: `Anyone can read your Supabase ${open.length === 1 ? 'table' : 'tables'}: ${open.join(', ')}`,
          why: 'Using only the public key found in your website, we received real rows back. Without Row Level Security, any visitor (or bot) can download every row, and possibly change or delete them too.',
          location: { file: `${base}/${open[0]}` },
          fixPrompt:
            `My Supabase project ${project} lets anyone read these tables with just the public anon key: ${open.join(', ')}. Please:\n` +
            `1. Write the SQL to enable Row Level Security on each one ("alter table <name> enable row level security;").\n` +
            `2. Add policies so signed-in users can only see and change their own rows (using auth.uid()), and keep tables that must be public read-only.\n` +
            `3. Check storage buckets and database functions for the same problem.\n` +
            `4. Tell me how to test it by running the same query with the anon key and confirming it returns nothing.\n` +
            `Also tell me whether I should assume the data has been copied already.`,
        }),
      );
    } else {
      out.passed.push(
        tables.size
          ? `Supabase: no rows came back from ${plural(Math.min(tables.size, MAX_TABLES), 'table')} using only the public key`
          : 'Supabase: no table names could be found to test',
      );
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------

export async function runLiveScan(input: string, options: LiveOptions = {}): Promise<Report> {
  const target = parseTarget(input);
  const fetcher = new Fetcher({
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 3_000_000,
    fetch: options.fetch ?? fetch,
  });

  const home = await fetcher.get(target.href);
  if (!home) {
    throw new Error(`Couldn't reach ${target.origin}. Check the address and that the site is online.`);
  }
  if (home.status >= 500) throw new Error(`${target.origin} answered with an error (${home.status}). Try again later.`);

  const page = await loadPage(fetcher, home);

  const defs: { id: string; name: string; weight: number; out: Promise<CheckOutput> }[] = [
    { id: 'live-exposure', name: 'Exposed files & keys', weight: 3, out: exposureCheck(fetcher, home, page) },
    { id: 'live-database', name: 'Open database', weight: 3, out: databaseCheck(fetcher, page, options) },
    { id: 'live-headers', name: 'HTTPS & headers', weight: 1, out: headersCheck(fetcher, target, home) },
  ];

  const categories: CategoryResult[] = [];
  for (const d of defs) {
    let out: CheckOutput;
    try {
      out = await d.out;
    } catch (err) {
      out = notApplicable(`This check crashed: ${(err as Error).message}`);
    }
    const score = out.applicable ? scoreCategory(out) : null;
    categories.push({
      ...out,
      id: d.id,
      name: d.name,
      weight: d.weight,
      score,
      grade: score === null ? null : toGrade(score),
    });
  }

  return {
    tool: 'launch-doctor',
    version: version(),
    mode: 'live',
    root: new URL(home.url).origin,
    projectName: new URL(home.url).host,
    stack: [],
    filesScanned: fetcher.requests,
    truncated: false,
    ignored: 0,
    unknownIgnoreIds: [],
    ...overall(categories),
    categories,
    generatedAt: new Date().toISOString(),
  };
}
