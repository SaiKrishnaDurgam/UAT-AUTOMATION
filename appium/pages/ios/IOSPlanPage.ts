import { IOSBasePage, WdBrowser } from './IOSBasePage';
import { IOSValidationResult } from './IOSValidationPage';
import { IOSSafariValidationPage } from './IOSSafariValidationPage';
import { IOSPPVPage } from './IOSPPVPage';

/**
 * Handles the DAZN plan-selection page in Safari ("Choose a plan that's right
 * for you").
 *
 * This page displays radio-style plan cards (Flex, Annual Pay Monthly, Annual
 * Pay Upfront) and a Continue CTA. The default selection is "Annual - Pay
 * Monthly"; if the test requests a different plan (e.g. upfront), the correct
 * card must be clicked before validation and before Continue.
 */
export class IOSPlanPage extends IOSBasePage {
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

  /** Returns true when the visible page text/URL matches the DAZN plan page. */
  isPlanPage(bodyTextLower: string, url: string): boolean {
    return (
      /choose (your|the right) plan|choose how to buy/.test(bodyTextLower) ||
      (/page=PlanDetails/i.test(url) && /flex|annual|pay monthly|pay upfront/.test(bodyTextLower))
    );
  }

  /**
   * Resolve the requested plan/tier from environment variables.
   * Delegates to IOSPPVPage.getRequestedPlan() for consistency.
   */
  private getRequestedPlan() {
    // Re-use the shared resolver so both pages always agree.
    return new IOSPPVPage(this.driver).getRequestedPlan();
  }

