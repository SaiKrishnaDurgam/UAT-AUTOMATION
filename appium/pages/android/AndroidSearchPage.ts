import { AndroidBasePage, AndroidFlowHooks, WdBrowser, WdElement, adb, adbTap, getScreenSize } from './AndroidBasePage';
import { normalizeAndroidTitle } from '../../utils/androidTitleNormalizer';
import { resolvePpvTitleForSource } from '../../../utils/ppvTitleResolver';

export class AndroidSearchPage extends AndroidBasePage {
  async navigate(): Promise<void> {
    console.log('Navigating to Search screen...');
    await this.driver.saveScreenshot('./test-results/before_search_click.png');

    const searchSelectors = [
      'android=new UiSelector().text("Search")',
      'android=new UiSelector().description("Search")',
      'android=new UiSelector().textContains("Search")',
      'android=new UiSelector().descriptionContains("Search")',
      'android=new UiSelector().resourceIdMatches(".*search.*")',
      '//android.widget.ImageView[@content-desc="Search"]',
      '//android.widget.TextView[@content-desc="Search"]',
      '//*[@content-desc="Search"]',
      '//*[contains(@resource-id, "search")]',
    ];

    for (const selector of searchSelectors) {
      try {
        console.log(`  Trying to find Search button with selector: ${selector}`);
        const searchBtn = await this.driver.$(selector);
        if (await searchBtn.isDisplayed()) {
          console.log('  Found Search button, clicking...');
          await searchBtn.click();
          await this.driver.pause(3000);
          console.log('Search screen opened by selector');
          await this.driver.saveScreenshot('./test-results/after_search_click.png');
          return;
        }
      } catch (e: any) {
        console.log(`  Selector failed: ${e.message}`);
      }
    }

    const screenSize = getScreenSize();
    console.log(`  Screen size: ${screenSize.width}x${screenSize.height}`);

    const searchTopX = Math.round(screenSize.width * 0.90);
    const searchTopY = Math.round(screenSize.height * 0.06);
    console.log(`  Tapping top header search coordinates fallback: (${searchTopX}, ${searchTopY})`);
    adbTap(searchTopX, searchTopY);
    await this.driver.pause(3000);
    await this.driver.saveScreenshot('./test-results/after_search_top_tap.png');

    const hasInput = await this.driver.$('android=new UiSelector().className("android.widget.EditText")').isDisplayed().catch(() => false);
    if (hasInput) {
      console.log('Search screen opened via top coordinate tap');
      return;
    }

    const searchBottomX = Math.round(screenSize.width * 0.90);
    const searchBottomY = Math.round(screenSize.height * 0.92);
    console.log(`  Tapping bottom nav search coordinates fallback: (${searchBottomX}, ${searchBottomY})`);
    adbTap(searchBottomX, searchBottomY);
    await this.driver.pause(3000);
    await this.driver.saveScreenshot('./test-results/after_search_bottom_tap.png');
  }

