import { Page, Frame } from '@playwright/test';
import { BasePage } from './BasePage';

// VGS Iframe titles (each card field is a separate iframe)
const CARD_NUMBER_FRAME = 'Secure card number input frame';
const EXPIRY_DATE_FRAME = 'Secure card expiration date input frame';
const CVV_FRAME = 'Secure card security code input frame';
const CARD_HOLDER_FRAME = 'Secure text input frame';

export class PaymentFillPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * STEP 1: Select Credit & Debit Card payment method
   */
  async selectCreditCard(): Promise<void> {
    console.log('💳 Locating Credit & Debit Card payment section...');
    const creditCardSection = this.page.locator("section[id='Credit & Debit Card']");
    const creditCardRadioBtn = this.page.locator("section[id='Credit & Debit Card'] span svg").first();

    await creditCardSection.waitFor({ state: 'visible', timeout: 15000 });
    await creditCardSection.scrollIntoViewIfNeeded();
    await creditCardRadioBtn.click({ force: true });
    console.log('✅ Clicked Credit & Debit Card radio button.');

    // Wait for all VGS iframes to load
    const iframeTitles = [CARD_NUMBER_FRAME, EXPIRY_DATE_FRAME, CVV_FRAME, CARD_HOLDER_FRAME];
    console.log('⏳ Waiting for VGS input iframes to load...');
    for (const title of iframeTitles) {
      await this.page.locator(`iframe[title='${title}']`).waitFor({ state: 'visible', timeout: 30000 });
    }
    console.log('✅ All VGS iframes are visible.');
  }

  /**
   * STEP 2: Get VGS Frame with retry (iframes take time to initialize)
   */
  async getVGSFrame(iframeTitle: string): Promise<Frame> {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const iframeLocator = this.page.locator(`iframe[title='${iframeTitle}']`);
      const elementHandle = await iframeLocator.elementHandle();
      if (!elementHandle) {
        console.log(`⚠️ Attempt ${attempt}/${maxRetries}: Iframe element handle not found for "${iframeTitle}". Retrying...`);
        await this.page.waitForTimeout(2000);
        continue;
      }

      const frame = await elementHandle.contentFrame();
      if (!frame) {
        console.log(`⚠️ Attempt ${attempt}/${maxRetries}: Content frame not found for "${iframeTitle}". Retrying...`);
        await this.page.waitForTimeout(2000);
        continue;
      }

      await frame.waitForLoadState('domcontentloaded').catch(() => {});
      const inputCount = await frame.locator('input').count().catch(() => 0);
      if (inputCount > 0) return frame;

      console.log(`⚠️ Attempt ${attempt}/${maxRetries}: Input not found inside iframe "${iframeTitle}". Retrying...`);
      await this.page.waitForTimeout(2000);
    }
    throw new Error(`Failed to get VGS frame after ${maxRetries} attempts: ${iframeTitle}`);
  }

  /**
   * STEP 3: Type into VGS iframe input (character by character with delay)
   */
  async typeInIframe(iframeTitle: string, value: string): Promise<void> {
    console.log(`typing: typing into VGS frame "${iframeTitle}"...`);
    const frame = await this.getVGSFrame(iframeTitle);
    const input = frame.locator("input:not([type='hidden'])").first();

    await input.click({ force: true });
    await input.press('Meta+A').catch(() => input.press('Control+A'));
    await input.press('Backspace');

    // Must type char by char — VGS auto-formats (spaces in card number, "/" in expiry)
    for (const char of value) {
      await this.page.keyboard.type(char, { delay: 150 });
    }
    console.log(`✅ Completed typing into "${iframeTitle}".`);
  }

  /**
   * STEP 4: Fill all card details
   */
  async fillCardDetails(
    cardNumber: string,
    expiryDate: string,
    cvv: string,
    cardHolderName: string
  ): Promise<void> {
    console.log('📝 Filling credit card details...');
    await this.typeInIframe(CARD_NUMBER_FRAME, cardNumber);
    await this.typeInIframe(EXPIRY_DATE_FRAME, expiryDate);
    await this.typeInIframe(CVV_FRAME, cvv);
    await this.typeInIframe(CARD_HOLDER_FRAME, cardHolderName);
    console.log('✅ Finished filling card details.');
  }

  /**
   * STEP 5: Click save card checkbox (optional)
   */
  async clickSaveCard(): Promise<void> {
    console.log('💾 Checking for save card checkbox...');
    const checkbox = this.page.locator("label[role='switch']").first();
    if (await checkbox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await checkbox.click({ force: true });
      console.log('✅ Clicked Save Card checkbox (toggled off/on).');
    } else {
      console.log('ℹ️ Save Card checkbox not found/visible.');
    }
  }

  /**
   * STEP 6: Click submit button with multiple fallbacks
   */
  async clickSubmit(): Promise<void> {
    console.log('🖱️ Locating payment submit button...');
    const submitSelectors = [
      '.sc-hmdnzv.mksuv',
      'button[type="submit"]',
      'button:has-text("Pay")',
      'button:has-text("Subscribe")',
      'button:has-text("Start subscription")',
      'button:has-text("Submit")'
    ];

    let clicked = false;
    for (const selector of submitSelectors) {
      const btn = this.page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`🖱️ Clicking submit button using selector: ${selector}`);
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ force: true });
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Last resort: click any submit button on the page
      const lastResortBtn = this.page.locator('button[type="submit"]').first();
      if (await lastResortBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('🖱️ Clicking last resort button[type="submit"]');
        await lastResortBtn.click({ force: true });
      } else {
        throw new Error('❌ Failed to locate payment submit button.');
      }
    }
  }

  /**
   * Verify success message / redirect after submit
   */
  async verifyPaymentSuccess(): Promise<void> {
    console.log('⏳ Waiting for payment success/welcome screen...');
    const successSelectors = [
      'text=/Success/i',
      'text=/Welcome/i',
      'text=/Thank you/i',
      'text=/Start watching/i',
      'text=/Confirmation/i',
      'h1:has-text("Welcome")',
      'h1:has-text("Success")',
      'h1:has-text("Thank you")'
    ];

    let foundSuccess = false;
    // Wait up to 30 seconds for success indicators or url change
    for (let attempt = 0; attempt < 15; attempt++) {
      if (this.page.isClosed()) throw new Error('Page closed during payment processing');
      
      const currentUrl = this.page.url();
      if (
        currentUrl.includes('success') ||
        currentUrl.includes('welcome') ||
        currentUrl.includes('home') ||
        currentUrl.includes('watching')
      ) {
        console.log(`✅ Success page detected via URL: ${currentUrl}`);
        foundSuccess = true;
        break;
      }

      for (const sel of successSelectors) {
        if (await this.page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`✅ Success page detected via selector: ${sel}`);
          foundSuccess = true;
          break;
        }
      }

      if (foundSuccess) break;
      await this.page.waitForTimeout(2000);
    }

    if (!foundSuccess) {
      // Check if we have error messages on the page
      const errorMsg = await this.page.locator('[class*="error" i], [role="alert"]').first().textContent().catch(() => '');
      if (errorMsg && errorMsg.trim()) {
        throw new Error(`Payment failed. Error on page: ${errorMsg.trim()}`);
      }
      throw new Error('Timeout waiting for payment success page/confirmation');
    }
  }

  /**
   * Click Continue on success page
   */
  async clickSuccessContinue(): Promise<void> {
    console.log('🖱️ Clicking Continue on success page...');
    const continueBtn = this.page.locator(
      'button:has-text("Continue"), ' +
      'button:has-text("Start watching"), ' +
      'button:has-text("Go to home"), ' +
      'a:has-text("Continue"), ' +
      'a:has-text("Start watching")'
    ).first();

    if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continueBtn.click({ force: true }).catch(() => {});
      console.log('✅ Clicked success CTA');
    } else {
      console.log('ℹ️ No explicit Continue button found on success page (or auto-redirected)');
    }
  }

  /**
   * Complete flow orchestrator
   */
  async fillPaymentAndSubmit(
    cardNumber = '4111111111111111',
    expiryDate = '03/30',
    cvv = '737',
    cardHolderName = 'Test User'
  ): Promise<void> {
    await this.selectCreditCard();
    await this.fillCardDetails(cardNumber, expiryDate, cvv, cardHolderName);
    await this.clickSaveCard();
    await this.clickSubmit();
  }
}
