import { Page } from '@playwright/test';
import { LandingPage } from './LandingPage';
import { RailsInterceptor } from '../utils/railsInterceptor';
import { pollForHomePagePopup, logoutForPopupRetry, clickAndWaitForNav } from '../utils/testHelpers';
import { assertDaznPageAvailable, dismissMarketingPopup, handleCookies, hasLoadedPPVArtwork, stabilisePage } from '../utils/helpers';
import { validateVariant } from '../flows/validateVariant';
import { getHomePageData } from '../utils/excelReader';

export class HomePage extends LandingPage {
  protected baseUrl: string;

  constructor(page: Page, baseUrl: string = '') {
    super(page);
    this.baseUrl = baseUrl;
  }

  // Navigation for home-page flows
  override async navigate(baseUrl: string, source?: string, eventData?: Record<string, string>): Promise<void> {
    const welcomeUrl = `${baseUrl}/welcome`;
    console.log(`🌍 [HomePage] Navigating to Welcome page: ${welcomeUrl}`);
    await this.page.goto(welcomeUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    await this.dismissConsentIfPresent();

    // Check for VPN/network error BEFORE looking for Explore button.
    // assertDaznPageAvailable refreshes once if the DAZN "problem opening" page is shown.
    await assertDaznPageAvailable(this.page, 'welcome page load');

    console.log(`✅ [HomePage] Welcome page loaded: ${this.page.url()}`);
    await this.clickExplore();
    await assertDaznPageAvailable(this.page, 'home page navigation');

    console.log(`✅ [HomePage] Home page loaded: ${this.page.url()}`);

    // Wait for the hero banner or swiper component to render and be visible
    const bannerLocator = this.page.locator('main [class*="banner"], [class*="hero-banner-slider"], .swiper:not([class*="rail" i]):not([class*="tiles" i])').first();
    await bannerLocator.waitFor({ state: 'visible', timeout: 10000 }).catch((e) => {
      console.log('⚠️ [HomePage] Timeout waiting for hero banner/swiper: ' + e.message);
    });
  }

  protected async clickExplore(): Promise<void> {
    console.log('🔍 Looking for "Explore" button on welcome page...');

    const exploreSelectors = [
      'a:has-text("Explore")',
      'button:has-text("Explore")',
      'a[href*="/home" i]',
      'a:has-text("Explore DAZN")',
      'a:has-text("Explore without subscribing")',
      'a:has-text("Explore for free")',
      '[class*="explore" i]',
    ];

    const combinedSelector = exploreSelectors.join(', ');
    const anyExplore = this.page.locator(combinedSelector).first();
    let found = await anyExplore.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);

    // If Explore not found, refresh the page (likely VPN/transient issue) and retry
    if (!found) {
      console.log('⚠️ Explore button not found — refreshing page and retrying...');
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      await this.dismissConsentIfPresent();
      await assertDaznPageAvailable(this.page, 'welcome page refresh');
      found = await anyExplore.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    }

    if (found) {
      console.log(`📍 Found Explore button`);
      await anyExplore.scrollIntoViewIfNeeded().catch(() => { });
      await anyExplore.click({ force: true });
      await this.page.waitForURL((url: URL) => url.toString().includes('/home'), { timeout: 15000 }).catch(() => { });
    } else {
      // Last resort: direct navigation to /home
      console.log('⚠️ Explore button still not found after refresh — navigating directly to /home');
      const currentUrl = this.page.url();
      const baseMatch = currentUrl.match(/(https:\/\/[a-z0-9.-]*dazn\.com\/en-[A-Z]+)/i);
      const base = baseMatch?.[1] || this.getFallbackBaseUrl();
      await this.page.goto(`${base}/home`, { waitUntil: 'domcontentloaded' });
    }

    // Wait for Home page to be visually ready before next action
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
  }

  // Find container logic:
  // For home-page-banner: uses LandingPage.findPPVInBanner
  // For home-page-dont-miss: finds tile, clicks it to open modal, and returns the modal popup!
  override async findPPVContainer(eventData: Record<string, string>, source?: string): Promise<any> {
    const src = (source || '').toLowerCase();

    if (src === 'home-page-banner') {
      return super.findPPVInBanner(eventData, src);
    }

    if (src === 'home-biggest-fights') {
      console.log('🔍 [HomePage Biggest Fights] Flow: Home → Competition Page → Coming Up → Popup');

      // ── STEP 1: Scroll to the fights section heading ──────────────
      // Section name is dynamic — could be "The Biggest Fights", "Saturday Fight Night", etc.
      // Each source must verify from its specific section — if it doesn't exist, the test should fail.
      const sectionPatterns = [
        /biggest\s*fights/i,
        /saturday\s*fight\s*night/i,
        /fight\s*night/i,
      ];

      let sectionHeading: any = null;
      let foundHeading = false;
      let matchedPattern = '';

      // Check real rail headings first, then retain the generic fallback for
      // markup variants. After dev mode returns to Home the rails lazy-load,
      // so scan the full dynamically-sized page instead of a fixed 8,000px.
      const railHeadingSelector = [
        'section[data-target="rail"] h1',
        'section[data-target="rail"] h2',
        'section[data-target="rail"] h3',
        'section[data-target="rail"] [class*="title" i]',
      ].join(', ');
      const fallbackHeadingSelector = 'h1, h2, h3, [class*="title" i]';

      // IMPORTANT: skip any heading that is wrapped inside an <a> element —
      // those are article/promo tiles (href="/en-GB/home/ArticleId:..."), not rail headings.
      for (let i = 0; i < 35 && !foundHeading; i++) {
        for (const pattern of sectionPatterns) {
          for (const selector of [railHeadingSelector, fallbackHeadingSelector]) {
            const allCandidates = this.page.locator(selector).filter({ hasText: pattern });
            const count = await allCandidates.count().catch(() => 0);
            for (let j = 0; j < count; j++) {
              const candidate = allCandidates.nth(j);
              if (!await candidate.isVisible().catch(() => false)) continue;
              // Skip if heading is inside an <a> link (promo/article tile)
              const insideLink = await candidate.locator('xpath=ancestor::a[1]').count().catch(() => 0) > 0;
              if (insideLink) {
                const txt = (await candidate.textContent().catch(() => '')) || '';
                console.log(`⏭️ [Biggest Fights] Skipping heading inside <a>: "${txt.trim().substring(0, 60)}"`);
                continue;
              }
              sectionHeading = candidate;
              foundHeading = true;
              matchedPattern = pattern.source;
              break;
            }
            if (foundHeading) break;
          }
          if (foundHeading) break;
        }
        if (!foundHeading) {
          if (this.page.isClosed()) break;
          await this.page.evaluate(() => {
            window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: 'instant' });
          }).catch(() => { });
          // Give the next rail a chance to render before checking headings again.
          await this.page.waitForTimeout(400).catch(() => { });
        }
      }

      if (!foundHeading) {
        throw new Error(
          `❌ [HomePage Biggest Fights] No fights section heading found on Home page. ` +
          `Tried patterns: ${sectionPatterns.map(p => p.source).join(', ')}`
        );
      }

      await sectionHeading.scrollIntoViewIfNeeded().catch(() => { });
      const sectionHeadingText = ((await sectionHeading.textContent().catch(() => '')) || '').trim();
      if (sectionHeadingText) {
        eventData.HOME_BIGGEST_FIGHTS_SECTION_HEADING = sectionHeadingText;
      }
      console.log(`✅ [HomePage Biggest Fights] Section heading found (matched: ${matchedPattern})`);

      const ppvName = eventData.PPV_NAME || '';
      const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
      const fighter1 = vsMatch ? vsMatch[1] : '';
      const fighter2 = vsMatch ? vsMatch[2] : '';
      console.log(`🔍 [HomePage Biggest Fights] Looking for: "${ppvName}" (f1="${fighter1}", f2="${fighter2}")`);

