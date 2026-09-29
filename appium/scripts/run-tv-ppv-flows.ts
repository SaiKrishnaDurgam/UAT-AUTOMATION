import { spawnSync } from 'child_process';
import path from 'path';

type FlowConfig = {
  name: string;
  tvTarget: string;
  source: string;
};

function flowListFromEnv(): FlowConfig[] {
  const fireTvSource = (process.env.FIRETV_SOURCE || 'home-page-banner').toLowerCase();
  const androidTvSharedSource = (process.env.ANDROIDTV_SHARED_SOURCE || 'schedule').toLowerCase();
  const androidTvNewSource = (process.env.ANDROIDTV_NEW_SOURCE || 'search').toLowerCase();

  return [
    { name: 'firetv-existing-flow', tvTarget: 'firetv', source: fireTvSource },
    { name: 'androidtv-existing-flow', tvTarget: 'androidtv', source: androidTvSharedSource },
    { name: 'androidtv-new-flow', tvTarget: 'androidtv', source: androidTvNewSource },
  ];
}

const appiumDirectory = path.resolve(__dirname, '..');
const flows = flowListFromEnv();
const failures: string[] = [];

console.log(`Running ${flows.length} TV PPV flow(s)...`);

for (const [index, flow] of flows.entries()) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`TV flow ${index + 1}/${flows.length}: ${flow.name}`);
  console.log(`TV_TARGET=${flow.tvTarget} SOURCE=${flow.source}`);
  console.log(`${'═'.repeat(72)}\n`);

  const result = spawnSync(
    'npx',
    ['wdio', 'run', 'config/wdio.android.conf.ts', '--spec', 'tests/android/tv.ppv.spec.ts'],
    {
      cwd: appiumDirectory,
      env: {
        ...process.env,
        TV_TARGET: flow.tvTarget,
        SOURCE: flow.source,
      },
      stdio: 'inherit',
      shell: false,
    },
  );

  if (result.error || result.status !== 0) {
    failures.push(flow.name);
    console.error(`❌ Failed: ${flow.name}`);
  } else {
    console.log(`✅ Passed: ${flow.name}`);
  }
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} TV PPV flow(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('\n✅ All TV PPV flows completed successfully.');
