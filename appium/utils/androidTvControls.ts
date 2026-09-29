import { execSync } from 'child_process';

const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_SDK}/platform-tools/adb`;

type WdBrowser = any;

function adb(cmd: string): string {
  try {
    const serialArg = process.env.DEVICE_SERIAL ? `-s ${process.env.DEVICE_SERIAL} ` : '';
    return execSync(`${ADB} ${serialArg}${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim();
  } catch {
    return '';
  }
}

export const TV_KEYCODES = {
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  BACK: 4,
  HOME: 3,
} as const;

export function sendTvKeyevent(keyCode: number): void {
  adb(`shell input keyevent ${keyCode}`);
}

export async function primeAndroidTvFocus(driver: WdBrowser): Promise<void> {
  // TV shells can open with focus in a stale component. Nudging focus makes
  // subsequent selector-based clicks more reliable while keeping behavior safe.
  sendTvKeyevent(TV_KEYCODES.DPAD_DOWN);
  await driver.pause(300);
  sendTvKeyevent(TV_KEYCODES.DPAD_UP);
  await driver.pause(300);
}
