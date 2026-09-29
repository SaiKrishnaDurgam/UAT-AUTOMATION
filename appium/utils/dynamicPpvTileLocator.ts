import { AndroidFlowHooks, WdBrowser, adbBack, adbTap } from '../pages/android/AndroidBasePage';
import { AndroidRailTileMatch, AndroidRailsFetcher } from './androidRailsFetcher';
import { normalizeAndroidTitle, normalizeAndroidTitleWords } from './androidTitleNormalizer';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ANCILLARY_PPV_CONTENT = /\b(?:official preview|preview|locked in|press conference|press conf|weigh[\s-]?in|highlights|prelims?|pre[\s-]?show|buy[\s-]?in|tailgate(?: brawl)?|the making of|re-live|relive|countdown|all access|rewind|behind the scenes|workout|open workout|grand arrivals|documentary|episode)\b/i;

function isAncillaryPpvContent(value: string): boolean {
  return ANCILLARY_PPV_CONTENT.test(value);
}

export interface DynamicPpvTileLocatorResult {
  success: boolean;
  apiRailTitle: string;
  apiTileIndex: number;
  swipesPerformed: number;
  openedPpvTitle: string;
  apiOrderMatchedUiOrder: boolean;
  diagnosticDetails?: string;
}

export class DynamicPpvTileLocator {
  constructor(private driver: WdBrowser, private ppvName: string = '') { }

