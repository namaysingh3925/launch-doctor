import type { Check } from '../types.js';
import { appCode, emptyOutput, notApplicable } from './common.js';

const TRACKERS: [string, string][] = [
  ['@sentry/', 'Sentry'],
  ['posthog-js', 'PostHog'],
  ['posthog-node', 'PostHog'],
  ['@bugsnag/', 'Bugsnag'],
  ['logrocket', 'LogRocket'],
  ['@highlight-run/', 'Highlight'],
  ['highlight.run', 'Highlight'],
  ['@datadog/browser-rum', 'Datadog'],
  ['@datadog/browser-logs', 'Datadog'],
  ['dd-trace', 'Datadog'],
  ['rollbar', 'Rollbar'],
  ['@rollbar/', 'Rollbar'],
  ['@honeybadger-io/', 'Honeybadger'],
  ['@axiomhq/', 'Axiom'],
  ['@logtail/', 'Better Stack'],
  ['@betterstack/', 'Better Stack'],
  ['@baselime/', 'Baselime'],
  ['trackjs', 'TrackJS'],
  ['raygun4js', 'Raygun'],
  ['@appsignal/', 'AppSignal'],
  ['newrelic', 'New Relic'],
  ['@newrelic/', 'New Relic'],
  ['@vercel/otel', 'OpenTelemetry'],
  ['@opentelemetry/sdk-node', 'OpenTelemetry'],
  ['elastic-apm-node', 'Elastic APM'],
  // Mobile (React Native / Expo)
  ['sentry-expo', 'Sentry'],
  ['@react-native-firebase/crashlytics', 'Firebase Crashlytics'],
  ['instabug-reactnative', 'Instabug'],
  ['@datadog/mobile-react-native', 'Datadog'],
  ['@embrace-io/', 'Embrace'],
  ['posthog-react-native', 'PostHog'],
];

export const monitoringCheck: Check = {
  id: 'monitoring',
  name: 'Errors & monitoring',
  weight: 1,
  ids: ['no-error-tracking', 'no-error-boundary', 'uptime-monitor', 'know-your-logs', 'store-crash-reports'],
  run(ctx) {
    if (!ctx.isWebApp && !ctx.isMobileApp) return notApplicable('Not a web app');
    const out = emptyOutput();
    // An app with no website: crash reports and store dashboards matter, uptime pages don't.
    const mobileOnly = ctx.isMobileApp && !ctx.isWebApp;

    const tracker = TRACKERS.find(([pkg]) => ctx.uses(pkg))?.[1];
    if (tracker) {
      out.passed.push(`Error tracking is set up (${tracker})`);
    } else {
      out.findings.push({
        id: 'no-error-tracking',
        severity: 'warning',
        title: mobileOnly ? 'No crash reporting' : 'No error tracking',
        why: mobileOnly
          ? "When your app crashes on someone's phone, you won't know unless they leave a one-star review. Most people just uninstall."
          : "When your app breaks for a user, you won't know unless they bother to tell you. Most people don't — they just leave.",
        fixPrompt: mobileOnly
          ? 'Add crash reporting to my React Native / Expo app with Sentry (@sentry/react-native; for Expo, add its config plugin in app.json). ' +
            'Upload source maps during the build (EAS Build or the native build) so stack traces point at my code, keep the DSN in config, ' +
            "make sure it doesn't send passwords or personal data, and add a temporary test crash I can trigger once to confirm reports arrive. Then remove the test."
          : 'Add error tracking to my app with Sentry (it has a free plan). Set it up for both the frontend and the backend / API routes, keep the DSN in an environment variable, ' +
            "make sure it doesn't send passwords or personal data, and add a temporary test error I can trigger once to confirm errors show up in Sentry. Then remove the test.",
      });
    }

    // Friendly crash screen instead of a blank white page
    if (ctx.uses('react') || ctx.uses('next')) {
      const nextAppRouter = ctx.hasPath(/(^|\/)app\/(?:.*\/)?page\.(?:t|j)sx?$/);
      let hasBoundary: boolean;
      if (nextAppRouter) {
        hasBoundary = ctx.hasPath(/(^|\/)app\/(?:.*\/)?(?:error|global-error)\.(?:t|j)sx?$/);
      } else if (ctx.uses('next')) {
        hasBoundary = ctx.hasPath(/(^|\/)pages\/(?:_error|500)\.(?:t|j)sx?$/);
      } else {
        hasBoundary =
          ctx.uses('react-error-boundary') ||
          ctx.findCode(/ErrorBoundary|componentDidCatch|errorElement\s*[:=]/, appCode, 1).length > 0;
      }
      if (hasBoundary) {
        out.passed.push('Crashes show an error screen instead of a blank page');
      } else {
        out.findings.push({
          id: 'no-error-boundary',
          severity: 'warning',
          title: 'No friendly error screen',
          why: mobileOnly
            ? 'If one screen of a React Native app crashes, the whole app closes or shows a blank screen. An error screen shows "Something went wrong — try again" instead.'
            : 'If one part of a React app crashes, the whole page goes blank white. An error screen shows "Something went wrong — try again" and keeps the rest of the app usable.',
          fixPrompt: mobileOnly
            ? 'Add an error screen to my React Native app: with Expo Router, export an ErrorBoundary from app/_layout.tsx (it receives the error and a retry function); otherwise wrap the root component with react-error-boundary. Show a friendly "Something went wrong" message with a "Try again" button, and send the error to my crash reporter if I have one.'
            : nextAppRouter || ctx.uses('next')
              ? 'Add error pages to my Next.js app: an app/error.tsx with a friendly "Something went wrong" message and a "Try again" button that calls reset(), plus an app/global-error.tsx for crashes in the root layout. Send the error to my error tracker if I have one.'
              : 'Add a React error boundary to my app (the react-error-boundary package is fine) around the main routes, showing a friendly "Something went wrong" message with a "Try again" button instead of a blank page. Send the error to my error tracker if I have one.',
        });
      }
    }

    if (ctx.isMobileApp) {
      out.manual.push({
        id: 'store-crash-reports',
        title: 'Know where the app stores show your crashes',
        how: 'App Store Connect (TestFlight → Crashes, and Xcode Organizer) and Google Play Console → Android vitals list crashes and freezes. Look there before every release, not only after bad reviews.',
      });
    }
    if (mobileOnly) return out;

    out.manual.push(
      {
        id: 'uptime-monitor',
        title: 'Set up a free uptime monitor',
        how: 'UptimeRobot or Better Stack can check your site every few minutes and text or email you when it goes down.',
      },
      {
        id: 'know-your-logs',
        title: 'Know where to find your server logs',
        how: 'Find the logs page for your host (Vercel → Logs, Netlify → Functions, Supabase → Logs) before something breaks, not during.',
      },
    );

    return out;
  },
};
