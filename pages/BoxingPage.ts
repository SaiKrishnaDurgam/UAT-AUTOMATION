import { Page } from '@playwright/test';
import { LandingPage } from './LandingPage';
import { assertDaznPageAvailable } from '../utils/helpers';

export class BoxingPage extends LandingPage {
  constructor(page: Page) {
    super(page);
  }

  // ─────────────────────────────
  // NAVIGATE TO BOXING URL
  // ─────────────────────────────
  override async navigate(baseUrl: string, source?: string): Promise<void> {
    const url = `${baseUrl}/p/boxing`;
    console.log(`🌍 Navigating to Boxing page: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    await assertDaznPageAvailable(this.page, 'boxing page navigation');
    await this.dismissConsentIfPresent();
    const isStag = url.includes('stag') || (process.env.DAZN_ENV || '').toLowerCase() === 'stag';
    const waitTimeout = isStag ? 2000 : 15000;
    const isSubscriptionSource =
      source === 'boxing-ultimate-subscription' ||
      source === 'boxing-standard-subscription' ||
      source === 'boxing-join-the-club';
    if (isSubscriptionSource) {
      // Subscription sources don't require PPV buttons — wait for any main content
      await this.page.waitForSelector(
        'main, [class*="hero"], [class*="banner"], [class*="ultimate" i], button',
        { state: 'visible', timeout: waitTimeout }
      ).catch(() => { });
    } else {
      await this.page.waitForSelector(
        'button:has-text("Buy this fight"), button:has-text("Get included")',
        { state: 'visible', timeout: waitTimeout }
      ).catch(() => { });
    }
    console.log(`✅ Landed on: ${this.page.url()}`);
  }

  // ─────────────────────────────
  // FIND PPV CARD IN "UPCOMING BIG FIGHTS" SECTION
  // Strict: throws if section not found. Uses > carousel button
  // to navigate through all cards if PPV not immediately visible.
  // Pattern mirrors SportsLandingPage.findPPVTileInDontMissRail()
  // ─────────────────────────────
  async findUpcomingFightsPPV(eventData: Record<string, string>): Promise<any> {
    const ppvName = eventData.PPV_NAME || '';
    const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
    const fighter1 = vsMatch ? vsMatch[1] : '';
    const fighter2 = vsMatch ? vsMatch[2] : '';

    console.log(`🔍 [Upcoming Big Fights] Looking for "${ppvName}"...`);

    // ── STEP 1: Scroll to find "Upcoming Big Fights" heading ──────────
    // STRICT: if heading not found → throw, no fallback
    let sectionHeading: any = null;
    for (let scroll = 0; scroll < 12; scroll++) {
      const heading = this.page.locator(
        'h2, h3, h4, [class*="heading" i], [class*="title" i], [class*="sectionTitle" i]'
      ).filter({ hasText: /upcoming big fights/i }).first();

      if (await heading.isVisible({ timeout: 800 }).catch(() => false)) {
        sectionHeading = heading;
        break;
      }
      await this.page.evaluate(() => window.scrollBy(0, 400));
      await this.page.waitForTimeout(300);
    }

    if (!sectionHeading) {
      throw new Error(
        `❌ [Upcoming Big Fights] Section heading "Upcoming Big Fights" not found on Boxing page. ` +
        `This section must be present for source "boxing-upcoming-fights" to work. ` +
        `No fallback will be attempted.`
      );
    }

    console.log('✅ [Upcoming Big Fights] Section heading found');
    await sectionHeading.scrollIntoViewIfNeeded().catch(() => { });
    await this.page.waitForTimeout(500);

    // ── STEP 2: Find the section wrapper / rail container ─────────────
    // Walk up from the heading to find the container that holds the cards
    let sectionWrapper: any = null;

    // Try common wrapper class patterns (same approach as SportsLandingPage)
    const wrapperSelectors = [
      'xpath=ancestor::div[.//div[contains(@class,"swiper")]][1]',
      'xpath=ancestor::*[contains(@class,"railWrapper")][1]',
      'xpath=ancestor::*[contains(@class,"rail__rail-wrapper")][1]',
      'xpath=ancestor::section[1]',
      'xpath=ancestor::div[contains(@class,"section")][1]',
      'xpath=ancestor::div[contains(@class,"upcoming")][1]',
      'xpath=ancestor::div[contains(@class,"fights")][1]',
    ];

    for (const sel of wrapperSelectors) {
      const wrapper = sectionHeading.locator(sel);
      if (await wrapper.isVisible({ timeout: 1000 }).catch(() => false)) {
        sectionWrapper = wrapper;
        console.log(`✅ [Upcoming Big Fights] Found section wrapper via: ${sel}`);
        break;
      }
    }

    // Fallback: use the heading's parent section/div
    if (!sectionWrapper) {
      sectionWrapper = sectionHeading.locator('xpath=ancestor::*[self::section or self::div][1]');
      const hasWrapper = await sectionWrapper.isVisible({ timeout: 1000 }).catch(() => false);
      if (!hasWrapper) {
        // Last resort: scope to page but log warning
        console.log('⚠️ [Upcoming Big Fights] Could not find section wrapper — scoping to full page');
        sectionWrapper = this.page.locator('body');
      }
    }

    // ── STEP 3: Wait for fight cards to render ────────────────────────
    await this.page.waitForSelector(
      'button:has-text("Buy now"), a:has-text("Buy now")',
      { state: 'visible', timeout: 8000 }
    ).catch(() => {
      console.log('⚠️ [Upcoming Big Fights] No "Buy now" buttons found within timeout');
    });

    // ── STEP 4: Build name matchers (same pattern as SportsLandingPage) ─
    const cleanStr = (s: string) =>
      (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
    const partsWordLists = nameParts
      .map(part => cleanStr(part).split(/\s+/).filter(Boolean))
      .filter(list => list.length > 0);

    const matchesCard = (text: string): boolean => {
      const ct = cleanStr(text);
      const matchTitle = partsWordLists.some(words => words.every(w => ct.includes(w)));
      const matchFighters = !!(
        fighter1 && fighter2 &&
        ct.includes(fighter1.toLowerCase()) &&
        ct.includes(fighter2.toLowerCase())
      );
      return matchTitle || matchFighters;
    };

    // ── STEP 5: Check if PPV card is already visible ──────────────────
    const isTileInView = async (): Promise<any> => {
      // Find all cards — match by PPV name first, do NOT filter by "Buy now"
      // because the target PPV may show a different CTA (e.g. "Get included",
      // "Watch Live", etc.) depending on the user's plan/entitlement state.
      const cardCandidates = sectionWrapper.locator(
        '.swiper-slide'
      );

      const count = await cardCandidates.count().catch(() => 0);
      let bestCard: any = null;
      let bestScore = 0;

      for (let i = 0; i < count; i++) {
        const card = cardCandidates.nth(i);
        if (!await card.isVisible().catch(() => false)) continue;

        const text = (await card.textContent().catch(() => '')) || '';
        if (!matchesCard(text)) continue;

        // Check if card is in viewport (not hidden by carousel overflow)
        const inView = await card.evaluate((el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
        }).catch(() => false);

        if (!inView) continue;

        // Score the match (exact match = 100, partial = lower)
        const score = (() => {
          const ct = cleanStr(text);
          const cn = cleanStr(ppvName);
          if (ct === cn) return 100;
          const nameWords = cn.split(/\s+/).filter(Boolean);
          const allMatch = nameWords.every(w => ct.includes(w));
          if (!allMatch) return 0;
          return Math.round((cn.length / ct.length) * 90);
        })();

        if (score > bestScore) {
          bestScore = score;
          bestCard = card;
          console.log(`🔍 [Upcoming Big Fights] Candidate card (score=${score}): "${text.replace(/\s+/g, ' ').substring(0, 80)}"`);
        }
      }

      return bestCard;
    };

    // ── STEP 6: Navigate carousel using > button (same as SportsLandingPage) ─
    // Find the next/chevron button within the section
    const nextBtn = sectionWrapper.locator([
      '[class*="rail-module__next"]',
      'button[aria-label="Next slide"]',
      'button[class*="swiper-button-next"]',
      '[class*="next" i]:not([class*="disabled" i])',
      'button[class*="chevron" i]',
      'button[class*="arrow" i]',
      'svg[class*="chevron" i]',
    ].join(', ')).first();

    // Hover to reveal navigation arrows (same pattern as SportsLandingPage)
    await sectionWrapper.hover({ force: true }).catch(() => { });
    await this.page.waitForTimeout(300);

    let found = await isTileInView();
    if (found) {
      await this.stopCarouselAutoSlide();
      console.log('✅ [Upcoming Big Fights] PPV card already visible — no carousel navigation needed');
      return found;
    }

    // Navigate carousel with > button until PPV found or end reached
    const maxClicks = 30;
    let clicks = 0;

    while (!found && clicks < maxClicks) {
      if (this.page.isClosed()) throw new Error('Page closed during carousel navigation');

      // Hover to keep arrows visible
      await sectionWrapper.hover({ force: true }).catch(() => { });
      await this.page.waitForTimeout(200);

      // Check if next button is disabled (end of carousel)
      const nextDisabled = await nextBtn.evaluate((el: Element) => {
        return el.classList.contains('swiper-button-disabled') ||
          el.classList.contains('rail-module__disable') ||
          el.className.includes('disable') ||
          el.hasAttribute('disabled');
      }).catch(() => false);

      if (nextDisabled) {
        console.log('⚠️ [Upcoming Big Fights] Next button disabled — end of carousel reached');
        break;
      }

      // Check next button exists in DOM (retry once for transient detach)
      let nextCount = await nextBtn.count().catch(() => 0);
      if (nextCount === 0) {
        await this.page.waitForTimeout(400);
        nextCount = await nextBtn.count().catch(() => 0);
        if (nextCount === 0) {
          console.log('⚠️ [Upcoming Big Fights] Next button not found in DOM after retry');
          break;
        }
      }

      console.log(`  [Upcoming Big Fights] Click ${clicks + 1}: advancing carousel...`);
      await nextBtn.click({ timeout: 5000, force: true }).catch((e: any) => {
        console.log(`⚠️ Next click error: ${e.message}`);
      });
      clicks++;
      await this.page.waitForTimeout(600);

      found = await isTileInView();
    }

    console.log(`📊 [Upcoming Big Fights] Carousel clicks performed: ${clicks}`);

    // If still not found after carousel navigation → FAIL
    if (!found) {
      throw new Error(
        `❌ [Upcoming Big Fights] PPV card for "${ppvName}" not found in "Upcoming Big Fights" ` +
        `section after navigating ${clicks} carousel slides. ` +
        `No fallback will be attempted.`
      );
    }

    console.log(`✅ [Upcoming Big Fights] PPV card found after ${clicks} carousel clicks`);
    await this.stopCarouselAutoSlide();
    return found;
  }

  // ─────────────────────────────
  // FIND BUNDLE SECTION on /boxing page
  // ─────────────────────────────
  async findBundleSection(): Promise<any> {
    console.log('🔍 [Bundle] Looking for bundle section on boxing page...');

    // Scroll down to find the bundle section
    for (let scroll = 0; scroll < 5; scroll++) {
      await this.page.evaluate(() => {
        window.scrollBy(0, 600);
      }).catch(() => { });
      await this.page.waitForTimeout(500);

      // Check if bundle section is visible
      const bundleHeading = this.page.locator('text=/Save with a fight bundle/i').first();
      if (await bundleHeading.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('✅ [Bundle] Found "Save with a fight bundle" section');
        break;
      }
    }

    // Wait for Get Started button
    const getStartedBtn = this.page.locator('button:has-text("Get Started"), a:has-text("Get Started")').first();
    await getStartedBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {
      console.log('⚠️  [Bundle] "Get Started" button not found');
    });

    // Find the bundle card container
    const bundleCard = this.page.locator(
      '[class*="bundle" i], [class*="Bundle" i]'
    ).first();

    if (await bundleCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('✅ [Bundle] Bundle card found');
      return bundleCard;
    }

    // Fallback: return the section containing the Get Started button
    if (await getStartedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('✅ [Bundle] Returning section with Get Started button');
      return this.page.locator('body').first();
    }

    console.log('⚠️  [Bundle] Bundle section not found');
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FIND BOXING PAGE PPV TILE → CLICK IT → WAIT FOR MODAL POPUP
  // Used by home-boxing-tile. Mirrors home-page-dont-miss tile-click-popup flow:
  //   1. Scroll the boxing page to find the PPV event tile
  //   2. Click the tile → PPV popup appears in #notification-layer
  //   3. Return #notification-layer so clickBuyNow can scope Buy now to the popup
  //
  // This avoids the body-wide Buy now search that, for logged-in freemium users,
  // hits the pre-existing DAZN Ultimate subscription CTA instead of the PPV popup.
  // ─────────────────────────────────────────────────────────────────────────────
  async findBoxingTileAndOpenPopup(eventData: Record<string, string>): Promise<any> {
    const ppvName = eventData.PPV_NAME || '';
    const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
    const fighter1 = vsMatch ? vsMatch[1].toLowerCase() : '';
    const fighter2 = vsMatch ? vsMatch[2].toLowerCase() : '';

    console.log(`🔍 [home-boxing-tile] Looking for PPV tile "${ppvName}" on boxing page...`);

    const cleanStr = (s: string) =>
      (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    const matchesTile = (text: string): boolean => {
      const ct = cleanStr(text);
      if (fighter1 && fighter2 && ct.includes(fighter1) && ct.includes(fighter2)) return true;
      const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
      return nameParts.some(part => {
        const words = cleanStr(part).split(/\s+/).filter(Boolean);
        return words.length > 0 && words.every(w => ct.includes(w));
      });
    };

    // ── Step 1: Find the boxing page PPV tile ────────────────────────────────
    let tile: any = null;

    // Tile selectors — boxing page tiles are typically cards/articles
    const tileSelectors = [
      '[class*="card" i]',
      '[class*="tile" i]',
      '[class*="event" i]',
      '[class*="fight" i]',
      'article',
      'li',
    ].join(', ');

    for (let scroll = 0; scroll < 12 && !tile; scroll++) {
      const candidates = this.page.locator(tileSelectors);
      const count = await candidates.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        const el = candidates.nth(i);
        if (!await el.isVisible().catch(() => false)) continue;
        const text = (await el.textContent().catch(() => '')) || '';
        if (!matchesTile(text)) continue;
        tile = el;
        console.log(`✅ [home-boxing-tile] Found tile: "${text.replace(/\s+/g, ' ').substring(0, 80)}"`);
        break;
      }

      if (!tile) {
        await this.page.evaluate(() => window.scrollBy(0, 400));
        await this.page.waitForTimeout(300);
      }
    }

    if (!tile) {
      console.log(`⚠️ [home-boxing-tile] PPV tile not found by event name — falling back to body`);
      return this.page.locator('body').first();
    }

    // ── Step 2: Click the tile → popup should appear ─────────────────────────
    const beforeUrl = this.page.url();
    await tile.scrollIntoViewIfNeeded().catch(() => { });
    await this.page.waitForTimeout(150);

    try {
      await tile.click({ force: true, timeout: 10000 });
      console.log('✅ [home-boxing-tile] Clicked PPV tile');
    } catch {
      console.log('⚠️ [home-boxing-tile] Standard tile click failed — trying JS click');
      const handle = await tile.elementHandle().catch(() => null);
      if (handle) {
        await this.page.evaluate((el: any) => el.click(), handle);
        console.log('✅ [home-boxing-tile] JS click on tile executed');
      }
    }

    // ── Step 3: Wait for popup in #notification-layer ───────────────────────
    for (let attempt = 0; attempt < 15; attempt++) {
      if (this.page.url() !== beforeUrl) {
        console.log(`✅ [home-boxing-tile] Tile click navigated directly to: ${this.page.url()}`);
        return this.page.locator('body').first();
      }

      // Check for popup Buy now in notification-layer (same selectors as clickBuyNow uses)
      const notifBuyNow = this.page.locator(
        '#notification-layer button:has-text("Buy now"), ' +
        '#notification-layer a:has-text("Buy now"), ' +
        '[class*="signup-paywall"] button:has-text("Buy now"), ' +
        '[class*="signup-paywall"] a:has-text("Buy now")'
      ).first();

      if (await notifBuyNow.isVisible({ timeout: 200 }).catch(() => false)) {
        console.log('✅ [home-boxing-tile] PPV popup appeared in #notification-layer');
        return this.page.locator('#notification-layer').first();
      }

      await this.page.waitForTimeout(150);
    }

    console.log('⚠️ [home-boxing-tile] Modal popup not detected — falling back to body');
    return this.page.locator('body').first();
  }

  override async findPPVContainer(eventData: Record<string, string>, source?: string): Promise<any> {
    const src = (source || '').toLowerCase();
    if (src.startsWith('boxing-bundle') || src.startsWith('boxing-page-bundle')) {
      return this.findBundleSection();
    }
    if (src === 'boxing-upcoming-fights') {
      // Returns the specific PPV card element — clickBuyNow will find
      // "Buy now" inside it. Throws if section or PPV not found.
      return this.findUpcomingFightsPPV(eventData);
    }
    if (src === 'boxing-page-banner' || src === 'boxing-buy' || src === 'boxing-ultimate' || src === 'boxing-banner-ultimate') {
     return this.findPPVInBanner(eventData, src);
    }
    if (src === 'boxing-ultimate-subscription' || src === 'boxing-standard-subscription' || src === 'boxing-join-the-club') {
      // Subscription-only flows — no PPV container needed.
      console.log(`ℹ️ [BoxingPage] Subscription source "${src}" — returning page body as container`);
      return this.page.locator('body').first();
    }
    if (src === 'home-boxing-tile') {
      // The boxing page (Home of Boxing, /p/boxing) has a PPV tile.
      // For logged-in users there are OTHER "Buy now" / subscription CTAs already on the page
      // (Ultimate promo in notification-layer, header upgrade btn, etc.) which break the
      // naive body-wide Buy now search.
      // Fix: find and click the boxing page PPV tile so the PPV popup appears in
      // #notification-layer, then return it — exactly as home-page-dont-miss does.
      return this.findBoxingTileAndOpenPopup(eventData);
    }
    return this.page.locator('body').first();
  }

  override async clickBuyNow(container: any, source?: string): Promise<void> {
    if (!container) {
      throw new Error('❌ No PPV container found — cannot click Buy Now');
    }

    console.log(`` + `💳 Clicking Boxing CTA via source: ${source}...`);
    await this.stopCarouselAutoSlide();
    await this.dismissConsentIfPresent();

    let btn: any;
    if (source === 'boxing-bundle' || source === 'boxing-page-bundle' || source === 'boxing-bundle-ultimate') {
      if (source === 'boxing-bundle-ultimate') {
        // Look for container with Ultimate text and find its Get Started button
        const ultimateBtn = this.page.locator('div:has-text("Ultimate"), [class*="ultimate" i]')
          .locator('button:has-text("Get Started"), a:has-text("Get Started")')
          .first();
        if (await ultimateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          btn = ultimateBtn;
        } else {
          const btns = this.page.locator('button:has-text("Get Started"), a:has-text("Get Started")');
          if (await btns.count().catch(() => 0) > 1) {
            btn = btns.nth(1);
          } else {
            btn = btns.first();
          }
        }
      } else {
        btn = this.page.locator('button:has-text("Get Started"), a:has-text("Get Started")').first();
      }
    } else if (source === 'boxing-ultimate-subscription') {
      // ── "Introducing DAZN Ultimate" section — "Continue with DAZN Ultimate" CTA ──
      // This CTA appears in the subscription section of /p/boxing (Image 3/4 reference).
      // It takes the user directly to TierPlans or PlanDetails for Ultimate plan only.
      console.log('💎 [boxing-ultimate-subscription] Looking for "Continue with DAZN Ultimate" CTA...');
      const ultimateSubSelectors = [
        'button:has-text("Continue with DAZN Ultimate")',
        'a:has-text("Continue with DAZN Ultimate")',
        'button:has-text("Join the club")',
        'a:has-text("Join the club")',
        'button:has-text("Join Club")',
        'a:has-text("Join Club")',
        '[role="button"]:has-text("Ultimate")',
        '[class*="button" i]:has-text("Ultimate")',
        'div:has-text("Continue with DAZN Ultimate")',
        'span:has-text("Continue with DAZN Ultimate")',
      ];
      let found = false;
      for (const sel of ultimateSubSelectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          btn = el;
          found = true;
          console.log(`✅ [boxing-ultimate-subscription] CTA found via: ${sel}`);
          break;
        }
      }
      if (!found) {
        // Scroll down to find the "Introducing DAZN Ultimate" section
        for (let i = 0; i < 6; i++) {
          await this.page.evaluate(() => window.scrollBy(0, 500));
          await this.page.waitForTimeout(300);
          for (const sel of ultimateSubSelectors) {
            const el = this.page.locator(sel).first();
            if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
              btn = el;
              found = true;
              console.log(`✅ [boxing-ultimate-subscription] CTA found after scroll via: ${sel}`);
              break;
            }
          }
          if (found) break;
        }
      }
      if (!found || !btn) {
        throw new Error('❌ [boxing-ultimate-subscription] "Continue with DAZN Ultimate" or "Join the club" CTA not found on boxing page.');
      }
    } else if (source === 'boxing-standard-subscription') {
      // ── "Introducing DAZN Ultimate" section — "Continue with Standard" CTA ──
      console.log('🔵 [boxing-standard-subscription] Looking for "Continue with Standard" CTA...');
      const standardSubSelectors = [
        'button:has-text("Continue with Standard")',
        'a:has-text("Continue with Standard")',
        'button:has-text("Continue with DAZN Standard")',
        'a:has-text("Continue with DAZN Standard")',
        'button:has-text("Sign up")',
        'a:has-text("Sign up")',
        '[role="button"]:has-text("Standard")',
        '[class*="button" i]:has-text("Standard")',
        'div:has-text("Continue with DAZN Standard")',
        'span:has-text("Continue with DAZN Standard")',
      ];
      let foundStd = false;
      for (const sel of standardSubSelectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          btn = el;
          foundStd = true;
          console.log(`✅ [boxing-standard-subscription] CTA found via: ${sel}`);
          break;
        }
      }
      if (!foundStd) {
        // Scroll down to find the section
        for (let i = 0; i < 6; i++) {
          await this.page.evaluate(() => window.scrollBy(0, 500));
          await this.page.waitForTimeout(300);
          for (const sel of standardSubSelectors) {
            const el = this.page.locator(sel).first();
            if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
              btn = el;
              foundStd = true;
              console.log(`✅ [boxing-standard-subscription] CTA found after scroll via: ${sel}`);
              break;
            }
          }
          if (foundStd) break;
        }
      }
      if (!foundStd || !btn) {
        throw new Error('❌ [boxing-standard-subscription] "Continue with Standard" CTA not found on boxing page.');
      }
    } else if (source === 'boxing-join-the-club') {
      // ── "Introducing DAZN Ultimate" section — "Join the club" CTA ──
      // Distinct button from "Continue with DAZN Ultimate" — this is the
      // subscription tile CTA that takes the user directly to TierPlans/PlanDetails.
      console.log('🌟 [boxing-join-the-club] Looking for "Join the club" CTA...');
      const joinSelectors = [
        'button:has-text("Join the club")',
        'a:has-text("Join the club")',
        'button:has-text("Join Club")',
        'a:has-text("Join Club")',
        'button:has-text("Join the Club")',
        'a:has-text("Join the Club")',
      ];
      let foundJoin = false;
      for (const sel of joinSelectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          btn = el;
          foundJoin = true;
          console.log(`✅ [boxing-join-the-club] CTA found via: ${sel}`);
          break;
        }
      }
      if (!foundJoin) {
        // Scroll down to find the "Introducing DAZN Ultimate" section
        for (let i = 0; i < 8; i++) {
          await this.page.evaluate(() => window.scrollBy(0, 500));
          await this.page.waitForTimeout(300);
          for (const sel of joinSelectors) {
            const el = this.page.locator(sel).first();
            if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
              btn = el;
              foundJoin = true;
              console.log(`✅ [boxing-join-the-club] CTA found after scroll via: ${sel}`);
              break;
            }
          }
          if (foundJoin) break;
        }
      }
      if (!foundJoin || !btn) {
        throw new Error('❌ [boxing-join-the-club] "Join the club" CTA not found on boxing page.');
      }
    } else {
      let btnSelector = '';
      if (source === 'boxing-buy' || source === 'boxing-page-banner') {
        btnSelector = 'button:has-text("Buy this fight"), a:has-text("Buy this fight")';
      } else if (source === 'boxing-ultimate' || source === 'boxing-banner-ultimate') {
        btnSelector = 'button:has-text("Get included in DAZN Ultimate"), a:has-text("Get included in DAZN Ultimate")';
      } else if (source === 'boxing-upcoming-fights') {
        // container IS the specific PPV card matched by name.
        // Only click if "Buy now" is present inside it.
        // If the card shows "See more" or any other CTA instead of "Buy now",
        // fail immediately — do NOT click a different PPV or fall back page-wide.
        const cardBuyNow = container.locator(
          'button:has-text("Buy now"), a:has-text("Buy now")'
        ).first();
        const isVisible = await cardBuyNow.isVisible({ timeout: 3000 }).catch(() => false);
        if (!isVisible) {
          throw new Error(
            `❌ [Upcoming Big Fights] "Buy now" is not available for this PPV. ` +
            `The card was found and matched by name, but it does not have a "Buy now" button ` +
            `(it may show "See more" or similar — this PPV is not yet purchasable). ` +
            `Will NOT click a different PPV as a fallback.`
          );
        }
        btn = cardBuyNow;
      } else if (source === 'home-boxing-tile') {
        // home-boxing-tile: tile click opens a PPV popup modal in #notification-layer.
        // The container returned by findPPVContainer is `body` — do NOT search inside
        // body for "Buy now" or we'll hit the first match on the page (e.g. header nav).
        // Instead, scope directly to the DAZN notification layer like home-page-dont-miss.
        const notifBtn = this.page.locator(
          '#notification-layer button:has-text("Buy now"), ' +
          '#notification-layer a:has-text("Buy now"), ' +
          '#notification-layer button:has-text("Buy Now")'
        ).first();
        const paywallBtn = this.page.locator(
          '[class*="signup-paywall"] button:has-text("Buy now"), ' +
          '[class*="signup-paywall"] a:has-text("Buy now"), ' +
          '[class*="signup-paywall"] button:has-text("Buy Now")'
        ).first();

        if (await notifBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          btn = notifBtn;
          console.log('✅ [home-boxing-tile] Buy now found in #notification-layer');
        } else if (await paywallBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          btn = paywallBtn;
          console.log('✅ [home-boxing-tile] Buy now found in signup-paywall');
        } else {
          throw new Error(
            '❌ [home-boxing-tile] Buy now button not found in #notification-layer or signup-paywall. ' +
            'Will NOT search page-wide to avoid hitting wrong element.'
          );
        }
      }
      // Restore original fallback: guard with !btn to guarantee btn is always assigned
      // for banner/generic sources (boxing-page-banner, boxing-buy, boxing-ultimate, etc.)
      if (!btn || (source !== 'boxing-upcoming-fights' && source !== 'home-boxing-tile' && !btnSelector)) {
        btn = container.locator(btnSelector || 'button:has-text("Buy now")').first();
      } else if (source !== 'boxing-upcoming-fights' && source !== 'home-boxing-tile' && !btn) {
        btn = container.locator(btnSelector).first();
      }
    }

    const isBtnVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isBtnVisible) {
      const isStag = this.page.url().includes('stag') || (process.env.DAZN_ENV || '').toLowerCase() === 'stag';
      if (isStag) {
        throw new Error(`❌ STAGING FAST FAIL: Boxing PPV banner not available on staging environment.`);
      }
      throw new Error(`❌ Boxing CTA button not visible on page (source: ${source})`);
    }

    await btn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
      await btn.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(500);
    });

    await btn.scrollIntoViewIfNeeded().catch(() => { });
    await this.page.waitForTimeout(300);

    const beforeUrl = this.page.url();

    try {
      await btn.click({ force: true, timeout: 5000 });
    } catch {
      console.log('⚠️  Click intercepted → forcing JS click');
      const handle = await btn.elementHandle({ timeout: 2000 });
      if (!handle) throw new Error('❌ Boxing CTA element handle not found');
      await this.page.evaluate((el: any) => el.click(), handle);
    }

    console.log(`✅ Clicked Boxing CTA`);
    await this.page.waitForLoadState('domcontentloaded').catch(() => { });
    await this.waitForBoxingCtaRouteToSettle(source || '');

    const newUrl = this.page.url();
    console.log(`✅ Navigated to: ${newUrl}`);

    // Verify navigation
    if (newUrl !== beforeUrl && !newUrl.includes('ppv') &&
      !newUrl.includes('contextualPpv') && !newUrl.includes('signup')) {
      console.log(`⚠️  WARNING: Unexpected URL: ${newUrl}`);
    }
  }

  private async waitForBoxingCtaRouteToSettle(source: string): Promise<void> {
    const src = source.toLowerCase();
    const isPpvEntrySource =
      src === 'boxing-page-banner' ||
      src === 'boxing-buy' ||
      src === 'boxing-page-bundle' ||
      src === 'boxing-bundle' ||
      src === 'boxing-upcoming-fights';

    if (!isPpvEntrySource) {
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
      return;
    }

    await this.page.waitForFunction(() => {
      const href = window.location.href.toLowerCase();
      const text = document.body?.innerText?.toLowerCase() || '';
      const onPayment =
        href.includes('paymentdetails') ||
        href.includes('page=payment') ||
        text.includes('choose how to pay');
      const ppvSelectionReady =
        href.includes('contextualppvid=') &&
        !href.includes('upselltierselected=true') &&
        (
          href.includes('upselltiershown=true') ||
          text.includes('continue with pay-per-view') ||
          text.includes('to watch your pay-per-view') ||
          text.includes('just the fight')
        );
      // Active Ultimate users can be routed to My Account after using a Boxing
      // PPV CTA. Treat that as a settled route so the caller can verify the PPV
      // entitlement there instead of waiting for a PPV purchase page.
      const onMyAccount = href.includes('/myaccount');
      return onPayment || ppvSelectionReady || onMyAccount;
    }, { timeout: 12000 }).catch(() => {
      console.log('⚠️ [Boxing CTA] Route did not fully settle before detection; continuing with current page state.');
    });

    await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
  }
}
