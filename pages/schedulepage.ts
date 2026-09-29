import { Page, Locator, expect } from '@playwright/test';
import { handleCookies, dismissMarketingPopup } from '../utils/helpers';
import { validateVariant } from '../flows/validateVariant';
import { readSheet } from '../utils/excelReader';


export class SchedulePage {
  constructor(private page: Page) { }

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

  async clickEntitledEventAndValidate(
    event: Locator,
    results: any[],
    eventData: Record<string, string>
  ): Promise<void> {
    console.log('💎 [Schedule] Clicking entitled PPV event tile directly...');
    await event.scrollIntoViewIfNeeded().catch(() => { });
    await event.click({ force: true, timeout: 5000 });
    await this.page.waitForURL((url: URL) => this.isFixtureOrPreviewUrl(url.href), { timeout: 15000 }).catch(() => { });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

    const rows = readSheet('Schedule page').filter((row: any) =>
      String(row.Flow || '').trim().toLowerCase() === 'ultimate-login-first'
    );
    await validateVariant(this.page, 'schedule', rows, results, eventData, 'Schedule', 'ultimate-login-first');

    const navResult = results
      .slice()
      .reverse()
      .find((r: any) => r.page === 'Schedule' && r.field === 'Ultimate Navigation Target');
    if (navResult?.status === 'FAIL') {
      throw new Error(`❌ [Schedule] Ultimate navigation target validation failed. URL: ${this.page.url()}`);
    }
  }

  // ── DISMISS POPUPS ─────────────────────────────────────────────
  async dismissSchedulePopups() {
    console.log('🔍 Checking for schedule page popups...');

    // Call the general marketing popup dismisser
    await dismissMarketingPopup(this.page);

    // Selectors for close button or "Maybe later" or similar dismiss CTAs
    const closeButtonSelectors = [
      'button[class*="close" i]',
      'div[class*="close" i]',
      '[aria-label*="close" i]',
      '[class*="CloseButton" i]',
      '[class*="ModalClose" i]',
      'button:has-text("Maybe later")',
      'a:has-text("Maybe later")',
      'button:has-text("Maybe Later")',
      'a:has-text("Maybe Later")'
    ];

    for (const selector of closeButtonSelectors) {
      const btn = this.page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        console.log(`🔔 Popup close button found with selector: "${selector}". Clicking to dismiss...`);
        await btn.click({ force: true }).catch(() => { });
        await this.page.waitForTimeout(500);
        return;
      }
    }

    // Fallback: Click on elements that look like 'x' or 'X' inside dialog/modal wrapper
    const xButton = this.page.locator('[class*="Modal" i] button, [class*="dialog" i] button, [class*="popup" i] button')
      .filter({ hasText: /^(x|close)$/i }).first();
    if (await xButton.isVisible().catch(() => false)) {
      console.log('🔔 Popup close button found via child button filter. Clicking...');
      await xButton.click({ force: true }).catch(() => { });
      await this.page.waitForTimeout(500);
      return;
    }

