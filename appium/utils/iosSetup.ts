import { execSync } from 'child_process';
import { ensureLoggedOut } from './iosLogout';

const BUNDLE_ID = process.env.DAZN_BUNDLE_ID || 'com.dazn.enterprise';

type WdBrowser = any;
type WdElement = any;

type PrepareIosAppOptions = {
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

// Helper: check if alert is open
async function isAlertCurrentlyOpen(driver: WdBrowser): Promise<boolean> {
  try {
    return await driver.isAlertOpen();
  } catch {
    return false;
  }
}

// Helper: read page source and check for occurrences
async function pageSourceContainsAny(driver: WdBrowser, needles: string[]): Promise<boolean> {
  try {
    const source = (await driver.getPageSource()).toLowerCase();
    return needles.some(needle => source.includes(needle.toLowerCase()));
  } catch {
    return false;
  }
}

// Helper: find visible element from list of selectors
async function findVisible(driver: WdBrowser, sels: string[]): Promise<WdElement | null> {
  for (const sel of sels) {
    try {
      const els = await driver.$$(sel);
      for (const el of els) {
        if (await el.isDisplayed()) return el;
      }
    } catch {}
  }
  return null;
}

// Helper: tap dialog button by text candidates
async function tapDialogButton(driver: WdBrowser, labels: string[], tag: string): Promise<boolean> {
  for (const label of labels) {
    const btn = await findVisible(driver, [
      `-ios predicate string:type == "XCUIElementTypeButton" AND (name == "${label}" OR label == "${label}")`,
      `-ios predicate string:type == "XCUIElementTypeStaticText" AND (name == "${label}" OR label == "${label}")`,
      `~${label}`,
    ]);

    if (btn) {
      try {
        await btn.click();
        console.log(`[${tag}] Tapped visible button "${label}"`);
        return true;
      } catch {}
    }
  }
  return false;
}

async function dismissMarketingPopupIfPresent(driver: WdBrowser): Promise<boolean> {
  const dismissButton = await findVisible(driver, [
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Keep me updated" OR label == "Keep me updated" OR name == "Keep Me Updated" OR label == "Keep Me Updated" OR name == "Maybe later" OR label == "Maybe later" OR name == "Maybe Later" OR label == "Maybe Later" OR name == "No thanks" OR label == "No thanks" OR name == "No Thanks" OR label == "No Thanks" OR name == "Not now" OR label == "Not now" OR name == "Not Now" OR label == "Not Now" OR name == "Close" OR label == "Close" OR name == "Dismiss" OR label == "Dismiss")',
  ]);
  if (dismissButton) {
    await dismissButton.click();
    console.log('🔔 [Marketing Popup] Dismissed visible marketing popup.');
    return true;
  }

  const source = await driver.getPageSource().catch(() => '');
  if (!/where fans meet superstars|reserve a seat|powered by the residency|live chat|keep me updated|maybe later|no thanks|not now/i.test(source)) {
    return false;
  }
  const closeButton = await findVisible(driver, [
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "X" OR label == "X" OR name == "×" OR label == "×")',
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Close" OR label CONTAINS[c] "Close" OR name CONTAINS[c] "Dismiss" OR label CONTAINS[c] "Dismiss")',
  ]);
  if (!closeButton) return false;

  await closeButton.click();
  console.log('🔔 [Marketing Popup] Dismissed visible marketing popup.');
  return true;
}

