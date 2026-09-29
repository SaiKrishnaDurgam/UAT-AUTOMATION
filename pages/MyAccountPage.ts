import { Page, Locator } from '@playwright/test';
import { handleCookies, hasLoadedPPVArtwork } from '../utils/helpers';
import { validateVariant } from '../flows/validateVariant';
import { getMyAccountData } from '../utils/excelReader';
import { compare } from '../utils/compare';
import { getDynamicDateTimeBadge, getNowForRegion } from '../utils/dateUtils';

const MY_ACCOUNT_PPV_CARD_MARKER = 'data-myaccount-ppv-card-target';

export class MyAccountPage {
  constructor(private page: Page) { }

  private eventNameRegex(ppvName: string): RegExp {
    const words = this.eventNameWords(ppvName)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (words.length === 0) {
      return new RegExp(ppvName.split(/\s+/).join('.*'), 'i');
    }
    return new RegExp(words.join('[^a-z0-9]+'), 'i');
  }

  async navigateAndValidatePurchasedPPVStatus(
    baseUrl: string,
    results: any[],
    eventData: Record<string, string>
  ): Promise<void> {
    console.log('\n🏠 [My Account] Validating purchased PPV status via Excel...');
    const myAccountUrl = `${baseUrl.replace(/\/$/, '')}/myaccount`;
    await this.page.goto(myAccountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

    if (!this.isOnMyAccountPage()) {
      const actualUrl = this.page.url();
      const message =
        `❌ [My Account] Navigation verification failed: expected My Account after navigating to "${myAccountUrl}", ` +
        `but landed on "${actualUrl}". PPV status cannot be verified.`;
      console.error(message);
      throw new Error(message);
    }

    await handleCookies(this.page, 8000);
    await this.scrollToPPVSection();

    const rows = getMyAccountData().filter((row: any) =>
      String(row.Field || '').trim().toLowerCase() === 'ppv status'
    );
    await validateVariant(this.page, 'myaccount', rows, results, eventData, 'My Account', 'myaccount');

    const statusResult = results
      .slice()
      .reverse()
      .find((r: any) => r.page === 'My Account' && r.field === 'PPV Status');
    if (statusResult?.status === 'FAIL') {
      throw new Error(
        `❌ [My Account] PPV Status validation failed. expected="${statusResult.expected}" actual="${statusResult.actual}"`
      );
    }
  }

  async hasPPV(ppvName: string): Promise<boolean> {
    const row = await this.searchPPVInCurrentDOM(ppvName);
    return row !== null;
  }

  /**
   * Ensure the requested PPV is visible before field-level validation. The
   * My Account overview shows only a short featured list; the full event list
   * is reached through "Explore more PPV events" at /myaccount/ppv.
   */
  async preparePPVValidation(ppvName: string): Promise<boolean> {
    try {
      const row = await this.findPPVRow(ppvName);
      if (!row) return false;
      await row.scrollIntoViewIfNeeded().catch(() => { });
      console.log(`✅ Prepared My Account PPV validation for "${ppvName}" on ${this.page.url()}`);
      return true;
    } catch (error: any) {
      console.warn(`⚠️ Unable to prepare My Account PPV validation for "${ppvName}": ${error?.message || 'unknown error'}`);
      return false;
    }
  }

  // ─────────────────────────────
  // PRIVATE: scroll done guard
  // Prevents double scroll when spec calls scrollToPPVSection()
  // and clickBuyNow is called immediately after
  // ─────────────────────────────
  private _ppvScrollDone = false;

  // ─────────────────────────────
  // DISMISS CONSENT OVERLAY
  // ─────────────────────────────
  private async dismissConsentIfPresent(): Promise<void> {
    await handleCookies(this.page);
  }

  private isOnMyAccountPage(): boolean {
    const url = this.page.url().toLowerCase();
    return (
      url.includes('/myaccount') ||
      (url.includes('/account') &&
        !url.includes('/signup') &&
        !url.includes('/signin') &&
        !url.includes('/personaldetails') &&
        !url.includes('/emaildetails') &&
        !url.includes('/content/'))
    );
  }

  private normalizeEventName(value: string): string {
    return value
      .toLowerCase()
      .replace(/\bv(?:s)?\.?\b/g, ' vs ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private eventNameWords(ppvName: string): string[] {
    return this.normalizeEventName(ppvName)
      .split(' ')
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs'].includes(w));
  }

  private isNearWordMatch(expected: string, actual: string): boolean {
    if (expected === actual) return true;
    if (expected.length < 5 || expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length - 1; i++) {
      const swapped = expected.slice(0, i) + expected[i + 1] + expected[i] + expected.slice(i + 2);
      if (swapped === actual) return true;
    }
    return false;
  }

  private isEventTitleText(text: string, ppvName: string): boolean {
    const cleanText = this.normalizeEventName(text);
    const cleanName = this.normalizeEventName(ppvName);
    if (!cleanText || !cleanName) return false;
    if (/entitlement[_\s-]+set[_\s-]+title|ppv_t_/i.test(text)) return false;
    if (cleanText === cleanName) return true;

    const words = this.eventNameWords(ppvName);
    if (words.length === 0 || text.length > 100) return false;
    const textWords = cleanText.split(' ');
    return words.every(word => textWords.some(textWord => this.isNearWordMatch(word, textWord)));
  }

  private async cardHasMatchingTitle(card: Locator, ppvName: string): Promise<boolean> {
    const titleCandidates = card.locator(
      'span, p, h1, h2, h3, h4, h5, strong, [id*="title" i], [class*="title" i]'
    );
    const count = await titleCandidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const text = ((await titleCandidates.nth(i).textContent().catch(() => '')) || '').trim();
      if (this.isEventTitleText(text, ppvName)) {
        return true;
      }
    }

    const cardText = ((await card.textContent().catch(() => '')) || '').trim();
    const ctaCount = await card
      .locator('div[role="button"], button, a')
      .filter({ hasText: /buy now|purchased|included/i })
      .count()
      .catch(() => 0);

    // Last resort for card structures that render no separate title element.
    // Keep this intentionally strict so a list containing multiple PPVs is not
    // accepted as the requested event card.
    return cardText.length > 0 && cardText.length <= 260 && ctaCount <= 1 && this.isEventTitleText(cardText, ppvName);
  }

  private async findVisiblePPVCardByDOM(ppvName: string): Promise<Locator | null> {
    const marked = await this.page.evaluate(({ marker, ppvName }: { marker: string; ppvName: string }) => {
      const clean = (value: string | null | undefined) =>
        String(value ?? '').replace(/\s+/g, ' ').trim();
      const normalize = (value: string) =>
        clean(value)
          .toLowerCase()
          .replace(/\bv(?:s)?\.?\b/g, ' vs ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const words = normalize(ppvName)
        .split(' ')
        .filter(word => word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs'].includes(word));

      document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
      if (!words.length) return false;

      const isVisible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
      };

      const isNearWordMatch = (expected: string, actual: string): boolean => {
        if (expected === actual) return true;
        if (expected.length < 5 || expected.length !== actual.length) return false;
        for (let i = 0; i < expected.length - 1; i++) {
          const swapped = expected.slice(0, i) + expected[i + 1] + expected[i] + expected.slice(i + 2);
          if (swapped === actual) return true;
        }
        return false;
      };

      const hasAllWords = (text: string): boolean => {
        if (/entitlement[_\s-]+set[_\s-]+title|ppv_t_/i.test(text)) return false;
        const textWords = normalize(text).split(' ');
        return words.every(word => textWords.some(textWord => isNearWordMatch(word, textWord)));
      };

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        'article, li, a, section, div'
      ));
      let best: HTMLElement | null = null;
      let bestScore = -Infinity;

      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = clean(el.innerText || el.textContent);
        if (text.length < 8 || text.length > 450) continue;
        if (!hasAllWords(text)) continue;

        const buyNowCount = (text.match(/\bbuy now\b/gi) || []).length;
        const statusCount = (text.match(/\b(?:buy now|purchased|included)\b/gi) || []).length;
        if (buyNowCount > 1 || statusCount > 1) continue;

        const hasPrice = /(?:(?:AED\s?|[£$€₹]\s?)\d+(?:[,.]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)/i.test(text);
        const hasDate = /\b(?:mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/i.test(text) &&
          (/\bat\b/i.test(text) || /\b\d{1,2}:\d{2}\b/.test(text) || /\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\b/.test(text));
        const hasCta = /\b(?:buy now|purchased|included)\b/i.test(text) ||
          !!el.querySelector('button, a, [role="button"]');
        const hasMedia = !!el.querySelector('img, picture, [role="img"], [style*="background-image"]');

        // A title/price wrapper is often nested inside the real PPV card. It is
        // sufficient for the name validation but has no date, CTA, or artwork,
        // which made the remaining My Account fields incorrectly return N/A.
        // Only mark a scope that contains at least two independent card signals.
        const signalCount = Number(hasPrice) + Number(hasDate) + Number(hasCta) + Number(hasMedia);
        if (signalCount < 2) continue;

        const rect = el.getBoundingClientRect();
        // Prefer the most complete individual card, then the most specific
        // container. This keeps the scope away from a whole PPV-list section.
        let score = signalCount * 10000;
        score -= text.length;
        score -= Math.max(0, rect.width - 500) / 10;

        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }

      if (!best) return false;
      best.setAttribute(marker, 'true');
      return true;
    }, { marker: MY_ACCOUNT_PPV_CARD_MARKER, ppvName }).catch(() => false);

    if (!marked) return null;
    const target = this.page.locator(`[${MY_ACCOUNT_PPV_CARD_MARKER}="true"]`).first();
    if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
      const cardText = ((await target.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      console.log(`✅ Matched My Account PPV card: "${cardText.slice(0, 160)}"`);
      return target;
    }
    return null;
  }

  // ─────────────────────────────
  // SCROLL TO PPV SECTION
  // Called ONCE from spec — guard prevents double scroll
  // ─────────────────────────────
  async scrollToPPVSection(): Promise<void> {
    if (this._ppvScrollDone) {
      console.log('📺 PPV scroll already done — skipping');
      return;
    }

    // FIX: Only scroll on My Account page — not home page
    if (!this.isOnMyAccountPage()) {
      console.log(`⚠️  Not on My Account page (${this.page.url()}) — skipping scroll`);
      this._ppvScrollDone = true;
      return;
    }

    console.log('📺 Scrolling to Pay-Per-View section...');

    // Wait up to 2 seconds for the PPV heading to be attached to the DOM
    const headingLocator = this.page.locator('h1, h2, h3, h4, h5, [class*="heading" i], [class*="title" i]')
      .filter({ hasText: /pay-per-view|pay per view|available to buy/i })
      .first();

    const targetScrollY = await headingLocator.waitFor({ state: 'attached', timeout: 5000 })
      .then(() => headingLocator.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const target = Math.max(0, window.scrollY + rect.top - 120);
        window.scrollTo({ top: target, behavior: 'instant' });
        return target;
      }))
      .catch(() => -1);

    if (targetScrollY >= 0) {
      console.log(`✅ Scrolled to PPV section at ${targetScrollY}px`);

      // Lock scroll for 2s — prevents page snapping back (DAZN scroll-hijacking)
      await this.page.evaluate((lockedY: number) => {
        const interval = setInterval(() => {
          if (Math.abs(window.scrollY - lockedY) > 50) {
            window.scrollTo({ top: lockedY, behavior: 'instant' });
          }
        }, 50);
        setTimeout(() => clearInterval(interval), 2000);
      }, targetScrollY);

      await this.page.waitForTimeout(2200);

      // Verify scroll position — re-scroll if page snapped back
      const checkY = await this.page.evaluate(() => window.scrollY).catch(() => 0);
      if (Math.abs(checkY - targetScrollY) > 100) {
        console.log(`⚠️  Scroll drifted to ${checkY}px (expected ~${targetScrollY}px) — re-scrolling`);
        await this.page.evaluate((y: number) => {
          window.scrollTo({ top: y, behavior: 'instant' });
        }, targetScrollY);
        await this.page.waitForTimeout(500);
      }

    } else {
      console.log('⚠️  PPV heading not found — scrolling to mid-page');
      try {
        await this.page.evaluate(() =>
          window.scrollTo({
            top: document.body.scrollHeight / 2,
            behavior: 'instant',
          })
        );
        await this.page.waitForTimeout(500);
      } catch (scrollErr: any) {
        console.warn(`⚠️  Scroll failed (page may have navigated): ${scrollErr.message}`);
      }
    }

    const finalY = await this.page
      .evaluate(() => window.scrollY)
      .catch(() => -1);
    console.log(`📍 Final scroll position: ${finalY}px`);

    this._ppvScrollDone = true;
  }

