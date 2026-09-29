import { Page } from '@playwright/test';
import { handleCookies, stabilisePage } from '../utils/helpers';

/**
 * BasePage — shared page object methods
 * All page objects should extend this class
 */
export class BasePage {
  constructor(protected page: Page) { }

  /**
   * Navigate to a URL and wait for the page to load
   */
  async navigate(url: string, options?: any): Promise<void> {
    const timeout = options?.timeout || 30000;
    console.log(`🌍 Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout }).catch(() => {
      console.log(`⚠️  Navigation timeout — continuing anyway`);
    });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
    if (options?.waitForSelector) {
      await this.page.waitForSelector(options.waitForSelector, {
        state: 'visible',
        timeout: 15000,
      }).catch(() => {
        console.log(`⚠️  Selector "${options.waitForSelector}" not found`);
      });
    }
    console.log(`✅ Landed on: ${this.page.url()}`);
  }

  /**
   * Get the page title
   */
  async getPageTitle(): Promise<string> {
    try {
      const h1s = this.page.locator('h1');
      const count = await h1s.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const text = ((await h1s.nth(i).textContent({ timeout: 2000 }).catch(() => '')) || '').trim();
        if (text && text.toLowerCase() !== 'dazn') {
          return text;
        }
      }
      const h1 = await this.page.locator('h1').first().textContent({ timeout: 2000 });
      return (h1 || '').trim();
    } catch {
      return 'N/A';
    }
  }

  /**
   * Get page body text
   */
  async getBodyText(): Promise<string> {
    try {
      return await this.page.locator('body').innerText({ timeout: 3000 });
    } catch {
      return '';
    }
  }

  /**
   * Wait for loading state
   */
  async waitForLoad(timeout = 5000): Promise<void> {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout });
    } catch {
      console.log('⚠️  Load state timeout');
    }
  }

  async waitForConsentAndDismiss(timeout = 15000): Promise<void> {
    await handleCookies(this.page, timeout);
    await stabilisePage(this.page);
  }

  /**
   * Scroll element into center view
   */
  async scrollToElement(selector: string): Promise<void> {
    try {
      await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, selector);
    } catch {
      console.log(`⚠️  Could not scroll to: ${selector}`);
    }
  }

  /**
   * Slow scroll the page to trigger lazy loading
   */
  async slowScrollToBottom(): Promise<void> {
    await this.page.evaluate(async () => {
      await new Promise<void>(resolve => {
        let scrolled = 0;
        const step = 300;
        const delay = 50;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          scrolled += step;
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, delay);
      });
    }).catch(() => { });
  }

  /**
   * Reset scroll to top
   */
  async scrollToTop(): Promise<void> {
    await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
  }

  /**
   * Check if element is visible
   */
  async isVisible(selector: string, timeout = 3000): Promise<boolean> {
    try {
      return await this.page.locator(selector).first().isVisible({ timeout });
    } catch {
      return false;
    }
  }

  /**
   * Get text content of an element
   */
  async getText(selector: string): Promise<string> {
    try {
      const text = await this.page.locator(selector).first().textContent({ timeout: 2000 });
      return (text || '').trim();
    } catch {
      return 'N/A';
    }
  }

  /**
   * Click and wait for navigation
   */
  async clickAndWait(selector: string, label: string): Promise<void> {
    const btn = this.page.locator(selector).first();
    const before = this.page.url();
    console.log(`clicking: ${label}`);
    try {
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click({ force: true });
      await this.page.waitForURL(
        (url: URL) => url.toString() !== before,
        { timeout: 8000 }
      );
      console.log(`navigated to: ${this.page.url()}`);
    } catch {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => { });
      console.log(`navigated to: ${this.page.url()}`);
    }
  }

  /**
   * Log available page elements for debugging
   */
  async logSnapshotContents(label: string): Promise<void> {
    console.log(`\n📋 ${label} — page snapshot:`);
    const tags = ['h1', 'h2', 'h3', 'p', 'span', 'button', 'a', 'label'];
    for (const tag of tags) {
      try {
        const els = this.page.locator(tag);
        const count = await els.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 3); i++) {
          const text = (await els.nth(i).textContent() || '').trim().substring(0, 60);
          if (text) console.log(`  [${tag}] "${text}"`);
        }
      } catch { }
    }
    console.log(`📋 End snapshot\n`);
  }
}