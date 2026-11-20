import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/index.js';
import type { Finding, Report } from '../src/types.js';
import { category, fakeKey, ids, makeProject } from './helpers.js';

const opts = { offline: true, useGit: false };

const find = (report: Report, id: string): Finding | undefined =>
  report.categories.flatMap((c) => c.findings).find((f) => f.id === id);
const manualIds = (report: Report) => report.categories.flatMap((c) => c.manual.map((m) => m.id));

/** A typical create-expo-app project: Expo Router, react-dom and react-native-web for its web build. */
const expoPackage = (extra: Record<string, string> = {}) =>
  JSON.stringify({
    name: 'pocket-app',
    main: 'expo-router/entry',
    dependencies: {
      expo: '~54.0.0',
      'expo-router': '~6.0.0',
      react: '19.1.0',
      'react-dom': '19.1.0',
      'react-native': '0.81.0',
      'react-native-web': '~0.21.0',
      ...extra,
    },
  });

const appJson = (expo: Record<string, unknown>) =>
  JSON.stringify({ expo: { name: 'Pocket', slug: 'pocket', ...expo } });

test('an Expo app gets mobile checks, not website checks', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': expoPackage(),
      'app.json': appJson({ ios: { bundleIdentifier: 'com.pocketco.app' }, android: { package: 'com.pocketco.app' } }),
      'app/_layout.tsx': 'export default function Layout() { return null; }\n',
      'app/index.tsx': 'export default function Home() { return null; }\n',
    }),
    opts,
  );
  const fi = category(report, 'first-impressions');
  assert.equal(fi.applicable, true);
  assert.ok(!ids(report).includes('no-description'), 'no meta descriptions for an app');
  assert.ok(!ids(report).includes('no-social-preview'));
  const manual = manualIds(report);
  assert.ok(manual.includes('device-test'));
  assert.ok(manual.includes('store-listing'));
  assert.ok(manual.includes('store-privacy-labels'));
  assert.ok(!manual.includes('phone-test'));
  assert.ok(!manual.includes('robots-sitemap'));
  assert.ok(!ids(report).includes('mobile-placeholder-app-id'), 'a real app id passes');
});

test('keys in mobile app code ship inside the app; the backend folder does not', async () => {
  const testKey = fakeKey('sk_' + 'test_', 30, 31);
  const report = await runDoctor(
    makeProject({
      'package.json': expoPackage({ stripe: '18' }),
      'app.json': appJson({}),
      'src/pay.ts': `export const stripeKey = "${testKey}";\n`,
      'server/index.ts': `import express from "express";\nconst key = "${fakeKey('sk_' + 'test_', 30, 32)}";\napp.listen(3000);\n`,
    }),
    opts,
  );
  const found = report.categories
    .flatMap((c) => c.findings)
    .filter((f) => f.id === 'stripe-test-key')
    .map((f) => [f.location?.file, f.severity]);
  assert.deepEqual(found.sort(), [
    ['server/index.ts', 'warning'],
    ['src/pay.ts', 'critical'],
  ]);
  const inApp = report.categories.flatMap((c) => c.findings).find((f) => f.location?.file === 'src/pay.ts');
  assert.match(inApp!.why, /built into your app/);
});

test('EXPO_PUBLIC_ secrets are explained as built into the app', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': expoPackage(),
      'app.json': appJson({}),
      'src/ai.ts': 'const key = process.env.EXPO_PUBLIC_OPENAI_API_KEY;\n',
    }),
    opts,
  );
  const f = find(report, 'public-secret-variable');
  assert.equal(f?.severity, 'critical');
  assert.match(f!.why, /EXPO_PUBLIC_ is built into your app/);
});

test('placeholder app ids, cleartext traffic and turned-off iOS HTTPS checks are found', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': expoPackage(),
      'app.json': appJson({
        ios: {
          bundleIdentifier: 'com.anonymous.pocket',
          infoPlist: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } },
        },
        android: { package: 'com.anonymous.pocket', usesCleartextTraffic: true },
      }),
    }),
    opts,
  );
  assert.match(find(report, 'mobile-placeholder-app-id')!.title, /com\.anonymous\.pocket/);
  assert.equal(find(report, 'android-cleartext-traffic')?.location?.file, 'app.json');
  assert.equal(find(report, 'ios-arbitrary-loads')?.location?.file, 'app.json');
});