  private async searchPPVInCurrentDOM(ppvName: string): Promise<Locator | null> {
    const regex = this.eventNameRegex(ppvName);

    const domCard = await this.findVisiblePPVCardByDOM(ppvName);
    if (domCard) return domCard;

    // Strategy 0: prefer individual PPV cards and require a matching title
    // inside that card. The My Account page can render multiple PPVs inside one
    // list container; returning that parent makes date/price/clicks use the
    // first card instead of the requested PPV.
    const cardSelectorGroups = [
      '#addons-list-card',
      '[id*="ppv-card" i], [class*="ppv-card" i], [id*="ppv-tile" i], [class*="ppv-tile" i]',
      'article',
      'div[class*="card" i]:not([class*="list" i]):not([class*="container" i]):not([class*="wrapper" i])',
      'div[class*="tile" i], div[class*="event" i]:not([class*="list" i]):not([class*="container" i]):not([class*="wrapper" i])',
      'a[href*="/ppv"], a[href*="/pay-per-view"]',
    ];

    for (const selector of cardSelectorGroups) {
      const cards = this.page.locator(selector);
      const cardCount = await cards.count().catch(() => 0);
      for (let i = 0; i < cardCount; i++) {
        const card = cards.nth(i);
        const cardText = ((await card.textContent().catch(() => '')) || '').trim();
        if (!cardText || cardText.length > 500) continue;

        const ctaCount = await card
          .locator('div[role="button"], button, a')
          .filter({ hasText: /buy|get|book|continue|subscribe|purchase|select|choose/i })
          .count()
          .catch(() => 0);
        const subCardsCount = await card.locator('#addons-list-card, article, [class*="card" i]').count().catch(() => 0);
        if (ctaCount > 1 || subCardsCount > 1) continue;

        if (await this.cardHasMatchingTitle(card, ppvName)) {
          console.log(`✅ Matched PPV card text: "${cardText.replace(/\s+/g, ' ').slice(0, 160)}"`);
          return card;
        }
      }
    }

    // Strategy 1: Find name title element first, and walk up to find its card
    const titleLocator = this.page.locator('span, p, h2, h3, h4, h5, strong')
      .filter({ hasText: regex });
    const titleCount = await titleLocator.count().catch(() => 0);
    for (let i = 0; i < titleCount; i++) {
      const el = titleLocator.nth(i);
      const text = await el.textContent().catch(() => '');
      if (!text || text.length > 120 || !this.isEventTitleText(text, ppvName)) continue;

      let current = el;
      for (let depth = 0; depth < 5; depth++) {
        const parent = current.locator('xpath=..');
        const parentText = (await parent.textContent().catch(() => '')) || '';
        if (parentText.length > 350) break;
        const ctas = parent.locator('div[role="button"], button, a').filter({ hasText: /buy|get|book|continue|subscribe|purchase|select|choose/i });
        const ctaCount = await ctas.count().catch(() => 0);
        const subCardsCount = await parent.locator('#addons-list-card, article, [class*="card" i]').count().catch(() => 0);
        if (ctaCount > 1 || subCardsCount > 1) break;
        current = parent;
      }
      if (await this.cardHasMatchingTitle(current, ppvName)) {
        return current;
      }
    }

    // Strategy 2: Fallback to old candidate list-based scan
    const nameParts = ppvName
      .split(/[:\-–—,]+/)
      .flatMap(p => p.trim().split(/\s+/))
      .filter(w => w.length > 3 && !/^(the|and|for|with|from)$/i.test(w))
      .map(w => w.toLowerCase());
    const matchesPartially = (text: string): boolean => {
      const lower = text.toLowerCase();
      const matchCount = nameParts.filter(w => lower.includes(w)).length;
      return matchCount >= Math.min(2, nameParts.length);
    };

    const candidates = this.page.locator('div, li, article, section, a').filter({ hasText: regex });
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      const text = await el.textContent().catch(() => '');
      if (!text || text.length > 400) continue;

      const ctas = el.locator('div[role="button"], button, a').filter({ hasText: /buy|get|book|continue|subscribe|purchase|select|choose/i });
      const ctaCount = await ctas.count().catch(() => 0);
      const subCardsCount = await el.locator('#addons-list-card, article, [class*="card" i]').count().catch(() => 0);
      if (ctaCount > 1 || subCardsCount > 1) {
        continue;
      }

      const tagName = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
      const role = await el.getAttribute('role').catch(() => null);
      const isSelfCTA = tagName === 'a' || tagName === 'button' || role === 'button';
      const hasCTA = isSelfCTA || ctaCount > 0;
      if (hasCTA && await this.cardHasMatchingTitle(el, ppvName)) return el;

      const elText = text.toLowerCase();
      const hasPurchasedText = elText.includes('purchased') || elText.includes('included');
      if (hasPurchasedText && text.length < 200 && await this.cardHasMatchingTitle(el, ppvName)) return el;
    }

