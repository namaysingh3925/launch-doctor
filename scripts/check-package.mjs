// Fails if the npm tarball would contain anything besides the built CLI and the docs.
// Run with: node scripts/check-package.mjs
import { execSync } from 'node:child_process';

const ALLOWED = [/^dist\/src\//, /^README\.md$/, /^LICENSE$/, /^CHANGELOG\.md$/, /^package\.json$/];

// A fixed command string (no user input), so it works the same on Windows and Unix.
const out = execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' });
const [pack] = JSON.parse(out);
const files = pack.files.map((f) => f.path.replace(/\\/g, '/'));

const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
const missing = ['dist/src/cli.js', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'].filter(
  (f) => !files.includes(f),
);

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes packed`);
if (unexpected.length || missing.length) {
  if (unexpected.length) console.error(`Unexpected files in the package:\n  ${unexpected.join('\n  ')}`);
  if (missing.length) console.error(`Missing from the package:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('Package contents look right.');
