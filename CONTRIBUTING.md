# Contributing to Launch Doctor

Thanks for helping. The goal is simple: catch the mistakes that hurt vibe-coded apps after launch, and explain them so anyone can fix them.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Report security problems privately (see [SECURITY.md](SECURITY.md)), not in public issues.

## Setup

You need Node.js 22 or newer (the test command uses `node --test` glob patterns, and CI runs Node 22 and 24).

```bash
git clone https://github.com/namaysingh3925/launch-doctor.git
cd launch-doctor
npm install
npm test                  # compiles TypeScript, then runs every test
npm run doctor -- --demo  # run the CLI against the built-in sample app
npm run doctor -- ../some-app
```

## Project layout

```
src/
  cli.ts          command-line flags, the init subcommand, output files and exit codes
  index.ts        runDoctor(): runs every check, applies ignores and the baseline, grades the result
  project.ts      reads the project: files, dependencies, imports, git status, .launchdoctorignore
  comments.ts     comment-free view of a file (for "is X present?" checks)
  detect.ts       shared "does this app use X?" helpers
  checks/         one file per category, plus common.ts helpers
  grade.ts        category scores, weights and letter grades
  baseline.ts     .launchdoctor-baseline.json fingerprints
  history.ts      --history git log scan
  report.ts       the terminal report
  fixes.ts        LAUNCH_FIXES.md
  sarif.ts        --sarif output
  summary.ts      GitHub Actions job summary
  init.ts         files created by `launch-doctor init`
  demo.ts         the sample project used by --demo
test/             node:test tests; projects are built in temp folders
```

## Adding a check, step by step

1. **Pick the file.** Add your check to the right category in `src/checks/`. For a new category, create a file that exports a `Check` and add it to `CHECKS` in `src/index.ts`. The category id must be kebab-case; it's what `--only` / `--skip` use.
2. **Detect the situation.** Use the `ProjectContext` helpers:
   - `ctx.uses('stripe')` / `ctx.imported('stripe')`: is a package installed / actually imported? (`'@sentry/'` matches a whole scope.)
   - `ctx.find(/regex/, filter)`: matches with file and line, on the raw text. Use it for secrets.
   - `ctx.findCode(/regex/, filter)` and `ctx.codeOf(file)`: the same, with comments removed. Use these when checking that something is *present* (a rate limiter, an auth check), so commented-out code doesn't count.
   - `ctx.isClient(file)`, `ctx.isWebApp`, and the `appCode`, `serverCode(ctx)`, `clientCode(ctx)` and `isRouteLike` filters in `checks/common.ts`.
3. **Push a finding.**
   - `id`: stable, kebab-case, describing the problem rather than the fix (`stripe-webhook-unverified`, not `add-constructevent`). People put ids in `.launchdoctorignore` and baselines, so never rename one.
   - Add the id to the check's `ids` array (a test fails if you forget).
   - `severity`: `critical` only if it can leak data, lose money or lose data; otherwise `warning`.
   - `title` and `why`: plain English for someone who has never read code. Say what happens to the user or their wallet, not what the code does.
   - `location`: file and line whenever you have them (they drive inline ignores, SARIF and the baseline).
4. **Write the `fixPrompt`.** It is pasted into an AI coding tool as is, so:
   - name the file and line, and what is wrong;
   - give numbered steps when there is more than one change;
   - name the concrete API or setting to use (`stripe.webhooks.constructEvent`, `alter table ... enable row level security`);
   - ask the AI to explain how to test the fix, and to rotate keys when something leaked;
   - never include a full secret (use `mask()`).
5. **Can't tell from code?** Add a `manual` checklist item instead of guessing.
6. **Test it.** Add a test in `test/` with `makeProject({...})`. Cover the case that should be reported and a close case that shouldn't. For bug fixes, add a regression test to `test/regressions.test.ts`.
7. **Document it.** Update the "What it checks" table in `README.md` and add a line under "Unreleased" in `CHANGELOG.md`.

## Rules for test data

Never commit a string that looks like a real secret, even a fake one. GitHub push protection will block it, and it trains people to ignore warnings. Build keys at runtime instead: `fakeKey('sk_' + 'live_', 28)`.

## Writing style

- Short sentences, everyday words. "Anyone can read your users' data" beats "unauthorized data exfiltration risk".
- No emojis in code, output or docs (a test checks this).
- Don't make claims we can't back up. When unsure, say "may" or move it to the checklist.

## Commit messages

- Use the imperative mood and keep the subject under about 70 characters: "Check every Stripe webhook route on its own".
- Explain the *why* in the body: what was wrong, and what changes for users.
- Keep each commit to one logical change, and keep formatting-only changes in their own commit.

## Pull request checklist

- [ ] `npm test` passes
- [ ] New behaviour has tests (bug fixes have a regression test)
- [ ] New finding ids are added to the check's `ids` array
- [ ] `README.md` updated (check table, CLI reference) if behaviour or flags changed
- [ ] `CHANGELOG.md` has a line under "Unreleased"
- [ ] No real-looking secrets in test data