  getPPVKeywords(searchQuery: string, ppvName = this.ppvName): string[] {
    const words = [searchQuery, ppvName];
    const candidates: string[] = [];
    for (const word of words) {
      if (!word) continue;
      // Strip diacritics so "Teófimo" and "Teofimo" both produce the same keyword
      const cleanWord = normalizeAndroidTitle(word, ' ').replace(/[:\-–\.]/g, ' ');
      if (cleanWord.includes('vs')) {
        const parts = cleanWord.split(/\bvs\b/).map(p => p.trim());
        candidates.push(...parts);
      } else {
        candidates.push(...cleanWord.split(/\s+/).map(p => p.trim()));
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
    return result.length > 0 ? result : [normalizeAndroidTitle(searchQuery, ' ') || searchQuery.toLowerCase()];
  }

  async findCorrectPPVTile(keywords: string[]): Promise<WdElement | null> {
    console.log(`🔍 Search: Looking for PPV tile. ppvName="${this.ppvName}" keywords=${JSON.stringify(keywords)}`);

    let elements: WdElement[] = [];
    try {
      elements = await this.driver.$$('android=new UiSelector().className("android.widget.TextView")');
    } catch (e: any) {
      console.log(`  Error fetching TextViews: ${e.message}`);
      return null;
    }

    const normPpv     = normalizeAndroidTitle(this.ppvName || '', ' ').trim().toLowerCase();

    // ── Tier 1: Exact title-only match (raw text equals PPV name exactly) ────
    // The actual PPV tile contains ONLY the PPV title as its text.
    // Related tiles (Press Conference, Weigh-In, Prelims, etc.) always have
    // a colon + suffix, so they will never be an exact match.
    for (const el of elements) {
      const rawText = await el.getText().catch(() => '');
      if (!rawText) continue;
      const rawNorm = normalizeAndroidTitle(rawText, ' ').trim().toLowerCase();
      if (rawNorm === normPpv || this.isPpvDiscoveryTitle(rawText, this.ppvName)) {
        console.log(`✅ Search Tier 1 (exact match): "${rawText}"`);
        return el;
      }
    }

    // ── Tier 2: Exact match after stripping punctuation differences ──────────
    // Handles minor punctuation differences like "vs." vs "vs" or extra spaces.
    const stripPunct = (s: string) => s.replace(/[.,:;!?'"""'']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const normPpvStripped = stripPunct(normPpv);
    for (const el of elements) {
      const rawText = await el.getText().catch(() => '');
      if (!rawText) continue;
      const rawStripped = stripPunct(normalizeAndroidTitle(rawText, ' '));
      if (rawStripped === normPpvStripped) {
        console.log(`✅ Search Tier 2 (punct-stripped exact match): "${rawText}"`);
        return el;
      }
    }

    // ── Tier 3: Keyword-contains + expanded ancillary blocklist (fallback) ───
    // Only reached when no exact-title tile is found (e.g. app renders the
    // PPV tile differently). Rejects tiles that contain any suffix keyword
    // that indicates it is NOT the main PPV event.
    console.log('   Search Tier 1 & 2 found no exact match. Falling back to keyword + blocklist logic.');
    const ANCILLARY_TERMS = [
      'press conference', 'press', 'weigh-in', 'weigh in', 'weigh',
      'prelims', 'preliminary', 'workout', 'replay', 'highlights',
      'preview', 'promo', 'interview', 'behind the', 'episode',
      'documentary', 'face off', 'kickboxing', 'launch',
      'undercard', 'open workout', 'media day', 'final', 'official',
    ];

    for (const el of elements) {
      const rawText = await el.getText().catch(() => '');
      if (!rawText) continue;

      const textNorm     = normalizeAndroidTitle(rawText, ' ').toLowerCase();
      const matchesQuery = keywords.every(kw => textNorm.includes(kw));
      const isAncillary  = ANCILLARY_TERMS.some(term => textNorm.includes(term));

      if (matchesQuery && !isAncillary) {
        console.log(`✅ Search Tier 3 (keyword+blocklist): "${rawText}"`);
        return el;
      }
    }

    console.log('❌ Search: No matching PPV tile found in any tier.');
    return null;
  }

  async typeSearchQuery(searchQuery: string): Promise<void> {
    const screenSize = getScreenSize();
    let searchInput = null;
    const inputSelectors = [
      'android=new UiSelector().className("android.widget.EditText")',
      'android=new UiSelector().resourceIdMatches(".*search_src_text.*")',
      'android=new UiSelector().resourceIdMatches(".*search.*")',
      '//android.widget.EditText',
      '//*[contains(@resource-id, "search")]',
    ];

    for (const selector of inputSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed()) {
          searchInput = el;
          break;
        }
      } catch {}
    }

    let searchInputSuccess = false;
    if (searchInput) {
      try {
        await searchInput.click();
        await this.driver.pause(1000);
        await searchInput.clearValue();
        await searchInput.setValue(searchQuery);
        await this.driver.pause(1500);
        searchInputSuccess = true;
      } catch (e: any) {
        console.log(`Search input interaction failed: ${e.message}. Falling back to coordinates...`);
      }
    }

    if (!searchInputSuccess) {
      console.log('Search input not found or failed, using coordinate tap fallback and ADB text typing...');
      const inputX = Math.round(screenSize.width / 2);
      const inputY = Math.round(screenSize.height * 0.06);
      adbTap(inputX, inputY);
      await this.driver.pause(1000);
      const adbText = searchQuery.replace(/\s+/g, '%s');
      adb(`shell input text "${adbText}"`);
      await this.driver.pause(1500);
    }

    console.log('Pressing Search/Enter on keyboard...');
    adb('shell input keyevent 66');
  }

  async openSearchResultPaywall(searchQuery: string, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    await this.navigate();
    await this.typeSearchQuery(searchQuery);
    await this.driver.pause(4000);
    await this.driver.saveScreenshot('./test-results/android_search_results.png');

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
      const retryQuery = `${searchQuery} upcoming`;
      console.log(`PPV tile not found for "${searchQuery}". Retrying search with "${retryQuery}"...`);
      await this.navigate();
      await this.typeSearchQuery(retryQuery);
      await this.driver.pause(4000);
      await this.driver.saveScreenshot('./test-results/android_search_retry_results.png');

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
        ? await hooks.saveScreenshot('./test-results/android_search_ppv_not_found.png')
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
    await this.driver.saveScreenshot('./test-results/android_search_after_tile_click.png');

    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Search tile clicked. Checking for PIN Protection screen...');
      await this.handlePinProtectionIfPresent();
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Navigated to fixture page. Ending search flow (no paywall expected).');
      return true;
    }

    console.log('  On paywall screen - will capture URL via Copy button');
    return true;
  }
}

export async function navigateToSearch(driver: WdBrowser): Promise<void> {
  return new AndroidSearchPage(driver).navigate();
}

export async function typeSearchQuery(driver: WdBrowser, searchQuery: string): Promise<void> {
  return new AndroidSearchPage(driver).typeSearchQuery(searchQuery);
}

export function getPPVKeywords(searchQuery: string, ppvName: string): string[] {
  return new AndroidSearchPage(null, ppvName).getPPVKeywords(searchQuery, ppvName);
}

export async function findCorrectPPVTile(driver: WdBrowser, keywords: string[]): Promise<WdElement | null> {
  return new AndroidSearchPage(driver).findCorrectPPVTile(keywords);
}

export async function openSearchResultPaywall(
  driver: WdBrowser,
  ppvName: string,
  searchQuery: string,
  hooks: AndroidFlowHooks = {},
  eventConfig?: any,
): Promise<boolean> {
  return new AndroidSearchPage(driver, resolvePpvTitleForSource(eventConfig || { PPV_NAME: ppvName }, 'search')).openSearchResultPaywall(searchQuery, hooks);
}
