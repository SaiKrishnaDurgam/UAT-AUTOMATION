import { execSync } from 'child_process';

const APP_PACKAGE = process.env.APP_PACKAGE || 'com.dazn';
const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_SDK}/platform-tools/adb`;
const COOKIE_BUTTON_XPATH = '//android.widget.Button[@resource-id="com.dazn:id/btn_accept_cookies"]';

type WdBrowser = any;
type WdElement = any;

type PrepareAndroidAppOptions = {
  clearAppData?: boolean;
  waitForHome?: boolean;
  acceptCookiesOnly?: boolean;
};

function isConfiguredPpvPopup(source: string): boolean {
  if ((process.env.SOURCE || '').trim().toLowerCase() !== 'home-page-popup') return false;
  const title = (process.env.PPV_NAME || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const terms = title.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(term => term.length >= 3 && term !== 'vs');
  const text = String(source || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return terms.length > 0 && terms.every(term => text.includes(term)) && /\bbuy now\b/.test(text);
}

function adb(cmd: string, targetSerial?: string): string {
  try {
    let serial = targetSerial || process.env.DEVICE_SERIAL || '';
    if (!serial) {
      try {
        const out = execSync(`${ADB} devices`, { encoding: 'utf8', timeout: 5000 });
        const devices = out
          .split('\n')
          .slice(1)
          .filter(l => l.includes('\tdevice'))
          .map(l => l.split('\t')[0].trim())
          .filter(Boolean);
        if (devices.length === 1) serial = devices[0];
      } catch {}
    }
    const serialArg = serial ? `-s ${serial}` : '';
    return execSync(`${ADB} ${serialArg} ${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim();
  } catch {
    return '';
  }
}

async function clickIfVisible(el: WdElement, label: string, driver: WdBrowser): Promise<boolean> {
  try {
    if (await el.isDisplayed().catch(() => false) || await el.isExisting()) {
      try {
        await el.click();
      } catch (clickErr: any) {
        console.warn(`  Native click failed: ${clickErr.message}. Trying ADB tap fallback...`);
        const rect = await el.getRect();
        const tapX = Math.round(rect.x + rect.width / 2);
        const tapY = Math.round(rect.y + rect.height / 2);
        const caps: any = driver.capabilities || {};
        const udid = caps['appium:udid'] || caps.udid || caps['appium:deviceUDID'] || caps.deviceUDID || process.env.DEVICE_SERIAL || '';
        const serialArg = udid ? `-s ${udid}` : '';
        const { execSync } = require('child_process');
        const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
        const ADB = `${ANDROID_SDK}/platform-tools/adb`;
        execSync(`${ADB} ${serialArg} shell input tap ${tapX} ${tapY}`);
      }
      console.log(`✅ ${label}`);
      return true;
    }
  } catch {}

  return false;
}

async function tapFirstVisible(driver: WdBrowser, selectors: string[], label: string): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const el = await driver.$(selector);
      if (await clickIfVisible(el, label, driver)) return true;
    } catch {}
  }

  return false;
}

async function acceptCookiesIfPresent(driver: WdBrowser): Promise<boolean> {
  const selectors = [
    COOKIE_BUTTON_XPATH,
    'android=new UiSelector().resourceId("com.dazn:id/btn_accept_cookies")',
    'android=new UiSelector().textMatches("(?i)^accept all cookies$")',
    'android=new UiSelector().textMatches("(?i)^accept all$")',
    'android=new UiSelector().textMatches("(?i)^accept$")',
    'android=new UiSelector().textContains("I Agree")',
  ];

  for (let i = 0; i < 5; i++) {
    if (await tapFirstVisible(driver, selectors, 'Cookies accepted')) {
      return true;
    }
    await driver.pause(800);
  }

  return false;
}

