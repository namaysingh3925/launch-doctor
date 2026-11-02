# Launch Doctor

**A pre-launch checkup for vibe-coded apps.**
One command grades your project A–F on the things that break *after* launch: leaked keys, open databases, fake-able payments, emails landing in spam, surprise AI bills, missing legal pages, and the "Vite + React" title still in your browser tab.

For every problem it writes a **copy-paste prompt** you can hand straight to Claude Code, Cursor, Lovable, Bolt or Windsurf to fix it.

```bash
npx launch-doctor
```

No account, no API key, no config. Your code never leaves your computer.

---

## Why

AI tools can build an app in a weekend. They don't tell you that:

- your OpenAI key is sitting in the browser where anyone can copy it,
- your Supabase tables have no Row Level Security, so anyone can read every user's data,
- your Stripe webhook accepts fake "payment succeeded" messages,
- your sign-up emails come from a test address that only delivers to you,
- one bot can call your AI endpoint 10,000 times overnight on your card.

Security scans of thousands of AI-built apps keep finding these same mistakes. Launch Doctor checks for them in seconds, explains each one in plain English, and gives you the exact prompt to fix it.

## Try it

```bash
# check the project in the current folder
npx launch-doctor

# no project handy? scan a built-in sample app full of mistakes
npx launch-doctor --demo
```

```
  Launch Doctor v0.1.0
  Checked my-weekend-saas · 12 files · Vite, React, Supabase, Stripe, OpenAI

  Overall grade  F   Not ready to launch: fix 6 critical issues first

  F  Secrets & keys       2 critical · 1 to fix · 1 to check
  F  Database & backups   2 critical · 1 to check
  F  Payments             1 critical · 2 to check
  F  AI & API costs       1 critical · 1 to fix · 1 to check
  B  Email delivery       1 to fix · 3 to check
  C  Errors & monitoring  2 to fix · 2 to check
  D  Legal & trust        5 to fix
  D  First impressions    5 to fix · 3 to check

  MUST FIX BEFORE LAUNCH (6)

  [CRITICAL] Stripe live secret key is written directly in your code
      src/lib/stripe.ts:1
      This file is sent to every visitor's browser, so anyone can copy the key
      (sk_live_…exe9) and use your account.

  [CRITICAL] Secret exposed through the public variable VITE_OPENAI_API_KEY
      .env:3
      Anything starting with VITE_ gets copied into your website's JavaScript,
      so every visitor can read it. That prefix is only for values that are safe
      to be public.
  ...

  Fix prompts saved to LAUNCH_FIXES.md
```

## What it checks

| Category | Examples of what it catches |
|---|---|
| **Secrets & keys** | Stripe / OpenAI / Anthropic / AWS / GitHub keys in code · Supabase `service_role` key in the frontend · secrets in `NEXT_PUBLIC_` / `VITE_` variables · `.env` not in `.gitignore` or already committed · database passwords in connection strings |
| **Database & backups** | Supabase tables without Row Level Security · policies that let anyone write (`using (true)`) · Firebase "test mode" rules · SQLite on Vercel/Netlify · `prisma db push` / `--accept-data-loss` instead of migrations |
| **Payments** | Stripe webhooks that don't verify the signature · webhooks that parse JSON before verifying (so every real webhook fails) · no webhook at all · Razorpay payments never verified on the server |
| **AI & API costs** | OpenAI/Anthropic/Gemini called from the browser · `dangerouslyAllowBrowser: true` · AI endpoints with no login check · no rate limiting |
| **Email delivery** | Sending from `onboarding@resend.dev` · sending through personal Gmail · missing SPF / DMARC / DKIM on your domain (live DNS check) · Supabase's built-in test mailer |
| **Errors & monitoring** | No error tracking (Sentry, PostHog, …) · no error boundary / `error.tsx`, so crashes show a blank white page |
| **Legal & trust** | No privacy policy, terms, refund policy or contact page · no way for users to delete their account · cookie analytics without consent |
| **First impressions** | Default "Vite + React" / "Create Next App" titles · Vite favicon · Lovable default meta tags · no description or social preview image · hard-coded `localhost` URLs |

Things that can't be seen from code — backups, spending limits, a real test purchase, uptime monitoring — go on a **"Check yourself"** checklist instead of being guessed at.

Works with **JavaScript / TypeScript** projects (Next.js, Vite, React, Vue, Svelte, Astro, Express, Supabase Edge Functions…) and understands **Python** apps (Flask, FastAPI, Django) too.

