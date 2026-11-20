import { detectAuth, detectDatabase } from '../detect.js';
import { isTestPath, type ProjectContext, type SourceFile } from '../project.js';
import type { Check, Location } from '../types.js';
import { lineAt, plural } from '../util.js';
import { appCode, at, emptyOutput, notApplicable, where } from './common.js';

// ---------- Convex ----------

/** Public Convex functions that can change data. internalMutation / internalAction can't be called from outside. */
const CONVEX_PUBLIC_WRITE = /export\s+const\s+(\w+)\s*=\s*(mutation|action)\s*\(/g;
/** Ways a Convex function finds out who is calling. */
const CONVEX_AUTH =
  /ctx\.auth\b|getAuthUserId\s*\(|getAuthSessionId\s*\(|\b(?:requireUser|requireAuth|getCurrentUser|getUserOrThrow|ensureUser|assertUser|currentUser|checkAuth|getViewer|mustGetCurrentUser|getMe)\w*\s*\(/;

const isConvexFunctionFile = (f: SourceFile) =>
  /(^|\/)convex\/(?!_generated\/).+\.[cm]?[jt]s$/.test(f.path) && !isTestPath(f.path);

/** Public mutations and actions whose body never asks who the caller is. */
function unprotectedConvexFunctions(ctx: ProjectContext): { name: string; loc: Location }[] {
  const out: { name: string; loc: Location }[] = [];
  for (const f of ctx.files.filter(isConvexFunctionFile)) {
    const code = ctx.codeOf(f);
    const starts = [...code.matchAll(/^export\s/gm)].map((m) => m.index);
    for (const m of code.matchAll(CONVEX_PUBLIC_WRITE)) {
      const next = starts.find((i) => i > m.index) ?? code.length;
      if (CONVEX_AUTH.test(code.slice(m.index, next))) continue;
      out.push({ name: m[1]!, loc: { file: f.path, line: lineAt(code, m.index) } });
    }
  }
  return out;
}

// ---------- Appwrite ----------

/** Document or collection permissions that let anyone (even signed-out visitors) write. */
const APPWRITE_OPEN = /Permission\.(write|create|update|delete)\s*\(\s*Role\.(any|guests)\s*\(\s*\)\s*\)/;
/** Update or delete rights for every signed-in user (create for everyone signed in is normal). */
const APPWRITE_USERS = /Permission\.(write|update|delete)\s*\(\s*Role\.users\s*\(\s*\)\s*\)/;
/** The same in appwrite.json (the Appwrite CLI config): "update(\"any\")". */
const APPWRITE_JSON_OPEN = /"(write|create|update|delete)\(\\"(any|guests)\\"\)"/;
const APPWRITE_JSON_USERS = /"(write|update|delete)\(\\"users\\"\)"/;
const isAppwriteConfig = (f: SourceFile) => /(^|\/)appwrite(?:\.config)?\.json$/.test(f.path);

/** Remove SQL comments but keep line numbers the same. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, '');
}

interface TableInfo {
  name: string;
  loc: Location;
}

function analyzeSupabaseSql(files: SourceFile[]) {
  const created = new Map<string, TableInfo>();
  const rls = new Set<string>();
  const policies: PolicyInfo[] = [];

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
      const open = /(?:using|with\s+check)\s*\(\s*true\s*\)/i.test(body);
      if (!open) continue;
      // No "to ..." clause means the policy applies to everyone (public).
      const rolesMatch = /\bto\s+((?:"?\w+"?\s*,\s*)*"?\w+"?)/i.exec(body);
      const roles = rolesMatch ? rolesMatch[1]!.split(',').map((r) => r.replace(/"/g, '').trim().toLowerCase()) : [];
      if (roles.length && roles.every((r) => r === 'service_role')) continue;
      const toEveryone = !roles.length || roles.some((r) => r === 'anon' || r === 'public');
      const toSignedIn = roles.includes('authenticated');
      // No "for ..." clause means FOR ALL, which includes writes.
      const writes = /\bfor\s+(all|insert|update|delete)\b/i.test(body) || !/\bfor\s+select\b/i.test(body);

      let kind: PolicyInfo['kind'] | null = null;
      if (writes && toEveryone) kind = 'open-write';
      else if (writes && toSignedIn) kind = 'signed-in-write';
      else if (!writes && toEveryone) kind = 'public-read';
      if (kind) {
        policies.push({
          kind,
          name: m[2] ?? m[3] ?? 'policy',
          table: m[4]!.toLowerCase(),
          loc: { file: file.path, line: lineAt(sql, m.index) },
        });
      }
    }
  }

  const missing = [...created.values()].filter((t) => !rls.has(t.name));
  return { created, missing, policies };
}

interface PolicyInfo {
  /** open-write: anyone can write · signed-in-write: any signed-in user can write every row · public-read: anyone can read */
  kind: 'open-write' | 'signed-in-write' | 'public-read';
  name: string;
  table: string;
  loc: Location;
}

export const databaseCheck: Check = {
  id: 'database',
  name: 'Database & backups',
  weight: 3,
  ids: [
    'supabase-rls-missing',
    'supabase-open-policy',
    'supabase-signed-in-write-policy',
    'supabase-public-read',
    'supabase-rls-dashboard',
    'firebase-open-rules',
    'firebase-rules-console',
    'convex-public-mutation',
    'appwrite-open-permission',
    'appwrite-signed-in-write',
    'appwrite-permissions-console',
    'sqlite-on-serverless',
    'prisma-db-push',
    'backups',
  ],
  run(ctx) {
    const dbs = detectDatabase(ctx);
    if (!dbs.length) return notApplicable('No database found');
    const out = emptyOutput();

    const supabaseClient = ctx.usesAny(['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs']);
    const sqlFiles = ctx.files.filter((f) => f.path.toLowerCase().endsWith('.sql'));

    // ---- Supabase Row Level Security ----
    if (supabaseClient || dbs.includes('Supabase')) {
      const { created, missing, policies } = analyzeSupabaseSql(sqlFiles);
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
          why: 'Your Supabase public (anon) key is inside your website, which is normal. But without Row Level Security, anyone holding that key can read, change or delete every row in these tables.',
          location: missing[0]!.loc,
          fixPrompt:
            `These Supabase tables don't have Row Level Security enabled: ${missing.map((t) => t.name).join(', ')}. ` +
            `Please write a new SQL migration that runs "alter table <name> enable row level security;" for each one, and add policies so signed-in users can only read and change their own rows (using auth.uid()). ` +
            `If a table is meant to be publicly readable (like a product list), add a read-only policy for it and no public write policy. Explain each policy in one plain-English sentence.`,
        });
      } else {
        out.passed.push(`Row Level Security is on for all ${plural(created.size, 'table')}`);
      }

      for (const p of policies.filter((x) => x.kind === 'open-write').slice(0, 3)) {
        out.findings.push({
          id: 'supabase-open-policy',
          severity: 'critical',
          title: `Supabase policy "${p.name}" lets anyone change the ${p.table} table`,
          why: 'This policy uses "true" as its rule, so anyone (even people who are not signed in) can add, edit or delete rows. That is as bad as having no Row Level Security at all.',
          location: p.loc,
          fixPrompt:
            `In ${where(p.loc)} the Supabase policy "${p.name}" on table "${p.table}" uses (true), so anyone can write to it. ` +
            `Please replace it with policies that only let signed-in users change their own rows (e.g. using (auth.uid() = user_id)), and keep public read access only if the data is meant to be public.`,
        });
      }
      for (const p of policies.filter((x) => x.kind === 'signed-in-write').slice(0, 3)) {
        out.findings.push({
          id: 'supabase-signed-in-write-policy',
          severity: 'warning',
          title: `Supabase policy "${p.name}": any signed-in user can change every row in ${p.table}`,
          why: 'The policy is limited to signed-in users, but its rule is "true". Anyone who creates a free account can edit or delete other people\'s rows.',
          location: p.loc,
          fixPrompt:
            `In ${where(p.loc)} the Supabase policy "${p.name}" on "${p.table}" lets any authenticated user write any row (using/with check (true)). ` +
            `Please change it so users can only change rows they own (e.g. using (auth.uid() = user_id) with check (auth.uid() = user_id)), adding a user_id column if the table needs one.`,
        });
      }
      const publicReadTables = [...new Set(policies.filter((x) => x.kind === 'public-read').map((x) => x.table))];
      for (const table of publicReadTables.slice(0, 5)) {
        out.manual.push({
          id: 'supabase-public-read',
          title: `Anyone can read every row of ${table}; make sure that is intended`,
          how: `A "for select using (true)" policy makes ${table} readable by everyone, even signed-out visitors. That's fine for things like a product list, but not for anything personal (emails, orders, messages).`,
        });
      }
    }

    // ---- Firebase security rules ----
    if (dbs.includes('Firebase')) {
      const ruleFiles = ctx.files.filter((f) =>
        /(^|\/)(firestore|storage)\.rules$|(^|\/)database\.rules\.json$|\.rules$/.test(f.path),
      );
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

    // ---- Convex: public functions that never check who is calling ----
    if (dbs.includes('Convex')) {
      const convexFiles = ctx.files.filter(isConvexFunctionFile);
      // Only an app with accounts has a "who is calling" to check; a public guestbook may write without one.
      const hasAccounts =
        !!detectAuth(ctx) ||
        ctx.uses('@convex-dev/auth') ||
        convexFiles.some((f) => /ctx\.auth\b|getAuthUserId\s*\(/.test(ctx.codeOf(f)));
      const anyPublicWrite = convexFiles.some((f) => new RegExp(CONVEX_PUBLIC_WRITE.source).test(ctx.codeOf(f)));
      const open = hasAccounts ? unprotectedConvexFunctions(ctx) : [];
      if (open.length) {
        const names = open.slice(0, 5).map((o) => o.name);
        const more = open.length > 5 ? ` and ${open.length - 5} more` : '';
        out.findings.push({
          id: 'convex-public-mutation',
          severity: 'warning',
          title: `${plural(open.length, 'Convex function')} anyone can call without signing in: ${names.join(', ')}${more}`,
          why: 'Every mutation and action exported from your convex/ folder is a public API. Your Convex URL is inside your app, so anyone can call these directly, signed in or not. These never check who is calling, so anyone can change data through them.',
          location: open[0]!.loc,
          fixPrompt:
            `These Convex functions never check who is calling: ${open.map((o) => `${o.name} (${where(o.loc)})`).join(', ')}. For each one:\n` +
            `1. At the top of the handler, add: const identity = await ctx.auth.getUserIdentity(); if (!identity) throw new Error("Not signed in");\n` +
            `2. Before changing a document, check that it belongs to the signed-in user.\n` +
            `3. If a function is only called by other Convex functions, crons or the scheduler, make it an internalMutation or internalAction instead, so it can't be called from outside.\n` +
            `Explain each change in one sentence.`,
        });
      } else if (hasAccounts && anyPublicWrite) {
        out.passed.push('Convex mutations check who is calling');
      }
    }

    // ---- Appwrite permissions ----
    if (dbs.includes('Appwrite')) {
      const inCode = (re: RegExp) => [
        ...ctx.findCode(re, appCode, 3),
        ...ctx.find(re === APPWRITE_OPEN ? APPWRITE_JSON_OPEN : APPWRITE_JSON_USERS, isAppwriteConfig, 3),
      ];
      const open = inCode(APPWRITE_OPEN);
      const signedIn = inCode(APPWRITE_USERS);
      for (const m of open.slice(0, 3)) {
        const action = m.match[1]!;
        const who = m.match[2] === 'guests' ? 'signed-out visitors' : 'anyone';
        const createOnly = action === 'create';
        out.findings.push({
          id: 'appwrite-open-permission',
          severity: createOnly ? 'warning' : 'critical',
          title: createOnly
            ? `Appwrite lets ${who} create documents (${action} for ${m.match[2]})`
            : `Appwrite lets ${who} ${action === 'write' ? 'change and delete' : action} your data`,
          why: createOnly
            ? 'Anyone, even people who are not signed in, can add documents here. Fine for something like a contact form, but bots can fill it with junk unless you add a captcha or rate limit.'
            : 'This permission is granted to "any" (or guests), so anyone on the internet can use your public project ID to change or delete these documents, without signing in.',
          location: at(m),
          fixPrompt:
            `In ${where(at(m))} an Appwrite permission gives "${action}" to Role.${m.match[2]}(). ` +
            `Please change it so only the document's owner can update or delete it (Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))), ` +
            `keep public read only if the data is meant to be public, and turn on "Document security" for the collection if documents need per-user permissions. Explain each permission in one sentence.`,
        });
      }
      for (const m of signedIn.slice(0, 3)) {
        out.findings.push({
          id: 'appwrite-signed-in-write',
          severity: 'warning',
          title: `Appwrite: any signed-in user can ${m.match[1] === 'write' ? 'change and delete' : m.match[1]} these documents`,
          why: `The permission is granted to Role.users(), which means every account. Anyone who creates a free account can edit or delete other people's documents.`,
          location: at(m),
          fixPrompt:
            `In ${where(at(m))} an Appwrite permission gives "${m.match[1]}" to Role.users(), so every signed-in user can change every document. ` +
            `Please give update and delete rights only to the owner (Role.user(userId)) when creating each document, with "Document security" turned on for the collection.`,
        });
      }
      const anyPermissions =
        ctx.findCode(/Permission\.\w+\s*\(\s*Role\./, appCode, 1).length > 0 ||
        ctx.files.some((f) => isAppwriteConfig(f) && /\$permissions|"permissions"/.test(f.content));
      if (!anyPermissions) {
        out.manual.push({
          id: 'appwrite-permissions-console',
          title: 'Check your Appwrite collection and bucket permissions',
          how: 'Open the Appwrite Console → Databases → each collection → Settings → Permissions (and Storage → each bucket). "Any" with create, update or delete lets anyone change your data; give those rights to users or to the document owner instead.',
        });
      } else if (!open.length && !signedIn.length) {
        out.passed.push("Appwrite permissions don't let anyone change other people's data");
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
        why: "That works on your laptop, but hosts like Vercel and Netlify don't keep files between requests, so saved data disappears or writes fail once you deploy. Use a hosted database, or a server with a permanent disk.",
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
        : dbs.includes('Convex')
          ? 'In the Convex dashboard → your production deployment → Backups, turn on periodic backups, then download or restore one once to be sure it works.'
          : dbs.includes('Appwrite')
            ? 'Turn on database backups in the Appwrite Console (Databases → Backups), or back up your server volumes if you host Appwrite yourself, then restore one into a test project once.'
            : 'Turn on automatic daily backups with your database host, then restore one into a test database once to prove it works.';
    out.manual.push({ id: 'backups', title: 'Turn on automatic backups and test a restore', how });

    return out;
  },
};
