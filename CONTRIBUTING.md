# Contributing to Launch Doctor

Thanks for helping! The goal is simple: catch the mistakes that hurt vibe-coded apps after launch, and explain them so anyone can fix them.

## Setup

```bash
npm install
npm test                  # compiles TypeScript, then runs every test
npm run doctor -- --demo  # run the CLI against the built-in sample app
npm run doctor -- ../some-app
```

Node 22 or newer is required (the test command uses `node --test` glob patterns, and CI runs Node 22 and 24).

## How the code is laid out

```
src/
  cli.ts          command-line flags and output
  index.ts        runDoctor(): runs every check and grades the result
  project.ts      reads the project: files, dependencies, imports, git status
  detect.ts       shared "does this app use X?" helpers
  checks/         one file per category
  grade.ts        scores and letter grades
  report.ts       the terminal report
  fixes.ts        LAUNCH_FIXES.md
test/             node:test tests; projects are built in temp folders
```

## Adding a check

1. Pick the category file in `src/checks/` (or create a new one and add it to `CHECKS` in `src/index.ts`).
2. Use the `ProjectContext` helpers:
   - `ctx.uses('stripe')`: is a package installed or imported? (`'@sentry/'` matches a whole scope)
   - `ctx.find(/regex/, filter)`: matches with file and line numbers
   - `ctx.isClient(file)`: does this file end up in the browser?
   - `appCode`, `serverCode(ctx)`, `clientCode(ctx)`: ready-made filters
3. Push a `Finding` with:
   - a stable kebab-case `id` (people use it in `.launchdoctorignore`),
   - `severity`: `critical` only if it can leak data, lose money or lose data; otherwise `warning`,
   - a plain-English `title` and `why`, written for someone who has never read code,
   - a `fixPrompt` someone can paste into an AI coding tool as is.
4. If code can't prove it either way, add a `manual` checklist item instead of guessing.
5. Add a test in `test/`. Build fake projects with `makeProject({...})`.

## Rules for test data

Never commit a string that looks like a real secret, even a fake one. GitHub push protection will block it, and it trains people to ignore warnings. Build keys at runtime instead: `fakeKey('sk_' + 'live_', 28)`.

## Writing style

- Short sentences, everyday words. "Anyone can read your users' data" beats "unauthorized data exfiltration risk".
- Say what happens to the user or their wallet, not what the code does.
- Don't make claims we can't back up. When unsure, say "may" or move it to the checklist.
