import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSensitivePublicName } from '../src/checks/secrets.js';
import { overall, toGrade } from '../src/grade.js';
import { matchesGitignore, packageNameOf } from '../src/project.js';
import type { CategoryResult, Finding } from '../src/types.js';
import { decodeJwtPayload, lineAt, looksLikePlaceholder, mask } from '../src/util.js';
import { fakeJwt, fakeKey } from './helpers.js';

test('placeholders are recognised, realistic keys are not', () => {
  assert.equal(looksLikePlaceholder('sk_' + 'live_' + 'x'.repeat(24)), true);
  assert.equal(looksLikePlaceholder('sk-your-openai-key-goes-here-123'), true);
  assert.equal(looksLikePlaceholder('sk_live_' + 'a'.repeat(30)), true);
  assert.equal(looksLikePlaceholder(fakeKey('sk_' + 'live_', 28)), false);
});

test('mask keeps only the start and end of a secret', () => {
  const key = fakeKey('sk_' + 'live_', 28);
  const masked = mask(key);
  assert.ok(masked.startsWith(key.slice(0, 8)));
  assert.ok(masked.endsWith(key.slice(-4)));
  assert.ok(masked.length < 15);
});

test('JWT payloads are decoded', () => {
  assert.equal(decodeJwtPayload(fakeJwt({ role: 'service_role' }))?.role, 'service_role');
  assert.equal(decodeJwtPayload(fakeJwt({ role: 'anon' }))?.role, 'anon');
  assert.equal(decodeJwtPayload('not.a.jwt'), null);
});

test('public variable names: secrets flagged, safe values allowed', () => {
  assert.equal(isSensitivePublicName('OPENAI_API_KEY'), true);
  assert.equal(isSensitivePublicName('SUPABASE_SERVICE_ROLE_KEY'), true);
  assert.equal(isSensitivePublicName('STRIPE_SECRET_KEY'), true);
  assert.equal(isSensitivePublicName('DATABASE_URL'), true);
  assert.equal(isSensitivePublicName('SUPABASE_ANON_KEY'), false);
  assert.equal(isSensitivePublicName('STRIPE_PUBLISHABLE_KEY'), false);
  assert.equal(isSensitivePublicName('OPENAI_ASSISTANT_ID'), false);
  assert.equal(isSensitivePublicName('SUPABASE_URL'), false);
});

test('package names are pulled out of import paths', () => {
  assert.equal(packageNameOf('openai'), 'openai');
  assert.equal(packageNameOf('@supabase/supabase-js'), '@supabase/supabase-js');
  assert.equal(packageNameOf('@sentry/nextjs/client'), '@sentry/nextjs');
  assert.equal(packageNameOf('npm:openai@4.2.0'), 'openai');
  assert.equal(packageNameOf('https://esm.sh/@supabase/supabase-js@2'), '@supabase/supabase-js');
  assert.equal(packageNameOf('./local'), null);
  assert.equal(packageNameOf('node:fs'), null);
});

test('gitignore fallback matching', () => {
  assert.equal(matchesGitignore('.env', '.env'), true);
  assert.equal(matchesGitignore('.env*', '.env.local'), true);
  assert.equal(matchesGitignore('*.local', '.env'), false); // the classic Vite gap
  assert.equal(matchesGitignore('.env*\n!.env.example', '.env.example'), false);
  assert.equal(matchesGitignore('/apps/web/.env', 'apps/web/.env'), true);
  assert.equal(matchesGitignore('.env', 'apps/web/.env'), true);
});

test('line numbers', () => {
  assert.equal(lineAt('a\nb\nc', 0), 1);
  assert.equal(lineAt('a\nb\nc', 4), 3);
});

function cat(id: string, weight: number, findings: Finding['severity'][]): CategoryResult {
  const fs: Finding[] = findings.map((severity, i) => ({ id: `${id}-${i}`, severity, title: '', why: '', fixPrompt: '' }));
  const score = Math.max(0, 100 - 50 * findings.filter((s) => s === 'critical').length - 15 * findings.filter((s) => s === 'warning').length);
  return { id, name: id, icon: '', weight, applicable: true, findings: fs, passed: [], manual: [], score, grade: toGrade(score) };
}

test('grading: A only when clean, any critical blocks a good grade', () => {
  assert.equal(overall([cat('a', 3, []), cat('b', 1, [])]).grade, 'A');
  assert.equal(overall([cat('a', 3, []), cat('b', 1, ['warning'])]).grade, 'B');
  assert.equal(overall([cat('a', 3, ['critical']), cat('b', 1, [])]).grade, 'D');
  assert.equal(overall([cat('a', 3, ['critical', 'critical', 'critical'])]).grade, 'F');
  assert.match(overall([cat('a', 1, ['critical', 'critical'])]).verdict, /fix 2 critical issues/);
});
