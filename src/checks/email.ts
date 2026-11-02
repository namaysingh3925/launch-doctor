import { Resolver } from 'node:dns/promises';
import { detectAuth, detectEmailProviders } from '../detect.js';
import { isEnvPath, type Match, type ProjectContext } from '../project.js';
import type { Check, CheckOutput } from '../types.js';
import { mostCommon } from '../util.js';
import { appCode, at, emptyOutput, notApplicable } from './common.js';

const IGNORED_DOMAINS = new Set([
  'resend.dev',
  'example.com',
  'example.org',
  'example.net',
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'test.com',
  'yourdomain.com',
  'domain.com',
  'mydomain.com',
  'acme.com',
  'company.com',
  'email.com',
  'mail.com',
  'localhost',
  'sendgrid.net',
  'users.noreply.github.com',
]);

const DKIM_SELECTORS = [
  'resend',
  'google',
  'default',
  's1',
  's2',
  'k1',
  'k2',
  'k3',
  'selector1',
  'selector2',
  'mail',
  'dkim',
  'smtp',
  'mailjet',
  'mandrill',
  'zoho',
  'mxvault',
  'sig1',
  'pm',
  'brevo1',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/;

interface Sender {
  email: string;
  domain: string;
  match: Match;
}

function collectSenders(ctx: ProjectContext): Sender[] {
  const out: Sender[] = [];
  const add = (m: Match, text: string) => {
    const e = EMAIL_RE.exec(text);
    if (e) out.push({ email: e[0], domain: e[1]!.toLowerCase(), match: m });
  };
  for (const m of ctx.find(/\bfrom\s*:\s*[`'"]([^`'"\n]{3,120})[`'"]/, appCode)) add(m, m.match[1]!);
  for (const m of ctx.find(
    /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:FROM|SENDER)[A-Z0-9_]*[ \t]*=[ \t]*['"]?([^\n'"#]+)/m,
    (f) => isEnvPath(f.path),
  )) {
    add(m, m.match[1]!);
  }
  return out;
}

type TxtResult = string[] | 'missing' | 'error';

async function txt(resolver: DnsLike, name: string): Promise<TxtResult> {
  try {
    const records = await resolver.resolveTxt(name);
    return records.map((chunks) => chunks.join(''));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') return 'missing';
    return 'error';
  }
}

export interface EmailDnsResult {
  offline: boolean;
  /** The domain itself doesn't exist (no NS records, ENOTFOUND). */
  notFound: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

/** The two DNS calls we need; a real Resolver, or a fake one in tests. */
export interface DnsLike {
  resolveNs(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export async function checkEmailDns(
  domain: string,
  resolver: DnsLike = new Resolver({ timeout: 3000, tries: 2 }),
): Promise<EmailDnsResult> {
  // Does the domain exist at all? A typo should give one clear message, not three missing records.
  try {
    await resolver.resolveNs(domain);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'NXDOMAIN') {
      return { offline: false, notFound: true, spf: false, dkim: false, dmarc: false };
    }
    // ENODATA (e.g. a subdomain without its own NS records) or a network error: carry on.
  }
  const [root, sendSub, dmarc, ...dkim] = await Promise.all([
    txt(resolver, domain),
    txt(resolver, `send.${domain}`),
    txt(resolver, `_dmarc.${domain}`),
    ...DKIM_SELECTORS.map((s) => txt(resolver, `${s}._domainkey.${domain}`)),
  ]);
  const all = [root, sendSub, dmarc, ...dkim];
  if (all.every((r) => r === 'error')) return { offline: true, notFound: false, spf: false, dkim: false, dmarc: false };
  const has = (r: TxtResult | undefined, re: RegExp) => Array.isArray(r) && r.some((v) => re.test(v));
  return {
    offline: false,
    notFound: false,
    spf: has(root, /^v=spf1/i) || has(sendSub, /^v=spf1/i),
    dmarc: has(dmarc, /^v=DMARC1/i),
    dkim: dkim.some((r) => has(r, /v=DKIM1|k=rsa|\bp=/i)),
  };
}

/** Providers that usually publish SPF on a separate return-path (bounce) subdomain, not the root. */
const RETURN_PATH_PROVIDERS = ['Amazon SES', 'Postmark', 'SendGrid'];

/** Turn DNS results into findings, passes and checklist items. */
export function applyEmailDns(out: CheckOutput, domain: string, dns: EmailDnsResult, providers: string[]): void {
  if (dns.offline) {
    out.manual.push({
      id: 'email-dns',
      title: `Check the email DNS records for ${domain}`,
      how: "Couldn't reach DNS (are you offline?). Your email provider's dashboard should show SPF, DKIM and DMARC as verified.",
    });
    return;
  }
  if (dns.notFound) {
    out.findings.push({
      id: 'email-domain-not-found',
      severity: 'warning',
      title: `Domain ${domain} was not found in DNS - check the spelling`,
      why: "Email can't be sent from, or delivered for, a domain that doesn't exist. Either the domain in your \"from\" address has a typo, or it hasn't been registered yet.",
      fixPrompt: `My app sends email from the domain ${domain}, but that domain doesn't exist in DNS. Find every place the sender address or domain is set (code and environment variables), check it for typos, and tell me what the correct domain should be.`,
    });
    return;
  }
  if (dns.spf) out.passed.push(`${domain} has an SPF record`);
  else {
    const returnPath = providers.find((p) => RETURN_PATH_PROVIDERS.includes(p));
    if (returnPath) {
      out.manual.push({
        id: 'email-spf-return-path',
        title: `Check SPF for ${domain} in your ${returnPath} dashboard`,
        how: `${returnPath} usually puts SPF on a separate return-path (bounce) subdomain, so a missing SPF record on ${domain} itself can be normal. Make sure ${returnPath} shows the domain as fully verified.`,
      });
    } else {
      out.findings.push({
        id: 'email-no-spf',
        severity: 'warning',
        title: `${domain} has no SPF record`,
        why: 'SPF tells Gmail and Outlook which services may send email for your domain. Without it, your sign-up and password-reset emails are likely to land in spam.',
        fixPrompt: `My domain ${domain} has no SPF DNS record. Tell me exactly which TXT record to add for my email provider (${providers.join(', ') || 'my email service'}), where to add it at my domain registrar, and how to check it worked.`,
      });
    }
  }
  if (dns.dmarc) out.passed.push(`${domain} has a DMARC record`);
  else {
    out.findings.push({
      id: 'email-no-dmarc',
      severity: 'warning',
      title: `${domain} has no DMARC record`,
      why: 'Gmail and Yahoo now expect a DMARC record from domains that send email. Without one, more of your emails get rejected or marked as spam, and others can pretend to be you.',
      fixPrompt: `My domain ${domain} has no DMARC record. Give me a safe starter DMARC TXT record for _dmarc.${domain} (starting with p=none and a reporting address), explain what it does, and when I should tighten it to p=quarantine.`,
    });
  }
  if (dns.dkim) out.passed.push(`${domain} has a DKIM key`);
  else {
    out.manual.push({
      id: 'email-dkim',
      title: `Check that DKIM is set up for ${domain}`,
      how: "We couldn't find a DKIM key under common names. Your email provider's dashboard should show the domain as verified; if not, add the DKIM records it gives you.",
    });
  }
}

export const emailCheck: Check = {
  id: 'email',
  name: 'Email delivery',
  weight: 1,
  ids: [
    'email-test-sender',
    'email-personal-gmail',
    'email-domain-not-found',
    'email-no-spf',
    'email-spf-return-path',
    'email-no-dmarc',
    'email-dkim',
    'email-dns',
    'supabase-smtp',
    'email-real-inbox',
  ],
  async run(ctx) {
    const providers = detectEmailProviders(ctx);
    // Supabase Auth sends confirmation and password-reset emails on its own.
    const supabaseAuthEmails = detectAuth(ctx) === 'Supabase Auth';

    if (!providers.length && !supabaseAuthEmails) return notApplicable("Your app doesn't send email");
    const out = emptyOutput();

    const senders = collectSenders(ctx);

    const testSender = senders.find((s) => s.domain === 'resend.dev');
    if (testSender) {
      out.findings.push({
        id: 'email-test-sender',
        severity: 'warning',
        title: `Emails are sent from Resend's test address (${testSender.email})`,
        why: "Resend's onboarding@resend.dev address only delivers to your own account email. Real users won't receive anything.",
        location: at(testSender.match),
        fixPrompt:
          `My app sends email from ${testSender.email}, which is Resend's test address. Please change the "from" address to use my own domain ` +
          `(read it from an EMAIL_FROM environment variable, e.g. "My App <hello@mydomain.com>"), and walk me through verifying my domain in Resend (adding the DNS records it shows).`,
      });
    }

    const gmail =
      ctx.find(/smtp\.gmail\.com|service\s*:\s*["']gmail["']/i, appCode, 1)[0] ??
      senders.find((s) => s.domain === 'gmail.com' || s.domain === 'googlemail.com')?.match;
    if (gmail) {
      out.findings.push({
        id: 'email-personal-gmail',
        severity: 'warning',
        title: 'Emails are sent through a personal Gmail account',
        why: 'Gmail limits how many emails you can send per day, and messages from a personal address look untrustworthy and often land in spam.',
        location: at(gmail),
        fixPrompt:
          'My app sends email through a personal Gmail account. Please switch it to a transactional email service (for example Resend, Postmark or Amazon SES) sending from my own domain, ' +
          'keep the API key in an environment variable, and tell me which DNS records (SPF, DKIM, DMARC) to add so emails reach the inbox.',
      });
    }

    const detected = mostCommon(senders.map((s) => s.domain).filter((d) => !IGNORED_DOMAINS.has(d)));
    const domain = ctx.options.domain ?? detected;

    if (domain && !ctx.options.offline) {
      applyEmailDns(out, domain, await checkEmailDns(domain), providers);
    } else {
      out.manual.push({
        id: 'email-dns',
        title: 'Set up SPF, DKIM and DMARC for the domain you send email from',
        how: domain
          ? `Your email provider's dashboard lists the DNS records to add for ${domain}.`
          : 'Run launch-doctor again with --domain yourdomain.com to check these automatically.',
      });
    }

    if (supabaseAuthEmails) {
      out.manual.push({
        id: 'supabase-smtp',
        title: 'Set up custom SMTP for Supabase Auth emails',
        how: "Supabase's built-in email sender is for testing only and is heavily rate-limited, so sign-up and password-reset emails stop arriving once real users show up. Add your own SMTP (e.g. Resend) in Supabase → Authentication → Emails.",
      });
    }

    out.manual.push({
      id: 'email-real-inbox',
      title: 'Send yourself every email from the live app',
      how: "Sign up, reset your password and trigger every notification using a real Gmail and Outlook address. Check they arrive, aren't in spam, and the links work.",
    });

    return out;
  },
};