  /**
   * Main API-driven PPV tile locator and recovery sequence.
   * Derives rail title and tile index dynamically from backend Rails API response.
   */
  async locateAndOpenPpvTile(options: {
    page: 'Home' | 'Boxing' | string;
    eventConfig?: any;
    hooks?: AndroidFlowHooks;
    forceRailTitle?: string;
    minRailY?: number;
    skipPaywallValidation?: boolean;
  }): Promise<DynamicPpvTileLocatorResult> {
    const pageName = options.page || 'Home';
    const eventConfig = options.eventConfig || {};
    const hooks = options.hooks || {};

    const entitlementId = (
      eventConfig?.PPV_ENTITLEMENT_ID ||
      eventConfig?.global?.PPV_ENTITLEMENT_ID ||
      process.env.PPV_ENTITLEMENT_ID ||
      ''
    ).trim();

    const targetPpvTitle = (
      this.ppvName ||
      eventConfig?.PPV_NAME ||
      eventConfig?.global?.PPV_NAME ||
      process.env.PPV_NAME ||
      ''
    ).trim();

    const promoter = (
      eventConfig?.PPV_PROMOTER ||
      eventConfig?.global?.PPV_PROMOTER ||
      ''
    ).trim();

    // 1. Query backend Rails API and dynamically derive Rail Title and Tile Index from payload
    const railsFetch = await AndroidRailsFetcher.fetchAndMatchRails({
      page: pageName,
      entitlementId,
      ppvTitle: targetPpvTitle,
      promoter,
      country: process.env.DAZN_REGION || 'GB',
    });

    const forcedRailTitle = (options.forceRailTitle || '').trim();
    const minRailY = options.minRailY ?? 380;
    const skipPaywallValidation = options.skipPaywallValidation === true;
    // Forced PPV rails render artwork-only cards.
    // Like the iOS flow, find the configured PPV in the rendered rail before
    // tapping; a backend index is useful evidence but is not a tap coordinate.
    // Keep the generic DAZN entitlement rail on its existing index path.
    const usesVisualRailSearch = Boolean(forcedRailTitle) && !skipPaywallValidation;
    const cleanRailTitle = (value: string) => value.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim();
    let apiMatch: AndroidRailTileMatch | undefined = forcedRailTitle
      ? railsFetch.matchingTiles.find(match => cleanRailTitle(match.railTitle).includes(cleanRailTitle(forcedRailTitle)))
      : railsFetch.matchingTiles[0];

    const railTitle = (
      forcedRailTitle ||
      apiMatch?.railTitle ||
      eventConfig?.PPV_RAIL_TITLE ||
      eventConfig?.RAIL_TITLE ||
      "Don't Miss"
    ).trim();

    // 2. Scroll vertically until expected rail header is located in content viewport
    console.log(`Scrolling to rail...`);
    const railHeaderRect = await this.scrollToRail(railTitle, targetPpvTitle, entitlementId, !forcedRailTitle, minRailY);
    if (!railHeaderRect) {
      console.log(`❌ Rail "${railTitle}" not visible after scrolling.`);
      return {
        success: false,
        apiRailTitle: railTitle,
        apiTileIndex: 0,
        swipesPerformed: 0,
        openedPpvTitle: '<none>',
        apiOrderMatchedUiOrder: false,
        diagnosticDetails: `Rail "${railTitle}" header not found in viewport after content feed load.`,
      };
    }
    console.log(`Rail found at y=${railHeaderRect.y}.`);

    // 3. Derive tile index dynamically from backend API response or UI DOM scan (no hardcoded numbers)
    let expectedTileIndex: number;
    const isHomePage = pageName.toLowerCase() === 'home';
    if (forcedRailTitle && isHomePage && apiMatch?.tileIndex !== undefined) {
      expectedTileIndex = apiMatch.tileIndex;
      console.log(`  ✓ Dynamic Tile Index calculated from forced rail API order for ${pageName} page: ${expectedTileIndex}`);
    } else if (forcedRailTitle && !isHomePage) {
      // Non-Home pages (e.g. Boxing) have different rail content than the Home API returns.
      // The API index is unreliable; use it only for reporting when image-only cards require visual search.
      const detectedUiIndex = await this.detectTileIndexFromUiDom(railHeaderRect.y, targetPpvTitle, entitlementId);
      expectedTileIndex = detectedUiIndex ?? apiMatch?.tileIndex ?? 0;
      console.log(
        detectedUiIndex !== null
          ? `  ✓ Dynamic Tile Index for ${pageName} page (non-Home): ${expectedTileIndex} (UI DOM detection)`
          : `  ℹ️ No UI tile index is available for the image-only ${pageName} rail; using visual PPV artwork search.`,
      );
    } else if (apiMatch?.tileIndex !== undefined) {
      expectedTileIndex = apiMatch.tileIndex;
      console.log(`  ✓ Dynamic Tile Index calculated from Rails API response for ${pageName} page: ${expectedTileIndex}`);
    } else {
      const detectedUiIndex = await this.detectTileIndexFromUiDom(railHeaderRect.y, targetPpvTitle, entitlementId);
      expectedTileIndex = detectedUiIndex !== null ? detectedUiIndex : 0;
      console.log(`  ✓ Dynamic Tile Index calculated from UI DOM inspection: ${expectedTileIndex}`);
    }

    // Log explicit API Rail Title and API Tile Index right after dynamic resolution
    console.log(`API Rail Title: ${railTitle}`);
    console.log(
      usesVisualRailSearch
        ? `API Tile Index: not used for image-only ${pageName} rail${apiMatch ? ` (source index: ${apiMatch.tileIndex})` : ''}`
        : `API Tile Index: ${expectedTileIndex}`,
    );

    // 4. Calculate safe Y tile swipe & tap coordinate (strictly BELOW rail header & ABOVE bottom nav bar)
    const { width, height } = await this.driver.getWindowRect();
    const rawSwipeY = Math.round(railHeaderRect.y + railHeaderRect.height + height * 0.10);
    const minSafeY = Math.max(Math.round(railHeaderRect.y + railHeaderRect.height + 40), Math.round(height * 0.40));
    const maxSafeY = Math.round(height * 0.76); // Keep safely above bottom nav bar (y >= 0.85 height)
    const safeSwipeY = Math.max(minSafeY, Math.min(maxSafeY, rawSwipeY));

    console.log(`  Tile card swipe & tap line set to safe Y=${safeSwipeY} (Header Y=${railHeaderRect.y})`);

    let tileSurfaceValidated = false;
    const validateTileSurface = async () => {
      if (!hooks?.validateSurface || tileSurfaceValidated) return;
      tileSurfaceValidated = true;
      console.log(`🔍 [Tile Validation] Running PPV tile validations on screen...`);
      await hooks.validateSurface('PPV Tile').catch((err: any) => {
        console.warn(`⚠️ PPV Tile validation warning: ${err.message}`);
      });
    };

    // 4.5. Check if target tile text is ALREADY visible on screen under rail
    const directVisibleTap = pageName.toLowerCase() === 'home' && forcedRailTitle
      ? null
      : await this.findVisibleTileBoundsUnderRail(railHeaderRect.y, targetPpvTitle, entitlementId, width, height);
    if (directVisibleTap) {
      console.log(`🎯 Found target PPV title text under tile directly on screen at x=${directVisibleTap.x}, y=${directVisibleTap.y}`);
      await validateTileSurface();
      console.log(`Opening tile via direct UI text tap...`);
      adbTap(directVisibleTap.x, directVisibleTap.y);
      await this.driver.pause(3000);

      console.log(`Validating paywall...`);
      const isPaywallValid = skipPaywallValidation || await this.validatePaywall(targetPpvTitle, entitlementId);
      if (isPaywallValid) {
        console.log(`PPV matched.`);
        this.logVerificationSummary({
          apiRailTitle: railTitle,
          apiTileIndex: expectedTileIndex,
          swipesPerformed: 0,
          openedPpvTitle: targetPpvTitle,
          apiOrderMatchedUiOrder: true,
        });

        hooks.recordAvailability?.(true, undefined, `${pageName} Page`);
        const userStateStr = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
        const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userStateStr);
        const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
        if (!isUltimateUser || !isLoginFirst) {
          await hooks.validatePaywall?.().catch(() => { });
        }

        return {
          success: true,
          apiRailTitle: railTitle,
          apiTileIndex: expectedTileIndex,
          swipesPerformed: 0,
          openedPpvTitle: targetPpvTitle,
          apiOrderMatchedUiOrder: true,
        };
      } else {
        console.log(`Direct UI tap opened non-paywall screen. Closing and proceeding with API index swipe...`);
        await this.closePaywall();
        await this.driver.pause(2000);
      }
    }

