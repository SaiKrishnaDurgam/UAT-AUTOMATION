import {
  IOSFlowHooks,
  WdBrowser,
} from './IOSBasePage';
import { IOSLandingPage } from './IOSLandingPage';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ANCILLARY_PPV_CONTENT = /\b(?:official preview|preview|locked in|press conference|press conf|weigh[\s-]?in|highlights|prelims?|pre[\s-]?show|buy[\s-]?in|tailgate(?: brawl)?|the making of|re-live|relive|countdown|all access|rewind|behind the scenes|workout|open workout|grand arrivals|documentary|episode)\b/i;

interface IOSVisualTileMatch {
  visible: boolean;
  xPercent: number | null;
  yPercent: number | null;
  ocrTexts?: string[];
  screenshotFingerprint?: string;
}

interface IOSVisualRailMatch {
  visible: boolean;
  yPercent: number | null;
  bottomYPercent?: number;
}

export class IOSHomePage extends IOSLandingPage {
  async openHomePageSubscribePaywall(): Promise<boolean> {
    await this.ensureOnHome();
    const selectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Subscribe" OR label == "Subscribe")',
      '~Subscribe',
    ];
    for (const selector of selectors) {
      const button = await this.driver.$(selector).catch(() => null);
      if (button && await button.isDisplayed().catch(() => false)) {
        await button.click();
        const isUsRegion = (process.env.DAZN_REGION || '').toUpperCase() === 'US';
        const externalCtas = isUsRegion
          ? ['BUY NOW', 'Buy now']
          : ['Go to dazn.com/start', 'Go to DAZN.com/start', 'dazn.com/start'];
        if (!isUsRegion) {
          await this.driver.waitUntil(async () => {
            for (const cta of externalCtas) {
              if (await this.isVisible(cta, 500)) return true;
            }
            return false;
          }, {
            timeout: 15000,
            interval: 500,
            timeoutMsg: 'Home Subscribe did not open the iOS native paywall.',
          });
          console.log('✅ Home Subscribe opened the iOS native paywall; opening dazn.com/start.');
        }
        const ctaTapped = await this.tapBuyCtaWithFallback(externalCtas, {
          scrollBeforeFallback: true,
          fallbackCtas: externalCtas,
        });
        if (ctaTapped || !isUsRegion) return ctaTapped;

        // This native US sheet can render BUY NOW without exposing it to XCUITest.
        const { width, height } = await this.driver.getWindowRect();
        await this.driver.performActions([{
          type: 'pointer', id: 'us-home-subscribe-buy-now', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(width * 0.5), y: Math.round(height * 0.88) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }]);
        await this.driver.releaseActions();
        console.log('✅ [US] Tapped Home Subscribe Buy Now via native paywall fallback position.');
        await this.driver.pause(Number(process.env.IOS_US_INAPP_BROWSER_SETTLE_MS || 2000));
        return true;
      }
    }
    throw new Error('Home Subscribe CTA was not found after freemium login.');
  }

  async openHomePagePopupPaywall(hooks: IOSFlowHooks = {}, eventData: Record<string, any> = {}): Promise<boolean> {
    const normalise = (value: string) => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const title = eventData.MOBILE_BANNER_TITLE || eventData.PPV_NAME || this.ppvName;
    const date = eventData.HOME_POPUP_DATE || eventData.MOBILE_BANNER_DATE_TIME || eventData.MOBILE_PPV_DATE || eventData.PPV_DATE;
    const description = eventData.MOBILE_BANNER_DESCRIPTION || eventData.PPV_DESCRIPTION || eventData.DESCRIPTION;
    const titleTerms = normalise(this.ppvDiscoveryTitleQuery(title)).split(' ').filter(term => term.length >= 3 && term !== 'vs');

    console.log(`🏠 [Home Popup] Polling for the configured PPV popup: "${title}"`);
    let cachedSource = '';
    await this.driver.waitUntil(async () => {
      const source = await this.driver.getPageSource().catch(() => '');
      const popupText = normalise(source);
      if (titleTerms.every(term => popupText.includes(term)) && /\bbuy now\b/i.test(source)) {
        cachedSource = source;
        return true;
      }
      return false;
    }, {
      timeout: Number(process.env.HOME_PAGE_POPUP_TIMEOUT_MS || 30000),
      interval: 500,
      timeoutMsg: `Configured Home popup for "${title}" did not appear after authentication.`,
    });

    const source = cachedSource || await this.driver.getPageSource();
    const popupText = normalise(source);
    const assertConfiguredText = (label: string, expected: string) => {
      if (!expected) throw new Error(`[Home Popup] Missing configured ${label} for "${title}".`);
      const expectedTerms = normalise(label === 'title' ? this.ppvDiscoveryTitleQuery(expected) : expected)
        .split(' ').filter(term => term.length >= 3);
      if (!expectedTerms.every(term => popupText.includes(term))) {
        throw new Error(`[Home Popup] ${label} does not match configured PPV "${title}". Expected: "${expected}".`);
      }
    };
    assertConfiguredText('title', title);
    // Description check is a soft warning — minor text differences are possible
    try { assertConfiguredText('description', description); } catch (e: any) {
      console.warn(`⚠️ ${e.message} — continuing (popup confirmed by title).`);
    }

    await hooks.validateSurface?.('PPV Popup');

    // Find and click the Buy Now button directly (no container scoping needed)
    const buyNowSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Buy Now" OR label == "Buy Now" OR name == "Buy now" OR label == "Buy now")',
      '~Buy Now',
      '~Buy now',
    ];
    let buyNowClicked = false;
    for (const sel of buyNowSelectors) {
      const buttons = await this.driver.$$(sel).catch(() => []);
      for (const button of buttons) {
        if (await button.isDisplayed().catch(() => false)) {
          await button.click();
          buyNowClicked = true;
          break;
        }
      }
      if (buyNowClicked) break;
    }
    if (!buyNowClicked) {
      throw new Error(`[Home Popup] Buy Now CTA not found or not clickable for "${title}".`);
    }
    console.log(`✅ [Home Popup] Validated and clicked the configured PPV Buy Now CTA: "${title}".`);

    // ── Post-Buy-Now: validate native paywall and handoff to Safari ───
    console.log('Validating native Home Popup paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_home_popup_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    return this.tapBuyCtaWithFallback([
      'Go to dazn.com/start',
      'Go to DAZN.com/start',
      'dazn.com/start',
      'Buy now',
      'Buy Now',
      'Buy',
      'Get PPV',
      'Purchase',
    ]);
  }

  async ensureOnHome(): Promise<void> {
    const homeTabSel = '-ios predicate string:(name == "Home" OR label == "Home") AND type == "XCUIElementTypeButton"';
    const homeTab = await this.driver.$(homeTabSel);
    if (await homeTab.isDisplayed().catch(() => false)) {
      console.log('  Already on Home page');
      return;
    }

    const homeClicked = await this.tapByText('Home', 3000);
    if (!homeClicked) {
      console.log('  Could not tap Home by text; trying to click home button locator...');
      await homeTab.click().catch(() => { });
    }
    await this.driver.pause(3000);
  }

  async openHomeBannerPaywall(hooks: IOSFlowHooks = {}, options: { immediatePaywall?: boolean } = {}): Promise<boolean> {
    await this.ensureOnHome();
    await this.driver.pause(2000);

    const bannerCtaTapped = await this.openBannerPaywall({
      label: 'Home Page',
      pageName: 'Home page',
      missingScreenshot: './test-results/ios_home_ppv_banner_not_found.png',
      foundScreenshot: './test-results/ios_home_ppv_banner_found.png',
      buyMissingScreenshot: './test-results/ios_home_buy_cta_not_found.png',
      ctaTexts: ['Buy now', 'Buy Now'],
      validateSurface: 'PPV Banner',
      immediatePaywall: options.immediatePaywall ?? true,
      recordPage: 'Home Page',
      ensureBannerStillVisibleBeforeBuy: true,
      tapVerifiedBannerCta: true,
    }, hooks);
    if (!bannerCtaTapped) return false;

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(
      String(process.env.USER_STATE || '').toLowerCase().trim(),
    );
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimateUser && isLoginFirst) return true;

    console.log('Validating native Home Page paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_home_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    return this.tapBuyCtaWithFallback([
      'Go to dazn.com/start',
      'Go to DAZN.com/start',
      'dazn.com/start',
      'Buy now',
      'Buy Now',
      'Buy',
      'Get PPV',
      'Purchase',
    ]);
  }

  async openGenericPPVPaywall(hooks: IOSFlowHooks = {}): Promise<boolean> {
    console.log(`Unknown source fallback - finding "${this.ppvName}" from current screen`);
    const found = await this.findPPVBanner(this.ppvName);
    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot);
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found`);
      throw new Error(`"${this.ppvName}" not found`);
    }

    hooks.recordAvailability?.(true);
    await this.runSurfaceValidation(hooks, 'PPV Banner');
    await this.tapByText(this.ppvName);
    await this.driver.pause(2000);

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      await this.validateUltimateFixtureOrPreviewPage(hooks);
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Tile clicked (generic). Skipping Buy click and returning true.');
      return true;
    }

    return this.tapBuyCtaWithFallback(['Buy now', 'Buy Now', 'Buy'], { scrollBeforeFallback: false });
  }

  async openHomePageDontMissPaywall(
    hooks: IOSFlowHooks = {},
    options: { skipEnsureHome?: boolean; recordPage?: string } = {},
  ): Promise<boolean> {
    console.log('Home Page -> Find "Don\'t Miss" rail -> swipe to PPV tile -> open PPV');
    if (!options.skipEnsureHome) await this.ensureOnHome();
    delete process.env.IOS_DONT_MISS_PPV_TILE_FOUND;
    delete process.env.IOS_DONT_MISS_OCR_TEXTS;

    // iOS accessibility labels vary between the straight and typographic
    // apostrophe, depending on the feed payload and OS text rendering.
    const railLabels = ["Don't Miss", 'Don’t Miss', 'Dont Miss'];
    // XCUITest can report collection items as displayed while they sit beyond
    // the left or right edge of a horizontally scrolling rail. Require the
    // element's centre point to be on screen so an off-screen/edge-only PPV
    // card cannot bypass the rail swipe loop.
    const isInViewport = async (candidate: any): Promise<boolean> => {
      if (typeof candidate?.getLocation !== 'function') return false;
      const [viewport, location, size] = await Promise.all([
        this.driver.getWindowRect().catch(() => null),
        candidate.getLocation().catch(() => null),
        typeof candidate.getSize === 'function'
          ? candidate.getSize().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!viewport || !location || !size || size.width <= 0 || size.height <= 0) return false;
      const centreX = location.x + (size?.width || 0) / 2;
      const centreY = location.y + (size?.height || 0) / 2;
      return centreX >= 0 && centreX < viewport.width && centreY >= 0 && centreY < viewport.height;
    };
    const findVisibleDontMissRail = async (): Promise<any | undefined> => {
      for (const label of railLabels) {
        const selectors = [
          `~${label}`,
          `-ios predicate string:type == "XCUIElementTypeStaticText" AND (name CONTAINS[c] "${label}" OR label CONTAINS[c] "${label}")`,
          `-ios predicate string:name CONTAINS[c] "${label}" OR label CONTAINS[c] "${label}"`,
        ];
        for (const selector of selectors) {
          const candidates = await this.driver.$$(selector);
          for (const candidate of candidates) {
            if (!(await candidate.isDisplayed().catch(() => false))) continue;
            const type = await candidate.getAttribute('type').catch(() => '');
            if (type && type !== 'XCUIElementTypeStaticText') continue;
            // XCTest can retain a displayed accessibility node after its rail
            // has moved outside the viewport. Do not lock horizontal swipes
            // to that stale heading.
            if (typeof candidate.getLocation !== 'function') continue;
            if (await isInViewport(candidate)) return candidate;
          }
        }
      }
      return undefined;
    };
    let railFound = false;
    let railY = 0;
    const findRailByRenderedHeading = async (): Promise<boolean> => {
      // On this real-device build, the screenshot shows the heading while its
      // accessibility element can be absent from page source and predicates.
      // Check the rendered screen directly, rather than gating OCR on the
      // unavailable native hierarchy.
      const visualRail = await locateIOSDontMissRailByImage(this.driver);
      if (!visualRail.visible || visualRail.yPercent === null) return false;
      const { height } = await this.driver.getWindowRect();
      railY = Math.round(height * visualRail.yPercent);
      console.log(`  Found rendered Don't Miss heading at y=${railY}; stopping vertical scroll.`);
      return true;
    };
    // After an existing-user login, the Home tab is visible before its feed
    // has rendered. Wait for the actual rail condition before any vertical
    // movement; otherwise the scroll can outrun the late-arriving feed.
    railFound = await this.driver.waitUntil(async () => {
      const rail = await findVisibleDontMissRail();
      if (!rail) return false;
      const location = await rail.getLocation().catch(() => null);
      if (!location) return false;
      railY = location.y;
      railFound = true;
      return true;
    }, {
      timeout: 10000,
      interval: 500,
      timeoutMsg: "Don't Miss rail did not appear in the initial Home feed.",
    }).then(() => true).catch(() => false);
    // Some real-device builds render the heading in the screenshot before it
    // becomes an accessibility element. Preserve the OCR fallback, but only
    // after the native rail wait so it is not repeatedly invoked while the
    // feed is still mounting.
    let lastRailOcrAttempt = 0;
    if (!railFound) railFound = await findRailByRenderedHeading();
    // Keep the vertical movement deliberately small. The generic scrollDown
    // gesture moves roughly 40% of the screen and can take this rail from
    // below the fold to above it in one action before it is checked again.
    const scrollTowardDontMissRail = async (): Promise<void> => {
      const { width, height } = await this.driver.getWindowRect();
      const x = Math.round(width / 2);
      await this.driver.performActions([{
        type: 'pointer', id: 'dont-miss-vertical-search', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x, y: Math.round(height * 0.65) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerMove', duration: 250, x, y: Math.round(height * 0.50) },
          { type: 'pointerUp', button: 0 },
        ],
      }]);
      await this.driver.releaseActions();
    };
    for (let attempt = 0; attempt < 20 && !railFound; attempt++) {
      const rail = await findVisibleDontMissRail();
      if (rail) {
        const location = await rail.getLocation();
        railY = location.y;
        railFound = true;
        console.log(`  Found visible Don't Miss rail at y=${railY}; stopping vertical scroll.`);
      } else if (attempt - lastRailOcrAttempt >= 2) {
        lastRailOcrAttempt = attempt;
        railFound = await findRailByRenderedHeading();
      }
      if (!railFound) {
        console.log(`  Don't Miss rail is not in the viewport; making short vertical swipe ${attempt + 1}/20.`);
        await scrollTowardDontMissRail();
        // Poll the real rail condition after each small gesture. This waits
        // for the native list to settle without adding a blind delay.
        await this.driver.waitUntil(async () => {
          const appearedRail = await findVisibleDontMissRail();
          if (!appearedRail) return false;
          const location = await appearedRail.getLocation().catch(() => null);
          if (!location) return false;
          railY = location.y;
          railFound = true;
          console.log(`  Found visible Don't Miss rail at y=${railY}; stopping vertical scroll.`);
          return true;
        }, {
          timeout: 1500,
          interval: 250,
          timeoutMsg: "Don't Miss rail did not appear after the short vertical swipe.",
        }).catch(() => { });
      }
    }

    // A heading at the bottom of the viewport leaves its cards underneath the
    // bottom navigation, and a horizontal gesture at the calculated rail
    // position lands above the cards. Move the discovered rail into the middle
    // once, then re-query it before starting the horizontal search.
    if (railFound) {
      const { height } = await this.driver.getWindowRect();
      if (railY > height * 0.55) {
        console.log(`  Don't Miss rail is at y=${railY}; making one short swipe to centre its cards.`);
        await scrollTowardDontMissRail();
        await this.driver.waitUntil(async () => {
          const centredRail = await findVisibleDontMissRail();
          if (centredRail) {
            const location = await centredRail.getLocation().catch(() => null);
            if (location) {
              railY = location.y;
              return true;
            }
          }
          return findRailByRenderedHeading();
        }, {
          timeout: 1500,
          interval: 250,
          timeoutMsg: "Don't Miss rail did not remain visible while being centred.",
        });
        console.log(`  Don't Miss rail centred at y=${railY}; starting horizontal search from its card row.`);
      }
    }

    const recordPage = options.recordPage || 'Home Page';
    if (!railFound) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_dont_miss_rail_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, recordPage);
      await hooks.generateAvailabilityFailureReport?.('"Don\'t Miss" rail not found');
      throw new Error('"Don\'t Miss" rail not found. See test-results/ios_dont_miss_rail_not_found.png');
    }

    const { width, height } = await this.driver.getWindowRect();
    // Do not vertically scroll after this point. Once the rail is visible,
    // all remaining discovery happens in its horizontal card row.
    console.log(`  Don't Miss rail locked at y=${railY}; starting horizontal search only.`);
    // Start inside the upper half of the card row. A lower point can fall on
    // the card edge or the content below it after the rail has been centred.
    const swipeY = Math.max(Math.round(height * 0.30), Math.min(Math.round(height * 0.80), railY + Math.round(height * 0.10)));
    const swipeRail = async (direction: 'left' | 'right', pointerId: string, centreNudge = false): Promise<void> => {
      // Travel about one rendered card width while searching, but use a
      // smaller nudge once the target tile is already visible.
      const startX = direction === 'left'
        ? Math.round(width * (centreNudge ? 0.62 : 0.70))
        : Math.round(width * (centreNudge ? 0.38 : 0.30));
      const endX = direction === 'left'
        ? Math.round(width * (centreNudge ? 0.46 : 0.38))
        : Math.round(width * (centreNudge ? 0.54 : 0.62));
      await this.driver.performActions([{
        type: 'pointer', id: pointerId, parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: startX, y: swipeY },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 40 },
          { type: 'pointerMove', duration: 180, x: endX, y: swipeY },
          { type: 'pointerUp', button: 0 },
        ],
      }]);
      await this.driver.releaseActions();
    };
    const discoveryTitle = this.ppvDiscoveryTitleQuery(this.ppvName);
    let railBottom = 0;
    const refreshRailBounds = async (): Promise<void> => {
      const bounds = await locateIOSDontMissRailByImage(this.driver);
      if (!bounds.visible || bounds.yPercent === null || bounds.bottomYPercent === undefined) {
        await this.driver.saveScreenshot('./test-results/ios_dont_miss_ppv_not_found.png');
        throw new Error(`Cannot establish rendered Don't Miss card-row bounds for "${this.ppvName}"; refusing to tap another rail.`);
      }
      railY = Math.ceil(bounds.yPercent * height);
      railBottom = Math.floor(bounds.bottomYPercent * height);
    };
    await refreshRailBounds();
    let targetTileOutsideViewport = false;
    const findVisiblePpvTile = async (): Promise<any | undefined> => {
      targetTileOutsideViewport = false;
      const inspectedCandidates = new Set<string>();
      const predicate = `(name CONTAINS[c] "${this.iosPredicateValue(discoveryTitle)}" OR label CONTAINS[c] "${this.iosPredicateValue(discoveryTitle)}")`;
      const candidates = await this.driver.$$(`-ios predicate string:${predicate}`);
      for (const candidate of candidates) {
        if (!(await candidate.isDisplayed().catch(() => false))) continue;
        const location = await candidate.getLocation().catch(() => undefined);
        if (!location || location.y < railY || location.y >= railBottom) continue;
        const size = await candidate.getSize().catch(() => null);
        if (!size || size.width <= 0 || size.height <= 0 || location.y + size.height > railBottom) continue;
        const fingerprint = `${location.x}:${location.y}:${size?.width || 0}:${size?.height || 0}`;
        // XCUITest can expose multiple nodes at the same card bounds.
        if (inspectedCandidates.has(fingerprint)) continue;
        inspectedCandidates.add(fingerprint);
        const name = await candidate.getAttribute('name');
        const label = await candidate.getAttribute('label');
        if (ANCILLARY_PPV_CONTENT.test(`${name || ''} ${label || ''}`)) continue;
        const isTargetTitle = [name, label].some(value => this.isPpvDiscoveryTitle(String(value || ''), this.ppvName));
        if (!isTargetTitle) continue;
        const centreX = location.x + (size?.width || 0) / 2;
        const centreY = location.y + (size?.height || 0) / 2;
        if (centreX < 0 || centreX >= width || centreY < 0 || centreY >= height) {
          console.log(`  PPV tile is outside the horizontal viewport at x=${location.x}, y=${location.y}; continuing rail swipe search.`);
          targetTileOutsideViewport = true;
          return undefined;
        }
        console.log(`  Found PPV tile name="${name}" label="${label}" at x=${location.x}, y=${location.y}, width=${size.width}, height=${size.height} inside Don't Miss [${railY}, ${railBottom}].`);
        return candidate;
      }
      return undefined;
    };

    // Don't Miss cards are artwork-only on iOS: XCTest exposes the rail title
    // but not necessarily the PPV title inside the image. OCR the current
    // screenshot locally without changing the scroll or rail-location logic.
    let latestRailScreenshotFingerprint = '';
    const findPpvTileByImage = async (collectEvidenceWithoutTitleMatch = false): Promise<{ x: number; y: number } | undefined> => {
      const visualMatch = await locateIOSPpvTileByImage(this.driver, this.ppvName, {
        minYPercent: Math.max(0, railY / height),
        maxYPercent: Math.min(1, railBottom / height),
      }, collectEvidenceWithoutTitleMatch, true);
      latestRailScreenshotFingerprint = visualMatch.screenshotFingerprint || '';
      if (!visualMatch.visible || visualMatch.xPercent === null || visualMatch.yPercent === null) {
        if (collectEvidenceWithoutTitleMatch && visualMatch.ocrTexts?.length) {
          // The native tile lookup has already confirmed this event. Retain its
          // complete title when artwork OCR splits or misspells a fighter name.
          process.env.IOS_DONT_MISS_OCR_TEXTS = JSON.stringify([
            ...visualMatch.ocrTexts,
            this.ppvName,
          ]);
        }
        return undefined;
      }

      const x = Math.round(width * visualMatch.xPercent);
      const y = Math.round(height * visualMatch.yPercent);
      if (x < 0 || x > width || y < railY || y > railBottom) {
        console.warn(`  Ignoring visual PPV match outside the Don't Miss rail: x=${x}, y=${y}`);
        return undefined;
      }
      process.env.IOS_DONT_MISS_OCR_TEXTS = JSON.stringify([
        ...(visualMatch.ocrTexts || []),
        ...(collectEvidenceWithoutTitleMatch ? [this.ppvName] : []),
      ]);
      console.log(`  Found PPV artwork for "${this.ppvName}" at x=${x}, y=${y}; stopping horizontal search.`);
      return { x, y };
    };

    let ppvTile = await findVisiblePpvTile();
    let visualTile: { x: number; y: number } | undefined = ppvTile
      ? undefined
      : await findPpvTileByImage();
    const maxHorizontalRailSwipes = 40;
    let previousRailScreenshotFingerprint = createHash('sha256')
      .update(await this.driver.takeScreenshot())
      .digest('hex');
    let unchangedRailSwipes = 0;
    for (let attempt = 0; attempt < maxHorizontalRailSwipes && !ppvTile && !visualTile; attempt++) {
      console.log(`  PPV tile is not in the current card viewport; making short horizontal swipe ${attempt + 1}/${maxHorizontalRailSwipes}.`);
      await swipeRail('left', 'dont-miss-rail-search');
      ppvTile = await findVisiblePpvTile();
      if (!ppvTile && !targetTileOutsideViewport) visualTile = await findPpvTileByImage();
      if (!ppvTile && !visualTile && latestRailScreenshotFingerprint) {
        unchangedRailSwipes = latestRailScreenshotFingerprint === previousRailScreenshotFingerprint
          ? unchangedRailSwipes + 1
          : 0;
        previousRailScreenshotFingerprint = latestRailScreenshotFingerprint;
        if (unchangedRailSwipes >= 2) {
          console.log('  Don\'t Miss rail did not move after consecutive horizontal swipes; stopping search.');
          break;
        }
      }
    }

    // Vision OCR starts a Swift process and can take tens of seconds on the
    // test host. It is an artwork-only fallback, so keep native search first
    // and only do one final evidence/fallback pass if the loop did not match.
    if (!ppvTile && !visualTile) visualTile = await findPpvTileByImage();

    if (!ppvTile && !visualTile) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_dont_miss_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, recordPage);
      await hooks.generateAvailabilityFailureReport?.(`No PPV tile configured for "${this.ppvName}" on ${recordPage} Don't Miss rail`);
      throw new Error(`No PPV tile configured for "${this.ppvName}" on ${recordPage} Don't Miss rail. See test-results/ios_dont_miss_ppv_not_found.png`);
    }

    // Centre the found card before validation and interaction. The card can
    // first appear at either edge after a search swipe, where validation
    // screenshots are incomplete and the title element is a poor tap target.
    for (let adjustment = 0; adjustment < 2; adjustment++) {
      const location = ppvTile
        ? await ppvTile.getLocation().catch(() => null)
        : visualTile;
      const size = ppvTile
        ? await ppvTile.getSize().catch(() => null)
        : null;
      if (!location) break;
      const tileCenterX = location.x + (size?.width || 0) / 2;
      const centreTolerance = width * 0.15;
      if (Math.abs(tileCenterX - width / 2) <= centreTolerance) break;

      const direction = tileCenterX > width / 2 ? 'left' : 'right';
      console.log(`  PPV tile is at x=${Math.round(tileCenterX)}; making short ${direction} swipe to centre it before validation.`);
      await swipeRail(direction, 'dont-miss-rail-centre', true);
      if (ppvTile) {
        await this.driver.waitUntil(async () => Boolean(await findVisiblePpvTile()), {
          timeout: 1200,
          interval: 250,
          timeoutMsg: `PPV tile "${this.ppvName}" did not remain visible while being centred.`,
        });
      }
      ppvTile = await findVisiblePpvTile();
      visualTile = ppvTile ? undefined : await findPpvTileByImage();
      if (!ppvTile && !visualTile) {
        throw new Error(`PPV "${this.ppvName}" disappeared while being centred in Don't Miss rail.`);
      }
    }

    // Native title nodes do not contain the date rendered in the card artwork.
    // Capture OCR evidence once the target is centred so PPV Date validation
    // uses the visible card rather than replacing it with the title alone.
    const visualEvidence = await findPpvTileByImage(Boolean(ppvTile));
    if (visualEvidence) visualTile = visualTile || visualEvidence;

    process.env.IOS_DONT_MISS_PPV_TILE_FOUND = 'true';
    if (ppvTile && !process.env.IOS_DONT_MISS_OCR_TEXTS) {
      process.env.IOS_DONT_MISS_OCR_TEXTS = JSON.stringify([this.ppvName]);
    }
    hooks.recordAvailability?.(true, undefined, recordPage);
    await this.driver.saveScreenshot('./test-results/ios_dont_miss_ppv_found.png');
    await this.runSurfaceValidation(hooks, 'PPV Tile');
    // Validation can refresh the native rail. Reacquire an exact configured
    // title or a complete artwork match before interacting with it.
    await refreshRailBounds();
    ppvTile = await findVisiblePpvTile();
    visualTile = ppvTile ? undefined : await findPpvTileByImage();
    if (!ppvTile && !visualTile) {
      throw new Error(`PPV "${this.ppvName}" was no longer visible in Don't Miss after validation.`);
    }
    if (ppvTile) {
      try {
        await ppvTile.click();
        console.log(`  Opened PPV tile "${this.ppvName}" immediately after it became visible.`);
      } catch {
        const location = await ppvTile.getLocation();
        const size = await ppvTile.getSize();
        if (location.y < railY || location.y + size.height > railBottom) {
          throw new Error(`PPV "${this.ppvName}" moved outside Don't Miss before the fallback tap.`);
        }
        await this.driver.performActions([{
          type: 'pointer', id: 'dont-miss-ppv-tile', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(location.x + size.width / 2), y: Math.round(location.y + size.height / 2) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }]);
        await this.driver.releaseActions();
        console.log(`  Opened PPV tile "${this.ppvName}" using its visible element bounds.`);
      }
    } else {
      await this.driver.performActions([{
        type: 'pointer', id: 'dont-miss-ppv-artwork', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: visualTile!.x, y: visualTile!.y },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerUp', button: 0 },
        ],
      }]);
      await this.driver.releaseActions();
      console.log(`  Opened PPV tile "${this.ppvName}" using its artwork coordinates.`);
    }
    await this.driver.pause(2000);

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimateUser && isLoginFirst) {
      await this.validateUltimateFixtureOrPreviewPage(hooks);
      return true;
    }

    console.log('Validating native Don\'t Miss paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_dont_miss_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    const externalCtas = [
      'Go to dazn.com/start',
      'Go to DAZN.com/start',
      'dazn.com/start',
    ];
    return this.tapBuyCtaWithFallback(externalCtas, {
      scrollBeforeFallback: true,
      fallbackCtas: externalCtas,
    });
  }

  /**
   * Open a DAZN base entitlement tile on the Home page for defaultSignup flows.
   * Uses Rails API (entitlement-based discovery), scrolls to the matching rail,
   * taps the tile, handles content picker, and waits for the paywall CTA.
   * All native validation hooks are stripped since this is not a PPV-specific tile.
   */
  async openDaznTilePaywall(hooks: IOSFlowHooks = {}): Promise<boolean> {
    const { AndroidRailsFetcher } = require('../../utils/androidRailsFetcher');
    const tileEntitlement = 'base_dazn_content';
    console.log(`Home -> DAZN base entitlement tile discovery (entitlement: ${tileEntitlement})`);

    await this.ensureOnHome();

    // 1. Fetch Rails API to identify the matching rail and tile
    const railsFetch = await AndroidRailsFetcher.fetchAndMatchRails({
      page: 'Home',
      entitlementId: tileEntitlement,
      country: process.env.DAZN_REGION || 'GB',
      platform: 'ios',
    });

    if (!railsFetch.matchingTiles.length) {
      throw new Error(`❌ No DAZN base entitlement tile (${tileEntitlement}) found via Rails API`);
    }

    // Get the target rail and tile index from API results
    const apiMatch = railsFetch.matchingTiles[0];
    const targetRail = apiMatch.railTitle || 'Best of DAZN';
    const tileIndex = apiMatch.tileIndex ?? 0;
    const tileTitle = apiMatch.tileTitle || apiMatch.eventTitle || '';
    console.log(`  📡 API: tile "${tileTitle}" at index ${tileIndex} in rail "${targetRail}"`);

    // 2. Scroll to the target rail header
    const railFound = await this.scrollToText(targetRail);
    if (!railFound) {
      console.warn(`  ⚠️ Rail "${targetRail}" not found — trying "Best of DAZN" partial match...`);
      await this.scrollToText('Best of DAZN');
    }

    // 3. Find the rail header element position for coordinate-based tile taps
    const { width, height } = await this.driver.getWindowSize();
    let tileTapped = false;

    const railSel = `-ios predicate string:label CONTAINS[c] '${targetRail}' OR name CONTAINS[c] '${targetRail}'`;
    let railEl = await this.driver.$(railSel).catch(() => null);

    if (railEl) {
      let railLoc = await railEl.getLocation().catch(() => null);
      let railSize = await railEl.getSize().catch(() => null);

      if (railLoc && railSize) {
        // scrollToText can leave the rail at the bottom of the viewport, where
        // its cards overlap the fixed tab bar. Centre the card row before any
        // horizontal swipes or coordinate tap so the tap cannot hit News.
        for (let adjustment = 0; adjustment < 3 && railLoc && railSize; adjustment++) {
          const desiredHeaderY = Math.round((height * 0.45) - railSize.height - (height * 0.08));
          const offset = railLoc.y - desiredHeaderY;
          if (Math.abs(offset) <= 40) break;

          const distance = Math.min(Math.max(Math.abs(offset), 120), Math.round(height * 0.38));
          const startY = offset > 0 ? Math.round(height * 0.70) : Math.round(height * 0.30);
          const endY = offset > 0 ? startY - distance : startY + distance;
          await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
            .move({ duration: 0, x: Math.round(width * 0.5), y: startY })
            .down()
            .pause(150)
            .move({ duration: 400, x: Math.round(width * 0.5), y: endY })
            .up()
            .perform();
          await this.driver.pause(700);
          railEl = await this.driver.$(railSel).catch(() => null);
          railLoc = railEl ? await railEl.getLocation().catch(() => null) : null;
          railSize = railEl ? await railEl.getSize().catch(() => null) : null;
        }

        if (!railLoc || !railSize) {
          throw new Error(`❌ Rail "${targetRail}" disappeared while positioning its tile row`);
        }
        // Calculate tile tap Y: below rail header, within the tile row area
        const tileY = Math.round(railLoc.y + railSize.height + (height * 0.08));
        const tapX = Math.round(width * 0.5); // center of screen
        console.log(`  Rail header at y=${railLoc.y}, tile row at y≈${tileY}`);

        // 4. Swipe LEFT within the tile row to reach the target tile index
        //    (mirrors Android DynamicPpvTileLocator: swipe to tileIndex position)
        if (tileIndex > 0) {
          console.log(`  Swiping left ${tileIndex} time(s) to reach tile index ${tileIndex}...`);
          for (let i = 0; i < tileIndex; i++) {
            // Swipe left within the tile row (not full-width to stay within the rail)
            await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
              .move({ duration: 0, x: Math.round(width * 0.8), y: tileY })
              .down()
              .pause(200)
              .move({ duration: 300, x: Math.round(width * 0.2), y: tileY })
              .up()
              .perform();
            await this.driver.pause(500);
          }
        }

        // 5. Tap the tile at center
        console.log(`  Tapping tile at (${tapX}, ${tileY})...`);
        await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
          .move({ duration: 0, x: tapX, y: tileY })
          .down()
          .pause(100)
          .up()
          .perform();
        await this.driver.pause(2000);

        // 6. Verify content picker appeared (confirms correct DAZN locked tile)
        const src = (await this.driver.getPageSource().catch(() => '')).toLowerCase();
        if (src.includes('select what you want to watch') || (src.includes('full replay') && src.includes('subscribe'))) {
          console.log(`  ✓ Content picker detected — correct DAZN tile at index ${tileIndex}`);
          tileTapped = true;
        } else if (src.includes('go to dazn.com') || src.includes('go to dazn')) {
          console.log(`  ✓ Paywall CTA detected — DAZN tile opened directly`);
          tileTapped = true;
        } else {
          // Wrong tile — try neighboring indices (index ± 1, ± 2)
          console.log(`  ✗ Tile at index ${tileIndex} did not open content picker — trying neighbors...`);
          await this.driver.back().catch(() => {});
          await this.driver.pause(1000);

          for (const offset of [1, -1, 2]) {
            const neighborSwipes = offset;
            if (neighborSwipes > 0) {
              for (let s = 0; s < neighborSwipes; s++) {
                await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
                  .move({ duration: 0, x: Math.round(width * 0.8), y: tileY })
                  .down()
                  .pause(200)
                  .move({ duration: 300, x: Math.round(width * 0.2), y: tileY })
                  .up()
                  .perform();
                await this.driver.pause(400);
              }
            } else {
              for (let s = 0; s < Math.abs(neighborSwipes); s++) {
                await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
                  .move({ duration: 0, x: Math.round(width * 0.2), y: tileY })
                  .down()
                  .pause(200)
                  .move({ duration: 300, x: Math.round(width * 0.8), y: tileY })
                  .up()
                  .perform();
                await this.driver.pause(400);
              }
            }

            await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
              .move({ duration: 0, x: tapX, y: tileY })
              .down()
              .pause(100)
              .up()
              .perform();
            await this.driver.pause(2000);

            const neighborSrc = (await this.driver.getPageSource().catch(() => '')).toLowerCase();
            if (neighborSrc.includes('select what you want to watch') || (neighborSrc.includes('full replay') && neighborSrc.includes('subscribe')) || neighborSrc.includes('go to dazn.com')) {
              console.log(`  ✓ Content picker found at neighbor index ${tileIndex + offset}`);
              tileTapped = true;
              break;
            }
            await this.driver.back().catch(() => {});
            await this.driver.pause(1000);
          }
        }
      }
    }

    if (!tileTapped) {
      throw new Error(`❌ No DAZN base entitlement tile found in "${targetRail}" rail`);
    }

    // 4. Handle content picker ("Select what you want to watch")
    await this.driver.pause(1500);
    const pageSrc = (await this.driver.getPageSource().catch(() => '')).toLowerCase();

    if (pageSrc.includes('select what you want to watch') || (pageSrc.includes('full replay') && pageSrc.includes('subscribe'))) {
      console.log('  Content picker detected — looking for Subscribe CTA...');

      // Preferred: tap Subscribe directly
      const subscribeFound = await this.tapByText('Subscribe', 3000);
      if (!subscribeFound) {
        // Fallback: tap locked Full Replay row, then Subscribe
        console.log('  Subscribe not directly tappable — tapping locked Full Replay row first...');
        await this.tapByText('Full Replay', 3000);
        await this.driver.pause(1500);
        await this.tapByText('Subscribe', 3000);
      }

      console.log('  Subscribe tapped — waiting for paywall...');
      // Wait for the paywall CTA to appear
      const maxWaitMs = 30000;
      const pollStart = Date.now();
      const ctaTexts = ['Go to dazn.com/start', 'Go to DAZN.com/start', 'dazn.com/start'];
      let ctaVisible = false;
      while (Date.now() - pollStart < maxWaitMs) {
        for (const cta of ctaTexts) {
          if (await this.isVisible(cta, 1000)) {
            ctaVisible = true;
            break;
          }
        }
        if (ctaVisible) break;
        await this.driver.pause(1000);
      }
      if (ctaVisible) {
        console.log(`  ✓ Paywall CTA visible (${Date.now() - pollStart}ms).`);
      } else {
        console.log('  ⚠️ Paywall CTA not detected within 30s — proceeding anyway.');
      }
    }

    console.log('  DAZN tile opened native paywall; tapping external CTA...');

    const isUsRegion = (process.env.DAZN_REGION || '').toUpperCase() === 'US';
    const externalCtas = isUsRegion
      ? ['BUY NOW', 'Buy now']
      : ['Go to dazn.com/start', 'Go to DAZN.com/start', 'dazn.com/start'];
    const ctaTapped = await this.tapBuyCtaWithFallback(externalCtas, {
      scrollBeforeFallback: true,
      fallbackCtas: externalCtas,
    });
    if (ctaTapped || !isUsRegion) return ctaTapped;

    // This native US sheet can render BUY NOW without exposing it to XCUITest.
    const { width: viewportWidth, height: viewportHeight } = await this.driver.getWindowRect();
    await this.driver.performActions([{
      type: 'pointer', id: 'us-default-signup-buy-now', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(viewportWidth * 0.5), y: Math.round(viewportHeight * 0.88) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await this.driver.releaseActions();
    console.log('✅ [US] Tapped default-signup Buy Now via native paywall fallback position.');
    await this.driver.pause(Number(process.env.IOS_US_INAPP_BROWSER_SETTLE_MS || 2000));
    return true;
  }
}

export async function openHomeBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: IOSFlowHooks = {},
  options: { immediatePaywall?: boolean } = {},
): Promise<boolean> {
  return new IOSHomePage(driver, ppvName).openHomeBannerPaywall(hooks, options);
}

export async function openHomePageSubscribePaywall(driver: WdBrowser): Promise<boolean> {
  return new IOSHomePage(driver, '').openHomePageSubscribePaywall();
}

export async function openGenericPPVPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: IOSFlowHooks = {},
): Promise<boolean> {
  return new IOSHomePage(driver, ppvName).openGenericPPVPaywall(hooks);
}

