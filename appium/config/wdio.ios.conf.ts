// ─────────────────────────────────────────────────────────────────────────────
// DAZN PPV — WebdriverIO config for iOS (XCUITest)
//
// Supports two modes controlled by IOS_DEVICE_MODE env var:
//
//   IOS_DEVICE_MODE=simulator (default)
//   ─────────────────────────────────
//   - iPhone 16 Pro simulator (iOS 18)
//   - Appium auto-launched via @wdio/appium-service
//   - Set IOS_UDID to override the simulator UDID
//   - Set DAZN_BUNDLE_ID to override bundle (default: com.dazn.enterprise)
//
//   IOS_DEVICE_MODE=real
//   ─────────────────────
//   - Real iPhone (iOS 26.5)
//   - Set IOS_UDID            REQUIRED — your device UDID (e.g. 00008110-0006605E3A89401E)
//   - Set IOS_PLATFORM_VER    (default: 26.5)
//   - Set DAZN_BUNDLE_ID      (default: com.dazn.theApp)
//   - Set IOS_XCODE_ORG_ID    (default: 579UJ5S27U)
//   - Set IOS_WDA_URL         (optional) — if pre-built WDA running, e.g. http://localhost:8100
//                              If not set, Appium builds WDA on first run (~2 min)
//
// PRE-REQUISITES (real device):
//   1. iPhone trusted on this Mac (tap "Trust" on device)
//   2. DAZN app installed on the device
//   3. Appium running: npx appium (in a separate terminal)
//   4. xcodeOrgId must match your Apple Developer team
//
// QUICK START (new device):
//   IOS_DEVICE_MODE=real IOS_UDID=<your-udid> npx wdio run appium/config/wdio.ios.conf.ts
//
// QUICK START (pre-built WDA):
//   IOS_DEVICE_MODE=real IOS_UDID=<udid> IOS_WDA_URL=http://localhost:8100 npx wdio run appium/config/wdio.ios.conf.ts
// ─────────────────────────────────────────────────────────────────────────────
const MODE = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase();
const IS_REAL = MODE === 'real';

// ── Shared ────────────────────────────────────────────────────────────────────
const BUNDLE_ID = process.env.DAZN_BUNDLE_ID || (IS_REAL ? 'com.dazn.theApp' : 'com.dazn.enterprise');
const IPA_PATH  = process.env.DAZN_IPA_PATH  || '';

// ── Simulator defaults ────────────────────────────────────────────────────────
const SIM_UDID           = process.env.IOS_UDID           || '2BA2D104-D63D-4E22-8E15-7E1FA9B9E26C';
const SIM_PLATFORM_VER   = process.env.IOS_PLATFORM_VER   || '18';

// ── Real device defaults ──────────────────────────────────────────────────────
const REAL_UDID          = process.env.IOS_UDID            || '00008140-00044D501EC2801C';
const REAL_PLATFORM_VER  = process.env.IOS_PLATFORM_VER   || '26.5';
const REAL_WDA_URL       = process.env.IOS_WDA_URL         || '';
const REAL_XCODE_ORG_ID  = process.env.IOS_XCODE_ORG_ID   || '579UJ5S27U';
const REAL_WDA_BUNDLE_ID = process.env.IOS_WDA_BUNDLE_ID  || 'com.dazn.test.WebDriverAgentRunner';

// ── Capabilities ─────────────────────────────────────────────────────────────
const simulatorCaps = {
  platformName: 'iOS',
  'appium:deviceName': 'iPhone 16 Pro',
  'appium:platformVersion': SIM_PLATFORM_VER,
  'appium:automationName': 'XCUITest',
  'appium:udid': SIM_UDID,
  'appium:bundleId': BUNDLE_ID,
  ...(IPA_PATH ? { 'appium:app': IPA_PATH } : {}),
  'appium:noReset': true,
  'appium:fullReset': false,
  'appium:newCommandTimeout': 120,
  'appium:wdaLaunchTimeout': 60000,
  'appium:wdaConnectionTimeout': 60000,
  'appium:simulatorStartupTimeout': 120000,
  'appium:autoAcceptAlerts': false,
  'appium:autoDismissAlerts': false,
  // The iOS PPV handoff leaves DAZN and opens Safari.  Expose Safari's
  // WebKit context so the same Appium/WebdriverIO session can continue the
  // browser flow after the Apple external-website confirmation.
  'appium:includeSafariInWebviews': true,
  'appium:webviewConnectRetries': 15,
  'appium:webviewConnectTimeout': 5000,
  // Do not let one loading/blank Safari WebView block the whole handoff.
  // The page objects poll contexts explicitly after these bounded failures.
  'appium:webkitResponseTimeout': 5000,
  'appium:webviewAtomWaitTimeout': 10000,
};

