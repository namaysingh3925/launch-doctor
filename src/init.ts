import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The same workflow as the README's "CI integration" example. */
export const WORKFLOW_TEMPLATE = `name: Launch Doctor
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
`;

export const IGNORE_TEMPLATE = `# .launchdoctorignore: things Launch Doctor should leave alone.
# One entry per line. Lines starting with # are comments.

# Finding ids (each fix in LAUNCH_FIXES.md shows its id). For example:
# no-error-tracking
# no-account-deletion

# Folders or files to skip (anything with / * or . is a path):
# legacy/
# scripts/seed.ts
# **/*.fixture.ts

# To silence one finding in one place, add a comment on that line or the line above:
#   // launch-doctor-ignore stripe-test-key
`;

export interface InitResult {
  created: string[];
  skipped: string[];
}

/** Create the starter files in `root`. Existing files are never overwritten. */
export function runInit(root: string): InitResult {
  const files: [string, string][] = [
    ['.launchdoctorignore', IGNORE_TEMPLATE],
    ['.github/workflows/launch-doctor.yml', WORKFLOW_TEMPLATE],
  ];
  const result: InitResult = { created: [], skipped: [] };
  for (const [rel, content] of files) {
    const full = join(root, rel);
    if (existsSync(full)) {
      result.skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, { flag: 'wx' });
    result.created.push(rel);
  }
  return result;
}
