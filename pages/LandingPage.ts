import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import selectors from '../config/selectors.json';
import { validateVariant } from '../flows/validateVariant';
import { readSheet } from '../utils/excelReader';
import { assertDaznPageAvailable } from '../utils/helpers';

export class LandingPage extends BasePage {
  // A banner slide can be replaced by React/Swiper between validation and the
  // CTA click. Keep the PPV identity rather than retaining a DOM element.
  private bannerPpvName = '';

  constructor(page: Page) {
    super(page);
  }

  protected isFixtureOrPreviewUrl(url: string): boolean {
    const lower = url.toLowerCase();
    const isTarget =
      lower.includes('preview') ||
      lower.includes('fixture') ||
      lower.includes('event') ||
      lower.includes('stream') ||
      lower.includes('player');
    const isPurchaseRoute =
      lower.includes('plandetails') ||
      lower.includes('tierplans') ||
      lower.includes('signup') ||
      lower.includes('signin') ||
      lower.includes('payment') ||
      lower.includes('checkout');
    return isTarget && !isPurchaseRoute;
  }

  protected getUltimateValidationSheet(pageName: string): string {
    const normalized = pageName.toLowerCase();
    if (normalized.includes('home of boxing')) return 'Home of Boxing';
    if (normalized.includes('home page')) return 'Home page';
    if (normalized.includes('boxing')) return 'Boxing page';
    return 'Landing page';
  }

  protected getFlowRows(sheetName: string, flow: string): any[] {
    const normalize = (value: any) => value?.toString().trim().toLowerCase();
    const rows = readSheet(sheetName).filter((row: any) => normalize(row.Flow) === normalize(flow));
    if (!rows.length) {
      throw new Error(`❌ No Excel validation rows found for sheet="${sheetName}" flow="${flow}"`);
    }
    return rows;
  }

  protected async validateExcelFlow(
    sheetName: string,
    flow: string,
    results: any[],
    eventData: Record<string, string>,
    pageName: string,
    variant = 'landing'
  ): Promise<void> {
    const rows = this.getFlowRows(sheetName, flow);
    await validateVariant(this.page, variant, rows, results, eventData, pageName, flow);
  }

  protected async waitForFixtureOrPreviewNavigation(
    results: any[],
    pageName: string,
    source: string,
    timeout = 15000
  ): Promise<void> {
    await this.page.waitForURL((url: URL) => this.isFixtureOrPreviewUrl(url.href), { timeout }).catch(() => { });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

    const currentUrl = this.page.url();
    const reachedTarget = this.isFixtureOrPreviewUrl(currentUrl);
    results.push({
      page: pageName,
      field: 'Ultimate Navigation Target',
      expected: 'Fixture Page or Preview Page',
      actual: `Navigated to: ${currentUrl}`,
      status: reachedTarget ? 'PASS' : 'FAIL',
      source,
    });

    if (!reachedTarget) {
      throw new Error(
        `❌ [${pageName}] Ultimate tile navigation did not reach a fixture or preview page. URL: ${currentUrl}`
      );
    }
  }

  protected async clickFightCardFromContainer(container: any): Promise<void> {
    const fightCard = container
      .locator('a:has-text("Fight Card"), button:has-text("Fight Card"), a:has-text("Fight card"), button:has-text("Fight card")')
      .first();
    const visible = await fightCard.isVisible({ timeout: 5000 }).catch(() => false);
    if (!visible) {
      throw new Error('❌ [Ultimate Banner] Fight Card CTA not visible on purchased banner.');
    }

    await fightCard.click({ force: true, timeout: 5000 });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
  }

  async validateUltimatePurchasedBannerAndFightCard(
    container: any,
    source: string,
    results: any[],
    eventData: Record<string, string>,
    pageName: string,
    flowParam?: string
  ): Promise<void> {
    const sheetName = this.getUltimateValidationSheet(pageName);
    const baseFlow = flowParam && flowParam !== 'landing' ? flowParam : source;

    console.log(`💎 [Ultimate Banner] Validating purchased banner via Excel flow: ${baseFlow}-ultimate-banner`);
    await this.validateExcelFlow(sheetName, `${baseFlow}-ultimate-banner`, results, eventData, pageName);

    console.log('🖱️ [Ultimate Banner] Clicking Fight Card CTA and validating modal...');
    await this.clickFightCardFromContainer(container);
    await this.page.waitForSelector(
      '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i]',
      { state: 'visible', timeout: 10000 }
    ).catch(() => { });
    await this.validateExcelFlow(sheetName, `${baseFlow}-ultimate-fight-card`, results, eventData, pageName);
  }

  async clickUltimateTileAndValidateNavigation(
    container: any,
    source: string,
    results: any[],
    _eventData: Record<string, string>,
    pageName: string
  ): Promise<void> {
    if (!this.isFixtureOrPreviewUrl(this.page.url())) {
      const containerIsBody = await container.evaluate((el: HTMLElement) =>
        el.tagName.toLowerCase() === 'body'
      ).catch(() => false);

      if (containerIsBody) {
        throw new Error(`❌ [Ultimate Tile] Tile flow returned page body but did not navigate to fixture. URL: ${this.page.url()}`);
      }

      await container.scrollIntoViewIfNeeded().catch(() => { });
      await container.click({ force: true, timeout: 5000 });
    }

    await this.waitForFixtureOrPreviewNavigation(
      results,
      pageName,
      source
    );
  }