    console.log('ℹ️ No schedule page popups found or dismissed.');
  }

  // ── NAVIGATE ──────────────────────────────────────────────────
  async navigate(baseUrl: string) {
    const url = `${baseUrl}/schedule`;
    console.log(`📅 Navigating to: ${url}`);
    await this.page.goto(url);
    await expect(this.page).toHaveURL(/schedule/);
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
    // Wait for networkidle so OneTrust's async cookie script has time to load
    await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    // Use longer timeout to wait for cookie banner to appear and dismiss it
    await handleCookies(this.page, 8000);
    await this.page.waitForSelector('body', { timeout: 15000 });

    console.log('✅ Schedule page loaded');
    await this.page.waitForTimeout(1000); // Wait a brief moment for any popup to animate in
    await this.dismissSchedulePopups();
  }

  async selectSport(sport: string) {
    if (!sport) {
      throw new Error('❌ selectSport() called with undefined — check config has SPORT field');
    }
    console.log(`🥊 Selecting ${sport}...`);
    await handleCookies(this.page);

    const filterContainer = this.page.locator('#schedule-filter-container');
    const isFilterContainerVisible = await filterContainer.waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false);

    let useHorizontalFilter = false;
    if (isFilterContainerVisible) {
      const sportEl = filterContainer.getByText(sport, { exact: true });
      const sportVisible = await sportEl.isVisible().catch(() => false);
      if (sportVisible) {
        useHorizontalFilter = true;
      }
    }

    if (useHorizontalFilter) {
      const sportEl = filterContainer.getByText(sport, { exact: true });
      await sportEl.click();
    } else {
      console.log('ℹ️ Horizontal filter container not visible. Looking for "All Sports" dropdown...');
      const allSportsBtn = this.page.locator('button:has-text("All Sports")')
        .or(this.page.locator('[class*="sportsFilter" i] button'))
        .or(this.page.locator('[class*="filter" i] button'))
        .first();
      await expect(allSportsBtn).toBeVisible({ timeout: 8000 });
      await allSportsBtn.click();
      console.log(' Clicked "All Sports" dropdown');

      // Now click the sport from the dropdown/menu
      const sportItem = this.page.getByRole('option', { name: sport })
        .or(this.page.locator(`[role="menuitem"]:has-text("${sport}")`))
        .or(this.page.locator(`button:has-text("${sport}")`))
        .or(this.page.locator(`a:has-text("${sport}")`))
        .or(this.page.locator(`li:has-text("${sport}")`))
        .first();
      await expect(sportItem).toBeVisible({ timeout: 8000 });
      await sportItem.click();
      console.log(`✅ Selected ${sport} from dropdown`);
    }

    await this.page.waitForFunction(
      () => document.querySelectorAll('article').length > 0,
      null,
      { timeout: 8000 }
    ).catch(() => { });
    await this.page.waitForTimeout(1000);

    // Reset scroll to top after sport filter applied
    await this.page.evaluate(() => window.scrollTo(0, 0));
    console.log(`✅ ${sport} selected`);
  }

  // ── FIND EVENT ────────────────────────────────────────────────
  async findEvent(eventName: string): Promise<Locator> {
    console.log(`🔍 Searching for event: ${eventName}`);
    await handleCookies(this.page);

    const stripDiacritics = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const regex = new RegExp(
      stripDiacritics(eventName).replace(/[:\-–]/g, '').replace(/\s+/g, '.*'),
      'i'
    );

    const cleanStr = (value: string) =>
      (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    const eventTitle = cleanStr(eventName);
    const variantPattern = /\b(press\s*conference|weigh\s*in|weigh-in|prelims?|preliminary|undercard|open\s*workout|face\s*off|highlights?|trailer|preview|countdown|full\s*fight|replay)\b/i;
    const scoreEventText = (text: string): number => {
      const cleaned = cleanStr(text);
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const hasVariantSuffix = variantPattern.test(text);
      const exactTitleLine = lines.some(line => cleanStr(line) === eventTitle);
      const startsWithTitle = !!eventTitle && cleaned.startsWith(eventTitle);

      if (cleaned === eventTitle || exactTitleLine) return hasVariantSuffix ? 80 : 100;
      if (startsWithTitle) return hasVariantSuffix ? 50 : 90;
      return hasVariantSuffix ? 10 : 60;
    };

    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(300);

    let bestEvent: Locator | null = null;
    let bestScore = 0;
    let bestLabel = '';

    for (let i = 0; i < 25; i++) {
      const articles = this.page
        .locator('article')
        .filter({ hasText: regex });

      const count = await articles.count().catch(() => 0);

      for (let j = 0; j < count; j++) {
        const article = articles.nth(j);
        if (await article.isVisible().catch(() => false)) {
          const text = await article.innerText().catch(() => '');
          const score = scoreEventText(text);
          const label = text.split('\n').find(l => l.trim()) || text.slice(0, 40);

          if (variantPattern.test(text)) {
            console.log(`⏭️  Deprioritising non-main event tile score=${score}: "${label.trim()}"`);
          }

          if (score > bestScore) {
            bestEvent = article;
            bestScore = score;
            bestLabel = label.trim();
          }

          if (score >= 100) {
            console.log(`✅ Event found: "${bestLabel}"`);
            return article;
          }

          if (score < 60) {
            continue;
          }
        }
      }

      await this.page.evaluate(() => {
        window.scrollBy({ top: window.innerHeight, behavior: 'instant' });
      });
      await this.page.waitForTimeout(300);
    }

    if (bestEvent && bestScore >= 60) {
      console.log(`✅ Event found by best available score=${bestScore}: "${bestLabel}"`);
      return bestEvent;
    }

    throw new Error(`❌ Event "${eventName}" not found on schedule page`);
  }

  // ── CLICK EVENT (open modal) ──────────────────────────────────
  async clickEvent(event: Locator) {
    console.log('🖱️ Clicking event...');
    await handleCookies(this.page);

    // Save scroll position BEFORE any scrolling
    const scrollY = await this.page.evaluate(() => window.scrollY);
    console.log(`📍 Saved scroll position: ${scrollY}px`);

    // Click using Playwright's built-in click
    try {
      await event.click({ timeout: 5000 });
    } catch (err: any) {
      console.warn(`⚠️ Standard click failed: ${err.message}. Falling back to manual scroll and mouse click...`);
      await event.scrollIntoViewIfNeeded();
      await this.page.waitForTimeout(500);
      const box = await event.boundingBox();
      if (!box) throw new Error('❌ Event not clickable — no bounding box');
      await this.page.mouse.click(
        box.x + box.width / 2,
        box.y + box.height / 2
      );
    }

    // Immediately lock scroll AND background to prevent DAZN snap-back
    await this.page.evaluate((y) => {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      // Persistent scroll lock — holds position during modal animation
      const interval = setInterval(() => {
        if (Math.abs(window.scrollY - y) > 30) {
          window.scrollTo({ top: y, behavior: 'instant' });
        }
      }, 50);
      // Keep lock for 3s to cover modal open animation
      setTimeout(() => clearInterval(interval), 3000);
      (window as any).__scheduleScrollLock = interval;
    }, scrollY);

    // Wait for Buy Now button using manual poll (not expect, which can trigger scrollIntoView)
    const buyNowButton = this.page.locator(
      'a:has-text("Buy now"), ' +
      'button:has-text("Buy now"), ' +
      'a:has-text("Buy Now"), ' +
      'button:has-text("Buy Now")'
    ).first();

    let buyVisible = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      buyVisible = await buyNowButton.isVisible({ timeout: 500 }).catch(() => false);
      if (buyVisible) break;
      await this.page.waitForTimeout(200);
    }

    if (!buyVisible) {
      throw new Error('❌ Buy Now button not visible in modal after 15s');
    }

    // Final scroll restoration & keep overflow hidden for validation
    await this.page.evaluate((y) => {
      window.scrollTo({ top: y, behavior: 'instant' });
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }, scrollY);

    // Brief wait for scroll to settle
    await this.page.waitForTimeout(300);

    const finalY = await this.page.evaluate(() => window.scrollY).catch(() => -1);
    console.log(`📍 Final scroll position: ${finalY}px (target: ${scrollY}px)`);
    console.log('🔒 Background scroll locked');
    console.log('✅ Modal opened & Buy button located');
  }

  // ── CLICK BUY NOW ─────────────────────────────────────────────
  async clickBuyNow(): Promise<void> {
    console.log('💳 Clicking Buy Now CTA...');
    await handleCookies(this.page);
    const buyNow = this.page.locator(
      'a:has-text("Buy now"), ' +
      'button:has-text("Buy now"), ' +
      'a:has-text("Buy Now"), ' +
      'button:has-text("Buy Now")'
    ).first();

    await expect(buyNow).toBeVisible({ timeout: 8000 });
    await buyNow.click({ force: true });
    console.log('✅ Buy Now clicked');
  }
}