async function dismissOneStartupDialog(driver: WdBrowser): Promise<boolean> {
  return tapFirstVisible(driver, [
    '//android.widget.ImageView[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
    '//android.widget.ImageButton[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
    '//android.widget.Button[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
    '//android.widget.ImageView[contains(@resource-id, "close") or contains(@resource-id, "dismiss") or contains(@resource-id, "btn_close") or contains(@resource-id, "close_button") or contains(@resource-id, "iv_close")]',
    '//android.widget.ImageButton[contains(@resource-id, "close") or contains(@resource-id, "dismiss") or contains(@resource-id, "btn_close") or contains(@resource-id, "close_button")]',
    '//android.widget.Button[@resource-id="com.android.permissioncontroller:id/permission_allow_button"]',
    'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_button")',
    'android=new UiSelector().resourceId("com.android.permissioncontroller:id/permission_allow_foreground_only_button")',
    'android=new UiSelector().resourceId("android:id/button1")',
    'android=new UiSelector().resourceIdMatches("(?i).*(btn_close|close_button|iv_close|dismiss_button|close_dialog|modal_close).*")',
    'android=new UiSelector().resourceIdMatches("(?i).*close.*")',
    'android=new UiSelector().resourceIdMatches("(?i).*dismiss.*")',
    'android=new UiSelector().descriptionMatches("(?i)^(close|dismiss|close dialog|dismiss dialog|x)$")',
    'android=new UiSelector().descriptionContains("Close")',
    'android=new UiSelector().descriptionContains("Dismiss")',
    'android=new UiSelector().textMatches("(?i)^(✕|×|x|Close|Dismiss)$")',
    'android=new UiSelector().textMatches("(?i)^(Continue|Start watching|Done|OK|Allow)$")',
    'android=new UiSelector().textMatches("(?i)^(Not now|No thanks|Maybe later|Skip|Cancel|Remind me later)$")',
    '//*[@content-desc="Close" or @content-desc="close" or @content-desc="Dismiss" or @content-desc="dismiss"]',
  ], 'Startup dialog dismissed');
}

async function dismissLandingPage(driver: WdBrowser): Promise<boolean> {
  const tvTarget = String(process.env.TV_TARGET || '').toLowerCase().trim();
  const isTv = tvTarget === 'androidtv' || tvTarget === 'firetv';

  const mobileLandingSelectors = [
    'android=new UiSelector().textMatches("(?i)^Explore$")',
    'android=new UiSelector().textMatches("(?i)^Explore DAZN$")',
    'android=new UiSelector().textMatches("(?i)^Explore the app$")',
    'android=new UiSelector().textContains("Explore")',
    'android=new UiSelector().descriptionMatches("(?i)^Explore$")',
    'android=new UiSelector().descriptionContains("Explore")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_explore")',
    'android=new UiSelector().textMatches("(?i)^Get started$")',
    'android=new UiSelector().textContains("Get started")',
    'android=new UiSelector().descriptionMatches("(?i)^Get started$")',
    'android=new UiSelector().descriptionContains("Get started")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_get_started")',
    'android=new UiSelector().resourceIdMatches("(?i).*get_started.*")',
  ];

  const tvLandingSelectors = [
    'android=new UiSelector().textMatches("(?i)^Get started$")',
    'android=new UiSelector().textMatches("(?i)^Get Started$")',
    'android=new UiSelector().textContains("Get started")',
    'android=new UiSelector().textMatches("(?i)^Log in$")',
    'android=new UiSelector().textMatches("(?i)^Sign in$")',
    'android=new UiSelector().textMatches("(?i)^Continue$")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_get_started")',
    'android=new UiSelector().resourceIdMatches("(?i).*get_started.*")',
    'android=new UiSelector().resourceIdMatches("(?i).*btn_continue.*")',
    'android=new UiSelector().descriptionMatches("(?i)^Get started$")',
    'android=new UiSelector().descriptionContains("Get started")',
    'android=new UiSelector().descriptionMatches("(?i)^Continue$")',
    'android=new UiSelector().descriptionContains("Continue")',
  ];

  const selectors = isTv ? tvLandingSelectors : [...mobileLandingSelectors, ...tvLandingSelectors];

  const ctaTapped = await tapFirstVisible(driver, selectors, 'Landing page dismissed');

  if (ctaTapped) {
    await driver.pause(2000);
    return true;
  }

  if (isTv) {
    console.log('  ⚠️ TV landing CTA not found (Get started/Log in/Continue). Skipping swipe fallback.');
    return false;
  }
  
  // If no button found, try swiping left
  try {
    const { width, height } = await driver.getWindowSize();
    await driver.action('pointer')
      .move({ x: Math.round(width * 0.8), y: Math.round(height * 0.5) })
      .down()
      .move({ x: Math.round(width * 0.2), y: Math.round(height * 0.5) })
      .up()
      .perform();
    await driver.pause(2000);
    console.log('  ✓ Landing page dismissed (swipe)');
    return true;
  } catch (e) {
    return false;
  }
}

