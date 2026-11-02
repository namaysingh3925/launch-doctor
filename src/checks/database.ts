import { detectDatabase } from '../detect.js';
import type { SourceFile } from '../project.js';
import type { Check, Location } from '../types.js';
import { lineAt, plural } from '../util.js';
import { emptyOutput, notApplicable, where } from './common.js';

/** Remove SQL comments but keep line numbers the same. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
}

interface TableInfo {
  name: string;
  loc: Location;
}

function analyzeSupabaseSql(files: SourceFile[]) {
  const created = new Map<string, TableInfo>();
  const rls = new Set<string>();
  const openPolicies: { name: string; table: string; loc: Location }[] = [];

  for (const file of files) {
    const sql = stripSqlComments(file.content);

    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql))) {
      const schema = (m[1] ?? 'public').toLowerCase();
      if (schema !== 'public') continue;
      const name = m[2]!.toLowerCase();
      if (!created.has(name)) created.set(name, { name, loc: { file: file.path, line: lineAt(sql, m.index) } });
    }

    const dropRe = /drop\s+table\s+(?:if\s+exists\s+)?(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?/gi;
    while ((m = dropRe.exec(sql))) created.delete(m[2]!.toLowerCase());

    // Track enable/disable in order, so a later "disable" wins.
    const rlsRe =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s+(enable|disable)\s+row\s+level\s+security/gi;
    while ((m = rlsRe.exec(sql))) {
      const name = m[2]!.toLowerCase();
      if (m[3]!.toLowerCase() === 'enable') rls.add(name);
      else rls.delete(name);
    }

    const policyRe = /create\s+policy\s+("([^"]+)"|(\w+))\s+on\s+(?:"?\w+"?\s*\.\s*)?"?(\w+)"?([\s\S]*?);/gi;
    while ((m = policyRe.exec(sql))) {
      const body = m[5] ?? '';
      const writes = /\bfor\s+(all|insert|update|delete)\b/i.test(body) || !/\bfor\s+select\b/i.test(body);
      const open = /(?:using|with\s+check)\s*\(\s*true\s*\)/i.test(body);
      const anyone = !/\bto\s+(service_role|authenticated)\b/i.test(body);
      if (writes && open && anyone) {
        openPolicies.push({
          name: m[2] ?? m[3] ?? 'policy',
          table: m[4]!.toLowerCase(),
          loc: { file: file.path, line: lineAt(sql, m.index) },
        });
      }
    }
  }

  const missing = [...created.values()].filter((t) => !rls.has(t.name));
  return { created, missing, openPolicies };
}

export const databaseCheck: Check = {
  id: 'database',
  name: 'Database & backups',
  icon: '💾',
  weight: 3,
  run(ctx) {
    const dbs = detectDatabase(ctx);
    if (!dbs.length) return notApplicable('No database found');
    const out = emptyOutput();

    const supabaseClient = ctx.usesAny(['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs']);
    const sqlFiles = ctx.files.filter((f) => f.path.toLowerCase().endsWith('.sql'));

    // ---- Supabase Row Level Security ----
    if (supabaseClient || dbs.includes('Supabase')) {
      const { created, missing, openPolicies } = analyzeSupabaseSql(sqlFiles);
      if (!created.size) {
        out.manual.push({
          id: 'supabase-rls-dashboard',
          title: 'Turn on Row Level Security for every Supabase table',
          how: 'Open Supabase → Table Editor. Every table should show "RLS enabled", with policies so people can only see their own data. Without RLS, anyone with your public key can read and change every row.',
        });
      } else if (missing.length) {
        const names = missing.slice(0, 6).map((t) => t.name);
        const more = missing.length > 6 ? ` and ${missing.length - 6} more` : '';
        out.findings.push({
          id: 'supabase-rls-missing',
          severity: 'critical',
          title: `${plural(missing.length, 'Supabase table')} without Row Level Security: ${names.join(', ')}${more}`,
          why: "Your Supabase public (anon) key is inside your website, which is normal. But without Row Level Security, anyone holding that key can read, change or delete every row in these tables.",
          location: missing[0]!.loc,
          fixPrompt:
            `These Supabase tables don't have Row Level Security enabled: ${missing.map((t) => t.name).join(', ')}. ` +
            `Please write a new SQL migration that runs "alter table <name> enable row level security;" for each one, and add policies so signed-in users can only read and change their own rows (using auth.uid()). ` +
            `If a table is meant to be publicly readable (like a product list), add a read-only policy for it and no public write policy. Explain each policy in one plain-English sentence.`,
        });
      } else {
        out.passed.push(`Row Level Security is on for all ${plural(created.size, 'table')}`);
      }

      for (const p of openPolicies.slice(0, 3)) {
        out.findings.push({
          id: 'supabase-open-policy',
          severity: 'warning',
          title: `Supabase policy "${p.name}" lets anyone change the ${p.table} table`,
          why: 'This policy uses "true" as its rule, which means anyone — even people who are not signed in — can add, edit or delete rows. RLS is switched on, but this policy opens the door again.',
          location: p.loc,
          fixPrompt:
            `In ${where(p.loc)} the Supabase policy "${p.name}" on table "${p.table}" uses (true), so anyone can write to it. ` +
            `Please replace it with policies that only let signed-in users change their own rows (e.g. using (auth.uid() = user_id)), and keep public read access only if the data is meant to be public.`,
        });
      }
    }

    // ---- Firebase security rules ----
    if (dbs.includes('Firebase')) {
      const ruleFiles = ctx.files.filter((f) => /(^|\/)(firestore|storage)\.rules$|(^|\/)database\.rules\.json$|\.rules$/.test(f.path));
      let openFound = false;
      for (const f of ruleFiles) {
        const testMode = /request\.time\s*<\s*timestamp\.date\s*\(/.exec(f.content);
        // Any rule that allows writing (write/create/update/delete) to everyone.
        const openAll =
          /allow\s+[\w\s,]*\b(?:write|create|update|delete)\b[\w\s,]*:\s*if\s+true\s*;|allow\s+[\w\s,]*\b(?:write|create|update|delete)\b[\w\s,]*;/.exec(
            f.content,
          );
        const rtdbOpen = f.path.endsWith('.json') ? /"\.write"\s*:\s*true/.exec(f.content) : null;
        const hit = testMode ?? openAll ?? rtdbOpen;
        if (!hit) continue;
        openFound = true;
        const loc = { file: f.path, line: lineAt(f.content, hit.index) };
        out.findings.push({
          id: 'firebase-open-rules',
          severity: 'critical',
          title: testMode ? 'Firebase is still in "test mode"' : 'Firebase rules let anyone write to your database',
          why: testMode
            ? 'Test-mode rules let anyone on the internet read and change all your data until the date runs out — then your app suddenly stops working for everyone.'
            : 'These rules allow anyone, even people who are not signed in, to change or delete your data.',
          location: loc,
          fixPrompt:
            `My Firebase security rules in ${where(loc)} are wide open${testMode ? ' (test mode with a date)' : ''}. ` +
            `Please rewrite them so only signed-in users can read and write their own documents (match on request.auth.uid), public data is read-only, and everything else is denied by default. ` +
            `Explain each rule in plain English and tell me how to test them with the Firebase Emulator before deploying.`,
        });
      }
      if (!ruleFiles.length) {
        out.manual.push({
          id: 'firebase-rules-console',
          title: 'Check your Firebase security rules',
          how: 'Open Firebase Console → Firestore/Storage → Rules. If they say "allow read, write: if true" or have a request.time date, your data is open to everyone.',
        });
      } else if (!openFound) {
        out.passed.push('Firebase security rules are not wide open');
      }
    }

    // ---- SQLite on serverless hosting ----
    const prismaSqlite = ctx.find(/provider\s*=\s*"sqlite"/, (f) => f.path.endsWith('.prisma'), 1)[0];
    const sqliteLib = ctx.usesAny(['better-sqlite3', 'sqlite3']);
    const serverless = ctx.uses('next') || ctx.hasPath(/(^|\/)(vercel\.json|netlify\.toml)$/);
    if ((prismaSqlite || sqliteLib) && serverless) {
      const loc = prismaSqlite ? { file: prismaSqlite.file.path, line: prismaSqlite.line } : undefined;
      out.findings.push({
        id: 'sqlite-on-serverless',
        severity: 'warning',
        title: 'Your database is a file on disk (SQLite)',
        why: 'That works on your laptop, but hosts like Vercel and Netlify don\'t keep files between requests, so saved data disappears or writes fail once you deploy. Use a hosted database, or a server with a permanent disk.',
        location: loc,
        fixPrompt:
          `My app uses SQLite (a database stored in a file)${loc ? ` — see ${where(loc)}` : ''}, and I want to deploy it to serverless hosting like Vercel. ` +
          `Help me switch to a hosted database (for example Neon or Supabase Postgres, or Turso if I want to stay with SQLite). ` +
          `Update the database config and environment variables, create proper migrations, and explain how to copy my existing data across.`,
      });
    }

    // ---- Risky schema changes ----
    if (dbs.includes('Prisma')) {
      const usesDbPush = ctx.scripts.some((s) => /prisma\s+db\s+push/.test(s));
      const dataLoss = ctx.scripts.some((s) => /--accept-data-loss/.test(s));
      const hasMigrations = ctx.hasPath(/(^|\/)prisma\/migrations\//);
      if (dataLoss || (usesDbPush && !hasMigrations)) {
        out.findings.push({
          id: 'prisma-db-push',
          severity: 'warning',
          title: dataLoss
            ? 'Your scripts run database changes with --accept-data-loss'
            : 'Database changes use "prisma db push" instead of migrations',
          why: '"db push" changes your live database to match your code, and can silently delete columns and the data in them. Migrations keep a history and let you review changes before they hit real data.',
          location: { file: 'package.json' },
          fixPrompt:
            `My project changes the database with "prisma db push"${dataLoss ? ' and --accept-data-loss' : ''}. Before launch I want safe migrations instead. ` +
            `Please create a baseline migration from my current schema with "prisma migrate dev", update my package.json scripts to use "prisma migrate deploy" in production, ` +
            `remove --accept-data-loss, and explain the new workflow for changing the schema later.`,
        });
      } else if (hasMigrations) {
        out.passed.push('Database changes are tracked with migrations');
      }
    }

    // ---- Backups (can't be seen from code) ----
    const how = dbs.includes('Supabase')
      ? 'In Supabase → Database → Backups, check that backups exist for your plan (free projects may not include them). Download or restore one once to be sure it works.'
      : dbs.includes('Firebase')
        ? 'Turn on scheduled Firestore backups (Google Cloud → Firestore → Disaster recovery), then restore one into a test project once.'
        : 'Turn on automatic daily backups with your database host, then restore one into a test database once to prove it works.';
    out.manual.push({ id: 'backups', title: 'Turn on automatic backups and test a restore', how });

    return out;
  },
};