// Use pre-built WDA only when an explicit URL is provided.
// If IOS_WDA_URL is not set, Appium will build WDA fresh (slower first run, needed for new devices).
const USE_PREBUILT_WDA = !!REAL_WDA_URL && REAL_WDA_URL !== 'none';

const realDeviceCaps: Record<string, unknown> = {
  platformName: 'iOS',
  'appium:deviceName': 'iPhone',
  'appium:platformVersion': REAL_PLATFORM_VER,
  'appium:automationName': 'XCUITest',
  'appium:udid': REAL_UDID,
  'appium:bundleId': BUNDLE_ID,
  'appium:noReset': true,
  'appium:forceAppLaunch': true,
  // Xcode signing (required for WDA on real device)
  'appium:xcodeOrgId': REAL_XCODE_ORG_ID,
  'appium:xcodeSigningId': 'Apple Development',
  'appium:updatedWDABundleId': REAL_WDA_BUNDLE_ID,
  // Speed up element commands: default idle wait adds ~10s per lookup on real devices
  'appium:waitForIdleTimeout': 1,
  'appium:autoDismissAlerts': false,
  // Allow switching into SFSafariViewController / WKWebView contexts
  'appium:includeSafariInWebviews': true,
  'appium:webviewConnectRetries': 15,
  'appium:webviewConnectTimeout': 5000,
  // A real-device Safari WebKit command can otherwise wait until Mocha's
  // overall test timeout while the new private tab is still connecting.
  'appium:webkitResponseTimeout': 5000,
  'appium:webviewAtomWaitTimeout': 10000,
  'appium:showXcodeLog': true,
  'appium:newCommandTimeout': 120,
  // A frozen externally managed WDA must fail within a bounded time instead
  // of holding the entire iOS flow until Mocha's global timeout.
  'appium:wdaConnectionTimeout': Number(process.env.IOS_WDA_CONNECTION_TIMEOUT_MS || 60000),
  'appium:commandTimeouts': process.env.IOS_WDA_COMMAND_TIMEOUTS || '{"findElement":60000,"findElements":60000,"default":60000}',
  // WDA — use pre-built if URL provided, otherwise Appium builds it (needed for new devices)
  'appium:usePrebuiltWDA': USE_PREBUILT_WDA,
  ...(USE_PREBUILT_WDA ? { 'appium:webDriverAgentUrl': REAL_WDA_URL } : {}),
  // Enable MJPEG server for reliable real-device screen recording via ffmpeg
  // (no iOS screen-recording permission needed on the device)
  'appium:mjpegServerPort': Number(process.env.IOS_MJPEG_PORT || 9100),
};

export const config = {
  runner: 'local',
  tsConfigPath: './tsconfig.json',
  hostname: '127.0.0.1',
  port: Number(process.env.APPIUM_PORT || 4723),

  specs: ['../tests/ios/*.spec.ts'],
  exclude: [],
  maxInstances: 1,

  capabilities: [IS_REAL ? realDeviceCaps : simulatorCaps],

  // Only auto-launch Appium in simulator mode.
  // Real device uses a pre-running WDA — starting another Appium server here
  // would conflict with the WDA process.
  services: IS_REAL
    ? []
    : [
        [
          '@wdio/appium-service',
          {
            command: 'appium',
            args: {
              address: '127.0.0.1',
              port: 4723,
              relaxedSecurity: true,
            },
          },
        ],
      ],

  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 600000,
  },
};