    // Strategy 3: Try partial matching on cards
    const cardSelectors = [
      '#addons-list-card',
      'div[id*="ppv-card" i]',
      'div[class*="ppv-card" i]',
      'div[id*="ppv-tile" i]',
      'div[class*="ppv-tile" i]',
      'article',
      'div[class*="card" i]:not([class*="list" i]):not([class*="container" i]):not([class*="wrapper" i])',
      'div[id*="card" i]:not([id*="list" i]):not([id*="container" i]):not([id*="wrapper" i])',
      'div[class*="tile" i]',
      'div[class*="event" i]:not([class*="list" i]):not([class*="container" i]):not([class*="wrapper" i])',
      'a[href*="/ppv"]',
      'a[href*="/pay-per-view"]',
    ];
    const allCards = this.page.locator(cardSelectors.join(', '));
    const cardCount = await allCards.count().catch(() => 0);

    for (let i = 0; i < cardCount; i++) {
      const card = allCards.nth(i);
      const cardText = await card.textContent().catch(() => '');
      if (!cardText || cardText.length > 400) continue;

      if (matchesPartially(cardText)) {
        const ctas = card.locator('div[role="button"], button, a').filter({ hasText: /buy|get|book|continue|subscribe|purchase|select|choose/i });
        const ctaCount = await ctas.count().catch(() => 0);
        const subCardsCount = await card.locator('#addons-list-card, article, [class*="card" i]').count().catch(() => 0);
        if (ctaCount > 1 || subCardsCount > 1) {
          continue;
        }

        const tagName = await card.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
        const role = await card.getAttribute('role').catch(() => null);
        const isSelfCTA = tagName === 'a' || tagName === 'button' || role === 'button';
        const hasCTA = isSelfCTA || ctaCount > 0;
        if (hasCTA && await this.cardHasMatchingTitle(card, ppvName)) return card;

        const hasPurchased = cardText.toLowerCase().includes('purchased') || cardText.toLowerCase().includes('included');
        if (hasPurchased && cardText.length < 200 && await this.cardHasMatchingTitle(card, ppvName)) return card;
      }
    }

