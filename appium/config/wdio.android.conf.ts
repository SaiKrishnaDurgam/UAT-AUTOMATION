// ─────────────────────────────────────────────────────────────────────────────
// DAZN PPV — WebdriverIO config for ANDROID (UiAutomator2)
//
// Works with ANY connected Android device — deviceName and platformVersion
// are auto-detected via ADB at runtime (no hardcoding needed).
//
// FLOW:
//   1. Connects to first ADB-authorised device (or DEVICE_SERIAL env var)
//   2. Launches DAZN app (already installed & logged in)
//   3. Android test navigates PPV flow and captures checkout URL
//
// PRE-REQUISITES:
//   - Device connected via USB with ADB authorised (run: adb devices)
//   - DAZN app installed and user already logged in (noReset: true)
//   - Appium 3.x installed globally
//
// HOW TO RUN:
//   cd appium && npm run android
//
// ENV VARS (all optional):
//   DEVICE_SERIAL    : ADB serial (auto-detected if only one device connected)
//   APP_PACKAGE      : DAZN app package  (default: com.dazn.beta)
//   APP_ACTIVITY     : Launch activity   (default: com.dazn.splash.view.SplashScreenActivity)
// ─────────────────────────────────────────────────────────────────────────────

import { execSync, spawn, ChildProcess } from 'child_process';

let appiumProcess: ChildProcess | null = null;
let appiumCommand = 'appium';
try {
  const detected = execSync('which appium', { encoding: 'utf8' }).trim();
  if (detected) {
    appiumCommand = detected;
  }
} catch {}

const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB         = `${ANDROID_SDK}/platform-tools/adb`;
const APPIUM_PORT = Number(process.env.APPIUM_PORT || '4723');
const SYSTEM_PORT = Number(process.env.APPIUM_SYSTEM_PORT || '8200');
const CHROMEDRIVER_PORT = Number(process.env.CHROMEDRIVER_PORT || '9515');
const TV_TARGET = (process.env.TV_TARGET || '').trim().toLowerCase();
const argvJoined = process.argv.join(' ');
const IS_TV_SPEC_RUN = argvJoined.includes('tv.ppv.spec.ts');
const EFFECTIVE_TV_TARGET = IS_TV_SPEC_RUN ? TV_TARGET : '';

// AndroidTV profile defaults (can be overridden with env vars).
const ANDROIDTV_PROFILE_DEFAULTS = {
  platformVersion: '11',
  deviceName: 'Android TV at 172.26.90.26',
  udid: '172.26.90.26:5555',
  automationName: 'UiAutomator2',
};

const FIRETV_PROFILE_DEFAULTS = {
  platformVersion: '11',
  deviceName: 'Fire TV at 172.26.81.184',
  udid: '172.26.81.184:5555',
  automationName: 'UiAutomator2',
};

// Export ANDROID_HOME at module level so Appium server inherits it
process.env.ANDROID_HOME     = ANDROID_SDK;
process.env.ANDROID_SDK_ROOT = ANDROID_SDK;
process.env.ADB_PATH         = ADB;