      const cleanStr = (s: string) =>
        (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      const isVariantTileText = (text: string): boolean =>
        /\b(press\s*conference|weigh\s*in|weigh-in|prelims?|preliminary|pre[\s-]?show|buy[\s-]?in|tailgate|face\s*off|highlights?|trailer|preview|countdown|full\s*fight|replay)\b/i.test(text);
      const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
      const partsWordLists = nameParts
        .map(part => cleanStr(part).split(/\s+/).filter(Boolean))
        .filter(list => list.length > 0);
      const matchesTileText = (text: string): boolean => {
        const ct = cleanStr(text);
        const matchTitle = partsWordLists.some(words => words.every(w => ct.includes(w)));
        const matchFighters = !!(
          fighter1 && fighter2 &&
          ct.includes(cleanStr(fighter1)) &&
          ct.includes(cleanStr(fighter2))
        );
        return matchTitle || matchFighters;
      };

      // ── RailsInterceptor (for diagnostics) ──
      const railsInterceptor: RailsInterceptor | undefined = (eventData as any)._railsInterceptor;
      if (railsInterceptor) {
        railsInterceptor.printRailsSummary();
      }

      // ── STEP 2: Find the rail container, then locate the correct tile ─────────
      // IMPORTANT: scope ALL img/link searches to the rail container, not the full
      // page, so we don't accidentally pick up Joshua tiles from Don't Miss or Banner.
      await sectionHeading.scrollIntoViewIfNeeded().catch(() => { });

      // Walk up from heading to the nearest ancestor that has competition links
      let railContainer: any = sectionHeading.locator('xpath=..');
      for (const xpath of ['xpath=..', 'xpath=../..', 'xpath=../../..', 'xpath=../../../..', 'xpath=../../../../..']) {
        const candidate = sectionHeading.locator(xpath);
        const lc = await candidate.locator('a[href*="/competition/"], a[href*="/sport/"], a[href]').count().catch(() => 0);
        if (lc > 0) {
          railContainer = candidate;
          console.log(`✅ [Biggest Fights] Rail container found at ${xpath} (${lc} links)`);
          break;
        }
      }

      await railContainer.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(400);
      await railContainer.hover({ force: true }).catch(() => { });

      const nextBtn = railContainer.locator([
        'button[aria-label="Next slide"]',
        'button[class*="swiper-button-next" i]',
        '[class*="next" i]:not(a)',
      ].join(', ')).first();

      let targetTile: any = null;

      // A Swiper clone can be "visible" to Playwright even though it is not the
      // card a user can select.  Filter those at the link level (the duplicate
      // class is on the slide, not on its img), rather than with an img selector.
      const isUsableTile = async (tile: any): Promise<boolean> => {
        if (!await tile.isVisible().catch(() => false)) return false;
        const href = await tile.getAttribute('href').catch(() => '');
        if (!href || href.includes('ArticleId')) return false;
        const isDuplicate = await tile.locator(
          'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " swiper-slide-duplicate ")]'
        ).count().catch(() => 0);
        return isDuplicate === 0;
      };

      const getTileMetadata = async (tile: any): Promise<string> => tile.evaluate((link: HTMLAnchorElement) => {
        const linkData = [
          link.textContent,
          link.getAttribute('aria-label'),
          link.getAttribute('title'),
        ];
        const imageData = Array.from(link.querySelectorAll('img')).flatMap((img: HTMLImageElement) => [
          img.alt,
          img.currentSrc,
          img.src,
          img.getAttribute('srcset'),
          img.getAttribute('data-src'),
        ]);
        return [...linkData, ...imageData].filter(Boolean).join(' ');
      }).catch(() => '');

      const getTileCandidates = async (): Promise<Array<{ tile: any; metadata: string }>> => {
        const candidates: Array<{ tile: any; metadata: string }> = [];
        const links = railContainer.locator('a[href]');
        const count = await links.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const tile = links.nth(i);
          if (await isUsableTile(tile)) {
            candidates.push({ tile, metadata: await getTileMetadata(tile) });
          }
        }
        return candidates;
      };

      // The cards in this rail frequently expose only a promoter name in the
      // DOM; the fighter names are rendered into the poster artwork. Resolve
      // the configured PPV name to that public Home competition/poster asset, then match
      // the asset in this rail. This deliberately does not use a PPV entitlement
      // or a secondary browser tab.
      const eventMatchIds = railsInterceptor
        ? await railsInterceptor.findHomePortraitImageIdsByTitle(partsWordLists)
        : [];

      const findTileByEventImage = async (): Promise<any> => {
        const candidates = await getTileCandidates();
        console.log(`🔎 [Biggest Fights] Match IDs to match: ${JSON.stringify(eventMatchIds)}`);
        console.log(`🔎 [Biggest Fights] Candidates in view: ${candidates.length}`);
        for (const { metadata } of candidates) {
          const preview = metadata.slice(0, 120).replace(/\n/g, ' ');
          console.log(`   📋 Tile metadata: "${preview}…"`);
        }
        for (const imageId of eventMatchIds) {
          const matches = candidates.filter(({ metadata }) =>
            metadata.toLowerCase().includes(imageId.toLowerCase())
          );
          if (matches.length === 1) {
            const href = await matches[0].tile.getAttribute('href').catch(() => '');
            console.log(`✅ [Biggest Fights] Found PPV card by its named poster image: href="${href}"`);
            return matches[0].tile;
          }
          if (matches.length > 1) {
            console.log(`⚠️ [Biggest Fights] Poster image matched ${matches.length} cards; not selecting an ambiguous card`);
          }
        }
        return null;
      };

      // Fallback for environments where the fight name is exposed in a card
      // label rather than solely in the artwork.
      const findTileInRail = async (): Promise<any> => {
        for (const { tile, metadata } of await getTileCandidates()) {
          if (matchesTileText(metadata)) {
            const href = await tile.getAttribute('href').catch(() => '');
            console.log(`✅ [Biggest Fights] Found tile by event metadata: href="${href}"`);
            return tile;
          }
        }

        // No tile found in current view — carousel loop will advance and retry
        console.log(`ℹ️ [Biggest Fights] Tile not found in current view — will try next carousel slide`);
        return null;
      };

      const findTileByUniquePromoter = async (): Promise<any> => {
        const promoter = cleanStr(eventData.PPV_PROMOTER || '');
        if (!promoter) return null;

        const matches = (await getTileCandidates()).filter(({ metadata }) =>
          cleanStr(metadata).includes(promoter)
        );
        if (matches.length === 1) {
          const href = await matches[0].tile.getAttribute('href').catch(() => '');
          console.log(`✅ [Biggest Fights] Found tile by unique promoter "${eventData.PPV_PROMOTER}": href="${href}"`);
          return matches[0].tile;
        }
        if (matches.length > 1) {
          console.log(`⚠️ [Biggest Fights] Promoter "${eventData.PPV_PROMOTER}" matched ${matches.length} cards; not selecting an ambiguous card`);
        }
        return null;
      };

      const findTileByHomeRailContentId = async (): Promise<any> => {
        const contentId = eventData.HOME_RAIL_CONTENT_ID;
        if (!contentId) return null;
        const matches = (await getTileCandidates()).filter(({ metadata }) =>
          metadata.toLowerCase().includes(contentId.toLowerCase())
        );
        if (matches.length === 1) {
          const href = await matches[0].tile.getAttribute('href').catch(() => '');
          console.log(`✅ [Biggest Fights] Found PPV tile by Home rail content ID: href="${href}"`);
          return matches[0].tile;
        }
        return null;
      };

      if (!targetTile) {
        targetTile = await findTileByEventImage() || await findTileInRail() || await findTileByUniquePromoter() || await findTileByHomeRailContentId();
        let clicks = 0;
        while (!targetTile && clicks < 15) {
          const nd = await nextBtn.evaluate((el: Element) =>
            el.classList.contains('swiper-button-disabled') || el.hasAttribute('disabled')
          ).catch(() => true);
          if (nd) { console.log('⚠️ [Biggest Fights] Carousel end reached'); break; }
          await railContainer.hover({ force: true }).catch(() => { });
          await nextBtn.click({ force: true, timeout: 3000 }).catch(() => { });
          clicks++;
          await this.page.waitForTimeout(500);
          targetTile = await findTileByEventImage() || await findTileInRail() || await findTileByUniquePromoter() || await findTileByHomeRailContentId();
        }
      }

      if (!targetTile) {
        // ── Fallback: entitlement-based tile discovery ──────────────────
        // The tile text only contains the promoter name (e.g. "PBC") and the
        // fight name is baked into the poster artwork. Try matching via the
        // PPV entitlement ID from the intercepted Rails data instead.
        const ppvEntitlements = [
          eventData.PPV_ENTITLEMENT_ID,
          eventData.HOME_RAIL_ENTITLEMENT_ID,
        ].filter(Boolean);
        if (!targetTile && railsInterceptor && ppvEntitlements.length > 0) {
          console.log(`🔎 [Biggest Fights] Image/text match failed — trying entitlement fallback: "${ppvEntitlements.join(', ')}"`);
          const entitlementMatches = railsInterceptor.findTilesByEntitlement(ppvEntitlements);
          if (entitlementMatches.length > 0) {
            const clicked = await railsInterceptor.clickFirstVisibleEntitlementTile(entitlementMatches);
            if (clicked) {
              console.log(
                `✅ [Biggest Fights] Found PPV tile via entitlement: "${clicked.tileTitle}" ` +
                `in rail "${clicked.railTitle}"`
              );
              // Skip the normal click flow below — tile was already clicked
              eventData._BIGGEST_FIGHTS_ENTITLEMENT_CLICKED = 'true';
              targetTile = 'entitlement-clicked';
            }
          }
        }
      }

      if (!targetTile) {
        throw new Error(
          `❌ [HomePage Biggest Fights] No competition tile found. ` +
          `PPV: "${ppvName}"`
        );
      }

      // ── STEP 4: Click tile → Navigate to competition page ────────────
      if (eventData._BIGGEST_FIGHTS_ENTITLEMENT_CLICKED !== 'true') {
        const tileHref = await targetTile.getAttribute('href').catch(() => '');
        console.log(`✅ [Biggest Fights] Clicking competition tile: href="${tileHref}"`);
        await targetTile.scrollIntoViewIfNeeded().catch(() => { });
        await targetTile.click({ timeout: 5000 });
        console.log('🔗 [Biggest Fights] Clicked tile, waiting for competition/sport page...');
      } else {
        console.log('🔗 [Biggest Fights] Tile already clicked via entitlement fallback, waiting for competition/sport page...');
      }

      await this.page.waitForURL(
        (url: URL) => {
          const u = url.toString();
          return u.includes('/competition/') || u.includes('/sport/') || u.includes('/event/');
        },
        { timeout: 15000 }
      );
      await this.page.waitForLoadState('domcontentloaded').catch(() => { });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      console.log(`✅ [Biggest Fights] Competition page loaded: ${this.page.url()}`);

