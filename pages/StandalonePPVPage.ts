import { BasePage } from './BasePage';
import { Page } from '@playwright/test';
import { validateVariant } from '../flows/validateVariant';

export class StandalonePPVPage extends BasePage {

  /**
   * Wait until the standalone PPV page has rendered its primary content.
   * This prevents validation from reading the transition/loading DOM.
   */
  async waitUntilPPVPageReady(): Promise<void> {
    const subscriptionSection = this.page.getByText(/choose your subscription/i).first();
    const planOption = this.page.locator('input[type="radio"], [role="radio"]').first();

    await Promise.all([
      subscriptionSection.waitFor({ state: 'visible', timeout: 20000 }),
      planOption.waitFor({ state: 'visible', timeout: 20000 }),
    ]);

    console.log('✅ [PPV Ready] Standalone PPV subscription options are visible');
  }

  constructor(page: Page) {
    super(page);
  }

  async isPPVCheckboxChecked(ppvName?: string): Promise<boolean> {
    const mainName = ppvName ? ppvName.split(/[:\-–]/)[0].trim() : '';
    const btn = mainName
      ? this.page.locator(`button:has-text("${mainName}"), button[class*="ni7RX"]`).first()
      : this.page.locator(`button[class*="ni7RX"]`).first();
    if (await btn.isVisible().catch(() => false)) {
      const ariaPressed = await btn.getAttribute('aria-pressed').catch(() => null);
      const ariaChecked = await btn.getAttribute('aria-checked').catch(() => null);
      const classAttr = (await btn.getAttribute('class').catch(() => null)) || '';
      if (ariaPressed === 'true' || ariaChecked === 'true' || classAttr.toLowerCase().includes('checked') || classAttr.toLowerCase().includes('active')) {
        return true;
      }
      // Check if there is an active/checked svg or checkmark icon inside the button
      const hasCheckedCheckmark = await btn.locator('svg[class*="checked" i], [class*="checkmark" i]').count().catch(() => 0);
      if (hasCheckedCheckmark > 0) return true;
    }
    const cb = this.page.locator('input[type="checkbox"]').first();
    return await cb.isChecked().catch(() => false);
  }

