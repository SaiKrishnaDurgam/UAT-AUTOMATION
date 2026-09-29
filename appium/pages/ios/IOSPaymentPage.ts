import fs from 'fs';
import path from 'path';
import { IOSBasePage, WdBrowser } from './IOSBasePage';
import { IOSValidationResult } from './IOSValidationPage';
import { IOSSafariValidationPage } from './IOSSafariValidationPage';

export class IOSPaymentPage extends IOSBasePage {
  constructor(driver: WdBrowser) {
    super(driver);
  }

  private async savePaymentScreenshot(step: string): Promise<string> {
    const dir = path.resolve(process.cwd(), 'test-results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const screenshot = path.join(dir, `ios_safari_payment_${step}_${Date.now()}.png`);
    await this.driver.saveScreenshot(screenshot).catch(() => { });
    return screenshot;
  }

  private async waitForVisibleEnabled(element: any, label: string): Promise<void> {
    await this.driver.waitUntil(async () =>
      await element.isDisplayed().catch(() => false) &&
      await element.isEnabled().catch(() => false),
    {
      timeout: 10000,
      interval: 250,
      timeoutMsg: `${label} did not become visible and enabled.`,
    });
  }

  private async clearAndType(element: any, value: string): Promise<void> {
    await element.click();
    await element.clearValue().catch(() => { });
    for (const char of value) {
      await element.addValue(char);
      await this.driver.pause(75);
    }
  }

  private async switchToFrame(frame: any): Promise<boolean> {
    const driver: any = this.driver;
    if (typeof driver.switchToFrame === 'function') {
      await driver.switchToFrame(frame);
      return true;
    }
    if (typeof driver.switchFrame === 'function') {
      await driver.switchFrame(frame);
      return true;
    }
    return false;
  }

  private async switchToMainFrame(): Promise<void> {
    const driver: any = this.driver;
    if (typeof driver.switchToParentFrame === 'function') {
      await driver.switchToParentFrame().catch(() => { });
      return;
    }
    if (typeof driver.switchFrame === 'function') {
      await driver.switchFrame(null).catch(() => { });
    }
  }

  private async fillPaymentField(
    label: string,
    value: string,
    directSelectors: string[],
    frameSelectors: string[],
  ): Promise<boolean> {
    const direct = await this.browserFirstVisible(directSelectors);
    if (direct) {
      await this.waitForVisibleEnabled(direct, label);
      await this.clearAndType(direct, value);
      console.log(`✅ [Payment] Filled ${label}.`);
      return true;
    }

    for (const frameSelector of frameSelectors) {
      const frame = await this.browserFirstVisible([frameSelector]);
      if (!frame) continue;

      let switched = false;
      try {
        switched = await this.switchToFrame(frame);
        if (!switched) continue;
        const input = await this.browserFirstVisible([
          'input:not([type="hidden"])',
          '[role="textbox"]',
        ]);
        if (!input) continue;
        await this.waitForVisibleEnabled(input, label);
        await this.clearAndType(input, value);
        console.log(`✅ [Payment] Filled ${label} inside iframe: ${frameSelector}`);
        return true;
      } finally {
        if (switched) await this.switchToMainFrame();
      }
    }

    return false;
  }

  private async waitForPaymentMethodsToRender(): Promise<void> {
    await this.driver.waitUntil(async () => {
      return Boolean(await this.driver.execute(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
        const hasMethodText = /apple pay|google pay|paypal|credit.*debit.*card|credit.*card|debit.*card|card number/.test(text);
        const hasCardInput = Boolean(document.querySelector(
          'input[autocomplete="cc-number"], input[name*="card" i], iframe[title*="card" i], iframe[name*="card" i]'
        ));
        return hasMethodText || hasCardInput;
      }).catch(() => false));
    }, {
      timeout: 20000,
      interval: 500,
      timeoutMsg: 'iOS Safari payment methods did not finish rendering.',
    }).catch(() => {
      console.log('⚠️ [Payment] Payment methods did not finish rendering before fill attempt.');
    });
  }

  private async waitForCardFormToRender(): Promise<boolean> {
    return await this.driver.waitUntil(async () => {
      return Boolean(await this.driver.execute(() => Boolean(document.querySelector(
        'input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i], iframe[title*="card" i], iframe[name*="card" i]'
      ))).catch(() => false));
    }, {
      timeout: 15000,
      interval: 500,
      timeoutMsg: 'iOS Safari credit-card form did not render after selecting Credit & Debit Card.',
    }).then(() => true).catch(() => false);
  }