  // ─────────────────────────────
  // NAVIGATE TO BASE URL
  // ─────────────────────────────
  async navigate(baseUrl: string, source?: string): Promise<void> {
    const url = `${baseUrl}/welcome`;
    const t0 = Date.now();
    console.log(`🌍 [T+0ms] Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`⏱️ [T+${Date.now() - t0}ms] goto done`);
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    console.log(`⏱️ [T+${Date.now() - t0}ms] networkidle done`);
    await assertDaznPageAvailable(this.page, 'landing page navigation');
    await this.dismissConsentIfPresent();
    console.log(`⏱️ [T+${Date.now() - t0}ms] consent done`);

    // Wait for the page structure (main content or banner or explore button) to render
    const pageLoadedIndicator = this.page.locator('main [class*="banner"], main .swiper, a:has-text("Buy now"), button:has-text("Buy now"), button:has-text("Explore"), a:has-text("Explore")').first();
    await pageLoadedIndicator.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
    console.log(`⏱️ [T+${Date.now() - t0}ms] pageLoaded done`);

    console.log(`✅ Landed on: ${this.page.url()}`);
  }

  // ─────────────────────────────
  // CLICK LOG IN ON WELCOME PAGE
  // ─────────────────────────────
  async clickLogIn(): Promise<void> {
    const logInBtn = this.page.locator(
      'button:has-text("Log in"), a:has-text("Log in"), ' +
      'button:has-text("Log In"), a:has-text("Log In")'
    ).first();
    await logInBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('🖱️ Clicking Log In on welcome page...');
    await logInBtn.click({ force: true });
    await this.page.waitForLoadState('domcontentloaded').catch(() => { });
  }

  // ─────────────────────────────
  // DISMISS CONSENT
  // ─────────────────────────────
  async dismissConsentIfPresent(): Promise<void> {
    await this.waitForConsentAndDismiss();
  }

  // ─────────────────────────────
  // FIND BANNER CAROUSEL CONTAINER (resilient selector)
  // ─────────────────────────────
  protected bannerCarousel(): import('@playwright/test').Locator {
    // Use specific selectors to find the hero banner carousel, excluding general rail swipers.
    // Broadest fallbacks (main .swiper-container, main .swiper) are last so that specific
    // named selectors take priority; .first() returns the topmost DOM match.
    return this.page.locator([
      'main [class*="hero-banner" i]',
      'main [class*="heroBanner" i]',
      'main [class*="herobanner" i]',
      'main div.heroBannerSlider',
      'main [class*="bannersContainer" i]',
      'main [class*="hero-slider" i]',
      'main [class*="heroSlider" i]',
      'main [class*="hero" i] .swiper',
      'main [class*="banner" i] .swiper',
      '[class*="hero-banner" i]',
      '[class*="heroBanner" i]',
      '[class*="bannersContainer" i]',
      'main [class*="carousel" i]',
      'main [class*="Carousel" i]',
      'main [data-testid*="banner" i]',
      'main [data-testid*="carousel" i]',
      'main [data-test-id*="banner" i]',
      'main [data-test-id*="carousel" i]',
      'main .swiper-container',
      'main .swiper',
    ].join(', ')).first();
  }

  // ─────────────────────────────
  // GET ALL BANNER SLIDES (resilient selector)
  // ─────────────────────────────
  protected bannerSlides(carousel?: import('@playwright/test').Locator): import('@playwright/test').Locator {
    const parent = carousel || this.bannerCarousel();
    return parent.locator('.swiper-slide:not(.swiper-slide-duplicate)');
  }

  // ─────────────────────────────
  // STOP CAROUSEL AUTO-SLIDE
  // ─────────────────────────────
  protected async stopCarouselAutoSlide(): Promise<void> {
    await this.page.evaluate(() => {
      try {
        const stopSwiper = (swiper: any) => {
          if (!swiper) return;
          swiper.autoplay?.stop();
          swiper.params.autoplay = false;
          if (swiper.autoplay?.running) {
            swiper.autoplay.stop();
          }
        };
        const swiperEl = document.querySelector('.swiper') as any;
        if (swiperEl?.swiper) {
          stopSwiper(swiperEl.swiper);
        }
        const allSwipers = document.querySelectorAll('.swiper, [class*="swiper"]');
        allSwipers.forEach((el: any) => {
          if (el.swiper) {
            stopSwiper(el.swiper);
          }
        });
        if ((window as any).swiper) {
          stopSwiper((window as any).swiper);
        }
      } catch { }
    }).catch(() => { });
  }

  /**
   * Re-find and activate the PPV banner immediately before clicking its CTA.
   * Locators survive a Swiper/React re-render; an ElementHandle does not.
   */
  protected async reacquireBannerSlideForClick(): Promise<Locator | null> {
    if (!this.bannerPpvName) return null;

    const carousel = this.bannerCarousel();
    const slides = this.bannerSlides(carousel);
    const slideCount = await slides.count().catch(() => 0);
    let targetIndex = -1;

    for (let index = 0; index < slideCount; index++) {
      if (await this.hasPpvBannerTitle(slides.nth(index), this.bannerPpvName)) {
        targetIndex = index;
        break;
      }
    }

    if (targetIndex === -1) {
      console.warn(`⚠️ [Banner] Could not re-find PPV "${this.bannerPpvName}" before Buy Now click.`);
      return null;
    }

    const logicalIndex = await slides.nth(targetIndex)
      .getAttribute('data-swiper-slide-index')
      .catch(() => null);
    await this.stopCarouselAutoSlide();
    const activated = await carousel.evaluate((root: HTMLElement, target: {
      index: number;
      logicalIndex: string | null;
    }) => {
      const swiperElement = [root, ...Array.from(
        root.querySelectorAll<HTMLElement>('.swiper, .swiper-container, [class*="swiper" i]')
      )].find((element: any) => element.swiper);
      const swiper = (swiperElement as any)?.swiper;
      if (!swiper) return false;

      const slideIndex = Number(target.logicalIndex);
      try { swiper.autoplay?.stop(); } catch { }
      if (Number.isInteger(slideIndex) && typeof swiper.slideToLoop === 'function') {
        swiper.slideToLoop(slideIndex, 0);
      } else {
        swiper.slideTo(target.index, 0);
      }
      return true;
    }, { index: targetIndex, logicalIndex }).catch(() => false);

    if (!activated) {
      console.warn(`⚠️ [Banner] Could not move the carousel to refreshed PPV slide ${targetIndex}.`);
      return null;
    }

    let activeSlide = carousel.locator(selectors.banner.activeSlide).first();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.hasPpvBannerTitle(activeSlide, this.bannerPpvName)) break;
      await this.page.waitForTimeout(200);
      activeSlide = carousel.locator(selectors.banner.activeSlide).first();
    }

    if (!await this.hasPpvBannerTitle(activeSlide, this.bannerPpvName)) {
      console.warn(`⚠️ [Banner] Carousel did not activate refreshed PPV slide ${targetIndex}.`);
      return null;
    }

    await this.stopCarouselAutoSlide();
    await activeSlide.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { });
    console.log(`✅ [Banner] Re-acquired PPV slide ${targetIndex} immediately before Buy Now click.`);
    return activeSlide;
  }

  // ─────────────────────────────
  // MATCH PPV NAME (flexible, splits colons/hyphens)
  // ─────────────────────────────
  protected matchesPPVName(text: string, ppvName: string): boolean {
    if (!text || !ppvName) return false;
    const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
    const cleanStr = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanText = cleanStr(text);
    return nameParts.some(part => {
      const words = cleanStr(part).split(/\s+/).filter(Boolean);
      if (words.length === 0) return false;
      return words.every(w => cleanText.includes(w));
    });
  }

  /**
   * Banner copy can mention several fights, so matching the complete slide text
   * is unsafe. Match the configured event only when it appears as a short,
   * title-like line (or a title/accessibility attribute) on that slide.
   */
  protected async hasPpvBannerTitle(slide: Locator, ppvName: string): Promise<boolean> {
    return slide.evaluate((node, expectedName) => {
      const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const expected = normalise(expectedName);
      if (!expected) return false;

      // Some single-event BKFC banners omit the configured event number (for
      // example, "BKFC 94: Till vs. Romero" -> "BKFC: Till vs. Romero").
      // This is intentionally narrower than a partial title match: it accepts
      // only the omitted trailing number, the same promotion, and one exact
      // matchup, so a combined-event banner cannot be selected.
      const matchesWithoutEventNumber = (rawTitle: string): boolean => {
        const expectedParts = expectedName.split(':').map(part => normalise(part));
        const titleParts = rawTitle.split(':').map(part => normalise(part));
        if (expectedParts.length !== 2 || titleParts.length !== 2) return false;
        if ((normalise(rawTitle).match(/\bvs\b/g) || []).length !== 1) return false;

        const configuredPromotion = expectedParts[0];
        const promotionWithoutNumber = configuredPromotion.replace(/\s+\d+$/, '').trim();
        const titlePromotion = titleParts[0];
        const configuredMatchup = expectedParts[1];

        return promotionWithoutNumber !== configuredPromotion &&
          titlePromotion === promotionWithoutNumber &&
          titleParts[1] === configuredMatchup;
      };

      const matchesTitle = (value: string | null | undefined): boolean => {
        const title = normalise(value || '');
        if (!title) return false;
        // A generic promotion can mention many "A vs B" fights. An event title
        // has one matchup and is either exact or has a small date/label suffix.
        if ((title.match(/\bvs\b/g) || []).length > 1) return false;
        return title === expected ||
          matchesWithoutEventNumber(value || '') ||
          title.includes(expected) ||
          (title.startsWith(`${expected} `) && title.length <= expected.length + 40);
      };

      const titleElements = node.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, [role="heading"], ' +
        '[class*="title" i], [class*="heading" i], ' +
        '[data-testid*="title" i], [data-test-id*="title" i], img[alt], [aria-label], [title]'
      );
      if (Array.from(titleElements).some(element => [
        element.textContent,
        element.getAttribute('alt'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].some(matchesTitle))) return true;

      // DAZN sometimes renders the event title in an unlabelled div. Restrict
      // this fallback to complete short visual lines, not the whole marketing
      // paragraph, so a generic "Introducing Ultimate" slide is still rejected.
      const text = (node as HTMLElement).innerText || node.textContent || '';
      const lines = text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && line.length <= 100);
      if (lines.some(matchesTitle)) return true;

      // Some banner slides render content without line breaks (date + title +
      // description concatenated), resulting in a single long string that
      // exceeds the per-line limit. Try the full text as a fallback, but
      // still guard against multi-fight generic promotions.
      if (text.length > 0) {
        const truncated = text.substring(0, 500);
        const normalised = normalise(truncated);
        if ((normalised.match(/\bvs\b/g) || []).length <= 1) {
          return matchesTitle(truncated);
        }
      }
      return false;
    }, ppvName).catch(() => false);
  }

  /**
   * Score how closely a tile text matches the PPV name.
   * Higher score = better match. 0 = no match.
   * Exact match (tile text equals PPV name) scores highest.
   * Partial match (PPV name words found in longer text) scores lower.
   */
  protected scorePPVMatch(tileText: string, ppvName: string): number {
    if (!tileText || !ppvName) return 0;
    const cleanStr = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const cleanTile = cleanStr(tileText);
    const cleanName = cleanStr(ppvName);

    // Exact match (after normalization) — highest score
    if (cleanTile === cleanName) return 100;

    // Check if all words of PPV name are in tile text
    const nameWords = cleanName.split(/\s+/).filter(Boolean);
    const allWordsMatch = nameWords.every(w => cleanTile.includes(w));
    if (!allWordsMatch) return 0;

    // Score inversely by how much extra text the tile has
    // "GLORY COLLISION 9" (18 chars) matching "Glory Collision 9: Prelims" (26 chars)
    // vs matching "GLORY COLLISION 9" (18 chars) — latter scores higher
    const ratio = cleanName.length / cleanTile.length;
    return Math.round(ratio * 90); // Max 90 for partial match, 100 for exact
  }

  // ─────────────────────────────
  // FIND PPV IN BANNER (carousel) — with resilient selectors
  // ─────────────────────────────
  async findPPVInBanner(eventData: Record<string, string>, source?: string): Promise<any> {
    const ppvName = eventData.PPV_NAME || '';
    const sourceName = source || 'banner';
    this.bannerPpvName = ppvName;
    const tBanner = Date.now();
    console.log(`🔍 [T+0ms] [Banner] Finding PPV: ${ppvName}`);

    const failPpvNotConfigured = (detail: string): never => {
      throw new Error(
        `❌ [Banner] PPV "${ppvName || '(missing PPV_NAME)'}" is not configured in source ` +
        `"${sourceName}" for the current page/region. ${detail}`
      );
    };

    if (!ppvName.trim()) {
      failPpvNotConfigured('The event configuration has no PPV_NAME.');
    }

    // Helper to aggressively stop all swipers on the page via JS + CSS injection
    const stopAllAutoSlide = async () => {
      await this.page.evaluate(() => {
        try {
          // Inject CSS to freeze carousel transitions
          const styleId = '__ppv_freeze_carousel__';
          if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
              .swiper-wrapper { transition-duration: 0ms !important; }
            `;
            document.head.appendChild(style);
          }

          const stopSwiper = (swiper: any) => {
            if (!swiper) return;
            try { swiper.autoplay?.stop(); } catch { }
            try {
              swiper.params.autoplay = false;
            } catch { }
            try {
              if (swiper.autoplay?.running) swiper.autoplay.stop();
            } catch { }
          };

          // Strategy 1: el.swiper
          const allSwipers = document.querySelectorAll('.swiper, [class*="swiper"], .swiper-container');
          allSwipers.forEach((el: any) => {
            if (el.swiper) stopSwiper(el.swiper);
          });

          // Strategy 2: window.swiper
          if ((window as any).swiper) {
            stopSwiper((window as any).swiper);
          }

          // Strategy 3: Walk all DOM elements for swiper instances
          const allEls = document.querySelectorAll('*');
          allEls.forEach((el: any) => {
            if (el.swiper && typeof el.swiper === 'object' && el.swiper.autoplay) {
              stopSwiper(el.swiper);
            }
          });
        } catch { }
      }).catch(() => { });
    };

    // Stop auto-slide immediately
    await stopAllAutoSlide();
    console.log(`⏱️ [Banner T+${Date.now() - tBanner}ms] stopAutoSlide done`);

    // Helper to dump page structure for diagnostics
    const dumpPageDiag = async (label: string) => {
      const pageDiag = await this.page.evaluate(() => {
        const main = document.querySelector('main');
        const body = document.body;
        const classes = (el: Element | null) =>
          el ? Array.from(el.classList).join(' ') : '';
        const children = (el: Element | null) =>
          el ? Array.from(el.children).slice(0, 8).map(c =>
            `<${c.tagName.toLowerCase()} class="${classes(c)}">`
          ).join(' | ') : '';
        const swipers = Array.from(document.querySelectorAll('[class*="swiper" i], [class*="banner" i], [class*="hero" i]'))
          .slice(0, 15).map(el => `${el.tagName.toLowerCase()}.${classes(el)}`);
        const h1 = document.querySelector('h1')?.textContent?.trim().substring(0, 80) || '';
        return {
          url: window.location.href,
          title: document.title.substring(0, 80),
          h1,
          mainClass: classes(main),
          mainChildren: children(main),
          bodyChildren: children(body),
          swipers,
        };
      }).catch(() => null);
      console.log(`🔍 [Banner] PAGE DIAGNOSTIC (${label}):`, JSON.stringify(pageDiag, null, 2));
    };

    // Check if carousel exists (wait for it to become visible).
    // If not found after 20s, reload the page once and retry — handles transient load failures
    // on slow shared runners as well as cases where the page rendered a different structure first.
    let carousel = this.bannerCarousel();
    let carouselFound = await carousel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);

    if (!carouselFound) {
      await dumpPageDiag('attempt 1 — reloading page');
      console.log('🔄 [Banner] Carousel not found — reloading page and retrying...');
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await assertDaznPageAvailable(this.page, 'landing banner retry');
      await this.dismissConsentIfPresent().catch(() => { });
      await stopAllAutoSlide();
      carousel = this.bannerCarousel();
      carouselFound = await carousel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    }

    if (!carouselFound) {
      await dumpPageDiag('attempt 2 — giving up');
      failPpvNotConfigured('No banner carousel is available in this source.');
    }

    // Scroll to the carousel to ensure it is in view for hover/click interactions
    await carousel.scrollIntoViewIfNeeded().catch(() => { });
    await stopAllAutoSlide();

    const getActiveSlide = (): Locator =>
      carousel.locator(selectors.banner.activeSlide).first();
    const getActiveSlideText = async (): Promise<string> => {
      const active = getActiveSlide();
      if (await active.isVisible({ timeout: 1000 }).catch(() => false)) {
        return ((await active.textContent().catch(() => '')) || '').trim();
      }
      return '';
    };
    const saveActiveSlideIndex = async (active: Locator, fallbackIndex: number): Promise<void> => {
      const index = await active.getAttribute('data-swiper-slide-index').catch(() => null);
      const renderedIndex = await active.evaluate((node: HTMLElement) => {
        const slides = Array.from(
          node.parentElement?.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)') || []
        );
        return slides.indexOf(node);
      }).catch(() => -1);
      eventData._ppvBannerSlideIndex = index && /^\d+$/.test(index)
        ? index
        : String(renderedIndex >= 0 ? renderedIndex : fallbackIndex);
    };

    // Check active slide first
    const activeText = await getActiveSlideText();
    const activeSlide = getActiveSlide();
    if (await this.hasPpvBannerTitle(activeSlide, ppvName)) {
      console.log(`✅ [Banner] PPV already on active slide`);
      await stopAllAutoSlide();
      await saveActiveSlideIndex(activeSlide, 0);
      return activeSlide;
    }
    console.log(`ℹ️  Active slide: "${activeText.substring(0, 60)}..." — not our PPV`);

    // Check if swiper has slides at all
    const slides = this.bannerSlides(carousel);
    const totalSlideCount = await slides.count().catch(() => 0);
    if (totalSlideCount === 0) {
      // Static banner (no swiper slides)
      if (await this.hasPpvBannerTitle(carousel, ppvName)) {
        console.log('✅ [Banner] PPV found on static banner container');
        return carousel;
      }
      console.log('⚠️ [Banner] PPV not found on static banner');
      failPpvNotConfigured('The static banner does not match the configured PPV.');
    }

    // Walk the visible carousel with its next chevron. Do not promote a hidden
    // slide by changing Swiper's CSS classes: its text can then be paired with
    // the artwork still positioned behind it.
    if (totalSlideCount === 1) {
      failPpvNotConfigured('The only rendered banner slide does not match the configured PPV.');
    }

    const nextButton = carousel.locator([
      selectors.banner.nextButton,
      'button[aria-label*="next" i]',
      '[role="button"][aria-label*="next" i]',
      'button[class*="next" i]',
      '[role="button"][class*="next" i]',
    ].join(', ')).first();
    if (!await nextButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      failPpvNotConfigured(`The banner has ${totalSlideCount} slide(s), but its next chevron is not available.`);
    }

    const maxChevronMoves = totalSlideCount + 1;
    console.log(`🔍 [Banner] Checking up to ${maxChevronMoves + 1} banner slide(s) via the next chevron...`);
    for (let step = 1; step <= maxChevronMoves; step++) {
      const previousSlide = getActiveSlide();
      const previousIndex = await previousSlide.getAttribute('data-swiper-slide-index').catch(() => null);
      const previousText = await getActiveSlideText();
      await nextButton.click({ force: true, timeout: 5000 });

      let currentSlide = getActiveSlide();
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.page.waitForTimeout(200);
        currentSlide = getActiveSlide();
        const currentIndex = await currentSlide.getAttribute('data-swiper-slide-index').catch(() => null);
        const currentText = await getActiveSlideText();
        if ((currentIndex && currentIndex !== previousIndex) || currentText !== previousText) break;
      }
      if (await this.hasPpvBannerTitle(currentSlide, ppvName)) {
        console.log(`✅ [Banner] PPV found after ${step} chevron move(s)`);
        await stopAllAutoSlide();
        await saveActiveSlideIndex(currentSlide, step);
        return currentSlide;
      }
    }

    const renderedMatch = await this.reacquireBannerSlideForClick();
    if (renderedMatch) {
      console.log('✅ [Banner] PPV found by activating rendered slide after chevron scan');
      await saveActiveSlideIndex(renderedMatch, totalSlideCount);
      return renderedMatch;
    }

    failPpvNotConfigured(`Checked ${totalSlideCount} active banner slide(s) without a matching PPV title.`);
  }

  // ─────────────────────────────
  // FIND PPV IN "DON'T MISS LIVE" TILE SECTION
  // ─────────────────────────────
  async findPPVInTileSection(eventData: Record<string, string>, source?: string): Promise<any> {
    const ppvName = eventData.PPV_NAME || '';
    const src = (source || '').toLowerCase();

    let headingPattern = /don'?t\s*miss/i;
    let headingLabel = "Don't Miss";
    if (src.includes('biggest-fights') || src === 'home-biggest-fights') {
      headingPattern = /biggest\s*fights/i;
      headingLabel = "Biggest Fights";
    } else if (src.includes('upcoming')) {
      headingPattern = /upcoming/i;
      headingLabel = "Upcoming Fights";
    }

    console.log(`🔍 [Tile] Finding PPV in "${headingLabel}" section: ${ppvName}`);

    // Build multiple name parts for verification
    const nameParts = ppvName.split(/[:\-–]/).map(p => p.trim()).filter(p => p.length > 3);
    const cleanStr = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    // Extract fighter names for image alt-text matching (e.g., "Fury vs. Hall")
    const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
    const fighter1 = vsMatch ? vsMatch[1] : '';
    const fighter2 = vsMatch ? vsMatch[2] : '';
    if (fighter1) console.log(`🔍 [Tile] Fighter names: "${fighter1}" vs "${fighter2}"`);

    const isBannerElement = async (locator: any): Promise<boolean> => {
      return locator.evaluate((node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const pageY = rect.top + window.scrollY;
        if (pageY > 0 && pageY < 750) return true;

        let parent = node.parentElement;
        for (let i = 0; i < 15; i++) {
          if (!parent) break;
          const cls = parent.className || '';
          const clsLower = typeof cls === 'string' ? cls.toLowerCase() : '';
          if (clsLower.includes('hero') || (clsLower.includes('banner') && !clsLower.includes('rail'))) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      }).catch(() => false);
    };

    const matchesPPV = (text: string): boolean => {
      return this.matchesPPVName(text, ppvName);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Scroll to heading and locate the rail wrapper
    // ─────────────────────────────────────────────────────────────────────────
    console.log(`📜 [Tile] Locating "${headingLabel}" section...`);

    const railHeadingLocator = this.page
      .locator('h1, h2, h3, h4, [class*="heading" i]')
      .filter({ hasText: headingPattern });

    let railHeadingCount = 0;

    for (let attempt = 0; attempt < 5; attempt++) {
      railHeadingCount = await railHeadingLocator.count().catch(() => 0);

      if (railHeadingCount > 0) {
        break;
      }

      await this.page.evaluate(() => {
        const viewportHeight = window.innerHeight || 800;
        const nextScrollTop = Math.min(
          document.documentElement.scrollHeight - viewportHeight,
          window.scrollY + viewportHeight * 0.85
        );

        window.scrollTo({
          top: Math.max(0, Math.round(nextScrollTop)),
          behavior: 'instant',
        });
      }).catch(() => { });

      await this.page.waitForTimeout(500);
    }

    try {
      await railHeadingLocator.first().waitFor({ state: 'attached', timeout: 8000 });
    } catch (e) {
      throw new Error(`❌ [Tile] "${headingLabel}" rail heading not attached/found in DOM after timeout for event: "${ppvName}"`);
    }

    railHeadingCount = await railHeadingLocator.count().catch(() => 0);
    if (railHeadingCount === 0) {
      throw new Error(`❌ [Tile] "${headingLabel}" rail heading count is 0 in DOM for event: "${ppvName}"`);
    }
    const railHeading = railHeadingLocator.first();

    await railHeading.evaluate((heading: HTMLElement) => {
      const headerOffset = 24;
      const absoluteTop = heading.getBoundingClientRect().top + window.scrollY;

      window.scrollTo({
        top: Math.max(0, Math.round(absoluteTop - headerOffset)),
        behavior: 'instant',
      });
    }).catch(() => { });

    await this.page.waitForTimeout(300);

    const railPosition = await railHeading.evaluate((heading: HTMLElement) => {
      const rect = heading.getBoundingClientRect();

      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
      };
    }).catch(() => null);

    console.log(
      `✅ [Tile] "${headingLabel}" heading top-aligned` +
      (railPosition
        ? ` (top=${railPosition.top}, bottom=${railPosition.bottom}, viewport=${railPosition.viewportHeight})`
        : '')
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2: Get the rail wrapper container and swiper next button
    // ─────────────────────────────────────────────────────────────────────────
    // Try both class patterns: "railWrapper" (welcome page) and "rail__rail-wrapper" (boxing page)
    let railWrapper = railHeading.locator('xpath=ancestor::*[contains(@class,"railWrapper")][1]');
    let hasWrapper = await railWrapper.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasWrapper) {
      railWrapper = railHeading.locator('xpath=ancestor::*[contains(@class,"rail__rail-wrapper")][1]');
      hasWrapper = await railWrapper.isVisible({ timeout: 3000 }).catch(() => false);
    }
    if (!hasWrapper) {
      // Broad fallback: find nearest ancestor with "rail" in className
      railWrapper = railHeading.locator('xpath=ancestor::*[contains(@class,"rail")][1]');
      hasWrapper = await railWrapper.isVisible({ timeout: 2000 }).catch(() => false);
    }

    if (!hasWrapper) {
      throw new Error(`❌ [Tile] Rail wrapper container not found in DOM for "Don't Miss" section for event: "${ppvName}"`);
    }
    console.log('✅ [Tile] Rail wrapper container found');

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2.5: Build image selector for PPV tile (same approach as BoxingHomePage)
    // ─────────────────────────────────────────────────────────────────────────
    // Build an exclusion selector to avoid matching ancillary content
    const exclusions = [
      'press conference', 'weigh-in', 'workout', 'replay', 'highlights',
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

    const textTileLocator = railWrapper.locator('.swiper-slide, [class*="tile" i], article, li').filter({
      hasText: fighter1 && fighter2 ? new RegExp(`${fighter1}|${fighter2}`, 'i') : ppvName
    }).first();

    // Helper: check if the PPV tile is currently in view (with retry for transient detachments)
    const isTileInView = async (): Promise<any> => {
      for (let retry = 0; retry < 2; retry++) {
        // Strategy A: Find by Text Content
        const candidates = railWrapper.locator('.swiper-slide, [class*="tile" i], article, li');
        const count = await candidates.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const el = candidates.nth(i);
          if (await el.isVisible().catch(() => false)) {
            const text = (await el.textContent().catch(() => '')) || '';
            const match = matchesPPV(text) ||
              (fighter1 && text.toLowerCase().includes(fighter1.toLowerCase())) ||
              (fighter2 && text.toLowerCase().includes(fighter2.toLowerCase()));

            if (match) {
              const inView = await el.evaluate((node: HTMLElement) => {
                const r = node.getBoundingClientRect();
                return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
              }).catch(() => false);

              if (inView) {
                const buyNowBtn = el.locator('button:has-text("Buy now"), button:has-text("Buy"), a:has-text("Buy now"), a:has-text("Buy")').first();
                if (await buyNowBtn.isVisible().catch(() => false)) {
                  console.log('✅ Found matching tile and its Buy Now button in view');
                  return buyNowBtn;
                }
                const anchor = el.locator('xpath=self::a | ancestor-or-self::a').first();
                if (await anchor.count().catch(() => 0) > 0) {
                  console.log('✅ Found matching tile anchor in view');
                  return anchor;
                }
                console.log('✅ Found matching tile element in view');
                return el;
              }
            }
          }
        }

        // Strategy B: Fallback to original image alt-text search
        const imgCount = await ppvImg.count().catch(() => 0);
        if (imgCount > 0) {
          const inView = await ppvImg.evaluate((el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
          }).catch(() => false);
          if (inView) {
            console.log('✅ Found matching tile via image alt-text in view');
            return ppvTileLink;
          }
        }

        if (retry === 0) {
          await this.page.waitForTimeout(400);
          continue;
        }
      }
      return null;
    };

    // Find the next-slide button (support multiple selector patterns across landing page variants)
    const nextBtn = railWrapper.locator([
      'button[aria-label="Next slide"]',
      'button[class*="swiper-button-next"]',
      '.custom-swiper-button-next',
      '[class*="next" i]',
    ].join(', ')).first();

    // Wait for swiper navigation to be attached
    await nextBtn.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {
      console.log('⚠️  [Tile] Swiper next button not attached after 8s');
    });

    // Hover rail wrapper to make swiper arrows visible
    await railWrapper.hover({ force: true }).catch(() => { });
    await this.page.waitForTimeout(500);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: Navigate the swiper rail — click > until PPV tile is found (same as BoxingHomePage)
    // ─────────────────────────────────────────────────────────────────────────
    let clicks = 0;
    const maxClicks = 30;
    let found = await isTileInView();

    while (!found && clicks < maxClicks) {
      if (this.page.isClosed()) throw new Error('Page closed during swiper navigation');

      await railWrapper.hover({ force: true }).catch(() => { });
      await this.page.waitForTimeout(200);

      // Check if next button is disabled (end of rail) — check all known disable class patterns
      const nextDisabled = await nextBtn.evaluate((el: Element) => {
        return el.classList.contains('swiper-button-disabled') ||
          el.classList.contains('rail-module__disable') ||
          el.className.includes('disable') ||
          el.hasAttribute('disabled');
      }).catch(() => false);

      if (nextDisabled) {
        console.log('⚠️  [Tile] Next button disabled — end of rail reached');
        break;
      }

      // Check if next button exists in DOM (retry once for transient detach during animation)
      let nextCount = await nextBtn.count().catch(() => 0);
      if (nextCount === 0) {
        await this.page.waitForTimeout(400);
        nextCount = await nextBtn.count().catch(() => 0);
        if (nextCount === 0) {
          console.log('⚠️  [Tile] Next button not found in DOM after retry');
          break;
        }
      }

      console.log(`  [Tile] Click ${clicks + 1}: advancing to next slide...`);
      await nextBtn.click({ timeout: 5000, force: true }).catch((e: any) => {
        console.log('⚠️  Next click error:', e.message);
      });
      clicks++;
      await this.page.waitForTimeout(800);
      found = await isTileInView();
    }

    console.log(`✅ [Tile] Swiper "Next" clicks performed: ${clicks}`);

    // Fallback: if tile exists in DOM but not in viewport, scroll it into view
    const hasTextTile = await textTileLocator.count().catch(() => 0) > 0;
    if (!found && (hasTextTile || (await ppvImg.count()) > 0)) {
      console.log('🔍 [Tile] Tile in DOM but not visible — scrolling into view');
      const scrollTarget = hasTextTile ? textTileLocator : ppvImg;
      await scrollTarget.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(500);
      found = await isTileInView();
    }

    if (!found) {
      // Debug dump — show all images in rail for diagnostics
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
      throw new Error(`❌ [Tile] Could not find "${fighter1 || ppvName}" tile in "Don't Miss" rail after ${clicks} clicks`);
    }

    console.log(`✅ [Tile] Tile in view after ${clicks} next clicks`);
    await found.scrollIntoViewIfNeeded().catch(() => { });
    await found.hover().catch(() => { });
    await this.page.waitForTimeout(300);
    return found;
  }

  /**
   * Static fallback DOM search for findPPVInTileSection.
   * This is the original Strategy 2 + Strategy 3 logic, used as a last resort
   * when swiper navigation fails (e.g., no rail wrapper found, no next button).
   */
  private async _findPPVInTileSectionStaticFallback(
    eventData: Record<string, string>,
    nameParts: string[],
    cleanStr: (s: string) => string,
    matchesPPV: (text: string) => boolean,
    isBannerElement: (locator: any) => Promise<boolean>,
  ): Promise<any> {
    throw new Error(`❌ [Tile Fallback] Page-wide fallback is disabled. PPV tile for "${eventData.PPV_NAME}" was not found in the "Don't Miss" rail.`);
  }

  // ─────────────────────────────
  // FIND PPV IN WELCOME PAGE "DON'T MISS LIVE" SWIPER RAIL
  // ─────────────────────────────
  async findPPVInWelcomeRail(eventData: Record<string, string>): Promise<any> {
    const ppvDisplayName = eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || '';
    console.log(`🔍 [WelcomeRail] Finding PPV tile: "${ppvDisplayName}"`);

    const matchesTile = (text: string): boolean => {
      return this.matchesPPVName(text, ppvDisplayName);
    };

    // Scroll down to find "Don't miss live on DAZN" heading
    console.log('📍 [WelcomeRail] Scrolling to rail heading...');
    await this.page.evaluate(() => { window.scrollTo({ top: 1200, behavior: 'instant' }); }).catch(() => { });
    await this.page.waitForTimeout(800);

    const railHeading = this.page.getByText(/don.t miss live/i).first();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await railHeading.count().catch(() => 0) > 0) break;
      await this.page.evaluate(() => {
        window.scrollTo({ top: 2500 + Math.random() * 500, behavior: 'instant' });
      }).catch(() => { });
      await this.page.waitForTimeout(600);
    }

    const headingFound = await railHeading.waitFor({ state: 'attached', timeout: 8000 })
      .then(() => true).catch(() => false);
    if (!headingFound) {
      console.log('⚠️ [WelcomeRail] "Don\'t miss live on DAZN" heading not found');
      return null;
    }
    await railHeading.scrollIntoViewIfNeeded().catch(() => { });
    console.log('✅ [WelcomeRail] Rail heading found');

    // Get rail wrapper container
    const railWrapper = railHeading.locator('xpath=ancestor::*[contains(@class,"railWrapper")][1]');
    const hasWrapper = await railWrapper.isVisible({ timeout: 3000 }).catch(() => false);
    const railContainer = hasWrapper ? railWrapper : this.page.locator('body');

    // Find next-slide button (welcome page uses div[class*="next"], not button[aria-label])
    const nextBtn = railContainer.locator('[class*="next" i]').first();

    let ppvTile: any = null;
    for (let click = 0; click < 20; click++) {
      // Hover to reveal navigation arrows
      await railContainer.hover().catch(() => { });
      await this.page.waitForTimeout(300);

      // Search for tile matching PPV name with "Buy now" CTA — score all and pick best
      const candidates = railContainer.locator('a, div[class*="tile" i], article, li');
      const count = await candidates.count().catch(() => 0);

      let bestScore = ppvTile ? this.scorePPVMatch(await ppvTile.textContent().catch(() => '') || '', ppvDisplayName) : 0;

      for (let i = 0; i < count; i++) {
        const el = candidates.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const text = (await el.textContent().catch(() => '')) || '';
        const lower = text.toLowerCase();
        if (matchesTile(text) && (lower.includes('buy now') || lower.includes('buy'))) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 50 && box.width < 700 && box.height > 50 && box.height < 600) {
            const score = this.scorePPVMatch(text, ppvDisplayName);
            if (score > bestScore) {
              bestScore = score;
              ppvTile = el;
              console.log(`🔍 [WelcomeRail] Candidate tile (score=${score}): "${text.replace(/\s+/g, ' ').substring(0, 100)}"`);
            }
          }
        }
      }
      if (ppvTile) break;

      // Click next slide
      if (await nextBtn.isVisible().catch(() => false)) {
        const disabled = await nextBtn.evaluate((el: Element) =>
          el.classList.contains('rail-module__disable') || el.className.includes('disable')
        ).catch(() => false);
        if (disabled) {
          console.log('⚠️ [WelcomeRail] Next button disabled — end of rail');
          break;
        }

        await nextBtn.click({ force: true }).catch(() => { });
        await this.page.waitForTimeout(800);
      } else {
        console.log('⚠️ [WelcomeRail] Next slide button not visible');
        break;
      }
    }

    if (!ppvTile) {
      console.log(`⚠️ [WelcomeRail] PPV tile "${ppvDisplayName}" not found in rail`);
    }
    return ppvTile;
  }

  async findPPVContainer(eventData: Record<string, string>, source?: string): Promise<any> {
    const src = (source || '').toLowerCase();

    // Dismiss cookie banner if it appeared late
    await this.waitForConsentAndDismiss(5000).catch(() => { });

    if (src === 'welcome-rail') {
      return this.findPPVInWelcomeRail(eventData);
    }

    if (src.includes('banner')) {
      return this.findPPVInBanner(eventData, src);
    }

    if (src.includes('dont-miss') || src.includes('tile') || src.includes('upcoming')) {
      return this.findPPVInTileSection(eventData, source);
    }

    // Strict source validation — no cross-source fallback
    throw new Error(
      `❌ PPV not found in expected source: "${source || 'unknown'}". ` +
      `No fallback search will be attempted. Valid sources: landing-page-banner, landing-page-dont-miss-live, welcome-rail.`
    );
  }

  async clickBuyNow(container: any, source?: string): Promise<void> {
    if (!container) {
      throw new Error('❌ No PPV container found — cannot click Buy Now');
    }

    const src = (source || '').toLowerCase();
    console.log('💳 Clicking Buy Now via container...');

    // For banner sources: use aggressive CSS-injection stop (same as findPPVInBanner)
    // to prevent carousel from rotating between finding the slide and clicking Buy Now
    if (src.includes('banner')) {
      await this.page.evaluate(() => {
        try {
          const styleId = '__ppv_freeze_carousel__';
          if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = '.swiper-wrapper { transition-duration: 0ms !important; }';
            document.head.appendChild(style);
          }
          const stopSwiper = (swiper: any) => {
            if (!swiper) return;
            try { swiper.autoplay?.stop(); } catch { }
            try { swiper.params.autoplay = false; } catch { }
            try { if (swiper.autoplay?.running) swiper.autoplay.stop(); } catch { }
          };
          document.querySelectorAll('.swiper, [class*="swiper"], .swiper-container').forEach((el: any) => {
            if (el.swiper) stopSwiper(el.swiper);
          });
          document.querySelectorAll('*').forEach((el: any) => {
            if (el.swiper && typeof el.swiper === 'object' && el.swiper.autoplay) stopSwiper(el.swiper);
          });
        } catch { }
      }).catch(() => { });
    } else {
      await this.stopCarouselAutoSlide();
    }
    // For banner sources: skip scrollIntoViewIfNeeded — calling it on a non-active
    // swiper slide triggers a DAZN SPA navigation that closes the Playwright page context.
    // Swiper slide activation below uses slideTo/slideToLoop (JS-only, no browser scroll).
    if (!src.includes('banner')) {
      await container.scrollIntoViewIfNeeded().catch(() => { });
    }
    if (this.page.isClosed()) {
      // Give the page up to 2s to recover in case this is a transient
      // navigation / onboarding redirect (e.g. DAZN ?step= wizard).
      console.warn(`⚠️ [clickBuyNow] Page appears closed after scroll (source: ${source || 'unknown'}) — waiting to confirm...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (this.page.isClosed()) {
        throw new Error(
          `❌ [clickBuyNow] Page was closed after scroll — likely a session redirect or account-state issue (source: ${source || 'unknown'})`
        );
      }
      console.log('✅ [clickBuyNow] Page recovered after transient close state — continuing...');
    }
    await this.page.waitForTimeout(200);

    let targetContainer = container;

    if (src.includes('banner')) {
      const refreshedBanner = await this.reacquireBannerSlideForClick();
      if (refreshedBanner) {
        targetContainer = refreshedBanner;
      } else if (!await this.hasPpvBannerTitle(targetContainer, this.bannerPpvName)) {
        throw new Error(
          `❌ [Banner] Could not re-acquire configured PPV "${this.bannerPpvName}" before Buy Now click. ` +
          'Will NOT use the currently active banner as a fallback.'
        );
      }
    }

    // Check if container is a swiper slide
    // Skip swiper slide activation for banner sources — findPPVInBanner already
    // ensures the correct slide is active with auto-slide stopped
    try {
      const isBannerSource = src.includes('banner');
      const isSwiperSlide = !isBannerSource && await container.evaluate((node: HTMLElement) => {
        return node.classList.contains('swiper-slide') || !!node.closest('.swiper-slide');
      }).catch(() => false);

      if (isSwiperSlide) {
        console.log('🔄 Container is a swiper slide — checking active slide in swiper...');

        const slideIndex = await container.evaluate((node: HTMLElement) => {
          const slideEl = node.classList.contains('swiper-slide') ? node : node.closest('.swiper-slide');
          if (!slideEl) return null;
          const slideIndexAttr = slideEl.getAttribute('data-swiper-slide-index');
          if (slideIndexAttr !== null && slideIndexAttr !== undefined) {
            return { type: 'loop', index: parseInt(slideIndexAttr, 10) };
          }
          const swiperEl = slideEl.parentElement?.closest('.swiper, [class*="swiper"]');
          const slides = Array.from(swiperEl?.querySelectorAll('.swiper-slide') || []);
          const idx = slides.indexOf(slideEl);
          return { type: 'normal', index: idx };
        }).catch(() => null);

        console.log(`ℹ️ Target slide info: ${JSON.stringify(slideIndex)}`);

        if (slideIndex !== null) {
          const swiperLocator = container.locator('xpath=ancestor-or-self::*[contains(@class, "swiper") or contains(@class, "Swiper")][1]');
          const swiperCount = await swiperLocator.count().catch(() => 0);
          const activeSlideLocator = (swiperCount > 0)
            ? swiperLocator.locator('.swiper-slide-active, [class*="swiper-slide-active"]').first()
            : this.page.locator('.swiper-slide-active, [class*="swiper-slide-active"]').first();
          let isActiveMatching = false;
          if (await activeSlideLocator.isVisible().catch(() => false)) {
            const activeInfo = await activeSlideLocator.evaluate((node: HTMLElement) => {
              const slideIndexAttr = node.getAttribute('data-swiper-slide-index');
              if (slideIndexAttr !== null && slideIndexAttr !== undefined) {
                return { type: 'loop', index: parseInt(slideIndexAttr, 10) };
              }
              const swiperEl = node.parentElement?.closest('.swiper, [class*="swiper"]');
              const slides = Array.from(swiperEl?.querySelectorAll('.swiper-slide') || []);
              const idx = slides.indexOf(node);
              return { type: 'normal', index: idx };
            }).catch(() => null);

            console.log(`ℹ️ Current active slide info: ${JSON.stringify(activeInfo)}`);
            if (activeInfo && activeInfo.type === slideIndex.type && activeInfo.index === slideIndex.index) {
              isActiveMatching = true;
              targetContainer = activeSlideLocator;
              console.log('✅ Active slide already matches target slide index');
            }
          }

          if (!isActiveMatching) {
            console.log('🔄 Active slide does not match target index — triggering slide navigation...');
            const handle = await container.elementHandle().catch(() => null);
            if (handle) {
              await this.page.evaluate((slideNode: any) => {
                if (!slideNode) return;
                const slideEl = slideNode.classList.contains('swiper-slide') ? slideNode : slideNode.closest('.swiper-slide');
                if (!slideEl) return;
                const swiperEl = slideEl.parentElement?.closest('.swiper, [class*="swiper"]');
                const swiper = (swiperEl as any)?.swiper;
                if (swiper) {
                  swiper.autoplay?.stop();
                  const slideIndexAttr = slideEl.getAttribute('data-swiper-slide-index');
                  if (slideIndexAttr !== null && slideIndexAttr !== undefined) {
                    swiper.slideToLoop(parseInt(slideIndexAttr, 10));
                  } else {
                    const slides = Array.from(swiperEl.querySelectorAll('.swiper-slide') || []);
                    const idx = slides.indexOf(slideEl);
                    if (idx !== -1) {
                      swiper.slideTo(idx);
                    }
                  }
                }
              }, handle);
              await this.page.waitForTimeout(1000);

              if (await activeSlideLocator.isVisible().catch(() => false)) {
                const newActiveInfo = await activeSlideLocator.evaluate((node: HTMLElement) => {
                  const slideIndexAttr = node.getAttribute('data-swiper-slide-index');
                  if (slideIndexAttr !== null && slideIndexAttr !== undefined) {
                    return { type: 'loop', index: parseInt(slideIndexAttr, 10) };
                  }
                  const swiperEl = node.parentElement?.closest('.swiper, [class*="swiper"]');
                  const slides = Array.from(swiperEl?.querySelectorAll('.swiper-slide') || []);
                  const idx = slides.indexOf(node);
                  return { type: 'normal', index: idx };
                }).catch(() => null);
                if (newActiveInfo && newActiveInfo.type === slideIndex.type && newActiveInfo.index === slideIndex.index) {
                  targetContainer = activeSlideLocator;
                  console.log('✅ Navigated to matching active slide');
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.log(`⚠️ Slide activation/matching warning in clickBuyNow: ${(e as Error).message}`);
    }

    let containerText = (await targetContainer.textContent().catch(() => ''))?.trim() || '';
    console.log(`📋 Container preview: "${containerText.substring(0, 80)}"`);

    // Check if carousel rotated away (container is stale/invisible)
    let containerBox = await targetContainer.boundingBox().catch(() => null);
    if (src.includes('banner') && (containerText.length === 0 || !containerBox || containerBox.width === 0)) {
      console.log('🔄 Re-finding active banner slide container...');
      const activeSlide = this.page.locator(selectors.banner.activeSlide).locator(':visible').first();
      if (await activeSlide.isVisible().catch(() => false)) {
        targetContainer = activeSlide;
        containerText = (await targetContainer.textContent().catch(() => ''))?.trim() || '';
        containerBox = await targetContainer.boundingBox().catch(() => null);
        console.log(`📋 Re-found container preview: "${containerText.substring(0, 80)}"`);
      }
    }

    if (containerText.length === 0 || (containerBox && containerBox.width === 0)) {
      console.log('⚠️  Container appears stale or rotated away');
      containerText = '';
    }

    let buyNowBtn: any = null;

    if (containerText.length > 0) {
      // Normal path: container has content, find Buy Now inside it
      buyNowBtn = targetContainer
        .locator('a, button')
        .filter({ hasText: /buy now/i })
        .first();

      // Verify the button is findable
      const btnVisible = await buyNowBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (!btnVisible) {
        console.log('⚠️  Buy Now not visible inside container — checking container itself');
        // The container might BE the Buy Now link (e.g., <a> with "Buy now" text)
        if (/buy now/i.test(containerText)) {
          buyNowBtn = targetContainer;
        } else {
          buyNowBtn = null;
        }
      }
    }

    if (!buyNowBtn) {
      const typeLabel = src.includes('banner') ? 'Banner' : (src.includes('welcome-rail') ? 'Welcome Rail' : 'Tile');
      throw new Error(
        `❌ [${typeLabel}] "Buy Now" button not found inside the matched PPV container. ` +
        'Will NOT click a different PPV as a fallback.'
      );
    }

    // Wait for Buy Now to be visible
    await buyNowBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
      await buyNowBtn.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(500);
    });

    await this.stopCarouselAutoSlide();

    // Try boundingBox but don't fail hard — fall through to force click
    const box = await buyNowBtn.boundingBox({ timeout: 5000 }).catch(() => null);
    if (!box || box.width === 0 || box.height === 0) {
      console.log('⚠️  Buy Now has zero/null bounding box — attempting force click anyway');
    }

    const beforeUrl = this.page.url();

    try {
      await buyNowBtn.click({ force: true, timeout: 5000 });
    } catch {
      console.log('⚠️  Click intercepted → forcing JS click');
      let retriedWithFreshBannerLocator = false;

      if (src.includes('banner')) {
        const refreshedBanner = await this.reacquireBannerSlideForClick();
        if (refreshedBanner) {
          const freshBuyNow = refreshedBanner
            .locator('a, button')
            .filter({ hasText: /buy now/i })
            .first();
          retriedWithFreshBannerLocator = await freshBuyNow
            .click({ force: true, timeout: 5000 })
            .then(() => true)
            .catch(() => false);
          if (retriedWithFreshBannerLocator) {
            console.log('✅ [Banner] Buy Now clicked through a fresh PPV-slide locator.');
          }
        }
      }

      if (retriedWithFreshBannerLocator) {
        // The click succeeded after the carousel re-render; do not fall back
        // to an element handle from the previous DOM tree.
      } else {
        const handle = await buyNowBtn.elementHandle().catch(() => null);
        if (handle) {
          await this.page.evaluate((el: any) => el.click(), handle);
        } else if (src.includes('banner') || src.includes('tile') || src.includes('dont-miss')) {
          // elementHandle went stale (carousel rotated) — re-click scoped to active slide only
          console.log('🔄 elementHandle stale — clicking Buy Now in active banner slide via evaluate');
          const clicked = await this.page.evaluate(() => {
            const activeSlide = document.querySelector(
              '.swiper-slide-active:not(.swiper-slide-duplicate), [class*="swiper-slide-active"]:not([class*="duplicate"])'
            );
            const root = activeSlide || document.querySelector('main') || document.body;
            const candidates = root.querySelectorAll('a, button');
            for (const btn of candidates) {
              if (/buy now/i.test(btn.textContent || '')) {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          }).catch(() => false);
          if (!clicked) {
            throw new Error(`❌ [${src}] elementHandle stale and active-slide fallback found no Buy Now button.`);
          }
        } else {
          await this.page.evaluate(() => {
            const btns = document.querySelectorAll('a, button');
            for (const btn of btns) {
              if (/buy now/i.test(btn.textContent || '')) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top > 0) {
                  (btn as HTMLElement).click();
                  return;
                }
              }
            }
          }).catch(() => { });
        }
      }
    }

    console.log(`✅ Clicked Buy Now`);
    await this.page.waitForLoadState('domcontentloaded').catch(() => { });

    const newUrl = this.page.url();
    console.log(`✅ Navigated to: ${newUrl}`);

    // Verify navigation
    if (newUrl !== beforeUrl && !newUrl.includes('ppv') &&
      !newUrl.includes('contextualPpv') && !newUrl.includes('signup')) {
      console.log(`⚠️  WARNING: Unexpected URL: ${newUrl}`);
    }
  }

  // ─────────────────────────────
  // GET EVENT DATE (from container)
  // ─────────────────────────────
  async getEventDate(container: any): Promise<string> {
    if (!container) return 'N/A';
    try {
      const allEls = container.locator('span, p, div, time');
      const count = await allEls.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const text = (await allEls.nth(i).textContent().catch(() => ''))?.trim() || '';
        if (/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(text) && text.length < 60) return text;
        if (/\d{1,2}(st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(text) && text.length < 60) return text;
        if (/this\s+evening/i.test(text) && text.length < 60) return text;
        if (/tonight/i.test(text) && text.length < 60) return text;
      }
    } catch { }
    return 'N/A';
  }
}