// Helper: tap by coordinates on iOS screen
async function tapByCoordinates(driver: WdBrowser, x: number, y: number): Promise<void> {
  await driver.performActions([{
    type: 'pointer', id: 'pt', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
  await driver.releaseActions();
}

async function tapElementCenter(driver: WdBrowser, el: WdElement): Promise<void> {
  const loc = await el.getLocation();
  const size = await el.getSize();
  const centerX = Math.round(loc.x + size.width / 2);
  const centerY = Math.round(loc.y + size.height / 2);
  await tapByCoordinates(driver, centerX, centerY);
}

// Helper: tap button in standard native iOS alert
async function tapIosAlertButton(driver: WdBrowser, preferredLabels: string[], tag: string): Promise<boolean> {
  if (!(await isAlertCurrentlyOpen(driver))) {
    return false;
  }

  try {
    const buttons = await driver.execute('mobile: alert', { action: 'getButtons' }) as string[];
    if (!Array.isArray(buttons) || buttons.length === 0) return false;

    const normalizedButtons = buttons.map(b => (b ?? '').trim());
    const exactMatch = preferredLabels.find(label => normalizedButtons.includes(label));
    const containsMatch = preferredLabels.find(label =>
      normalizedButtons.some(btn => btn.toLowerCase().includes(label.toLowerCase())),
    );
    const buttonToTap = exactMatch || containsMatch;

    if (!buttonToTap) return false;

    await driver.execute('mobile: alert', {
      action: 'accept',
      buttonLabel: buttonToTap,
    });
    console.log(`[${tag}] Tapped iOS alert button "${buttonToTap}"`);
    return true;
  } catch {
    return false;
  }
}

// Helper: check if ATT (App Tracking Transparency) popup is visible
async function isAttPopupPresent(driver: WdBrowser): Promise<boolean> {
  const attVisible = await findVisible(driver, [
    '-ios predicate string:type == "XCUIElementTypeStaticText" AND (name CONTAINS[c] "track your activity" OR label CONTAINS[c] "track your activity" OR value CONTAINS[c] "track your activity")',
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Ask App Not to Track" OR label == "Ask App Not to Track")',
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Ask App Not To Track" OR label == "Ask App Not To Track")',
    '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Allow" OR label == "Allow")',
    '~Ask App Not to Track',
    '~Ask App Not To Track',
    '~Allow',
  ]);
  if (attVisible) return true;

  return await pageSourceContainsAny(driver, [
    'track your activity',
    'ask app not to track',
    'other companies',
  ]);
}

// Helper: ATT popup dismissal coordinates fallback
async function tapAttPopupFallback(driver: WdBrowser, tag: string): Promise<boolean> {
  try {
    if (!(await isAttPopupPresent(driver)) && !(await isAlertCurrentlyOpen(driver))) {
      return false;
    }

    const privacyFirst = await findVisible(driver, [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Ask App Not to Track" OR label == "Ask App Not to Track")',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Ask App Not To Track" OR label == "Ask App Not To Track")',
      '~Ask App Not to Track',
      '~Ask App Not To Track',
    ]);
    if (privacyFirst) {
      try {
        await privacyFirst.click();
      } catch {
        await tapElementCenter(driver, privacyFirst);
      }
      await driver.pause(550);
      if (!(await isAttPopupPresent(driver)) && !(await isAlertCurrentlyOpen(driver))) {
        console.log(`[${tag}] ATT popup dismissed via visible "Ask App Not to Track" button.`);
        return true;
      }
    }

    const { width, height } = await driver.getWindowRect();
    const x = Math.round(width * 0.5);

    // ATT popup buttons are near the lower half of the popup sheet.
    await tapByCoordinates(driver, x, Math.round(height * 0.67));
    await driver.pause(700);
    if (!(await isAttPopupPresent(driver)) && !(await isAlertCurrentlyOpen(driver))) {
      console.log(`[${tag}] ATT popup dismissed via coordinate tap (opt-out zone).`);
      return true;
    }

    await tapByCoordinates(driver, x, Math.round(height * 0.77));
    await driver.pause(700);
    if (!(await isAttPopupPresent(driver)) && !(await isAlertCurrentlyOpen(driver))) {
      console.log(`[${tag}] ATT popup dismissed via coordinate tap (allow zone).`);
      return true;
    }
  } catch {}

  return false;
}

// Helper: force dismiss ATT popup via guide coordinate taps
async function forceDismissAttByCoordinates(driver: WdBrowser, tag: string): Promise<boolean> {
  try {
    const beforeLooksLikeAtt = await pageSourceContainsAny(driver, [
      'track your activity',
      'ask app not to track',
      'other companies',
    ]);
    if (!beforeLooksLikeAtt) return false;

    const { width, height } = await driver.getWindowRect();
    const x = Math.round(width * 0.5);

    await tapByCoordinates(driver, x, Math.round(height * 0.76));
    await driver.pause(650);
    await tapByCoordinates(driver, x, Math.round(height * 0.84));
    await driver.pause(650);

    const afterStillLooksLikeAtt = await pageSourceContainsAny(driver, [
      'track your activity',
      'ask app not to track',
    ]);
    if (!afterStillLooksLikeAtt) {
      console.log(`[${tag}] ATT dismissed via source-guided coordinate taps.`);
      return true;
    }
  } catch {}

  return false;
}

// Helper: hard check to make sure ATT dialog is closed
export async function ensureAttDialogClosed(driver: WdBrowser, timeoutMs = 18000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let attempt = 0;
  let forcedAuthHeaderCycleDone = false;

  while (Date.now() < end) {
    attempt++;

    const authHeaderVisible = await findVisible(driver, [
      '-ios predicate string:(type == "XCUIElementTypeButton" OR type == "XCUIElementTypeStaticText") AND (name == "Sign up for free" OR label == "Sign up for free")',
      '-ios predicate string:(type == "XCUIElementTypeButton" OR type == "XCUIElementTypeStaticText") AND (name == "Log in" OR label == "Log in")',
      '~Sign up for free',
      '~Log in',
    ]);

    if (authHeaderVisible) {
      console.log('[ATT Guard] Auth header (landing/login elements) detected. App is ready.');
      return;
    }

    const attPresent = await isAttPopupPresent(driver);
    const alertOpen = await isAlertCurrentlyOpen(driver);
    if (!attPresent && !alertOpen) {
      console.log(`[ATT Guard] No ATT dialog detected (attempt ${attempt}).`);
      return;
    }

    const tappedNative = await tapIosAlertButton(driver, [
      'Ask App Not to Track',
      'Ask App Not To Track',
      'Allow',
      'OK',
    ], 'ATT Guard Native');
    if (tappedNative) {
      await driver.pause(450);
      continue;
    }

    const tappedVisible = await tapAttPopupFallback(driver, 'ATT Guard Visible');
    if (tappedVisible) {
      await driver.pause(450);
      continue;
    }

    const tappedBySource = await forceDismissAttByCoordinates(driver, 'ATT Guard Source');
    if (tappedBySource) {
      await driver.pause(450);
      continue;
    }

    await driver.pause(250);
  }

  console.warn('⚠️ ATT dialog guard finished or timed out.');
}

// Helper: handle system/startup prompts (stacked ATT, notification permissions, etc.)
export async function handleStartupDialogs(driver: WdBrowser, timeoutMs = 20000): Promise<void> {
  const startupLabels = [
    'Ask App Not to Track',
    'Ask App Not To Track',
    'Allow Tracking',
    'Allow',
    'Continue',
    'Close',
    'Dismiss',
    'Skip',
    'Not Now',
    'No Thanks',
    'Maybe Later',
    'Remind Me Later',
    'OK',
    'Open',
  ];

  const end = Date.now() + timeoutMs;
  let handledCount = 0;
  let forcedAttTapCount = 0;
  while (Date.now() < end) {
    const didTapNativeAlert = await tapIosAlertButton(driver, [
      'Ask App Not to Track',
      'Ask App Not To Track',
      'Continue',
      'Allow',
      'OK',
    ], 'Startup Alert');
    if (didTapNativeAlert) {
      handledCount++;
      await driver.pause(500);
      continue;
    }

    const didTapAttFallback = await tapAttPopupFallback(driver, 'Startup Alert');
    if (didTapAttFallback) {
      handledCount++;
      await driver.pause(600);
      continue;
    }

    try {
      if (await isAlertCurrentlyOpen(driver)) {
        const acceptedByLabel = await tapIosAlertButton(driver, [
          'Ask App Not to Track',
          'Ask App Not To Track',
          'Continue',
          'Allow',
          'OK',
        ], 'Startup Alert');

        if (!acceptedByLabel && !(await tapAttPopupFallback(driver, 'Startup Alert'))) {
          await driver.acceptAlert();
        }

        handledCount++;
        await driver.pause(500);
        continue;
      }
    } catch {}

    const didTap = await tapDialogButton(driver, startupLabels, 'Startup');
    if (didTap) {
      handledCount++;
      await driver.pause(500);
      continue;
    }

    if (await dismissMarketingPopupIfPresent(driver)) {
      handledCount++;
      await driver.pause(500);
      continue;
    }

    if (forcedAttTapCount < 3) {
      const forcedAttDismissed = await tapAttPopupFallback(driver, 'Startup Forced ATT');
      if (forcedAttDismissed) {
        forcedAttTapCount++;
        handledCount++;
        await driver.pause(600);
        continue;
      }

      const sourceGuidedDismissed = await forceDismissAttByCoordinates(driver, 'Startup Source ATT');
      if (sourceGuidedDismissed) {
        forcedAttTapCount++;
        handledCount++;
        await driver.pause(600);
        continue;
      }
    }

    // Quiet time wait after handling dialogs
    if (handledCount > 0) {
      let noDialogCount = 0;
      const quietStart = Date.now();
      while (Date.now() - quietStart < 1000 && Date.now() < end) {
        const nextBtn = await findVisible(driver, [
          '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Ask App Not to Track" OR label == "Ask App Not to Track")',
          '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Continue" OR label == "Continue")',
          '~Allow',
        ]);
        let alertOpen = false;
        try {
          alertOpen = await isAlertCurrentlyOpen(driver);
        } catch {
          alertOpen = false;
        }
        if (nextBtn || alertOpen) {
          noDialogCount = 0;
          break;
        }
        await driver.pause(150);
        noDialogCount++;
      }
      if (noDialogCount > 0) {
        console.log(`[Startup] Handled ${handledCount} startup dialog(s).`);
        break;
      }
    }

    await driver.pause(150);
  }

  if (handledCount === 0) {
    const attTextVisible = await pageSourceContainsAny(driver, [
      'track your activity',
      'ask app not to track',
      'other companies',
    ]);

    if (attTextVisible) {
      const { width, height } = await driver.getWindowRect();
      const x = Math.round(width * 0.5);
      await tapByCoordinates(driver, x, Math.round(height * 0.66));
      await driver.pause(650);
      await tapByCoordinates(driver, x, Math.round(height * 0.75));
      await driver.pause(650);
      console.log('[Startup] Defensive ATT taps executed (ATT text fallback).');
    }
    console.log('[Startup] No startup dialog appeared.');
  } else {
    console.log(`[Startup] Total handled: ${handledCount}`);
  }
}

async function acceptCookiesIfPresent(driver: WdBrowser): Promise<boolean> {
  const accepted = await tapDialogButton(driver, [
    'Accept Cookies', 'Accept All', 'Accept All Cookies', 'Accept',
    'Allow All', 'Allow All Cookies', 'Allow', 'I Accept',
    'OK', 'Confirm My Choices',
  ], 'Cookies accepted');
  if (accepted) {
    await driver.pause(1500);
    return true;
  }

  // Fallback: detect cookie consent via page source and try coordinate tap
  try {
    const source = (await driver.getPageSource()).toLowerCase();
    const hasCookieConsent = /cookie|cookies|onetrust|consent|privacy/i.test(source);
    if (!hasCookieConsent) return false;

    // Try to find and click the accept/allow button by broader matching
    const acceptSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Accept" OR label CONTAINS[c] "Accept" OR name CONTAINS[c] "Allow" OR label CONTAINS[c] "Allow")',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "OK" OR label CONTAINS[c] "OK")',
      '//XCUIElementTypeButton[contains(@name, "Accept") or contains(@label, "Accept") or contains(@name, "Allow") or contains(@label, "Allow")]',
    ];
    for (const sel of acceptSelectors) {
      const btn = await findVisible(driver, [sel]);
      if (btn) {
        try {
          await btn.click();
          console.log('[Cookies] Accepted via fallback broader selector.');
          await driver.pause(1500);
          return true;
        } catch {}
      }
    }
  } catch {}
  return false;
}

async function dismissLandingPage(driver: WdBrowser): Promise<boolean> {
  const tapped = await tapDialogButton(driver, ['Explore', 'Get started', 'Continue'], 'Landing page dismissed');
  if (tapped) {
    await driver.pause(2000);
    return true;
  }

  // Fallback: swipe left
  try {
    const { width, height } = await driver.getWindowRect();
    await driver.performActions([{
      type: 'pointer', id: 'pd', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(width * 0.8), y: Math.round(height * 0.5) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerMove', duration: 250, x: Math.round(width * 0.2), y: Math.round(height * 0.5) },
        { type: 'pointerUp', button: 0 },
      ]
    }]);
    await driver.releaseActions();
    await driver.pause(2000);
    console.log('  ✓ Landing page dismissed (swipe)');
    return true;
  } catch {
    return false;
  }
}