    if (usesVisualRailSearch) {
      const visualSearch = await this.findPpvArtworkInRail(
        targetPpvTitle,
        railHeaderRect.y + railHeaderRect.height,
        Math.min(height * 0.85, railHeaderRect.y + railHeaderRect.height + height * 0.35),
        safeSwipeY,
        width,
        height,
      );
      if (visualSearch) {
        await validateTileSurface();
        console.log(`Opening visually matched PPV tile "${targetPpvTitle}"...`);
        adbTap(visualSearch.x, visualSearch.y);
        await this.driver.pause(3000);

        if (skipPaywallValidation || await this.validatePaywall(targetPpvTitle, entitlementId)) {
          console.log('PPV matched.');
          this.logVerificationSummary({
            apiRailTitle: railTitle,
            apiTileIndex: expectedTileIndex,
            swipesPerformed: visualSearch.swipesPerformed,
            openedPpvTitle: targetPpvTitle,
            apiOrderMatchedUiOrder: false,
          });
          hooks.recordAvailability?.(true, undefined, `${pageName} Page`);
          const userStateStr = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
          const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userStateStr);
          const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
          if (!isUltimateUser || !isLoginFirst) {
            await hooks.validatePaywall?.().catch(() => { });
          }
          return {
            success: true,
            apiRailTitle: railTitle,
            apiTileIndex: expectedTileIndex,
            swipesPerformed: visualSearch.swipesPerformed,
            openedPpvTitle: targetPpvTitle,
            apiOrderMatchedUiOrder: false,
          };
        }

        console.log(`The visually matched "${targetPpvTitle}" tile did not open its paywall.`);
        return {
          success: false,
          apiRailTitle: railTitle,
          apiTileIndex: expectedTileIndex,
          swipesPerformed: visualSearch.swipesPerformed,
          openedPpvTitle: '<mismatched>',
          apiOrderMatchedUiOrder: false,
          diagnosticDetails: `The visually matched "${targetPpvTitle}" tile did not open the expected paywall.`,
        };
      }