  // Android standalone tests still cover the unchecked state. Web and iOS do
  // not call this method because they validate only the default checked state.
  async togglePPVCheckbox(ppvName?: string): Promise<void> {
    const mainName = ppvName ? ppvName.split(/[:\-–]/)[0].trim() : '';
    const btn = mainName
      ? this.page.locator(`button:has-text("${mainName}"), button[class*="ni7RX"]`).first()
      : this.page.locator(`button[class*="ni7RX"]`).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true });
    } else {
      const cb = this.page.locator('input[type="checkbox"]').first();
      await cb.click({ force: true }).catch(() => { });
    }
    await this.page.waitForTimeout(1000);
  }

  async validatePPVPageForSelectedPlan(
    data: any[],
    results: any[],
    eventData: Record<string, string>,
    planType: 'flex' | 'annual_monthly',
  ): Promise<void> {
    console.log(`🔍 Validating Standalone PPV page for selected ${planType} plan...`);

    const checkedRows = data.filter(r => (r.State || '').trim().toLowerCase() === 'checked');
    const hasAnnualFreeMonthOffer = /(?:1|first)\s+month\s+free/i.test(
      String(eventData.ANNUAL_BADGE || '')
    );
    const checkboxRows = checkedRows.filter(
      r => (r.Field || '').trim().toLowerCase() === 'ppv checkbox state'
    );
    const selectedPlanRows = checkedRows.filter(r => {
      const field = (r.Field || '').trim().toLowerCase();
      if (field === 'ppv checkbox state') return false;
      const isFlexField = field.startsWith('flex ') || field === 'cta button (flex selected)';
      const isAnnualField = field.startsWith('annual ') || field === 'cta button (apm selected)';
      const isAnnualFeature = /^annual feature [1-3]$/.test(field);
      if (isAnnualFeature && !hasAnnualFreeMonthOffer) return false;
      return planType === 'flex'
        ? !isAnnualField
        : !isFlexField;
    });

    // The ticket must be selected by default. Do not change the product state
    // merely to make the validation pass.
    await validateVariant(this.page, 'standalone-ppv', checkboxRows, results, eventData, 'PPV');

    if (planType === 'flex') {
      await this.selectPlan('flex');
      await validateVariant(this.page, 'standalone-ppv', selectedPlanRows, results, eventData, 'PPV');
    } else {
      await this.selectPlan('annual_monthly');
      await validateVariant(this.page, 'standalone-ppv', selectedPlanRows, results, eventData, 'PPV');
    }
  }

  // Retained only for existing Android callers. Do not use in web or iOS flows.
  async validatePPVPageChecked(data: any[], results: any[], eventData: Record<string, string>): Promise<void> {
    const checked = await this.isPPVCheckboxChecked(eventData.PPV_NAME);
    if (!checked) await this.togglePPVCheckbox(eventData.PPV_NAME);

    const checkedRows = data.filter(r => (r.State || '').trim().toLowerCase() === 'checked');
    const apmCtaRows = checkedRows.filter(
      r => (r.Field || '').trim().toLowerCase() === 'cta button (apm selected)'
    );
    const flexAndCommonRows = checkedRows.filter(
      r => (r.Field || '').trim().toLowerCase() !== 'cta button (apm selected)'
    );
    await this.selectPlan('flex');
    await validateVariant(this.page, 'standalone-ppv', flexAndCommonRows, results, eventData, 'PPV');
    if (apmCtaRows.length > 0) {
      await this.selectPlan('annual_monthly');
      await validateVariant(this.page, 'standalone-ppv', apmCtaRows, results, eventData, 'PPV');
    }
  }

  // Retained only for existing Android callers. Do not use in web or iOS flows.
  async validatePPVPageUnchecked(data: any[], results: any[], eventData: Record<string, string>): Promise<void> {
    const checked = await this.isPPVCheckboxChecked(eventData.PPV_NAME);
    if (checked) await this.togglePPVCheckbox(eventData.PPV_NAME);
    const uncheckedRows = data.filter(r => (r.State || '').trim().toLowerCase() === 'unchecked');
    await validateVariant(this.page, 'standalone-ppv', uncheckedRows, results, eventData, 'PPV');
    await this.togglePPVCheckbox(eventData.PPV_NAME);
  }

  async selectPlan(planType: 'flex' | 'annual_monthly'): Promise<void> {
    console.log(`💎 Selecting plan: ${planType}...`);
    const targetLabel = planType === 'flex' ? 'Flex' : 'Annual - Pay Monthly';

    // Strategy 1: Find clickable plan card/label by text content
    const cardSelectors = [
      `label:has-text("${targetLabel}")`,
      `div[class*="Plan"]:has-text("${targetLabel}")`,
      `div[class*="plan"]:has-text("${targetLabel}")`,
      `button:has-text("${targetLabel}")`,
      `[role="radio"]:has-text("${targetLabel}")`,
    ];

    let clicked = false;
    for (const selector of cardSelectors) {
      const el = this.page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  🎯 Found plan card via: ${selector}`);
        await el.scrollIntoViewIfNeeded().catch(() => { });
        await el.click({ force: true }).catch(() => { });
        clicked = true;
        break;
      }
    }

    // Strategy 2: Fallback to radio inputs by index if text-based selection failed
    if (!clicked) {
      console.log(`  ⚠️ Text-based selection failed, falling back to radio index`);
      const index = planType === 'flex' ? 0 : 1;
      const radios = this.page.locator('input[type="radio"], [role="radio"]');
      const count = await radios.count().catch(() => 0);
      console.log(`  📊 Found ${count} radio inputs, clicking index ${index}`);
      if (count > index) {
        const radio = radios.nth(index);
        await radio.scrollIntoViewIfNeeded().catch(() => { });
        await radio.click({ force: true }).catch(() => { });
        clicked = true;
      }
    }

    // Strategy 3: Last resort — click any container with target text
    if (!clicked) {
      console.log(`  ⚠️ Radio fallback failed, trying broad text match`);
      const broadEl = this.page.locator(`text=/${targetLabel}/i`).first();
      if (await broadEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        await broadEl.click({ force: true }).catch(() => { });
        clicked = true;
      }
    }

    await this.page.waitForTimeout(500);

    // Verification: log which plan appears selected
    const bodySnippet = await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const hasFlexSelected = /flex.*selected|selected.*flex/i.test(bodySnippet) ||
      await this.page.locator('[aria-checked="true"]:has-text("Flex"), [aria-pressed="true"]:has-text("Flex")').count().catch(() => 0) > 0;
    const hasAnnualSelected = /annual.*selected|selected.*annual/i.test(bodySnippet) ||
      await this.page.locator('[aria-checked="true"]:has-text("Annual"), [aria-pressed="true"]:has-text("Annual")').count().catch(() => 0) > 0;
    console.log(`  📋 Post-click state: flexSelected=${hasFlexSelected}, annualSelected=${hasAnnualSelected}`);
    console.log(`✅ Selected ${planType} plan (clicked=${clicked})`);
  }

  async clickContinue(): Promise<void> {
    console.log('🖱️ Clicking Continue CTA on Standalone PPV page...');
    const btn = this.page.locator('button:has-text("Continue")').first();
    await btn.scrollIntoViewIfNeeded().catch(() => { });
    await btn.click({ force: true }).catch(() => { });
    console.log('✅ Continue CTA clicked');
  }
}