// ── Auto-detect device info via ADB ──────────────────────────────────────────
function adbShell(serial: string, cmd: string): string {
  try {
    return execSync(`${ADB} -s ${serial} ${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim();
  } catch {
    return '';
  }
}

function getConnectedDevices(): string[] {
  try {
    const out = execSync(`${ADB} devices`, { encoding: 'utf8', timeout: 10000 });
    return out
      .split('\n')
      .slice(1)
      .filter(l => l.includes('\tdevice'))
      .map(l => l.split('\t')[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Pick device: explicit DEVICE_SERIAL first, then TV-target-specific serial,
// else the first connected Android device.
const devices    = getConnectedDevices();
const targetSerial =
  EFFECTIVE_TV_TARGET === 'firetv'
    ? (process.env.FIRETV_SERIAL || FIRETV_PROFILE_DEFAULTS.udid)
    : EFFECTIVE_TV_TARGET === 'androidtv'
      ? (process.env.ANDROIDTV_SERIAL || ANDROIDTV_PROFILE_DEFAULTS.udid)
      : '';
const serial     = process.env.DEVICE_SERIAL || targetSerial || devices[0] || '';

if (!serial) {
  console.warn('⚠️  No Android device detected via ADB. Ensure USB debugging is enabled and run: adb devices');
}

// Read device model name (e.g. "SM_G990E" → "SM G990E")
const rawModel   = serial ? adbShell(serial, 'shell getprop ro.product.model') : '';
const targetDeviceName =
  EFFECTIVE_TV_TARGET === 'firetv'
    ? (process.env.FIRETV_DEVICE_NAME || FIRETV_PROFILE_DEFAULTS.deviceName)
    : EFFECTIVE_TV_TARGET === 'androidtv'
      ? (process.env.ANDROIDTV_DEVICE_NAME || ANDROIDTV_PROFILE_DEFAULTS.deviceName)
      : '';
const deviceName = process.env.DEVICE_NAME || targetDeviceName || rawModel || 'Android Device';

// Read Android OS version (e.g. "15", "14", "13")
const rawVersion       = serial ? adbShell(serial, 'shell getprop ro.build.version.release') : '';
const targetPlatformVersion =
  EFFECTIVE_TV_TARGET === 'firetv'
    ? (process.env.FIRETV_PLATFORM_VERSION || FIRETV_PROFILE_DEFAULTS.platformVersion)
    :
  EFFECTIVE_TV_TARGET === 'androidtv'
    ? (process.env.ANDROIDTV_PLATFORM_VERSION || ANDROIDTV_PROFILE_DEFAULTS.platformVersion)
    : '';
const platformVersion  = process.env.PLATFORM_VERSION || targetPlatformVersion || rawVersion || '';
const automationName =
  EFFECTIVE_TV_TARGET === 'firetv'
    ? (process.env.FIRETV_AUTOMATION_NAME || FIRETV_PROFILE_DEFAULTS.automationName)
    :
  EFFECTIVE_TV_TARGET === 'androidtv'
    ? (process.env.ANDROIDTV_AUTOMATION_NAME || ANDROIDTV_PROFILE_DEFAULTS.automationName)
    : (process.env.AUTOMATION_NAME || 'UiAutomator2');

console.log(`📱 Device   : ${deviceName} (${serial || 'no device'})`);
console.log(`🤖 Android  : ${platformVersion || 'unknown'}`);
if (EFFECTIVE_TV_TARGET) {
  console.log(`📺 TV target : ${EFFECTIVE_TV_TARGET}`);
}

// The native DAZN app formats event times from the Android device timezone.
// Web timezone emulation only applies after the checkout handoff, so configure
// the device itself before the app is launched for the test.
const regionTimezoneMap: Record<string, string> = {
  GB: 'Europe/London',
  UK: 'Europe/London',
  US: 'America/New_York',
  AE: 'Asia/Dubai',
  UAE: 'Asia/Dubai',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  NO: 'Europe/Oslo',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  FR: 'Europe/Paris',
  CA: 'America/Toronto',
  JP: 'Asia/Tokyo',
};

function configureDeviceTimezone(): void {
  if (!serial || process.env.ANDROID_SET_TIMEZONE === 'false') return;

  const region = (process.env.DAZN_REGION || 'GB').toUpperCase();
  const timezone = regionTimezoneMap[region] || regionTimezoneMap.GB;
  console.log(`🌍 Setting Android device timezone for ${region}: ${timezone}`);

  // Disable automatic timezone detection so a carrier/network cannot overwrite
  // the regional timezone while the native app is under test.
  adbShell(serial, 'shell settings put global auto_time_zone 0');
  adbShell(serial, `shell cmd alarm set-timezone ${timezone}`);

  const activeTimezone = adbShell(serial, 'shell getprop persist.sys.timezone');
  if (activeTimezone === timezone) {
    console.log(`✅ Android device timezone is ${activeTimezone}`);
  } else {
    console.warn(
      `⚠️ Could not confirm Android timezone "${timezone}" (device reports "${activeTimezone || 'unknown'}"). ` +
      'The connected device may block timezone changes via ADB.',
    );
  }
}

configureDeviceTimezone();
// ─────────────────────────────────────────────────────────────────────────────

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAppiumServer(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const statusUrl = `http://127.0.0.1:${APPIUM_PORT}/status`;

  while (Date.now() < deadline) {
    try {
      execSync(`curl -fsS ${statusUrl}`, { stdio: 'ignore', timeout: 3000 });
      return;
    } catch {
      if (appiumProcess?.exitCode !== null) {
        throw new Error(`Appium server exited before it became ready on ${statusUrl}`);
      }
      await pause(500);
    }
  }

  throw new Error(`Appium server did not become ready on ${statusUrl} within ${timeoutMs}ms`);
}

export const config = {
  runner: 'local',
  port:   APPIUM_PORT,
  path:   '/',

  services: [],

  onPrepare: async function () {
    console.log('🧹 Clearing stale ADB port forwards...');
    try {
      execSync(`${ADB} forward --remove-all`, { stdio: 'ignore' });
    } catch {}
    console.log(`🚀 Starting Appium server manually on port ${APPIUM_PORT}...`);
    appiumProcess = spawn(appiumCommand, [
      '--port', String(APPIUM_PORT),
      '--address', '127.0.0.1',
      '--relaxed-security',
      '--log-level', process.env.APPIUM_LOG_LEVEL || 'error'
    ], {
      stdio: process.env.APPIUM_SHOW_LOGS === 'true' ? 'inherit' : 'ignore',
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    await waitForAppiumServer();
    console.log('✅ Appium server started.');
  },

  onComplete: async function () {
    if (appiumProcess) {
      console.log('🧹 Stopping Appium server...');
      appiumProcess.kill();
    }
  },

  specs:        TV_TARGET ? ['../tests/android/tv.ppv.spec.ts'] : ['../tests/android/*.spec.ts'],
  exclude:      [],
  maxInstances: 1,

  capabilities: [
    {
      platformName:                      'Android',
      // Inject TV metadata only for the dedicated TV spec.
      ...(IS_TV_SPEC_RUN
        ? {
            'dazn:tvTarget': EFFECTIVE_TV_TARGET || 'androidtv',
            'dazn:deviceFamily': EFFECTIVE_TV_TARGET === 'firetv' ? 'FireTV' : 'AndroidTV',
          }
        : {}),
      'appium:deviceName':               deviceName,
      // platformVersion is optional for UiAutomator2 — omit if empty so
      // Appium matches any connected device automatically
      ...(platformVersion ? { 'appium:platformVersion': platformVersion } : {}),
      'appium:udid':                     serial || undefined,
      'appium:automationName':           automationName,
      'appium:appPackage':               process.env.APP_PACKAGE   || 'com.dazn.beta',
      'appium:appActivity':              process.env.APP_ACTIVITY  || 'com.dazn.splash.view.SplashScreenActivity',
      'appium:noReset':                  true,
      'appium:autoLaunch':               false,   // do NOT auto-launch at session creation
      'appium:forceAppLaunch':           false,   // do NOT force-restart if already running
      'appium:autoGrantPermissions':     true,
      'appium:ignoreHiddenApiPolicyError': true,
      'appium:unicodeKeyboard':          false,
      'appium:resetKeyboard':            false,
      'appium:chromeOptions':            { androidPackage: 'com.android.chrome' },
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout':        300,
      'appium:uiautomator2ServerInstallTimeout': 60000,
      // These ports must be unique when two devices run on the same Mac.
      'appium:systemPort':                SYSTEM_PORT,
      'appium:chromedriverPort':          CHROMEDRIVER_PORT,
    } as any,
  ],

  logLevel:               (process.env.WDIO_LOG_LEVEL || 'warn') as any,
  bail:                   0,
  waitforTimeout:         20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount:   3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui:      'bdd',
    timeout: 600000,
  },

  before() {
    process.env.ANDROID_HOME = ANDROID_SDK;
    process.env.ADB_PATH     = ADB;
  },
};