async function isHomeReady(driver: WdBrowser): Promise<boolean> {
  const homeSelectors = [
    '-ios predicate string:(name == "Home" OR label == "Home") AND type == "XCUIElementTypeButton"',
    '-ios predicate string:(name == "Sports" OR label == "Sports") AND type == "XCUIElementTypeButton"',
    '-ios predicate string:(name == "Schedule" OR label == "Schedule") AND type == "XCUIElementTypeButton"',
    '-ios predicate string:(name == "Search" OR label == "Search") AND type == "XCUIElementTypeButton"',
    '~Home',
    '~Sports',
    '~Schedule',
    '~Search',
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
  const landingIndicators = [
    '-ios predicate string:name CONTAINS "DAZN" OR label CONTAINS "DAZN"',
    '-ios predicate string:name CONTAINS "Explore" OR label CONTAINS "Explore"',
    '-ios predicate string:name CONTAINS "Get started" OR label CONTAINS "Get started"',
    '~Explore',
    '~Get started',
    '~Sign in',
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

async function hasAnyVisibleElement(driver: WdBrowser): Promise<boolean> {
  try {
    const source = await driver.getPageSource();
    const hasContent = source.includes('XCUIElementType');
    if (hasContent) {
      console.log('  ✓ App UI detected (page source fallback)');
      return true;
    }
  } catch {}
  return false;
}

export async function waitForHomePage(driver: WdBrowser, timeoutMs = 120000, options: { preservePpvPopup?: boolean } = {}): Promise<void> {
  let sawCookiePrompt = false;
  let sawStartupDialog = false;
  let lastCheckTime = Date.now();
  const startTime = Date.now();
  const checkInterval = 5000;

  try {
    await driver.waitUntil(async () => {
      const now = Date.now();
      if (now - lastCheckTime >= checkInterval) {
        lastCheckTime = now;
        console.log(`  ⏳ Still waiting for iOS app to be ready... (${Math.floor((now - startTime) / 1000)}s elapsed)`);
      }

      // Dismiss any iOS system dialogs (ATT tracking, Face ID, local network)
      // that can overlay the app and block home-page detection.
      try {
        if (await driver.isAlertOpen()) {
          const btns = await driver.execute('mobile: alert', { action: 'getButtons' }) as string[];
          const dismiss = ['Allow', "Don't Allow", 'Ask App Not to Track', 'Not Now', 'OK']
            .find(l => btns?.some(b => b?.trim() === l));
          if (dismiss) {
            await driver.execute('mobile: alert', { action: 'accept', buttonLabel: dismiss });
            console.log(`  Dismissed iOS system alert with "${dismiss}".`);
            return false;
          }
        }
      } catch { /* no alert open */ }

      const source = options.preservePpvPopup ? await driver.getPageSource().catch(() => '') : '';
      if (options.preservePpvPopup && isConfiguredPpvPopup(source)) {
        console.log('✅ Configured Home PPV popup is visible; preserving it for source-specific validation.');
        return true;
      }

      if (await acceptCookiesIfPresent(driver)) {
        sawCookiePrompt = true;
        await driver.pause(2000);
        return false;
      }

      if (await dismissMarketingPopupIfPresent(driver)) {
        return false;
      }

      if (await tapDialogButton(driver, ['Close', 'Dismiss', 'Not Now', 'No Thanks', 'Maybe Later', 'Remind Me Later', 'Skip'], 'Startup')) {
        sawStartupDialog = true;
        await driver.pause(1000);
        return false;
      }

      if (await isHomeReady(driver)) {
        console.log('  ✓ Home page detected');
        return true;
      }

      if (await isLandingPageReady(driver)) {
        console.log('  ✓ Landing page detected - dismissing to reach home');
        await dismissLandingPage(driver);
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
      interval: 2000,
      timeoutMsg: `iOS app did not reach Home or Landing page after ${Math.floor(timeoutMs / 1000)}s`,
    });
  } catch (error) {
    await driver.saveScreenshot('./test-results/ios_startup_not_ready.png').catch(() => {});
    try {
      const pageSource = await driver.getPageSource();
      require('fs').writeFileSync('./test-results/ios_startup_page_source.xml', pageSource);
    } catch {}
    throw error;
  }

  if (!sawCookiePrompt) console.log('ℹ️ Cookie popup not shown');
  console.log('✅ iOS App ready (Home or Landing page detected)');
}

export async function prepareIosApp(driver: WdBrowser, options: PrepareIosAppOptions = {}) {
  console.log('═══════════════════════════════════════');
  console.log('📱 Preparing iOS app');
  console.log('═══════════════════════════════════════');

  // Timezone handles are set through caps configured in wdio.ios.conf.ts

  // Terminate app if running
  try {
    await driver.terminateApp(BUNDLE_ID);
    console.log('✅ App terminated');
  } catch {}

  // Launch app
  await driver.activateApp(BUNDLE_ID);
  console.log('🚀 App launched');

  // Dismiss standard iOS alert prompts first (ATT/Local notification)
  await handleStartupDialogs(driver, 12000);
  await ensureAttDialogClosed(driver, 18000);

  // Dismiss cookie consent early — it can overlay the app and prevent
  // ensureLoggedOut from detecting the profile icon.
  await acceptCookiesIfPresent(driver);

  // Ensure app starts from a logged-out state for clean test runs.
  await ensureLoggedOut(driver);

  if (options.acceptCookiesOnly) {
    console.log('⏳ Waiting for Landing page to load...');
    try {
      await driver.waitUntil(async () => {
        return await isLandingPageReady(driver);
      }, {
        timeout: 30000,
        interval: 1000,
        timeoutMsg: 'iOS app landing page did not load in 30s'
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

  console.log('✅ iOS app ready');
  console.log('═══════════════════════════════════════');
}
