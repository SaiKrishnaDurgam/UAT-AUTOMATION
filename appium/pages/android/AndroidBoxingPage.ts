import { AndroidBasePage, AndroidFlowHooks, WdBrowser, WdElement, adbSwipe, adbTap, getScreenSize } from './AndroidBasePage';
import { normalizeAndroidTitle } from '../../utils/androidTitleNormalizer';
import { AndroidRailsFetcher } from '../../utils/androidRailsFetcher';
import { DynamicPpvTileLocator } from '../../utils/dynamicPpvTileLocator';
import { resolvePpvTitleForSource } from '../../../utils/ppvTitleResolver';
import https from 'https';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface AndroidPPVDateParts {
  month: string;
  monthShort: string;
  day: string;
}

export function getPPVDateParts(eventConfig?: any): AndroidPPVDateParts {
  try {
    // 1. Check regional date fields first (e.g. US: Sat 22nd August)
    const regionalDateStr =
      eventConfig?.HOME_BOXING_UPCOMING_DATE ||
      eventConfig?.MOBILE_SCHEDULE_DAY_DATE ||
      eventConfig?.MOBILE_BANNER_DATE_TIME ||
      eventConfig?.LANDING_PAGE_PPV_DATE ||
      eventConfig?.PPV_DATE ||
      eventConfig?.MOBILE_PPV_DATE ||
      '';

    if (regionalDateStr) {
      const monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const monthsShort = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

      const monthMatch = regionalDateStr.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i);
      const dayMatch = regionalDateStr.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);

      if (monthMatch && dayMatch) {
        const mStr = monthMatch[1].toLowerCase();
        const mIdx = monthsShort.findIndex(s => s.toLowerCase() === mStr.substring(0, 3));
        if (mIdx !== -1) {
          return {
            month: monthsFull[mIdx],
            monthShort: monthsShort[mIdx],
            day: dayMatch[1].replace(/\D/g, ''),
          };
        }
      }
    }

    // Direct day / month overrides from event JSON
    if (eventConfig?.MOBILE_SCHEDULE_DATE || eventConfig?.MOBILE_BANNER_DATE) {
      const rawDay = String(eventConfig.MOBILE_SCHEDULE_DATE || eventConfig.MOBILE_BANNER_DATE || '').replace(/\D/g, '');
      const rawMonthShort = String(eventConfig.MOBILE_SCHEDULE_MONTH || '').toUpperCase().substring(0, 3);
      if (rawDay && rawMonthShort) {
        const monthsFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const monthsShort = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const mIdx = monthsShort.indexOf(rawMonthShort);
        return {
          month: mIdx !== -1 ? monthsFull[mIdx] : rawMonthShort,
          monthShort: rawMonthShort,
          day: rawDay,
        };
      }
    }

    // 2. Fallback to UTC date if no regional date is specified
    const utcDate = eventConfig?.global?.PPV_UTC_DATE || eventConfig?.PPV_UTC_DATE || '';
    if (utcDate) {
      const d = new Date(utcDate);
      return {
        month: d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
        monthShort: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase(),
        day: String(d.getUTCDate()),
      };
    }
  } catch (e: any) {
    console.log(`  Could not read PPV date from config: ${e.message}`);
  }

  return { month: 'July', monthShort: 'JUL', day: '' };
}

export class AndroidBoxingPage extends AndroidBasePage {

