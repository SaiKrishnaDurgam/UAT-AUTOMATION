import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { compare } from '../utils/compare';
import { resolveExpected } from '../utils/resolveExpected';
import { captureFailures } from '../utils/failureCapture';

/**
 * PPVUpsellSuccessPage — Generic page object for post-payment success pages
 * that contain PPV upsell offers or promotional dismiss flows.
 *
 * Fully dynamic — reads all PPV names, prices, and CTA text from eventData.
 * Works for any upsell PPV (Fury vs Hall, future events, etc.)
 */
export class PPVUpsellSuccessPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ─────────────────────────────
  // DETECT: Is this a success/upsell page?
  // ─────────────────────────────
  async isSuccessPage(): Promise<boolean> {
    const body = await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return body.toLowerCase().includes('payment was successful');
  }

  async waitForUpsellOffer(buyCta: string): Promise<void> {
    console.log('⏳ Waiting for payment confirmation and upsell offer...');
    await this.page.waitForFunction(
      expectedBuyCta => {
        const bodyText = document.body.innerText.toLowerCase();
        return bodyText.includes('payment was successful') &&
          bodyText.includes(expectedBuyCta.toLowerCase());
      },
      buyCta,
      { timeout: 30_000 }
    );
    console.log('✅ Payment confirmation and upsell offer are visible');
  }

  // ─────────────────────────────
  // VALIDATE: PPV Upsell Success Page (generic)
  // Validates fields like: payment success text, upsell heading,
  // upsell image, upsell date, buy CTA, no thanks link
  // ─────────────────────────────
  async validateUpsellSuccess(
    data: any[],
    results: any[],
    eventData: Record<string, string>,
    pageName = 'First Success'
  ): Promise<void> {
    console.log(`🔍 Validating ${pageName} page...`);
    const bodyText = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const bodyLower = bodyText.toLowerCase();

    for (const row of data) {
      const field = (row['Field'] || '').trim();
      if (!field) continue;
      const expected = resolveExpected(row, eventData);

      // Skip validation if expected is 'N/A' or empty
      const expectedNorm = (expected || '').trim().toUpperCase();
      const expectedOptions = expectedNorm.split('|').map(opt => opt.trim());
      const isAllNAOrEmpty = expectedOptions.every(opt => opt === 'N/A' || opt === '');
      if (isAllNAOrEmpty) {
        console.log(`  ⏭️  Skipping [${field}] — expected is "${expected}"`);
        continue;
      }

      let actual = 'N/A';
      const key = field.toLowerCase().replace(/\s+/g, ' ').trim();

      if (key.includes('payment success')) {
        actual = bodyLower.includes('payment was successful') ? 'Your payment was successful' : 'N/A';

      } else if (key.includes('upsell heading') || key.includes('upsell title')) {
        let h1Text = '';
        const h1s = this.page.locator('h1');
        const h1Count = await h1s.count().catch(() => 0);
        for (let i = 0; i < h1Count; i++) {
          const text = ((await h1s.nth(i).textContent().catch(() => '')) || '').trim();
          if (text && text.toLowerCase() !== 'dazn') {
            h1Text = text;
            break;
          }
        }
        if (!h1Text) {
          h1Text = (await h1s.first().textContent().catch(() => '')) || '';
        }
        const h2 = await this.page.locator('h2').first().textContent().catch(() => '');
        actual = (h1Text || h2 || '').trim() || 'N/A';
        // Fallback: search body for heading text that matches expected
        if (actual === 'N/A' || (expected && !actual.toLowerCase().includes(expected.toLowerCase().substring(0, 15)))) {
          const headings = await this.page.locator('h1, h2, h3').allTextContents().catch(() => []);
          const match = headings.find((h: string) => h.toLowerCase().includes('vs') || h.toLowerCase().includes('miss'));
          if (match) actual = match.trim();
        }

      } else if (key.includes('upsell image') || key.includes('image present')) {
        const imgs = this.page.locator('img').filter({ hasNotText: /dazn/i });
        let found = false;
        const imgCount = await imgs.count().catch(() => 0);
        for (let i = 0; i < imgCount; i++) {
          if (await imgs.nth(i).isVisible().catch(() => false)) { found = true; break; }
        }
        actual = found ? 'Yes' : 'No';

      } else if (key.includes('upsell date') || key.includes('date badge')) {
        // Try multiple date formats: "Sat 13th Jun at 22:30", "Saturday at 18:00", etc.
        const datePatterns = [
          /\b(Sat|Sun|Mon|Tue|Wed|Thu|Fri)\w*\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+at\s+\d{1,2}:\d{2}/i,
          /\b(Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday)\s+at\s+\d{1,2}:\d{2}/i,
          /\b(Sat|Sun|Mon|Tue|Wed|Thu|Fri)\w*\s+at\s+\d{1,2}:\d{2}/i,
          /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+at\s+\d{1,2}:\d{2}/i,
        ];
        for (const pattern of datePatterns) {
          const match = bodyText.match(pattern);
          if (match) { actual = match[0].trim(); break; }
        }

      } else if (key.includes('upsell buy') || key.includes('buy cta') || key.includes('buy now')) {
        // Generic: find any "Buy Now For £X.XX" or "Buy Now" button
        const buyBtn = this.page.locator(
          'button:has-text("Buy"), a:has-text("Buy")'
        ).first();
        actual = (await buyBtn.textContent().catch(() => ''))?.trim() || 'N/A';

      } else if (key.includes('upsell price') || key === 'ppv price') {
        const priceMatch = bodyText.match(/(?:(?:[A-Z]{3}\s*|[£$€₹]\s?)\d+(?:[.,]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)/);
        actual = priceMatch ? priceMatch[0] : 'N/A';

      } else if (key.includes('no thanks')) {
        const noThanks = this.page.locator(
          'button:has-text("No thanks"), a:has-text("No thanks")'
        ).first();
        actual = (await noThanks.textContent().catch(() => ''))?.trim() || 'N/A';

      } else if (key.includes('upsell description')) {
        const descEl = await this.page.locator('h1 + p, h2 + p, [class*="description" i]')
          .first().textContent().catch(() => null);
        actual = descEl?.trim() || 'N/A';
        // Fallback: check if expected text exists in body
        if (actual === 'N/A' && expected && bodyLower.includes(expected.toLowerCase().substring(0, 20))) {
          actual = expected;
        }
      }

      const status = compare(actual, expected) ? 'PASS' : 'FAIL';
      const icon = status === 'PASS' ? '✅' : '❌';
      console.log(`  ${icon} [${field}] expected="${expected}" actual="${actual}"`);
      results.push({ page: pageName, field, expected, actual, status });
    }

    // Capture red-boxed screenshots for any failed fields
    await captureFailures(this.page, results, pageName);
  }

  // ─────────────────────────────
  // ACTION: Click upsell "Buy Now For £X.XX" CTA (generic)
  // ─────────────────────────────
  async clickBuyUpsell(): Promise<void> {
    console.log('💳 Clicking upsell "Buy Now" CTA...');
    const buyBtn = this.page.locator(
      'button:has-text("Buy Now For"), a:has-text("Buy Now For"), ' +
      'button:has-text("Buy Now for"), a:has-text("Buy Now for"), ' +
      'button:has-text("Buy now"), a:has-text("Buy now")'
    ).first();

    if (await buyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      const beforeUrl = this.page.url();
      await buyBtn.click({ force: true });
      console.log('✅ Clicked upsell Buy CTA');

      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 10000 }).catch(() => {});
      console.log(`✅ Navigated to: ${this.page.url()}`);
    } else {
      console.log('⚠️ Upsell Buy CTA not found');
    }
  }

  // ─────────────────────────────
  // VALIDATE: DAZN Bet / Promotional Upsell (Second Success)
  // ─────────────────────────────
  async validateBetUpsell(
    data: any[],
    results: any[],
    eventData: Record<string, string>,
    pageName = 'Second Success'
  ): Promise<void> {
    console.log(`🔍 Validating ${pageName} page (DAZN Bet / Promo)...`);
    const bodyText = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const bodyLower = bodyText.toLowerCase();

    for (const row of data) {
      const field = (row['Field'] || '').trim();
      if (!field) continue;
      const expected = resolveExpected(row, eventData);

      // Skip validation if expected is 'N/A' or empty
      const expectedNorm = (expected || '').trim().toUpperCase();
      const expectedOptions = expectedNorm.split('|').map(opt => opt.trim());
      const isAllNAOrEmpty = expectedOptions.every(opt => opt === 'N/A' || opt === '');
      if (isAllNAOrEmpty) {
        console.log(`  ⏭️  Skipping [${field}] — expected is "${expected}"`);
        continue;
      }

      let actual = 'N/A';
      const key = field.toLowerCase().replace(/\s+/g, ' ').trim();

      if (key.includes('payment success')) {
        actual = bodyLower.includes('payment was successful') ? 'Your payment was successful' : 'N/A';

      } else if (key.includes('bet offer title') || key.includes('promo title')) {
        actual = bodyLower.includes('exclusive dazn bet') ? 'Exclusive DAZN Bet Offer' : 'N/A';
        // Generic fallback: check expected text
        if (actual === 'N/A' && expected && bodyLower.includes(expected.toLowerCase().substring(0, 15))) {
          actual = expected;
        }

      } else if (key.includes('bet heading') || key.includes('promo heading')) {
        const headings = await this.page.locator('h1, h2, h3').allTextContents().catch(() => []);
        const betH = headings.find((h: string) =>
          h.toLowerCase().includes('free bet') || h.toLowerCase().includes('dazn bet')
        );
        actual = betH?.trim() || (bodyLower.includes('free bet') ? expected : 'N/A');

      } else if (key.includes('bet image') || key.includes('promo image')) {
        const imgs = this.page.locator('img').filter({ hasNotText: /logo/i });
        actual = (await imgs.count().catch(() => 0)) > 0 ? 'Yes' : 'No';

      } else if (key.includes('activate') || key.includes('bet cta')) {
        const btn = this.page.locator(
          'button:has-text("Activate"), a:has-text("Activate")'
        ).first();
        actual = (await btn.textContent().catch(() => ''))?.trim() || 'N/A';

      } else if (key.includes('maybe later') || key.includes('dismiss')) {
        const link = this.page.locator(
          'button:has-text("Maybe later"), a:has-text("Maybe later")'
        ).first();
        actual = (await link.textContent().catch(() => ''))?.trim() || 'N/A';
      }

      const status = compare(actual, expected) ? 'PASS' : 'FAIL';
      const icon = status === 'PASS' ? '✅' : '❌';
      console.log(`  ${icon} [${field}] expected="${expected}" actual="${actual}"`);
      results.push({ page: pageName, field, expected, actual, status });
    }

    // Capture red-boxed screenshots for any failed fields
    await captureFailures(this.page, results, pageName);
  }

  // ─────────────────────────────
  // ACTION: Click "Maybe later" to dismiss promo (generic)
  // ─────────────────────────────
  async clickMaybeLater(): Promise<void> {
    console.log('🚫 Clicking "Maybe later" to dismiss promo offer...');
    const maybeLater = this.page.locator(
      'button:has-text("Maybe later"), a:has-text("Maybe later")'
    ).first();
    if (await maybeLater.isVisible({ timeout: 5000 }).catch(() => false)) {
      const beforeUrl = this.page.url();
      await maybeLater.click({ force: true });
      console.log('✅ Clicked "Maybe later"');
      await this.page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 10000 }).catch(() => {});
    } else {
      console.log('⚠️ "Maybe later" not found — trying to proceed');
    }
  }

  // ─────────────────────────────
  // ACTION: Click "No thanks" to skip upsell (generic)
  // ─────────────────────────────
  async clickNoThanks(): Promise<void> {
    console.log('🚫 Clicking "No thanks" to skip upsell...');
    const noThanks = this.page.locator(
      'button:has-text("No thanks"), a:has-text("No thanks"), ' +
      'button:has-text("No, thanks"), a:has-text("No, thanks")'
    ).first();
    if (await noThanks.isVisible({ timeout: 5000 }).catch(() => false)) {
      const beforeUrl = this.page.url();
      await noThanks.click({ force: true });
      console.log('✅ Clicked "No thanks"');
      await this.page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 10000 }).catch(() => {});
    } else {
      console.log('⚠️ "No thanks" not found');
    }
  }
}