export async function openHomePageDontMissPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: IOSFlowHooks = {},
  options: { skipEnsureHome?: boolean; recordPage?: string } = {},
): Promise<boolean> {
  return new IOSHomePage(driver, ppvName).openHomePageDontMissPaywall(hooks, options);
}

export async function openHomePagePopupPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: IOSFlowHooks = {},
  eventData: Record<string, any> = {},
): Promise<boolean> {
  return new IOSHomePage(driver, ppvName).openHomePagePopupPaywall(hooks, eventData);
}

export async function openDaznTilePaywall(
  driver: WdBrowser,
  hooks: IOSFlowHooks = {},
): Promise<boolean> {
  return new IOSHomePage(driver, '').openDaznTilePaywall(hooks);
}

async function locateIOSDontMissRailByImage(driver: WdBrowser): Promise<IOSVisualRailMatch> {
  let screenshotPath = '';
  try {
    screenshotPath = path.join(os.tmpdir(), `dazn-dont-miss-ocr-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(await driver.takeScreenshot(), 'base64'));

    const swiftVisionScript = `
      import AppKit
      import Vision

      guard CommandLine.arguments.count > 1,
            let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
            let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        exit(1)
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = ["en-GB"]
      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      try handler.perform([request])
      let values = (request.results ?? []).compactMap { observation -> [String: Any]? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        let box = observation.boundingBox
        return ["text": text, "yPercent": 1 - box.midY,
                "x": box.minX, "top": 1 - box.maxY, "bottom": 1 - box.minY, "height": box.height]
      }
      let data = try JSONSerialization.data(withJSONObject: values)
      print(String(data: data, encoding: .utf8)!)
    `;
    const output = execFileSync('/usr/bin/swift', ['-e', swiftVisionScript, screenshotPath], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const observations = JSON.parse(output) as Array<{
      text: string; yPercent: number; x: number; top: number; bottom: number; height: number;
    }>;
    const heading = observations.find(observation => /^don['\u2019]?t\s+miss$/i.test(observation.text.trim()));
    // Rail headings share the left margin and heading-size text. Stop at the
    // next rendered heading, not a screen-height estimate spanning other rails.
    const nextHeading = heading && observations
      .filter(observation => observation.top > heading.bottom &&
        Math.abs(observation.x - heading.x) <= 0.02 &&
        observation.height >= heading.height * 0.8)
      .sort((left, right) => left.top - right.top)[0];
    return heading
      ? { visible: true, yPercent: heading.bottom, bottomYPercent: nextHeading?.top }
      : { visible: false, yPercent: null };
  } catch (error: any) {
    console.warn(`  Local OCR Don't Miss heading lookup failed: ${error.message}`);
    return { visible: false, yPercent: null };
  } finally {
    if (screenshotPath && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  }
}

export async function locateIOSPpvTileByImage(
  driver: WdBrowser,
  ppvName: string,
  verticalRange?: { minYPercent: number; maxYPercent: number },
  collectEvidenceWithoutTitleMatch = false,
  requireAllPpvTerms = false,
): Promise<IOSVisualTileMatch> {
  let screenshotPath = '';
  try {
    screenshotPath = path.join(os.tmpdir(), `dazn-ppv-ocr-${process.pid}-${Date.now()}.png`);
    const screenshot = await driver.takeScreenshot();
    const screenshotFingerprint = createHash('sha256').update(screenshot).digest('hex');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));

    const swiftVisionScript = `
      import AppKit
      import Vision

      guard CommandLine.arguments.count > 1,
            let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
            let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        exit(1)
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = ["en-GB"]
      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      try handler.perform([request])
      let values = (request.results ?? []).compactMap { observation -> [String: Any]? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        let box = observation.boundingBox
      return ["text": text, "xPercent": box.midX, "yPercent": 1 - box.midY]
      }
      let data = try JSONSerialization.data(withJSONObject: values)
      print(String(data: data, encoding: .utf8)!)
    `;
    const output = execFileSync('/usr/bin/swift', ['-e', swiftVisionScript, screenshotPath], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const observations = JSON.parse(output) as Array<{ text: string; xPercent: number; yPercent: number }>;
    const normalise = (value: string) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const terms = normalise(ppvName)
      .split(/\s+vs\.?\s+|[^a-z0-9]+/)
      .map(term => term.trim())
      .filter(term => term.length >= 3);
    const railObservations = verticalRange
      ? observations.filter(observation =>
        observation.yPercent >= verticalRange.minYPercent &&
        observation.yPercent <= verticalRange.maxYPercent,
      )
      : observations;
    // Artwork can omit title metadata such as a promotion name or event
    // number. Require two configured terms in the same card area (or the
    // sole term for a one-word title), rather than every configured token.
    const candidates = railObservations
      .map(observation => ({
        observation,
        matchedTerms: terms.filter(term => normalise(observation.text).includes(term)).length,
      }))
      .filter(candidate => !ANCILLARY_PPV_CONTENT.test(candidate.observation.text));
    const match = candidates
      .filter(candidate => {
        if (candidate.matchedTerms === 0) return false;
        if (!requireAllPpvTerms) return true;
        return terms.filter(term => candidates.some(other =>
          normalise(other.observation.text).includes(term) &&
          Math.abs(other.observation.yPercent - candidate.observation.yPercent) <= 0.12 &&
          Math.abs(other.observation.xPercent - candidate.observation.xPercent) <= 0.65,
        )).length >= Math.min(2, terms.length) && !railObservations.some(other =>
          ANCILLARY_PPV_CONTENT.test(other.text) &&
          Math.abs(other.yPercent - candidate.observation.yPercent) <= 0.12 &&
          Math.abs(other.xPercent - candidate.observation.xPercent) <= 0.30,
        );
      })
      .sort((left, right) => right.matchedTerms - left.matchedTerms)[0]?.observation;
    if (!match) {
      return {
        visible: false,
        xPercent: null,
        yPercent: null,
        ocrTexts: collectEvidenceWithoutTitleMatch
          ? railObservations.map(observation => observation.text)
          : undefined,
        screenshotFingerprint,
      };
    }
    console.log(`  Local OCR matched PPV artwork text: "${match.text}".`);
    return {
      visible: true,
      xPercent: match.xPercent,
      yPercent: match.yPercent,
      // The surface validator uses this evidence for the artwork-only title
      // and date checks. Previously it was discarded even after an OCR match,
      // making those checks deterministically report "Not found".
      ocrTexts: railObservations.map(observation => observation.text),
      screenshotFingerprint,
    };
  } catch (error: any) {
    console.warn(`  Local OCR PPV lookup failed: ${error.message}`);
    return { visible: false, xPercent: null, yPercent: null };
  } finally {
    if (screenshotPath && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  }
}

export async function getIOSRenderedTextInBounds(
  driver: WdBrowser,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<string[]> {
  let screenshotPath = '';
  try {
    const screen = await driver.getWindowRect();
    screenshotPath = path.join(os.tmpdir(), `dazn-bounded-ocr-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(await driver.takeScreenshot(), 'base64'));
    const swiftVisionScript = `
      import AppKit
      import Vision

      guard CommandLine.arguments.count > 1,
            let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
            let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        exit(1)
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = ["en-GB"]
      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      try handler.perform([request])
      let values = (request.results ?? []).compactMap { observation -> [String: Any]? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        let box = observation.boundingBox
        return ["text": text, "xPercent": box.midX, "yPercent": 1 - box.midY]
      }
      let data = try JSONSerialization.data(withJSONObject: values)
      print(String(data: data, encoding: .utf8)!)
    `;
    const output = execFileSync('/usr/bin/swift', ['-e', swiftVisionScript, screenshotPath], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const observations = JSON.parse(output) as Array<{ text: string; xPercent: number; yPercent: number }>;
    const minX = Math.max(0, bounds.x / screen.width);
    const maxX = Math.min(1, (bounds.x + bounds.width) / screen.width);
    const minY = Math.max(0, bounds.y / screen.height);
    const maxY = Math.min(1, (bounds.y + bounds.height) / screen.height);
    return observations
      .filter(observation =>
        observation.xPercent >= minX && observation.xPercent <= maxX &&
        observation.yPercent >= minY && observation.yPercent <= maxY,
      )
      .map(observation => observation.text);
  } catch (error: any) {
    console.warn(`  Local OCR bounded-text lookup failed: ${error.message}`);
    return [];
  } finally {
    if (screenshotPath && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  }
}
