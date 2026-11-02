# Launch Doctor

**A pre-launch checkup for vibe-coded apps: one command, an A-F grade, and a fix prompt for every problem.**

[![CI](https://github.com/namaysingh3925/launch-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/namaysingh3925/launch-doctor/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/launch-doctor)](https://www.npmjs.com/package/launch-doctor)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Launch Doctor scans your project for the problems that hurt apps after launch: leaked API keys, databases anyone can read, payments that can be faked, emails that land in spam, AI endpoints that can run up your bill, missing legal pages and leftover template defaults. It is built for people who ship with AI coding tools (Claude Code, Cursor, Lovable, Bolt, Windsurf) and may not read every line the AI wrote. Every finding is explained in plain English and comes with a prompt you can paste straight back into your AI tool. It has no runtime dependencies, needs no account, and your code never leaves your machine.

## Quick start

```bash
# check the project in the current folder
npx launch-doctor

# no project handy? scan a built-in sample app full of mistakes
npx launch-doctor --demo
```

Requires Node.js 22 or newer.

## Example output

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

| Category | What it catches | Severity range |
|---|---|---|
| Secrets & keys (`secrets`) | Stripe, OpenAI, Anthropic, OpenRouter, Groq, Hugging Face, Supabase, AWS, GitHub, Slack, SendGrid and Resend keys in code; Supabase `service_role` keys; private keys; database URLs with passwords; secrets in `NEXT_PUBLIC_` / `VITE_` variables; `.env` files committed or not in `.gitignore`; with `--history`, keys still in git history | Warning to critical |
| Database & backups (`database`) | Supabase tables without Row Level Security; policies that let anyone write (`using (true)`); write policies open to any signed-in user; Firebase test-mode or open rules; SQLite on serverless hosting; `prisma db push` / `--accept-data-loss` instead of migrations | Warning to critical |
| Payments (`payments`) | Stripe webhooks that don't verify the signature (each route checked separately); webhooks or global `express.json()` that parse the body before verifying; no webhook at all; Razorpay payments never verified on the server | Warning to critical |
| AI & API costs (`costs`) | Paid AI or SMS APIs called from the browser; `dangerouslyAllowBrowser: true`; AI endpoints with no login check (middleware only counts if it really blocks `/api`); no real rate limiter | Warning to critical |
| Email delivery (`email`) | Resend's test sender; personal Gmail SMTP; sender domains that don't exist; missing SPF or DMARC (live DNS check); Supabase's built-in test mailer | Warning |
| Errors & monitoring (`monitoring`) | No error tracking (Sentry, PostHog and others); no error boundary or `error.tsx`, so crashes show a blank page | Warning |
| Legal & trust (`legal`) | No privacy policy, terms, refund policy or contact page; no way for users to delete their account; cookie analytics without consent | Warning |
| First impressions (`first-impressions`) | "Vite + React" / "Create Next App" titles and descriptions; Vite favicon; Lovable default meta tags; no description or social preview image; hard-coded `localhost` URLs | Warning |

Each category also adds **"check yourself"** items for things code can't show, such as backups, spending limits, a real test purchase and uptime monitoring. Monitoring, legal and first impressions only run on web apps (a frontend framework, server routes, or an `index.html`). Command-line tools and libraries skip them.

## How it works

1. **Parse arguments:** flags, the `init` subcommand and usage errors (`src/cli.ts`).
2. **Read the project:** walk the folder (skipping `node_modules`, build output and hidden folders), read text files, `package.json` / `requirements.txt` / `pyproject.toml` dependencies, imports, git status and `.launchdoctorignore` (`src/project.ts`).
3. **Detect the stack:** frameworks, auth, database, payments and email providers, which files run in the browser, and whether it is a web app (`src/detect.ts`, `src/project.ts`). A comment-free view of each file (`src/comments.ts`) keeps commented-out code from counting as protection.
4. **Run the checks:** one file per category in `src/checks/`, registered in `CHECKS` in `src/index.ts`. `--history` adds the git-history scan (`src/history.ts`).
5. **Apply ignores:** inline `launch-doctor-ignore` comments, `.launchdoctorignore` ids and paths (`src/index.ts`), then the baseline (`src/baseline.ts`).
6. **Score:** category scores, weights and the overall grade (`src/grade.ts`).
7. **Output:** the terminal report (`src/report.ts`), `LAUNCH_FIXES.md` (`src/fixes.ts`), `--json`, `--sarif` (`src/sarif.ts`) and the GitHub Actions job summary (`src/summary.ts`).
8. **Exit code:** 0, 1 or 2 (`src/cli.ts`, see below).

## Grading

- **Category score** = 100 − 50 per critical finding − 15 per warning.
  - Any critical finding caps the category at 39, which is an F.
  - Without a critical finding the score never drops below 40, so warnings alone can't give an F.
- **Overall score** is the weighted average of the categories that ran:
  - Weights: secrets, database and payments 3; costs 2; email, monitoring, legal and first impressions 1.
  - Categories that don't apply, or are skipped with `--only` / `--skip`, are left out.
- **Caps on the overall score:**
  - Any critical finding anywhere caps it at 39 (F).
  - Any warning caps it at 89, so an A means nothing is left to fix.
- **Letters:** A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F < 40.
- "Check yourself" items never change the grade. Baseline findings still count toward the grade, but not toward the `--ci` exit code.

## CLI reference

```
npx launch-doctor [folder] [options]
npx launch-doctor init [folder]
```

| Flag | Default | Description |
|---|---|---|
| `[folder]` | `.` | Project folder to check |
| `--domain <domain>` | auto-detected | Domain you send email from; checks SPF, DKIM and DMARC |
| `--out <file>` | `LAUNCH_FIXES.md` in the project | Where to save the fix prompts |
| `--no-file` | off | Don't write the fix prompts file |
| `--json` | off | Print the full report as JSON (no fix file unless `--out` is given) |
| `--sarif <file>` | off | Also write a SARIF 2.1.0 file for GitHub code scanning |
| `--offline` | off | Skip network checks (email DNS) |
| `--ci` | off | Exit with code 1 if findings at or above `--fail-on` (no fix file unless `--out`) |
| `--fail-on <level>` | `critical` | With `--ci`, the lowest severity that fails: `critical` or `warning` |
| `--only <ids>` | all | Run only these categories (comma-separated) |
| `--skip <ids>` | none | Skip these categories (comma-separated) |
| `--history` | off | Also look for keys still in git history |
| `--history-depth <n>` | `500` | How many commits `--history` reads |
| `--update-baseline` | off | Save today's findings to `.launchdoctor-baseline.json` as accepted |
| `--no-baseline` | off | Ignore `.launchdoctor-baseline.json` and show every finding |
| `--demo` | off | Scan a built-in sample app full of mistakes |
| `-h`, `--help` | | Show help |
| `-v`, `--version` | | Show the version |
| `init [folder]` | `.` | Create `.launchdoctorignore` and `.github/workflows/launch-doctor.yml` (never overwrites) |

Category ids for `--only` and `--skip`: `secrets`, `database`, `payments`, `costs`, `email`, `monitoring`, `legal`, `first-impressions`. Skipped categories show as "skipped" and don't count toward the grade.

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | The scan finished (and with `--ci`, nothing at or above `--fail-on`) |
| `1` | `--ci` was given and there are findings at or above `--fail-on` (baseline findings don't count) |
| `2` | Usage error (unknown flag, bad value, folder not found) or a crash |

## Configuration

### `.launchdoctorignore`

One entry per line, `#` for comments. `npx launch-doctor init` creates a commented starter file.

```
# finding ids (each fix in LAUNCH_FIXES.md shows its id)
no-error-tracking
no-account-deletion

# folders or files to skip
legacy/
scripts/seed.ts
```

A plain word is a finding id. Anything with `/`, `*` or `.` is a path pattern, and so is a bare word that matches an existing file or folder. Ids that don't match any check are reported as a warning, so typos don't silently do nothing.

### Inline ignores

To silence one finding in one place, put a `launch-doctor-ignore <id>` comment on the same line or the line above. Any comment style works (`//`, `#`, `/* */`, `<!-- -->`, SQL `--`), and you can list several ids separated by commas.

```ts
// launch-doctor-ignore stripe-test-key
const STRIPE_TEST_KEY = 'sk_test_...'; // used only by the local seed script
```

### Baseline

Adding Launch Doctor to an existing project? Record what's there today, so CI only fails on new problems:

```bash
npx launch-doctor --update-baseline   # writes .launchdoctor-baseline.json (commit it)
```

Later runs:

- mark matching findings as `baseline: true` in `--json`;
- show them as a single "N existing issues (baseline)" line;
- leave them out of `--ci` / `--fail-on`.

Findings are matched by id, file and the text of the matched line, so they still match when lines move. `--no-baseline` shows everything again.

## CI integration

`npx launch-doctor init` creates this workflow:

```yaml
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

- **`--fail-on`:** by default `--ci` fails only on critical findings. Use `--fail-on warning` to fail on warnings too.
- **Job summary:** on GitHub Actions, Launch Doctor adds a summary (grade, category table, and each critical and warning with its file and line) to the job's summary page through the `GITHUB_STEP_SUMMARY` file. No setup is needed.
- **Code scanning:** to see findings as alerts in the repository's Security tab, write SARIF and upload it:

```yaml
      - run: npx launch-doctor --sarif launch-doctor.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: launch-doctor.sarif
```

## Using with AI coding tools

Launch Doctor writes `LAUNCH_FIXES.md` next to your code. Each problem has the file and line, why it matters, and a prompt to paste. There is also one "fix everything in one go" prompt at the top.

With Claude Code:

```
! npx launch-doctor
Fix the issues in LAUNCH_FIXES.md one at a time, starting with the critical ones. Explain each change before making it.
```

With Cursor, Lovable, Bolt or Windsurf, paste one prompt at a time into the chat, check the change, then run `npx launch-doctor` again and watch the grade go up.

## Privacy and network use

Launch Doctor reads your files locally and never uploads your code, findings or keys anywhere. Secrets are always masked in output (`sk_live_…exe9`).

- **Email DNS check:** this is the only network request Launch Doctor makes. It runs when your app sends email and a sender domain is known (detected in code or given with `--domain`). It sends ordinary DNS queries through your system resolver for that domain's NS and TXT records: the domain itself, `send.<domain>`, `_dmarc.<domain>`, and about 20 common DKIM selector names. No other data is sent. `--offline` turns this off, and `--demo` never makes network requests.
- **`--history`:** runs `git log` on your machine. No network.
- **`npx`:** downloads Launch Doctor itself from the npm registry, as for any npx command.

## Limitations

Launch Doctor is a fast checkup, not a security audit or penetration test.

- It reads code with patterns and heuristics, so it can miss real problems and sometimes flag something that's fine. Use `.launchdoctorignore` or an inline ignore for those.
- It can't see dashboards. Settings made by clicking in Supabase, Firebase, Stripe or your host go on the "check yourself" list instead.
- It understands JavaScript / TypeScript and Python projects best.

If you handle money or sensitive data, get a human review too.

## Roadmap

- [ ] Scan a live URL (exposed `.env`, source maps, security headers, open Supabase tables through the anon key)
- [ ] GitHub Action that comments the report on pull requests
- [ ] Claude Code plugin / MCP server
- [ ] More providers: Clerk, Convex, Appwrite, Lemon Squeezy, Paddle
- [ ] Mobile apps (Expo / React Native)

Ideas and bug reports are welcome. Please open an issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the project layout and how to add a check. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please don't report security problems in public issues. See [SECURITY.md](SECURITY.md) for how to report one privately.

## License

[MIT](LICENSE)
