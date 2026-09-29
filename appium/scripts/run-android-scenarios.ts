import { spawnSync } from 'child_process';
import path from 'path';

/**
 * Runs selected desktop-web and native-Android PPV sources sequentially.
 * Android sessions must remain sequential on one connected device.
 *
 * Example:
 *   WEB_SOURCES=landing-page-banner,search ANDROID_SOURCES=landing-page-banner,home-page-banner npm run selected:scenarios
 */
function requestedSources(environmentVariable: string, fallback = ''): string[] {
  const raw = process.env[environmentVariable] || fallback;
  return (raw || '').split(',').map(source => source.trim().toLowerCase()).filter(Boolean);
}

const rootDirectory = path.resolve(__dirname, '../..');
const appiumDirectory = path.resolve(__dirname, '..');
const webSources = requestedSources('WEB_SOURCES');
// SOURCES remains an Android-only alias for the previously added command.
const androidSources = requestedSources('ANDROID_SOURCES', process.env.SOURCES || '');

if (webSources.length === 0 && androidSources.length === 0) {
  console.error('No scenarios selected. For example:');
  console.error('  WEB_SOURCES=landing-page-banner,search ANDROID_SOURCES=landing-page-banner,home-page-banner npm --prefix appium run selected:scenarios');
  process.exit(2);
}

const failures: string[] = [];

function runScenarios(label: string, sources: string[], command: string, args: string[], cwd: string): void {
  if (sources.length === 0) return;
  console.log(`\nRunning ${sources.length} ${label} scenario(s): ${sources.join(', ')}`);

  for (const [index, source] of sources.entries()) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`${label} ${index + 1}/${sources.length}: SOURCE=${source}`);
    console.log(`${'═'.repeat(72)}\n`);

    const result = spawnSync(command, args, {
      cwd,
      env: { ...process.env, SOURCE: source },
      stdio: 'inherit',
      shell: false,
    });

    if (result.error || result.status !== 0) {
      failures.push(`${label}:${source}`);
      console.error(`\n❌ ${label} scenario failed: ${source}`);
    } else {
      console.log(`\n✅ ${label} scenario passed: ${source}`);
    }
  }
}

runScenarios(
  'Desktop web',
  webSources,
  'npx',
  ['playwright', 'test', process.env.WEB_SCENARIO_SPEC || 'tests/new_user/newuser.ppv.spec.ts', '--project=' + (process.env.WEB_PROJECT || 'chromium')],
  rootDirectory,
);

runScenarios(
  'Native Android → web handoff',
  androidSources,
  'npx',
  ['wdio', 'run', 'config/wdio.android.conf.ts', '--spec', process.env.ANDROID_SCENARIO_SPEC || 'tests/android/ppv.handoff.spec.ts'],
  appiumDirectory,
);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} selected scenario(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('\n✅ All selected desktop-web and native-Android scenarios passed.');
