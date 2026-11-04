# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `launch-doctor scan <url>` checks a deployed site from the outside: downloadable `.env`, `.git` and SQL backups, public source maps, API keys in the JavaScript, Supabase tables readable with the public key, and HTTPS and security headers. `--no-db` skips the Supabase test.
- AI endpoints are now judged one handler at a time: auth and rate limiting must be reachable from that handler, including through local imports.
- `--fail-on <critical|warning>` chooses the lowest severity that makes `--ci` exit with code 1.
- Inline ignores: a `launch-doctor-ignore <id>` comment on a finding's line or the line above silences that one finding (`//`, `#`, `/* */`, `<!-- -->` and SQL `--` comments).
- `--only <ids>` and `--skip <ids>` run or skip categories; skipped categories don't count toward the grade.
- GitHub Actions job summary: when `GITHUB_STEP_SUMMARY` is set, a Markdown summary is added to the job page.
- `--sarif <file>` writes SARIF 2.1.0 for GitHub code scanning.
- Baselines: `--update-baseline` writes `.launchdoctor-baseline.json`; later runs mark known findings, collapse them and leave them out of `--ci`. `--no-baseline` ignores the file.
- `launch-doctor init` creates a commented `.launchdoctorignore` and a GitHub Actions workflow without overwriting existing files.
- `--history` and `--history-depth <n>` find API keys that were removed from the code but are still in git history.
- Comment-aware matching: commented-out code no longer counts as an error boundary, account deletion, rate limiter, auth check or webhook verification.
- Supabase policies are graded by how open they are: open write policies are critical, write policies open to any signed-in user are a warning, and public read policies go on the checklist.
- Email: a sender domain that doesn't exist in DNS gets one clear warning, and a missing root SPF record is a checklist item (not a warning) for Amazon SES, Postmark and SendGrid.
- Web-app detection: monitoring, legal and first-impressions checks only run on web apps.
- Unknown ids in `.launchdoctorignore` are reported as a warning.

### Changed

- Any critical finding now gives an F, in its category and overall.
- Removed all emojis from the terminal report, `LAUNCH_FIXES.md`, `--help` and the docs. The report uses `[CRITICAL]`, `[WARN]`, `[PASS]` and `[ ]` labels.
- `--json` and `--ci` no longer write `LAUNCH_FIXES.md` unless `--out` is given.
- An existing `LAUNCH_FIXES.md` is rewritten (with an "All clear" section) when nothing is left to fix.
- In `.launchdoctorignore`, a bare word that names an existing file or folder is treated as a path.
- Requires Node.js 22 or newer.
- Match line numbers use cached line starts and a binary search, which is faster on large files.

### Fixed

- Middleware only counts as protecting AI routes when it actually blocks signed-out requests and covers `/api` (Supabase's `updateSession()` alone doesn't).
- The rate-limit check no longer passes on comments, `RateLimitError` handling, or a package that is installed but never imported.
- Sending an `Authorization` header to the AI provider is no longer mistaken for a user auth check.
- A global `app.use(express.json())` with no `express.raw()` is reported, because it breaks Stripe signature checks.
- Every Stripe webhook route is checked on its own; one verified webhook no longer hides an unverified one.
- DKIM records that contain only the public key (`p=...`) are recognised.
- Truncated scans (more than 20,000 files) are still sorted.
- The `--demo` temp folder is deleted even if the scan crashes.
- Every git command runs with `core.fsmonitor=false`, so scanning an untrusted folder can't make git run a program from that folder's `.git/config`.

## [0.1.0] - 2026-11-02

First release.

### Added

- `npx launch-doctor`: grades a project A-F in eight categories (secrets and keys, database and backups, payments, AI and API costs, email delivery, errors and monitoring, legal and trust, first impressions).
- Plain-English explanations and a copy-paste fix prompt for every finding, saved to `LAUNCH_FIXES.md`.
- "Check yourself" checklist items for things code can't show.
- Live DNS check of SPF, DKIM and DMARC for the sending domain.
- `--json`, `--ci`, `--offline`, `--out`, `--no-file`, `--domain` and `--demo`.
- `.launchdoctorignore` for silencing findings by id or skipping paths.
- Support for JavaScript / TypeScript and Python projects.

[Unreleased]: https://github.com/namaysingh3925/launch-doctor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/namaysingh3925/launch-doctor/releases/tag/v0.1.0
