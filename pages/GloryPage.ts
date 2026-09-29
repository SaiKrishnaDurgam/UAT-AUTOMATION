import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { StandalonePPVPage } from './StandalonePPVPage';
import { SignupPage } from './SignupPage';
import { PaymentPage } from './PaymentPage';
import { createTestUser } from '../utils/testDataBuilder';

/**
 * GloryPage — Page object for the DAZN Glory Kickboxing landing page
 * Handles navigation, cookie acceptance, page validation, PPV tile selection,
 * Buy Now modal clicking, and complete flow orchestration through to payment
 */
export class GloryPage extends BasePage {
  // Composed page objects — initialized once and reused
  private standalonePPV: StandalonePPVPage;
  private signup: SignupPage;
  private payment: PaymentPage;

  constructor(page: Page) {
    super(page);
    // Initialize other page objects with the same 'page' instance
    // so they all operate on the same browser tab
    this.standalonePPV = new StandalonePPVPage(page);
    this.signup        = new SignupPage(page);
    this.payment       = new PaymentPage(page);
  }

  // ─────────────────────────────
  // NAVIGATE TO GLORY PAGE
  // ─────────────────────────────
  async navigate(url?: string): Promise<void> {
    const targetUrl = url || 'https://www.dazn.com/welcome/glory';
    console.log(`🌍 [GloryPage] Navigating to: ${targetUrl}`);
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });

    // Wait for and accept cookie consent banner
    await this.waitForConsentAndDismiss(15000);

    // Wait for page network to settle and content to render
    await this.page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {
      console.log('⚠️ [GloryPage] Network idle timeout — continuing anyway');
    });

    console.log(`✅ [GloryPage] Landed on: ${this.page.url()}`);
  }

  // ─────────────────────────────
  // VALIDATE GLORY KICKBOXING PAGE
  // ─────────────────────────────
  async validateGloryPage(): Promise<boolean> {
    console.log('🔍 [GloryPage] Validating we are on Glory Kick Boxing page...');

    const url = this.page.url().toLowerCase();
    const bodyText = await this.page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const lowerBody = bodyText.toLowerCase();

    // Check URL contains 'glory'
    const urlHasGlory = url.includes('glory');

    // Check body content for Glory/Kickboxing indicators
    const contentHasGlory = lowerBody.includes('glory');
    const contentHasKickboxing = lowerBody.includes('kickboxing');
    const contentHasGloryKickboxing = lowerBody.includes('glory kickboxing');

    const isValid = urlHasGlory || contentHasGlory || contentHasKickboxing || contentHasGloryKickboxing;

    console.log(`  📋 URL contains "glory": ${urlHasGlory}`);
    console.log(`  📋 Page contains "glory": ${contentHasGlory}`);
    console.log(`  📋 Page contains "kickboxing": ${contentHasKickboxing}`);
    console.log(`  📋 Page contains "glory kickboxing": ${contentHasGloryKickboxing}`);
    console.log(`✅ [GloryPage] Validation result: ${isValid ? 'PASS' : 'FAIL'}`);

    return isValid;
  }

  // ─────────────────────────────
  // FIND AND CLICK CONFIGURED EVENT IN "COMING UP" RAIL
  // ─────────────────────────────
  async clickConfiguredEventTile(targetEvent: string): Promise<void> {
    if (!targetEvent.trim()) {
      throw new Error('❌ [GloryPage] Configured PPV name is required to locate a Glory tile.');
    }
    console.log(`🔍 [GloryPage] Searching for "${targetEvent}" in "Coming up" rail...`);

    // ── Step 1: Scroll to "Coming up" section ──
    await this.scrollToComingUpRail();

    // ── Step 2: Find rail wrapper and navigation button ──
    const railHeader = this.page.getByText(/coming up/i).first();
    const railWrapper = railHeader.locator(
      'xpath=ancestor::*[contains(@class,"rail__rail-wrapper")][1] | ' +
      'ancestor::section[contains(@class,"rail")][1] | ' +
      'ancestor::div[contains(@class,"rail")][1]'
    );

    const nextBtn = railWrapper.locator(
      'button[aria-label="Next slide"], ' +
      'button[class*="swiper-button-next"], ' +
      '.custom-swiper-button-next, ' +
      '[class*="next" i]'
    ).first();

    await nextBtn.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {
      console.log('⚠️ [GloryPage] Swiper next button not attached');
    });

    await railWrapper.hover({ force: true }).catch(() => { });
    await this.page.waitForTimeout(200);

    // ── Step 3: Score-based tile search ──
    const cleanStr = (s: string) =>
      (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

    const cleanName = cleanStr(targetEvent);
    const nameWords = cleanName.split(/\s+/).filter(Boolean);

    const scoreMatch = (tileText: string): number => {
      if (!tileText) return 0;
      const cleanTile = cleanStr(tileText);
      if (cleanTile === cleanName) return 100;
      const allWordsMatch = nameWords.every(w => cleanTile.includes(w));
      if (!allWordsMatch) return 0;
      const ratio = cleanName.length / cleanTile.length;
      return Math.round(ratio * 90);
    };

    const isTileInView = async (): Promise<any> => {
      const tileCandidates = railWrapper.locator(
        'a[class*="tile__link" i], a[class*="tile" i], ' +
        'div[class*="tile" i], div[class*="card" i], a, button'
      );
      const count = await tileCandidates.count().catch(() => 0);

      let bestTile: any = null;
      let bestScore = 0;

      for (let i = 0; i < count; i++) {
        const tile = tileCandidates.nth(i);
        if (await tile.isVisible().catch(() => false)) {
          const text = await tile.textContent().catch(() => '');
          if (text) {
            const inView = await tile.evaluate((el: HTMLElement) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > 0 && r.left < window.innerWidth;
            }).catch(() => false);

            if (inView) {
              const score = scoreMatch(text);
              if (score > bestScore) {
                bestScore = score;
                bestTile = tile;
                if (score >= 100) break;
              }
            }

          }
        }
      }

      if (bestTile) {
        const tileText = (await bestTile.textContent().catch(() => '')) || '';
        console.log(`  🎯 Best matching tile (score=${bestScore}): "${tileText.trim().replace(/\s+/g, ' ').substring(0, 80)}"`);
      }
      return bestTile;
    };

    // ── Step 4: Navigate rail clicking "Next" until target tile is found ──
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
        console.log('⚠️ [GloryPage] Next button disabled — end of rail reached');
        break;
      }

      let nextCount = await nextBtn.count().catch(() => 0);
      if (nextCount === 0) {
        await this.page.waitForTimeout(100);
        nextCount = await nextBtn.count().catch(() => 0);
        if (nextCount === 0) {
          console.log('⚠️ [GloryPage] Next button not found in DOM after retry');
          break;
        }
      }

      await nextBtn.click({ timeout: 5000, force: true }).catch((e: any) => {
        console.log('⚠️ [GloryPage] Next click error:', e.message);
      });
      clicks++;
      await this.page.waitForTimeout(300);
      found = await isTileInView();
    }

    console.log(`✅ [GloryPage] Swiper "Next" clicks performed: ${clicks}`);

    if (!found) {
      throw new Error(`❌ [GloryPage] Could not find "${targetEvent}" tile in "Coming up" rail after ${clicks} clicks`);
    }

    // ── Step 5: Scroll tile into view and click ──
    console.log(`📌 [GloryPage] Found "${targetEvent}" tile, clicking...`);
    await found.scrollIntoViewIfNeeded().catch(() => { });
    await this.page.waitForTimeout(200);

    const beforeUrl = this.page.url();
    try {
      await found.click({ force: true, timeout: 10000 });
      console.log(`✅ [GloryPage] Clicked "${targetEvent}" tile`);
    } catch (e: any) {
      console.log('⚠️ [GloryPage] Standard click failed → trying JS click');
      const handle = await found.elementHandle();
      if (handle) {
        await this.page.evaluate((el: any) => el.click(), handle);
        console.log(`✅ [GloryPage] JS click executed on tile`);
      } else {
        throw new Error(`❌ [GloryPage] Failed to click "${targetEvent}" tile: ${e.message}`);
      }
    }

    // ── Step 6: Wait for navigation or modal ──
    await this.page.waitForTimeout(2000);
    const afterUrl = this.page.url();
    if (afterUrl !== beforeUrl) {
      console.log(`✅ [GloryPage] Navigated to: ${afterUrl}`);
    } else {
      console.log(`🔍 [GloryPage] Tile click opened modal/popup on same page`);
    }
  }

  // ─────────────────────────────
  // FIND CONFIGURED EVENT IN HERO BANNER AND CLICK BUY NOW
  // ─────────────────────────────
  async clickConfiguredEventBanner(targetEvent: string): Promise<void> {
    if (!targetEvent.trim()) {
      throw new Error('❌ [GloryPage] Configured PPV name is required to locate a Glory banner.');
    }

    const normalize = (value: string) =>
      value.toLowerCase()
        .replace(/\bv(?:s)?\.?\b/g, ' vs ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const eventWords = normalize(targetEvent)
      .split(' ')
      .filter(word => word.length > 2 && !['the', 'and', 'for', 'with', 'from', 'vs'].includes(word));
    if (!eventWords.length) {
      throw new Error(`❌ [GloryPage] Configured PPV name has no searchable event words: "${targetEvent}".`);
    }

    await this.page.evaluate(() => {
      const stopSwiper = (swiper: any) => {
        try { swiper?.autoplay?.stop(); } catch { }
        try { swiper.params.autoplay = false; } catch { }
      };
      document.querySelectorAll<HTMLElement>('[class*="swiper" i], [class*="banner" i], [class*="hero" i]')
        .forEach((element: any) => stopSwiper(element.swiper));
    }).catch(() => {});

    const banners = this.page.locator(
      'main [class*="hero-banner" i], main [class*="herobanner" i], ' +
      'main [class*="banner" i], main [class*="hero" i], main [data-testid*="banner" i]'
    );
    const count = await banners.count().catch(() => 0);
    let banner: any = null;

    for (let index = 0; index < count; index++) {
      const candidate = banners.nth(index);
      if (!await candidate.isVisible({ timeout: 1000 }).catch(() => false)) continue;
      const text = normalize((await candidate.innerText().catch(() => '')) || '');
      if (eventWords.every(word => text.includes(word))) {
        banner = candidate;
        break;
      }
    }

    if (!banner) {
      throw new Error(`❌ [GloryPage] No visible Glory hero banner matched configured event "${targetEvent}".`);
    }

    const buyNow = banner.locator(
      'button:has-text("Buy now"), a:has-text("Buy now"), ' +
      'button:has-text("Buy Now"), a:has-text("Buy Now")'
    ).first();
    if (!await buyNow.isVisible({ timeout: 5000 }).catch(() => false)) {
      throw new Error(`❌ [GloryPage] Matching Glory banner for "${targetEvent}" has no visible Buy Now CTA.`);
    }

    const urlBeforeClick = this.page.url();
    await buyNow.click({ force: true, timeout: 10000 });
    await this.page.waitForURL(url => url.toString() !== urlBeforeClick, { timeout: 15000 }).catch(() => {});
    console.log(`✅ [GloryPage] Clicked Buy Now in configured banner for "${targetEvent}".`);
  }

  // ─────────────────────────────
  // CLICK BUY NOW IN THE MODAL POPUP
  // ─────────────────────────────
  async clickBuyNowInModal(): Promise<void> {
    console.log('🔍 [GloryPage] Looking for Buy Now button in modal popup...');

    // Wait for modal to appear (up to 15 seconds)
    const modal = await this.waitForModalWithBuyNow();
    if (!modal) {
      throw new Error('❌ [GloryPage] Modal popup with Buy Now button not found');
    }

    console.log('✅ [GloryPage] Modal popup found, clicking Buy Now...');

    // Try to locate Buy Now button within the modal
    let buyNowBtn = modal.locator(
      'button:has-text("Buy now"), a:has-text("Buy now"), ' +
      'button:has-text("Buy Now"), a:has-text("Buy Now")'
    ).first();

    let visible = await buyNowBtn.isVisible({ timeout: 3000 }).catch(() => false);

    if (!visible) {
      // Fallback: search the entire page for Buy Now
      console.log('⏳ [GloryPage] Buy Now not found in modal container — searching entire page...');
      buyNowBtn = this.page.locator(
        'button:has-text("Buy now"), a:has-text("Buy now"), ' +
        'button:has-text("Buy Now"), a:has-text("Buy Now")'
      ).first();
      visible = await buyNowBtn.isVisible({ timeout: 5000 }).catch(() => false);
    }

    if (!visible) {
      // Last resort: try JS-based click
      console.log('🔍 [GloryPage] Trying JS-based Buy Now click...');
      const clicked = await this.page.evaluate(() => {
        const allEls = document.querySelectorAll('button, a');
        for (const el of allEls) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (text === 'buy now' || text.startsWith('buy now')) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (!clicked) {
        throw new Error('❌ [GloryPage] Buy Now button not found after tile click');
      }

      console.log('✅ [GloryPage] JS Buy Now click executed');
    } else {
      // Standard click on Buy Now button
      await buyNowBtn.scrollIntoViewIfNeeded().catch(() => { });
      await this.page.waitForTimeout(200);

      try {
        await buyNowBtn.click({ force: true, timeout: 10000 });
        console.log('✅ [GloryPage] Clicked Buy Now in modal');
      } catch (e: any) {
        console.log('⚠️ [GloryPage] Standard click failed → trying JS click');
        const handle = await buyNowBtn.elementHandle();
        if (handle) {
          await this.page.evaluate((el: any) => el.click(), handle);
          console.log('✅ [GloryPage] JS Buy Now click executed');
        } else {
          throw new Error(`❌ [GloryPage] Failed to click Buy Now: ${e.message}`);
        }
      }
    }

    // Wait for navigation to PPV/Plan page
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { });
    await this.page.waitForTimeout(2000);
    console.log(`✅ [GloryPage] After Buy Now, landed on: ${this.page.url()}`);
  }

  // ──────────────────────────────────────────────────────────
  // COMPLETE GLORY FLOW — Orchestrates the full journey from
  // Glory page → PPV tile click → Buy Now → Standalone PPV →
  // Signup (email + personal details) → Payment → Success
  // ──────────────────────────────────────────────────────────
  async completeGloryFlow(
    options?: {
      ppvName?: string;
      planType?: 'flex' | 'annual_monthly';
      env?: string;
    }
  ): Promise<void> {
    const ppvName = options?.ppvName || process.env.PPV_NAME || '';
    if (!ppvName.trim()) {
      throw new Error('❌ [GloryPage] Configured PPV name is required to complete the Glory flow.');
    }
    const planType = options?.planType || 'flex';
    const env = options?.env || process.env.DAZN_ENV || 'stag';
    const results: Array<{ page: string; field: string; expected: string; actual: string; status: string }> = [];

    try {
      // ═══════════════════════════════════════
      // STEP 1: Glory page — Navigate & Validate
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log('STEP 1: Glory Page — Navigation & Validation');
      console.log('══════════════════════════════════════════════');

      await this.navigate('https://www.dazn.com/glory');
      const isValid = await this.validateGloryPage();
      if (!isValid) {
        throw new Error('❌ [GloryPage] Failed to validate Glory Kickboxing page');
      }
      results.push({
        page: 'Glory Kickboxing',
        field: 'Glory Page Validation',
        expected: 'true',
        actual: 'true',
        status: 'PASS',
      });

      // ═══════════════════════════════════════
      // STEP 2: Click configured GLORY event tile
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log(`STEP 2: Click ${ppvName} Tile`);
      console.log('══════════════════════════════════════════════');

      await this.clickConfiguredEventTile(ppvName);
      results.push({
        page: 'Glory Kickboxing',
        field: 'Configured GLORY Tile Clicked',
        expected: 'Tile clicked',
        actual: 'Tile clicked',
        status: 'PASS',
      });

      // ═══════════════════════════════════════
      // STEP 3: Click Buy Now in modal
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log('STEP 3: Click Buy Now in Modal');
      console.log('══════════════════════════════════════════════');

      await this.clickBuyNowInModal();
      results.push({
        page: 'Glory Kickboxing',
        field: 'Buy Now Clicked in Modal',
        expected: 'Navigated onwards',
        actual: `URL: ${this.page.url()}`,
        status: 'PASS',
      });

      // ═══════════════════════════════════════
      // STEP 4: Standalone PPV page
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log('STEP 4: Standalone PPV Page');
      console.log('══════════════════════════════════════════════');

      // Ensure PPV checkbox is checked
      if (!(await this.standalonePPV.isPPVCheckboxChecked(ppvName))) {
        console.log('📌 Toggling PPV checkbox to ensure it is checked...');
        await this.standalonePPV.togglePPVCheckbox(ppvName);
      }

      // Select plan (flex or annual) and click Continue
      await this.standalonePPV.selectPlan(planType);
      await this.page.waitForTimeout(500);
      await this.standalonePPV.clickContinue();
      results.push({
        page: 'Standalone PPV',
        field: 'Plan Selected & Continue Clicked',
        expected: 'Navigated to next page',
        actual: 'Continue clicked',
        status: 'PASS',
      });

      // Wait for page transition
      await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
      await this.page.waitForTimeout(1500);

      // ═══════════════════════════════════════
      // STEP 5: Signup Page (Email + Personal Details)
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log('STEP 5: Signup Page — Email & Personal Details');
      console.log('══════════════════════════════════════════════');

      const user = createTestUser();

      // Check if on email step or already on personal details
      const emailInput = await this.signup.findEmailInput();
      if (emailInput) {
        await this.signup.enterEmail(user.email);
        await this.signup.clickContinue();
        console.log(`✅ Email entered: ${user.email}`);

        // Wait for navigation to personal details
        await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
        await this.page.waitForTimeout(1500);
      } else {
        console.log('ℹ️ Email input not found — may already be on personal details page');
      }

      // Fill personal details
      console.log('📝 Filling personal details...');
      try {
        await this.signup.fillPersonalDetails(user);
        await this.page.waitForTimeout(500);
        await this.signup.clickPersonalDetailsContinue();

        // Wait for navigation to payment
        await this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
        await this.page.waitForTimeout(2000);

        results.push({
          page: 'Signup',
          field: 'Personal Details Submitted',
          expected: 'Navigated to payment',
          actual: `URL: ${this.page.url()}`,
          status: 'PASS',
        });
      } catch (fillErr: any) {
        const currentUrl = this.page.url().toLowerCase();
        if (currentUrl.includes('payment') || currentUrl.includes('paymentdetails')) {
          console.log(`ℹ️ Page transitioned to payment despite form fill issue: ${fillErr.message}`);
          results.push({
            page: 'Signup',
            field: 'Personal Details Submitted',
            expected: 'Navigated to payment',
            actual: `URL: ${currentUrl}`,
            status: 'PASS',
          });
        } else {
          throw fillErr;
        }
      }

      // ═══════════════════════════════════════
      // STEP 6: Payment Page
      // ═══════════════════════════════════════
      console.log('\n══════════════════════════════════════════════');
      console.log('STEP 6: Payment Page');
      console.log('══════════════════════════════════════════════');

      const isPayment = await this.payment.isPaymentPage();
      if (isPayment) {
        console.log('✅ Payment page reached');
        results.push({
          page: 'Payment',
          field: 'Payment Page Reached',
          expected: 'Yes',
          actual: 'Yes',
          status: 'PASS',
        });

        // Fill payment details on staging environment
        if (env === 'stag') {
          console.log('💳 Environment is stag — filling credit card payment details...');
          try {
            await this.payment.fillPaymentAndSubmit();
            await this.payment.verifyPaymentSuccess();
            await this.payment.clickSuccessContinue();
            console.log('✅ Payment details submitted successfully on staging!');
            results.push({
              page: 'Payment Success',
              field: 'Payment Completed',
              expected: 'Success page reached',
              actual: 'Success page reached',
              status: 'PASS',
            });
          } catch (paymentErr: any) {
            console.error(`❌ Payment filling failed: ${paymentErr.message}`);
            results.push({
              page: 'Payment Success',
              field: 'Payment Completed',
              expected: 'Success page reached',
              actual: `Failed: ${paymentErr.message}`,
              status: 'FAIL',
            });
            throw paymentErr;
          }
        } else {
          console.log(`ℹ️ Environment is "${env}" — skipping card details filling.`);
        }
      } else {
        console.log('⚠️ Payment page not detected, checking current URL...');
        const finalUrl = this.page.url();
        if (finalUrl.includes('paymentDetails') || finalUrl.includes('payment')) {
          console.log('💳 Payment page detected via URL fallback');
          results.push({
            page: 'Payment',
            field: 'Payment Page Reached',
            expected: 'Yes',
            actual: 'Yes',
            status: 'PASS',
          });
        } else {
          results.push({
            page: 'Payment',
            field: 'Payment Page Reached',
            expected: 'Yes',
            actual: `No — URL: ${finalUrl}`,
            status: 'FAIL',
          });
        }
      }

    } catch (error: any) {
      console.error(`❌ [GloryPage] Flow failed: ${error.message}`);
      throw error;
    }

    // ── Final summary ──
    console.log('\n══════════════════════════════════════════════');
    console.log('FLOW RESULTS SUMMARY');
    console.log('══════════════════════════════════════════════');
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`Total: ${results.length} | ✅ PASS: ${passed} | ❌ FAIL: ${failed}`);
    for (const r of results) {
      console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} [${r.page}] ${r.field}: ${r.status}`);
    }
    console.log(`\n✅ [GloryPage] Flow completed. Final URL: ${this.page.url()}`);
  }

  // ─────────────────────────────
  // WAIT FOR MODAL WITH BUY NOW BUTTON
  // ─────────────────────────────
  private async waitForModalWithBuyNow(): Promise<any> {
    console.log('🔍 [GloryPage] Searching for modal popup with Buy Now...');

    const modalSelectors = [
      '[role="dialog"]',
      '[class*="modal" i]',
      '[class*="popup" i]',
      '[class*="Dialog" i]',
      '[aria-modal="true"]',
      '[class*="overlay" i]',
    ];

    // Try for up to 15 seconds (150 attempts × 100ms)
    for (let attempt = 0; attempt < 150; attempt++) {
      for (const selector of modalSelectors) {
        const modalElements = this.page.locator(selector);
        const count = await modalElements.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const modal = modalElements.nth(i);
          if (await modal.isVisible().catch(() => false)) {
            const hasBuyNow = await modal.locator(
              'button:has-text("Buy now"), a:has-text("Buy now"), ' +
              'button:has-text("Buy Now"), a:has-text("Buy Now")'
            ).first().isVisible({ timeout: 500 }).catch(() => false);
            if (hasBuyNow) {
              console.log(`✅ [GloryPage] Found modal with Buy Now via selector: "${selector}" (index ${i})`);
              return modal;
            }
          }
        }
      }
      await this.page.waitForTimeout(100);
    }

    console.log('⚠️ [GloryPage] No modal with "Buy Now" found after 15 seconds');
    return null;
  }

  // ─────────────────────────────
  // SCROLL TO "COMING UP" RAIL
  // ─────────────────────────────
  private async scrollToComingUpRail(): Promise<void> {
    console.log('📜 [GloryPage] Scrolling to "Coming up" section...');

    const railHeader = this.page.getByText(/coming up/i).first();

    let found = false;
    for (let i = 0; i < 10; i++) {
      if (await railHeader.isVisible().catch(() => false)) {
        found = true;
        break;
      }
      const scrollPos = (i + 1) * 700;
      await this.page.evaluate((pos) => {
        window.scrollTo({ top: pos, behavior: 'instant' });
      }, scrollPos).catch(() => { });

      found = await railHeader.waitFor({ state: 'attached', timeout: 300 })
        .then(() => true).catch(() => false);
      if (found) break;
    }

    if (!found) {
      found = await railHeader.waitFor({ state: 'attached', timeout: 10000 })
        .then(() => true).catch(() => false);
    }

    if (!found) {
      throw new Error('❌ [GloryPage] "Coming up" section heading not found on page');
    }

    await railHeader.scrollIntoViewIfNeeded().catch(() => { });
    console.log('✅ [GloryPage] "Coming up" section heading is visible');
  }
}