async function isHomeReady(driver: WdBrowser): Promise<boolean> {
  const homeSelectors = [
    'android=new UiSelector().text("Home")',
    'android=new UiSelector().text("Sports")',
    'android=new UiSelector().text("Schedule")',
    'android=new UiSelector().text("Search")',
    'android=new UiSelector().descriptionContains("Home")',
    'android=new UiSelector().descriptionContains("Sports")',
    'android=new UiSelector().descriptionContains("Schedule")',
    'android=new UiSelector().descriptionContains("Search")',
  ];

  for (const selector of homeSelectors) {
    try {
      const el = await driver.$(selector);
      if (await el.isDisplayed()) return true;
    } catch {}
  }

  return false;
}

async function isLandingPageReady(driver: WdBrowser): Promise<boolean> {
  const isTv = String(process.env.TV_TARGET || '').toLowerCase().trim() === 'androidtv' || String(process.env.TV_TARGET || '').toLowerCase().trim() === 'firetv';
  const landingIndicators = isTv ? [
    'android=new UiSelector().textContains("Get started")',
    'android=new UiSelector().textContains("Get Started")',
    'android=new UiSelector().textContains("Sign in")',
    'android=new UiSelector().textContains("Continue")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_get_started")',
    'android=new UiSelector().resourceIdMatches("(?i).*get_started.*")',
    'android=new UiSelector().resourceIdMatches("(?i).*btn_continue.*")',
    'android=new UiSelector().descriptionContains("Get started")',
    'android=new UiSelector().descriptionContains("Continue")',
    'android=new UiSelector().resourceId("com.dazn:id/landing")',
    'android=new UiSelector().resourceId("com.dazn:id/splash")',
  ] : [
    'android=new UiSelector().textContains("DAZN")',
    'android=new UiSelector().textContains("Explore")',
    'android=new UiSelector().textContains("Start watching")',
    'android=new UiSelector().textContains("Welcome")',
    'android=new UiSelector().textContains("Get started")',
    'android=new UiSelector().textContains("Get Started")',
    'android=new UiSelector().textContains("Sign in")',
    'android=new UiSelector().textContains("Continue")',
    'android=new UiSelector().resourceId("com.dazn:id/landing")',
    'android=new UiSelector().resourceId("com.dazn:id/splash")',
    'android=new UiSelector().resourceId("com.dazn:id/onboarding")',
    'android=new UiSelector().resourceId("com.dazn:id/get_started")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_get_started")',
    'android=new UiSelector().resourceIdMatches("(?i).*get_started.*")',
    'android=new UiSelector().resourceId("com.dazn:id/btn_continue")',
    'android=new UiSelector().descriptionContains("DAZN")',
    'android=new UiSelector().descriptionContains("landing")',
    'android=new UiSelector().descriptionContains("Get started")',
  ];

  for (const selector of landingIndicators) {
    try {
      const el = await driver.$(selector);
      if (await el.isDisplayed()) {
        console.log(`  ✓ Landing page indicator found: ${selector}`);
        return true;
      }
    } catch {}
  }

  return false;
}

async function isTvQrLoginReady(driver: WdBrowser): Promise<boolean> {
  const qrLoginIndicators = [
    'android=new UiSelector().textContains("Scan the QR code")',
    'android=new UiSelector().textContains("Use remote to log in")',
    'android=new UiSelector().textContains("Watch your favourite sports")',
    'android=new UiSelector().textContains("dazn.com/loginhelp")',
  ];

  for (const selector of qrLoginIndicators) {
    try {
      const el = await driver.$(selector);
      if (await el.isDisplayed()) {
        console.log(`  ✓ TV QR login page indicator found: ${selector}`);
        return true;
      }
    } catch {}
  }

  return false;
}