  private async selectCreditCardIfPresent(): Promise<void> {
    await this.waitForPaymentMethodsToRender();

    const clickedByText = await this.driver.execute(() => {
      const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        'button, [role="button"], [role="radio"], label, section, div'
      ))
        .filter(el => {
          const text = clean(el.innerText || el.textContent);
          return isVisible(el) && text.length <= 120 && /credit.*(?:debit.*)?card|debit.*card/i.test(text);
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        });
      const target = candidates[0];
      if (!target) return '';
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return clean(target.innerText || target.textContent);
    }).catch(() => '');

    if (clickedByText) {
      console.log(`✅ [Payment] Selected Credit & Debit Card payment method: "${clickedByText}".`);
      if (await this.waitForCardFormToRender()) return;
      console.log('⚠️ [Payment] Card form did not render after text click; trying locator fallback.');
    }

    const creditCard = await this.browserFirstVisible([
      "section[id='Credit & Debit Card']",
      '//*[self::section or self::div or self::label or self::button or @role="button" or @role="radio"][contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "credit") and contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "card")]',
      '//*[self::section or self::div or self::label or self::button or @role="button" or @role="radio"][contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "debit card")]',
    ]);
    if (!creditCard) return;
    await creditCard.scrollIntoView().catch(() => { });
    await creditCard.click().catch(async () => {
      await this.driver.execute((el: HTMLElement) => el.click(), creditCard).catch(() => { });
    });
    console.log('✅ [Payment] Selected Credit & Debit Card payment method.');
    await this.waitForCardFormToRender();
  }

  async fillCreditCardAndSubmit(eventData?: Record<string, any>): Promise<void> {
    console.log('💳 [Payment] Filling iOS Safari credit-card payment form...');
    await this.selectCreditCardIfPresent();
    const beforeScreenshot = await this.savePaymentScreenshot('before_fill');

    const cardNumber = process.env.TEST_CARD_NUMBER || process.env.STAG_CARD_NUMBER || '4242424242424242';
    const expiry = process.env.TEST_CARD_EXPIRY || process.env.STAG_CARD_EXPIRY || '12/30';
    const cvv = process.env.TEST_CARD_CVV || process.env.STAG_CARD_CVV || '123';
    const cardName = process.env.TEST_CARD_NAME || process.env.STAG_CARD_HOLDER || 'UAT Test';

    const fields = [
      {
        label: 'card number',
        value: cardNumber,
        direct: [
          'input[autocomplete="cc-number"]',
          'input[name*="card" i][name*="number" i]',
          'input[id*="card" i][id*="number" i]',
          'input[placeholder*="card number" i]',
        ],
        frames: [
          'iframe[title="Secure card number input frame"]',
          'iframe[title*="card number" i]',
          'iframe[name*="card" i]',
        ],
      },
      {
        label: 'expiry',
        value: expiry,
        direct: [
          'input[autocomplete="cc-exp"]',
          'input[name*="exp" i]',
          'input[id*="exp" i]',
          'input[placeholder*="MM" i]',
        ],
        frames: [
          'iframe[title="Secure card expiration date input frame"]',
          'iframe[title*="expiration" i]',
          'iframe[title*="expiry" i]',
        ],
      },
      {
        label: 'CVV',
        value: cvv,
        direct: [
          'input[autocomplete="cc-csc"]',
          'input[name*="cvv" i]',
          'input[name*="cvc" i]',
          'input[id*="cvv" i]',
          'input[id*="cvc" i]',
          'input[placeholder*="CVV" i]',
        ],
        frames: [
          'iframe[title="Secure card security code input frame"]',
          'iframe[title*="security code" i]',
          'iframe[title*="cvv" i]',
          'iframe[title*="cvc" i]',
        ],
      },
      {
        label: 'cardholder name',
        value: String(eventData?.CARDHOLDER_NAME || cardName),
        direct: [
          'input[autocomplete="cc-name"]',
          'input[name*="holder" i]',
          'input[name*="name" i]',
          'input[id*="holder" i]',
          'input[placeholder*="name" i]',
        ],
        frames: [
          'iframe[title="Secure text input frame"]',
          'iframe[title*="text input" i]',
          'iframe[title*="name" i]',
        ],
      },
    ];

    for (const field of fields) {
      const filled = await this.fillPaymentField(field.label, field.value, field.direct, field.frames);
      if (!filled) {
        const screenshot = await this.savePaymentScreenshot(`missing_${field.label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
        throw new Error(`iOS Safari payment form did not expose ${field.label}. Before-fill screenshot: ${beforeScreenshot}. Failure screenshot: ${screenshot}`);
      }
    }

    await this.savePaymentScreenshot('after_fill');
    await this.clickPaymentSubmit();
    await this.savePaymentScreenshot('after_submit');
  }

  async clickPaymentSubmit(): Promise<void> {
    console.log('🖱️ [Payment] Clicking final payment submit button...');
    const submit = await this.browserFirstVisible([
      'button*=Pay now',
      'button*=Pay Now',
      'button*=Subscribe',
      'button*=Confirm',
      'button*=Start watching',
      'button*=Complete purchase',
      'button*=One time payment',
      '[role="button"]*=Pay now',
      '[role="button"]*=Pay Now',
      '[role="button"]*=Confirm',
      'button[type="submit"]',
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "pay now")]',
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "confirm")]',
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "complete purchase")]',
    ]);
    if (!submit) {
      const screenshot = await this.savePaymentScreenshot('submit_not_found');
      throw new Error(`iOS Safari payment submit button was not found. Screenshot: ${screenshot}`);
    }
    await submit.scrollIntoView().catch(() => { });
    await this.waitForVisibleEnabled(submit, 'payment submit button');
    await submit.click().catch(async () => {
      await this.driver.execute((el: HTMLElement) => el.click(), submit).catch(() => { });
    });
    console.log('✅ [Payment] Submitted payment.');
  }

  async validateSuccessPage(results: IOSValidationResult[], eventData?: Record<string, any>): Promise<void> {
    console.log('⏳ [Payment] Waiting for iOS Safari success page...');
    let successText = '';
    const successFound = await this.driver.waitUntil(async () => {
      const url = await this.driver.getUrl().catch(() => '');
      const text = await this.browserText();
      successText = text;
      if (/success|confirmation|thank-you|\/watch|welcome|home|purchasedSignupPPV|UpsellAfter/i.test(url)) return true;
      return /you.re all set|welcome to dazn|payment successful|payment was successful|purchase complete|thank you|start watching|all set/i.test(text);
    }, {
      timeout: 30000,
      interval: 1000,
      timeoutMsg: 'iOS Safari payment submission did not reach a success page.',
    }).then(() => true).catch(() => false);

    if (!successFound) {
      const screenshot = await this.savePaymentScreenshot('success_not_found');
      const errorText = await this.browserText();
      const errorMatch = errorText.match(/(?:payment was not successful|payment failed|error|declined)[^\n]{0,160}/i)?.[0];
      throw new Error(`iOS Safari payment success page was not detected within 30s.${errorMatch ? ` Error text: ${errorMatch}` : ''} Screenshot: ${screenshot}`);
    }

    const fullText = successText || await this.browserText();
    const hasSuccessMessage = /you.re all set|welcome to dazn|payment successful|payment was successful|purchase complete|thank you|start watching|all set/i.test(fullText) ||
      /success|confirmation|thank-you|\/watch|welcome|home|purchasedSignupPPV|UpsellAfter/i.test(await this.driver.getUrl().catch(() => ''));
    results.push({
      page: 'Success Page (Safari)',
      field: 'Purchase Confirmed',
      expected: 'Yes',
      actual: hasSuccessMessage ? 'Yes' : 'No',
      status: hasSuccessMessage ? 'PASS' : 'FAIL',
    });

    const ppvName = String(eventData?.PPV_NAME || eventData?.PPV_DISPLAY_NAME || '').trim();
    if (ppvName) {
      const words = ppvName.toLowerCase().split(/[\s:\-–—,]+/).filter(word => word.length > 2 && !/^(the|and|for|with|from|ppv|vs)$/.test(word));
      const matchesName = words.length > 0 && words.some(word => fullText.toLowerCase().includes(word));
      results.push({
        page: 'Success Page (Safari)',
        field: 'Purchased PPV Name',
        expected: ppvName,
        actual: matchesName ? ppvName : 'Not found',
        status: matchesName ? 'PASS' : 'FAIL',
      });
    }
    console.log('✅ [Payment] Success page validated.');
  }

  async completePayment(results: IOSValidationResult[], eventData?: Record<string, any>): Promise<void> {
    if (eventData) {
      await new IOSSafariValidationPage(this.driver).validatePaymentPage(eventData, results);
    }
    if ((process.env.DAZN_ENV || 'stag').toLowerCase() === 'prod') {
      console.log('ℹ️ [prod] Payment page validated — skipping payment entry and submission.');
      return;
    }
    await this.fillCreditCardAndSubmit(eventData);
    await this.validateSuccessPage(results, eventData);
    results.push({ page: 'iOS Safari', field: 'Payment Completed', expected: 'Yes', actual: 'Yes', status: 'PASS' });
  }

  async completePPVPayment(results: IOSValidationResult[], eventData?: Record<string, any>): Promise<void> {
    if (eventData) {
      await new IOSSafariValidationPage(this.driver).validatePPVPaymentPage(eventData, results);
    }
    if ((process.env.DAZN_ENV || 'stag').toLowerCase() === 'prod') {
      console.log('ℹ️ [prod] PPV payment page validated — skipping payment submission.');
      return;
    }
    await this.clickPaymentSubmit();
    await this.savePaymentScreenshot('ppv_after_submit');
    await this.validateSuccessPage(results, eventData);
    results.push({ page: 'iOS Safari', field: 'Payment Completed', expected: 'Yes', actual: 'Yes', status: 'PASS' });
  }
}

export async function completePayment(
  driver: WdBrowser,
  results: IOSValidationResult[],
  eventData?: Record<string, any>,
): Promise<void> {
  return new IOSPaymentPage(driver).completePayment(results, eventData);
}

export async function completePPVPayment(
  driver: WdBrowser,
  results: IOSValidationResult[],
  eventData?: Record<string, any>,
): Promise<void> {
  return new IOSPaymentPage(driver).completePPVPayment(results, eventData);
}
