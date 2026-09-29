import { IOSBasePage, WdElement } from './IOSBasePage';
import { IOSPPVPage } from './IOSPPVPage';
import { IOSSignupPage } from './IOSSignupPage';
import { IOSMyAccountPage } from './IOSMyAccountPage';
import { IOSValidationResult } from './IOSValidationPage';

export interface IOSSafariCheckoutOptions {
  capturedUrl: string;
  safariContext?: string;
  eventName: string;
  results: IOSValidationResult[];
  eventData?: Record<string, any>;
}

export class IOSSafariCheckoutPage extends IOSBasePage {
  private async switchToSafariWebContext(expectedUrl: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Derive the expected hostname for loose matching. The captured URL may be
    // a collapsed address-bar value (e.g. https://dazn.com/) that differs from
    // the fully-resolved tab URL (e.g. https://www.dazn.com/en-GB/).
    let expectedHostname = '';
    try {
      expectedHostname = new URL(expectedUrl).hostname.replace(/^www\./, '');
    } catch { }

    while (Date.now() < deadline) {
      const contexts = await this.driver.getContexts().catch(() => []) as string[];
      // The newest WebKit context is the visible Safari handoff. Older
      // contexts can remain alive in the same Appium session.
      for (const context of contexts.filter((value: string) => value !== 'NATIVE_APP').reverse()) {
        try {
          await this.driver.switchContext(context);
          const url = await this.driver.getUrl();
          if (!url) continue;
          // Prefer exact match; fall back to hostname comparison so that
          // locale-prefixed URLs like /en-GB/ are still accepted.
          const tabHostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
          const isMatch = url === expectedUrl ||
            (expectedHostname && tabHostname && tabHostname === expectedHostname);
          if (isMatch) {
            console.log(`🌐 Switched to Safari search context: ${context} (${url})`);
            return;
          }
        } catch { }
      }
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      await this.driver.pause(500);
    }
    throw new Error(`Safari WebKit context was not exposed for ${expectedUrl}.`);
  }

  private async switchToPreferredSafariContext(context: string, expectedUrl: string): Promise<boolean> {
    try {
      await this.driver.switchContext(context);
      const url = await this.driver.getUrl();
      const expectedHostname = new URL(expectedUrl).hostname.replace(/^www\./, '');
      const actualHostname = new URL(url).hostname.replace(/^www\./, '');
      if (expectedHostname === actualHostname) {
        console.log(`🌐 Switched to the new Safari private-tab context: ${context} (${url})`);
        return true;
      }
    } catch { }
    await this.driver.switchContext('NATIVE_APP').catch(() => { });
    return false;
  }

  private async waitForSafariStartToSettle(): Promise<void> {
    await this.driver.waitUntil(async () => this.browserLoadComplete(), {
      timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
      interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
      timeoutMsg: 'Safari handoff page did not reach the load state.',
    });
    await this.refreshSafariOpeningProblemPageIfPresent();
    console.log(`🌐 Safari handoff landing settled: ${await this.driver.getUrl()}`);
  }

  private async isSafariOpeningProblemPage(): Promise<boolean> {
    const text = (await this.browserText()).replace(/\s+/g, ' ').toLowerCase();
    return /there.?s a problem opening dazn just now|try opening the application or browser again later/.test(text);
  }

  private async refreshSafariOpeningProblemPageIfPresent(): Promise<void> {
    if (!await this.isSafariOpeningProblemPage()) return;

    console.warn('⚠️ Safari showed DAZN opening problem page; refreshing once before continuing.');
    await this.driver.saveScreenshot('./test-results/ios_safari_dazn_opening_problem_before_refresh.png').catch(() => { });
    await this.driver.refresh();
    await this.driver.waitUntil(async () => this.browserDocumentReady(), {
      timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
      interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
      timeoutMsg: 'Safari did not render after refreshing DAZN opening problem page.',
    });
    await this.driver.pause(2000);

    if (await this.isSafariOpeningProblemPage()) {
      await this.driver.saveScreenshot('./test-results/ios_safari_dazn_opening_problem_after_refresh.png').catch(() => { });
      throw new Error('DAZN Safari page still shows "There is a problem opening DAZN just now" after one refresh. Possible VPN/network issue.');
    }
    console.log('✅ DAZN Safari opening problem page cleared after refresh.');
  }