async function hasAnyVisibleElement(driver: WdBrowser): Promise<boolean> {
  // Fallback: check if the app has any visible UI by trying to get the current activity
  // This indicates the app has loaded, even if we can't identify the specific page
  try {
    const currentActivity = await driver.getCurrentActivity();
    if (currentActivity && currentActivity.includes('com.dazn') && !currentActivity.toLowerCase().includes('splash')) {
      console.log(`  ✓ App is running (activity: ${currentActivity})`);
      return true;
    }
  } catch (e) {
    console.log('  ⚠️ Could not get current activity for fallback');
  }
  
  // Secondary fallback: check page source for any UI elements
  try {
    const source = await driver.getPageSource();
    const hasContent = source.includes('android.widget.') || 
                       source.includes('android.view.') ||
                       source.includes('com.dazn.id');
    if (hasContent) {
      console.log('  ✓ App UI detected (page source fallback)');
      return true;
    }
  } catch (e) {
    console.log('  ⚠️ Could not check page source for fallback');
  }
  
  return false;
}

export async function waitForHomePage(driver: WdBrowser, timeoutMs = 120000, options: { preservePpvPopup?: boolean } = {}): Promise<void> {
  let sawCookiePrompt = false;
  let sawStartupDialog = false;
  let lastCheckTime = Date.now();
  const startTime = Date.now();
  const checkInterval = 5000; // Log progress every 5 seconds

  try {
    await driver.waitUntil(async () => {
      const now = Date.now();
      if (now - lastCheckTime >= checkInterval) {
        lastCheckTime = now;
        console.log(`  ⏳ Still waiting for app to be ready... (${Math.floor((now - (lastCheckTime - checkInterval)) / 1000)}s elapsed)`);
      }

      const source = options.preservePpvPopup ? await driver.getPageSource().catch(() => '') : '';
      if (options.preservePpvPopup && isConfiguredPpvPopup(source)) {
        console.log('✅ Configured Home PPV popup is visible; preserving it for source-specific validation.');
        return true;
      }

      if (await acceptCookiesIfPresent(driver)) {
        sawCookiePrompt = true;
        // Pause briefly after cookie dismissal so the app can transition to home
        await driver.pause(2000);
        return false;
      }

      if (await dismissOneStartupDialog(driver)) {
        sawStartupDialog = true;
        // Pause briefly after dialog dismissal to let the UI settle
        await driver.pause(1500);
        return false;
      }

      if (await isHomeReady(driver)) {
        console.log('  ✓ Home page detected');
        return true;
      }

      if (await isTvQrLoginReady(driver)) {
        console.log('  ✓ TV QR login page detected');
        return true;
      }

      if (await isLandingPageReady(driver)) {
        console.log('  ✓ Landing page detected - dismissing to reach home');
        await dismissLandingPage(driver);
        // Don't return true yet - wait for home to appear after dismissal
        return false;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 40000 && await hasAnyVisibleElement(driver)) {
        console.log('  ✓ App UI detected (fallback after 40s)');
        return true;
      }

      return false;
    }, {
      timeout: timeoutMs,
      interval: 1000,
      timeoutMsg: `Android app did not reach Home or Landing page after ${Math.floor(timeoutMs / 1000)}s`,
    });
  } catch (error) {
    await driver.saveScreenshot('./test-results/android_startup_not_ready.png').catch(() => {});
    
    // Dump page source for debugging
    try {
      const pageSource = await driver.getPageSource();
      const debugFile = './test-results/android_startup_page_source.xml';
      require('fs').writeFileSync(debugFile, pageSource);
      console.log(`📄 Page source saved to: ${debugFile}`);
    } catch (e) {
      console.log('⚠️ Could not capture page source for debugging');
    }
    
    throw error;
  }

  if (!sawCookiePrompt) console.log('ℹ️ Cookie popup not shown');
  if (!sawStartupDialog) console.log('ℹ️ Startup dialogs not shown');
  console.log('✅ App ready (Home or Landing page detected)');
}

