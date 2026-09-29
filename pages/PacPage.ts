import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';
import { assertDaznPageAvailable } from '../utils/helpers';

export class PacPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ─────────────────────────────
  // VALIDATE PARTNER LANDING PAGE
  // ─────────────────────────────
  async validateLandingPage(expectedTextArray: string[]): Promise<boolean> {
    console.log('🔍 Validating partner landing page content...');
    
    // Log visible headers/paragraphs to console for debugging
    await this.logSnapshotContents('Partner Landing');

    const bodyText = await this.getBodyText();
    for (const text of expectedTextArray) {
      const match = bodyText.toLowerCase().includes(text.toLowerCase());
      console.log(`   - Expecting "${text}": ${match ? '✅ Found' : '❌ NOT found'}`);
      if (!match) {
        return false;
      }
    }
    return true;
  }

  // ─────────────────────────────
  // CLICK SIGN UP BUTTON
  // ─────────────────────────────
  async clickSignUp() {
    console.log('🖱️ Clicking SIGN UP button...');
    const btn = this.page.locator('button:has-text("SIGN UP"), button:has-text("Sign up"), [role="button"]:has-text("SIGN UP")').first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click({ force: true });
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  // ─────────────────────────────
  // CLICK SIGN IN BUTTON
  // ─────────────────────────────
  async clickSignIn() {
    console.log('🖱️ Clicking Sign in button...');
    const btn = this.page.locator('button:has-text("Sign in"), button:has-text("Sign In"), a:has-text("Sign in"), a:has-text("Sign In"), [role="button"]:has-text("Sign in")').first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click({ force: true });
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  // ─────────────────────────────
  // CLICK CLAIM OFFER BUTTON (IF SHOWN)
  // ─────────────────────────────
  async clickClaimOfferIfPresent(timeout = 5000): Promise<boolean> {
    const btn = this.page.locator('button:has-text("CLAIM OFFER"), button:has-text("Claim offer"), button:has-text("Claim Offer")').first();
    const visible = await btn.isVisible({ timeout }).catch(() => false);
    if (visible) {
      console.log('🖱️ Clicking CLAIM OFFER button...');
      await btn.click({ force: true });
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
    console.log('ℹ️ CLAIM OFFER button not present, skipping...');
    return false;
  }

  // ─────────────────────────────
  // FILL REGISTRATION ACCOUNT DETAILS
  // ─────────────────────────────
  async fillAccountDetails(user: { firstName: string; lastName: string; email: string; password: string }) {
    console.log(`👤 Filling account details for email: ${user.email}`);

    // Wait for the account creation screen to be ready
    const emailInput = this.page.locator('input[type="email"], input[name="email"], input[name="emailAddress"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });

    // Fill First Name
    const firstNameInput = this.page.locator('input[name="firstName"], input[placeholder*="First" i]').first();
    await firstNameInput.fill(user.firstName);
    await firstNameInput.dispatchEvent('input');

    // Fill Last Name
    const lastNameInput = this.page.locator('input[name="lastName"], input[placeholder*="Last" i]').first();
    await lastNameInput.fill(user.lastName);
    await lastNameInput.dispatchEvent('input');

    // Fill Email
    await emailInput.fill(user.email);
    await emailInput.dispatchEvent('input');

    // Fill Password
    const passwordInput = this.page.locator('input[type="password"], input[name="password"], input[name="newPassword"]').first();
    await passwordInput.fill(user.password);
    await passwordInput.dispatchEvent('input');

    console.log('✅ Account details form filled.');
  }

  // ─────────────────────────────
  // ACCEPT CONSENTS / CHECKBOXES
  // ─────────────────────────────
  async acceptConsents() {
    console.log('✅ Checking consent / marketing checkboxes...');
    const checkboxes = this.page.locator('input[type="checkbox"]');
    const count = await checkboxes.count().catch(() => 0);
    console.log(`   Found ${count} checkboxes.`);
    for (let i = 0; i < count; i++) {
      const box = checkboxes.nth(i);
      const isChecked = await box.isChecked().catch(() => false);
      if (!isChecked) {
        // Click the label or sibling if clicking input[type="checkbox"] is intercepted
        await box.click({ force: true }).catch(async () => {
          console.warn(`   ⚠️ Click on checkbox ${i} failed, trying parent click...`);
          const parent = box.locator('xpath=..');
          await parent.click({ force: true }).catch(() => {});
        });
      }
    }
  }

  // ─────────────────────────────
  // CLICK CONTINUE TO REGISTER
  // ─────────────────────────────
  async clickContinue() {
    console.log('🖱️ Clicking CONTINUE button...');
    const btn = this.page.locator('button:has-text("CONTINUE"), button:has-text("Continue"), button[type="submit"]').first();
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ force: true });
    
    // Wait for the next page load
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await assertDaznPageAvailable(this.page, 'after submitting registration');
  }

  // ─────────────────────────────
  // VALIDATE WELCOME PAGE & START WATCHING
  // ─────────────────────────────
  async validateWelcomeAndStartWatching(timeout = 30000): Promise<void> {
    console.log('⏳ Waiting for Welcome to DAZN screen...');
    
    const welcomeHeading = this.page.locator('h1:has-text("Welcome to DAZN"), h2:has-text("Welcome to DAZN"), *:has-text("Welcome to DAZN")').first();
    await welcomeHeading.waitFor({ state: 'visible', timeout }).catch(() => {
      console.warn('⚠️ Welcome heading did not appear within timeout. Proceeding anyway...');
    });

    const startWatchingBtn = this.page.locator('button:has-text("START WATCHING"), button:has-text("Start watching"), button:has-text("Start Watching")').first();
    if (await startWatchingBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('🖱️ Clicking START WATCHING button...');
      await startWatchingBtn.click({ force: true });
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      console.log('ℹ️ START WATCHING button not found or already navigated away.');
    }
  }
}
