import { IOSBasePage, IOSFlowHooks, WdBrowser, WdElement } from './IOSBasePage';
import { resolvePpvTitleForSource } from '../../../utils/ppvTitleResolver';
import { IOSSafariCheckoutOptions, IOSSafariCheckoutPage } from './IOSSafariCheckoutPage';

export interface IOSSafariSearchOptions extends IOSSafariCheckoutOptions { }

export class IOSSearchPage extends IOSBasePage {
  async continueSafariCheckout(options: IOSSafariSearchOptions): Promise<void> {
    await new IOSSafariCheckoutPage(this.driver, this.ppvName).continueSafariCheckout(options);
  }

  async navigate(): Promise<void> {
    console.log('Navigating to Search screen...');
    await this.driver.saveScreenshot('./test-results/before_ios_search_click.png');

    const searchSelectors = [
      // iOS DAZN real-device home uses a magnifying glass in the top header,
      // not a bottom-navigation Search tab.
      '-ios class chain:**/XCUIElementTypeButton[`name CONTAINS[c] "Search" OR label CONTAINS[c] "Search"`]',
      '-ios predicate string:name CONTAINS[c] "Search" OR label CONTAINS[c] "Search"',
      '//XCUIElementTypeButton[contains(@name, "Search") or contains(@label, "Search")]',
      '~Search',
    ];

    let searchBtn: WdElement | null = null;
    for (const selector of searchSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          searchBtn = el;
          break;
        }
      } catch { }
    }

    if (searchBtn) {
      console.log('  Found header Search icon, clicking...');
      await searchBtn.click();
      await this.driver.pause(3000);
      await this.driver.saveScreenshot('./test-results/after_ios_search_click.png');
    } else {
      // The production iOS app sometimes does not expose an accessibility
      // label for this icon. Its position is stable in the header, between
      // the DAZN logo and Sign up button (as shown on the target device).
      const { width, height } = await this.driver.getWindowSize();
      const x = Math.round(width * 0.37);
      const y = Math.round(height * 0.09);
      console.warn(`  Header Search icon has no accessible label; tapping fallback coordinates (${x}, ${y}).`);
      await this.driver.action('pointer')
        .move({ x, y })
        .down()
        .pause(100)
        .up()
        .perform();
      await this.driver.pause(2000);
      await this.driver.saveScreenshot('./test-results/after_ios_search_header_fallback.png');

      // Retain the native tree for selector refinement when the app layout
      // changes; this is more useful than reporting a misleading bottom-nav
      // failure.
      const source = await this.driver.getPageSource().catch(() => '');
      require('fs').writeFileSync('./test-results/ios_search_header_source.xml', source);
    }
  }

  getPPVKeywords(searchQuery: string, ppvName = this.ppvName): string[] {
    const words = [searchQuery, ppvName];
    const candidates: string[] = [];
    for (const word of words) {
      if (!word) continue;
      const cleanWord = word.toLowerCase().replace(/[:\-–\.]/g, ' ');
      const normalisedCleanWord = cleanWord.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (normalisedCleanWord.includes('vs')) {
        const parts = normalisedCleanWord.split(/\bvs\b/).map(p => p.trim());
        candidates.push(...parts);
      } else {
        candidates.push(...normalisedCleanWord.split(/\s+/).map(p => p.trim()));
      }
    }

    const keywordsSet = new Set<string>();
    for (const candidate of candidates) {
      const subWords = candidate.split(/\s+/);
      for (const subWord of subWords) {
        if (subWord.length > 2 && subWord !== 'the' && subWord !== 'vs' && subWord !== 'and') {
          keywordsSet.add(subWord);
        }
      }
    }

    const result = Array.from(keywordsSet);
    return result.length > 0 ? result : [searchQuery.toLowerCase()];
  }

  async findCorrectPPVTile(keywords: string[]): Promise<WdElement | null> {
    console.log(`Scanning XCUIElementTypeStaticText elements for keywords: ${JSON.stringify(keywords)}`);
    try {
      const elements = await this.driver.$$('//XCUIElementTypeStaticText');
      for (const el of elements) {
        const text = await el.getAttribute('label').catch(() => '');
        if (!text) continue;

        const textLower = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const titleText = text
          .replace(/\b(?:article|epg|list)\b.*$/i, '')
          .trim();
        const matchesQuery = this.ppvName
          ? this.isPpvDiscoveryTitle(titleText, this.ppvName)
          : keywords.every(kw => textLower.includes(kw));
        const isAncillary = [
          'press', 'weigh', 'workout', 'replay', 'highlights',
          'preview', 'promo', 'interview', 'behind the', 'episode',
          'documentary', 'face off', 'kickboxing',
        ].some(term => textLower.includes(term));

        if (matchesQuery && !isAncillary) {
          console.log(`  Found matching main event tile: "${text}"`);
          return el;
        }
      }
    } catch (e: any) {
      console.log(`  Error finding tile: ${e.message}`);
    }

    return null;
  }

  async typeSearchQuery(searchQuery: string): Promise<void> {
    let searchInput: WdElement | null = null;
    const inputSelectors = [
      '//XCUIElementTypeSearchField',
      // The production iOS field is exposed as a text field with the
      // placeholder "Search sports, teams, events".  Restrict every locator
      // to an editable field; a broad "label contains Search" selector can
      // otherwise select the header magnifying-glass button.
      '-ios predicate string:type == "XCUIElementTypeTextField" AND (name CONTAINS[c] "Search" OR label CONTAINS[c] "Search" OR value CONTAINS[c] "Search")',
      '//XCUIElementTypeTextField[contains(@name, "Search") or contains(@label, "Search") or contains(@value, "Search")]',
      '//XCUIElementTypeTextField',
    ];

    for (const selector of inputSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          searchInput = el;
          break;
        }
      } catch { }
    }

    if (!searchInput) {
      await this.driver.saveScreenshot('./test-results/ios_search_input_not_found.png');
      throw new Error('Search input not found on the iOS Search screen; cannot continue with SOURCE=search.');
    }

    try {
      await searchInput.click();
      await this.driver.pause(500);
      await searchInput.clearValue().catch(() => { });
      await searchInput.setValue(searchQuery);
      await this.driver.pause(500);

      // Do not inspect results until the exact configured event is visibly
      // present in the input.  This prevents stale recent-search content from
      // being treated as a real SOURCE=search result.
      let entered = String(await searchInput.getValue().catch(() => ''));
      if (!entered) entered = String(await searchInput.getAttribute('value').catch(() => ''));
      const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalise(entered).includes(normalise(searchQuery))) {
        throw new Error(`Search query was not entered. Expected="${searchQuery}" actual="${entered || 'empty'}"`);
      }
      console.log(`  ✓ Entered and verified Search query: "${entered}"`);

      // On the real iPhone keyboard the action is labelled Done.  Prefer it,
      // then fall back to Search / Enter for other iOS versions.
      const keyboardActions = ['~Done', '~done', '~Search', '~search'];
      let submitted = false;
      for (const selector of keyboardActions) {
        const key = await this.driver.$(selector);
        if (await key.isDisplayed().catch(() => false)) {
          await key.click();
          submitted = true;
          break;
        }
      }
      if (!submitted) await this.driver.keys(['\n']);
      await this.driver.pause(1500);
    } catch (e: any) {
      await this.driver.saveScreenshot('./test-results/ios_search_query_entry_failed.png').catch(() => { });
      throw new Error(`Unable to enter and submit iOS Search query "${searchQuery}": ${e.message}`);
    }
  }

  async openSearchResultPaywall(searchQuery: string, hooks: IOSFlowHooks = {}): Promise<boolean> {
    await this.navigate();
    await this.typeSearchQuery(searchQuery);
    await this.driver.pause(4000);
    await this.driver.saveScreenshot('./test-results/ios_search_results.png');

    const keywords = this.getPPVKeywords(searchQuery, this.ppvName);
    console.log(`Looking for PPV tile: "${this.ppvName}"...`);
    let ppvTile = await this.findCorrectPPVTile(keywords);

    if (!ppvTile) {
      console.log('  PPV tile not immediately visible. Swiping down search results...');
      await this.scrollDown();
      await this.driver.pause(2000);
      ppvTile = await this.findCorrectPPVTile(keywords);
    }

    if (!ppvTile) {
      const retryQuery = `${this.ppvName || searchQuery} upcoming`;
      console.log(`PPV tile not found for "${searchQuery}". Retrying search with "${retryQuery}"...`);
      // Stay on the current Search screen. Re-running navigate() can hit the
      // header/back control and leave Search, which violates SOURCE=search.
      await this.typeSearchQuery(retryQuery);
      await this.driver.pause(4000);
      await this.driver.saveScreenshot('./test-results/ios_search_retry_results.png');

      ppvTile = await this.findCorrectPPVTile(keywords);
      if (!ppvTile) {
        console.log('  PPV tile not immediately visible in retry search. Swiping down results...');
        await this.scrollDown();
        await this.driver.pause(2000);
        ppvTile = await this.findCorrectPPVTile(keywords);
      }
    }

    if (!ppvTile) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_search_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Search');
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found in Search`);
      throw new Error(`PPV event "${this.ppvName}" not found in search results (after primary & retry search).`);
    }

    hooks.recordAvailability?.(true, undefined, 'Search');
    console.log('Found PPV tile - tapping it...');
    await this.runSurfaceValidation(hooks, 'PPV Tile');
    await ppvTile.click();
    await this.driver.pause(4000);
    await this.driver.saveScreenshot('./test-results/ios_search_after_tile_click.png');

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      await this.validateUltimateFixtureOrPreviewPage(hooks);
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Search tile clicked, navigated to fixture page. Ending flow.');
      return true;
    }

    // The bottom sheet is the native iOS paywall. Validate it while it is
    // still on screen, before tapping the external-site CTA. That CTA opens
    // Apple's confirmation sheet and makes native paywall selectors stale.
    console.log('Validating native Search paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_search_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    // Only after native validation is complete may we leave DAZN for Safari.
    console.log('Tapping Buy/Go-to CTA on event page...');
    const buyTapped = await this.tapBuyCtaWithFallback([
      'Go to dazn.com/start',
      'Go to DAZN.com/start',
      'Buy now',
      'Buy Now',
      'Buy',
      'Get PPV',
      'Purchase',
      'Continue',
    ], { scrollBeforeFallback: true });

    if (!buyTapped) {
      await this.driver.saveScreenshot('./test-results/ios_search_buy_not_found.png');
      throw new Error(`❌ Could not click Buy CTA on event page`);
    }

    return true;
  }
}

export async function navigateToSearch(driver: WdBrowser): Promise<void> {
  return new IOSSearchPage(driver).navigate();
}

export async function typeSearchQuery(driver: WdBrowser, searchQuery: string): Promise<void> {
  return new IOSSearchPage(driver).typeSearchQuery(searchQuery);
}

export function getPPVKeywords(searchQuery: string, ppvName: string): string[] {
  return new IOSSearchPage(null, ppvName).getPPVKeywords(searchQuery, ppvName);
}

export async function findCorrectPPVTile(driver: WdBrowser, keywords: string[]): Promise<WdElement | null> {
  return new IOSSearchPage(driver).findCorrectPPVTile(keywords);
}

export async function openSearchResultPaywall(
  driver: WdBrowser,
  ppvName: string,
  searchQuery: string,
  hooks: IOSFlowHooks = {},
  eventConfig?: any,
): Promise<boolean> {
  return new IOSSearchPage(driver, resolvePpvTitleForSource(eventConfig || { PPV_NAME: ppvName }, 'search')).openSearchResultPaywall(searchQuery, hooks);
}