async function clearAppDataViaSettings(driver: WdBrowser, appPackage: string, targetSerial?: string): Promise<boolean> {
  try {
    console.log(`🔄 Attempting fallback: Clearing app data via Android Settings UI (${appPackage})...`);
    adb(`shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:${appPackage}`, targetSerial);
    await driver.pause(1500);

    // Direct check: On some OEM UIs (e.g. Xiaomi/HyperOS), "Clear data" is directly on the App info page
    const directClearSelectors = [
      'android=new UiSelector().textMatches("(?i)^Clear data$")',
      'android=new UiSelector().resourceIdMatches("(?i).*(clear_data|clear_user_data).*")',
      '//android.widget.Button[contains(@text, "Clear data")]',
    ];

    let foundClearBtn = false;
    for (const sel of directClearSelectors) {
      try {
        const el = await driver.$(sel);
        if (await el.isDisplayed().catch(() => false)) {
          console.log(`  Found direct clear button: ${sel}`);
          await el.click();
          foundClearBtn = true;
          await driver.pause(800);
          break;
        }
      } catch {}
    }

    // Otherwise, click "Storage" / "Storage usage" / "Storage & cache" first
    if (!foundClearBtn) {
      const storageSelectors = [
        'android=new UiSelector().textMatches("(?i)^(Storage|Storage usage|Storage & cache)$")',
        'android=new UiSelector().textContains("Storage")',
        '//android.widget.TextView[contains(@text, "Storage")]',
        '//android.widget.Button[contains(@text, "Storage")]',
      ];

      for (const sel of storageSelectors) {
        try {
          const el = await driver.$(sel);
          if (await el.isDisplayed().catch(() => false)) {
            console.log(`  Found storage menu: ${sel}`);
            await el.click();
            await driver.pause(1200);
            break;
          }
        } catch {}
      }

      // Inside Storage page, click "Clear data" or "Clear storage"
      const storageClearSelectors = [
        'android=new UiSelector().textMatches("(?i)^Clear (storage|data)$")',
        'android=new UiSelector().resourceIdMatches("(?i).*(clear_data_button|clear_user_data_button|button1).*")',
        '//android.widget.Button[contains(@text, "Clear storage") or contains(@text, "Clear data")]',
        '//android.widget.TextView[contains(@text, "Clear storage") or contains(@text, "Clear data")]',
      ];

      for (const sel of storageClearSelectors) {
        try {
          const el = await driver.$(sel);
          if (await el.isDisplayed().catch(() => false)) {
            console.log(`  Found clear storage button: ${sel}`);
            await el.click();
            foundClearBtn = true;
            await driver.pause(800);
            break;
          }
        } catch {}
      }
    }

    // Confirm dialog prompt ("OK", "Delete", "Clear all data")
    const confirmSelectors = [
      'android=new UiSelector().resourceId("android:id/button1")',
      'android=new UiSelector().textMatches("(?i)^(OK|Delete|Clear|Clear all data)$")',
      '//android.widget.Button[@resource-id="android:id/button1"]',
      '//android.widget.Button[contains(@text, "OK") or contains(@text, "Delete") or contains(@text, "Clear")]',
    ];

    for (const sel of confirmSelectors) {
      try {
        const el = await driver.$(sel);
        if (await el.isDisplayed().catch(() => false)) {
          console.log(`  Confirming data deletion: ${sel}`);
          await el.click();
          await driver.pause(1200);
          break;
        }
      } catch {}
    }

    // Force stop app and close Settings
    adb(`shell am force-stop ${appPackage}`, targetSerial);
    adb('shell am force-stop com.android.settings', targetSerial);
    console.log(`✅ App data cleared via Android Settings UI (${appPackage})`);
    return true;
  } catch (err: any) {
    console.warn(`⚠️ Settings UI clear failed: ${err.message}`);
    return false;
  }
}

