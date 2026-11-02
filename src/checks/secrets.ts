import { isCodeFile, isEnvPath, isRealEnvPath, type Match, type ProjectContext, type SourceFile } from '../project.js';
import type { Check, Finding, Location, Severity } from '../types.js';
import { decodeJwtPayload, looksLikePlaceholder, mask } from '../util.js';
import { at, emptyOutput, where } from './common.js';

interface KeyPattern {
  id: string;
  name: string;
  re: RegExp;
  severity: Severity;
  envName: string;
  rotate: string;
  /**
   * For prefixes that also show up in normal text (like "sk-" in URL slugs):
   * "mixed" needs upper case, lower case and a digit; "digits-letters" needs both.
   */
  mustLookRandom?: 'mixed' | 'digits-letters';
}

function looksRandom(value: string, kind: 'mixed' | 'digits-letters'): boolean {
  const hasDigit = /\d/.test(value);
  if (kind === 'digits-letters') return hasDigit && /[a-z]/i.test(value);
  return hasDigit && /[A-Z]/.test(value) && /[a-z]/.test(value);
}

const KEY_PATTERNS: KeyPattern[] = [
  {
    id: 'stripe-live-key', name: 'Stripe live secret key', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/g,
    severity: 'critical', envName: 'STRIPE_SECRET_KEY', rotate: 'Stripe Dashboard → Developers → API keys → Roll key',
  },
  {
    id: 'stripe-test-key', name: 'Stripe test secret key', re: /\bsk_test_[0-9a-zA-Z]{20,}/g,
    severity: 'warning', envName: 'STRIPE_SECRET_KEY', rotate: 'Stripe Dashboard → Developers → API keys → Roll key',
  },
  {
    id: 'anthropic-key', name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    severity: 'critical', envName: 'ANTHROPIC_API_KEY', rotate: 'console.anthropic.com → Settings → API keys',
  },
  {
    id: 'openrouter-key', name: 'OpenRouter API key', re: /\bsk-or-v1-[A-Za-z0-9]{40,}/g,
    severity: 'critical', envName: 'OPENROUTER_API_KEY', rotate: 'openrouter.ai → Keys', mustLookRandom: 'digits-letters',
  },
  {
    id: 'openai-key', name: 'OpenAI API key', re: /\bsk-(?!ant-|or-v1-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
    severity: 'critical', envName: 'OPENAI_API_KEY', rotate: 'platform.openai.com → API keys', mustLookRandom: 'mixed',
  },
  {
    id: 'supabase-secret-key', name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
    severity: 'critical', envName: 'SUPABASE_SECRET_KEY', rotate: 'Supabase → Project Settings → API Keys',
  },
  {
    id: 'stripe-webhook-secret', name: 'Stripe webhook signing secret', re: /\bwhsec_[A-Za-z0-9]{24,}/g,
    severity: 'critical', envName: 'STRIPE_WEBHOOK_SECRET', rotate: 'Stripe Dashboard → Developers → Webhooks → Roll secret',
  },
  {
    id: 'groq-key', name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{40,}/g,
    severity: 'critical', envName: 'GROQ_API_KEY', rotate: 'console.groq.com → API Keys',
  },
  {
    id: 'huggingface-token', name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/g,
    severity: 'critical', envName: 'HF_TOKEN', rotate: 'huggingface.co → Settings → Access Tokens', mustLookRandom: 'mixed',
  },
  {
    id: 'aws-key', name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: 'critical', envName: 'AWS_ACCESS_KEY_ID', rotate: 'AWS Console → IAM → Users → Security credentials',
  },
  {
    id: 'github-token', name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
    severity: 'critical', envName: 'GITHUB_TOKEN', rotate: 'github.com → Settings → Developer settings → Personal access tokens',
  },
  {
    id: 'slack-token', name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    severity: 'critical', envName: 'SLACK_TOKEN', rotate: 'api.slack.com → Your apps → OAuth & Permissions',
  },
  {
    id: 'sendgrid-key', name: 'SendGrid API key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    severity: 'critical', envName: 'SENDGRID_API_KEY', rotate: 'SendGrid → Settings → API Keys',
  },
  {
    id: 'resend-key', name: 'Resend API key', re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g,
    severity: 'critical', envName: 'RESEND_API_KEY', rotate: 'resend.com → API Keys', mustLookRandom: 'mixed',
  },
  {
    id: 'private-key', name: 'private key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?:\\n|\s)+[A-Za-z0-9+/=]{40,}/g,
    severity: 'critical', envName: 'PRIVATE_KEY', rotate: 'wherever this key was created (Google Cloud, Firebase, Apple, etc.)',
  },
];

const DB_URL_RE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/([^:\s'"`/@]+):([^@\s'"`]+)@([^\s'"`/:?,]+)/g;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|db|database|postgres|mysql|mongo|mongodb|redis)$/i;
const WEAK_PLACEHOLDER_PW = /^(password|pass|postgres|root|secret|admin|pwd|user|mysql|test)$/i;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

const PUBLIC_VAR_RE = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|PUBLIC_)([A-Z0-9_]+)/g;
const SENSITIVE_PART =
  /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|OPENAI|ANTHROPIC|CLAUDE|GEMINI|GROQ|MISTRAL|DEEPSEEK|OPENROUTER|PERPLEXITY|REPLICATE|HUGGING|HF_TOKEN|COHERE|TOGETHER|ELEVENLABS|RESEND|SENDGRID|MAILGUN|POSTMARK|TWILIO_AUTH|AUTH_TOKEN|ACCESS_TOKEN|ADMIN_KEY)/;
const DB_PART = /(DATABASE_URL|DB_URL|POSTGRES_URL|MONGODB_URI|MONGO_URI)/;
const SAFE_SUFFIX = /(_URL|_URI|_ENDPOINT|_MODEL|_BASE|_HOST|_REGION|_VERSION|_ENABLED|_ID|_NAME)$/;

export function isSensitivePublicName(rest: string): boolean {
  if (DB_PART.test(rest)) return true;
  if (SAFE_SUFFIX.test(rest)) return false;
  return SENSITIVE_PART.test(rest);
}

/** Files to search for hard-coded secrets: everything except real .env files (secrets belong there). */
const notRealEnv = (f: SourceFile) => !isRealEnvPath(f.path);

function hardcodedFinding(ctx: ProjectContext, p: KeyPattern, m: Match): Finding {
  const client = ctx.isClient(m.file);
  const shown = p.id === 'private-key' ? '-----BEGIN … PRIVATE KEY-----' : mask(m.match[0]);
  return {
    id: p.id,
    severity: client ? 'critical' : p.severity,
    title: `${capitalize(p.name)} is written directly in your code`,
    why: client
      ? `This file is sent to every visitor's browser, so anyone can copy the key (${shown}) and use your account.`
      : `Anyone who can see your code (GitHub, collaborators, AI tools) can copy this key (${shown}) and use your account. Keys belong in environment variables.`,
    location: at(m),
    fixPrompt:
      `In ${where(at(m))} there is a hard-coded ${p.name} (it starts with "${shown}"). Please:\n` +
      `1. Move it into an environment variable called ${p.envName} in my .env file and read it with process.env.${p.envName}, only in server-side code (never in browser/frontend code).\n` +
      `2. Make sure .env is listed in .gitignore.\n` +
      `3. Search the whole project for any other copies of this key and remove them.\n` +
      `Then tell me step by step how to revoke this key and create a new one (${p.rotate}), because it has probably already leaked.`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const secretsCheck: Check = {
  id: 'secrets',
  name: 'Secrets & keys',
  icon: '🔑',
  weight: 3,
  run(ctx) {
    const out = emptyOutput();

    // 1. Hard-coded API keys
    const seen = new Set<string>();
    let hardcoded = 0;
    for (const p of KEY_PATTERNS) {
      for (const m of ctx.find(p.re, notRealEnv)) {
        if (p.id !== 'private-key' && looksLikePlaceholder(m.match[0])) continue;
        if (p.mustLookRandom && !looksRandom(m.match[0], p.mustLookRandom)) continue;
        const key = `${p.id}|${m.file.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (++hardcoded > 10) break;
        out.findings.push(hardcodedFinding(ctx, p, m));
      }
    }

    // 2. Database connection strings with real passwords
    for (const m of ctx.find(DB_URL_RE, notRealEnv)) {
      const password = m.match[2]!;
      const host = m.match[3]!;
      if (LOCAL_HOST_RE.test(host) || WEAK_PLACEHOLDER_PW.test(password) || looksLikePlaceholder(password)) continue;
      if (password.startsWith('$') || password.startsWith('[') || password.startsWith('%')) continue;
      const key = `db-url|${m.file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hardcoded++;
      out.findings.push({
        id: 'database-password',
        severity: 'critical',
        title: 'Your database password is written directly in your code',
        why: 'Anyone who sees this file can log straight into your database and read, change or delete everything.',
        location: at(m),
        fixPrompt:
          `In ${where(at(m))} there is a database connection string with the password written in it. ` +
          `Move it into an environment variable called DATABASE_URL in .env (make sure .env is in .gitignore), ` +
          `read it with process.env.DATABASE_URL only on the server, and remove every hard-coded copy. ` +
          `Then tell me how to change the database password in my database provider's dashboard, since the old one may have leaked.`,
      });
    }

    // 3. Supabase service_role keys (they bypass all database security)
    for (const m of ctx.find(JWT_RE, notRealEnv)) {
      const payload = decodeJwtPayload(m.match[0]);
      if (payload?.role !== 'service_role') continue;
      const key = `service-role|${m.file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hardcoded++;
      out.findings.push({
        id: 'supabase-service-role-key',
        severity: 'critical',
        title: 'Supabase service_role key is written directly in your code',
        why: 'The service_role key skips all of your database security rules (RLS). Anyone who finds it can read and delete every row in every table.',
        location: at(m),
        fixPrompt:
          `In ${where(at(m))} my Supabase service_role key is hard-coded. Please remove it from the code. ` +
          `Frontend code must only use the anon (public) key. If some feature truly needs admin access, move that code into a server-only place ` +
          `(an API route or a Supabase Edge Function) that reads SUPABASE_SERVICE_ROLE_KEY from environment variables. ` +
          `Then tell me how to rotate the service_role key / JWT secret in the Supabase dashboard.`,
      });
    }

    if (hardcoded === 0) out.passed.push('No API keys or passwords are hard-coded in your code');

    // 4. Secrets exposed through "public" env variable names
    const publicHits = new Map<string, Location>();
    // Big apps reference public variables thousands of times, so don't stop early.
    for (const m of ctx.find(PUBLIC_VAR_RE, (f) => isCodeFile(f) || isEnvPath(f.path), 200_000)) {
      const full = m.match[0];
      if (!isSensitivePublicName(m.match[2]!) || publicHits.has(full)) continue;
      publicHits.set(full, at(m));
    }
    // A public variable that actually holds a service_role key
    for (const file of ctx.files.filter((f) => isEnvPath(f.path))) {
      file.content.split(/\r?\n/).forEach((line, i) => {
        const kv = /^\s*(?:export\s+)?((?:NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|PUBLIC_)[A-Z0-9_]+)\s*=\s*['"]?([^'"\s#]+)/.exec(line);
        if (kv && decodeJwtPayload(kv[2]!)?.role === 'service_role' && !publicHits.has(kv[1]!)) {
          publicHits.set(kv[1]!, { file: file.path, line: i + 1 });
        }
      });
    }
    let publicCount = 0;
    for (const [name, loc] of publicHits) {
      if (++publicCount > 5) break;
      const prefix = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_|PUBLIC_)/.exec(name)?.[1] ?? '';
      out.findings.push({
        id: 'public-secret-variable',
        severity: 'critical',
        title: `Secret exposed through the public variable ${name}`,
        why: `Anything starting with ${prefix} gets copied into your website's JavaScript, so every visitor can read it. That prefix is only for values that are safe to be public.`,
        location: loc,
        fixPrompt:
          `My app has an environment variable called ${name} (see ${where(loc)}). Because it starts with ${prefix}, it is bundled into the browser code and anyone can read it. Please:\n` +
          `1. Rename it to a server-only name without the ${prefix} prefix.\n` +
          `2. Move every piece of code that uses it into server-side code (an API route, server action, or Supabase Edge Function) and make the frontend call that instead.\n` +
          `3. Update .env and .env.example.\n` +
          `Then tell me how to rotate this key in the provider's dashboard, because it has already been public.`,
      });
    }
    if (publicHits.size === 0) {
      out.passed.push('No secret keys in public (NEXT_PUBLIC_ / VITE_) variables');
    }

    // 5. .env files kept out of git
    const realEnvs = ctx.files.filter(
      (f) => isRealEnvPath(f.path) && /^[ \t]*(?:export[ \t]+)?[A-Za-z_]\w*[ \t]*=[ \t]*['"]?[^\s'"#]/m.test(f.content),
    );
    if (realEnvs.length) {
      const committed = realEnvs.filter((f) => ctx.isTracked(f.path));
      const notCommitted = realEnvs.filter((f) => !ctx.isTracked(f.path));
      const ignored = ctx.ignoredAmong(notCommitted.map((f) => f.path));
      const exposed = notCommitted.filter((f) => !ignored.has(f.path));

      for (const f of committed.slice(0, 3)) {
        out.findings.push({
          id: 'env-committed',
          severity: 'critical',
          title: `${f.path} is saved in git`,
          why: 'Your .env file holds your secret keys and it has been committed to git. If this repo is ever pushed to GitHub (even privately), those keys are exposed — and they stay in the git history even after you delete the file.',
          location: { file: f.path },
          fixPrompt:
            `My ${f.path} file (with secret keys) is tracked by git. Please: add it to .gitignore, run "git rm --cached ${f.path}" so git stops tracking it (the file stays on my computer), ` +
            `and create a .env.example with the same variable names but no values. Then list every key inside it and tell me how to rotate each one, because they are in my git history.`,
        });
      }
      for (const f of exposed.slice(0, 3)) {
        out.findings.push({
          id: 'env-not-ignored',
          severity: ctx.gitRoot ? 'critical' : 'warning',
          title: `${f.path} is not in .gitignore`,
          why: ctx.gitRoot
            ? 'The next "git add ." will upload your secret keys along with your code.'
            : 'As soon as you put this project on GitHub, your secret keys will be uploaded with it.',
          location: { file: f.path },
          fixPrompt:
            `Add ${f.path} (and other .env files except .env.example) to my .gitignore so my secret keys are never committed. ` +
            `Use a pattern like ".env*" followed by "!.env.example". Then create .env.example with the same variable names but empty values.`,
        });
      }
      if (!committed.length && !exposed.length) out.passed.push('.env files are kept out of git');
    }

    out.manual.push({
      id: 'separate-keys',
      title: 'Use separate keys for testing and for the live app',
      how: 'Use test-mode keys on your laptop and live keys only in your hosting dashboard (Vercel, Netlify, Render…). If you ever pasted a key into a chat, screenshot or public repo, rotate it.',
    });

    return out;
  },
};
