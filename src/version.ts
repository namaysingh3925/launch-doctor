import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** Version from package.json (works from both src/ and dist/src/). */
export function version(): string {
  if (cached) return cached;
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (pkg.name === 'launch-doctor' && typeof pkg.version === 'string') {
        cached = pkg.version as string;
        return cached;
      }
    } catch {
      // try the next location
    }
  }
  cached = '0.0.0';
  return cached;
}
