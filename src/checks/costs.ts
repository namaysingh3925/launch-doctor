import { AUTH_CHECK_RE } from '../detect.js';
import type { SourceFile } from '../project.js';
import type { Check } from '../types.js';
import { lineTextAt, uniqueBy } from '../util.js';
import { appCode, at, clientCode, emptyOutput, isRouteLike, notApplicable, serverCode, where } from './common.js';

const AI_PACKAGES = [
  'openai', '@anthropic-ai/sdk', '@google/generative-ai', '@google/genai', 'ai', '@ai-sdk/', 'groq-sdk',
  '@mistralai/mistralai', 'replicate', 'cohere-ai', 'together-ai', '@huggingface/inference', 'elevenlabs',
  '@elevenlabs/elevenlabs-js', '@fal-ai/client', '@langchain/', 'langchain', '@openrouter/ai-sdk-provider',
];

/** SDKs that need a secret key, so they must never run in the browser. */
const BROWSER_FORBIDDEN_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](?:npm:)?(openai|@anthropic-ai\/sdk|@google\/generative-ai|@google\/genai|groq-sdk|@mistralai\/mistralai|replicate|cohere-ai|together-ai|twilio)(?:[@/][^"']*)?["']/;

const AI_DIRECT_URL =
  /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai\/api|api\.mistral\.ai|api\.deepseek\.com|api\.replicate\.com|api\.elevenlabs\.io|api\.together\.xyz/;

const AI_CALL =
  /\.chat\.completions\.create\s*\(|\.responses\.create\s*\(|\.messages\.(?:create|stream)\s*\(|\b(?:generateText|streamText|generateObject|streamObject)\s*\(|\.generateContent(?:Stream)?\s*\(|\.images\.generate\s*\(|\.audio\.speech\.create\s*\(/;

const RATE_LIMIT_PACKAGES = [
  '@upstash/ratelimit', 'express-rate-limit', 'rate-limiter-flexible', '@arcjet/', '@unkey/ratelimit',
  'hono-rate-limiter', '@nestjs/throttler', 'next-rate-limit', 'limiter', '@fastify/rate-limit', 'koa-ratelimit',
];

const RATE_LIMIT_USAGE =
  /new\s+Ratelimit\s*\(|Ratelimit\.slidingWindow\s*\(|\brateLimit\s*\(\s*\{|new\s+RateLimiter\w*\s*\(|\blimiter\.(?:limit|consume|removeTokens)\s*\(|@limiter\.limit\s*\(|\barcjet\s*\(/;

/** Code in a middleware file that actually turns away signed-out requests. */
const MIDDLEWARE_BLOCKS =
  /\.protect\s*\(|status\s*:\s*401|NextResponse\.redirect\s*\(|\bredirect\s*\([^)]*["'`][^"'`]*\/(?:login|sign-?in)\b/i;

/**
 * The strings in `matcher: "..."` or `matcher: ["...", "..."]`, or null if there is no matcher.
 * Read string by string, because matcher patterns often contain "]" themselves.
 */
function matcherEntries(content: string): string[] | null {
  const start = /matcher\s*:\s*/.exec(content);
  if (!start) return null;
  let i = start.index + start[0].length;
  const inArray = content[i] === '[';
  if (inArray) i++;
  const entries: string[] = [];
  const str = /\s*,?\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/y;
  for (;;) {
    str.lastIndex = i;
    const m = str.exec(content);
    if (!m) break;
    entries.push(m[2]!);
    i = str.lastIndex;
    if (!inArray) break;
  }
  return entries;
}

/**
 * True when a Next.js-style middleware (or proxy) file blocks signed-out users AND runs on /api routes.
 * Middleware that only refreshes the session (e.g. Supabase's updateSession) doesn't count.
 */
export function middlewareBlocksApi(f: SourceFile): boolean {
  if (!/(^|\/)(?:src\/)?(middleware|proxy)\.(t|j)s$/.test(f.path)) return false;
  if (!MIDDLEWARE_BLOCKS.test(f.content)) return false;
  const entries = matcherEntries(f.content);
  if (!entries) return true; // no matcher: runs on every route
  return entries.some((e) => {
    if (/(^|\/)\(?api\b|\(api\||\|api\)/.test(e) && !/\(\?!/.test(e)) return true; // e.g. "/api/:path*" or "/(api|trpc)(.*)"
    const catchAll = /^\/(\(.*\)|:path\*|\.\*)/.test(e) || e === '/(.*)';
    const excludesApi = /\(\?![^)]*\bapi\b/.test(e);
    return catchAll && !excludesApi;
  });
}

export const costsCheck: Check = {
  id: 'costs',
  name: 'AI & API costs',
  icon: '💸',
  weight: 2,
  ids: ['ai-in-browser', 'ai-endpoint-no-auth', 'no-rate-limit', 'spending-limits', 'twilio-geo'],
  run(ctx) {
    const usesAI = ctx.usesAny(AI_PACKAGES) || ctx.find(AI_DIRECT_URL, appCode, 1).length > 0;
    const usesTwilio = ctx.uses('twilio');
    if (!usesAI && !usesTwilio) return notApplicable('No paid AI or SMS APIs found');
    const out = emptyOutput();
    const client = clientCode(ctx);
    const server = serverCode(ctx);

    // 1. Paid APIs called straight from the browser
    // "import type" is removed at build time, so it never reaches the browser.
    const realImports = ctx
      .find(BROWSER_FORBIDDEN_IMPORT, client)
      .filter((m) => !/^\s*(?:import|export)\s+type\b/.test(lineTextAt(m.file.content, m.index)));
    const browserHits = uniqueBy(
      [
        ...realImports,
        ...ctx.find(AI_DIRECT_URL, client),
        ...ctx.find(/dangerouslyAllowBrowser\s*:\s*true/, appCode),
      ],
      (m) => m.file.path,
    );
    for (const m of browserHits.slice(0, 3)) {
      out.findings.push({
        id: 'ai-in-browser',
        severity: 'critical',
        title: `A paid ${/twilio/i.test(m.match[0]) ? 'SMS' : 'AI'} API is called straight from the browser`,
        why: 'For that to work, your secret API key has to be in the browser too, so anyone can copy it and run up your bill. Bots scan websites for exactly this.',
        location: at(m),
        fixPrompt:
          `In ${where(at(m))} my frontend calls a paid AI API directly, which means my API key is exposed in the browser. Please:\n` +
          `1. Create a server-side endpoint (an API route, server action, or Supabase Edge Function) that makes the AI call using a server-only environment variable.\n` +
          `2. Make that endpoint check the user is signed in and limit how many requests each user can make.\n` +
          `3. Change the frontend to call my endpoint instead, and remove the key and any "dangerouslyAllowBrowser" option.\n` +
          `Then remind me to rotate the old key, because it has been public.`,
      });
    }
    if (!browserHits.length) out.passed.push('Paid AI APIs are only called from your server');

    // 2. AI endpoints that anyone can call
    const middlewareProtects = ctx.files.some((f) => middlewareBlocksApi(f));
    const aiRoutes = uniqueBy(
      ctx.find(AI_CALL, (f) => server(f) && isRouteLike(f)),
      (m) => m.file.path,
    );
    const unprotected = middlewareProtects ? [] : aiRoutes.filter((m) => !AUTH_CHECK_RE.test(m.file.content));
    for (const m of unprotected.slice(0, 3)) {
      out.findings.push({
        id: 'ai-endpoint-no-auth',
        severity: 'warning',
        title: `Paid API endpoint doesn't check who is calling it (${m.file.path})`,
        why: 'Anyone on the internet can call this endpoint over and over, and every call is billed to you. Only signed-in users (or a paid plan) should be able to use it.',
        location: at(m),
        fixPrompt:
          `The endpoint in ${where(at(m))} calls a paid AI API but doesn't check who is calling. Please add a check at the top that rejects requests from users who aren't signed in (return 401), ` +
          `using the auth system my app already has. Also cap the size of the input and set a max tokens / max output limit on the AI call.`,
      });
    }
    if (aiRoutes.length && !unprotected.length) out.passed.push('AI endpoints check who is calling');

    // 3. Rate limiting: an imported rate-limit package, or code that really sets up a limiter.
    // (Comments and "RateLimitError" handling don't count.)
    const rateLimited =
      RATE_LIMIT_PACKAGES.some((p) => ctx.imported(p)) || ctx.find(RATE_LIMIT_USAGE, server, 1).length > 0;
    if (rateLimited) {
      out.passed.push('Rate limiting is in place');
    } else {
      out.findings.push({
        id: 'no-rate-limit',
        severity: 'warning',
        title: usesAI ? 'No rate limiting on your AI features' : 'No rate limiting on paid API calls',
        why: 'One user — or one bot — can send thousands of requests a minute, and you pay for every one. A simple limit per user (say 20 a minute) protects your wallet.',
        fixPrompt:
          `Add rate limiting to the endpoints in my app that call paid APIs (${usesAI ? 'AI' : 'SMS'}). Limit each signed-in user (and each IP address for signed-out visitors) to a sensible number of requests per minute and per day, ` +
          `return a friendly "slow down" message when they hit it, and use @upstash/ratelimit (works on Vercel/serverless) unless my stack already has a better option.`,
      });
    }

    // 4. Things only the dashboards can show
    out.manual.push({
      id: 'spending-limits',
      title: 'Set a monthly spending limit with your AI and hosting providers',
      how: 'Set hard limits and email alerts in OpenAI / Anthropic / Google AI billing, and in your host (e.g. Vercel Spend Management, Supabase spend cap). A leaked key or a bug then costs a little, not a lot.',
    });
    if (usesTwilio) {
      out.manual.push({
        id: 'twilio-geo',
        title: 'Turn on Twilio geo-permissions and SMS fraud protection',
        how: 'Bots trigger thousands of SMS codes to expensive countries ("SMS pumping"). Only allow the countries your users are in, and enable Twilio Verify Fraud Guard.',
      });
    }

    return out;
  },
};