      // ── STEP 5: Scroll to "Coming Up" section on competition page ────
      // Wait for rails content to appear (async API-loaded) instead of hard timeout

      const comingUpHeading = this.page.locator('h2, h3, h4, [class*="title" i]')
        .filter({ hasText: /coming\s*up/i }).first();

      let foundComingUp = false;
      for (let i = 0; i < 15; i++) {
        if (await comingUpHeading.isVisible().catch(() => false)) {
          foundComingUp = true;
          break;
        }
        await this.page.evaluate((pos: number) => {
          window.scrollTo({ top: pos, behavior: 'instant' });
        }, (i + 1) * 400);
        foundComingUp = await comingUpHeading.waitFor({ state: 'attached', timeout: 500 })
          .then(() => true).catch(() => false);
        if (foundComingUp) break;
      }

      if (!foundComingUp) {
        throw new Error('❌ [Competition Page] "Coming Up" section not found');
      }

      await comingUpHeading.scrollIntoViewIfNeeded().catch(() => { });
      console.log('✅ [Competition Page] "Coming Up" section found');

      // ── STEP 6: Find PPV tile in "Coming Up" rail ────────────────────
      let comingUpRail = comingUpHeading.locator('xpath=ancestor::div[contains(@class,"rail")][1]');
      let hasComingUpRail = await comingUpRail.isVisible({ timeout: 3000 }).catch(() => false);
      if (!hasComingUpRail) {
        comingUpRail = comingUpHeading.locator('xpath=ancestor::section[1]');
        hasComingUpRail = await comingUpRail.isVisible({ timeout: 2000 }).catch(() => false);
      }
      if (!hasComingUpRail) {
        comingUpRail = comingUpHeading.locator('xpath=../..');
      }

      const comingUpTiles = comingUpRail.locator('a[class*="tile" i], a, div[class*="tile" i]');
      const comingUpNext = comingUpRail.locator([
        'button[aria-label="Next slide"]',
        'button[class*="swiper-button-next"]',
        '[class*="next" i]',
      ].join(', ')).first();

      const scoreComingUpTile = (text: string): number => {
        const ct = cleanStr(text);
        const title = cleanStr(ppvName);
        if (!matchesTileText(text)) return 0;

        const hasVariantSuffix = isVariantTileText(text);
        const exactTitle = ct === title;
        const startsWithTitle = title && ct.startsWith(title);
        const titleOnlyLine = text
          .split(/\n+/)
          .map(line => line.trim())
          .some(line => cleanStr(line) === title);

        if (exactTitle || titleOnlyLine) return hasVariantSuffix ? 80 : 100;
        if (startsWithTitle) return hasVariantSuffix ? 50 : 90;
        return hasVariantSuffix ? 10 : 60;
      };