  private async waitForSafariLandingNavigation(): Promise<void> {
    const landingControls = [
      'a*=Explore', 'button*=Explore', '[role="button"]*=Explore',
      'header a[href*="/search"]', 'header button[aria-label*="Search" i]',
      'header [data-testid*="search" i]', 'a[href*="/search"]',
      'button[aria-label*="Search" i]', '[role="button"][aria-label*="Search" i]',
      '[data-testid*="search" i]',
    ];
    const timeoutMsg = 'Safari landing page did not render content and usable Explore or Search after cookie handling.';
    const waitForLandingControls = async () => {
      await this.refreshSafariOpeningProblemPageIfPresent();
      let readyReads = 0;
      await this.driver.waitUntil(async () => {
        const onSearch = /\/search(?:[/?#]|$)/i.test(await this.driver.getUrl());
        const control = await this.browserFirstVisible(onSearch
          ? ['input[type="search"]', 'input[placeholder*="search" i]', '[role="searchbox"]']
          : landingControls);
        const ready = control && await control.isClickable() &&
          (onSearch ? await this.browserLoadComplete() : await this.browserPageContentReady());
        readyReads = ready ? readyReads + 1 : 0;
        return readyReads >= 2;
      }, { timeout: 30000, interval: 2000, timeoutMsg });
    };
    console.log('⏳ Waiting for Safari landing controls after cookie handling...');
    try {
      await waitForLandingControls();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(timeoutMsg)) throw error;
    }

    console.warn('⚠️ Safari landing content or controls did not become ready; refreshing once.');
    await this.driver.refresh();
    await this.driver.waitUntil(async () => await this.browserDocumentReady() && await this.browserLoadComplete(), {
      timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
      interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 500),
      timeoutMsg: 'Safari did not finish rendering after refreshing the landing page.',
    });
    this.resetCookieConsentCache();
    await this.handleSafariCookies();
    console.log('⏳ Rechecking Safari landing controls after refresh...');
    await waitForLandingControls();
  }

  private async performExistingUserWebLogin(eventName: string): Promise<boolean> {
    const email = process.env.USER_EMAIL || '';
    const password = process.env.USER_PASSWORD || '';
    if (!email || !password) throw new Error('LOGIN_FIRST Safari web login requires USER_EMAIL and USER_PASSWORD.');

    const ppvPage = new IOSPPVPage(this.driver);
    const isContextualCheckout = async (): Promise<boolean> => {
      const url = await this.driver.getUrl().catch(() => '');
      if (this.isAccountCheckoutUrl(url)) return true;
      const text = (await this.browserText()).toLowerCase();
      return ppvPage.isContextualPPVPage(text, url);
    };
    const clickFirstEnabled = async (selectors: string[], timeoutMsg: string): Promise<boolean> => {
      let control: WdElement | null = null;
      const available = await this.driver.waitUntil(async () => {
        control = await this.browserFirstVisible(selectors);
        return Boolean(control) && await control!.isEnabled().catch(() => false);
      }, {
        timeout: 10000,
        interval: 250,
        timeoutMsg,
      }).then(() => true).catch(() => false);
      if (!available || !control) return false;
      control = await this.browserFirstVisible(selectors);
      if (!control || !await control.isEnabled().catch(() => false)) return false;
      await control.scrollIntoView().catch(() => { });
      await control.click();
      return true;
    };

    if (await isContextualCheckout()) {
      console.log(`✅ Existing-user Safari session is already on contextual checkout for "${eventName}".`);
      return true;
    }

    const loginClicked = await clickFirstEnabled([
      '//*[self::button or self::a or @role="button"][normalize-space(.)="Log in" or normalize-space(.)="Log In" or normalize-space(.)="Login" or normalize-space(.)="Sign in" or normalize-space(.)="Sign In"]',
      'a*=Log in', 'button*=Log in', '[role="button"]*=Log in',
      'a*=Log In', 'button*=Log In', '[role="button"]*=Log In',
      'a*=Sign in', 'button*=Sign in', '[role="button"]*=Sign in',
    ], 'Safari landing page did not expose a Log in button.');
    if (!loginClicked) {
      console.log('ℹ️ Existing-user Safari web login button was not found; falling back to welcome PPV tile search.');
      return false;
    }
    console.log('✅ Existing-user Safari web login opened.');
    await this.driver.pause(1000);
    await this.handleSafariCookies(5000);

    let emailInput: WdElement | null = null;
    await this.driver.waitUntil(async () => {
      if (await isContextualCheckout()) return true;
      emailInput = await this.browserFirstVisible([
        'input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="email"]',
        'input[placeholder*="email" i]', 'input[aria-label*="email" i]',
      ]);
      return Boolean(emailInput);
    }, {
      timeout: 15000,
      interval: 500,
      timeoutMsg: 'Safari web login did not expose an email input.',
    }).catch(() => { });
    if (await isContextualCheckout()) return true;
    if (!emailInput) {
      await this.navigateToWelcomePage();
      await this.refreshSafariOpeningProblemPageIfPresent();
      return false;
    }

    await emailInput.click();
    await emailInput.clearValue().catch(() => { });
    await emailInput.setValue(email);
    const emailSubmitted = await clickFirstEnabled([
      'button[type="submit"]', 'input[type="submit"]', 'button*=Continue',
      '[role="button"]*=Continue', '[aria-label*="Continue" i]',
    ], 'Safari web login email Continue button did not become available.');
    if (!emailSubmitted) {
      await this.navigateToWelcomePage();
      await this.refreshSafariOpeningProblemPageIfPresent();
      return false;
    }

    let passwordInput: WdElement | null = null;
    await this.driver.waitUntil(async () => {
      if (await isContextualCheckout()) return true;
      passwordInput = await this.browserFirstVisible([
        'input[type="password"]', 'input[name*="password" i]', 'input[autocomplete="current-password"]',
      ]);
      return Boolean(passwordInput);
    }, {
      timeout: 20000,
      interval: 500,
      timeoutMsg: 'Safari web login did not expose a password input.',
    }).catch(() => { });
    if (await isContextualCheckout()) return true;
    if (!passwordInput) {
      await this.navigateToWelcomePage();
      await this.refreshSafariOpeningProblemPageIfPresent();
      return false;
    }

    await passwordInput.click();
    await passwordInput.clearValue().catch(() => { });
    await passwordInput.setValue(password);
    const passwordSubmitted = await clickFirstEnabled([
      'button[type="submit"]', 'input[type="submit"]',
      'button*=Sign In', 'button*=Sign in', 'button*=Log in', 'button*=Log In', 'button*=Continue',
      '[role="button"]*=Sign In', '[role="button"]*=Sign in', '[role="button"]*=Log in', '[role="button"]*=Continue',
    ], 'Safari web login password submit button did not become available.');
    if (!passwordSubmitted) {
      await this.navigateToWelcomePage();
      await this.refreshSafariOpeningProblemPageIfPresent();
      return false;
    }

    const isUltimateUser = String(process.env.USER_STATE || '').toLowerCase().trim().startsWith('active_ultimate');
    if (isUltimateUser) {
      const myAccountPage = new IOSMyAccountPage(this.driver);
      await this.driver.waitUntil(async () => {
        const url = await this.driver.getUrl().catch(() => '');
        return myAccountPage.isSafariPurchasedPPVPage('', url);
      }, {
        timeout: 45000,
        interval: 1000,
        timeoutMsg: 'Safari web login for an active Ultimate user did not redirect to the My Account PPV page.',
      }).catch(async (error: Error) => {
        await this.driver.saveScreenshot('./test-results/ios_ultimate_myaccount_redirect_failed.png').catch(() => {});
        throw error;
      });
      console.log(`✅ Active Ultimate user Safari login redirected to My Account PPV for "${eventName}".`);
      return true;
    }

    const redirectedToCheckout = await this.driver.waitUntil(async () => isContextualCheckout(), {
      timeout: 45000,
      interval: 1000,
      timeoutMsg: 'Safari web login did not redirect to contextual checkout.',
    }).then(() => true).catch(() => false);
    if (redirectedToCheckout) {
      console.log(`✅ Existing-user Safari web login reached contextual checkout for "${eventName}".`);
      return true;
    }

    console.log('ℹ️ Existing-user Safari web login did not reach contextual checkout; falling back to welcome PPV tile search.');
    await this.navigateToWelcomePage();
    await this.refreshSafariOpeningProblemPageIfPresent();
    this.resetCookieConsentCache();
    await this.handleSafariCookies(5000);
    await this.waitForSafariLandingNavigation();
    return false;
  }

