import { execFileSync } from 'child_process';

const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_SDK}/platform-tools/adb`;
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.dazn.beta';
const TV_TARGET = (process.env.TV_TARGET || 'androidtv').trim().toLowerCase();

const ANDROIDTV_SERIAL = process.env.ANDROIDTV_SERIAL || '172.26.89.94:5555';
const FIRETV_SERIAL = process.env.FIRETV_SERIAL || '172.26.81.184:5555';

function adb(args: string[], timeout = 15000): string {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
}

function getConnectedDevices(): string[] {
  try {
    return adb(['devices'], 10000)
      .split('\n')
      .slice(1)
      .map(line => line.trim())
      .filter(line => line.endsWith('\tdevice'))
      .map(line => line.split('\t')[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveDeviceSerial(): string {
  if (process.env.DEVICE_SERIAL) return process.env.DEVICE_SERIAL;
  if (TV_TARGET === 'firetv') return FIRETV_SERIAL;
  if (TV_TARGET === 'androidtv') return ANDROIDTV_SERIAL;
  return getConnectedDevices()[0] || '';
}

const serial = resolveDeviceSerial();
if (!serial) {
  throw new Error('No Android device serial resolved. Set DEVICE_SERIAL or connect one ADB device.');
}

console.log('═══════════════════════════════════════');
console.log('🧹 Resetting Android app before run');
console.log('═══════════════════════════════════════');
console.log(`📱 Device      : ${serial}`);
console.log(`📦 App package : ${APP_PACKAGE}`);

adb(['-s', serial, 'shell', 'am', 'force-stop', APP_PACKAGE]);
console.log('✅ App force-stopped');

adb(['-s', serial, 'shell', 'pm', 'clear', APP_PACKAGE]);
console.log('✅ App data cleared');

adb(['-s', serial, 'shell', 'am', 'force-stop', APP_PACKAGE]);
console.log('✅ App force-stopped after clear');
console.log('═══════════════════════════════════════');