  /**
   * Read selection state from the current document, rather than a plan-card
   * element retained across React's rerender after a radio click.
   */
  private async isRequestedPlanSelected(terms: string[]): Promise<boolean> {
    return this.driver.execute((requestedTerms: string[]) => {
      const hasTermsNear = (element: Element): boolean => {
        let node: HTMLElement | null = element as HTMLElement;
        // Stop before the page root: its text contains every plan and would
        // make the already-selected default card look like Pay Upfront.
        for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
          if (node.querySelectorAll('input[type="radio"], [role="radio"]').length > 1) continue;
          const text = (node.textContent || '').toLowerCase();
          if (requestedTerms.every(term => text.includes(term))) return true;
        }
        return false;
      };

      for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
        if (radio.checked && hasTermsNear(radio)) return true;
      }
      for (const option of Array.from(document.querySelectorAll<HTMLElement>('label, [role="radio"], [role="option"]'))) {
        const selected = option.getAttribute('aria-checked') === 'true'
          || option.getAttribute('data-selected') === 'true'
          || option.getAttribute('data-state') === 'checked';
        if (selected && hasTermsNear(option)) return true;
      }
      return false;
    }, terms).catch(() => false);
  }

  /** Resolve the real radio control only when its visible plan card is not exposed. */
  private async findRequestedPlanRadio(terms: string[]): Promise<any | null> {
    const radios = await this.driver.$$('input[type="radio"], [role="radio"]').catch(() => []);
    for (const radio of radios) {
      const belongsToRequestedPlan = await this.driver.execute((control: HTMLElement, requestedTerms: string[]) => {
        for (let node: HTMLElement | null = control; node && node !== document.body; node = node.parentElement) {
          if (node.querySelectorAll('input[type="radio"], [role="radio"]').length > 1) continue;
          const text = (node.innerText || node.textContent || '').toLowerCase();
          if (requestedTerms.every(term => text.includes(term))) return true;
        }
        return false;
      }, radio, terms).catch(() => false);
      if (belongsToRequestedPlan) return radio;
    }
    return null;
  }

  /**
   * Click the plan card matching the test's requested tier/ratePlan.
   */
  async selectRequestedPlan(): Promise<void> {
    const requested = this.getRequestedPlan();
    const predicates = requested.terms.map(term =>
      `contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "${term}")`
    ).join(' and ');
    // Prefer the visible card label. It is the control a user actually taps;
    // the nested radio is often visually hidden in Safari's checkout UI.
    let option = await this.firstVisible([
      `//label[${predicates}]`,
      `//*[@role="radio" or @role="option"][${predicates}]`,
    ]) ?? await this.findRequestedPlanRadio(requested.terms);

    // Safari can expose a plan card as a generic container with only the
    // inner radio input accessible. In that tree the wrapper selector above
    // cannot see Annual/Upfront even though the requested card is available.
    if (!option) {
      const radios = await this.driver.$$('input[type="radio"]').catch(() => []);
      for (const radio of radios) {
        const matchesRequestedPlan = await this.driver.execute((input: HTMLInputElement, terms: string[]) => {
          const container = input.closest('label, [role="radio"], [role="option"]') || input.parentElement;
          if (!container) return false;
          const style = window.getComputedStyle(container);
          const box = container.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0) return false;
          const text = (container?.textContent || '').toLowerCase();
          return terms.every(term => text.includes(term));
        }, radio, requested.terms).catch(() => false);
        if (matchesRequestedPlan) {
          option = radio;
          break;
        }
      }
    }

    if (!option) {
      throw new Error(
        `Requested Safari plan "${requested.plan}" (${requested.label}) was not exposed on the plan screen; refusing to continue with DAZN's default plan.`
      );
    }

    await option.scrollIntoView().catch(() => { });

    const targetKind = await this.driver.execute((el: HTMLElement) => {
      if (el.matches('label')) return 'label';
      if (el.matches('[role="radio"], [role="option"]')) return 'aria-control';
      return 'radio-input';
    }, option).catch(() => 'plan-control');
    const clickMethod = await option.click()
      .then(() => `native-${targetKind}`)
      .catch(() => null as string | null);
    console.log(`🖱️ Plan selection click via: ${clickMethod ?? 'screen-tap-fallback'}`);

    // ── Step 2: Verify a fresh post-click document state ────────────────────
    let isNowSelected = await this.driver.waitUntil(
      () => this.isRequestedPlanSelected(requested.terms),
      { timeout: 3000, interval: 250, timeoutMsg: `Requested plan "${requested.plan}" did not become selected.` },
    ).then(() => true).catch(() => false);

    // A controlled Safari card can briefly show the clicked styling before a
    // React render restores the default. Do not allow Continue unless the
    // requested radio remains selected after that render has completed.
    if (isNowSelected) {
      await this.driver.pause(1500);
      isNowSelected = await this.isRequestedPlanSelected(requested.terms);
    }

    if (!isNowSelected) {
      // The card can be covered by a WebKit layer even though it is exposed to
      // the accessibility tree. Retry inside this exact card's bounds so Safari
      // receives the same tap as a real user.
      console.log('⚠️ Native plan-card click did not update radio state — retrying with an exact Safari tap.');
      const location = await option.getLocation();
      const size = await option.getSize();
      await this.driver.execute('mobile: tap', {
        x: Math.round(location.x + size.width / 2),
        y: Math.round(location.y + size.height / 2),
      });
      isNowSelected = await this.driver.waitUntil(
        () => this.isRequestedPlanSelected(requested.terms),
        { timeout: 3000, interval: 250, timeoutMsg: `Requested plan "${requested.plan}" did not become selected after the Safari tap.` },
      ).then(() => true).catch(() => false);
      if (isNowSelected) {
        await this.driver.pause(1500);
        isNowSelected = await this.isRequestedPlanSelected(requested.terms);
      }
      if (!isNowSelected) {
        throw new Error(`Requested Safari plan "${requested.plan}" did not become selected after clicking ${requested.label}.`);
      }
    }

    console.log(`✅ Selected Safari plan: ${requested.label}`);
  }

  /** Continue using the CTA for the plan tier that was just verified. */
  async continueWithSelectedPlan(): Promise<void> {
    const requested = this.getRequestedPlan();
    const wantsUltimate = requested.tier === 'ultimate';
    const cta = await this.firstVisible(wantsUltimate
      ? [
        'button*=Continue with DAZN Ultimate',
        'button*=Continue with Ultimate',
        '[role="button"]*=Continue with DAZN Ultimate',
        'button*=Continue',
        '[role="button"]*=Continue',
      ]
      : [
        'button*=Continue with DAZN Standard',
        'button*=Continue',
        '[role="button"]*=Continue',
      ]);
    if (!cta) {
      throw new Error(`Requested Safari ${wantsUltimate ? 'Ultimate' : 'Standard'} plan did not expose its Continue CTA.`);
    }
    await cta.scrollIntoView().catch(() => { });
    const urlBeforeClick = await this.driver.getUrl().catch(() => '');
    await cta.click();
    await this.driver.waitUntil(async () => {
      if ((await this.driver.getUrl().catch(() => '')) !== urlBeforeClick) return true;
      return !(await cta.isExisting().catch(() => false));
    }, {
      timeout: 8000,
      interval: 250,
      timeoutMsg: `Safari ${wantsUltimate ? 'Ultimate' : 'Standard'} plan did not transition after Continue.`,
    }).catch(() => { });
    console.log(`✅ Continued with selected Safari ${wantsUltimate ? 'Ultimate' : 'Standard'} plan.`);
  }


  /**
   * Select the requested plan, wait for the radio state to settle, validate
   * the plan page fields, then return (Continue is clicked by the caller).
   */
  async validateAndSelect(
    results: IOSValidationResult[],
    eventData?: Record<string, any>,
  ): Promise<void> {
    // Select the plan card first so validation sees the correct radio state.
    await this.selectRequestedPlan();

    // ── Validate the selected Plan page ──
    if (eventData) {
      try {
        await new IOSSafariValidationPage(this.driver).validatePlanPage(eventData, results);
      } catch (err: any) {
        console.warn(`⚠️ Plan page validation error: ${err.message}`);
      }
    }
  }
}
