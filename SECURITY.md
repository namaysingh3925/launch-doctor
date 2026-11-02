# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report them privately through GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/namaysingh3925/launch-doctor/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it (a minimal project folder is ideal) and the impact you expect.

You should get a first reply within 7 days. Once the problem is confirmed, we'll agree on a fix and a disclosure date with you, and credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

Launch Doctor is pre-1.0. Security fixes go into the latest release only.

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No |

## What counts as a security bug

Launch Doctor reads projects that may not be yours or may not be trustworthy, so these count as security bugs:

- **Code execution while scanning.** Anything that makes Launch Doctor, or a tool it starts (such as `git`), run a program or code from the scanned folder. For example: a `.git/config` hook, a crafted file name, or a file that gets evaluated.
- **Leaking secrets.** A full API key, password or token printed to the terminal, `LAUNCH_FIXES.md`, `--json`, `--sarif`, the GitHub job summary or the baseline file. Keys must always be masked.
- **Unexpected network access.** Any request other than the documented email DNS lookups, or any of your code or findings being sent anywhere.
- **Writing outside the expected places.** Files written anywhere other than `LAUNCH_FIXES.md`, the `--out` / `--sarif` targets, `.launchdoctor-baseline.json`, the files created by `init`, or the `GITHUB_STEP_SUMMARY` file. This includes path traversal through crafted file names.
- **Denial of service.** A small, crafted project that makes a scan hang or use huge amounts of memory.

These are **not** security bugs (please open a normal issue instead):

- Launch Doctor missing a problem in your app (a false negative), or flagging something that's fine (a false positive). Use the *False positive* or *Bug report* issue templates.
- Vulnerabilities in the apps Launch Doctor scans. Launch Doctor's job is to point those out, not to fix them.
