import { Page, Locator, expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { dismissMarketingPopup } from '../utils/helpers';
import { validateVariant } from '../flows/validateVariant';
import { readSheet } from '../utils/excelReader';
import { resolveSearchPPVTile } from '../utils/searchPpvTileResolver';

export class SearchPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  private isFixtureOrPreviewUrl(url: string): boolean {
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

  private async clickVisibleEntitledTile(eventName: string): Promise<void> {
    const resolvedTile = await resolveSearchPPVTile(this.page, eventName);
    if (resolvedTile) {
      const rawText = (await resolvedTile.textContent().catch(() => '')) || '';
      console.log(`🖱️ [Search] Clicking resolved entitled PPV tile: "${rawText.replace(/\s+/g, ' ').trim().substring(0, 100)}"`);
      await resolvedTile.scrollIntoViewIfNeeded().catch(() => { });
      try {
        const eventLink = resolvedTile.locator('a[href*="/fixture/"], a[href*="/event/"], a[href*="/stream/"], a[href*="/player/"]').first();
        const clickTarget = await eventLink.count().catch(() => 0) ? eventLink : resolvedTile;
        await clickTarget.click({ force: true, timeout: 5000 });
        const reachedEventPage = await this.page
          .waitForURL((url: URL) => this.isFixtureOrPreviewUrl(url.href), { timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (reachedEventPage) {
          await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
          return;
        }
        console.log('⚠️ [Search] Resolved tile did not navigate to an event page; trying strict tile selector fallback.');
      } catch (error: any) {
        console.log(`⚠️ [Search] Could not click resolved event tile: ${error.message}`);
      }
    }

    const normalise = (value: string) => value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const expectedTitle = normalise(eventName);
    const candidates = this.page.locator(
      'article[data-target="tile"][data-target-title]:not([data-target-id^="Competitor:"])'
    );
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const tile = candidates.nth(i);
      if (!await tile.isVisible().catch(() => false)) continue;
      const targetTitle = await tile.getAttribute('data-target-title').catch(() => '');
      if (normalise(targetTitle || '') !== expectedTitle) continue;
      const rawText = (await tile.textContent().catch(() => '')) || '';
      const text = rawText.toLowerCase();
      const normalisedText = normalise(rawText);
      if (!normalisedText.includes(expectedTitle)) continue;
      if (/\b(press conference|weigh[\s-]?in|prelims?|preliminary|undercard|workout|replay|highlights?|preview|promo|interview|behind the scenes|episode|documentary|face[\s-]?off|kickboxing)\b/i.test(text)) continue;

      console.log(`🖱️ [Search] Clicking entitled PPV event tile: "${text.replace(/\s+/g, ' ').trim().substring(0, 100)}"`);
      await tile.scrollIntoViewIfNeeded().catch(() => { });
      try {
        const eventLink = tile.locator('a[href*="/fixture/"], a[href*="/event/"], a[href*="/stream/"], a[href*="/player/"]').first();
        const clickTarget = await eventLink.count().catch(() => 0) ? eventLink : tile;
        await clickTarget.click({ force: true, timeout: 5000 });
        const reachedEventPage = await this.page
          .waitForURL((url: URL) => this.isFixtureOrPreviewUrl(url.href), { timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (reachedEventPage) {
          await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
          return;
        }
        console.log('⚠️ [Search] Matching result did not navigate to an event page; trying the next matching tile.');
      } catch (error: any) {
        console.log(`⚠️ [Search] Could not click matching event tile: ${error.message}`);
      }
    }

    throw new Error(`❌ [Search] Could not find visible entitled tile for "${eventName}"`);
  }

  async searchAndClickEntitledPPV(
    eventName: string,
    results: any[],
    eventData: Record<string, string>
  ): Promise<void> {
    await this.searchForPPVTileWithUpcomingFallback(eventName);
    await this.clickVisibleEntitledTile(eventName);
    await this.page.waitForURL((url: URL) => this.isFixtureOrPreviewUrl(url.href), { timeout: 15000 }).catch(() => { });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

    const rows = readSheet('Search page').filter((row: any) =>
      String(row.Flow || '').trim().toLowerCase() === 'ultimate-login-first'
    );
    await validateVariant(this.page, 'search', rows, results, eventData, 'Search', 'ultimate-login-first');

    const navResult = results
      .slice()
      .reverse()
      .find((r: any) => r.page === 'Search' && r.field === 'Ultimate Navigation Target');
    if (navResult?.status === 'FAIL') {
      throw new Error(`❌ [Search] Ultimate navigation target validation failed. URL: ${this.page.url()}`);
    }
  }

  private async hasVisiblePPVTile(eventName: string): Promise<boolean> {
    return Boolean(await resolveSearchPPVTile(this.page, eventName));
  }

  async searchForPPVTileWithUpcomingFallback(eventName: string): Promise<void> {
    let searchQuery = eventName;
    if (eventName.includes(':')) {
      searchQuery = eventName.split(':').pop()?.trim() || eventName;
    }

    console.log(`🔍 [Search Attempt 1] Searching with: "${searchQuery}"`);
    await this.searchForEvent(searchQuery);
    if (await this.hasVisiblePPVTile(eventName)) {
      return;
    }

    const upcomingQuery = `${searchQuery} Upcoming`;
    console.log(`⚠️ [Search Attempt 1] PPV tile not found for "${eventName}" — retrying with "${upcomingQuery}"...`);
    await this.searchForEvent(upcomingQuery);
    if (await this.hasVisiblePPVTile(eventName)) {
      return;
    }

    const allText = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('article, li, [class*="result" i]'))
        .map(el => (el as HTMLElement).innerText?.substring(0, 100))
        .filter(t => t && t.length > 5)
        .slice(0, 10)
        .join('\n');
    }).catch(() => 'N/A');
    console.log('📋 Page content sample:\n', allText);

    throw new Error(
      `❌ PPV tile not found for: "${eventName}" ` +
      `(tried "${searchQuery}" and "${upcomingQuery}")`
    );
  }

  // ── NAVIGATE ──────────────────────────────────────────────────
  async navigate(baseUrl: string) {
    const url = `${baseUrl}/search`;
    console.log(`🔍 Navigating to: ${url}`);
    await this.page.goto(url);
    await this.page.waitForLoadState('domcontentloaded');
    await this.waitForConsentAndDismiss();
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });

    console.log('✅ Search page loaded');
  }

  // ── SEARCH FOR EVENT ──────────────────────────────────────────
  async searchForEvent(eventName: string) {
    console.log(`🔍 Searching for: ${eventName}`);

    // Wait for search input
    const searchInput = this.page.locator(
      'input[type="search"], ' +
      'input[placeholder*="search" i], ' +
      'input[placeholder*="Search" i], ' +
      '[class*="search" i] input, ' +
      '[data-testid*="search" i] input'
    ).first();

    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.click();
    await searchInput.fill(eventName);
    await searchInput.press('Enter');

    // Wait for results to load — wait for spinner to disappear
    await this.page.waitForFunction(() => {
      const spinner = document.querySelector('[class*="spinner" i], [class*="loading" i], [class*="loader" i]');
      return !spinner || getComputedStyle(spinner).display === 'none';
    }, { timeout: 10000 }).catch(() => { });

    // Also wait for at least one result to appear
    await this.page.waitForFunction(
      (name: string) => {
        const els = Array.from(document.querySelectorAll('article, li, [class*="tile" i], [class*="card" i], [class*="result" i]'));
        return els.some(el => (el as HTMLElement).innerText?.toLowerCase().includes(name.toLowerCase().split(' ')[0]));
      },
      eventName,
      { timeout: 15000 }
    ).catch(() => console.log('⚠️  Results may not have loaded fully'));

    await this.page.waitForTimeout(1000);
    console.log(`✅ Search completed for: ${eventName}`);
  }

  // ── FIND AND CLICK PPV TILE ───────────────────────────────────
  async clickPPVTile(eventName: string): Promise<void> {
    console.log(`🎯 Looking for PPV tile: ${eventName}`);
    const bestTile = await resolveSearchPPVTile(this.page, eventName);
    if (bestTile) {
      const bestText = await bestTile.textContent().catch(() => '') || '';
      console.log(`✅ PPV tile found: "${bestText.substring(0, 80).trim()}"`);

      const scrollY = await this.page.evaluate(() => window.scrollY);
      await bestTile.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(300);

      const box = await bestTile.boundingBox();
      if (box) {
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        const buyNowButton = this.page.locator(
          'a:has-text("Buy now"), button:has-text("Buy now"), ' +
          'a:has-text("Buy Now"), button:has-text("Buy Now"), ' +
          'a:has-text("Continue"), button:has-text("Continue")'
        ).first();

        await expect(buyNowButton).toBeVisible({ timeout: 15000 });

        await this.page.evaluate((y) => {
          window.scrollTo(0, y);
          document.body.style.overflow = 'hidden';
          document.documentElement.style.overflow = 'hidden';
        }, scrollY);

        console.log('🔒 Background scroll locked');
        console.log('✅ PPV popup opened & Buy button located');
        return;
      }
    }

    // Debug — dump what's on the page
    const allText = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('article, li, [class*="result" i]'))
        .map(el => (el as HTMLElement).innerText?.substring(0, 100))
        .filter(t => t && t.length > 5)
        .slice(0, 10)
        .join('\n');
    }).catch(() => 'N/A');
    console.log('📋 Page content sample:\n', allText);

    throw new Error(`❌ PPV tile not found for: ${eventName}`);
  }

  // ── CLICK BUY NOW ─────────────────────────────────────────────
  async clickBuyNow(): Promise<void> {
    console.log('💳 Clicking Buy Now CTA...');
    const buyNow = this.page.locator(
      'a:has-text("Buy now"), button:has-text("Buy now"), ' +
      'a:has-text("Buy Now"), button:has-text("Buy Now"), ' +
      'a:has-text("Subscribe"), button:has-text("Subscribe"), ' +
      'a:has-text("Continue"), button:has-text("Continue")'
    ).first();

    await expect(buyNow).toBeVisible({ timeout: 8000 });
    await buyNow.click({ force: true });
    console.log('✅ Buy Now clicked');
  }

  // ═══════════════════════════════════════════════════════════════
  // DEV MODE: Enable dev mode to bypass phone number page
  // Flow: Landing → Explore → Home → Search → dev_mode_on → Copy ID → Back 2x → Back to Landing
  // ═══════════════════════════════════════════════════════════════
  async enableDevMode(options?: { preservePpvPromo?: boolean; returnToPreviousPage?: boolean }): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  🎭 ENABLING DEV MODE to bypass phone number page');
    console.log('═══════════════════════════════════════════════════\n');

    const originalUrl = this.page.url();
    console.log(`Original URL before dev mode: ${originalUrl}`);

    try {
      // ── Step 0: Check if dev mode is already active ────────────
      const yellowDot = this.page.locator('div[class*="dev-mode__circle"], [class*="dev-mode"]').first();
      const alreadyActive = await yellowDot.isVisible({ timeout: 1500 }).catch(() => false);
      if (alreadyActive) {
        console.log('✅ Dev mode is already active (yellow dot visible). Skipping activation flow.');
        return;
      }

      // ── Step 1: Navigate to search page ───────────
      const searchLink = this.page.locator('header a[href*="/search"], a[href*="/search"]').first();
      const searchVisible = await searchLink.isVisible({ timeout: 2000 }).catch(() => false);
      const baseUrl = this.page.url().match(/https:\/\/[^\/]+\/en-[A-Z]+/i)?.[0] || 'https://www.dazn.com/en-GB';
      const searchUrl = `${baseUrl}/search`;

      if (searchVisible) {
        console.log('✅ Found search link — navigating via client-side click');
        await Promise.all([
          this.page.waitForURL('**/search', { timeout: 10000 }).catch(() => { }),
          searchLink.click({ force: true })
        ]);
        await this.page.waitForLoadState('domcontentloaded').catch(() => { });
      }
      if (!this.page.url().includes('/search')) {
        console.log(`🧭 Search link did not reach Search — navigating directly to: ${searchUrl}`);
        await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        await this.waitForConsentAndDismiss().catch(() => { });
      }
      if (!this.page.url().includes('/search')) {
        throw new Error(`❌ Could not reach Search page for dev mode. Current URL: ${this.page.url()}`);
      }
      console.log(`✅ On search page: ${this.page.url()}`);

      // ── Step 2: Type [dev_mode_on] and press Enter ────────────
      console.log('⌨️  Entering "[dev_mode_on]" in search...');

      const searchInput = this.page.locator(
        'input[type="search"]:not(#vendor-search-handler):not([name="vendor-search-handler"]), ' +
        'input[placeholder*="search" i]:not(#vendor-search-handler):not([name="vendor-search-handler"]):not([aria-label*="cookie" i]), ' +
        '[class*="search" i] input:not(#vendor-search-handler):not([name="vendor-search-handler"]):not([aria-label*="cookie" i]), ' +
        '[data-testid*="search" i] input:not(#vendor-search-handler):not([name="vendor-search-handler"])'
      ).first();
      await searchInput.waitFor({ state: 'visible', timeout: 30000 });

      // Dismiss any marketing/promotion popup that is already visible
      await dismissMarketingPopup(this.page, 0, options).catch(() => { });

      try {
        await searchInput.click({ timeout: 5000 });
      } catch (clickError) {
        console.log('⚠️ Search input click was intercepted or failed. Attempting to dismiss popup and retry...');
        await dismissMarketingPopup(this.page, 4000, options).catch(() => { });
        await searchInput.click({ timeout: 10000, force: true }).catch((retryError) => {
          console.log(`⚠️ Forced search input click failed, continuing with direct fill: ${retryError.message}`);
        });
      }

      await searchInput.fill('[dev_mode_on]', { timeout: 10000 }).catch(async () => {
        await searchInput.evaluate((input: HTMLInputElement, value: string) => {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, '[dev_mode_on]');
      });
      await searchInput.press('Enter');
      console.log('✅ Text entered and Enter pressed');

      // ── Step 3: Wait for UUID popup and copy ID ────────────
      await this.page.waitForFunction(() => {
        const body = document.body.innerText || '';
        return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body) ||
          body.includes('Copy ID');
      }, { timeout: 5000 }).catch(() => { });

      const bodyContent = await this.page.innerText('body').catch(() => '');
      const uuidMatch = bodyContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const devModeId = uuidMatch ? uuidMatch[0] : null;
      console.log(`🔑 Extracted Dev Mode ID: ${devModeId}`);

      if (devModeId) {
        await this.page.evaluate((id) => {
          const textarea = document.createElement('textarea');
          textarea.value = id;
          document.body.appendChild(textarea);
          textarea.select();
          try { document.execCommand('copy'); } catch (e) { }
          document.body.removeChild(textarea);
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', id);
          document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
        }, devModeId).catch((err) => console.warn('⚠️ Copy error:', err.message));
      }

      // Capture search URL before copy (DAZN may auto-redirect after Copy ID)
      const searchPageUrl = this.page.url();
      console.log(`📌 Current search URL: ${searchPageUrl}`);

      const copyButton = this.page.locator('button:has-text("Copy ID")').first();
      const copyButtonVisible = await copyButton.isVisible({ timeout: 3000 }).catch(() => false);
      if (copyButtonVisible) {
        await copyButton.click();
        console.log('✅ Clicked Copy ID button');
      }

      // ── Step 4: Ensure we're on search page, refresh, verify yellow dot ──────
      // DAZN may auto-redirect to home after Copy ID — navigate back to search
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/search')) {
        console.log(`⚠️ Redirected away from search to: ${currentUrl}`);
        console.log(`🔄 Navigating back to search page: ${searchPageUrl}`);
        await this.page.goto(searchPageUrl, { waitUntil: 'domcontentloaded' });
      }

      console.log('🔄 Refreshing search page to verify yellow dot...');
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });

      const yellowDotVisible = await yellowDot.isVisible({ timeout: 5000 }).catch(() => false);
      if (yellowDotVisible) {
        console.log('✅ Yellow dot visible on search page — dev mode CONFIRMED ✨');

        // The home-page popup flow must return to its contextual PPV page via history.
        if (options?.returnToPreviousPage) {
          console.log('🔄 Returning to the contextual PPV page via browser history');
          await this.page.goBack({ waitUntil: 'domcontentloaded' });
        } else {
          console.log(`🔄 Navigating back to original URL: ${originalUrl}`);
          await this.page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
        }
        await this.waitForConsentAndDismiss().catch(() => { });
      } else {
        console.log('❌ Yellow dot NOT visible — dev mode activation FAILED');
        throw new Error('❌ Yellow dot not visible on search page after dev mode activation');
      }

      // ── Done — caller navigates to home/source ──────
      console.log('✅ Dev mode enabled — returning to caller for navigation');
      console.log('═══════════════════════════════════════════════════\n');

    } catch (e: any) {
      console.warn('⚠️  Dev mode error:', e.message);
      throw e;
    }
  }

}
