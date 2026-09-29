/**
 * Ensures the DAZN iOS app starts from a logged-out state.
 *
 * On real devices a previous test session may leave a user logged in.
 * This function detects that state and performs a logout so every test
 * run begins from the clean landing page.
 *
 * Safe to call at any point after startup dialogs have been dismissed.
 */

type WdBrowser = any;
type WdElement = any;

const LOGOUT_TIMEOUT = 90_000;

// ── Selectors ────────────────────────────────────────────────────────────

const PROFILE_ICON_SELECTORS = [
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Profile" OR label CONTAINS[c] "Profile")',
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Account" OR label CONTAINS[c] "Account")',
];

const LANDING_INDICATORS = [
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Log in" OR label == "Log in")',
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Log In" OR label == "Log In")',
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Explore" OR label == "Explore")',
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Get started" OR label == "Get started")',
  '~Log in',
  '~Log In',
  '~Explore',
  '~Get started',
];

const LOGOUT_BUTTON_SELECTORS = [
  '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Log out" OR label == "Log out")',
  '-ios class chain:**/XCUIElementTypeOther[`name == "signOutButton"`]/**/XCUIElementTypeButton',
];

const LOGOUT_MODAL_BUTTON_SELECTORS = [
  '-ios predicate string:name CONTAINS[c] "Log out" OR label CONTAINS[c] "Log out" OR value CONTAINS[c] "Log out"',
];

// ── Helpers ──────────────────────────────────────────────────────────────

async function firstVisible(driver: WdBrowser, selectors: string[]): Promise<WdElement | null> {
  for (const sel of selectors) {
    try {
      const elements = await driver.$$(sel);
      for (const el of elements) {
        if (await el.isDisplayed()) return el;
      }
    } catch { /* not found */ }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function ensureLoggedOut(driver: WdBrowser): Promise<void> {
  const start = Date.now();
  try {
    // 1. Determine current state: logged in (profile icon) or logged out (landing page).
    let profileIcon: WdElement | null = null;
    let isLanding = false;

    await driver.waitUntil(async () => {
      profileIcon = await firstVisible(driver, PROFILE_ICON_SELECTORS);
      if (profileIcon) return true;
      isLanding = Boolean(await firstVisible(driver, LANDING_INDICATORS));
      return isLanding;
    }, {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: 'Could not determine login state within 10 s.',
    }).catch(() => { });

    if (isLanding || !profileIcon) {
      // Already logged out or state indeterminate — let the normal flow handle it.
      return;
    }

    console.log('🔓 [Logout] User is logged in — performing logout before test...');

    // 2. Tap profile icon → navigate to Profile page.
    await profileIcon.click();
    console.log('🔓 [Logout] Tapped profile icon.');

    // 3. Wait for Profile page and find "Log out".
    let logoutBtn: WdElement | null = null;
    await driver.waitUntil(async () => {
      logoutBtn = await firstVisible(driver, LOGOUT_BUTTON_SELECTORS);
      return Boolean(logoutBtn);
    }, {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: '"Log out" button not visible on Profile page.',
    }).catch(() => { });

    if (!logoutBtn) {
      // "Log out" may be below the fold (e.g. profile completion card visible).
      // Scroll down once to reveal it.
      console.log('🔓 [Logout] "Log out" not visible — scrolling down to reveal it...');
      const { width, height } = await driver.getWindowSize();
      await driver.performActions([{
        type: 'pointer', id: 'logoutScroll', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(width / 2), y: Math.round(height * 0.8) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerMove', duration: 250, x: Math.round(width / 2), y: Math.round(height * 0.3) },
          { type: 'pointerUp', button: 0 },
        ],
      }]).catch(() => { });
      await driver.releaseActions().catch(() => { });
      await driver.pause(500);
      await driver.waitUntil(async () => {
        logoutBtn = await firstVisible(driver, LOGOUT_BUTTON_SELECTORS);
        return Boolean(logoutBtn);
      }, {
        timeout: 5_000,
        interval: 500,
        timeoutMsg: '"Log out" button not visible after scrolling.',
      }).catch(() => { });
    }

    if (!logoutBtn) {
      await driver.saveScreenshot('./test-results/ios_logout_no_button.png').catch(() => { });
      throw new Error('Could not find the Profile sign-out button.');
    }

    // 4. Tap "Log out".
    await logoutBtn.click();
    console.log('🔓 [Logout] Tapped "Log out".');

    // 5. Confirmation modal — tap "Log out" again.
    await driver.pause(1000);
    let modalLogout: WdElement | null = null;
    await driver.waitUntil(async () => {
      // On the modal there are two buttons: "Log out" and "Cancel".
      // We need the "Log out" button specifically.
      const buttons = await driver.$$(LOGOUT_MODAL_BUTTON_SELECTORS[0]);
      // The modal "Log out" button is the SECOND one (first is behind the modal on the profile page).
      // Use the last matching button which is the modal one.
      for (let i = buttons.length - 1; i >= 0; i--) {
        try {
          if (await buttons[i].isDisplayed()) {
            modalLogout = buttons[i];
            return true;
          }
        } catch { /* stale */ }
      }
      return false;
    }, {
      timeout: 5_000,
      interval: 300,
      timeoutMsg: 'Logout confirmation modal did not appear.',
    }).catch(() => { });

    if (!modalLogout) {
      await driver.saveScreenshot('./test-results/ios_logout_no_modal.png').catch(() => { });
      throw new Error('Logout confirmation modal did not appear.');
    }

    await modalLogout.click();
    console.log('🔓 [Logout] Confirmed logout on modal.');

    // 6. Wait for the landing page.
    let landingPageVisible = false;
    console.log('🔓 [Logout] Waiting for landing CTA after logout...');
    await driver.waitUntil(async () => {
      landingPageVisible = Boolean(await firstVisible(driver, LANDING_INDICATORS));
      return landingPageVisible;
    }, {
      timeout: LOGOUT_TIMEOUT,
      interval: 500,
      timeoutMsg: 'Landing page did not appear after logout.',
    }).catch(() => { });

    if (!landingPageVisible) {
      throw new Error('Landing page did not appear after logout.');
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`✅ [Logout] Logged out successfully (${elapsed}s). App is on the landing page.`);
  } catch (error: any) {
    console.warn(`⚠️ [Logout] Logout check failed: ${error?.message || error}`);
    await driver.saveScreenshot('./test-results/ios_logout_error.png').catch(() => { });
    throw error;
  }
}
