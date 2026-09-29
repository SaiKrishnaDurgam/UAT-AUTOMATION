import { IOSBasePage, WdBrowser } from './IOSBasePage';
import { IOSValidationResult } from './IOSValidationPage';
import { IOSSafariValidationPage } from './IOSSafariValidationPage';

/**
 * Handles the DAZN contextual PPV page in Safari.
 *
 * This page appears when the user needs to choose between a standalone PPV
 * purchase and DAZN Ultimate. It presents radio-style cards for each option.
 */
export class IOSPPVPage extends IOSBasePage {
  constructor(driver: WdBrowser) {
    super(driver);
  }

  private async firstVisible(selectors: string[]): Promise<any | null> {
    for (const selector of selectors) {
      try {
        const elements = await this.driver.$$(selector);
        for (const element of elements) {
          if (await element.isDisplayed().catch(() => false)) return element;
        }
      } catch { }
    }
    return null;
  }

  private async validateSelectedCta(
    cta: any,
    eventData: Record<string, any> | undefined,
    results: IOSValidationResult[],
    page: string,
  ): Promise<void> {
    const expected = String(eventData?.PLAN_CTA_BUTTON_ULTIMATE || eventData?.PPV_CTA_TEXT || 'Continue with DAZN Ultimate');
    const actual = (await cta.getText().catch(() => '')).replace(/\s+/g, ' ').trim() || 'Not found';
    const { compare } = require('../../../utils/compare');
    const status = compare(actual, expected) ? 'PASS' : 'FAIL';
    console.log(`  ${status === 'PASS' ? '✅' : '❌'} [CTA Button] expected="${expected}" actual="${actual}"`);
    let screenshot: string | undefined;
    if (status === 'FAIL') {
      const fs = require('fs');
      const path = require('path');
      const shotsDir = path.resolve(process.cwd(), 'test-results', 'failure-shots');
      if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir, { recursive: true });
      screenshot = path.join(shotsDir, `ios_safari_${page.replace(/[^a-zA-Z0-9]/g, '_')}_CTA_Button_${Date.now()}.png`);
      await this.driver.saveScreenshot(screenshot).catch(() => { screenshot = undefined; });
    }
    results.push({ page, field: 'CTA Button', expected, actual, status, screenshot });
  }

  /**
   * Returns true for the PPV tier-choice surface, which can transiently use
   * the PlanDetails route before DAZN appends `upsellTierSelected`.
   */
  async isContextualPPVPage(bodyTextLower: string, url = ''): Promise<boolean> {
    const hasPpvChoiceCopy = /pay-per-view, you.ll need a dazn plan|ultimate fan package|continue with pay-per-view|just the fight|to watch your pay-per-view/.test(bodyTextLower);
    const lowerUrl = url.toLowerCase();
    if (!lowerUrl.includes('contextualppvid=')) return hasPpvChoiceCopy;

    // These flags identify the actual plan page after the PPV tier was
    // selected (or deliberately skipped), so it must not be re-handled here.
    if (lowerUrl.includes('upselltierselected=true') || lowerUrl.includes('upselltierskipped=true')) return false;
    if (hasPpvChoiceCopy || lowerUrl.includes('upselltiershown=true')) return true;

    // The recorded Safari flow shows the PPV selection page for only a couple
    // of seconds on the PlanDetails route. Its document text can still be the
    // previous sign-in snapshot, while the PPV CTA is already interactable.
    return Boolean(await this.firstVisible([
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with pay-per-view")]',
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with dazn ultimate")]',
      '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with ultimate")]',
    ]));
  }

  /**
   * Resolve the requested plan/tier from environment variables.
   * Shared logic — also used by IOSPlanPage.
   */
  getRequestedPlan(): { plan: string; tier: string; ratePlan: string; label: string; terms: string[] } {
    const plan = (process.env.PLAN || 'standard_monthly').toLowerCase().replace(/[\s-]+/g, '_');
    let tier = (process.env.TIER || process.env.PLAN_TIER ||
      (plan.includes('ultimate') ? 'ultimate' : 'standard')).toLowerCase();
    const ratePlan = (process.env.RATE_PLAN ||
      (plan.includes('upfront') ? 'annual pay upfront' : plan.includes('apm') || plan.includes('annual') ? 'annual pay monthly' : 'monthly')).toLowerCase();
    const forceUltimateSwitch = String(process.env.SWITCH_TO_ULTIMATE || process.env.SWITCH || '').toLowerCase() === 'true';
    if (forceUltimateSwitch && tier === 'standard') {
      console.log('🔄 [SWITCH_TO_ULTIMATE] Forcing Ultimate tier selection mid-flow.');
      tier = 'ultimate';
    }

    if (tier === 'ultimate') {
      if (ratePlan.includes('upfront')) return { plan, tier, ratePlan, label: 'DAZN Ultimate – Annual Pay Upfront', terms: ['annual', 'upfront'] };
      if (ratePlan.includes('annual')) return { plan, tier, ratePlan, label: 'DAZN Ultimate – Annual Pay Monthly', terms: ['annual', 'pay monthly'] };
      return { plan, tier, ratePlan, label: 'DAZN Ultimate', terms: ['ultimate'] };
    }
    if (ratePlan.includes('upfront')) return { plan, tier, ratePlan, label: 'Annual – Pay Upfront', terms: ['annual', 'upfront'] };
    if (ratePlan.includes('annual')) return { plan, tier, ratePlan, label: 'Annual – Pay Monthly', terms: ['annual', 'pay monthly'] };
    return { plan, tier, ratePlan, label: 'Flex – Pay Monthly', terms: ['flex', 'pay monthly'] };
  }


  /**
   * Validate the contextual PPV page fields, then select the PPV or Ultimate
   * option based on the requested plan.
   */
  async validateAndSelectOption(
    results: IOSValidationResult[],
    eventName: string,
    eventData?: Record<string, any>,
  ): Promise<void> {
    // ── Validate PPV page before interacting ──
    if (eventData) {
      try {
        await new IOSSafariValidationPage(this.driver).validatePPVPage(eventData, results);
      } catch (err: any) {
        console.warn(`⚠️ PPV page validation error: ${err.message}`);
      }
    }

    const wantsUltimate = this.getRequestedPlan().tier === 'ultimate';
    const targetTexts = wantsUltimate
      ? ['dazn ultimate', 'ultimate fan package']
      : ['just the fight', 'pay-per-view', 'ppv only', 'ppv'];
    const currentUrl = await this.driver.getUrl().catch(() => '');
    console.log(`📍 [PPV Selection] Current URL: ${currentUrl}`);
    console.log(`🔍 [PPV Option] Searching for: "${targetTexts.join('" or "')}" (wantsUltimate=${wantsUltimate})`);
    let ppvOrUltimate = await this.firstVisible([
      ...targetTexts.map(targetText =>
        `//*[self::label or @role="radio" or @role="option"][contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "${targetText}")]`
      ),
    ]);
    if (ppvOrUltimate) {
      console.log(`✅ [PPV Option] Found via XPath option selector`);
    }
    // Safari sometimes exposes only the radio inside a generic card. Match it
    // against its own visible card rather than a shared ancestor containing
    // both PPV and Ultimate choices.
    if (!ppvOrUltimate) {
      console.log(`🔍 [PPV Option] XPath failed, searching radio buttons and their context...`);
      const radios = await this.driver.$$('input[type="radio"]').catch(() => []);
      console.log(`   Found ${radios.length} radio inputs on page`);
      for (const radio of radios) {
        const radioContext = await this.driver.execute((input: HTMLInputElement, texts: string[], isUltimate: boolean) => {
          for (let node: HTMLElement | null = input.parentElement; node && node !== document.body; node = node.parentElement) {
            if (node.querySelectorAll('input[type="radio"], [role="radio"]').length > 1) continue;
            const style = window.getComputedStyle(node);
            const box = node.getBoundingClientRect();
            const text = (node.textContent || '').toLowerCase();
            const matchedText = texts.find(candidate => text.includes(candidate));
            if (style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0 &&
              matchedText && (isUltimate || !/dazn\s+ultimate|ultimate fan package/.test(text))) {
              return { found: true, text: text.substring(0, 100), matchedText };
            }
          }
          return { found: false, text: '', matchedText: '' };
        }, radio, targetTexts, wantsUltimate).catch(() => false);
        if (radioContext && typeof radioContext === 'object' && radioContext.found) {
          console.log(`   ✅ Match found for "${radioContext.matchedText}": "${radioContext.text.substring(0, 60)}..."`);
          ppvOrUltimate = radio;
          break;
        }
      }
    }
    if (!ppvOrUltimate) {
      const pageText = await this.driver.execute(() => document.body?.innerText || '').catch(() => '');
      const radioCount = await this.driver.$$('input[type="radio"]').then(r => r.length).catch(() => 0);
      console.error(`❌ [PPV Option] Search failed. Page has ${radioCount} radios. Looking for "${targetTexts.join('" or "')}"`);
      console.error(`   Page text (first 400 chars): ${pageText.substring(0, 400)}`);
      await this.driver.saveScreenshot('./test-results/ios_ppv_option_not_found.png').catch(() => {});
      throw new Error(`Requested contextual ${wantsUltimate ? 'Ultimate' : 'PPV'} option was not exposed.`);
    }
    console.log(`✅ [PPV Option] Selected target radio input`);
    const selected = await this.driver.execute((el: HTMLElement) => {
      if (el.matches('input[type="radio"]')) {
        (el as HTMLInputElement).click();
        return 'radio-input';
      }
      el.click();
      return 'option';
    }, ppvOrUltimate).catch(() => null);
    if (!selected) await ppvOrUltimate.click();
    console.log(`✅ Selected contextual PPV option: ${wantsUltimate ? 'Ultimate' : 'PPV'}`);

    // The parent signup flow has generic Continue locators, with the PPV CTA
    // first. Submit the CTA here while the requested option is explicit;
    // otherwise an Ultimate selection can be followed by "Continue with
    // pay-per-view" and the handoff reports upsellTierSkipped=true.
    const optionCtaSelectors = wantsUltimate
      ? [
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with dazn ultimate")]',
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with ultimate")]',
      ]
      : [
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with pay-per-view")]',
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with ppv")]',
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "buy now")]',
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue")]',
      ];
    let optionCta = await this.firstVisible(optionCtaSelectors);
    if (!optionCta) {
      await this.driver.waitUntil(async () => {
        optionCta = await this.firstVisible(optionCtaSelectors);
        return Boolean(optionCta);
      }, {
        timeout: 8000,
        interval: 250,
        timeoutMsg: `Requested contextual ${wantsUltimate ? 'Ultimate' : 'PPV'} option did not expose its Continue CTA after selection.`,
      }).catch(() => { });
    }
    if (!optionCta) {
      throw new Error(`Requested contextual ${wantsUltimate ? 'Ultimate' : 'PPV'} option did not expose its Continue CTA.`);
    }
    if (wantsUltimate) await this.validateSelectedCta(optionCta, eventData, results, 'PPV Page (Safari)');
    await optionCta.scrollIntoView().catch(() => { });
    await optionCta.click();
    console.log(`✅ Continued with contextual ${wantsUltimate ? 'DAZN Ultimate' : 'pay-per-view'} option.`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHOOSE HOW TO BUY PAGE  (active_standard_* users)
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns true when the visible page text is the "Choose how to buy" surface. */
  isChooseHowToBuyPage(bodyTextLower: string): boolean {
    return /choose how to buy/.test(bodyTextLower);
  }

  /**
   * Validate the "Choose how to buy" page fields (Excel sheet rows),
   * then select the appropriate option (PPV or Ultimate) based on the
   * requested plan, and click the matching CTA.
   *
   * PPV path:  validates → clicks "Buy now" / "Continue" → advances to PPV Payment
   * Ultimate path: validates → selects Ultimate → clicks "Continue with DAZN Ultimate"
   *              → lands on Plan page (handled by IOSPlanPage)
   */
  async validateAndClickBuyNow(
    results: IOSValidationResult[],
    eventData?: Record<string, any>,
  ): Promise<void> {
    if (eventData) {
      try {
        await new IOSSafariValidationPage(this.driver).validateChooseHowToBuyPage(eventData, results);
      } catch (err: any) {
        console.warn(`⚠️ Choose how to buy validation error: ${err.message}`);
      }
    }

    // Determine if the user wants Ultimate upgrade or PPV-only
    const requested = this.getRequestedPlan();
    const wantsUltimate = requested.tier === 'ultimate';
    if (eventData && wantsUltimate) {
      eventData.TIER = 'ultimate';
      eventData.DAZN_TIER = 'DAZN Ultimate';
      eventData.RATE_PLAN = requested.ratePlan;
    }

    if (wantsUltimate) {
      // ── Ultimate path ─────────────────────────────────────────────
      console.log('💎 [Choose How To Buy] Selecting DAZN Ultimate...');
      const selectedUltimate = await this.driver.execute(() => {
        const visible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
          let card: HTMLElement | null = radio;
          for (let depth = 0; card && card !== document.body && depth < 8; depth++, card = card.parentElement) {
            if (card.querySelectorAll('input[type="radio"]').length > 1) continue;
            if (visible(card) && /dazn\s+ultimate/i.test(card.innerText || card.textContent || '')) {
              card.scrollIntoView({ block: 'center' });
              radio.click();
              radio.dispatchEvent(new Event('input', { bubbles: true }));
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              card.click();
              return true;
            }
          }
        }
        for (const option of Array.from(document.querySelectorAll<HTMLElement>('label, [role="radio"], [role="option"]'))) {
          if (option.querySelectorAll('input[type="radio"]').length > 1) continue;
          if (visible(option) && /dazn\s+ultimate/i.test(option.innerText || option.textContent || '')) {
            option.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (!selectedUltimate) {
        throw new Error('DAZN Ultimate option was not found on the "Choose how to buy" page.');
      }

      await this.driver.execute(() => window.scrollBy(0, Math.round(window.innerHeight * 0.65))).catch(() => { });
      console.log('↕️ [Choose How To Buy] Scrolled once to reveal the DAZN Ultimate CTA.');

      // Click "Continue with DAZN Ultimate" CTA
      let ultimateCta = await this.firstVisible([
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with dazn ultimate")]',
        '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with ultimate")]',
      ]);
      if (!ultimateCta) {
        await this.driver.waitUntil(async () => {
          ultimateCta = await this.firstVisible([
            '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with dazn ultimate")]',
            '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue with ultimate")]',
          ]);
          return Boolean(ultimateCta);
        }, {
          timeout: 8000,
          interval: 250,
          timeoutMsg: 'DAZN Ultimate selection did not expose its Continue CTA.',
        }).catch(() => { });
      }
      if (!ultimateCta) {
        throw new Error('"Continue with DAZN Ultimate" CTA not found on "Choose how to buy" page.');
      }
      await this.validateSelectedCta(ultimateCta, eventData, results, 'Choose How To Buy (Safari)');
      await ultimateCta.click();
      await this.driver.waitUntil(async () => {
        const text = await this.browserText();
        return !/choose how to buy/i.test(text) && /choose (?:your|the right) plan|annual|pay monthly|pay upfront/i.test(text);
      }, {
        timeout: 15000,
        interval: 250,
        timeoutMsg: 'DAZN Ultimate selection did not transition to the plan page.',
      });
      console.log('✅ Clicked "Continue with DAZN Ultimate" on "Choose how to buy" page.');
    } else {
      // ── PPV only path ─────────────────────────────────────────────
      console.log('🥊 [Choose How To Buy] Selecting PPV only...');

      const ppvName = String(eventData?.PPV_NAME || '').toLowerCase();
      const selectedPpv = await this.driver.execute((name: string) => {
        const visible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const nameTerms = name.split(/\s+/).filter(term => term.length > 2);
        for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
          let card: HTMLElement | null = radio;
          for (let depth = 0; card && card !== document.body && depth < 8; depth++, card = card.parentElement) {
            const text = (card.innerText || card.textContent || '').toLowerCase();
            if (visible(card) && !text.includes('dazn ultimate') && nameTerms.some(term => text.includes(term))) {
              radio.click();
              return true;
            }
          }
        }
        return false;
      }, ppvName).catch(() => false);
      if (!selectedPpv) throw new Error('PPV option was not found on the "Choose how to buy" page.');

      // Click the PPV "Buy now" / "Continue" CTA to advance to PPV Payment
      const buyNow = await this.firstVisible([
        'button*=Continue with',
        '[role="button"]*=Continue with',
      ]);
      if (!buyNow) throw new Error('"Buy now" CTA not found on "Choose how to buy" page.');
      await buyNow.click();
      await this.driver.waitUntil(async () => {
        const paymentText = await this.browserText();
        return !/choose how to buy/i.test(paymentText) &&
          /today you pay|one time payment|pay now|payment method|payment details/i.test(paymentText);
      }, {
        timeout: 15000,
        interval: 250,
        timeoutMsg: 'PPV selection did not transition to the saved-card payment page.',
      });
      console.log('✅ Clicked "Buy now" on "Choose how to buy" page.');
    }
  }
}