## The fix file

Launch Doctor saves `LAUNCH_FIXES.md` in your project. For each problem it has:

- **where** it is (file and line),
- **why it matters**, in plain English,
- **a prompt to paste** into your AI coding tool.

There's also a single "fix everything in one go" prompt at the top. Paste one fix at a time, test, then run `npx launch-doctor` again and watch your grade go up.

## Options

```
npx launch-doctor [folder] [options]

  --domain <domain>   Domain you send email from (checks SPF / DKIM / DMARC)
  --out <file>        Where to save the fix prompts (default: LAUNCH_FIXES.md)
  --no-file           Don't write the fix prompts file
  --json              Print the full report as JSON
  --sarif <file>      Also write a SARIF 2.1.0 file (for GitHub code scanning)
  --offline           Skip network checks
  --ci                Exit with code 1 if there are critical issues
  --fail-on <level>   With --ci, the lowest severity that fails: critical (default) or warning
  --only <ids>        Run only these categories (comma-separated)
  --skip <ids>        Skip these categories (comma-separated)
  --demo              Try it on a sample app full of mistakes
```

Category ids for `--only` and `--skip`: `secrets`, `database`, `payments`, `costs`, `email`, `monitoring`, `legal`, `first-impressions`. Skipped categories show as "skipped" and don't count toward the grade, for example `npx launch-doctor --only secrets,database`.

## Use it in CI

Block a deploy when something critical slips in:

```yaml
# .github/workflows/launch-doctor.yml
name: Launch Doctor
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npx launch-doctor --ci
```

On GitHub Actions, Launch Doctor also adds a summary (grade, category table, and every critical and warning with its file and line) to the job's summary page, using the `GITHUB_STEP_SUMMARY` file that Actions provides. No setup is needed.

To see findings as code-scanning alerts in the GitHub Security tab, write SARIF and upload it:

```yaml
      - run: npx launch-doctor --sarif launch-doctor.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: launch-doctor.sarif
```

By default `--ci` fails only on critical issues. Use `--fail-on warning` to fail on warnings too.
`--ci` and `--json` don't write `LAUNCH_FIXES.md` unless you pass `--out`.

## Use it with Claude Code

Run it, then ask Claude to work through the file:

```
! npx launch-doctor
Fix the issues in LAUNCH_FIXES.md one at a time, starting with the critical ones. Explain each change before making it.
```

## Silencing a finding

Not every check fits every app. Create a `.launchdoctorignore` file in your project:

```
# finding ids (shown at the bottom of each fix in LAUNCH_FIXES.md)
no-error-tracking
no-account-deletion

# folders or files to skip
legacy/
scripts/seed.ts
```

To silence one finding in one place, put a `launch-doctor-ignore <id>` comment on the same line or the line above. Any comment style works (`//`, `#`, `/* */`, `<!-- -->`, SQL `--`):

```ts
// launch-doctor-ignore stripe-test-key
const STRIPE_TEST_KEY = 'sk_test_...'; // used only by the local seed script
```

## Privacy

Launch Doctor runs entirely on your machine. It reads your files, prints a report and writes `LAUNCH_FIXES.md`. Nothing is uploaded. The only network request is an optional DNS lookup for your email domain's SPF/DKIM/DMARC records (skip it with `--offline`). Secrets are always masked in the output (`sk_live_…exe9`).

## Limits

Launch Doctor is a fast checkup, not a full security audit or penetration test. It reads your code with patterns and heuristics, so it can miss things and occasionally flag something that's fine (use `.launchdoctorignore` for those). It can't see your dashboards, so settings like Supabase RLS created by clicking in the UI land on the "Check yourself" list. If you handle money or sensitive data, get a human review too.

## Roadmap

- [ ] Scan a live URL (exposed `.env`, source maps, security headers, open Supabase tables via the anon key)
- [ ] GitHub Action that comments the report on pull requests
- [ ] Claude Code plugin with a `/launch-check` command
- [ ] More providers: Clerk, Convex, Appwrite, Lemon Squeezy, Paddle
- [ ] Mobile apps (Expo / React Native)

Ideas and bug reports are very welcome — open an issue.

## Contributing

```bash
git clone <this repo>
cd launch-doctor
npm install
npm test            # build + run all tests
npm run doctor -- --demo
```

Each category is one file in `src/checks/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a new check.

## License

MIT