export async function prepareAndroidApp(driver: WdBrowser, options: PrepareAndroidAppOptions = {}) {
  const clearAppData = options.clearAppData !== false;

  console.log('═══════════════════════════════════════');
  console.log('📱 Preparing Android app');
  console.log('═══════════════════════════════════════');

  // Set device timezone to match region
  const REGION = (process.env.DAZN_REGION || 'GB').toUpperCase();
  const tzMap: Record<string, string> = {
    GB:  'Europe/London',
    UK:  'Europe/London',
    US:  'America/New_York',
    UAE: 'Asia/Dubai',
    AU:  'Australia/Sydney',
    BR:  'America/Sao_Paulo',
    DE:  'Europe/Berlin',
    IT:  'Europe/Rome',
    ES:  'Europe/Madrid',
    FR:  'Europe/Paris',
    CA:  'America/Toronto',
    JP:  'Asia/Tokyo',
  };
  const targetTz = tzMap[REGION] || 'Europe/London';
  // Get device UDID from active session capabilities or env for targeted ADB calls
  const caps: any = driver.capabilities || {};
  const serial = caps['appium:udid'] || caps.udid || caps['appium:deviceUDID'] || caps.deviceUDID || process.env.DEVICE_SERIAL || '';

  try {
    adb(`shell setprop persist.sys.timezone ${targetTz}`, serial);
    console.log(`✅ Set Android device timezone to: ${targetTz}`);
  } catch (err: any) {
    console.warn(`⚠️ Failed to set device timezone via ADB: ${err.message}`);
  }

  // Kill app if already running (use adb force-stop for reliability)
  try {
    adb(`shell am force-stop ${APP_PACKAGE}`, serial);
    console.log('✅ App terminated');
  } catch {}

  if (clearAppData) {
    let cleared = false;
    // Attempt 1: ADB pm clear with explicit device serial
    try {
      const res = adb(`shell pm clear ${APP_PACKAGE}`, serial);
      const isSecurityException = res.includes('SecurityException') || res.includes('permission');
      if (!isSecurityException && (res.toLowerCase().includes('success') || res.trim() === '')) {
        console.log(`✅ App data cleared via ADB pm clear (${APP_PACKAGE})`);
        cleared = true;
      } else if (isSecurityException) {
        console.warn(`⚠️ ADB pm clear blocked by device security: ${res.split('\n')[0]}`);
      }
    } catch (err: any) {
      console.warn(`⚠️ ADB pm clear failed: ${err.message}`);
    }

    // Attempt 2: Appium mobile:shell fallback
    if (!cleared) {
      try {
        const res = await driver.execute('mobile: shell', { command: 'pm', args: ['clear', APP_PACKAGE] });
        if (typeof res === 'string' && res.toLowerCase().includes('success')) {
          console.log(`✅ App data cleared via Appium mobile:shell (${APP_PACKAGE})`);
          cleared = true;
        }
      } catch (err: any) {
        console.warn(`⚠️ Appium mobile:shell clear failed: ${err.message}`);
      }
    }

    // Attempt 3: Programmatic Settings UI Fallback (handles OnePlus/Oppo/Xiaomi/OEM permission restrictions)
    if (!cleared) {
      cleared = await clearAppDataViaSettings(driver, APP_PACKAGE, serial);
    }

    if (!cleared) {
      console.warn('⚠️ Unable to clear app data');
    }
  } else {
    console.log('ℹ️ App data preserved');
  }

  // Launch app
  await driver.activateApp(APP_PACKAGE);
  console.log('🚀 App launched');

  if (options.acceptCookiesOnly) {
    // Accept cookies but keep the landing page visible (don't dismiss it).
    // This is for LOGIN_FIRST flows where the "Log In" button is on the
    // landing page and must not be hidden by the cookie banner.
    console.log('⏳ Waiting for Landing page to load...');
    try {
      await driver.waitUntil(async () => {
        // A new install can show notification/local-network permissions before
        // its landing controls. Handle those prompts without dismissing the
        // landing screen required by the following auth flow.
        if (await dismissOneStartupDialog(driver)) return false;
        return await isLandingPageReady(driver);
      }, {
        timeout: 30000,
        interval: 1000,
        timeoutMsg: 'Android app landing page did not load in 30s'
      });
      console.log('✅ Landing page loaded');
    } catch (e: any) {
      console.warn(`⚠️ Warning: Landing page wait timed out: ${e.message}`);
    }

    console.log('🍪 Accepting cookies (landing page preserved)...');
    try {
      await acceptCookiesIfPresent(driver);
      console.log('✅ Cookies accepted, landing page visible');
    } catch (e) {
      console.log('ℹ️ No cookie banner detected');
    }
  } else if (options.waitForHome !== false) {
    await waitForHomePage(driver);
  } else {
    console.log('ℹ️ Skipping waiting for Home page');
  }

  console.log('✅ Android app ready');
  console.log('═══════════════════════════════════════');
}
