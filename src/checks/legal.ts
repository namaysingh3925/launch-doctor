import { detectAuth, detectCookieAnalytics, detectDatabase, detectEmailProviders, detectPayments } from '../detect.js';
import { isCodeFile, type ProjectContext } from '../project.js';
import type { Check } from '../types.js';
import { appCode, emptyOutput, notApplicable } from './common.js';

const POLICY_SERVICES = /iubenda\.com|termly\.io|termsfeed\.com|getterms\.io|privacypolicies\.com|termageddon\.com/;

/** Is there a page (file or link) for one of these words? */
function hasPage(ctx: ProjectContext, words: string[]): boolean {
  const alt = words.join('|');
  const pathRe = new RegExp(`(^|/|-|_)(${alt})([/._-]|$)`, 'i');
  if (ctx.paths.some((p) => pathRe.test(p) && (isCodeFile(p) || /\.(md|mdx|html|txt|pdf)$/i.test(p)))) return true;
  const linkRe = new RegExp(`["'\`(]/(?:[\\w-]+/)*(?:${alt})[\\w-]*\\b`, 'i');
  return ctx.find(linkRe, appCode, 1).length > 0;
}

export const legalCheck: Check = {
  id: 'legal',
  name: 'Legal & trust',
  icon: '📜',
  weight: 1,
  ids: ['no-privacy-policy', 'no-terms', 'no-refund-policy', 'no-contact', 'no-account-deletion', 'cookie-consent'],
  run(ctx) {
    if (!ctx.isWebApp) return notApplicable('Not a web app');
    const out = emptyOutput();

    const auth = detectAuth(ctx);
    const payments = detectPayments(ctx);
    const collectsData =
      !!auth || payments || detectDatabase(ctx).length > 0 || detectEmailProviders(ctx).length > 0 || detectCookieAnalytics(ctx);
    const policyService = ctx.find(POLICY_SERVICES, appCode, 1).length > 0;

    const hasPrivacy = policyService || hasPage(ctx, ['privacy', 'privacy-policy', 'privacypolicy', 'datenschutz']);
    const hasTerms = policyService || hasPage(ctx, ['terms', 'tos', 'terms-of-service', 'terms-and-conditions', 'terms-of-use']);
    const hasRefund = hasPage(ctx, ['refund', 'refunds', 'refund-policy', 'cancellation', 'cancellation-policy', 'returns']);
    const hasContact = hasPage(ctx, ['contact', 'contact-us']) || ctx.find(/mailto:/, appCode, 1).length > 0;

    if (collectsData) {
      if (hasPrivacy) out.passed.push('Has a privacy policy');
      else {
        out.findings.push({
          id: 'no-privacy-policy',
          severity: 'warning',
          title: 'No privacy policy page',
          why: "Your app collects personal data (accounts, emails, payments or analytics). Privacy laws like GDPR and India's DPDP Act expect a privacy policy, and Google sign-in, Stripe and app stores ask for one.",
          fixPrompt:
            'Create a /privacy page for my app with a clear, plain-English privacy policy. Base it on what the code actually does: list what personal data is collected, ' +
            'which third-party services receive it (look at my dependencies, e.g. auth, database, email, analytics, payments), how long it is kept, and how users can ask for deletion. ' +
            "Link it from the footer and the sign-up form. Add a note that I should have it reviewed, since you're not a lawyer.",
        });
      }
    }

    if (payments || auth) {
      if (hasTerms) out.passed.push('Has terms of service');
      else {
        out.findings.push({
          id: 'no-terms',
          severity: 'warning',
          title: 'No terms of service page',
          why: 'Terms set the rules: what people may do with your app, what you are and aren\'t responsible for, and when you can close an account. Payment providers usually expect them too.',
          fixPrompt:
            'Create a /terms page with simple terms of service for my app (acceptable use, accounts, payments and refunds if any, limitation of liability, how I can change the terms, contact email). ' +
            "Keep it short and readable, link it in the footer and sign-up form, and remind me to get it reviewed.",
        });
      }
    }

    if (payments) {
      if (hasRefund) out.passed.push('Has a refund / cancellation policy');
      else {
        out.findings.push({
          id: 'no-refund-policy',
          severity: 'warning',
          title: 'No refund or cancellation policy',
          why: 'Payment providers (Razorpay in particular) require a refund/cancellation policy on your site before turning on live payments, and a clear policy means fewer angry chargebacks.',
          fixPrompt:
            'Create a /refund page with a clear refund and cancellation policy for my app (how to cancel, whether and when refunds are given, how long they take, contact email). Link it from the footer and the checkout/pricing page.',
        });
      }
      if (hasContact) out.passed.push('Has a way to contact you');
      else {
        out.findings.push({
          id: 'no-contact',
          severity: 'warning',
          title: 'No contact page or email',
          why: "People paying you need a way to reach you. Without one they go straight to a chargeback, and payment providers may refuse to activate your account.",
          fixPrompt: 'Add a simple /contact page (or a footer link) with a support email address, and link it from the footer and pricing page.',
        });
      }
    }

    if (auth) {
      const canDelete = ctx.find(
        /delete.{0,3}account|deleteAccount|deleteUser|admin\.deleteUser|delete.{0,3}my.{0,3}(?:account|data)|close.{0,3}account|remove.{0,3}account/i,
        appCode,
        1,
      ).length > 0;
      if (canDelete) out.passed.push('Users can delete their account');
      else {
        out.findings.push({
          id: 'no-account-deletion',
          severity: 'warning',
          title: "Users can't delete their account",
          why: "Privacy laws give people the right to have their data deleted, and the Apple and Google app stores require an in-app way to delete accounts.",
          fixPrompt:
            `Add a "Delete my account" option to the settings page of my app (auth: ${auth}). It should ask for confirmation, delete the user's data and their auth account on the server, ` +
            'sign them out, and cancel any active subscription. Do the deletion in server-side code, not in the browser.',
        });
      }
    }

    if (detectCookieAnalytics(ctx)) {
      out.manual.push({
        id: 'cookie-consent',
        title: 'Ask for cookie consent if you have visitors from Europe or the UK',
        how: 'Your analytics sets cookies. In the EU/UK you need consent before loading it — or switch to a cookieless tool like Plausible or Vercel Analytics.',
      });
    }

    if (!collectsData && !payments && !auth) {
      out.passed.push("Your app doesn't seem to collect personal data");
    }

    return out;
  },
};