  private isAccountCheckoutUrl(url: string): boolean {
    return /\/account\//i.test(url) &&
      (/\/signup/i.test(url) || /[?&]page=/i.test(url) || /payment|checkout|purchase|choose/i.test(url));
  }

  private async openSafariSearchFromLanding(): Promise<void> {
    // Follow the visible web journey, matching the native flow: the welcome
    // screen exposes Explore, and the resulting home header exposes Search.
    // Do not force /search with driver.url(); that skips the actual handoff UI.
    if (/\/search(?:[/?#]|$)/i.test(await this.driver.getUrl())) {
      console.log('ℹ️ Safari is already on the Search route.');
      return;
    }
    await this.refreshSafariOpeningProblemPageIfPresent();

    const explore = await this.browserFirstVisible([
      '//*[self::button or self::a or @role="button"][normalize-space(.)="Explore"]',
      'a*=Explore', 'button*=Explore', '[role="button"]*=Explore',
    ]);
    if (explore) {
      await explore.click();
      console.log('✅ Safari handoff selected Explore.');
      this.resetCookieConsentCache();
      await this.handleSafariCookies(5000);
      await this.driver.waitUntil(async () => {
        if (!await this.browserDocumentReady()) return false;
        await this.refreshSafariOpeningProblemPageIfPresent();
        return /\/home(?:[/?#]|$)/i.test(await this.driver.getUrl()) &&
          await this.browserPageContentReady();
      }, {
        timeout: 15000,
        interval: 1000,
        timeoutMsg: 'Safari did not settle after selecting Explore.',
      });
    } else {
      console.log('ℹ️ Safari handoff is already beyond the Explore screen.');
    }

    const deadline = Date.now() + 15000;
    let searchControl: any | null = null;
    while (Date.now() < deadline && !searchControl) {
      await this.refreshSafariOpeningProblemPageIfPresent();
      searchControl = await this.browserFirstVisible([
        'header a[href*="/search"]',
        'header button[aria-label*="Search" i]',
        'header [data-testid*="search" i]',
        'a[href*="/search"]',
        'button[aria-label*="Search" i]',
        '[role="button"][aria-label*="Search" i]',
        '[data-testid*="search" i]',
      ]);
      if (!searchControl) await this.driver.pause(300);
    }
    if (!searchControl) {
      await this.driver.saveScreenshot('./test-results/ios_safari_search_icon_not_found.png').catch(() => { });
      throw new Error('Safari home did not expose a Search icon after Explore.');
    }

    await searchControl.click();
    await this.driver.waitUntil(async () => {
      if (!await this.browserDocumentReady()) return false;
      await this.refreshSafariOpeningProblemPageIfPresent();
      return /\/search(?:[/?#]|$)/i.test(await this.driver.getUrl());
    }, {
      timeout: 20000,
      timeoutMsg: 'Safari Search icon did not open the DAZN search route.',
    });
    console.log(`🌐 Safari Search icon opened: ${await this.driver.getUrl()}`);
  }

  /**
   * In a Safari WebKit context, driver.keys('Enter') can leave the iOS
   * keyboard open without firing the search form's submit action. Submit via
   * the visible native Return key when WebDriverAgent exposes it.
   */
  private async submitSafariSearch(): Promise<void> {
    const safariContext = await this.driver.getContext().catch(() => '');
    let submitted = false;

    try {
      await this.driver.switchContext('NATIVE_APP');
      const nativeContext = await this.driver.getContext().catch(() => '');
      const returnKeySelectors = [
        '~Return', '~return', '~Enter', '~enter',
        '-ios predicate string:(type == "XCUIElementTypeKey" OR type == "XCUIElementTypeButton") AND (name == "Return" OR label == "Return" OR value == "Return" OR name == "return" OR label == "return" OR value == "return" OR name == "Enter" OR label == "Enter" OR value == "Enter" OR name == "enter" OR label == "enter" OR value == "enter")',
      ];
      let returnKey: WdElement | null = null;
      let keyboardShown = false;
      await this.driver.waitUntil(async () => {
        keyboardShown = await this.driver.isKeyboardShown().catch(() => false);
        returnKey = nativeContext === 'NATIVE_APP'
          ? await this.browserFirstVisible(returnKeySelectors)
          : null;
        return Boolean(returnKey) || keyboardShown;
      }, {
        timeout: 5000,
        interval: 250,
        timeoutMsg: 'iOS Safari keyboard did not appear.',
      }).catch(() => { });
      if (returnKey) {
        await returnKey.click();
        submitted = true;
        console.log('⌨️ Submitted Safari search using the native Return key.');
      } else if (keyboardShown) {
        // Safari on iOS 16.5 can render the Return glyph without exposing an
        // accessible key element. Its position is fixed within the visible
        // iPhone keyboard; derive the tap from the current screen size rather
        // than hard-coding a device resolution.
        const { width, height } = await this.driver.getWindowSize();
        const returnX = Math.round(width * 0.86);
        const returnY = Math.round(height * 0.88);
        await this.driver.performActions([{
          type: 'pointer', id: 'safari-keyboard-return', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: returnX, y: returnY },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 60 },
            { type: 'pointerUp', button: 0 },
          ],
        }]);
        await this.driver.releaseActions();
        submitted = true;
        console.log(`⌨️ Submitted Safari search by tapping the visible Return key (${returnX}, ${returnY}).`);
      } else {
        // WDA's dedicated keyboard endpoint can still reach Safari's Return
        // action when the keyboard is visible on screen but isKeyboardShown()
        // is not reported for the external Safari process.
        const pressedByWda = await this.driver.execute('mobile: hideKeyboard', {
          keys: ['return', 'Return', 'enter', 'Enter'],
        }).then(() => true).catch(() => false);
        if (pressedByWda) {
          submitted = true;
          console.log('⌨️ Submitted Safari search using WDA’s native Return action.');
        }
      }
    } finally {
      if (safariContext && safariContext !== 'NATIVE_APP') {
        await this.driver.switchContext(safariContext);
      }
    }

    if (!submitted) {
      await this.driver.keys('Enter');
    }
  }

  /**
   * Mirrors pages/SearchPage.enableDevMode() for the real iOS Safari context.
   * Ultimate APM/APU flows in GB/US require this before checkout so the
   * account journey does not divert to phone-number collection.
   */
  private async enableSafariDevMode(): Promise<void> {
    console.log('🎭 Enabling Safari dev mode for Ultimate checkout...');
    await this.openSafariSearchFromLanding();
    await this.refreshSafariOpeningProblemPageIfPresent();
    await this.driver.waitUntil(async () => this.browserDocumentReady(), {
      timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
      interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
      timeoutMsg: 'Safari search page did not render before dev mode activation.',
    });
    this.resetCookieConsentCache();
    await this.handleSafariCookies();

    const hasDevIndicator = async () => {
      if (await this.browserFirstVisible([
        'div[class*="dev-mode__circle" i]',
      ])) return true;

      // Mobile Safari sometimes exposes the dot in the DOM but does not
      // report it as a WebDriver-visible element. Do not treat a hidden
      // dev-mode template as success: the yellow dot must actually be visible
      // before checkout leaves this page.
      return await this.driver.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>(
          '[class*="dev-mode__circle"]',
        )).some(element => {
          const style = window.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            style.opacity !== '0' && box.width > 0 && box.height > 0;
        }),
      ).catch(() => false);
    };
    // A previous activation can already have completed before the current
    // method resumes. The visible yellow dot is the same success signal used
    // by the web flow, so continue instead of trying to enter the command.
    if (await hasDevIndicator()) {
      await this.driver.pause(Number(process.env.IOS_DEV_MODE_CONFIRMED_SETTLE_MS || 1000));
      console.log('✅ Safari dev mode is already active (yellow indicator visible).');
      return;
    }

    const prompt = await this.browserFirstVisible([
      '//*[self::button or self::a or @role="button" or @role="searchbox"][contains(normalize-space(.), "Search sports, teams, events")]',
      '[role="search"]', '[aria-label*="Search" i]',
    ]);
    if (prompt) await prompt.click();

    let input: any | null = null;
    const inputDeadline = Date.now() + 15000;
    while (Date.now() < inputDeadline && !input) {
      await this.refreshSafariOpeningProblemPageIfPresent();
      input = await this.browserFirstVisible([
        'input[type="search"]', 'input[placeholder*="search" i]',
        '[role="searchbox"]', '[role="textbox"]',
      ]);
      if (!input) await this.driver.pause(300);
    }
    if (!input) throw new Error('Safari dev mode could not find the Search input.');

    // Do not use WebKit's element-click atom here: on real Safari it can wait
    // for 10 seconds and be retried even though normal JavaScript still works.
    // Focus the corresponding native Safari field, then return to WebKit to
    // enter the command through the already-focused DOM input.
    const safariContext = await this.driver.getContext().catch(() => '');
    let focusedNatively = false;
    try {
      await this.driver.switchContext('NATIVE_APP');
      const nativeContext = await this.driver.getContext().catch(() => '');
      const nativeInput = nativeContext === 'NATIVE_APP'
        ? await this.browserFirstVisible([
          '-ios predicate string:(type == "XCUIElementTypeSearchField" OR type == "XCUIElementTypeTextField") AND (name CONTAINS[c] "Search" OR label CONTAINS[c] "Search" OR value CONTAINS[c] "Search")',
        ])
        : null;
      if (nativeInput) {
        await nativeInput.click();
        focusedNatively = true;
      }
    } finally {
      if (safariContext && safariContext !== 'NATIVE_APP') {
        await this.driver.switchContext(safariContext);
      }
    }
    // Retain the WebKit click only as a compatibility fallback when Safari
    // does not expose its search field to the native accessibility tree.
    if (!focusedNatively) await input.click();
    await input.clearValue().catch(() => { });
    await input.addValue('[dev_mode_on]');
    // Safari can drop focus after WebKit enters text into a field that was
    // initially focused through the native tree. Refocus the entered field
    // so the visible keyboard Return action can submit the command.
    await input.click();
    await this.submitSafariSearch();
    await this.driver.pause(1000);

    // Safari can first show "no results" and only then mount the UUID/Copy ID
    // sheet. Some Safari variants activate immediately and only show the
    // yellow dev-mode dot (no UUID dialog), which is also a valid success.
    await this.driver.waitUntil(async () => {
      const text = await this.browserText();
      return await hasDevIndicator() ||
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text) ||
        /copy id/i.test(text);
    }, { timeout: 30000, timeoutMsg: 'Safari dev mode confirmation did not appear.' });

    let copiedId = false;
    if (!await hasDevIndicator()) {
      const copyIdSelectors = [
        'button*=Copy ID', '[role="button"]*=Copy ID', 'button[aria-label*="Copy ID" i]',
      ];
      let copyId = await this.browserFirstVisible(copyIdSelectors);
      if (!copyId) {
        await this.driver.waitUntil(async () => {
          copyId = await this.browserFirstVisible(copyIdSelectors);
          return Boolean(copyId);
        }, {
          timeout: 10000,
          interval: 500,
          timeoutMsg: 'Safari dev mode confirmation did not expose Copy ID.',
        }).catch(() => { });
      }
      if (copyId) {
        // Safari's WebDriver click atom repeatedly times out on this control
        // even though JavaScript commands remain responsive.  Trigger the
        // visible Copy ID button through WebKit instead, then verify the
        // yellow indicator only after the subsequent document load below.
        const copiedByDom = await this.driver.execute(() => {
          const button = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
            .find(element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'copy id');
          if (!button) return false;
          button.click();
          return true;
        }).catch(() => false);
        if (!copiedByDom) throw new Error('Safari dev mode confirmation exposed Copy ID but it was not actionable.');
        copiedId = true;
      } else {
        const copiedByDom = await this.driver.execute(() => {
          const button = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
            .find(element => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'copy id');
          if (!button) return false;
          button.click();
          return true;
        }).catch(() => false);
        if (!copiedByDom) throw new Error('Safari dev mode confirmation appeared but Copy ID was not actionable.');
        copiedId = true;
      }
    }

    let enabled = false;
    // Copy ID changes the Safari dev-mode state only after the next document
    // load. Stay on this same page: wait for a new, complete document and its
    // visible yellow indicator before the caller navigates to Welcome.
    if (copiedId) {
      console.log('🔄 Refreshing Safari after Copy ID...');
      const refreshMarker = `ios-dev-mode-refresh-${Date.now()}`;
      const refreshMarkerApplied = await this.driver.execute((marker: string) => {
        document.documentElement.setAttribute('data-ios-dev-mode-refresh', marker);
        return document.documentElement.getAttribute('data-ios-dev-mode-refresh') === marker;
      }, refreshMarker).catch(() => false);
      await this.driver.refresh();
      await this.driver.waitUntil(async () => this.browserDocumentReady(), {
        timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
        interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
        timeoutMsg: 'Safari did not render after refreshing dev mode.',
      });
      console.log('🌐 Safari refreshed after Copy ID.');
      console.log('⏳ Waiting for the visible yellow Safari dev-mode indicator on the refreshed page...');
      await this.driver.waitUntil(async () => {
        if (!await this.browserDocumentReady()) return false;
        if (refreshMarkerApplied) {
          const refreshedDocument = await this.driver.execute((marker: string) =>
            document.documentElement.getAttribute('data-ios-dev-mode-refresh') !== marker,
            refreshMarker).catch(() => false);
          if (!refreshedDocument) return false;
        }
        enabled = await hasDevIndicator();
        return enabled;
      }, {
        timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
        interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
        timeoutMsg: 'Safari dev mode was not confirmed by a visible yellow indicator after Copy ID refresh.',
      });
    } else {
      // A Safari variant can activate without exposing Copy ID. Preserve its
      // search/refresh fallback, but still confirm the visible indicator.
      if (!/\/search(?:[/?#]|$)/i.test(await this.driver.getUrl())) {
        await this.openSafariSearchFromLanding();
      }
      await this.driver.waitUntil(async () => {
        if (!await this.browserDocumentReady()) return false;
        enabled = await hasDevIndicator();
        return enabled;
      }, {
        timeout: 15000,
        interval: 500,
        timeoutMsg: 'Safari dev mode was not confirmed by its yellow indicator.',
      }).catch(() => { });
      enabled = enabled || await hasDevIndicator();
      if (!enabled) {
        await this.driver.refresh();
        await this.driver.waitUntil(async () => this.browserDocumentReady(), {
          timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
          interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
          timeoutMsg: 'Safari did not render after refreshing dev mode.',
        });
        enabled = await hasDevIndicator();
      }
    }
    if (!enabled) throw new Error('Safari dev mode was not confirmed by its yellow indicator.');
    await this.driver.waitUntil(async () => await hasDevIndicator(), {
      timeout: 5000,
      interval: 500,
      timeoutMsg: 'Safari dev-mode yellow indicator disappeared immediately after confirmation.',
    });
    await this.driver.pause(Number(process.env.IOS_DEV_MODE_CONFIRMED_SETTLE_MS || 1000));
    console.log('✅ Safari dev mode confirmed.');
  }

  private async openSafariSearchResult(eventName: string): Promise<void> {
    await this.openSafariSearchFromLanding();

    const prompt = await this.browserFirstVisible([
      '//*[self::button or self::a or @role="button" or @role="searchbox"][contains(normalize-space(.), "Search sports, teams, events")]',
      '[role="search"]', '[aria-label*="Search" i]',
    ]);
    if (prompt) await prompt.click();

    let input: any | null = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !input) {
      input = await this.browserFirstVisible([
        'input[type="search"]', 'input[placeholder*="search" i]', '[role="searchbox"]', '[role="textbox"]',
      ]);
      if (!input) await this.driver.pause(300);
    }
    if (!input) throw new Error('Safari search did not expose an editable search field.');
    // Dev-mode activation can leave [dev_mode_on] in this same search box.
    // Clear it explicitly so the PPV query does not append to the command.
    await input.clearValue().catch(() => { });
    await input.setValue(eventName);
    await this.driver.keys('Enter');
    await this.driver.pause(1200);

    const expected = eventName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const expectedWords = expected.split(' ').filter(word => word.length > 2 && word !== 'the');
    await this.driver.waitUntil(async () => {
      const resultText = (await this.browserText()).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      return expectedWords.every(word => resultText.includes(word));
    }, {
      timeout: 15000,
      timeoutMsg: `Safari search results did not render ${eventName}`,
    });

    // The mobile DAZN search result shown on the device is an anchor/role-link
    // rather than an article or a class-named card. Include both structural
    // forms and the data-target form used by the existing web page object.
    const candidates = await this.driver.$$(
      'article, [class*="tile" i], [class*="card" i], [class*="result" i], ' +
      'a[href], [role="link"], [role="button"], [data-target-title]'
    );
    for (const candidate of candidates) {
      const text = (await candidate.getText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const normalised = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalised.includes(expected) || /press conference|weigh.?in|prelims?|highlights?|interview/i.test(text)) continue;
      const link = await candidate.$('a[href*="/fixture/"], a[href*="/event/"], a[href*="/stream/"], a[href*="/player/"], a');
      const target = await link.isDisplayed().catch(() => false) ? link : candidate;
      await target.scrollIntoView();
      await target.click();
      console.log(`✅ Safari search selected PPV: ${text.substring(0, 100)}`);
      await this.driver.pause(1500);
      return;
    }
    const visibleText = (await this.browserText()).replace(/\s+/g, ' ').slice(0, 800);
    throw new Error(`Safari search found no clickable PPV tile for "${eventName}". Visible text: ${visibleText}`);
  }

  async continueSafariCheckout(options: IOSSafariCheckoutOptions): Promise<void> {
    const switchedToNewTab = options.safariContext
      ? await this.switchToPreferredSafariContext(options.safariContext, options.capturedUrl)
      : false;
    if (!switchedToNewTab) await this.switchToSafariWebContext(options.capturedUrl);
    const landedUrl = await this.driver.getUrl();
    options.results.push({
      page: 'iOS Safari',
      field: 'Safari landed URL',
      expected: 'DAZN URL',
      actual: landedUrl || 'Not found',
      status: /dazn\.com/i.test(landedUrl) ? 'PASS' : 'FAIL',
    });
    await this.waitForSafariStartToSettle();
    this.resetCookieConsentCache();
    await this.handleSafariCookies();
    const settledUrl = await this.driver.getUrl().catch(() => '');
    if (this.isAccountCheckoutUrl(settledUrl)) {
      console.log(`ℹ️ Safari handoff is already in account checkout: ${settledUrl}`);
      // Dev mode must still be activated for ultimate tier even when landing
      // directly on the checkout page.
      const tier = String(options.eventData?.TIER || process.env.TIER || '').toLowerCase();
      const region = String(options.eventData?.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase();
      const userState = String(options.eventData?.USER_STATE || process.env.USER_STATE || '').toLowerCase().trim();
      const isUSorGB = region === 'GB' || region === 'US';
      const isUltimateUser = userState.startsWith('active_ultimate');
      const isLoginFirst = String(process.env.LOGIN_FIRST || process.env.LOGIN || '').toLowerCase() === 'true';
      const ppvDevMode = String(options.eventData?.PPV_DEV_MODE || process.env.PPV_DEV_MODE || '').toLowerCase() === 'true';
      const isStandalonePPV = String(options.eventData?.PPV_TYPE || '').toLowerCase() === 'standalone';
      const devModeForced = String(process.env.DEV_MODE_ON || '').toLowerCase() === 'on' || ppvDevMode;
      const requiresPopupContextualBackRefresh = String(options.eventData?.SOURCE || options.eventData?.source || process.env.SOURCE || '')
        .trim().toLowerCase() === 'home-page-popup';
      if (!isStandalonePPV && (devModeForced || (tier === 'ultimate' && isUSorGB) || (isUltimateUser && isLoginFirst))) {
        console.log('🎭 Ultimate tier detected on account checkout — enabling dev mode first...');
        const searchUrl = new URL(`/en-${region}/search`, settledUrl).toString();
        await this.driver.url(searchUrl);
        await this.driver.waitUntil(async () =>
          /\/search(?:[/?#]|$)/i.test(await this.driver.getUrl()) &&
          await this.browserLoadComplete(), {
          timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
          interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 2000),
          timeoutMsg: 'Safari Search route did not reach the load state.',
        });
        await this.enableSafariDevMode();
        if (region === 'US' || requiresPopupContextualBackRefresh) {
          console.log(`${region === 'US' ? '🇺🇸 [US Ultimate]' : '🏠 [Home Popup Ultimate]'} Returning to contextual checkout with Safari Back, then refreshing...`);
          await this.driver.back().catch(() => { });
          const returnedToCheckout = await this.driver.waitUntil(async () => {
            const url = await this.driver.getUrl().catch(() => '');
            return this.isAccountCheckoutUrl(url);
          }, {
            timeout: 10000,
            interval: 500,
            timeoutMsg: 'Safari Back did not return to the contextual checkout URL.',
          }).then(() => true).catch(() => false);
          if (!returnedToCheckout) {
            console.warn('⚠️ Safari Back did not return to checkout; navigating directly to captured contextual URL.');
            await this.driver.url(settledUrl);
          }
          await this.driver.refresh();
        } else {
          // Navigate back to the checkout URL with dev mode active
          await this.driver.url(settledUrl);
        }
        await this.waitForSafariStartToSettle();
        this.resetCookieConsentCache();
        await this.handleSafariCookies();
      }
      await new IOSSignupPage(this.driver).completeToPayment(options.results, options.eventName, options.eventData);
      return;
    }

    await this.waitForSafariLandingNavigation();

    // Dev mode must be activated BEFORE clicking Buy now on the welcome page,
    // because it navigates to /search internally. After it completes, we always
    // navigate back to www.dazn.com (welcome) explicitly — history.back() only
    // returns to /search, not to the welcome page where the PPV tile lives.
    const tier = String(options.eventData?.TIER || process.env.TIER || '').toLowerCase();
    const region = String(options.eventData?.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase();
    const userState = String(options.eventData?.USER_STATE || process.env.USER_STATE || '').toLowerCase().trim();
    const isUSorGB = region === 'GB' || region === 'US';
    const isUltimateUser = userState.startsWith('active_ultimate');
    const isLoginFirst = String(process.env.LOGIN_FIRST || process.env.LOGIN || '').toLowerCase() === 'true';
    const isExistingUser = !userState.startsWith('new') || Boolean(process.env.USER_EMAIL);
    const ppvDevMode = String(options.eventData?.PPV_DEV_MODE || process.env.PPV_DEV_MODE || '').toLowerCase() === 'true';
    const isStandalonePPV = String(options.eventData?.PPV_TYPE || '').toLowerCase() === 'standalone';
    const devModeForced = String(process.env.DEV_MODE_ON || '').toLowerCase() === 'on' || ppvDevMode;
    if (!isStandalonePPV && (devModeForced || (tier === 'ultimate' && isUSorGB) || (isUltimateUser && isLoginFirst))) {
      await this.enableSafariDevMode();
      // Always navigate explicitly to welcome — dev mode ends on /search.
      await this.navigateToWelcomePage();
      await this.refreshSafariOpeningProblemPageIfPresent();
      this.resetCookieConsentCache();
      await this.handleSafariCookies(5000);
      await this.waitForSafariLandingNavigation();
    }

    const existingUserWebLoginReachedCheckout = isExistingUser && isLoginFirst && region !== 'US'
      ? await this.performExistingUserWebLogin(options.eventName)
      : false;

    if (!existingUserWebLoginReachedCheckout) {
      // DefaultSignup: skip PPV tile search and select the DAZN product card.
      if (process.env.DEFAULT_SIGNUP === 'true') {
        console.log('🔄 [DefaultSignup] Skipping welcome-page PPV tile search — finding the DAZN product Subscribe CTA...');
        let clicked = false;
        for (let scroll = 0; scroll < 15 && !clicked; scroll++) {
          clicked = await this.driver.execute(() => {
            const isVisible = (element: HTMLElement): boolean => {
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' &&
                rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
            };
            const pageText = (element: Element): string =>
              (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const headingVisible = Array.from(document.querySelectorAll<HTMLElement>('*')).some(element =>
              isVisible(element) && pageText(element) === 'sports subscriptions tailored to you',
            );
            if (!headingVisible) return false;

            const subscribe = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
              .find(button => {
                if (!isVisible(button) || pageText(button) !== 'subscribe') return false;
                for (let card: HTMLElement | null = button, depth = 0; card && depth < 8; card = card.parentElement, depth++) {
                  if (pageText(card).includes('dazn')) return true;
                }
                return false;
              });
            if (!subscribe) return false;
            subscribe.click();
            return true;
          }).catch(() => false);
          if (!clicked) {
            await this.driver.execute(() => window.scrollBy(0, Math.round(window.innerHeight * 0.75)));
            await this.driver.pause(500);
          }
        }
        if (!clicked) {
          await this.driver.saveScreenshot('./test-results/ios_safari_dazn_subscribe_not_found.png').catch(() => { });
          throw new Error('Safari default-signup flow did not find the DAZN product Subscribe CTA.');
        }
        console.log('  ✓ Tapped the DAZN product Subscribe CTA on the welcome page.');
        await this.driver.pause(2000);
      } else {
        const sport = String(options.eventData?.SPORT || '').trim();
        const isBoxingSport = !sport || sport.toLowerCase() === 'boxing' || sport.toLowerCase().includes('misfits');
        if (isBoxingSport) {
          await this.findWelcomePagePPVTile(options.eventName);
        } else {
          await this.findSafariSportComingUpPPVTile(options.eventName, sport);
        }
      }
    }
    await new IOSSignupPage(this.driver).completeToPayment(options.results, options.eventName, options.eventData);
  }
}