      return {
        success: false,
        apiRailTitle: railTitle,
        apiTileIndex: expectedTileIndex,
        swipesPerformed: 0,
        openedPpvTitle: '<none>',
        apiOrderMatchedUiOrder: false,
        diagnosticDetails: `PPV artwork for "${targetPpvTitle}" was not found in the ${railTitle} rail.`,
      };
    }

    // 5. Direct Swiping to Expected Tile Index & Neighbor Recovery Sequence
    const searchOrderIndices = forcedRailTitle
      ? [expectedTileIndex]
      : this.generateNeighborSearchSequence(expectedTileIndex);
    let totalSwipesPerformed = 0;
    let currentTilePositionOnScreen = 0;
    let openedPpvTitle = '<none>';
    let matchedUiOrder = false;

    for (let seqIdx = 0; seqIdx < searchOrderIndices.length; seqIdx++) {
      const candidateIndex = searchOrderIndices[seqIdx];

      if (seqIdx > 0) {
        console.log(`PPV mismatch. Trying neighbouring tile...`);
      }

      console.log(`Swiping to tile ${candidateIndex}...`);
      const deltaSwipes = candidateIndex - currentTilePositionOnScreen;
      if (deltaSwipes !== 0) {
        await this.swipeRelativeTileIndex(deltaSwipes, safeSwipeY, width);
        if (deltaSwipes > 0) {
          totalSwipesPerformed += deltaSwipes;
        }
        currentTilePositionOnScreen = candidateIndex;
      }

      if (candidateIndex === expectedTileIndex) {
        await validateTileSurface();
      }

      console.log(`Opening tile...`);
      const tapX = Math.round(width * 0.5);
      const tapY = safeSwipeY;
      adbTap(tapX, tapY);
      await this.driver.pause(3000);

      console.log(`Validating paywall...`);
      const isPaywallValid = skipPaywallValidation || await this.validatePaywall(targetPpvTitle, entitlementId);

      if (isPaywallValid) {
        console.log(`PPV matched.`);
        openedPpvTitle = targetPpvTitle;
        matchedUiOrder = candidateIndex === expectedTileIndex;

        // Log Verification Summary
        this.logVerificationSummary({
          apiRailTitle: railTitle,
          apiTileIndex: expectedTileIndex,
          swipesPerformed: totalSwipesPerformed,
          openedPpvTitle,
          apiOrderMatchedUiOrder: matchedUiOrder,
        });

        // Trigger hooks if passed
        hooks.recordAvailability?.(true, undefined, `${pageName} Page`);
        const userStateStr = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
        const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userStateStr);
        const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
        if (!isUltimateUser || !isLoginFirst) {
          await hooks.validatePaywall?.().catch(() => { });
        }

        return {
          success: true,
          apiRailTitle: railTitle,
          apiTileIndex: expectedTileIndex,
          swipesPerformed: totalSwipesPerformed,
          openedPpvTitle,
          apiOrderMatchedUiOrder: matchedUiOrder,
        };
      } else {
        console.log(`PPV mismatch.`);
        await this.closePaywall();
        await this.driver.pause(2000);
      }
    }

    // Search exhausted without paywall match
    this.logVerificationSummary({
      apiRailTitle: railTitle,
      apiTileIndex: expectedTileIndex,
      swipesPerformed: totalSwipesPerformed,
      openedPpvTitle: '<mismatched>',
      apiOrderMatchedUiOrder: false,
    });

    return {
      success: false,
      apiRailTitle: railTitle,
      apiTileIndex: expectedTileIndex,
      swipesPerformed: totalSwipesPerformed,
      openedPpvTitle: '<mismatched>',
      apiOrderMatchedUiOrder: false,
      diagnosticDetails: `Tapped tile index ${expectedTileIndex} and neighboring candidates, but paywall title did not match "${targetPpvTitle}".`,
    };
  }

  /**
   * Detect exact on-screen tap coordinates { x, y } of a tile if its PPV title or entitlement ID text is rendered under the tile in UI DOM.
   */
  private async findVisibleTileBoundsUnderRail(railTopY: number, targetTitle: string, entitlementId: string, screenWidth: number, screenHeight: number): Promise<{ x: number; y: number } | null> {
    try {
      const pageSource = await this.driver.getPageSource().catch(() => '');
      if (!pageSource) return null;

      const cleanTarget = targetTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const cleanEntitlement = entitlementId.toLowerCase().replace(/[^a-z0-9]/g, '');
      const titleParts = cleanTarget.split(/[\s:vs\-–]/).map(p => p.trim()).filter(p => p.length > 2);

      const matches = pageSource.matchAll(/<([a-zA-Z0-9.]+)\b([^>]*)bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g);

      for (const m of matches) {
        const left = parseInt(m[3], 10);
        const top = parseInt(m[4], 10);
        const right = parseInt(m[5], 10);
        const bottom = parseInt(m[6], 10);
        const attrs = m[2];
        const textMatch = attrs.match(/text="([^"]*)"/i);
        const descMatch = attrs.match(/content-desc="([^"]*)"/i);
        const text = (textMatch?.[1] || descMatch?.[1] || '').trim();

        if (top >= railTopY - 30 && bottom <= screenHeight * 0.85 && left >= 0 && right <= screenWidth && text && text.length > 2) {
          if (isAncillaryPpvContent(text)) continue;
          const txtClean = text.toLowerCase().replace(/[^a-z0-9]/g, '');
          const matchesTarget = cleanTarget && (txtClean.includes(cleanTarget) || cleanTarget.includes(txtClean));
          const matchesEntitlement = cleanEntitlement && txtClean.includes(cleanEntitlement);
          const matchesParts = titleParts.length > 0 && titleParts.some(part => txtClean.includes(part));

          if (matchesTarget || matchesEntitlement || matchesParts) {
            const tapX = Math.round((left + right) / 2);
            const tapY = Math.round((top + bottom) / 2);
            return { x: tapX, y: tapY };
          }
        }
      }
    } catch { }

    return null;
  }

  private async findPpvArtworkInRail(
    targetPpvTitle: string,
    railTop: number,
    railBottom: number,
    swipeY: number,
    screenWidth: number,
    screenHeight: number,
  ): Promise<{ x: number; y: number; swipesPerformed: number } | null> {
    let previousFingerprint = '';
    let unchangedSwipes = 0;

    for (let attempt = 0; attempt <= 40; attempt++) {
      const match = await this.findPpvArtworkInCurrentRailView(targetPpvTitle, railTop, railBottom, screenWidth, screenHeight);
      if (match) return { ...match, swipesPerformed: attempt };

      if (attempt === 40) break;
      if (match === null) {
        const screenshot = await this.driver.takeScreenshot();
        const fingerprint = createHash('sha256').update(screenshot).digest('hex');
        unchangedSwipes = fingerprint === previousFingerprint ? unchangedSwipes + 1 : 0;
        previousFingerprint = fingerprint;
        if (unchangedSwipes >= 2) {
          console.log(`"${targetPpvTitle}" was not found and the Don't Miss rail stopped moving.`);
          break;
        }
      }

      console.log(`PPV artwork is not in the current card viewport; making short horizontal swipe ${attempt + 1}/40.`);
      await this.swipeRelativeTileIndex(1, swipeY, screenWidth);
    }

    return null;
  }

  private async findPpvArtworkInCurrentRailView(
    targetPpvTitle: string,
    railTop: number,
    railBottom: number,
    screenWidth: number,
    screenHeight: number,
  ): Promise<{ x: number; y: number } | null> {
    let screenshotPath = '';
    try {
      screenshotPath = path.join(os.tmpdir(), `dazn-android-ppv-ocr-${process.pid}-${Date.now()}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(await this.driver.takeScreenshot(), 'base64'));
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
      const targetWords = normalizeAndroidTitleWords(targetPpvTitle)
        .filter(word => !['vs', 'v', 'the', 'and', 'at', 'on', 'ppv'].includes(word) && word.length > 2);
      const railObservations = observations.filter(observation => {
        const y = Math.round(screenHeight * observation.yPercent);
        return y >= railTop && y <= railBottom;
      });
      // Artwork can omit title metadata such as a promotion name or event
      // number. Require two meaningful configured terms in the same card
      // area (or the sole term for a one-word title), so OCR can still locate
      // the main event without accepting a single-fighter promo.
      const candidates = railObservations
        .map(observation => ({
          observation,
          matchedWords: targetWords.filter(word => normalizeAndroidTitle(observation.text, ' ').includes(word)).length,
        }))
        .filter(candidate => !isAncillaryPpvContent(candidate.observation.text));
      const match = candidates
        .filter(candidate => targetWords.filter(word =>
          candidates.some(other =>
            normalizeAndroidTitle(other.observation.text, ' ').includes(word) &&
            Math.abs(other.observation.yPercent - candidate.observation.yPercent) <= 0.12 &&
            Math.abs(other.observation.xPercent - candidate.observation.xPercent) <= 0.65,
          ),
        ).length >= Math.min(2, targetWords.length) && !railObservations.some(other =>
          isAncillaryPpvContent(other.text) &&
          Math.abs(other.yPercent - candidate.observation.yPercent) <= 0.12 &&
          Math.abs(other.xPercent - candidate.observation.xPercent) <= 0.30,
        ))
        .sort((left, right) => right.matchedWords - left.matchedWords)[0]?.observation;

      if (!match) return null;
      const x = Math.round(screenWidth * match.xPercent);
      const y = Math.round(screenHeight * match.yPercent);
      if (x < 0 || x > screenWidth || y < railTop || y > railBottom) return null;
      console.log(`Local OCR matched PPV artwork text: "${match.text}".`);
      return { x, y };
    } catch (error: any) {
      console.warn(`Local OCR PPV lookup failed: ${error.message}`);
      return null;
    } finally {
      if (screenshotPath && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    }
  }

  /**
   * Dynamically detect tile index by inspecting visible elements under rail in UI DOM source.
   */
  private async detectTileIndexFromUiDom(railTopY: number, targetTitle: string, entitlementId: string): Promise<number | null> {
    try {
      const pageSource = await this.driver.getPageSource().catch(() => '');
      if (!pageSource) return null;

      const cleanTarget = targetTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const cleanEntitlement = entitlementId.toLowerCase().replace(/[^a-z0-9]/g, '');
      const titleParts = cleanTarget.split('vs').map(p => p.trim()).filter(p => p.length > 2);

      const matches = pageSource.matchAll(/<([a-zA-Z0-9.]+)\b([^>]*)bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g);
      const railTexts: string[] = [];

      for (const m of matches) {
        const top = parseInt(m[4], 10);
        const attrs = m[2];
        const textMatch = attrs.match(/text="([^"]*)"/i);
        const descMatch = attrs.match(/content-desc="([^"]*)"/i);
        const text = (textMatch?.[1] || descMatch?.[1] || '').trim();

        if (top >= railTopY - 50 && text && text.length > 2) {
          if (!railTexts.includes(text)) {
            railTexts.push(text);
          }
        }
      }

      for (let idx = 0; idx < railTexts.length; idx++) {
        if (isAncillaryPpvContent(railTexts[idx])) continue;
        const txtClean = railTexts[idx].toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchesTarget = cleanTarget && txtClean.includes(cleanTarget);
        const matchesEntitlement = cleanEntitlement && txtClean.includes(cleanEntitlement);
        const matchesParts = titleParts.length > 0 && titleParts.every(part => txtClean.includes(part));

        if (matchesTarget || matchesEntitlement || matchesParts) {
          return idx;
        }
      }
    } catch { }

    return null;
  }

  /**
   * Explicitly check and wait until the first content rail is loaded and visible on screen before starting any scrolling.
   */
  async waitForFirstRailLoaded(timeoutMs = 25000): Promise<boolean> {
    console.log('⏳ Checking if the first content rail is loaded on screen before scrolling...');
    const startTime = Date.now();
    const ignoredNav = [
      'home', 'sports', 'sport', 'schedule', 'search', 'my account', 'dazn',
      'privacy', 'settings', 'account', 'help', 'betting', 'scores', 'all',
      'boxing', 'football', 'nfl', 'mma', 'darts', 'motorsport', 'golf',
      'tennis', 'snooker', 'esports', 'basketball', 'wrestling', 'featured',
      'highlights', 'shows', 'news', 'live'
    ];

    while (Date.now() - startTime < timeoutMs) {
      try {
        const textEls = await this.driver.$$('//android.widget.TextView');
        for (const el of textEls) {
          if (!(await el.isDisplayed().catch(() => false))) continue;
          const text = (await el.getText().catch(() => '')).trim();
          if (text && text.length > 2 && text.length < 60 && !ignoredNav.includes(text.toLowerCase())) {
            const loc = await el.getLocation();
            if (loc.y >= 380) {
              console.log(`✓ First content rail loaded and visible on screen: "${text}" at y=${loc.y}`);
              await this.driver.pause(2000);
              return true;
            }
          }
        }
      } catch { }
      await this.driver.pause(2000);
    }
    console.log('⚠️ Content rail load wait timeout reached. Proceeding with page search...');
    return false;
  }

  /**
   * Scroll vertically down until target rail title header or visible PPV tile text is located in viewport.
   */
  private async scrollToRail(railTitle: string, targetPpvTitle?: string, entitlementId?: string, allowDynamicFallback = true, minRailY = 380): Promise<{ x: number; y: number; width: number; height: number } | null> {
    await this.waitForFirstRailLoaded(25000);
    const cleanTitle = railTitle.replace(/['']/g, '');
    const candidateSelectors = [
      `android=new UiSelector().text("${railTitle}")`,
      `android=new UiSelector().textContains("${railTitle}")`,
      `android=new UiSelector().textContains("${cleanTitle}")`,
      `//android.widget.TextView[contains(@text, "${railTitle}")]`,
      `//android.widget.TextView[contains(@text, "${cleanTitle}")]`,
      `//android.widget.TextView[contains(translate(@text, "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "${railTitle.toUpperCase()}")]`,
    ];

    const { width, height } = await this.driver.getWindowRect();

    for (let scrollAttempt = 0; scrollAttempt < 15; scrollAttempt++) {
      for (const sel of candidateSelectors) {
        try {
          const el = await this.driver.$(sel);
          if (await el.isDisplayed().catch(() => false)) {
            const loc = await el.getLocation();
            const size = await el.getSize();

            if (loc.y >= minRailY && loc.y < height * 0.85) {
              const rect = { x: loc.x, y: loc.y, width: size.width, height: size.height };

              // Only adjust if header is sitting too low near bottom nav bar (loc.y > 0.70 height)
              if (rect.y > Math.round(height * 0.70)) {
                console.log(`  Adjusting low rail "${railTitle}" header position at y=${rect.y}...`);
                const startY = Math.round(height * 0.70);
                const endY = Math.round(height * 0.40);
                await this.driver.action('pointer')
                  .move({ x: Math.round(width / 2), y: startY })
                  .down()
                  .pause(100)
                  .move({ duration: 500, x: Math.round(width / 2), y: endY })
                  .up()
                  .perform();
                await this.driver.pause(1200);

                const freshEl = await this.driver.$(sel).catch(() => el);
                const freshLoc = await freshEl.getLocation().catch(() => loc);
                const freshSize = await freshEl.getSize().catch(() => size);
                rect.y = freshLoc.y;
                rect.height = freshSize.height;

                if (rect.y > Math.round(height * 0.70)) {
                  console.log(`  Rail "${railTitle}" header still low at y=${rect.y}; continuing vertical alignment...`);
                  continue;
                }
              }

              return rect;
            }
          }
        } catch { }
      }

      // Dynamic Fallback: Check if target PPV title or entitlement ID is visible under any rail on screen
      if (allowDynamicFallback && (targetPpvTitle || entitlementId)) {
        const detectedRect = await this.findRailHeaderAboveVisibleText(targetPpvTitle || '', entitlementId || '', height, minRailY);
        if (detectedRect) {
          console.log(`🎯 [Dynamic Rail Header] Located rail container header above visible tile text on screen at y=${detectedRect.y}`);
          return detectedRect;
        }
      }

      // Smooth scroll down
      console.log(`  Rail "${railTitle}" header not visible yet (attempt ${scrollAttempt + 1}/15). Scrolling down...`);
      const startY = Math.round(height * 0.75);
      const endY = Math.round(height * 0.35);
      await this.driver.action('pointer')
        .move({ x: Math.round(width / 2), y: startY })
        .down()
        .pause(100)
        .move({ duration: 500, x: Math.round(width / 2), y: endY })
        .up()
        .perform();
      await this.driver.pause(1200);
    }

    return null;
  }

  /**
   * Helper to detect closest valid rail header text above matched target tile text in UI DOM
   */
  private async findRailHeaderAboveVisibleText(targetTitle: string, entitlementId: string, screenHeight: number, minRailY = 380): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const pageSource = await this.driver.getPageSource().catch(() => '');
      if (!pageSource) return null;

      const cleanTarget = targetTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const cleanEntitlement = entitlementId.toLowerCase().replace(/[^a-z0-9]/g, '');

      const matches = pageSource.matchAll(/<([a-zA-Z0-9.]+)\b([^>]*)bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g);
      const elements: Array<{ left: number; top: number; right: number; bottom: number; text: string }> = [];

      for (const m of matches) {
        const left = parseInt(m[3], 10);
        const top = parseInt(m[4], 10);
        const right = parseInt(m[5], 10);
        const bottom = parseInt(m[6], 10);
        const attrs = m[2];
        const textMatch = attrs.match(/text="([^"]*)"/i);
        const descMatch = attrs.match(/content-desc="([^"]*)"/i);
        const text = (textMatch?.[1] || descMatch?.[1] || '').trim();

        if (text && top >= minRailY && bottom < screenHeight * 0.85) {
          elements.push({ left, top, right, bottom, text });
        }
      }

      const targetEl = elements.find(e => {
        const txtClean = e.text.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (cleanTarget && txtClean.includes(cleanTarget)) || (cleanEntitlement && txtClean.includes(cleanEntitlement));
      });

      if (targetEl) {
        const headersAbove = elements.filter(e => e.bottom < targetEl.top - 20 && e.text.length > 2 && e.text.length < 50);
        if (headersAbove.length > 0) {
          headersAbove.sort((a, b) => (targetEl.top - a.bottom) - (targetEl.top - b.bottom));
          const bestHeader = headersAbove[0];
          return {
            x: bestHeader.left,
            y: bestHeader.top,
            width: bestHeader.right - bestHeader.left,
            height: bestHeader.bottom - bestHeader.top,
          };
        }
      }
    } catch {}
    return null;
  }

  /**
   * Relative horizontal swipe across rail.
   */
  private async swipeRelativeTileIndex(deltaCount: number, swipeY: number, screenWidth: number): Promise<void> {
    if (deltaCount === 0) return;

    const swipes = Math.abs(deltaCount);
    const isLeft = deltaCount > 0; // Move forward (left swipe) or backward (right swipe)

    for (let s = 0; s < swipes; s++) {
      const startX = isLeft ? Math.round(screenWidth * 0.85) : Math.round(screenWidth * 0.25);
      const endX = isLeft ? Math.round(screenWidth * 0.25) : Math.round(screenWidth * 0.85);

      await this.driver.action('pointer')
        .move({ x: startX, y: swipeY })
        .down()
        .pause(100)
        .move({ duration: 500, x: endX, y: swipeY })
        .up()
        .perform();
      await this.driver.pause(1500);
    }
  }

  /**
   * Validate if currently displayed paywall belongs to expected PPV.
   */
  private async validatePaywall(expectedPpvTitle: string, entitlementId: string): Promise<boolean> {
    try {
      const rawPageSource = await this.driver.getPageSource().catch(() => '');
      const pageSource = rawPageSource.toLowerCase();
      const normPageSource = normalizeAndroidTitle(rawPageSource, ' ');
      const cleanExpected = expectedPpvTitle.toLowerCase().trim();
      const normExpected = normalizeAndroidTitle(expectedPpvTitle, ' ');
      const cleanEntitlement = entitlementId.toLowerCase().trim();

      const nameParts = cleanExpected.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 2);
      const fighterWords = normalizeAndroidTitleWords(expectedPpvTitle).filter(w => !['vs', 'v', 'the', 'and', 'at', 'on', 'ppv'].includes(w) && w.length > 2);

      const userStateStr = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
      const isUltimate = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userStateStr);
      const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
      const matchesFixtureOrWatch = pageSource.includes('watch') || pageSource.includes('play') || pageSource.includes('fixture') || pageSource.includes('related') || pageSource.includes('live') || pageSource.includes('matchroom') || (isUltimate && isLoginFirst);

      const matchesTitle = Boolean((cleanExpected && pageSource.includes(cleanExpected)) ||
        (normExpected && normPageSource.includes(normExpected)));
      const matchesEntitlement = Boolean(cleanEntitlement && pageSource.includes(cleanEntitlement));
      const matchesPart = Boolean(nameParts.some(part => pageSource.includes(part)) ||
        (fighterWords.length > 0 && fighterWords.some(w => normPageSource.includes(w))));
      const hasAncillaryExpectedTitle = Array.from(rawPageSource.matchAll(/(?:text|content-desc)="([^"]*)"/gi))
        .map(match => match[1])
        .some(text => isAncillaryPpvContent(text) && (
          (normExpected && normalizeAndroidTitle(text, ' ').includes(normExpected)) ||
          (normExpected && normExpected.includes(normalizeAndroidTitle(text, ' ')))
        ));
      const matchesPaywallCta = Boolean(
        pageSource.includes('buy') ||
        pageSource.includes('get ppv') ||
        pageSource.includes('subscribe') ||
        pageSource.includes('purchase') ||
        pageSource.includes('event pass') ||
        pageSource.includes('order') ||
        pageSource.includes('checkout') ||
        pageSource.includes('paywall') ||
        pageSource.includes('copy') ||
        pageSource.includes('paste this link') ||
        pageSource.includes('how to watch') ||
        pageSource.includes('choose the plan')
      );

      if (!hasAncillaryExpectedTitle &&
        (matchesTitle || matchesEntitlement || matchesPart) &&
        (matchesPaywallCta || matchesTitle || matchesFixtureOrWatch)) {
        return true;
      }

      // Check displayed text views on paywall screen
      const textEls = await this.driver.$$('//android.widget.TextView');
      for (const el of textEls) {
        const rawText = await el.getText().catch(() => '');
        const text = rawText.toLowerCase().trim();
        const normText = normalizeAndroidTitle(rawText, ' ');

        if (!text) continue;
        if (isAncillaryPpvContent(rawText)) continue;

        if (
          text.includes(cleanExpected) ||
          (cleanExpected && cleanExpected.includes(text)) ||
          (normExpected && (normText.includes(normExpected) || normExpected.includes(normText))) ||
          (fighterWords.length > 0 && fighterWords.some(w => normText.includes(w)))
        ) {
          return true;
        }
      }
    } catch { }

    return false;
  }

  /**
   * Close paywall using 'X' close button on top right, with fallback to ADB Back.
   */
  private async closePaywall(): Promise<void> {
    console.log('Closing paywall screen via X button / back gesture...');
    const closeSelectors = [
      '//android.widget.ImageView[contains(@content-desc, "Close") or contains(@resource-id, "close") or contains(@resource-id, "dismiss")]',
      '//android.widget.ImageButton[contains(@content-desc, "Close") or contains(@content-desc, "Navigate up")]',
      'android=new UiSelector().descriptionContains("Close")',
      'android=new UiSelector().resourceIdMatches(".*close.*")',
    ];

    for (const sel of closeSelectors) {
      try {
        const btn = await this.driver.$(sel);
        if (await btn.isDisplayed().catch(() => false)) {
          await btn.click();
          await this.driver.pause(1500);
          return;
        }
      } catch { }
    }

    // Top-right screen tap fallback for 'X' icon
    const { width } = await this.driver.getWindowRect();
    adbTap(Math.round(width * 0.92), 120);
    await this.driver.pause(1000);

    // Fallback: ADB back button
    adbBack();
    await this.driver.pause(1500);
  }

  /**
   * Generate recovery search order: Expected Index -> Index - 1 -> Index + 1 -> Index - 2 -> Index + 2
   */
  private generateNeighborSearchSequence(expectedIndex: number): number[] {
    const sequence = [expectedIndex];
    const maxOffset = 3;

    for (let offset = 1; offset <= maxOffset; offset++) {
      if (expectedIndex - offset >= 0) {
        sequence.push(expectedIndex - offset);
      }
      sequence.push(expectedIndex + offset);
    }

    return sequence;
  }

  private generateForcedRailRecoverySequence(expectedIndex: number, totalTiles?: number): number[] {
    const sequence = [expectedIndex];
    const maxIndex = Math.max(expectedIndex + 6, (totalTiles || 0) - 1);

    for (let offset = 1; offset <= maxIndex; offset++) {
      if (expectedIndex - offset >= 0) {
        sequence.push(expectedIndex - offset);
      }
      if (expectedIndex + offset <= maxIndex) {
        sequence.push(expectedIndex + offset);
      }
    }

    return sequence;
  }

  /**
   * Print structured Verification Summary log.
   */
  private logVerificationSummary(summary: {
    apiRailTitle: string;
    apiTileIndex: number;
    swipesPerformed: number;
    openedPpvTitle: string;
    apiOrderMatchedUiOrder: boolean;
  }): void {
    console.log('\n=== Verification Summary ===');
    console.log(`API Rail Title: ${summary.apiRailTitle}`);
    console.log(`API Tile Index: ${summary.apiTileIndex}`);
    console.log(`Horizontal Swipes Performed: ${summary.swipesPerformed}`);
    console.log(`Opened PPV Title: ${summary.openedPpvTitle}`);
    console.log(`API order matched UI order: ${summary.apiOrderMatchedUiOrder ? 'YES' : 'NO'}`);
    console.log('============================\n');
  }
}