  /**
   * Returns all visible elements whose text matches ppvName, tolerating diacritics.
   * e.g. "Rolly vs. Teófimo" matches "Rolly vs. Teofimo" on-screen and vice-versa.
   */
  private async findVisiblePpvTitleElements(ppvName = this.ppvName): Promise<WdElement[]> {
    // 1. Try exact XPath first (fast path — works when accents match)
    const discoveryTitle = this.ppvDiscoveryTitleQuery(ppvName);
    const exactMatches = await this.driver.$$(`//*[contains(@text, "${discoveryTitle}")]`).catch(() => []);
    const visibleExact: WdElement[] = [];
    for (const el of exactMatches) {
      if (!(await el.isDisplayed().catch(() => false))) continue;
      const text = String(
        await el.getText().catch(() => '') ||
        await el.getAttribute('contentDescription').catch(() => '') || '',
      );
      if (this.isPpvDiscoveryTitle(text, ppvName)) visibleExact.push(el);
    }
    if (visibleExact.length > 0) return visibleExact;

    // 2. Diacritic-stripped fallback scan (covers "Teofimo" ↔ "Teófimo")
    const target = normalizeAndroidTitle(ppvName);
    if (!target) return [];
    const allEls = await this.driver.$$('//*[@text or @content-desc]').catch(() => []);
    const normalized: WdElement[] = [];
    for (const el of allEls) {
      if (!await el.isDisplayed().catch(() => false)) continue;
      const text = String(
        await el.getText().catch(() => '') ||
        await el.getAttribute('contentDescription').catch(() => '') || ''
      );
      const cleanText = normalizeAndroidTitle(text);
      if (cleanText && (this.isPpvDiscoveryTitle(text, ppvName) ||
        (discoveryTitle === ppvName && (cleanText.includes(target) || target.includes(cleanText))))) {
        normalized.push(el);
      }
    }
    return normalized;
  }

