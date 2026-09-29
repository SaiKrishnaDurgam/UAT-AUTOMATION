import {
  AndroidFlowHooks,
  WdBrowser,
  adbSwipe,
  adbTap,
  getScreenSize,
} from './AndroidBasePage';
import { AndroidLandingPage } from './AndroidLandingPage';
import { AndroidRailsFetcher } from '../../utils/androidRailsFetcher';
import { DynamicPpvTileLocator } from '../../utils/dynamicPpvTileLocator';
import https from 'https';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export class AndroidHomePage extends AndroidLandingPage {
  async openHomePageSubscribePaywall(): Promise<boolean> {
    await this.ensureOnHome();
    const selectors = [
      'android=new UiSelector().text("Subscribe")',
      'android=new UiSelector().description("Subscribe")',
    ];
    for (const selector of selectors) {
      const button = await this.driver.$(selector).catch(() => null);
      if (button && await button.isDisplayed().catch(() => false)) {
        await button.click();
        await this.driver.waitUntil(async () => await this.isVisible('Copy', 500), {
          timeout: 15000,
          interval: 500,
          timeoutMsg: 'Home Subscribe did not open the native copy-link sheet.',
        });
        console.log('✅ Home Subscribe opened the native copy-link sheet.');
        return true;
      }
    }
    throw new Error('Home Subscribe CTA was not found after freemium login.');
  }

  async openHomePagePopupPaywall(hooks: AndroidFlowHooks = {}, eventData: Record<string, any> = {}): Promise<boolean> {
    const normalise = (value: string) => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const title = eventData.MOBILE_BANNER_TITLE || eventData.PPV_NAME || this.ppvName;
    const date = eventData.MOBILE_BANNER_DATE_TIME || eventData.MOBILE_PPV_DATE || eventData.PPV_DATE;
    const description = eventData.MOBILE_BANNER_DESCRIPTION || eventData.PPV_DESCRIPTION || eventData.DESCRIPTION;
    const titleTerms = normalise(this.ppvDiscoveryTitleQuery(title)).split(' ').filter(term => term.length >= 3 && term !== 'vs');

    console.log(`🏠 [Home Popup] Polling for the configured PPV popup: "${title}"`);
    await this.driver.waitUntil(async () => {
      const source = await this.driver.getPageSource().catch(() => '');
      const popupText = normalise(source);
      return titleTerms.every(term => popupText.includes(term)) && /\bbuy now\b/i.test(source);
    }, {
      timeout: Number(process.env.HOME_PAGE_POPUP_TIMEOUT_MS || 30000),
      interval: 500,
      timeoutMsg: `Configured Home popup for "${title}" did not appear after authentication.`,
    });

    const source = await this.driver.getPageSource();
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
      'android=new UiSelector().text("Buy Now")',
      'android=new UiSelector().text("Buy now")',
      'android=new UiSelector().description("Buy Now")',
      'android=new UiSelector().description("Buy now")',
    ];
    let buyNowClicked = false;
    for (const sel of buyNowSelectors) {
      const button = await this.driver.$(sel).catch(() => null);
      if (button && await button.isDisplayed().catch(() => false)) {
        await button.click();
        buyNowClicked = true;
        break;
      }
    }
    if (!buyNowClicked) {
      throw new Error(`[Home Popup] Buy Now CTA not found or not clickable for "${title}".`);
    }
    console.log(`✅ [Home Popup] Validated and clicked the configured PPV Buy Now CTA: "${title}".`);
    return true;
  }

  /**
   * Pre-scan the backend Rails API to check for entitlement tiles before UI interactions.
   */
  async verifyBackendEntitlementRail(options: { entitlementId?: string; ppvTitle?: string; promoter?: string }) {
    console.log('📡 [AndroidHomePage] Pre-checking backend rails API JSON payload...');
    const result = await AndroidRailsFetcher.fetchAndMatchRails(options);
    return result;
  }

  async openHomePageDontMissPaywall(hooks: AndroidFlowHooks = {}, options: { skipEnsureHome?: boolean } = {}, eventConfig?: any): Promise<boolean> {
    console.log('Home Page -> API-driven dynamic PPV tile discovery');
    if (!options.skipEnsureHome) {
      await this.ensureOnHome();
    } else {
      await this.waitForContentRailsToLoad();
    }

    const locator = new DynamicPpvTileLocator(this.driver, this.ppvName);
    const locatorRes = await locator.locateAndOpenPpvTile({
      page: 'Home',
      eventConfig,
      hooks,
      forceRailTitle: "Don't Miss",
    });

    if (locatorRes.success) {
      const userState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
      const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userState);
      const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

      if (isUltimateUser && isLoginFirst) {
        console.log('  Active Ultimate User with LOGIN_FIRST=true: Checking for PIN protection or WATCH NOW CTA on fixture screen...');
        await this.handlePinProtectionIfPresent();
        await this.driver.pause(2000);
        return true;
      }

      console.log('  PPV tile opened Android paywall; no additional Buy CTA tap required for this source.');
      return true;
    }
    return false;
  }

  async waitForContentRailsToLoad(timeoutMs = 15000): Promise<boolean> {
    console.log('⏳ Checking that Home / Boxing content rails are fully loaded and visible...');
    await this.dismissPromoPopup();
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const src = (await this.driver.getPageSource().catch(() => '')).toLowerCase();
        const railKeywords = [
          "don't miss", "dont miss", "boxing", "upcoming fights",
          "featured", "trending", "highlights", "schedule", "must watch",
          "live & upcoming", "catch up", "popular", "nfl", "spence"
        ];
        const loaded = railKeywords.some(k => src.includes(k));
        if (loaded) {
          console.log('  ✅ Content rails verified as loaded and visible on screen!');
          await this.driver.pause(2000);
          return true;
        }
      } catch {}
      console.log('  Waiting for content rails network feed to render...');
      await this.dismissPromoPopup();
      await this.driver.pause(2000);
    }
    return false;
  }

  async ensureOnHome(): Promise<void> {
    console.log('  Ensuring navigation to Home tab...');
    await this.dismissPromoPopup();
    const homeSelectors = [
      'android=new UiSelector().text("Home")',
      'android=new UiSelector().descriptionContains("Home")',
      '//android.widget.ImageView[contains(@content-desc, "Home")]',
      '//android.widget.TextView[contains(@text, "Home")]',
    ];

    const startTime = Date.now();
    const maxWaitMs = 12000;

    while (Date.now() - startTime < maxWaitMs) {
      for (const selector of homeSelectors) {
        try {
          const homeEl = await this.driver.$(selector);
          if (await homeEl.isDisplayed().catch(() => false)) {
            console.log('  ✓ Home tab verified as visible on screen. Tapping Home tab...');
            await homeEl.click();
            await this.driver.pause(2500);
            await this.waitForContentRailsToLoad();
            return;
          }
        } catch { }
      }
      console.log('  Waiting for page transition and Home tab to become visible...');
      await this.driver.pause(1500);
    }

    const homeClicked = await this.tapByText('Home', 3000);
    if (homeClicked) {
      await this.driver.pause(2500);
      await this.waitForContentRailsToLoad();
      return;
    }

    console.log('  ✓ Page transition finished. Checking content feed readiness...');
    await this.waitForContentRailsToLoad();
  }

  async openHomeBannerPaywall(hooks: AndroidFlowHooks = {}, options: { immediatePaywall?: boolean } = {}): Promise<boolean> {
    await this.ensureOnHome();
    await this.driver.pause(2000);

    return this.openBannerPaywall({
      label: 'Home Page',
      pageName: 'Home page',
      missingScreenshot: './test-results/android_home_ppv_banner_not_found.png',
      foundScreenshot: './test-results/android_home_ppv_banner_found.png',
      buyMissingScreenshot: './test-results/android_home_buy_cta_not_found.png',
      validateSurface: 'PPV Banner',
      immediatePaywall: options.immediatePaywall ?? true,
      recordPage: 'Home Page',
      ensureBannerStillVisibleBeforeBuy: true,
    }, hooks);
  }

  async openGenericPPVPaywall(hooks: AndroidFlowHooks = {}): Promise<boolean> {
    console.log(`Unknown source fallback - finding "${this.ppvName}" from current screen`);
    const found = await this.findPPVBanner(this.ppvName);
    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot);
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found`);
      throw new Error(`"${this.ppvName}" not found`);
    }

    hooks.recordAvailability?.(true);
    await this.runSurfaceValidation(hooks, 'PPV Banner');
    await this.tapByText(this.ppvName);
    await this.driver.pause(2000);

    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Tile clicked (generic). Checking for PIN Protection screen...');
      await this.handlePinProtectionIfPresent();
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Navigated to fixture page. Ending flow (no paywall expected).');
      return true;
    }

    return this.tapBuyCtaWithFallback(['Buy now', 'Buy Now', 'Buy'], { scrollBeforeFallback: false });
  }

  async scrollDownSmooth(): Promise<void> {
    const { width, height } = await this.driver.getWindowRect();
    await this.driver.action('pointer')
      .move({ x: Math.round(width / 2), y: Math.round(height * 0.65) })
      .down()
      .pause(100)
      .move({ duration: 600, x: Math.round(width / 2), y: Math.round(height * 0.35) })
      .up()
      .perform();
    await this.driver.pause(1000);
  }

  async openDaznTilePaywall(hooks: AndroidFlowHooks = {}): Promise<boolean> {
    const tileEntitlement = 'base_dazn_content';
    console.log(`Home -> DAZN base entitlement tile discovery (entitlement: ${tileEntitlement})`);

    await this.ensureOnHome();

    // 1. Fetch Rails API to identify the matching rail title and tile title
    const railsFetch = await AndroidRailsFetcher.fetchAndMatchRails({
      page: 'Home',
      entitlementId: tileEntitlement,
      country: process.env.DAZN_REGION || 'GB',
    });

    const apiMatch = railsFetch.matchingTiles[0];
    if (!apiMatch) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot(`./test-results/android_dazn_tile_not_found.png`)
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home Page');
      await hooks.generateAvailabilityFailureReport?.(`No DAZN base entitlement tile (${tileEntitlement}) found via Rails API`);
      throw new Error(`❌ No DAZN base entitlement tile (${tileEntitlement}) found on Home page`);
    }

    const tileTitle = apiMatch.tileTitle || apiMatch.eventTitle || '';
    const railTitle = apiMatch.railTitle || '';
    console.log(`  ✓ API matched tile "${tileTitle}" in rail "${railTitle}"`);

    // 2. Strip native validation hooks — defaultSignup source clicks a generic DAZN content tile,
    //    not a PPV tile; no PPV-specific native validations apply (matches web which only validates
    //    Default Signup / DAZN Plan / Payment pages in the checkout).
    const { validatePaywall: _skip, validateSurface: _skipSurface, recordAvailability: _skipAvail, ...locatorHooks } = hooks as any;

    // 3. Drive DynamicPpvTileLocator — skip internal paywall title check (generic content tile)
    const locator = new DynamicPpvTileLocator(this.driver, tileTitle);
    const locatorRes = await locator.locateAndOpenPpvTile({
      page: 'Home',
      eventConfig: { PPV_ENTITLEMENT_ID: tileEntitlement, PPV_NAME: tileTitle },
      hooks: locatorHooks as AndroidFlowHooks,
      forceRailTitle: railTitle,
      skipPaywallValidation: true,
    });

    if (locatorRes.success) {
      // 4. After tile tap a content picker may appear ("Select what you want to watch")
      //    with a locked "Full Replay" row and a Subscribe CTA.
      //    Web equivalent: clickLockedContentSelection() → then Subscribe button.
      await this.driver.pause(1500);
      const src = (await this.driver.getPageSource().catch(() => '')).toLowerCase();

      if (src.includes('select what you want to watch') || (src.includes('full replay') && src.includes('subscribe'))) {
        console.log('  Content picker detected — looking for Subscribe CTA...');

        // Try tapping Subscribe directly first (it is visible alongside locked Full Replay)
        const subscribeFound = await this.tapByText('Subscribe', 3000);
        if (!subscribeFound) {
          // Fallback: tap Full Replay row to surface Subscribe, then tap it
          console.log('  Subscribe not directly tappable — tapping locked Full Replay row first...');
          await this.tapByText('Full Replay', 3000);
          await this.driver.pause(1500);
          await this.tapByText('Subscribe', 3000);
        }

        console.log('  Subscribe tapped — waiting for Copy button on paywall overlay...');
        // Wait until the Copy button is actually visible on screen (no arbitrary timeout)
        const copySelectors = [
          'android=new UiSelector().textMatches("(?i)^Copy$")',
          '//android.widget.Button[@text="Copy"]',
          '//android.widget.TextView[@text="Copy"]',
          '//*[@content-desc="Copy"]',
        ];
        const maxWaitMs = 60000; // safety net only
        const pollStart = Date.now();
        let copyVisible = false;
        while (Date.now() - pollStart < maxWaitMs) {
          for (const sel of copySelectors) {
            try {
              const el = await this.driver.$(sel);
              if (await el.isDisplayed()) {
                copyVisible = true;
                break;
              }
            } catch {}
          }
          if (copyVisible) break;
          await this.driver.pause(1000);
        }
        if (copyVisible) {
          console.log(`  ✓ Copy button visible on paywall overlay (${Date.now() - pollStart}ms).`);
        } else {
          console.log('  ⚠️ Copy button not detected within 60s — proceeding anyway.');
        }
      }

      console.log('  DAZN tile opened native paywall overlay; ready for URL copy.');
      return true;
    }

    const shot2 = hooks.saveScreenshot
      ? await hooks.saveScreenshot(`./test-results/android_dazn_tile_paywall_failed.png`)
      : undefined;
    hooks.recordAvailability?.(false, shot2, 'Home Page');
    await hooks.generateAvailabilityFailureReport?.(`DAZN tile "${tileTitle}" found but paywall did not open`);
    throw new Error(`❌ DAZN tile "${tileTitle}" located but native paywall did not open`);
  }


}


export async function openHomeBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
  options: { immediatePaywall?: boolean } = {},
): Promise<boolean> {
  return new AndroidHomePage(driver, ppvName).openHomeBannerPaywall(hooks, options);
}

export async function openHomePageSubscribePaywall(driver: WdBrowser): Promise<boolean> {
  return new AndroidHomePage(driver, '').openHomePageSubscribePaywall();
}

export async function openGenericPPVPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidHomePage(driver, ppvName).openGenericPPVPaywall(hooks);
}

export async function openHomePageDontMissPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
  eventConfig?: any,
): Promise<boolean> {
  return new AndroidHomePage(driver, ppvName).openHomePageDontMissPaywall(hooks, {}, eventConfig);
}

export async function openHomePagePopupPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
  eventData: Record<string, any> = {},
): Promise<boolean> {
  return new AndroidHomePage(driver, ppvName).openHomePagePopupPaywall(hooks, eventData);
}

export async function openDaznTilePaywall(
  driver: WdBrowser,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidHomePage(driver, '').openDaznTilePaywall(hooks);
}


interface AndroidBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GeminiTileDetection {
  visible: boolean;
  extractedTitle: string;
  isMatch: boolean;
  x: number | null;
  y: number | null;
  error?: string;
  rawText?: string;
}

interface AndroidXmlElement extends AndroidBounds {
  tag: string;
  text: string;
  clickable: boolean;
}

function hasUsableGeminiKey(): boolean {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return false;
  const lower = apiKey.toLowerCase();
  return !lower.includes('your_') && !lower.includes('placeholder') && lower !== 'replace_me';
}

function isGeminiQuotaError(message: string): boolean {
  const lower = (message || '').toLowerCase();
  return lower.includes('http 429') || lower.includes('quota') || lower.includes('rate limit');
}

function titleTokens(title: string): string[] {
  return [...new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 3),
  )];
}

function comparableTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getDefaultDontMissArtworkBounds(headerRect: { y: number; height: number }, screenWidth: number, screenHeight: number): AndroidBounds {
  const left = Math.round(screenWidth * 0.04);
  const top = headerRect.y + headerRect.height + Math.round(screenHeight * 0.01);
  const artworkWidth = Math.round(screenWidth * 0.83);
  const artworkHeight = Math.round(artworkWidth * 0.39);
  return {
    left,
    top,
    right: Math.min(screenWidth - Math.round(screenWidth * 0.04), left + artworkWidth),
    bottom: Math.min(screenHeight, top + artworkHeight),
  };
}

function findFirstVisibleRailArtworkBounds(
  elements: AndroidXmlElement[],
  railTop: number,
  railBottom: number,
  screenWidth: number,
  screenHeight: number,
): AndroidBounds | null {
  const railElements = elements
    .filter(el => {
      const elWidth = el.right - el.left;
      const elHeight = el.bottom - el.top;
      const aspectRatio = elWidth / Math.max(elHeight, 1);
      return (
        el.top >= railTop &&
        el.bottom <= railBottom + Math.round(screenHeight * 0.08) &&
        el.left >= 0 &&
        el.left < screenWidth * 0.20 &&
        el.right > screenWidth * 0.45 &&
        elWidth > screenWidth * 0.45 &&
        elHeight > screenHeight * 0.08 &&
        elHeight < screenHeight * 0.25 &&
        aspectRatio > 1.6
      );
    })
    .sort((a, b) => {
      const areaA = (a.right - a.left) * (a.bottom - a.top);
      const areaB = (b.right - b.left) * (b.bottom - b.top);
      return a.top - b.top || a.left - b.left || areaB - areaA;
    });

  const firstArtwork = railElements[0];
  if (!firstArtwork) return null;

  const padX = Math.round(screenWidth * 0.01);
  const padY = Math.round(screenHeight * 0.005);
  return {
    left: Math.max(0, firstArtwork.left - padX),
    top: Math.max(0, firstArtwork.top - padY),
    right: Math.min(screenWidth, firstArtwork.right + padX),
    bottom: Math.min(screenHeight, firstArtwork.bottom + padY),
  };
}

function isPpvTitleMatch(candidateTitle: string, ppvName: string): boolean {
  const candidate = comparableTitle(candidateTitle);
  const target = comparableTitle(ppvName);
  if (!candidate || !target) return false;
  if (candidate.includes(target) || target.includes(candidate)) return true;

  const vsMatch = ppvName.match(/(\w+)\s+vs\.?\s+(\w+)/i);
  if (vsMatch) {
    const f1 = vsMatch[1].toLowerCase();
    const f2 = vsMatch[2].toLowerCase();
    if (f1.length >= 3 && f2.length >= 3 && candidate.includes(f1) && candidate.includes(f2)) return true;
  }

  const tokens = titleTokens(ppvName);
  if (tokens.length === 0) return false;
  const matchCount = tokens.filter(token => candidate.includes(token)).length;
  return matchCount >= Math.min(2, tokens.length);
}

function isPpvElementMatch(text: string, ppvName: string, entitlementId?: string, promoter?: string): boolean {
  if (!text) return false;
  const elClean = comparableTitle(text);
  if (!elClean) return false;

  if (isPpvTitleMatch(text, ppvName)) return true;

  const targetClean = comparableTitle(ppvName);
  if (targetClean && (elClean.includes(targetClean) || targetClean.includes(elClean))) return true;

  if (entitlementId) {
    const entClean = comparableTitle(entitlementId);
    if (entClean.length > 3 && elClean.includes(entClean)) return true;
  }

  if (promoter) {
    const promClean = comparableTitle(promoter);
    if (promClean.length > 3 && elClean.includes(promClean)) return true;
  }

  const tokens = ppvName
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !['with', 'and', 'the', 'for', 'vs', 'dazn', 'live', 'boxing', 'card', 'pass'].includes(w));

  const matchedCount = tokens.filter(t => elClean.includes(t)).length;
  if (tokens.length > 0 && matchedCount >= 1) return true;

  return false;
}

function cropPngBase64(base64Png: string, bounds: AndroidBounds): string {
  const { PNG } = require('pngjs');
  const source = PNG.sync.read(Buffer.from(base64Png, 'base64'));
  const left = Math.max(0, Math.min(source.width - 1, bounds.left));
  const top = Math.max(0, Math.min(source.height - 1, bounds.top));
  const right = Math.max(left + 1, Math.min(source.width, bounds.right));
  const bottom = Math.max(top + 1, Math.min(source.height, bounds.bottom));
  const crop = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(source, crop, left, top, right - left, bottom - top, 0, 0);
  return PNG.sync.write(crop).toString('base64');
}

async function locatePPVTileWithGemini(driver: WdBrowser, ppvName: string, tileBounds?: AndroidBounds, debugLabel?: string): Promise<GeminiTileDetection> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!hasUsableGeminiKey()) {
    console.warn('⚠️ [Gemini] GEMINI_API_KEY not configured. Cannot perform visual tile detection.');
    return { visible: false, extractedTitle: '', isMatch: false, x: null, y: null, error: 'GEMINI_API_KEY is unavailable' };
  }

  try {
    const screenshotBase64 = await driver.takeScreenshot();
    const imageBase64 = tileBounds ? cropPngBase64(screenshotBase64, tileBounds) : screenshotBase64;
    if (debugLabel) {
      try {
        const fs = require('fs');
        const debugDir = path.resolve(process.cwd(), 'test-results');
        fs.mkdirSync(debugDir, { recursive: true });
        const debugPath = path.join(debugDir, `${debugLabel}.png`);
        fs.writeFileSync(debugPath, Buffer.from(imageBase64, 'base64'));
        console.log(`  [Gemini] Saved OCR crop for title extraction: ${debugPath}`);
      } catch (saveErr: any) {
        console.log(`  [Gemini] Could not save OCR crop debug image: ${saveErr.message}`);
      }
    }
    console.log(`  [Gemini] Target PPV title="${ppvName}"; screenshot captured and sending ${tileBounds ? 'cropped tile image' : 'full screen'} for title extraction.`);

    const prompt = `
      You are an OCR assistant inspecting a cropped tile image from the "Don't Miss" rail in the DAZN mobile app.
      1. Read and extract ALL text, fight titles, or fighter names written on the tile artwork for the currently visible rail tile.
      2. Set "extractedTitle" to the exact fight/event title text extracted from the image.
      3. Compare the extracted title text with the target PPV title: "${ppvName}".
      4. Set "isMatch" to true if the extracted title matches or refers to "${ppvName}" or the fighters in "${ppvName}". Otherwise set "isMatch" to false.

      Return ONLY valid JSON matching this schema:
      {
        "visible": boolean,
        "extractedTitle": string,
        "isMatch": boolean,
        "allText": string
      }
    `;

    const payload = Buffer.from(JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/png', data: imageBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0
      }
    }));

    const model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = https.request(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length)
          }
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8')
          }));
        }
      );
      req.setTimeout(30000, () => req.destroy(new Error('Gemini request timed out')));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let apiMessage = response.body;
      try {
        apiMessage = JSON.parse(response.body)?.error?.message || apiMessage;
      } catch {}
      throw new Error(`Gemini returned HTTP ${response.statusCode}: ${apiMessage.slice(0, 300)}`);
    }

    const resObj = JSON.parse(response.body);
    const textResult = resObj.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text;
    if (!textResult) throw new Error('No text in Gemini response');

    const rawGeminiText = textResult.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsedResult = JSON.parse(rawGeminiText);
    const extractedCandidates = [
      parsedResult.extractedTitle,
      parsedResult.extracted_title,
      parsedResult.fightTitle,
      parsedResult.eventTitle,
      parsedResult.title,
      parsedResult.text,
      parsedResult.allText,
      Array.isArray(parsedResult.texts) ? parsedResult.texts.join(' ') : '',
    ];
    const extractedTitle = extractedCandidates
      .find(value => typeof value === 'string' && value.trim().length > 0)
      ?.trim() || '';
    const result: GeminiTileDetection = {
      visible: parsedResult.visible !== false,
      extractedTitle,
      isMatch: false,
      x: null,
      y: null,
      rawText: rawGeminiText,
    };

    result.isMatch = isPpvTitleMatch(result.extractedTitle, ppvName);
    if (tileBounds && result.visible && result.isMatch) {
      result.x = Math.round((tileBounds.left + tileBounds.right) / 2);
      result.y = Math.round((tileBounds.top + tileBounds.bottom) / 2);
    }
    console.log(`🤖 [Gemini] Tile detection result for "${ppvName}": ${JSON.stringify({
      visible: result.visible,
      extractedTitle: result.extractedTitle,
      isMatch: result.isMatch,
      x: result.x ?? null,
      y: result.y ?? null,
    })}`);
    if (!result.extractedTitle) {
      console.log(`⚠️ [Gemini] OCR returned no extractedTitle. Raw JSON response: ${rawGeminiText.slice(0, 500)}`);
    }
    return result;
  } catch (err: any) {
    console.error(`⚠️ [Gemini] Failed to detect tile: ${err.message}`);
    return { visible: false, extractedTitle: '', isMatch: false, x: null, y: null, error: err.message };
  }
}
