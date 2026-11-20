import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A random-looking (but fake) key, generated at runtime so no key-shaped string ships in the package. */
function fakeKey(prefix: string, length: number, seed: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let x = seed;
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

const DEMO_PREFIX = 'launch-doctor-demo-';
/** A demo folder older than this was left behind by a run that was killed before it could clean up. */
const STALE_DEMO_MS = 60 * 60 * 1000;

/**
 * Remove demo folders that killed runs left in the temp folder. Only folders named
 * launch-doctor-demo-* that are over an hour old are touched, so a demo running in
 * another terminal right now is left alone. Returns how many were removed.
 */
export function sweepStaleDemos(now = Date.now(), dir = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(DEMO_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < STALE_DEMO_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // in use or already gone: leave it
    }
  }
  return removed;
}

/**
 * Delete the demo folder if the run is stopped with Ctrl+C (SIGINT), SIGTERM or SIGHUP.
 * Register it before creating the folder: signal handlers run between JavaScript tasks,
 * so the folder name is always known by the time one runs.
 * Returns a function that removes the handlers again once the run has cleaned up normally.
 */
export function removeOnSignal(getDir: () => string | undefined): () => void {
  const codes: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handler = (signal: NodeJS.Signals) => {
    const dir = getDir();
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.exit(codes[signal] ?? 1);
  };
  for (const signal of Object.keys(codes)) process.once(signal, handler);
  return () => {
    for (const signal of Object.keys(codes)) process.removeListener(signal, handler);
  };
}

/** Writes a small "weekend project" with the classic launch mistakes and returns its folder. */
export function createDemoProject(): string {
  sweepStaleDemos();
  const dir = mkdtempSync(join(tmpdir(), DEMO_PREFIX));
  const openaiKey = fakeKey(['sk', 'proj', ''].join('-'), 40, 3);
  const stripeKey = fakeKey(['sk', 'live', ''].join('_'), 28, 7);

  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: 'my-weekend-saas',
        private: true,
        dependencies: {
          react: '^19.0.0',
          vite: '^7.0.0',
          '@supabase/supabase-js': '^2.50.0',
          stripe: '^18.0.0',
          openai: '^5.0.0',
          resend: '^4.0.0',
        },
      },
      null,
      2,
    ),
    '.env': `VITE_SUPABASE_URL=https://demo.supabase.co\nVITE_SUPABASE_ANON_KEY=demo\nVITE_OPENAI_API_KEY=${openaiKey}\n`,
    '.gitignore': 'node_modules\ndist\n*.local\n',
    'index.html':
      '<!doctype html>\n<html>\n  <head>\n    <link rel="icon" href="/vite.svg" />\n    <title>Vite + React + TS</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n',
    'src/lib/stripe.ts': `export const STRIPE_KEY = "${stripeKey}";\n`,
    'src/lib/supabase.ts':
      "import { createClient } from '@supabase/supabase-js';\nexport const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n",
    'src/lib/ai.ts':
      "import OpenAI from 'openai';\n\nconst openai = new OpenAI({ apiKey: import.meta.env.VITE_OPENAI_API_KEY, dangerouslyAllowBrowser: true });\n\nexport async function summarize(text: string) {\n  return openai.chat.completions.create({ model: 'gpt-5-mini', messages: [{ role: 'user', content: text }] });\n}\n",
    'src/pages/Signup.tsx':
      "import { supabase } from '../lib/supabase';\n\nexport function Signup() {\n  return <button onClick={() => supabase.auth.signUp({ email: '', password: '' })}>Create account</button>;\n}\n",
    'src/api.ts': "export const getNotes = () => fetch('http://localhost:3001/notes').then((r) => r.json());\n",
    'supabase/functions/stripe-webhook/index.ts':
      "Deno.serve(async (req) => {\n  const event = await req.json();\n  if (event.type === 'checkout.session.completed') {\n    // mark the user as paid\n  }\n  return new Response('ok');\n});\n",
    'supabase/functions/welcome-email/index.ts':
      "import { Resend } from 'npm:resend';\nconst resend = new Resend(Deno.env.get('RESEND_API_KEY'));\nDeno.serve(async () => {\n  await resend.emails.send({ from: 'onboarding@resend.dev', to: 'user@example.com', subject: 'Welcome!', html: '<p>Hi</p>' });\n  return new Response('sent');\n});\n",
    'supabase/migrations/20260101000000_init.sql':
      'create table public.profiles (\n  id uuid primary key references auth.users,\n  full_name text,\n  plan text default \'free\'\n);\n\ncreate table public.notes (\n  id bigint generated always as identity primary key,\n  user_id uuid references auth.users,\n  body text\n);\nalter table public.notes enable row level security;\ncreate policy "Anyone can edit notes" on public.notes for all using (true);\n',
  };

  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
