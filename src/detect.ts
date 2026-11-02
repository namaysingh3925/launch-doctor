import type { ProjectContext } from './project.js';
import { appCode } from './checks/common.js';

/** Returns the auth provider name if the app has user accounts. */
export function detectAuth(ctx: ProjectContext): string | null {
  const libs: [string, string][] = [
    ['next-auth', 'NextAuth'], ['@auth/', 'Auth.js'], ['@clerk/', 'Clerk'], ['better-auth', 'Better Auth'],
    ['lucia', 'Lucia'], ['@kinde-oss/', 'Kinde'], ['@auth0/', 'Auth0'], ['passport', 'Passport'],
    ['@workos-inc/', 'WorkOS'], ['@stackframe/', 'Stack Auth'], ['@privy-io/', 'Privy'],
  ];
  for (const [pkg, label] of libs) if (ctx.uses(pkg)) return label;
  if (
    ctx.usesAny(['@supabase/supabase-js', '@supabase/ssr', '@supabase/auth-helpers-nextjs']) &&
    ctx.find(/\.auth\.(?:signUp|signInWith\w+|getUser|getSession|onAuthStateChange)\s*\(/, appCode, 1).length
  ) {
    return 'Supabase Auth';
  }
  if (ctx.usesAny(['firebase', 'firebase-admin']) && ctx.find(/\bgetAuth\s*\(|signInWith\w+\s*\(|createUserWith\w+\s*\(/, appCode, 1).length) {
    return 'Firebase Auth';
  }
  return null;
}

export function detectDatabase(ctx: ProjectContext): string[] {
  const dbs: [string, string][] = [
    ['@supabase/supabase-js', 'Supabase'], ['@supabase/ssr', 'Supabase'], ['firebase', 'Firebase'],
    ['firebase-admin', 'Firebase'], ['@prisma/client', 'Prisma'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'],
    ['mongoose', 'MongoDB'], ['mongodb', 'MongoDB'], ['pg', 'Postgres'], ['postgres', 'Postgres'],
    ['mysql2', 'MySQL'], ['@neondatabase/serverless', 'Neon'], ['@planetscale/database', 'PlanetScale'],
    ['@libsql/client', 'Turso'], ['better-sqlite3', 'SQLite'], ['sqlite3', 'SQLite'], ['convex', 'Convex'],
    ['@vercel/postgres', 'Vercel Postgres'], ['typeorm', 'TypeORM'], ['sequelize', 'Sequelize'], ['knex', 'Knex'],
    ['sqlalchemy', 'SQLAlchemy'],
  ];
  const out: string[] = [];
  for (const [pkg, label] of dbs) if (ctx.uses(pkg) && !out.includes(label)) out.push(label);
  if (!out.includes('Prisma') && ctx.hasPath(/(^|\/)schema\.prisma$/)) out.push('Prisma');
  if (!out.includes('Supabase') && ctx.hasPath(/^supabase\/migrations\//)) out.push('Supabase');
  return out;
}

export function detectPayments(ctx: ProjectContext): boolean {
  return (
    ctx.usesAny([
      'stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', 'razorpay', '@lemonsqueezy/lemonsqueezy.js',
      '@paddle/paddle-node-sdk', '@paddle/paddle-js', '@polar-sh/sdk', 'dodopayments', '@paypal/react-paypal-js',
      '@paypal/paypal-js', '@paypal/checkout-server-sdk', 'cashfree-pg', '@cashfreepayments/cashfree-js',
    ]) || ctx.find(/https:\/\/buy\.stripe\.com\/|checkout\.razorpay\.com/, appCode, 1).length > 0
  );
}

/** Analytics that set cookies (cookieless tools like Plausible are left out on purpose). */
export function detectCookieAnalytics(ctx: ProjectContext): boolean {
  return (
    ctx.usesAny([
      'posthog-js', 'mixpanel-browser', '@segment/analytics-next', 'react-ga4', 'react-ga', '@next/third-parties',
      '@amplitude/analytics-browser', '@hotjar/browser', 'react-hotjar', '@microsoft/clarity',
    ]) || ctx.find(/googletagmanager\.com|gtag\s*\(\s*['"]config|clarity\.ms|static\.hotjar\.com/, appCode, 1).length > 0
  );
}

export function detectEmailProviders(ctx: ProjectContext): string[] {
  const libs: [string, string][] = [
    ['resend', 'Resend'], ['nodemailer', 'Nodemailer'], ['@sendgrid/mail', 'SendGrid'], ['postmark', 'Postmark'],
    ['mailgun.js', 'Mailgun'], ['mailgun-js', 'Mailgun'], ['@aws-sdk/client-ses', 'Amazon SES'],
    ['@aws-sdk/client-sesv2', 'Amazon SES'], ['@getbrevo/brevo', 'Brevo'], ['sib-api-v3-sdk', 'Brevo'],
    ['loops', 'Loops'], ['mailersend', 'MailerSend'], ['@mailchimp/mailchimp_transactional', 'Mailchimp'],
    ['@react-email/components', 'React Email'], ['@plunk/node', 'Plunk'],
  ];
  const out: string[] = [];
  for (const [pkg, label] of libs) if (ctx.uses(pkg) && !out.includes(label)) out.push(label);
  if (!out.length && ctx.find(/api\.resend\.com|api\.sendgrid\.com|api\.postmarkapp\.com|api\.mailgun\.net/, appCode, 1).length) {
    out.push('an email API');
  }
  return out;
}

/** Common ways code checks who the user is. */
export const AUTH_CHECK_RE =
  /getServerSession|\bauth\s*\(\s*\)|currentUser\s*\(|getAuth\s*\(|\.getUser\s*\(|getSession\s*\(|verifyIdToken|verifyToken|jwtVerify|jwt\.verify|clerkClient|withAuth|requireAuth|requireUser|isAuthenticated|ensureAuth|session\?\.user|session\.user|req\.user|request\.user|ctx\.user|locals\.user|validateRequest|getKindeServerSession|getToken\s*\(/;