test('native projects: Info.plist is read, the debug AndroidManifest is not', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': JSON.stringify({ name: 'bare-rn', dependencies: { 'react-native': '0.81.0', react: '19.1.0' } }),
      'ios/BareRn/Info.plist':
        '<?xml version="1.0"?>\n<plist><dict>\n<key>NSAppTransportSecurity</key>\n<dict>\n<key>NSAllowsArbitraryLoads</key>\n<true/>\n</dict>\n</dict></plist>\n',
      'android/app/src/debug/AndroidManifest.xml':
        '<manifest><application android:usesCleartextTraffic="true" /></manifest>\n',
      'android/app/src/main/AndroidManifest.xml': '<manifest><application android:label="BareRn" /></manifest>\n',
      'App.tsx': 'export default function App() { return null; }\n',
    }),
    opts,
  );
  assert.equal(find(report, 'ios-arbitrary-loads')?.location?.file, 'ios/BareRn/Info.plist');
  assert.ok(!ids(report).includes('android-cleartext-traffic'), 'debug builds may use http');
});

test('development addresses left in the app are found, __DEV__ ones are not', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': expoPackage(),
      'app.json': appJson({}),
      'src/api.ts':
        'export const API = "http://10.0.2.2:3000/api";\nexport const LOCAL = __DEV__ ? "http://192.168.1.20:3000" : "https://api.pocket.app";\n',
    }),
    opts,
  );
  const f = find(report, 'hardcoded-localhost');
  assert.match(f!.title, /http:\/\/10\.0\.2\.2:3000/);
  assert.doesNotMatch(f!.title, /in \d+ places/);
});

test('mobile monitoring: crash reporting and the store dashboards', async () => {
  const bare = await runDoctor(makeProject({ 'package.json': expoPackage(), 'app.json': appJson({}) }), opts);
  assert.equal(find(bare, 'no-error-tracking')?.title, 'No crash reporting');
  assert.match(find(bare, 'no-error-tracking')!.fixPrompt, /@sentry\/react-native/);
  assert.ok(manualIds(bare).includes('store-crash-reports'));
  assert.ok(!manualIds(bare).includes('uptime-monitor'), 'no website to watch');

  const withSentry = await runDoctor(
    makeProject({ 'package.json': expoPackage({ '@sentry/react-native': '7' }), 'app.json': appJson({}) }),
    opts,
  );
  assert.ok(!ids(withSentry).includes('no-error-tracking'));
});

test('every store app needs a privacy policy link, even one that collects nothing', async () => {
  const without = await runDoctor(makeProject({ 'package.json': expoPackage(), 'app.json': appJson({}) }), opts);
  assert.equal(find(without, 'no-privacy-policy')?.title, 'No privacy policy link in the app');

  const linked = await runDoctor(
    makeProject({
      'package.json': expoPackage(),
      'app.json': appJson({}),
      'app/settings.tsx': 'Linking.openURL("https://pocket.app/privacy");\n',
    }),
    opts,
  );
  assert.ok(!ids(linked).includes('no-privacy-policy'));
});

test('a monorepo with a website and a mobile app gets both sets of checks', async () => {
  const report = await runDoctor(
    makeProject({
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({
        name: 'web',
        dependencies: { next: '16', react: '19', 'react-dom': '19' },
      }),
      'apps/web/app/page.tsx': 'export default function Page() { return null; }\n',
      'apps/web/lib/billing.ts': `export const key = "${fakeKey('sk_' + 'test_', 30, 41)}";\n`,
      'apps/mobile/package.json': expoPackage(),
      'apps/mobile/app.json': appJson({}),
      'apps/mobile/src/billing.ts': `export const key = "${fakeKey('sk_' + 'test_', 30, 42)}";\n`,
    }),
    opts,
  );
  const severity = (file: string) =>
    report.categories.flatMap((c) => c.findings).find((f) => f.location?.file === file)?.severity;
  assert.equal(severity('apps/web/lib/billing.ts'), 'warning', 'web server code does not ship to users');
  assert.equal(severity('apps/mobile/src/billing.ts'), 'critical', 'mobile code does');
  const manual = manualIds(report);
  assert.ok(manual.includes('phone-test'), 'website checks still run');
  assert.ok(manual.includes('device-test'), 'and mobile checks too');
});