  /** Boolean wrapper around findVisiblePpvTitleElements — respects timeoutMs. */
  private async isPpvTitleVisible(ppvName = this.ppvName, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const els = await this.findVisiblePpvTitleElements(ppvName);
      if (els.length > 0) return true;
      if (Date.now() < deadline) await this.driver.pause(300);
    } while (Date.now() < deadline);
    return false;
  }

  private async keepPpvTitleInValidationView(): Promise<boolean> {
    const screen = getScreenSize();
    const cx = Math.round(screen.width / 2);
    const minY = Math.round(screen.height * 0.25);
    const maxY = Math.round(screen.height * 0.68);

    for (let attempt = 0; attempt < 4; attempt++) {
      const ppvEls = await this.findVisiblePpvTitleElements();
      for (const el of ppvEls) {
        if (!await el.isDisplayed().catch(() => false)) continue;
        const loc = await el.getLocation().catch(() => null);
        if (!loc) continue;
        if (loc.y >= minY && loc.y <= maxY) {
          console.log(`  PPV tile is ready for validation at y=${loc.y}.`);
          return true;
        }
        if (loc.y < minY) {
          console.log(`  PPV tile is high on screen (y=${loc.y}). Pulling it into validation view...`);
          adbSwipe(cx, Math.round(screen.height * 0.45), cx, Math.round(screen.height * 0.52));
        } else {
          console.log(`  PPV tile is low on screen (y=${loc.y}). Bringing it into validation view...`);
          adbSwipe(cx, Math.round(screen.height * 0.58), cx, Math.round(screen.height * 0.50));
        }
        await this.driver.pause(700);
        break;
      }
    }

    return this.isPpvTitleVisible(this.ppvName, 1000);
  }

  async navigateViaSports(): Promise<void> {
    console.log('Navigating to Boxing page via Sports tab...');
    const sportsTapped = await this.tapByText('Sports', 5000) || await this.tapByText('Sport', 4000);
    if (sportsTapped) {
      await this.driver.pause(1500);
      if (await this.scrollToText('Boxing') || await this.tapByText('Boxing', 6000)) {
        await this.driver.pause(2000);
        console.log('On Boxing page');
        return;
      }
    }
    if (await this.tapByText('Boxing', 5000)) {
      await this.driver.pause(2000);
      return;
    }
    console.log('Could not confirm Boxing page - continuing from current screen');
  }

  async clickHomeSportFilter(sportName: string = 'Boxing'): Promise<void> {
    const targetSport = sportName.trim() || 'Boxing';
    console.log(`  Selecting "${targetSport}" from Sports / All Sports on home page...`);
    await this.dismissPromoPopup();

    const sportSelectors = [
      `android=new UiSelector().text("${targetSport}")`,
      `android=new UiSelector().textContains("${targetSport}")`,
      `//android.widget.TextView[@text="${targetSport}"]`,
      `//*[contains(@text, "${targetSport}") or contains(@content-desc, "${targetSport}")]`,
    ];

    const allSportsSelectors = [
      'android=new UiSelector().text("All Sports")',
      'android=new UiSelector().textContains("All Sports")',
      'android=new UiSelector().text("Sports")',
      'android=new UiSelector().textContains("Sports")',
      '//*[contains(@text, "All Sports") or contains(@content-desc, "All Sports")]',
      '//*[contains(@text, "Sports") or contains(@content-desc, "Sports")]',
    ];

    const tryClickFromSelectors = async (selectors: string[], label: string): Promise<boolean> => {
      for (const selector of selectors) {
        try {
          const el = await this.driver.$(selector);
          if (await el.isDisplayed().catch(() => false)) {
            await el.click();
            console.log(`  ${label} clicked`);
            return true;
          }
        } catch {}
      }
      return false;
    };

    // Always enter through All Sports. A sport-name text match on Home can
    // belong to content rather than the sport selector and leave us on Home.
    let sportsOpened = await tryClickFromSelectors(allSportsSelectors, 'All Sports filter');
    if (!sportsOpened) {
      console.log('  All Sports filter not immediately visible - swiping top filter rail...');
      const screen = getScreenSize();
      for (let i = 0; i < 5; i++) {
        adbSwipe(
          Math.round(screen.width * 0.75),
          Math.round(screen.height * 0.22),
          Math.round(screen.width * 0.25),
          Math.round(screen.height * 0.22),
        );
        await this.driver.pause(700);
        if (await tryClickFromSelectors(allSportsSelectors, 'All Sports filter')) {
          sportsOpened = true;
          console.log(`  All Sports filter clicked after ${i + 1} horizontal swipe(s)`);
          break;
        }
      }
    }

    if (sportsOpened) {
      console.log(`  ✓ Sports page / menu opened. Searching for "${targetSport}"...`);
      await this.driver.pause(2000);

      // Scroll down step-by-step on the Sports page to find targetSport
      for (let scrollAttempt = 0; scrollAttempt < 10; scrollAttempt++) {
        for (const selector of sportSelectors) {
          try {
            const el = await this.driver.$(selector);
            if (await el.isDisplayed().catch(() => false)) {
              console.log(`🎯 Found "${targetSport}" on Sports page on scroll attempt ${scrollAttempt + 1}`);
              await el.click();
              console.log(`  ✓ Clicked "${targetSport}" on Sports page`);
              await this.driver.pause(2500);
              return;
            }
          } catch {}
        }

        console.log(`  "${targetSport}" not visible yet on Sports page (attempt ${scrollAttempt + 1}/10). Scrolling down...`);
        await this.scrollDownSmooth();
      }
    }

    await this.driver.saveScreenshot('./test-results/android_sport_filter_not_found.png');
    throw new Error(`${targetSport} could not be found or selected from Sports page.`);
  }

  async clickHomeBoxingFilter(): Promise<void> {
    return this.clickHomeSportFilter('Boxing');
  }

  async clickUpcomingFightsFilter(): Promise<boolean> {
    console.log('  Clicking "Upcoming Fights" filter on boxing page...');
    let clicked = false;
    const selectors = [
      'android=new UiSelector().text("Upcoming Fights")',
      'android=new UiSelector().textContains("Upcoming Fights")',
      'android=new UiSelector().textContains("Upcoming")',
      '//android.widget.TextView[contains(@text,"Upcoming")]',
    ];

    const tryClick = async (): Promise<boolean> => {
      for (const selector of selectors) {
        try {
          const el = await this.driver.$(selector);
          if (await el.isDisplayed()) {
            await el.click();
            console.log('  "Upcoming Fights" filter clicked');
            return true;
          }
        } catch {}
      }
      return false;
    };

    clicked = await tryClick();
    if (!clicked) {
      const screen = getScreenSize();
      for (let i = 0; i < 4; i++) {
        adbSwipe(
          Math.round(screen.width * 0.75),
          Math.round(screen.height * 0.22),
          Math.round(screen.width * 0.25),
          Math.round(screen.height * 0.22),
        );
        await this.driver.pause(700);
        clicked = await tryClick();
        if (clicked) break;
      }
    }

    if (!clicked) {
      console.log('  "Upcoming Fights" filter not found.');
      await this.driver.saveScreenshot('./test-results/android_upcoming_filter_not_found.png');
    }
    return clicked;
  }

  private async waitForUpcomingFightsContent(dateParts: AndroidPPVDateParts, previousSource = ''): Promise<boolean> {
    const targetLabels = [
      this.ppvName,
      dateParts.month,
      dateParts.monthShort,
      dateParts.day,
    ].filter(Boolean);
    let changed = !previousSource;
    let lastSource = '';
    let stableCount = 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      const source = await this.driver.getPageSource().catch(() => '');
      if (previousSource && source && source !== previousSource) changed = true;
      stableCount = changed && source && source === lastSource ? stableCount + 1 : 0;

      for (const label of targetLabels) {
        if (changed && await this.isVisible(label, 300)) {
          console.log(`  Upcoming Fights content is visible (${label}).`);
          return true;
        }
      }
      if (stableCount >= 1) {
        console.log('  Upcoming Fights content changed and is stable.');
        return true;
      }
      lastSource = source;
      await this.driver.pause(700);
    }

    await this.driver.saveScreenshot('./test-results/android_upcoming_fights_not_loaded.png');
    console.log('  Upcoming Fights content did not become visible before scrolling.');
    return false;
  }

  async scrollToUpcomingPPV(dateParts: AndroidPPVDateParts): Promise<boolean> {
    console.log(`  Scrolling to PPV - fast to "${dateParts.month}", slow to day "${dateParts.day}"...`);
    const screen = getScreenSize();
    const cx = Math.round(screen.width / 2);

    const monthOnScreen = async (): Promise<boolean> => {
      for (const label of [dateParts.month, dateParts.monthShort]) {
        if (label && await this.isVisible(label, 300)) return true;
      }
      return false;
    };

    const dateOnScreen = async (): Promise<boolean> => {
      if (!dateParts.day) return false;
      for (const label of [dateParts.day, `${dateParts.monthShort} ${dateParts.day}`, `${dateParts.month} ${dateParts.day}`]) {
        if (await this.isVisible(label, 300)) return true;
      }
      return this.isVisible(this.ppvName, 300);
    };

    let monthFound = await monthOnScreen();
    for (let i = 0; i < 25 && !monthFound; i++) {
      adbSwipe(cx, Math.round(screen.height * 0.78), cx, Math.round(screen.height * 0.18));
      await this.driver.pause(400);
      monthFound = await monthOnScreen();
    }

    if (!monthFound) {
      await this.driver.saveScreenshot('./test-results/android_month_not_found.png');
      console.log(`  Could not find "${dateParts.month}" - proceeding with slow scroll`);
    }

    let ppvDateFound = await dateOnScreen();
    for (let i = 0; i < 20 && !ppvDateFound; i++) {
      adbSwipe(cx, Math.round(screen.height * 0.60), cx, Math.round(screen.height * 0.40));
      await this.driver.pause(700);
      ppvDateFound = await dateOnScreen();
    }

    if (!ppvDateFound) {
      await this.driver.saveScreenshot('./test-results/android_ppv_date_not_found.png');
      console.log(`  PPV date "${dateParts.day}" not found - trying Buy now from current position`);
    }

    let ppvFound = await this.isPpvTitleVisible(this.ppvName, 3000);
    for (let i = 0; i < 5 && !ppvFound; i++) {
      adbSwipe(cx, Math.round(screen.height * 0.60), cx, Math.round(screen.height * 0.40));
      await this.driver.pause(600);
      ppvFound = await this.isPpvTitleVisible(this.ppvName, 1000);
    }

    if (ppvFound) {
      // If PPV is low on screen, use small nudges and re-find the element after each swipe.
      const targetY = Math.round(screen.height * 0.68);
      for (let s = 0; s < 3; s++) {
        const ppvEls = await this.findVisiblePpvTitleElements();
        const el = ppvEls.find(asyncEl => asyncEl);
        if (!el || !await el.isDisplayed().catch(() => false)) break;
        const loc = await el.getLocation().catch(() => null);
        if (!loc) break;
        if (loc.y <= targetY) {
          console.log(`  PPV tile is ready at y=${loc.y}.`);
          break;
        }
        console.log(`  PPV tile is low on screen (y=${loc.y} > ${targetY}). Nudging upward...`);
        adbSwipe(cx, Math.round(screen.height * 0.58), cx, Math.round(screen.height * 0.50));
        await this.driver.pause(800);
      }
      await this.driver.saveScreenshot('./test-results/android_ppv_tile_area.png');
    } else {
      await this.driver.saveScreenshot('./test-results/android_ppv_not_found.png');
      console.log(`  "${this.ppvName}" not found - trying Buy now from current position`);
    }

    return ppvFound;
  }

  async tapBuyNowNearPPV(): Promise<boolean> {
    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    const screen = getScreenSize();
    const cx = Math.round(screen.width / 2);

    if (isUltimateUser && isLoginFirst) {
      console.log(`✨ [Ultimate Active User with LOGIN_FIRST=true] Clicking the PPV tile itself for "${this.ppvName}"...`);
      const ppvEls = await this.findVisiblePpvTitleElements();
      for (const el of ppvEls) {
        if (await el.isDisplayed().catch(() => false)) {
          const loc = await el.getLocation().catch(() => null);
          if (loc && loc.y > Math.round(screen.height * 0.72)) {
            console.warn(`  PPV tile text is near bottom nav area (y=${loc.y} > ${Math.round(screen.height * 0.72)}). Scrolling up first...`);
            adbSwipe(cx, Math.round(screen.height * 0.65), cx, Math.round(screen.height * 0.40));
            await this.driver.pause(800);
          }
          await el.click();
          console.log(`  Tapped PPV tile text: "${this.ppvName}"`);
          await this.handlePinProtectionIfPresent();
          console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Navigated to fixture page. Ending flow (no paywall expected).');
          return true;
        }
      }
      return false;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`  Looking for Buy Now button belonging to "${this.ppvName}" (attempt ${attempt + 1})...`);
        const ppvEls = await this.findVisiblePpvTitleElements();
        let ppvLoc = null;
        for (const el of ppvEls) {
          if (await el.isDisplayed().catch(() => false)) {
            ppvLoc = await el.getLocation();
            break;
          }
        }

        if (ppvLoc) {
          const buyBtns = await this.driver.$$('//android.widget.TextView[@text="Buy now" or @text="Buy Now" or @text="Buy" or @text="Get PPV"]');
          let targetBtn = null;
          let minDiff = Infinity;

          for (const btn of buyBtns) {
            if (await btn.isDisplayed().catch(() => false)) {
              const btnLoc = await btn.getLocation();
              const diffY = btnLoc.y - ppvLoc.y;
              if (diffY >= -150 && diffY < minDiff && diffY < 1200) {
                minDiff = diffY;
                targetBtn = btn;
              }
            }
          }

          if (targetBtn) {
            await targetBtn.click();
            console.log('  Tapped "Buy now" specific to the PPV card');
            return true;
          }
        }
      } catch (e: any) {
        console.log(`  PPV-specific Buy now check error: ${e.message}`);
      }

      await this.driver.pause(500);
    }

    console.log(`  Buy CTA belonging to "${this.ppvName}" was not found. Not using generic fallback for Upcoming Fights.`);
    return false;
  }

  async openBoxingUpcomingFightsPaywall(hooks: AndroidFlowHooks = {}): Promise<boolean> {
    // Ensure we're on Home page before navigating to Sports (post-login behavior)
    const homeTab = await this.driver.$('android=new UiSelector().text("Home")');
    if (!(await homeTab.isDisplayed().catch(() => false))) {
      const homeClicked = await this.tapByText('Home', 3000);
      if (!homeClicked) {
        const screen = getScreenSize();
        adbTap(Math.round(screen.width * 0.15), Math.round(screen.height * 0.92));
      }
      await this.driver.pause(3000);
    }
    
    await this.navigateViaSports();
    console.log(`Searching for "${this.ppvName}" in Upcoming Big Fights...`);

    let found = await this.findPPVBanner(this.ppvName);
    for (let i = 0; i < 12 && !found; i++) {
      await this.scrollDown();
      found = await this.isVisible(this.ppvName, 1200);
    }

    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_boxing_debug.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found on Boxing page`);
      throw new Error(`"${this.ppvName}" not found on Boxing page. Check test-results/android_boxing_debug.png`);
    }

    hooks.recordAvailability?.(true, undefined, 'Home of Boxing');
    await this.driver.saveScreenshot('./test-results/android_ppv_found.png');
    await this.runSurfaceValidation(hooks, 'PPV Tile');
    await this.tapByText(this.ppvName);
    await this.driver.pause(2500);
    await this.driver.saveScreenshot('./test-results/android_ppv_detail.png');

    let buyTapped = await this.tapBuyCtaWithFallback(['Buy now', 'Buy Now', 'Buy', 'Get PPV', 'Purchase']);
    for (let i = 0; i < 4 && !buyTapped; i++) {
      await this.scrollDown();
      buyTapped = await this.tapBuyCtaWithFallback(['Buy now', 'Buy Now', 'Buy', 'Get PPV'], {
        primaryTimeoutMs: 2000,
        scrollBeforeFallback: false,
      });
    }
    return buyTapped;
  }

  async openBoxingPageBannerPaywall(hooks: AndroidFlowHooks = {}, options: { requireBanner?: boolean } = {}): Promise<boolean> {
    // Ensure we're on Home page before navigating to Sports (post-login behavior)
    const homeTab = await this.driver.$('android=new UiSelector().text("Home")');
    if (!(await homeTab.isDisplayed().catch(() => false))) {
      const homeClicked = await this.tapByText('Home', 3000);
      if (!homeClicked) {
        const screen = getScreenSize();
        adbTap(Math.round(screen.width * 0.15), Math.round(screen.height * 0.92));
      }
      await this.driver.pause(3000);
    }
    
    await this.navigateViaSports();
    await this.driver.pause(1500);

    const found = await this.findBannerOnCurrentPage(this.ppvName);
    if (!found && options.requireBanner) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_boxing_page_ppv_banner_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`PPV banner "${this.ppvName}" not found on Boxing page`);
      throw new Error(`PPV banner "${this.ppvName}" not found on Boxing page. See test-results/android_boxing_page_ppv_banner_not_found.png`);
    }

    if (found) {
      hooks.recordAvailability?.(true, undefined, 'Home of Boxing');
      console.log(`  Verified banner title: "${this.ppvName}"`);
      await this.runSurfaceValidation(hooks, 'PPV Banner');
    }

    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] PPV banner verified (boxing). Ending banner flow (no fixture / checkout expected).');
      return true;
    }

    return this.tapBuyCtaWithFallback(['Buy this fight', 'Buy now', 'Buy Now', 'Buy'], {
      primaryTimeoutMs: 7000,
      scrollBeforeFallback: false,
    });
  }

  async openHomeBoxingBannerPaywall(eventConfig?: any, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    const targetSport = (eventConfig?.SPORT || eventConfig?.global?.SPORT || 'Boxing').trim();
    console.log(`Home -> All Sports -> ${targetSport} -> PPV banner -> Buy now`);
    await this.clickHomeSportFilter(targetSport);
    await this.driver.saveScreenshot('./test-results/android_boxing_page.png');

    console.log(`  Finding PPV banner for "${this.ppvName}" on Boxing page...`);
    const found = await this.findBannerOnCurrentPage(this.ppvName);
    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_ppv_banner_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`PPV banner "${this.ppvName}" not found on Boxing page`);
      throw new Error(`PPV banner "${this.ppvName}" not found on boxing page. See test-results/android_ppv_banner_not_found.png`);
    }

    hooks.recordAvailability?.(true, undefined, 'Home of Boxing');
    console.log(`  Verified banner title: "${this.ppvName}"`);
    await this.driver.saveScreenshot('./test-results/android_ppv_banner_found.png');
    await this.runSurfaceValidation(hooks, 'PPV Banner');

    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] PPV banner verified (boxing). Ending banner flow (no fixture / checkout expected).');
      return true;
    }

    return this.tapBuyCtaWithFallback();
  }

  async openHomeBoxingUpcomingPaywall(eventConfig?: any, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    const targetSport = (eventConfig?.SPORT || eventConfig?.global?.SPORT || 'Boxing').trim();
    console.log(`Home -> All Sports -> ${targetSport} -> Upcoming Fights -> smart scroll -> Buy now`);
    
    // Ensure we're on Home page before clicking Boxing filter (post-login behavior)
    const homeTab = await this.driver.$('android=new UiSelector().text("Home")');
    if (!(await homeTab.isDisplayed().catch(() => false))) {
      const homeClicked = await this.tapByText('Home', 3000);
      if (!homeClicked) {
        const screen = getScreenSize();
        adbTap(Math.round(screen.width * 0.15), Math.round(screen.height * 0.92));
      }
      await this.driver.pause(3000);
    }
    
    const dateParts = getPPVDateParts(eventConfig);
    console.log(`  PPV date from config/fallback: ${dateParts.month} ${dateParts.day} (${dateParts.monthShort})`);

    await this.clickHomeSportFilter(targetSport);
    await this.driver.saveScreenshot('./test-results/android_boxing_page.png');
    const beforeUpcomingSource = await this.driver.getPageSource().catch(() => '');
    const upcomingClicked = await this.clickUpcomingFightsFilter();
    if (!upcomingClicked) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_upcoming_filter_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.('Upcoming Fights filter not found on Home Boxing page');
      return false;
    }
    const contentReady = await this.waitForUpcomingFightsContent(dateParts, beforeUpcomingSource);
    if (!contentReady) {
      hooks.recordAvailability?.(false, './test-results/android_upcoming_fights_not_loaded.png', 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.('Upcoming Fights content did not load before scrolling');
      return false;
    }
    await this.driver.saveScreenshot('./test-results/android_upcoming_fights.png');

    const found = await this.scrollToUpcomingPPV(dateParts);
    const targetReady = await this.keepPpvTitleInValidationView();
    if (!found || !targetReady) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_home_boxing_upcoming_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found in Home Boxing Upcoming`);
      return false;
    }

    hooks.recordAvailability?.(true, undefined, 'Home of Boxing');
    await this.runSurfaceValidation(hooks, 'PPV Tile');
    const buyTapped = await this.tapBuyNowNearPPV();
    if (!buyTapped) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_home_boxing_upcoming_buy_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`Buy CTA for PPV "${this.ppvName}" not found in Home Boxing Upcoming`);
    }
    return buyTapped;
  }

  async waitForContentRailsToLoad(timeoutMs = 15000): Promise<boolean> {
    console.log('⏳ Checking that Boxing page content rails are fully loaded and visible...');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        const src = (await this.driver.getPageSource().catch(() => '')).toLowerCase();
        const railKeywords = [
          "don't miss", "dont miss", "boxing", "upcoming fights",
          "featured", "trending", "highlights", "schedule", "must watch",
          "live & upcoming", "catch up", "popular"
        ];
        const loaded = railKeywords.some(k => src.includes(k));
        if (loaded) {
          console.log('  ✅ Content rails verified as loaded and visible on screen!');
          await this.driver.pause(2000);
          return true;
        }
      } catch {}
      console.log('  Waiting for content rails network feed to render...');
      await this.driver.pause(2000);
    }
    return false;
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

  async openHomeSportLockedTilePaywall(targetSport: string, eventConfig?: any, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    console.log(`Home -> Sports -> ${targetSport} -> Dynamic PPV tile discovery (API-driven)`);

    // 1. Navigate to target sport page (e.g. Boxing, Wrestling) via Sports / All Sports on Home
    await this.clickHomeSportFilter(targetSport);
    console.log(`  ✓ On ${targetSport} page. Waiting for content feed to initialize...`);
    await this.driver.pause(2500);
    await this.waitForContentRailsToLoad();

    const locator = new DynamicPpvTileLocator(this.driver, this.ppvName);
    const locatorRes = await locator.locateAndOpenPpvTile({
      page: targetSport,
      eventConfig,
      hooks,
      forceRailTitle: "Coming up",
      minRailY: 100,
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

    const shot = hooks.saveScreenshot
      ? await hooks.saveScreenshot(`./test-results/android_${targetSport.toLowerCase()}_ppv_locked_tile_not_found.png`)
      : undefined;
    hooks.recordAvailability?.(false, shot, `Home of ${targetSport}`);
    await hooks.generateAvailabilityFailureReport?.(`PPV locked tile for "${this.ppvName}" not found on ${targetSport} page`);
    throw new Error(`❌ PPV locked tile for "${this.ppvName}" not found on ${targetSport} page`);
  }

  async openHomeBoxingDontMissTilePaywall(hooks: AndroidFlowHooks = {}, eventConfig?: any): Promise<boolean> {
    const targetSport = (eventConfig?.SPORT || eventConfig?.global?.SPORT || 'Boxing').trim();

    if (targetSport.toLowerCase() !== 'boxing') {
      return this.openHomeSportLockedTilePaywall(targetSport, eventConfig, hooks);
    }

    console.log('Home -> All Sports -> Boxing filter -> Boxing Page -> Dynamic PPV tile discovery (API-driven)');

    // 1. Navigate to Boxing page via All Sports on Home
    await this.clickHomeSportFilter('Boxing');
    console.log('  ✓ On Boxing page. Waiting for content feed to initialize...');
    await this.driver.pause(2500);
    await this.waitForContentRailsToLoad();

    const locator = new DynamicPpvTileLocator(this.driver, this.ppvName);
    const locatorRes = await locator.locateAndOpenPpvTile({
      page: 'Boxing',
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

    const shot = hooks.saveScreenshot
      ? await hooks.saveScreenshot('./test-results/android_boxing_ppv_tile_not_found.png')
      : undefined;
    hooks.recordAvailability?.(false, shot, 'Home of Boxing');
    await hooks.generateAvailabilityFailureReport?.(`PPV tile "${this.ppvName}" not found on Boxing page`);
    throw new Error(`❌ PPV tile "${this.ppvName}" not found on Boxing page`);
  }
}

export async function navigateToBoxingPage(driver: WdBrowser): Promise<void> {
  return new AndroidBoxingPage(driver).navigateViaSports();
}

export async function clickHomeBoxingFilter(driver: WdBrowser): Promise<void> {
  return new AndroidBoxingPage(driver).clickHomeBoxingFilter();
}

export async function openBoxingUpcomingFightsPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidBoxingPage(driver, ppvName).openBoxingUpcomingFightsPaywall(hooks);
}

export async function openBoxingPageBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
  options: { requireBanner?: boolean } = {},
): Promise<boolean> {
  return new AndroidBoxingPage(driver, ppvName).openBoxingPageBannerPaywall(hooks, options);
}

export async function openHomeBoxingBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidBoxingPage(driver, ppvName).openHomeBoxingBannerPaywall(eventConfig, hooks);
}

export async function openHomeBoxingUpcomingPaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidBoxingPage(driver, ppvName).openHomeBoxingUpcomingPaywall(eventConfig, hooks);
}

export async function openHomeBoxingDontMissTilePaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
  eventConfig?: any,
): Promise<boolean> {
  return new AndroidBoxingPage(driver, resolvePpvTitleForSource(eventConfig || { PPV_NAME: ppvName }, 'home-boxing-tile')).openHomeBoxingDontMissTilePaywall(hooks, eventConfig);
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
      You are an OCR assistant inspecting a cropped tile image from the "Don't Miss" rail in the DAZN mobile Boxing app.
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
    // Keep the comparison deterministic. Gemini reads the artwork; the test
    // decides the match using the same normalized title rules on every run.
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