      const findComingUpTile = async (): Promise<any> => {
        let bestTile: any = null;
        let bestScore = 0;
        let bestText = '';
        const count = await comingUpTiles.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const tile = comingUpTiles.nth(i);
          if (!await tile.isVisible().catch(() => false)) continue;
          const text = (await tile.textContent().catch(() => '')) || '';
          const score = scoreComingUpTile(text);
          if (score > bestScore) {
            bestTile = tile;
            bestScore = score;
            bestText = text;
            if (score >= 100) break;
          }
        }
        if (bestTile) {
          console.log(`🔍 [Coming Up] Matched tile score=${bestScore}: "${bestText.replace(/\s+/g, ' ').trim().substring(0, 100)}"`);
        }
        return bestTile;
      };

      await comingUpRail.hover({ force: true }).catch(() => { });
      let comingUpTile = await findComingUpTile();
      let cuClicks = 0;

      while (!comingUpTile && cuClicks < 10) {
        const disabled = await comingUpNext.evaluate((el: Element) =>
          el.classList.contains('swiper-button-disabled') ||
          el.className.includes('disable') ||
          el.hasAttribute('disabled')
        ).catch(() => true);
        if (disabled) break;

        await comingUpRail.hover({ force: true }).catch(() => { });
        await comingUpNext.click({ force: true, timeout: 3000 }).catch(() => { });
        cuClicks++;
        await this.page.waitForTimeout(500);
        comingUpTile = await findComingUpTile();
      }

      if (!comingUpTile) {
        throw new Error(
          `❌ [Competition Page] PPV tile for "${ppvName}" not found in "Coming Up" section.`
        );
      }

      console.log(`✅ [Competition Page] PPV tile found in "Coming Up" after ${cuClicks} clicks`);
      return comingUpTile;
    }

    if (src === 'home-page-dazntile') {
      const railsInterceptor: RailsInterceptor | undefined =
        (eventData as any)._railsInterceptor;

      if (!railsInterceptor) {
        throw new Error(
          'home-page-dazntile requires RailsInterceptor to be started before home-page navigation'
        );
      }

      // Allow the home rails response to finish after navigation.
      await this.page.waitForTimeout(1500);

      const matches = railsInterceptor.findTilesByEntitlement([
        'base_dazn_content',
      ]);

      if (matches.length === 0) {
        railsInterceptor.printRailsSummary();
        throw new Error(
          'No DAZN tile found with entitlement base_dazn_content'
        );
      }

      // Do not assume API response order equals homepage render order.
      // Scan the rendered homepage from top to bottom and click the first
      // visible tile whose Rails payload has the required entitlement.
      let clicked = await railsInterceptor.clickFirstVisibleEntitlementTile(matches, false);

      // Transient network errors (e.g. net::ERR_NAME_NOT_RESOLVED) can cause the
      // home page to partially render, making tiles undiscoverable. Retry once
      // with a full reload before failing hard.
      if (!clicked) {
        console.warn('⚠️ [home-page-dazntile] No tile found on first attempt — reloading and retrying once.');
        await this.page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => { });
        await this.page.waitForTimeout(1500);
        clicked = await railsInterceptor.clickFirstVisibleEntitlementTile(matches, false);
      }

      if (!clicked) {
        throw new Error(
          'No rendered DAZN tile with entitlement base_dazn_content was found/clickable'
        );
      }

      console.log(
        `🎯 [HomePage] Clicked first rendered DAZN entitlement tile "${clicked.tileTitle}" ` +
        `from rail "${clicked.railTitle}"`
      );

      const subscribeCta = this.page
        .locator('#notification-layer')
        .getByRole('button', { name: /^subscribe$/i })
        .first();
      if (!await subscribeCta.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await railsInterceptor.clickLockedContentSelection();
      }

      // Store clicked tile info so it can be used in validation results
      eventData.DAZN_TILE_CLICKED = clicked.tileTitle;
      eventData.DAZN_TILE_RAIL = clicked.railTitle;

      return;
    }

    if (src === 'home-page-dont-miss') {
      console.log('🔍 [HomePage Tile] Flow: Tile + Modal popup flow');

      await this.page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return text.length > 100 && /home|sports|live|schedule|boxing/i.test(text);
      }, { timeout: 3000 }).catch(() => { });

      // 1. Scroll to section heading
      const sectionPattern = /don.t miss/i;
      let railHeader: any = null;
      let foundHeading = false;

      for (let i = 0; i < 14 && !foundHeading; i++) {
        const headingCandidates = this.page.locator('h1, h2, h3, h4, [class*="heading" i], [class*="title" i], [data-testid*="title" i]')
          .filter({ hasText: sectionPattern });
        const headingCount = await headingCandidates.count().catch(() => 0);

        for (let j = 0; j < headingCount; j++) {
          const candidate = headingCandidates.nth(j);
          if (!await candidate.isVisible().catch(() => false)) continue;

          const insideTileLink = await candidate.locator('xpath=ancestor::a[1]').count().catch(() => 0) > 0;
          if (insideTileLink) continue;

          railHeader = candidate;
          foundHeading = true;
          break;
        }

        if (foundHeading) break;

        const scrollPos = (i + 1) * 800;
        await this.page.evaluate((pos) => {
          window.scrollTo({ top: pos, behavior: 'instant' });
        }, scrollPos).catch(() => { });
        await this.page.waitForTimeout(250);
      }

      if (!foundHeading) {
        throw new Error(`❌ [HomePage Tile] "Don't Miss" rail heading not found in DOM`);
      }

      await railHeader.scrollIntoViewIfNeeded().catch(() => { });
      console.log(`✅ [HomePage Tile] Section heading is visible`);

      // 2. Locate rail wrapper
      const railWrapper = railHeader.locator('xpath=ancestor::*[contains(@class,"rail__rail-wrapper")][1] | ancestor::section[contains(@class,"rail")][1] | ancestor::div[contains(@class,"rail")][1] | ancestor::*[contains(@class,"railWrapper")][1]');
      await railWrapper.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { });
      console.log('✅ [HomePage Tile] Found rail wrapper');

      // 3. Build search parameters for tile (same as LandingPage.ts)
      const ppvName = eventData.PPV_NAME || '';
      const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
      const fighter1 = vsMatch ? vsMatch[1] : '';
      const fighter2 = vsMatch ? vsMatch[2] : '';
      console.log(`🔍 [HomePage Tile] Searching tile for event: "${ppvName}" (fighter1="${fighter1}", fighter2="${fighter2}")`);

      const cleanStr = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
      const partsWordLists = nameParts.map(part => cleanStr(part).split(/\s+/).filter(Boolean)).filter(list => list.length > 0);

      const matchesTileText = (text: string): boolean => {
        const ct = cleanStr(text);
        const matchTitle = partsWordLists.some(words => words.every(w => ct.includes(w)));
        const matchFighters = !!(fighter1 && fighter2 && ct.includes(cleanStr(fighter1)) && ct.includes(cleanStr(fighter2)));
        return matchTitle || matchFighters;
      };

      const getTileMetadata = async (tile: any): Promise<string> => {
        return await tile.evaluate((el: HTMLElement) => {
          const attrs = ['aria-label', 'title', 'href', 'data-entitlement', 'data-content-id', 'data-testid']
            .map(attr => el.getAttribute(attr) || '')
            .filter(Boolean);
          const imgs = Array.from(el.querySelectorAll('img')).flatMap((img: HTMLImageElement) => [
            img.alt,
            img.getAttribute('aria-label') || '',
            img.getAttribute('title') || '',
            img.currentSrc,
            img.src,
            img.getAttribute('srcset') || '',
            img.getAttribute('data-src') || '',
          ]);
          return [el.innerText || el.textContent || '', ...attrs, ...imgs].join(' ');
        }).catch(() => '');
      };

      const exclusions = [
        'press conference', 'weigh-in', 'pre-show', 'pre show', 'buy-in', 'buy in', 'tailgate', 'workout', 'replay', 'highlights',
        'preview', 'promo', 'interview', 'behind the scenes', 'episode',
        'documentary', 'face off'
      ];
      const exclusionSelector = exclusions.map(term => `:not([alt*="${term}" i])`).join('');

      let imgSelector = '';
      if (fighter1 && fighter2) {
        imgSelector = `img[alt*="${fighter1}" i][alt*="${fighter2}" i]${exclusionSelector}:not(.swiper-slide-duplicate img)`;
      } else if (fighter1) {
        imgSelector = `img[alt*="${fighter1}" i]${exclusionSelector}:not(.swiper-slide-duplicate img)`;
      } else {
        imgSelector = `img[alt*="${ppvName}" i]${exclusionSelector}:not(.swiper-slide-duplicate img)`;
      }

      const ppvImg = railWrapper.locator(imgSelector).first();
      const ppvTileLink = ppvImg.locator('xpath=ancestor::a[1]');


      const isTileInView = async (): Promise<any> => {
        // First check candidates by text
        const tileCandidates = railWrapper.locator('a[class*="tile__link" i], a[class*="tile" i], div[class*="tile" i], div[class*="card" i], a, button');
        const candidateCount = await tileCandidates.count().catch(() => 0);

        let bestTile: any = null;
        let bestScore = 0;

        for (let i = 0; i < candidateCount; i++) {
          const tile = tileCandidates.nth(i);
          if (await tile.isVisible().catch(() => false)) {
            const metadata = await getTileMetadata(tile);
            if (metadata && matchesTileText(metadata)) {
              const inView = await tile.evaluate((el: HTMLElement) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
              }).catch(() => false);
              if (inView) {
                const score = this.scorePPVMatch(metadata, ppvName);
                if (score > bestScore) {
                  bestScore = score;
                  bestTile = tile;
                }
              }
            }
          }
        }

        if (bestTile) {
          const tileText = await bestTile.textContent().catch(() => '');
          console.log(`✅ [HomePage Tile] Best matching tile (score=${bestScore}): "${(tileText || '').trim().replace(/\s+/g, ' ').substring(0, 80)}"`);
          return bestTile;
        }

        // Fallback to image alt matching
        for (let retry = 0; retry < 2; retry++) {
          const imgCount = await ppvImg.count().catch(() => 0);
          if (imgCount === 0) {
            if (retry === 0) {
              await this.page.waitForTimeout(100);
              continue;
            }
            break;
          }
          const inView = await ppvImg.evaluate((el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
          }).catch(() => false);
          if (inView) {
            return ppvTileLink;
          }
        }
        return null;
      };

      const nextBtn = railWrapper.locator([
        'button[aria-label="Next slide"]',
        'button[class*="swiper-button-next"]',
        '.custom-swiper-button-next',
        '[class*="next" i]',
      ].join(', ')).first();

      await railWrapper.hover({ force: true }).catch(() => { });
      await this.page.waitForTimeout(100);

      let clicks = 0;
      const maxClicks = 30;
      let found = await isTileInView();

      while (!found && clicks < maxClicks) {
        if (this.page.isClosed()) throw new Error('Page closed during swiper navigation');

        const nextDisabled = await nextBtn.evaluate((el: Element) => {
          return el.classList.contains('swiper-button-disabled') ||
            el.classList.contains('rail-module__disable') ||
            el.className.includes('disable') ||
            el.hasAttribute('disabled');
        }).catch(() => false);

        if (nextDisabled) {
          console.log('⚠️ [HomePage Tile] Next button disabled — end of rail reached');
          break;
        }

        let nextCount = await nextBtn.count().catch(() => 0);
        if (nextCount === 0) {
          await this.page.waitForTimeout(100);
          nextCount = await nextBtn.count().catch(() => 0);
          if (nextCount === 0) {
            console.log('⚠️ [HomePage Tile] Next button not found in DOM after retry');
            break;
          }
        }

        await nextBtn.click({ timeout: 5000, force: true }).catch((e: any) => {
          console.log('⚠️ Next click error:', e.message);
        });
        clicks++;

        await this.page.waitForTimeout(250);
        found = await isTileInView();
      }

      console.log(`✅ [HomePage Tile] Swiper "Next" clicks performed: ${clicks}`);

      if (!found && (await ppvImg.count()) > 0) {
        console.log('🔍 [HomePage Tile] Tile in DOM but not visible — scrolling into view');
        await ppvImg.scrollIntoViewIfNeeded().catch(() => { });
        await this.page.waitForTimeout(150);
        found = await isTileInView();
      }

      if (!found) {
        const dump = await railWrapper.evaluate((el: HTMLElement) => {
          const imgs = Array.from(el.querySelectorAll('img')).slice(0, 20).map((img: HTMLImageElement) => ({
            alt: img.alt,
            src: img.src?.substring(0, 80),
            w: img.width,
            h: img.height,
          }));
          return {
            nextDisabled: el.querySelector('button[aria-label="Next slide"]')?.classList.contains('swiper-button-disabled'),
            imgs,
          };
        }).catch(() => null);

        console.log('=== RAIL DEBUG ===');
        console.log('Next disabled:', dump?.nextDisabled);
        console.log('Images:', JSON.stringify(dump?.imgs, null, 2));
        throw new Error(`❌ [HomePage Tile] Could not find "${fighter1 || ppvName}" tile in "Don't Miss" rail after ${clicks} clicks`);
      }

      const sectionHeadingText = ((await railHeader.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const tileImageLoaded = await hasLoadedPPVArtwork(found, ppvName);
      const tileCapture = await found.evaluate((el: HTMLElement, expectedTitle: string) => {
        const clean = (value: string | null | undefined) =>
          String(value ?? '').replace(/\s+/g, ' ').trim();
        // DAZN appends collection metadata such as "- List:qb3p..." to a
        // tile's accessible label. It is not part of the event title.
        const cleanTileLabel = (value: string | null | undefined) =>
          clean(value).replace(/\s*[-–—]?\s*list\s*:\s*[^\s]+.*$/i, '').trim();
        const text = clean(el.innerText || el.textContent);
        const imgTexts = Array.from(el.querySelectorAll('img'))
          .map((img: HTMLImageElement) => clean(img.alt || img.getAttribute('aria-label') || img.getAttribute('title')))
          .filter(Boolean);
        const combined = clean(`${text} ${imgTexts.join(' ')} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`);
        const titleWords = expectedTitle.toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .split(/\s+/)
          .filter(word => word.length > 2);
        const titleCandidates = [
          ...Array.from(el.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [class*="title" i], [class*="heading" i], [aria-label], [title]'))
            .map(node => cleanTileLabel(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'))),
          ...imgTexts.map(cleanTileLabel),
          cleanTileLabel(el.getAttribute('aria-label')),
          cleanTileLabel(el.getAttribute('title')),
        ].filter(candidate => {
          const lower = candidate.toLowerCase();
          return candidate.length > 2 && candidate.length < 120 &&
            titleWords.length > 0 && titleWords.every(word => lower.includes(word));
        });
        const title = titleCandidates.sort((a, b) => a.length - b.length)[0] || '';
        const hasImage = Array.from(el.querySelectorAll<HTMLElement>('img, picture, [role="img"], div, span, a')).some(node => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          const hasBackground = !!style.backgroundImage && style.backgroundImage !== 'none';
          return node.tagName.toLowerCase() === 'img' ||
            node.tagName.toLowerCase() === 'picture' ||
            node.getAttribute('role') === 'img' ||
            (hasBackground && rect.width >= 80 && rect.height >= 45);
        });
        const dateMatch =
          combined.match(/\b\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|January|February|March|April|May|June|July|August|September|October|November|December)\b/i) ||
          combined.match(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i);
        return {
          text: combined,
          title,
          dateText: dateMatch ? dateMatch[0] : '',
          hasImage,
        };
      }, ppvName).catch(() => ({ text: '', title: '', dateText: '', hasImage: false }));

      eventData.__HOME_DONT_MISS_SECTION_HEADING = sectionHeadingText || 'Don\'t Miss';
      eventData.__HOME_DONT_MISS_TILE_FOUND = 'Yes';
      eventData.__HOME_DONT_MISS_TILE_TEXT = tileCapture.text || '';
      eventData.__HOME_DONT_MISS_TILE_TITLE = tileCapture.title || '';
      eventData.__HOME_DONT_MISS_TILE_DATE = tileCapture.dateText || eventData.LANDING_PAGE_PPV_DATE || '';
      eventData.__HOME_DONT_MISS_IMAGE_PRESENT = tileImageLoaded ? 'Yes' : 'No';
      console.log(
        `[HomePage Tile] Pre-captured Don't Miss validation data: ` +
        `section="${eventData.__HOME_DONT_MISS_SECTION_HEADING}", title="${eventData.__HOME_DONT_MISS_TILE_TITLE}", ` +
        `date="${eventData.__HOME_DONT_MISS_TILE_DATE}", ` +
        `image="${eventData.__HOME_DONT_MISS_IMAGE_PRESENT}"`
      );

      if (eventData.__RETURN_TILE_BEFORE_POPUP === 'true') {
        return found;
      }

      console.log(`📌 [HomePage Tile] Found PPV tile, clicking to open modal...`);
      await found.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(150);

      const beforeUrl = this.page.url();
      const clickTarget = found.locator(
        'xpath=ancestor-or-self::*[self::a or self::button or @role="button"][1]'
      ).first();
      const target = await clickTarget.isVisible({ timeout: 500 }).catch(() => false)
        ? clickTarget
        : found;
      try {
        await target.click({ force: true, timeout: 10000 });
        console.log(`✅ [HomePage Tile] Clicked PPV tile`);
      } catch (e: any) {
        console.log('⚠️ Standard click failed → trying JS click');
        const handle = await target.elementHandle();
        if (handle) {
          await this.page.evaluate((el: any) => el.click(), handle);
          console.log(`✅ [HomePage Tile] JS click executed on PPV tile`);
        } else {
          throw new Error('❌ PPV tile click failed: ' + e.message);
        }
      }

      let modal: any = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (this.page.url() !== beforeUrl) {
          console.log(`✅ [HomePage Tile] Tile click navigated to: ${this.page.url()}`);
          return this.page.locator('body');
        }
        modal = await this.waitForModal();
        if (modal) {
          break;
        }
        await this.page.waitForTimeout(200);
      }

      if (!modal) {
        throw new Error('❌ [HomePage Tile] Modal popup did not appear after clicking tile');
      }

      console.log(`✅ [HomePage Tile] Modal popup found`);
      return modal;
    }

    // For home-page-get-started: locate the "Get Started" CTA on the welcome/home page
    if (src === 'home-page-get-started') {
      console.log('🔍 [HomePage] Finding "Get Started" CTA (preferring header)...');

      // Look in header first to trigger default signup flow without event context
      let getStartedBtn = this.page.locator([
        'header a:has-text("Get started")',
        'header button:has-text("Get started")',
        'header a:has-text("Sign up")',
        'header button:has-text("Sign up")',
        'header a:has-text("Sign up now")',
        'header button:has-text("Sign up now")',
        '[class*="header" i] a:has-text("Get started")',
        '[class*="header" i] button:has-text("Get started")',
        '[class*="header" i] a:has-text("Sign up")',
        '[class*="header" i] button:has-text("Sign up")',
        '[class*="header" i] a:has-text("Sign up now")',
        '[class*="header" i] button:has-text("Sign up now")'
      ].join(', ')).first();

      let found = await getStartedBtn.waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (found) {
        console.log('✅ [HomePage] Found "Get Started" CTA in header');
        return getStartedBtn;
      }

      console.log('⚠️ [HomePage] Header "Get Started" CTA not visible — trying page-wide search');
      getStartedBtn = this.page.locator([
        'button:has-text("Get started ")', 'a:has-text("Get started")',
        'button:has-text("Get started")', 'a:has-text("Get started")',
        'button:has-text("Sign up")', 'a:has-text("Sign up")',
        'button:has-text("Sign up now")', 'a:has-text("Sign up now")'
      ].join(', ')).first();

      found = await getStartedBtn.waitFor({ state: 'visible', timeout: 12000 })
        .then(() => true)
        .catch(() => false);

      if (!found) {
        // Scroll down to find it if not immediately visible
        for (let i = 1; i <= 5; i++) {
          await this.page.evaluate((pos: number) => {
            window.scrollTo({ top: pos, behavior: 'instant' });
          }, i * 600).catch(() => { });
          const visible = await getStartedBtn.isVisible().catch(() => false);
          if (visible) break;
        }
      }

      if (!(await getStartedBtn.isVisible().catch(() => false))) {
        throw new Error('❌ [HomePage] "Get Started" CTA not found on welcome/home page');
      }

      console.log('✅ [HomePage] "Get Started" CTA found');
      return getStartedBtn;
    }

    // For home-page-subscribe: locate the "Subscribe" CTA in the header nav (freemium logged-in users)
    if (src === 'home-page-subscribe') {
      console.log('🔍 [HomePage] Finding "Subscribe" CTA in header nav...');

      const subscribeBtn = this.page.locator([
        'header a:has-text("Subscribe")',
        'header button:has-text("Subscribe")',
        '[class*="header-nav"] a:has-text("Subscribe")',
        '[class*="header-nav"] button:has-text("Subscribe")',
        'a[class*="upgrade-btn"]:has-text("Subscribe")',
        'a[class*="upgrade_btn"]:has-text("Subscribe")',
        '[class*="header" i] a:has-text("Subscribe")',
        '[class*="header" i] button:has-text("Subscribe")',
      ].join(', ')).first();

      const found = await subscribeBtn.waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false);

      if (!found) {
        throw new Error('❌ [HomePage] "Subscribe" CTA not found in header nav. Ensure user is logged in as freemium.');
      }

      console.log('✅ [HomePage] "Subscribe" CTA found in header nav');
      return subscribeBtn;
    }

    console.warn(`⚠️ Unknown source "${source || 'unknown'}" for HomePage. Valid sources: home-page-banner, home-page-dont-miss, home-page-get-started, home-page-subscribe, home-biggest-fights.`);
    return null;
  }

  private async waitForModal(): Promise<any> {
    // ── Priority 1: DAZN-specific notification layer (PPV popup lives here) ──
    // The actual PPV "Buy now" popup is always rendered inside #notification-layer
    // with class signup-paywall__modal. Target it directly to avoid accidentally
    // matching layout wrappers that also carry "modal" in their class names.
    const daznPopupSelectors = [
      '#notification-layer [class*="signup-paywall"]',
      '#notification-layer [class*="modal"]',
      '#notification-layer [role="dialog"]',
      '#notification-layer',
    ];

    for (const selector of daznPopupSelectors) {
      const el = this.page.locator(selector).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        const hasBuyNow = await el
          .locator('button:has-text("Buy now"), a:has-text("Buy now"), button:has-text("Buy Now")')
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);
        if (hasBuyNow) {
          console.log(`✅ [waitForModal] PPV popup found in DAZN notification layer via: ${selector}`);
          return el;
        }
      }
    }

    // ── Priority 2: Standard ARIA modal/dialog — filtered to contain Buy now ──
    const strictModalSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="signup-paywall" i]',
      '[class*="paywall" i]',
    ];

    for (const selector of strictModalSelectors) {
      try {
        const modal = this.page
          .locator(selector)
          .filter({ has: this.page.locator('button:has-text("Buy now"), a:has-text("Buy now"), button:has-text("Buy Now")') })
          .first();
        if (await modal.isVisible({ timeout: 300 }).catch(() => false)) {
          console.log(`✅ [waitForModal] Strict modal found via: ${selector}`);
          return modal;
        }
      } catch { /* selector not found */ }
    }

    // ── Priority 3: Generic modal selectors — filtered to contain Buy now ──
    // Deliberately excluded: [class*="modal" i] without filter — too broad at wide viewports.
    const genericSelectors = [
      '[class*="modal" i]',
      '[class*="popup" i]',
      '[class*="Dialog" i]',
      '.Modal',
    ];

    for (const selector of genericSelectors) {
      try {
        const modal = this.page
          .locator(selector)
          .filter({ has: this.page.locator('button:has-text("Buy now"), a:has-text("Buy now"), button:has-text("Buy Now")') })
          .first();
        if (await modal.isVisible({ timeout: 300 }).catch(() => false)) {
          console.log(`✅ [waitForModal] Generic modal found via: ${selector} (contains Buy now)`);
          return modal;
        }
      } catch { /* selector not found */ }
    }

    return null;
  }

  // Click Buy Now logic:
  // For home-page-banner: uses LandingPage clickBuyNow (direct banner navigation)
  // For home-page-dont-miss: clicks Buy Now inside the modal popup
  override async clickBuyNow(container: any, source?: string): Promise<void> {
    const src = (source || '').toLowerCase();

    if (src === 'home-page-banner') {
      await super.clickBuyNow(container, 'banner');
      return;
    }

    if (src === 'home-page-get-started') {
      console.log('🖱️ [HomePage] Clicking "Get Started" CTA...');
      if (!container) {
        throw new Error('❌ [HomePage] Get Started container is null');
      }
      const beforeUrl = this.page.url();
      await container.scrollIntoViewIfNeeded().catch(() => { });
      await container.click({ force: true, timeout: 10000 });
      let navigated = await this.page.waitForFunction((url) => {
        const href = window.location.href;
        const body = document.body?.innerText?.toLowerCase() || '';
        return href !== url ||
          href.toLowerCase().includes('signup') ||
          href.toLowerCase().includes('plandetails') ||
          href.toLowerCase().includes('tierplans') ||
          body.includes('choose a plan') ||
          body.includes('create an account');
      }, beforeUrl, { timeout: 5000 }).then(() => true).catch(() => false);

      if (!navigated) {
        console.log('⚠️ [HomePage] Get Started CTA click did not navigate; retrying with DOM click.');
        await container.evaluate((el: HTMLElement) => el.click()).catch(() => { });
        navigated = await this.page.waitForFunction((url) => window.location.href !== url, beforeUrl, { timeout: 3000 })
          .then(() => true)
          .catch(() => false);
      }

      if (!navigated) {
        const href = await container.evaluate((el: HTMLElement) => {
          const link = el.closest('a') as HTMLAnchorElement | null;
          return link?.href || '';
        }).catch(() => '');
        if (href) {
          console.log(`🧭 [HomePage] Navigating via Get Started href fallback: ${href}`);
          await this.page.goto(href, { waitUntil: 'domcontentloaded' });
        }
      }

      console.log('✅ [HomePage] Clicked "Get Started" CTA');
      return;
    }

    if (src === 'home-page-subscribe') {
      console.log('🖱️ [HomePage] Clicking "Subscribe" CTA...');
      if (!container) {
        throw new Error('❌ [HomePage] Subscribe container is null');
      }
      const beforeUrl = this.page.url();
      await container.scrollIntoViewIfNeeded().catch(() => { });
      await container.click({ force: true, timeout: 10000 });
      let navigated = await this.page.waitForFunction((url) => {
        const href = window.location.href;
        const body = document.body?.innerText?.toLowerCase() || '';
        return href !== url ||
          href.toLowerCase().includes('signup') ||
          href.toLowerCase().includes('plandetails') ||
          href.toLowerCase().includes('tierplans') ||
          body.includes('choose a plan') ||
          body.includes('subscribe without a pay-per-view');
      }, beforeUrl, { timeout: 5000 }).then(() => true).catch(() => false);

      if (!navigated) {
        console.log('⚠️ [HomePage] Subscribe CTA click did not navigate; retrying with DOM click.');
        await container.evaluate((el: HTMLElement) => el.click()).catch(() => { });
        navigated = await this.page.waitForFunction((url) => window.location.href !== url, beforeUrl, { timeout: 3000 })
          .then(() => true)
          .catch(() => false);
      }

      if (!navigated) {
        const href = await container.evaluate((el: HTMLElement) => {
          const link = el.closest('a') as HTMLAnchorElement | null;
          return link?.href || '';
        }).catch(() => '');
        if (href) {
          console.log(`🧭 [HomePage] Navigating via Subscribe href fallback: ${href}`);
          await this.page.goto(href, { waitUntil: 'domcontentloaded' });
        }
      }

      console.log('✅ [HomePage] Clicked "Subscribe" CTA');
      return;
    }

    if (src === 'home-biggest-fights') {
      console.log('💳 [Biggest Fights] Clicking PPV tile on Competition page → Popup');

      if (!container) {
        throw new Error('❌ [Biggest Fights] Coming Up tile container is null');
      }

      // Click the tile in "Coming Up" rail → popup modal appears
      await container.scrollIntoViewIfNeeded().catch(() => { });
      await container.click({ timeout: 5000 });
      console.log('✅ [Biggest Fights] Clicked Coming Up tile, waiting for popup modal...');

      // Wait for popup modal to appear — then return so handlePopupModal can validate + click Buy Now
      const modalSelectors = [
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="modal" i]',
        '[class*="popup" i]',
        '[class*="Dialog" i]',
      ];

      for (const selector of modalSelectors) {
        const modalLocator = this.page.locator(selector).first();
        const appeared = await modalLocator.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (appeared) {
          console.log('✅ [Biggest Fights] Popup modal appeared — handing off to popup handler for validation + Buy Now click');
          return;
        }
      }

      console.log('⚠️ [Biggest Fights] Popup modal not detected — handlePopupModal will attempt to find it');
      return;
    }

    if (src === 'home-page-dont-miss') {
      console.log('💳 [HomePage Tile] Clicking "Buy now" in modal popup...');

      if (!container) {
        throw new Error('❌ [HomePage Tile] Modal container is null');
      }

      // ── Step 1: Resolve the Buy Now button ──────────────────────────────────
      // The real PPV popup lives in #notification-layer > signup-paywall__modal.
      // The `container` from waitForModal() may be a broad layout wrapper rather
      // than the popup itself, so we always prefer the page-scoped notification
      // layer selectors and only fall back to container-scoped search.
      const buyNowSelector = [
        'button:has-text("Buy now")',
        'a:has-text("Buy now")',
        'button:has-text("Buy Now")',
        'a:has-text("Buy Now")',
      ].join(', ');

      // Candidate 1: inside DAZN notification layer (most reliable)
      const notifLayerBtn = this.page.locator(
        `#notification-layer ${buyNowSelector.split(', ').join(', #notification-layer ')}`
      ).first();

      // Candidate 2: inside signup-paywall class (DAZN-specific PPV modal)
      const paywallBtn = this.page.locator(
        `[class*="signup-paywall"] button:has-text("Buy now"), ` +
        `[class*="signup-paywall"] a:has-text("Buy now"), ` +
        `[class*="signup-paywall"] button:has-text("Buy Now")`
      ).first();

      // Candidate 3: inside the container returned by waitForModal()
      const containerBtn = container.locator(buyNowSelector).first();

      let buyNowBtn: any = null;
      let btnSource = '';

      if (await notifLayerBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        buyNowBtn = notifLayerBtn;
        btnSource = '#notification-layer';
      } else if (await paywallBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        buyNowBtn = paywallBtn;
        btnSource = '[class*="signup-paywall"]';
      } else if (await containerBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        // Verify it is actually inside a popup overlay (not the header nav)
        const isInOverlay = await containerBtn.evaluate((el: HTMLElement) => {
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 15 && cur; i++) {
            const id = cur.id || '';
            const cls = (cur.className || '').toLowerCase();
            if (id === 'notification-layer' || cls.includes('paywall') || cls.includes('overlay')) {
              return true;
            }
            cur = cur.parentElement;
          }
          return false;
        }).catch(() => false);
        if (isInOverlay) {
          buyNowBtn = containerBtn;
          btnSource = 'container (verified in overlay)';
        }
      }

      if (!buyNowBtn) {
        throw new Error(
          '❌ [HomePage Tile] Buy now button not found inside PPV popup modal. ' +
          'Checked: #notification-layer, [class*="signup-paywall"], container. ' +
          'Will NOT click page-wide to avoid hitting wrong element.'
        );
      }

      console.log(`🖱️ [HomePage Tile] Buy now button resolved via: ${btnSource}`);

      // ── Step 2: Click the button ─────────────────────────────────────────────
      try {
        await buyNowBtn.click({ timeout: 5000 });
        console.log('✅ [HomePage Tile] Clicked Buy now via standard click');
        return;
      } catch (clickErr: any) {
        console.log(`⚠️ [HomePage Tile] Standard click failed: ${clickErr.message} — trying JS click`);
        const handle = await buyNowBtn.elementHandle().catch(() => null);
        if (handle) {
          await this.page.evaluate((el: any) => el.click(), handle);
          console.log('✅ [HomePage Tile] JS click on Buy now executed');
          return;
        }
        try {
          await buyNowBtn.click({ force: true, timeout: 5000 });
          console.log('✅ [HomePage Tile] Clicked Buy now via force click');
          return;
        } catch (forceErr: any) {
          throw new Error('❌ [HomePage Tile] Buy now button click failed: ' + forceErr.message);
        }
      }
    }

    await super.clickBuyNow(container, source);
  }

  // --- EXISTING METHODS PRESERVED FOR BACKWARD COMPATIBILITY ---

  async navigateToMyAccount(): Promise<void> {
    console.log('👤 Navigating to My Account...');

    // ── Wait for page to be fully loaded ─────────────────────
    await this.page.waitForLoadState('domcontentloaded');

    // Avoid clicking volatile header controls after sign-in. The profile menu
    // can shift by region/session and may open All Sports instead of Account.
    await this.page.keyboard.press('Escape').catch(() => { });
    await this.navigateDirectly();
  }

  protected getFallbackBaseUrl(): string {
    const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
    let region = (process.env.DAZN_REGION || 'GB').toUpperCase();
    if (region === 'UAE') region = 'AE';
    let domain = 'stag.dazn.com';
    if (env === 'beta') domain = 'beta.dazn.com';
    if (env === 'prod') domain = 'www.dazn.com';
    return `https://${domain}/en-${region}`;
  }

  private async navigateDirectly(): Promise<void> {
    const currentUrl = this.page.url();
    const baseUrlMatch = currentUrl.match(/(https:\/\/[a-z0-9.-]*dazn\.com\/en-[A-Z]+)/i);
    const cleanBase = baseUrlMatch?.[1]
      || this.baseUrl
      || this.getFallbackBaseUrl();

    console.log(`🔗 Direct navigation to: ${cleanBase}/myaccount`);
    await this.page.goto(`${cleanBase}/myaccount`, {
      waitUntil: 'domcontentloaded',
    });
    await this.page.waitForURL(
      url => {
        const u = url.toString().toLowerCase();
        return (
          u.includes('/myaccount') ||
          (u.includes('/account') &&
            !u.includes('/signup') &&
            !u.includes('/signin') &&
            !u.includes('/personaldetails') &&
            !u.includes('/emaildetails') &&
            !u.includes('/content/'))
        );
      },
      { timeout: 15000 }
    ).catch(() => { });
    await this.page.waitForLoadState('domcontentloaded').catch(() => { });
    console.log(`✅ On My Account: ${this.page.url()}`);
  }

  async dismissPopup(): Promise<void> {
    console.log('🔍 Checking for popups...');
    try {
      const dismissSelectors =
        'button:has-text("Keep me updated"), ' +
        'button:has-text("Keep Me Updated"), ' +
        'button:has-text("Maybe later"), ' +
        'button:has-text("Maybe Later"), ' +
        'button:has-text("No thanks"), ' +
        'button:has-text("No Thanks"), ' +
        'button:has-text("Not now"), ' +
        'button:has-text("Not Now"), ' +
        'button:has-text("Close"), ' +
        'button:has-text("Dismiss"), ' +
        'button:has-text("Skip"), ' +
        'button:has-text("Got it"), ' +
        'button:has-text("Got It"), ' +
        'button:has-text("OK"), ' +
        'button:has-text("Cancel"), ' +
        'button:has-text("Done"), ' +
        'button:has-text("Use web version"), ' +
        'button:has-text("Not interested"), ' +
        'button:has-text("Remind me later"), ' +
        'button:has-text("No, thanks"), ' +
        '[aria-label="Close"], ' +
        '[aria-label="close"], ' +
        '[aria-label*="close" i], ' +
        '[aria-label*="dismiss" i], ' +
        '[data-testid*="close" i], ' +
        '[data-testid*="dismiss" i], ' +
        '[role="dialog"] button[class*="close" i], ' +
        '[role="dialog"] button[aria-label*="close" i], ' +
        'button[class*="close" i]:not(input), ' +
        'button[class*="dismiss" i]:not(input)';

      for (let attempt = 0; attempt < 3; attempt++) {
        const popup = this.page.locator(dismissSelectors).first();

        if (await popup.isVisible({ timeout: attempt === 0 ? 2000 : 1000 }).catch(() => false)) {
          const btnText = await popup.textContent().catch(() => '');
          await popup.click({ force: true });
          await this.page.waitForTimeout(200);
          console.log(`✅ Dismissed popup (attempt ${attempt + 1}): "${btnText?.trim()}"`);
          continue;
        }
        break;
      }

      const modal = this.page.locator(
        '[role="dialog"]:not([aria-hidden="true"]), ' +
        '[role="alertdialog"], ' +
        '[class*="modal" i]:not([aria-hidden="true"]), ' +
        '[class*="overlay" i]:not([aria-hidden="true"]), ' +
        '[class*="popup" i]:not([aria-hidden="true"]), ' +
        '[class*="drawer" i]:not([aria-hidden="true"])'
      ).first();

      if (await modal.isVisible({ timeout: 1000 }).catch(() => false)) {
        const closeBtn = modal.locator(
          'button[aria-label*="close" i], ' +
          'button[class*="close" i], ' +
          '[data-testid*="close" i]'
        ).first();

        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await closeBtn.click({ force: true });
          await this.page.waitForTimeout(200);
          console.log('✅ Dismissed modal via close button');
          return;
        }

        const modalBtn = modal.locator('button').last();
        if (await modalBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          const btnText = await modalBtn.textContent().catch(() => '');
          const dangerous = /confirm|subscribe|buy|pay|upgrade|continue with dazn/i;
          if (!dangerous.test(btnText || '')) {
            await modalBtn.click({ force: true });
            await this.page.waitForTimeout(200);
            console.log(`✅ Dismissed modal via last button: "${btnText?.trim()}"`);
            return;
          }
        }

        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(200);
        console.log('✅ Dismissed modal via Escape');
        return;
      }

      console.log('ℹ️  No popup found');
    } catch {
      console.log('ℹ️  No popup found');
    }
  }

  // ─────────────────────────────
  // SPORTS DROPDOWN TRIGGER HELPERS
  // ─────────────────────────────
  protected async clickAllSportsDropdown(): Promise<boolean> {
    console.log('🔍 Looking for "All Sports" or "Sports" dropdown menu trigger...');
    const triggers = [
      { label: 'button role: All sports', locator: this.page.getByRole('button', { name: /^All sports$/i }) },
      { label: 'link role: All sports', locator: this.page.getByRole('link', { name: /^All sports$/i }) },
      { label: 'button role: Sports', locator: this.page.getByRole('button', { name: /^Sports$/i }) },
      { label: 'link role: Sports', locator: this.page.getByRole('link', { name: /^Sports$/i }) },
      { label: 'button text: All sports', locator: this.page.locator('button').filter({ hasText: /^All sports$/i }) },
      { label: 'anchor text: All sports', locator: this.page.locator('a').filter({ hasText: /^All sports$/i }) },
      { label: 'button aria-label sports', locator: this.page.locator('button[aria-label*="sports" i]') },
      { label: 'anchor aria-label sports', locator: this.page.locator('a[aria-label*="sports" i]') },
    ];

    for (const trigger of triggers) {
      const locator = trigger.locator;
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          const triggerText = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          const ariaLabel = await el.getAttribute('aria-label').catch(() => '');
          const textLooksRight = /^all sports$/i.test(triggerText) || /^sports$/i.test(triggerText) || /sports/i.test(ariaLabel || '');
          if (!textLooksRight) {
            console.log(`⏭️ Skipping dropdown candidate "${trigger.label}" because text/label is "${triggerText || ariaLabel || 'empty'}"`);
            continue;
          }

          console.log(`🎯 Clicking Sports dropdown trigger: "${trigger.label}" (${triggerText || ariaLabel})`);
          await el.scrollIntoViewIfNeeded().catch(() => { });
          await el.click({ force: true });

          // Wait up to 3 seconds for a dropdown container to appear
          const containerSelectors = ['[role="menu"]', '[role="listbox"]', '[class*="dropdown" i]', '[class*="menu" i]'];
          for (const cSel of containerSelectors) {
            const menu = this.page.locator(cSel).filter({ hasText: /Boxing|Football|Basketball|MMA|All sports/i }).first();
            const menuVisible = await menu.waitFor({ state: 'visible', timeout: 1000 }).then(() => true).catch(() => false);
            if (menuVisible) {
              console.log(`✅ Sports dropdown menu visible: "${cSel}"`);
              return true;
            }
          }
          await this.page.waitForTimeout(500); // Fallback wait
          return true;
        }
      }
    }
    console.log('⚠️ Could not click Sports dropdown trigger.');
    return false;
  }

  protected async selectSportFromDropdown(sportName: string): Promise<boolean> {
    console.log(`🔍 Selecting sport "${sportName}" from dropdown list...`);

    // Define potential dropdown container selectors to restrict search scope
    const containers = [
      '[role="menu"]',
      '[role="listbox"]',
      '[class*="dropdown" i]',
      '[class*="menu" i]',
      '[class*="sports" i]',
      'div' // generic fallback
    ];

    let activeContainer = this.page.locator('body');
    for (const cSelector of containers) {
      const locator = this.page.locator(cSelector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const c = locator.nth(i);
        if (await c.isVisible().catch(() => false)) {
          const hasOption = await c.locator(`a:has-text("${sportName}"), button:has-text("${sportName}"), li:has-text("${sportName}"), span:has-text("${sportName}")`).first().isVisible().catch(() => false);
          if (hasOption) {
            const box = await c.boundingBox().catch(() => null);
            // Increased max width to 1000 to accommodate multi-column sports mega-menus
            if (box && box.width > 0 && box.width < 1000) {
              activeContainer = c;
              console.log(`✅ Scoping sport search to active dropdown container: "${cSelector}" (width: ${Math.round(box.width)})`);
              break;
            }
          }
        }
      }
      if (activeContainer !== this.page.locator('body')) break;
    }

    // Helper: check if element's own text matches exactly (not a parent with extra text)
    const isExactTextMatch = async (el: any, name: string): Promise<boolean> => {
      const ownText = await el.evaluate((node: HTMLElement) => {
        // Get only the direct text content of this element (not descendants)
        let text = '';
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent || '';
          }
        }
        // If no direct text, use innerText (for elements like <button><span>Boxing</span></button>)
        return text.trim() || node.innerText?.trim() || '';
      }).catch(() => '');
      return ownText.toLowerCase() === name.toLowerCase();
    };

    // ── Strategy 1: Exact text match via getByText ───────────────
    // This uses Playwright's built-in exact matching
    const exactSelectors = [
      activeContainer.getByRole('link', { name: sportName, exact: true }),
      activeContainer.getByRole('button', { name: sportName, exact: true }),
      activeContainer.getByRole('menuitem', { name: sportName, exact: true }),
    ];

    for (const locator of exactSelectors) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (await el.isVisible().catch(() => false)) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            console.log(`🎯 Clicking sport link (exact match): "${sportName}" inside container`);
            await el.scrollIntoViewIfNeeded().catch(() => { });
            const beforeUrl = this.page.url();
            await el.click({ force: true });

            const navigated = await this.page.waitForURL(
              (url: URL) => url.toString() !== beforeUrl,
              { timeout: 8000 }
            ).then(() => true).catch(() => false);

            if (navigated) {
              return true;
            } else {
              console.log(`⚠️ Clicked sport link (exact) but URL did not change from "${beforeUrl}"`);
            }
          }
        }
      }
    }

    // ── Strategy 2: has-text selectors with exact text verification ──
    const selectors = [
      `button:has-text("${sportName}")`,
      `button span:has-text("${sportName}")`,
      `a:has-text("${sportName}")`,
      `a[href*="sport"]:has-text("${sportName}")`,
      `a[href*="competition"]:has-text("${sportName}")`,
      `[role="menuitem"]:has-text("${sportName}")`,
      `li:has-text("${sportName}")`,
      `div:has-text("${sportName}")`
    ];

    for (const selector of selectors) {
      const locator = activeContainer.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (await el.isVisible().catch(() => false)) {
          // Verify the element's own text is an exact match (not "Misfits Boxing" for "Boxing")
          const exact = await isExactTextMatch(el, sportName);
          if (!exact) {
            const elText = await el.innerText().catch(() => '');
            console.log(`⏭️ Skipping "${elText.trim()}" — not exact match for "${sportName}"`);
            continue;
          }
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            console.log(`🎯 Clicking sport link: "${selector}" inside container`);
            await el.scrollIntoViewIfNeeded().catch(() => { });
            const beforeUrl = this.page.url();
            await el.click({ force: true });

            const navigated = await this.page.waitForURL(
              (url: URL) => url.toString() !== beforeUrl,
              { timeout: 8000 }
            ).then(() => true).catch(() => false);

            if (navigated) {
              return true;
            } else {
              console.log(`⚠️ Clicked sport link "${selector}" but URL did not change from "${beforeUrl}"`);
            }
          }
        }
      }
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // WAIT FOR HOME PAGE POPUP — 3-attempt popup detection + validate + Buy Now
  // Called after the user has authenticated and is ready to land on /home.
  // Handles: navigate to home → poll → refresh+poll → logout+re-login+poll
  //          → validate popup fields → click Buy Now → wait for navigation
  // ─────────────────────────────────────────────────────────────
  async waitForHomePagePopup(
    credentials: { email: string; password: string },
    baseUrl: string,
    results: any[],
    eventData: any
  ): Promise<void> {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║  HOME PAGE POPUP — Detecting popup on home page       ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');

    // ── Navigate to home page (skip if already there — the popup appears on login redirect) ──
    const currentUrl = this.page.url();
    if (currentUrl.includes('/home')) {
      console.log('🏠 [Home Page Popup] Already on home page — waiting for page to settle...');
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
    } else {
      console.log('🏠 [Home Page Popup] Navigating to home page...');
      await this.page.goto(`${baseUrl}/home`, { waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
    }
    await handleCookies(this.page, 5000);
    await stabilisePage(this.page);
    await dismissMarketingPopup(this.page, 1000, { preservePpvPromo: true });
    console.log(`📍 [Home Page Popup] On home page: ${this.page.url()}`);

    // ── Attempt 1 — poll 40s for popup ──
    console.log('\n🔁 [Home Page Popup] Attempt 1 — polling 40s for popup...');
    let popupModal: any = await pollForHomePagePopup(this.page, 40000, eventData.PPV_NAME);

    // ── Attempt 2 — refresh and poll again ──
    if (!popupModal) {
      console.log('\n🔁 [Home Page Popup] Attempt 2 — refreshing page and polling 40s...');
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await handleCookies(this.page, 5000);
      await stabilisePage(this.page);
      await dismissMarketingPopup(this.page, 1000, { preservePpvPromo: true });
      console.log(`📍 [Home Page Popup] After refresh: ${this.page.url()}`);
      popupModal = await pollForHomePagePopup(this.page, 40000, eventData.PPV_NAME);
    }

    // ── Attempt 3 — logout, re-login, navigate to home, poll ──
    if (!popupModal) {
      console.log('\n🔁 [Home Page Popup] Attempt 3 — logging out and signing back in...');

      await logoutForPopupRetry(this.page, baseUrl);
      await handleCookies(this.page, 5000);

      // Re-login
      const signinUrl = `${baseUrl}/signin`;
      console.log(`🔐 [Home Page Popup] Re-navigating to: ${signinUrl}`);
      await this.page.goto(signinUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await handleCookies(this.page, 10000);
      await this.page.waitForURL(/emailDetails|signup|signin/i, { timeout: 10000 }).catch(() => { });

      // Enter email
      const emailInput = this.page.locator(
        'input[type="email"], input[name="email"], input[placeholder*="email" i]'
      ).first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      console.log(`📧 [Home Page Popup] Re-entering email: ${credentials.email}`);
      await emailInput.fill(credentials.email);

      const emailNextBtn = this.page.locator(
        'button:has-text("Next"), button:has-text("Continue"), button[type="submit"]'
      ).first();
      await clickAndWaitForNav(this.page, emailNextBtn, 'Home Page Popup Retry — Email Next');
      await this.page.waitForLoadState('domcontentloaded').catch(() => { });

      // Enter password if shown
      const passwordInput = this.page.locator(
        'input[type="password"], input[name="password"]'
      ).first();
      try {
        await passwordInput.waitFor({ state: 'visible', timeout: 8000 });
        console.log('🔑 [Home Page Popup] Entering password for retry login...');
        await passwordInput.fill(credentials.password);
        const signInBtn = this.page.locator(
          'button:has-text("Sign in"), button:has-text("Log in"), ' +
          'button:has-text("Sign In"), button[type="submit"]'
        ).first();
        await clickAndWaitForNav(this.page, signInBtn, 'Home Page Popup Retry — Sign In');
      } catch {
        console.log('ℹ️ [Home Page Popup] Password field not shown during retry');
      }

      // Wait for redirect to /home (don't force goto — popup appears on redirect)
      await this.page.waitForURL(/\/home/i, { timeout: 20000 }).catch(() => { });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await handleCookies(this.page, 5000);
      await stabilisePage(this.page);
      await dismissMarketingPopup(this.page, 1000, { preservePpvPromo: true });
      console.log(`📍 [Home Page Popup] After re-login, on: ${this.page.url()}`);

      popupModal = await pollForHomePagePopup(this.page, 40000, eventData.PPV_NAME);
    }

    // ── Fail if popup still not found ──
    if (!popupModal) {
      throw new Error(
        `❌ [Home Page Popup] PPV popup did not appear after 3 attempts ` +
        `(initial load + page refresh + re-login). URL: ${this.page.url()}`
      );
    }

    // ── Validate popup fields via PPV_Input.xlsx (Home page sheet → Flow: home-page-popup) ──
    console.log('\n📋 [Home Page Popup] Validating popup fields...');
    try {
      const popupData = getHomePageData('home-page-popup');
      if (popupData && popupData.length > 0) {
        await validateVariant(
          this.page, 'home-page', popupData, results, eventData, 'Home Page Popup', 'home-page-popup'
        );
        console.log('✅ [Home Page Popup] Popup validations complete');
      } else {
        console.log('ℹ️ [Home Page Popup] No validation rules found in PPV_Input.xlsx for home-page-popup');
      }
    } catch (err: any) {
      console.warn(`⚠️ [Home Page Popup] Popup validation error: ${err.message}`);
    }

    // ── Click Buy Now inside the configured popup ────────────────────────
    console.log('\n💳 [Home Page Popup] Clicking Buy Now inside popup...');

    const popupBuyNowButton = popupModal
      .getByRole('button', { name: /buy now/i })
      .or(popupModal.getByRole('link', { name: /buy now/i }))
      .first();
    if (!await popupBuyNowButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      throw new Error(
        `❌ [Home Page Popup] Configured popup for "${eventData.PPV_NAME}" has no visible Buy Now CTA.`
      );
    }
    await popupBuyNowButton.click({ force: true });
    console.log(`✅ [Home Page Popup] Clicked Buy Now for "${eventData.PPV_NAME}"`);

    console.log('⏳ [Home Page Popup] Waiting for navigation...');
    await this.page.waitForURL(
      (url: URL) =>
        url.toString().includes('PlanDetails') ||
        url.toString().includes('TierPlans') ||
        url.toString().includes('signup') ||
        url.toString().includes('payment') ||
        url.toString().includes('checkout'),
      { timeout: 15000 }
    ).catch(() => {
      console.log(`⚠️ [Home Page Popup] Navigation timeout — current URL: ${this.page.url()}`);
    });

    const postClickUrl = this.page.url();
    const actualPpvId = new URL(postClickUrl).searchParams.get('contextualPpvId') || '';
    if (actualPpvId !== eventData.PPV_ENTITLEMENT_ID) {
      throw new Error(
        `❌ [Home Page Popup] Expected contextualPpvId="${eventData.PPV_ENTITLEMENT_ID}" ` +
        `for "${eventData.PPV_NAME}", but received "${actualPpvId || 'missing'}". URL: ${postClickUrl}`
      );
    }
    console.log(`✅ [Home Page Popup] Confirmed contextualPpvId: ${actualPpvId}`);
    console.log(`📍 [Home Page Popup] After Buy Now: ${postClickUrl}`);
  }
}