    return null;
  }

  // ─────────────────────────────
  // FIND PPV ROW BY EVENT NAME
  // ─────────────────────────────
  private async findPPVRow(ppvName: string): Promise<Locator | null> {
    console.log(`🔍 Searching for PPV: "${ppvName}"...`);

    // Wait for the My Account page sections/cards to load
    if (this.isOnMyAccountPage()) {
      console.log('⏳ Waiting for PPV section, cards, or Explore button to be attached to DOM...');
      const exploreSelector = 'a[href*="/ppv"]:not([href*="#"]), a[href*="/pay-per-view"]:not([href*="#"])';
      const cardSelector = '[id*="ppv-card"], [class*="ppv-card"], article, [class*="card" i], h2, h3';
      const combinedSelector = `${exploreSelector}, ${cardSelector}`;

      await this.page.waitForSelector(combinedSelector, { state: 'attached', timeout: 8000 }).catch(() => {
        console.log('⚠️ Timeout waiting for PPV related elements to attach to DOM');
      });
      await this.page.waitForTimeout(200);
    }

    // 1. Search in current DOM (My Account PPV section or Listing Page if already navigated)
    let row = await this.searchPPVInCurrentDOM(ppvName);
    if (row) {
      console.log(`✅ PPV row found in current view`);
      return row;
    }

    // 2. If not found, check if we are on My Account page
    if (this.isOnMyAccountPage()) {
      console.log(`ℹ️  PPV not found in My Account page — looking for "Explore more PPV events" link...`);

      let exploreBtn = this.page.getByText(/explore.*ppv/i).first();
      let isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);

      if (!isExploreVisible) {
        exploreBtn = this.page.getByText(/explore.*pay-per-view/i).first();
        isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (!isExploreVisible) {
        exploreBtn = this.page.locator('a[href*="/ppv"]:not([href*="#"]), a[href*="/pay-per-view"]:not([href*="#"])').first();
        isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (isExploreVisible) {
        console.log(`🖱️  Clicking "Explore more PPV events" link...`);
        await exploreBtn.scrollIntoViewIfNeeded().catch(() => { });
        await exploreBtn.click({ force: true });

        // Wait for page load
        console.log(`⏳ Waiting for PPV listing page to load...`);
        await this.page.waitForLoadState('domcontentloaded').catch(() => { });
        console.log(`⏳ Waiting for PPV cards to render...`);
        await this.page.waitForSelector(
          '#addons-list-card, article, [class*="card" i], button:has-text("Buy now")',
          { state: 'visible', timeout: 10000 }
        ).catch(() => { });

        // 3. Search on the PPV listing page with auto-scroll
        console.log(`📜 Searching PPV on listing page with auto-scroll...`);
        let lastScrollY = -1;
        let currentScrollY = 0;

        while (currentScrollY !== lastScrollY) {
          row = await this.searchPPVInCurrentDOM(ppvName);
          if (row) {
            console.log(`✅ PPV row found on listing page!`);
            return row;
          }

          // Scroll down
          lastScrollY = currentScrollY;
          await this.page.evaluate(() => window.scrollBy(0, 600)).catch(() => { });
          await this.page.waitForTimeout(500);
          currentScrollY = await this.page.evaluate(() => window.scrollY).catch(() => 0);
        }
      }
    }

    // Debug dump on failure
    const sectionHtml = await this.page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('h2, h3'));
      for (const el of allEls) {
        if (/pay-per-view/i.test((el as HTMLElement).innerText || '')) {
          return el.parentElement?.innerHTML?.substring(0, 2000) || 'N/A';
        }
      }
      return 'PPV section not found in DOM';
    }).catch(() => 'evaluate failed');
    console.log('🔍 PPV section HTML:\n', sectionHtml);

    // 4. PPV still not found -> Throw the critical error requested
    throw new Error(`PPV '${ppvName}' not found in My Account PPV section or Explore More PPV Events page.`);
  }

  // ─────────────────────────────
  // GET USER FULL NAME PARTS
  // Single DOM scan — anchors on email to avoid "My" from
  // "My Subscriptions" / "My Account"
  // Returns { firstName, lastName }
  // ─────────────────────────────
  async getUserName(): Promise<{ firstName: string; lastName: string }> {
    console.log('👤 Reading user name from My Account...');

    const EXCLUDE = [
      'my account', 'my subscriptions', 'my devices',
      'dazn free', 'dazn standard', 'dazn ultimate',
      'member since', 'back to dazn', 'need help',
      'overview', 'profile', 'manage', 'quick links',
      'pay-per-view', 'upgrade now', 'resubscribe',
      'view payment history',
      'explore other',
      'more on dazn',
      'redeem gift',
      'home location',
    ];

    const fullName = await this.page.evaluate((excludeList: string[]) => {
      const isNameLike = (text: string): boolean => {
        const lower = text.toLowerCase();
        return (
          text.length >= 2 &&
          text.length <= 50 &&
          !text.includes('@') &&
          !text.includes('£') &&
          !excludeList.some(ex => lower.includes(ex)) &&
          !/\d/.test(text) &&
          /^[A-Z][a-z]/.test(text) &&
          /^[A-Za-z\s\-']+$/.test(text)
        );
      };

      const allEls = Array.from(
        document.querySelectorAll<HTMLElement>('p, span, div, h2, h3')
      );

      // Step 1: Anchor on email — name is always near it
      let emailEl: HTMLElement | null = null;
      for (const el of allEls) {
        const text = el.innerText?.trim() || '';
        if (
          text.includes('@') &&
          text.includes('.') &&
          text.length < 60 &&
          !text.includes(' ')  // email has no spaces
        ) {
          emailEl = el;
          break;
        }
      }

      if (emailEl) {
        // Walk up 3 levels from email to find name sibling
        for (let depth = 0; depth < 3; depth++) {
          let container: HTMLElement | null = emailEl;
          for (let d = 0; d <= depth; d++) {
            container = container?.parentElement ?? null;
          }
          if (!container) continue;

          const siblings = Array.from(
            container.querySelectorAll<HTMLElement>('p, span, h2, h3')
          );

          for (const sib of siblings) {
            const text = sib.innerText?.trim() || '';
            // Full name = at least 2 words
            if (isNameLike(text) && text.split(/\s+/).length >= 2) {
              return text.trim();
            }
          }
        }
      }

      // Step 2: Full page scan with strict exclusions
      for (const el of allEls) {
        const text = el.innerText?.trim() || '';
        if (isNameLike(text) && text.split(/\s+/).length >= 2) {
          return text.trim();
        }
      }

      return '';
    }, EXCLUDE).catch(() => '');

    if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      console.log(
        `✅ Full name: "${fullName}" → ` +
        `first="${firstName}" last="${lastName}"`
      );
      return { firstName, lastName };
    }

    console.log('⚠️  User name not found');
    return { firstName: '', lastName: '' };
  }

  // ─────────────────────────────
  // GET FIRST NAME (convenience wrapper)
  // ─────────────────────────────
  async getFirstName(): Promise<string> {
    const { firstName } = await this.getUserName();
    return firstName;
  }

  // ─────────────────────────────
  // GET LAST NAME (convenience wrapper)
  // ─────────────────────────────
  async getLastName(): Promise<string> {
    const { lastName } = await this.getUserName();
    return lastName;
  }

  // ─────────────────────────────
  // IS RETURNING USER
  // Returning = lapsed subscription, "Resubscribe" button visible
  // ─────────────────────────────
  async isReturningUser(): Promise<boolean> {
    const resubscribe = this.page
      .locator('button:has-text("Resubscribe")')
      .first();
    const isReturning = await resubscribe
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    console.log(`🔄 Returning user: ${isReturning}`);
    return isReturning;
  }

  // ─────────────────────────────
  // VALIDATE MY ACCOUNT PAGE
  // ─────────────────────────────
  async getSubscriptionTier(): Promise<string> {
    const el = this.page
      .locator('text=/DAZN (Free|Standard|Ultimate|VIP)/i')
      .first();
    return (
      (await el.textContent({ timeout: 5000 }).catch(() => 'N/A'))?.trim() ||
      'N/A'
    );
  }

  async getSubscriptionStatus(): Promise<string> {
    // ── Resubscribe — returning/lapsed user ───────────────────
    const resubscribe = this.page
      .locator('button:has-text("Resubscribe")')
      .first();
    if (await resubscribe.isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'Resubscribe';
    }

    // ── Upgrade now — freemium user ───────────────────────────
    const upgrade = this.page
      .locator('button:has-text("Upgrade now")')
      .first();
    if (await upgrade.isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'Upgrade now';
    }

    // ── Manage subscription — active paid user (US/other regions)
    const manage = this.page
      .locator(
        'a:has-text("Manage subscription"), ' +
        'button:has-text("Manage subscription")'
      )
      .first();
    if (await manage.isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'Manage subscription';
    }

    // ── Fallback — active user with no specific button ────────
    return 'Active';
  }
  async isPPVSectionPresent(): Promise<boolean> {
    const heading = this.page
      .locator('h2, h3')
      .filter({ hasText: /pay-per-view/i })
      .first();
    return await heading.isVisible({ timeout: 5000 }).catch(() => false);
  }

  // ─────────────────────────────
  // GET PPV DETAILS
  // ─────────────────────────────
  async getPPVName(ppvName: string): Promise<string> {
    const row = await this.findPPVRow(ppvName);
    if (!row) return 'N/A';
    const titleCandidates = row.locator('span, p, h2, h3, h4, strong, [id*="title" i], [class*="title" i]');
    const count = await titleCandidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = titleCandidates.nth(i);
      const isLeaf = await candidate.evaluate((element: Element) => element.children.length === 0).catch(() => false);
      if (!isLeaf) continue;

      const text = ((await candidate.textContent().catch(() => '')) || '').trim();
      if (
        text &&
        text.length <= 120 &&
        !/\b\d{1,2}:\d{2}\b|(?:AED\s?|[£$€₹]\s?)\d|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr|buy now/i.test(text) &&
        this.isEventTitleText(text, ppvName)
      ) {
        return text;
      }
    }
    return 'N/A';
  }

  async getPPVDate(ppvName: string): Promise<string> {
    const row = await this.findPPVRow(ppvName);
    if (!row) return 'N/A';
    const readDate = (text: string): string => {
      const shortDateMatch = text.match(
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(?:\s+at\s+\d{1,2}:\d{2}(?:\s*(?:A\.?M\.?|P\.?M\.?))?)?(?![A-Za-z])/i
      );
      if (shortDateMatch) return shortDateMatch[0].trim();

      const weekdayTimeMatch = text.match(
        /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+at\s+\d{1,2}:\d{2}(?:\s*(?:A\.?M\.?|P\.?M\.?))?(?![A-Za-z])/i
      );
      return weekdayTimeMatch?.[0].trim() || '';
    };

    const rowDate = readDate(
      (await row.innerText().catch(() => '')) ||
      (await row.textContent().catch(() => '')) ||
      ''
    );
    if (rowDate) return rowDate;

    const allEls = row.locator('span, p, div, time');
    const count = await allEls.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const text =
        (await allEls.nth(i).innerText().catch(() => ''))?.trim() ||
        (await allEls.nth(i).textContent().catch(() => ''))?.trim() ||
        '';
      const date = readDate(text);
      if (date) return date;
    }
    return 'N/A';
  }

  async getPPVPrice(ppvName: string): Promise<string> {
    const row = await this.findPPVRow(ppvName);
    if (!row) return 'N/A';
    const pricePattern = /(?:(?:AED\s?|[£$€₹]\s?)[\d,.]+|[\d\s]+(?:[.,]\d{2,3})?\s*kr)/i;
    const rowText = (await row.textContent().catch(() => ''))?.trim() || '';
    const rowPrice = rowText.match(pricePattern);
    if (rowPrice) return rowPrice[0].trim();

    const el = row
      .locator('span, p, div')
      .filter({ hasText: /(?:(?:AED\s?|[£$€₹]\s?)[\d,.]+|[\d\s]+(?:[.,]\d{2,3})?\s*kr)/i })
      .first();
    const text = (await el.textContent().catch(() => 'N/A'))?.trim() || 'N/A';
    if (text === 'N/A') return 'N/A';
    const match = text.match(pricePattern);
    return match ? match[0].trim() : text;
  }

  async getPPVStatus(ppvName: string): Promise<string> {
    const row = await this.findPPVRow(ppvName);
    if (!row) return 'N/A';

    const rowText = ((await row.textContent().catch(() => '')) || '').trim();
    if (/\bbuy now\b/i.test(rowText)) return 'Buy now';
    if (/\bpurchased\b/i.test(rowText)) return 'Purchased';
    if (/\bincluded\b/i.test(rowText)) return 'Included';

    // Check Buy Now — freemium / standard
    const buyNow = row
      .locator('div[role="button"], a, button')
      .filter({ hasText: /buy now/i })
      .first();
    if (await buyNow.isVisible({ timeout: 2000 }).catch(() => false)) {
      return 'Buy now';
    }

    // Check Purchased / Included — ultimate
    const purchased = row
      .locator(
        'text=/purchased/i, ' +
        'text=/included/i, ' +
        '[class*="purchased" i], ' +
        '[class*="included" i]'
      )
      .first();
    if (await purchased.isVisible({ timeout: 2000 }).catch(() => false)) {
      return (await purchased.textContent().catch(() => 'Purchased'))?.trim() || 'Purchased';
    }

    const pageStatus = await this.isPPVPurchased(ppvName);
    return pageStatus && pageStatus !== 'N/A' ? pageStatus : 'N/A';
  }

  async hasPPVImage(ppvName: string): Promise<boolean> {
    console.log(`🔍 Checking PPV image presence for: ${ppvName}`);
    const row = await this.findPPVRow(ppvName);
    if (!row) {
      console.log('⚠️ PPV row not found when checking image');
      return false;
    }
    const hasArtwork = await hasLoadedPPVArtwork(row, ppvName);
    console.log(hasArtwork
      ? '✅ PPV event artwork is loaded in row'
      : 'ℹ️ PPV row has no loaded event artwork or contains a DAZN placeholder');
    return hasArtwork;
  }


  // ─────────────────────────────
  // IS PPV PURCHASED / INCLUDED
  // For ultimate tier — PPV shows "Purchased" or "Included"
  // No Buy Now button present
  // ─────────────────────────────
  async isPPVPurchased(ppvName: string): Promise<string> {
    console.log(`🔍 Checking PPV purchased status for: ${ppvName}`);

    // FIX: Use direct DOM query to find the specific PPV card
    // The PPV section has individual cards with id="purchased-ppv-card"
    // Each card has a name span and a status tag
    const result = await this.page.evaluate((name: string) => {
      const normalize = (value: string) =>
        value.toLowerCase()
          .replace(/\bv(?:s)?\.?\b/g, ' vs ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const isNearWordMatch = (expected: string, actual: string): boolean => {
        if (expected === actual) return true;
        if (expected.length < 5 || expected.length !== actual.length) return false;
        for (let i = 0; i < expected.length - 1; i++) {
          const swapped = expected.slice(0, i) + expected[i + 1] + expected[i] + expected.slice(i + 2);
          if (swapped === actual) return true;
        }
        return false;
      };
      const nameParts = normalize(name)
        .split(/\s+/)
        .filter(part => part.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs'].includes(part));
      const hasName = (text: string): boolean => {
        const textWords = normalize(text).split(/\s+/);
        return nameParts.length > 0 &&
          nameParts.every(part => textWords.some(word => isNearWordMatch(part, word)));
      };
      const isVisible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        '[id*="ppv-card"], [id*="ppv-list"] > div > div, article, li, section, div'
      ))
        .filter(el => isVisible(el))
        .map(el => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim() }))
        .filter(({ text }) => text.length >= 10 && text.length <= 500 && hasName(text))
        .sort((a, b) => a.text.length - b.text.length);

      for (const { text } of candidates) {
        if (/purchased/i.test(text)) return 'Purchased';
        if (/included/i.test(text)) return 'Included';
        if (/buy now/i.test(text)) return 'Buy now';
      }
      return 'N/A';
    }, ppvName).catch(() => 'N/A');

    console.log(`✅ PPV Status: "${result}"`);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST-PAYMENT: Navigate to My Account and validate PPV status = Purchased
  // Called after successful stag payment for both new and existing users
  // ─────────────────────────────────────────────────────────────────────────
  async navigateToMyAccountAndValidatePPVStatus(
    ppvName: string,
    results: any[],
    eventData: Record<string, string>
  ): Promise<void> {
    console.log('\n🏠 [Post-Payment] Navigating to My Account to validate PPV status...');

    // STEP 1: Extract base URL from current page URL
    const currentUrl = this.page.url();
    const baseMatch = currentUrl.match(/(https:\/\/[a-z0-9.-]*dazn\.com\/en-[A-Z]+)/i);
    let base = baseMatch?.[1] || '';

    // Fallback: build base URL from env vars if not extractable from URL
    if (!base) {
      const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
      let region = (process.env.DAZN_REGION || 'GB').toUpperCase();
      if (region === 'UAE') region = 'AE';
      const domain =
        env === 'prod' ? 'www.dazn.com' :
          env === 'beta' ? 'beta.dazn.com' :
            'stag.dazn.com';
      base = `https://${domain}/en-${region}`;
      console.log(`🔗 [Post-Payment] Using fallback base URL: ${base}`);
    }

    const myAccountUrl = `${base}/myaccount`;
    const isMobileWeb = String(eventData?.MOBILE_WEB_HANDOFF || '').toLowerCase() === 'true';

    // STEP 2: Skip navigation only when a mobile handoff has already redirected to My Account.
    const currentUrlLower = this.page.url().toLowerCase();
    if (isMobileWeb && (currentUrlLower.includes('myaccount') || currentUrlLower.includes('/account'))) {
      console.log('✅ [Post-Payment] Already on My Account page (Mobile Handoff) — skipping navigation');
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
    } else {
      console.log(`🔗 [Post-Payment] Navigating to: ${myAccountUrl}`);
      try {
        await this.page.goto(myAccountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      } catch (e: any) {
        console.log(`⚠️ [Post-Payment] Navigation to My Account failed: ${e.message}`);
        results.push({
          page: 'My Account (Post-Payment)',
          field: 'PPV Status After Purchase',
          expected: 'Purchased',
          actual: `Navigation failed: ${e.message}`,
          status: 'FAIL',
        });
        return;
      }
    }

    console.log(`✅ [Post-Payment] On My Account: ${this.page.url()}`);

    // STEP 3: Dismiss consent/cookies if present
    await this.dismissConsentIfPresent();

    // STEP 4: Wait for My Account content to load
    console.log('⏳ [Post-Payment] Waiting for My Account content to load...');
    const contentFound = await Promise.race([
      this.page.waitForSelector(
        'button:has-text("Manage subscription"), button:has-text("Manage"), ' +
        '[data-testid*="subscription" i], h2, h3',
        { state: 'visible', timeout: 20000 }
      ).then(() => true).catch(() => false),
    ]);

    if (!contentFound) {
      console.log('⚠️ [Post-Payment] My Account content not found within 20s — proceeding anyway');
    } else {
      console.log('✅ [Post-Payment] My Account content loaded');
    }

    // Small stabilisation wait
    await this.page.waitForTimeout(1500);

    // STEP 5: Scroll to PPV section
    console.log('📺 [Post-Payment] Scrolling to PPV section...');
    const scrolled = await this.page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,span,div'));
      const ppvHeadings = ['pay-per-view', 'pay per view', 'available to buy'];
      for (const el of allEls) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || '';
        if (ppvHeadings.some(h => text === h)) {
          const rect = el.getBoundingClientRect();
          const target = Math.max(0, window.scrollY + rect.top - 120);
          window.scrollTo({ top: target, behavior: 'instant' });
          return target;
        }
      }
      // Fallback: scroll to mid-page
      window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
      return -1;
    }).catch(() => -1);

    if (scrolled >= 0) {
      console.log(`✅ [Post-Payment] Scrolled to PPV section at ${scrolled}px`);
    } else {
      console.log('⚠️ [Post-Payment] PPV section heading not found — scrolled to mid-page');
    }

    await this.page.waitForTimeout(1000);

    // STEP 6: Check if PPV is on My Account page directly
    let ppvStatus = 'N/A';

    // First attempt: search in current DOM
    ppvStatus = await this.isPPVPurchased(ppvName);
    console.log(`🔍 [Post-Payment] PPV status from My Account DOM: "${ppvStatus}"`);

    // If not found in My Account, navigate to PPV listing page
    if (ppvStatus === 'N/A' || ppvStatus === 'Buy now') {
      console.log('🔍 [Post-Payment] PPV not found directly — checking for "Explore more PPV events" link...');

      let exploreBtn = this.page.getByText(/explore.*ppv/i).first();
      let isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);

      if (!isExploreVisible) {
        exploreBtn = this.page.getByText(/explore.*pay-per-view/i).first();
        isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (!isExploreVisible) {
        exploreBtn = this.page.locator('a[href*="/ppv"]:not([href*="#"]), a[href*="/pay-per-view"]:not([href*="#"])').first();
        isExploreVisible = await exploreBtn.isVisible({ timeout: 2000 }).catch(() => false);
      }

      if (isExploreVisible) {
        console.log('🖱️ [Post-Payment] Clicking "Explore more PPV events" link...');
        await exploreBtn.scrollIntoViewIfNeeded().catch(() => { });
        await exploreBtn.click({ force: true });

        await this.page.waitForLoadState('domcontentloaded').catch(() => { });
        await this.page.waitForSelector(
          '#addons-list-card, article, [class*="card" i], button:has-text("Buy now"), text=/Purchased/i',
          { state: 'visible', timeout: 10000 }
        ).catch(() => { });

        // Scroll and search on listing page
        let lastScrollY = -1;
        let currentScrollY = 0;
        while (currentScrollY !== lastScrollY) {
          ppvStatus = await this.isPPVPurchased(ppvName);
          if (ppvStatus !== 'N/A') break;
          lastScrollY = currentScrollY;
          await this.page.evaluate(() => window.scrollBy(0, 600)).catch(() => { });
          await this.page.waitForTimeout(500);
          currentScrollY = await this.page.evaluate(() => window.scrollY).catch(() => 0);
        }
        console.log(`🔍 [Post-Payment] PPV status from listing page: "${ppvStatus}"`);
      } else {
        console.log('⚠️ [Post-Payment] "Explore more PPV events" link not found');
      }
    }

    // STEP 7: Push validation result
    const expectedStatus = 'Purchased';
    const statusMatches =
      ppvStatus.toLowerCase().includes('purchased') ||
      ppvStatus.toLowerCase().includes('included');
    const finalStatus = statusMatches ? 'PASS' : 'FAIL';

    console.log(`  ${finalStatus === 'PASS' ? '✅' : '❌'} [PPV Status After Purchase] expected="${expectedStatus}" actual="${ppvStatus}"`);
    results.push({
      page: 'My Account (Post-Payment)',
      field: 'PPV Status After Purchase',
      expected: expectedStatus,
      actual: ppvStatus,
      status: finalStatus,
    });

    // Detailed validations for PPV card contents: PPV Image, PPV Title, PPV Date/Time, and Purchased Text
    console.log('🔍 [Post-Payment] Extracting detailed PPV card information for validations...');
    const cardData: any = await this.page.evaluate(({ name, expectedTitle, expectedDate }: { name: string; expectedTitle: string; expectedDate: string }) => {
      const normalize = (value: string) =>
        (value || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\bv(?:s)?\.?\b/g, ' vs ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const rawTerms = `${name} ${expectedTitle || ''}`;
      const searchTerms = normalize(rawTerms)
        .split(/\s+/)
        .filter(part => part.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs', 'ppv', 'event'].includes(part));

      const isVisible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const scoreElement = (text: string) => {
        const norm = normalize(text);
        let matches = 0;
        for (const term of searchTerms) {
          if (norm.includes(term)) matches++;
        }
        return matches;
      };

      const allContainers = Array.from(document.querySelectorAll<HTMLElement>(
        '[id*="ppv-card"], [id*="ppv-list"] > div > div, [id*="purchased-ppv-card"], [class*="card" i], article, li'
      )).filter(el => isVisible(el));

      let candidateCards = allContainers.filter(el => {
        const text = (el.innerText || '').trim();
        return text.length >= 10 && text.length <= 600 && scoreElement(text) > 0;
      });

      candidateCards = candidateCards.filter(card => {
        return !candidateCards.some(other => other !== card && card.contains(other));
      });

      if (candidateCards.length === 0) {
        const broadEls = Array.from(document.querySelectorAll<HTMLElement>('div, section, article'))
          .filter(el => isVisible(el) && (el.innerText || '').length >= 10 && (el.innerText || '').length <= 400 && scoreElement(el.innerText || '') > 0);
        candidateCards = broadEls.filter(card => !broadEls.some(other => other !== card && card.contains(other)));
      }

      candidateCards.sort((a, b) => {
        const scoreA = scoreElement(a.innerText || '');
        const scoreB = scoreElement(b.innerText || '');
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (a.innerText || '').length - (b.innerText || '').length;
      });

      const matchedCard = candidateCards[0];
      if (!matchedCard) {
        return { found: false };
      }

      const cardText = (matchedCard.innerText || '').trim();
      const findImg = (el: HTMLElement | null): boolean => {
        if (!el) return false;
        const imgEl = el.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
        if (imgEl) {
          if (imgEl.tagName.toLowerCase() === 'img') {
            const src = imgEl.getAttribute('src') || imgEl.getAttribute('srcset');
            return !!src;
          }
          return true;
        }
        const cardParent = el.closest('[id*="ppv"], [id*="card"], [class*="card" i], article, li, section');
        if (cardParent && cardParent !== el) {
          const parentImg = cardParent.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
          if (parentImg) {
            if (parentImg.tagName.toLowerCase() === 'img') {
              const src = parentImg.getAttribute('src') || parentImg.getAttribute('srcset');
              return !!src;
            }
            return true;
          }
        }
        if (el.parentElement) {
          const siblingImg = el.parentElement.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
          if (siblingImg) return true;
        }
        return false;
      };
      const imgPresent = findImg(matchedCard) ? 'Yes' : 'No';

      const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
      let title = '';
      let dateTimeStr = '';
      let purchasedText = '';

      const dateRegex = /\b((Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(?:at|•)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i;

      for (const line of lines) {
        if (scoreElement(line) > 0 && !title) {
          title = line;
        } else if (/purchased/i.test(line) || /included/i.test(line)) {
          purchasedText = line;
        } else if (dateRegex.test(line) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(line) || /\d{1,2}:\d{2}/.test(line)) {
          if (!dateTimeStr) dateTimeStr = line;
        }
      }

      if (!dateTimeStr) {
        const dateMatch = cardText.match(dateRegex);
        if (dateMatch) dateTimeStr = dateMatch[0];
      }
      if (!purchasedText) {
        if (/purchased/i.test(cardText)) purchasedText = 'Purchased';
        else if (/included/i.test(cardText)) purchasedText = 'Included';
      }

      return {
        found: true,
        imagePresent: imgPresent,
        title: title || lines[0] || '',
        dateTime: dateTimeStr || lines[1] || '',
        purchasedText: purchasedText || 'Not found',
        fullText: cardText,
      };
    }, {
      name: ppvName,
      expectedTitle: eventData?.PPV_DISPLAY_NAME || eventData?.PPV_NAME || ppvName,
      expectedDate: eventData?.PPV_DATE || '',
    }).catch(() => ({ found: false }));

    if (cardData && cardData.found) {
      console.log('✅ PPV card details found: ', JSON.stringify(cardData));

      // 1. PPV Image Present
      const imgStatus = cardData.imagePresent === 'Yes' ? 'PASS' : 'FAIL';
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Image Present',
        expected: 'Yes',
        actual: cardData.imagePresent,
        status: imgStatus,
      });

      // 2. PPV Title
      const expectedTitle = eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || ppvName;
      const normalizeStr = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const titleStatus = normalizeStr(cardData.title).includes(normalizeStr(expectedTitle)) || normalizeStr(expectedTitle).includes(normalizeStr(cardData.title)) || (normalizeStr(expectedTitle).split(/\s+/).filter(w => w.length > 2 && w !== 'vs').some(w => normalizeStr(cardData.title).includes(w))) ? 'PASS' : 'FAIL';
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Title',
        expected: expectedTitle,
        actual: cardData.title,
        status: titleStatus,
      });

      // 3. PPV Date & Time
      const expectedDate = eventData.PPV_DATE || '';
      const normalizeDate = (val: string) => {
        return (val || '').toLowerCase()
          .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
          .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
          .replace(/a\.\s*m\./gi, 'am')
          .replace(/p\.\s*m\./gi, 'pm')
          .replace(/\s+/g, ' ')
          .trim();
      };
      const checkDateMatch = (act: string, exp: string): boolean => {
        if (!exp) return true;
        if (compare(act, exp)) return true;
        const dynamicExpected = getDynamicDateTimeBadge(
          exp,
          getNowForRegion(eventData.DAZN_REGION || eventData.REGION),
        );
        if (dynamicExpected && compare(act, dynamicExpected)) return true;
        const expNorm = normalizeDate(exp);
        const actNorm = normalizeDate(act);
        if (actNorm === expNorm || actNorm.includes(expNorm) || expNorm.includes(actNorm)) return true;

        const parseTimeAndWk = (val: string) => {
          const clean = (val || '').toLowerCase()
            .replace(/a\.\s*m\./gi, 'am')
            .replace(/p\.\s*m\./gi, 'pm')
            .replace(/\s+/g, ' ').trim();
          const wk = clean.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i)?.[1]?.toLowerCase();
          const tm = clean.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) || clean.match(/(\d{1,2})\s*(am|pm)/i);
          if (!tm) return { wk, h: null, m: null };
          let h = parseInt(tm[1], 10);
          const min = tm[2] && !isNaN(parseInt(tm[2], 10)) ? parseInt(tm[2], 10) : 0;
          const meridiem = (tm[3] || (isNaN(parseInt(tm[2], 10)) ? tm[2] : ''))?.toLowerCase();
          if (meridiem === 'pm' && h < 12) h += 12;
          if (meridiem === 'am' && h === 12) h = 0;
          return { wk, h, m: min };
        };

        const expP = parseTimeAndWk(exp);
        const actP = parseTimeAndWk(act);
        if (expP.wk && actP.wk && expP.wk === actP.wk) {
          if (expP.h !== null && actP.h !== null) {
            return expP.h === actP.h && expP.m === actP.m;
          }
          return true;
        }
        return false;
      };
      const dateStatus = checkDateMatch(cardData.dateTime, expectedDate) ? 'PASS' : 'FAIL';
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Date & Time',
        expected: expectedDate,
        actual: cardData.dateTime,
        status: dateStatus,
      });

      // 4. Purchased Text
      const purchasedStatus = cardData.purchasedText.toLowerCase().includes('purchased') || cardData.purchasedText.toLowerCase().includes('included') ? 'PASS' : 'FAIL';
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'Purchased Text',
        expected: 'Purchased',
        actual: cardData.purchasedText,
        status: purchasedStatus,
      });
    } else {
      console.log('⚠️ PPV card details not found in My Account page.');
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Image Present',
        expected: 'Yes',
        actual: 'PPV event card not found',
        status: 'FAIL',
      });
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Title',
        expected: eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || ppvName,
        actual: 'PPV event card not found',
        status: 'FAIL',
      });
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'PPV Date & Time',
        expected: eventData.PPV_DATE || '',
        actual: 'PPV event card not found',
        status: 'FAIL',
      });
      results.push({
        page: 'My Account (Post-Payment)',
        field: 'Purchased Text',
        expected: 'Purchased',
        actual: 'PPV event card not found',
        status: 'FAIL',
      });
    }

    if (finalStatus === 'PASS') {
      console.log(`✅ [Post-Payment] PPV status confirmed as "${ppvStatus}" — purchase verified!`);
    } else {
      console.log(`❌ [Post-Payment] PPV status is "${ppvStatus}" — expected "Purchased"`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATE PPV ON CURRENT PAGE (no navigation)
  // Validates PPV image, title, date/time and purchased text on the page
  // that is already loaded (e.g. My Account after auto-redirect post-login)
  // ─────────────────────────────────────────────────────────────────────────
  async validatePPVOnCurrentPage(
    ppvName: string,
    results: any[],
    eventData: any
  ): Promise<void> {
    console.log(`\n🔍 [My Account] Validating PPV card on current page: ${this.page.url()}`);

    // Wait for My Account content to load
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this.dismissConsentIfPresent();

    await Promise.race([
      this.page.waitForSelector(
        'button:has-text("Manage subscription"), button:has-text("Manage"), ' +
        '[data-testid*="subscription" i], h2, h3',
        { state: 'visible', timeout: 15000 }
      ).then(() => true).catch(() => false),
    ]);

    await this.page.waitForTimeout(1500);

    // Scroll to PPV section
    console.log('📺 [My Account] Scrolling to PPV section...');
    const scrolled = await this.page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,span,div'));
      const ppvHeadings = ['pay-per-view', 'pay per view', 'available to buy'];
      for (const el of allEls) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase() || '';
        if (ppvHeadings.some(h => text === h)) {
          const rect = el.getBoundingClientRect();
          const target = Math.max(0, window.scrollY + rect.top - 120);
          window.scrollTo({ top: target, behavior: 'instant' });
          return target;
        }
      }
      window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
      return -1;
    }).catch(() => -1);

    if (scrolled >= 0) {
      console.log(`✅ [My Account] Scrolled to PPV section at ${scrolled}px`);
    } else {
      console.log('⚠️ [My Account] PPV section heading not found — scrolled to mid-page');
    }

    await this.page.waitForTimeout(1000);

    // Extract PPV card data
    const cardData: any = await this.page.evaluate(({ name, expectedTitle, expectedDate }: { name: string; expectedTitle: string; expectedDate: string }) => {
      const normalize = (value: string) =>
        (value || '').toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\bv(?:s)?\.?\b/g, ' vs ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const rawTerms = `${name} ${expectedTitle || ''}`;
      const searchTerms = normalize(rawTerms)
        .split(/\s+/)
        .filter(part => part.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs', 'ppv', 'event'].includes(part));

      const isVisible = (el: HTMLElement): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };

      const scoreElement = (text: string) => {
        const norm = normalize(text);
        let matches = 0;
        for (const term of searchTerms) {
          if (norm.includes(term)) matches++;
        }
        return matches;
      };

      const allContainers = Array.from(document.querySelectorAll<HTMLElement>(
        '[id*="ppv-card"], [id*="ppv-list"] > div > div, [id*="purchased-ppv-card"], [class*="card" i], article, li'
      )).filter(el => isVisible(el));

      let candidateCards = allContainers.filter(el => {
        const text = (el.innerText || '').trim();
        return text.length >= 10 && text.length <= 600 && scoreElement(text) > 0;
      });

      candidateCards = candidateCards.filter(card => {
        return !candidateCards.some(other => other !== card && card.contains(other));
      });

      if (candidateCards.length === 0) {
        const broadEls = Array.from(document.querySelectorAll<HTMLElement>('div, section, article'))
          .filter(el => isVisible(el) && (el.innerText || '').length >= 10 && (el.innerText || '').length <= 400 && scoreElement(el.innerText || '') > 0);
        candidateCards = broadEls.filter(card => !broadEls.some(other => other !== card && card.contains(other)));
      }

      candidateCards.sort((a, b) => {
        const scoreA = scoreElement(a.innerText || '');
        const scoreB = scoreElement(b.innerText || '');
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (a.innerText || '').length - (b.innerText || '').length;
      });

      const matchedCard = candidateCards[0];
      if (!matchedCard) {
        return { found: false };
      }

      const cardText = (matchedCard.innerText || '').trim();
      const findImg = (el: HTMLElement | null): boolean => {
        if (!el) return false;
        const imgEl = el.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
        if (imgEl) {
          if (imgEl.tagName.toLowerCase() === 'img') {
            const src = imgEl.getAttribute('src') || imgEl.getAttribute('srcset');
            return !!src;
          }
          return true;
        }
        const cardParent = el.closest('[id*="ppv"], [id*="card"], [class*="card" i], article, li, section');
        if (cardParent && cardParent !== el) {
          const parentImg = cardParent.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
          if (parentImg) {
            if (parentImg.tagName.toLowerCase() === 'img') {
              const src = parentImg.getAttribute('src') || parentImg.getAttribute('srcset');
              return !!src;
            }
            return true;
          }
        }
        if (el.parentElement) {
          const siblingImg = el.parentElement.querySelector('img, picture, svg, [role="img"], [style*="background-image"], canvas');
          if (siblingImg) return true;
        }
        return false;
      };
      const imgPresent = findImg(matchedCard) ? 'Yes' : 'No';

      const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);
      let title = '';
      let dateTimeStr = '';
      let purchasedText = '';

      const dateRegex = /\b((Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(?:at|•)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i;

      for (const line of lines) {
        if (scoreElement(line) > 0 && !title) {
          title = line;
        } else if (/purchased/i.test(line) || /included/i.test(line)) {
          purchasedText = line;
        } else if (dateRegex.test(line) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(line) || /\d{1,2}:\d{2}/.test(line)) {
          if (!dateTimeStr) dateTimeStr = line;
        }
      }

      if (!dateTimeStr) {
        const dateMatch = cardText.match(dateRegex);
        if (dateMatch) dateTimeStr = dateMatch[0];
      }
      if (!purchasedText) {
        if (/purchased/i.test(cardText)) purchasedText = 'Purchased';
        else if (/included/i.test(cardText)) purchasedText = 'Included';
      }

      return {
        found: true,
        imagePresent: imgPresent,
        title: title || lines[0] || '',
        dateTime: dateTimeStr || lines[1] || '',
        purchasedText: purchasedText || 'Not found',
        fullText: cardText,
      };
    }, {
      name: ppvName,
      expectedTitle: eventData?.PPV_DISPLAY_NAME || eventData?.PPV_NAME || ppvName,
      expectedDate: eventData?.PPV_DATE || '',
    }).catch(() => ({ found: false }));

    const page = 'My Account';

    if (cardData && cardData.found) {
      console.log('✅ [My Account] PPV card found:', JSON.stringify(cardData));

      // 1. PPV Image Present
      results.push({ page, field: 'PPV Image Present', expected: 'Yes', actual: cardData.imagePresent, status: cardData.imagePresent === 'Yes' ? 'PASS' : 'FAIL' });

      // 2. PPV Title
      const expectedTitle = eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || ppvName;
      const normalizeStr = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      const titleMatch = normalizeStr(cardData.title).includes(normalizeStr(expectedTitle)) || normalizeStr(expectedTitle).includes(normalizeStr(cardData.title)) || (normalizeStr(expectedTitle).split(/\s+/).filter(w => w.length > 2 && w !== 'vs').some(w => normalizeStr(cardData.title).includes(w)));
      results.push({ page, field: 'PPV Title', expected: expectedTitle, actual: cardData.title, status: titleMatch ? 'PASS' : 'FAIL' });

      // 3. PPV Date & Time
      const expectedDate = eventData.PPV_DATE || '';
      const normalizeDate = (val: string) => {
        return (val || '').toLowerCase()
          .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
          .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
          .replace(/a\.\s*m\./gi, 'am')
          .replace(/p\.\s*m\./gi, 'pm')
          .replace(/\s+/g, ' ')
          .trim();
      };
      const checkDateMatch = (act: string, exp: string): boolean => {
        if (!exp) return true;
        if (compare(act, exp)) return true;
        const dynamicExpected = getDynamicDateTimeBadge(
          exp,
          getNowForRegion(eventData.DAZN_REGION || eventData.REGION),
        );
        if (dynamicExpected && compare(act, dynamicExpected)) return true;
        const expNorm = normalizeDate(exp);
        const actNorm = normalizeDate(act);
        if (actNorm === expNorm || actNorm.includes(expNorm) || expNorm.includes(actNorm)) return true;

        const parseTimeAndWk = (val: string) => {
          const clean = (val || '').toLowerCase()
            .replace(/a\.\s*m\./gi, 'am')
            .replace(/p\.\s*m\./gi, 'pm')
            .replace(/\s+/g, ' ').trim();
          const wk = clean.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i)?.[1]?.toLowerCase();
          const tm = clean.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) || clean.match(/(\d{1,2})\s*(am|pm)/i);
          if (!tm) return { wk, h: null, m: null };
          let h = parseInt(tm[1], 10);
          const min = tm[2] && !isNaN(parseInt(tm[2], 10)) ? parseInt(tm[2], 10) : 0;
          const meridiem = (tm[3] || (isNaN(parseInt(tm[2], 10)) ? tm[2] : ''))?.toLowerCase();
          if (meridiem === 'pm' && h < 12) h += 12;
          if (meridiem === 'am' && h === 12) h = 0;
          return { wk, h, m: min };
        };

        const expP = parseTimeAndWk(exp);
        const actP = parseTimeAndWk(act);
        if (expP.wk && actP.wk && expP.wk === actP.wk) {
          if (expP.h !== null && actP.h !== null) {
            return expP.h === actP.h && expP.m === actP.m;
          }
          return true;
        }
        return false;
      };
      const dateMatch = checkDateMatch(cardData.dateTime, expectedDate);
      results.push({ page, field: 'PPV Date & Time', expected: expectedDate, actual: cardData.dateTime, status: dateMatch ? 'PASS' : 'FAIL' });

      // 4. Purchased Text
      const purchasedMatch = cardData.purchasedText.toLowerCase().includes('purchased') || cardData.purchasedText.toLowerCase().includes('included');
      results.push({ page, field: 'Purchased Text', expected: 'Purchased', actual: cardData.purchasedText, status: purchasedMatch ? 'PASS' : 'FAIL' });

    } else {
      console.log('⚠️ [My Account] PPV card not found on current page');
      const expectedTitle = eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || ppvName;
      const expectedDate = eventData.PPV_DATE || '';
      results.push({ page, field: 'PPV Image Present',  expected: 'Yes',         actual: 'PPV event card not found', status: 'FAIL' });
      results.push({ page, field: 'PPV Title',          expected: expectedTitle,  actual: 'PPV event card not found', status: 'FAIL' });
      results.push({ page, field: 'PPV Date & Time',    expected: expectedDate,   actual: 'PPV event card not found', status: 'FAIL' });
      results.push({ page, field: 'Purchased Text',     expected: 'Purchased',    actual: 'PPV event card not found', status: 'FAIL' });
    }
  }



  // ─────────────────────────────
  // HANDLE SUBSCRIBE TO BUY MODAL
  // Appears after clicking Buy Now for freemium/resubscribe users
  // Must click "SEE DAZN PLANS" to proceed to PPV flow
  // ─────────────────────────────
  async handleSubscribeToBuyModal(): Promise<void> {
    console.log('🔍 Checking for "Subscribe to Buy" modal...');

    // Wait directly for the SEE DAZN PLANS button
    const seePlansBtn = this.page
      .locator('div[role="button"], button, a')
      .filter({ hasText: /see dazn plans/i })
      .first();

    const modalVisible = await seePlansBtn
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!modalVisible) {
      // Log all role=button divs for diagnosis
      const allRoleBtns = await this.page
        .locator('div[role="button"]')
        .allTextContents()
        .catch(() => []);
      console.log(
        '🔍 All div[role="button"]:',
        allRoleBtns.map(t => t.trim()).filter(Boolean)
      );
      console.log('ℹ️  No "Subscribe to Buy" modal — continuing');
      return;
    }

    console.log('✅ Modal detected — SEE DAZN PLANS button visible');

    // Click via mouse coordinates — most reliable for div[role="button"]
    const box = await seePlansBtn.boundingBox().catch(() => null);

    if (box && box.width > 0 && box.height > 0) {
      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);
      console.log(`🖱️  Clicking SEE DAZN PLANS at x=${cx} y=${cy}`);
      await this.page.mouse.move(cx, cy);
      await this.page.waitForTimeout(100);
      await this.page.mouse.click(cx, cy);
    } else {
      console.log('⚠️  No bounding box — using DOM click');
      await seePlansBtn.evaluate((el: HTMLElement) => el.click());
    }

    console.log('✅ Clicked SEE DAZN PLANS');

    // Wait for navigation away from myaccount / account
    await Promise.race([
      this.page.waitForURL(
        url => {
          const u = url.toString().toLowerCase();
          return !u.includes('myaccount') && !u.includes('/account');
        },
        { timeout: 10000 }
      ),
      this.page.waitForURL(
        url => url.toString().includes('signup'),
        { timeout: 10000 }
      ),
    ]).catch(() =>
      console.log('⚠️  URL unchanged after SEE DAZN PLANS click')
    );

    await this.page.waitForLoadState('domcontentloaded').catch(() => { });
    console.log(`✅ Post-modal URL: ${this.page.url()}`);
  }

  // ─────────────────────────────
  // CLICK BUY NOW
  // Does NOT call scrollToPPVSection — spec calls it once before
  // Full flow:
  //   1. Dismiss consent
  //   2. Find PPV row by event name
  //   3. Click div[role="button"] Buy Now
  //   4. Handle "Subscribe to Buy" modal if present
  //      (freemium/returning → SEE DAZN PLANS)
  //      (standard → no modal, direct navigation)
  // ─────────────────────────────
  async clickBuyNow(ppvName: string): Promise<void> {
    console.log(`💳 Clicking Buy Now for: ${ppvName}`);

    // Step 1: Dismiss consent
    await this.dismissConsentIfPresent();

    // Step 2: Find PPV row
    const row = await this.findPPVRow(ppvName);
    if (!row) {
      throw new Error(`❌ PPV row not found for: ${ppvName}`);
    }

    // Step 3: Locate Buy Now — div[role="button"] on this page
    const buyNowBtn = row
      .locator('div[role="button"], button, a')
      .filter({ hasText: /buy now/i })
      .first();

    await buyNowBtn.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(200);

    // Step 4: Dismiss consent — can reappear after scroll
    await this.dismissConsentIfPresent();
    await this.page.waitForTimeout(150);

    // Step 5: Validate interactable
    const box = await buyNowBtn.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error('❌ Buy Now not interactable — zero bounding box');
    }

    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    console.log(`🖱️  Buy Now at x=${cx} y=${cy}`);

    // Step 6: Mouse click — most reliable for div[role="button"]
    await this.page.mouse.move(cx, cy);
    await this.page.waitForTimeout(100);
    await this.page.mouse.click(cx, cy);

    console.log(`✅ Clicked Buy Now for: ${ppvName}`);

    // Step 7: Handle "Subscribe to Buy" modal
    // Freemium/returning → modal appears → click SEE DAZN PLANS
    // Standard           → no modal → direct navigation
    await this.handleSubscribeToBuyModal();
  }

  // ─────────────────────────────
  // CLICK SUBSCRIPTION STATUS CTA
  // For freemium/frozen users default signup flow
  // ─────────────────────────────
  async clickSubscriptionStatusCTA(userStateKey: string): Promise<void> {
    console.log(`🖱️ Clicking subscription status CTA for state: ${userStateKey}`);

    // Step 1: Dismiss consent
    await this.dismissConsentIfPresent();

    // Step 2: Move away from the PPV list. The page can also render an
    // Upgrade CTA in the sticky header, so the subscription panel needs to be
    // brought back into view before choosing a candidate.
    await this.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => { });
    await this.page.waitForTimeout(300);

    const buttonText = userStateKey === 'frozen' ? 'Resubscribe' : 'Upgrade now';
    const buttonRegex = userStateKey === 'frozen' ? /^resubscribe$/i : /^upgrade now$/i;
    const controls = this.page
      .locator('button, a, [role="button"]')
      .filter({ hasText: buttonRegex });

    await controls.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => { });

    const count = await controls.count().catch(() => 0);
    const candidates: Array<{ locator: Locator; score: number; description: string }> = [];

    for (let i = 0; i < count; i++) {
      const candidate = controls.nth(i);
      if (!await candidate.isVisible({ timeout: 500 }).catch(() => false)) continue;

      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width === 0 || box.height === 0) continue;

      const meta = await candidate.evaluate((el) => {
        const element = el as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.innerText || element.textContent || '').trim();
        const inHeader = !!element.closest('header, nav, [role="banner"]');
        const fixedOrSticky = style.position === 'fixed' || style.position === 'sticky';

        let ancestor: HTMLElement | null = element;
        const textParts: string[] = [];
        for (let depth = 0; ancestor && depth < 5; depth++) {
          textParts.push((ancestor.innerText || '').trim());
          ancestor = ancestor.parentElement;
        }

        return {
          text,
          top: rect.top,
          left: rect.left,
          inHeader,
          fixedOrSticky,
          context: textParts.join(' ').toLowerCase(),
        };
      });

      let score = 0;
      if (buttonRegex.test(meta.text)) score += 50;
      if (meta.context.includes('current subscription')) score += 40;
      if (meta.context.includes('subscription status')) score += 35;
      if (meta.context.includes('my subscription')) score += 30;
      if (meta.context.includes('dazn free')) score += 25;
      if (meta.context.includes('dazn standard') || meta.context.includes('dazn ultimate')) score += 10;
      if (meta.context.includes('pay-per-view') || meta.context.includes('buy now')) score -= 15;
      if (meta.inHeader || meta.fixedOrSticky) score -= 100;
      if (meta.top < 90 && !meta.context.includes('subscription')) score -= 40;

      candidates.push({
        locator: candidate,
        score,
        description: `text="${meta.text}" top=${Math.round(meta.top)} left=${Math.round(meta.left)} header=${meta.inHeader} fixed=${meta.fixedOrSticky} score=${score}`,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    console.log(`🔎 Subscription status CTA candidates: ${candidates.map(c => c.description).join(' | ') || 'none'}`);

    const ctaBtn = candidates[0]?.locator;
    if (!ctaBtn || candidates[0].score < 0) {
      throw new Error(`❌ Subscription status CTA "${buttonText}" not found in My Account subscription panel for user state: ${userStateKey}`);
    }

    await ctaBtn.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(200);

    // Step 3: Dismiss consent again if needed
    await this.dismissConsentIfPresent();
    await this.page.waitForTimeout(150);

    const box = await ctaBtn.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(`❌ Subscription status CTA not interactable for user state: ${userStateKey}`);
    }

    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const beforeUrl = this.page.url();
    const beforeBody = await this.page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    console.log(`🖱️ Click Subscription Status CTA at x=${cx} y=${cy}`);

    await Promise.all([
      this.page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 15000 }).catch(() => null),
      ctaBtn.click({ timeout: 10000 }),
    ]);
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
    await this.page.waitForTimeout(1000);

    const afterUrl = this.page.url();
    const afterBody = await this.page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    const reachedSignup =
      /\/signup|tierplans|plandetails|personaldetails|emaildetails|payment/i.test(afterUrl) ||
      /choose a plan|choose your plan|email address|create an account|payment/i.test(afterBody);

    if (afterUrl === beforeUrl && afterBody === beforeBody) {
      throw new Error(`❌ Subscription status CTA click had no effect. Still on: ${afterUrl}`);
    }

    if (!reachedSignup && afterUrl.toLowerCase().includes('/myaccount')) {
      throw new Error(`❌ Subscription status CTA did not navigate away from My Account. URL: ${afterUrl}`);
    }

    console.log(`✅ Clicked subscription status CTA successfully. Landed on: ${afterUrl}`);
  }
}
