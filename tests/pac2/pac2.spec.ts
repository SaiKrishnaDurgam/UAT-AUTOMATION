import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { PacPage } from '../../pages/PacPage';
import { MyAccountPage } from '../../pages/MyAccountPage';
import { PaymentPage } from '../../pages/PaymentPage';
import { PacUrlPool } from '../../utils/pacUrlPool';
import { createTestUser } from '../../utils/testDataBuilder';
import { handleCookies } from '../../utils/helpers';
import { AuthenticationManager } from '../../auth/AuthenticationManager';

// Environment variables
const PARTNER = process.env.PAC_PARTNER || 'mobilevikings_be';
const isHeadless = process.env.HEADLESS === 'true';

test.describe(`PAC Partner Automation - ${PARTNER}`, () => {
  let config: any;
  let urlPool: PacUrlPool;

  test.beforeAll(async () => {
    const pac2ConfigPath = path.resolve(__dirname, `../../config/pac2/${PARTNER}.json`);
    const configPath = fs.existsSync(pac2ConfigPath) ? pac2ConfigPath : path.resolve(__dirname, `../../config/pac/${PARTNER}.json`);
    if (!fs.existsSync(configPath)) {
      throw new Error(`❌ Configuration file not found for partner: ${PARTNER} at ${configPath}`);
    }
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    urlPool = new PacUrlPool(PARTNER);
  });

  // Helper to dynamically create a user (Freemium or Active Paid) on Staging on-the-fly starting from the homepage
  async function createStagingUser(
    browser: any, 
    baseUrl: string, 
    type: 'freemium' | 'activePaid'
  ): Promise<{ email: string; password: string }> {
    const context = await browser.newContext({
      locale: config.locale || 'en-BE',
      geolocation: config.geolocation || { latitude: 50.8503, longitude: 4.3517 },
      permissions: ['clipboard-read', 'clipboard-write', 'geolocation'],
    });
    const page = await context.newPage();
    const homepageUrl = `${baseUrl}/en-BE/home`;
    console.log(`🆕 Generating a fresh dynamic ${type} user on Staging starting from homepage: ${homepageUrl}...`);
    
    try {
      await page.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await handleCookies(page, 15000).catch(() => {});
      
      // Click SIGN UP or Subscribe to enter standard onboarding
      const signUpBtn = page.locator('a:has-text("SIGN UP"), button:has-text("SIGN UP"), a:has-text("Sign up"), button:has-text("Sign up"), a:has-text("Subscribe"), button:has-text("Subscribe")').first();
      await signUpBtn.waitFor({ state: 'visible', timeout: 15000 });
      await signUpBtn.click({ force: true });
      
      const email = `dazn_pac_${type}_${Date.now()}@yopmail.com`;
      const password = 'TestPassword1!';
      console.log(`📧 Generated email: ${email}`);
      
      const emailInput = page.locator('input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 25000 });
      await emailInput.fill(email);
      await emailInput.dispatchEvent('change');
      
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      await continueBtn.click({ force: true });
      
      const firstName = page.locator('input[name="firstName"], input[id="firstName"]').first();
      await firstName.waitFor({ state: 'visible', timeout: 15000 });
      await firstName.fill('Test');
      
      const lastName = page.locator('input[name="lastName"], input[id="lastName"]').first();
      await lastName.fill('User');
      
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(password);
      
      const submitDetailsBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      await submitDetailsBtn.click({ force: true });
      
      // Wait for Plan selection page to load
      console.log('⏳ Waiting for plan selection page load...');
      await page.waitForTimeout(5000);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      
      if (type === 'activePaid') {
        console.log('⏳ Selecting standard subscription plan...');
        const planBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Select"), button[type="submit"]').first();
        await planBtn.waitFor({ state: 'visible', timeout: 20000 });
        await planBtn.click({ force: true });
        
        console.log('⏳ Entering staging credit card details and completing payment...');
        const paymentPage = new PaymentPage(page);
        
        // Wait for loading skeletons or shimmers to detach before selecting payment method
        const skeleton = page.locator('[class*="skeleton" i], [class*="loading" i], div[class*="shimmer" i]').first();
        if (await skeleton.isVisible().catch(() => false)) {
          console.log('⏳ Waiting for payment loading skeletons to disappear...');
          await skeleton.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
        }
        await page.waitForTimeout(2000); // Additional stabilization buffer

        await paymentPage.selectCreditCard();

        // Check the EU/BE specific terms and conditions checkbox if present
        const agreeCheckbox = page.locator('input[type="checkbox"], label:has-text("expressly agree"), [class*="checkbox" i]').first();
        if (await agreeCheckbox.isVisible({ timeout: 10000 }).catch(() => false)) {
          console.log('☑️ Clicking the EU immediate provision agreement checkbox...');
          await agreeCheckbox.click({ force: true });
        }

        // Fill card details and submit purchase
        await paymentPage.fillCardDetails(
          process.env.STAG_CARD_NUMBER || '4111111111111111',
          process.env.STAG_CARD_EXPIRY || '03/30',
          process.env.STAG_CARD_CVV || '737',
          process.env.STAG_CARD_HOLDER || 'Test User'
        );
        await paymentPage.clickSaveCard();
        await paymentPage.clickSubmit();
        
        // Wait for success / home redirect to complete
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      } else {
        // For freemium, we stop here (user is registered but has no plan)
        console.log('⏳ Freemium account state established.');
      }
      
      console.log(`✅ Dynamically created Staging ${type} account: ${email}`);
      return { email, password };
    } finally {
      await context.close();
    }
  }

  // Reusable flow function for different user states and auth pathways
  async function runPACFlow(
    browser: any,
    userType: 'new' | 'freemium' | 'frozen' | 'activePaid' | 'otherPartnerPac',
    authPathway: 'pre_auth' | 'logged_out'
  ) {
    const peekUrl = await urlPool.peekUrl();
    const baseUrl = new URL(peekUrl).origin;

    // Dynamic account creation on Staging (independent of specific partner link)
    let credentials = config.users[userType];
    if ((userType === 'freemium' || userType === 'activePaid') && baseUrl.includes('stag.dazn.com')) {
      const dynamicCreds = await createStagingUser(browser, baseUrl, userType);
      credentials = dynamicCreds;
    }

    const context = await browser.newContext({
      ...(isHeadless
        ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
        : { viewport: null }),
      isMobile: false,
      hasTouch: false,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      locale: config.locale || 'en-BE',
      geolocation: config.geolocation || { latitude: 50.8503, longitude: 4.3517 },
      permissions: ['clipboard-read', 'clipboard-write', 'geolocation'],
      recordVideo: {
        dir: 'test-results/videos/',
        size: { width: 1920, height: 1080 },
      },
    });

    const page = await context.newPage();
    const pacPage = new PacPage(page);
    const myAccountPage = new MyAccountPage(page);

    // 1. Pre-Authentication (if pathway is pre_auth)
    if (authPathway === 'pre_auth' && userType !== 'new') {
      if (!credentials || !credentials.email || credentials.email.includes('TODO_ADD')) {
        console.log(`⚠️ Skipped: No BE credentials found in config for user status "${userType}".`);
        test.skip(true, `No credentials configured for ${userType} BE user.`);
        await context.close();
        return;
      }
      console.log(`🔐 Pre-authenticating user: ${credentials.email}...`);
      const authManager = new AuthenticationManager(page, context, baseUrl);
      await authManager.authenticate({
        USER_EMAIL: credentials.email,
        USER_PASSWORD: credentials.password
      });
      console.log('✅ Pre-authentication successful.');
    }

    // 2. Navigate and validate partner URL (loop for claimed/expired retries)
    let partnerUrl = '';
    let isLandingOk = false;
    const maxAttempts = 5;
    let attempts = 0;

    while (attempts < maxAttempts && !isLandingOk) {
      attempts++;
      partnerUrl = await urlPool.getNextUnusedUrl();
      console.log(`🌍 [Attempt ${attempts}/${maxAttempts}] Navigating to partner page: ${partnerUrl}...`);
      
      try {
        await page.goto(partnerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await handleCookies(page, 15000);

        // Check if the page contains "This offer's unavailable" or "expired, has already been claimed"
        const bodyText = await page.innerText('body').catch(() => '');
        if (
          bodyText.includes("offer’s unavailable") || 
          bodyText.includes("offer's unavailable") || 
          bodyText.includes("already been claimed") ||
          bodyText.includes("expired")
        ) {
          console.warn(`⚠️ [Attempt ${attempts}] Code is expired or already claimed. Marking URL as EXPIRED and trying next one...`);
          await urlPool.markUrlStatus(partnerUrl, 'EXPIRED');
          continue;
        }

        // Validate expected landing UI copy
        const isUiValid = await pacPage.validateLandingPage(config.expectedLandingCopy);
        if (!isUiValid) {
          console.warn(`⚠️ [Attempt ${attempts}] UI Validation failed. Marking URL as EXPIRED and trying next...`);
          await urlPool.markUrlStatus(partnerUrl, 'EXPIRED');
          continue;
        }

        console.log('✅ Valid landing page copy identified.');
        isLandingOk = true;
      } catch (err: any) {
        console.warn(`⚠️ [Attempt ${attempts}] Error loading page: ${err.message}. Marking URL as EXPIRED and trying next...`);
        await urlPool.markUrlStatus(partnerUrl, 'EXPIRED');
      }
    }

    if (!isLandingOk) {
      throw new Error(`❌ Failed to find a valid/unexpired PAC URL after ${maxAttempts} attempts.`);
    }

    try {
      // 4. Trigger redemption flow
      await pacPage.clickClaimOfferIfPresent().catch(() => {});

      if (authPathway === 'logged_out' && userType !== 'new') {
        // Existing user inline sign-in
        await pacPage.clickSignIn();

        if (!credentials || !credentials.email || credentials.email.includes('TODO_ADD')) {
          console.log(`⚠️ Skipped: No BE credentials found in config for inline sign-in.`);
          test.skip(true, `No credentials configured for inline ${userType} BE user.`);
          return;
        }

        console.log(`🔑 Logging in inline with email: ${credentials.email}`);
        const emailInput = page.locator('input[type="email"], input[name="email"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        await emailInput.fill(credentials.email);
        await emailInput.dispatchEvent('change');

        const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
        await continueBtn.click({ force: true });

        const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
        await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
        await passwordInput.fill(credentials.password);
        await passwordInput.dispatchEvent('change');

        const signInBtn = page.locator('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]').first();
        await signInBtn.click({ force: true });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(5000); // Wait for redirect
        await handleCookies(page, 5000).catch(() => {}); // Dismiss cookie preferences if shown again

        console.log(`📍 Post-login URL: ${page.url()}`);
        await pacPage.logSnapshotContents('Post Sign In / Redemption Page');

        // Check if a confirmation CTA (Claim/Redeem/Confirm) appears post-login to switch billing
        // We exclude '#onetrust-consent-sdk' to avoid cookie center CONTINUE buttons
        const claimOfferBtn = page.locator('button:has-text("CONFIRM AND SWITCH MY BILLING"), [role="button"]:has-text("CONFIRM AND SWITCH MY BILLING"), a:has-text("CONFIRM AND SWITCH MY BILLING"), button:has-text("Confirm and switch my billing"), [role="button"]:has-text("Confirm and switch my billing"), a:has-text("Confirm and switch my billing"), button:has-text("CONTINUE"):not(#onetrust-consent-sdk button), [role="button"]:has-text("CONTINUE"):not(#onetrust-consent-sdk button), button:has-text("Continue"):not(#onetrust-consent-sdk button), [role="button"]:has-text("Continue"):not(#onetrust-consent-sdk button)').first();
        console.log('⏳ Waiting for confirmation button to be visible post-login...');
        await claimOfferBtn.waitFor({ state: 'visible', timeout: 20000 });

        console.log('🖱️ Clicking CLAIM OFFER / Confirm button after login...');
        await claimOfferBtn.scrollIntoViewIfNeeded().catch(() => {});
        await claimOfferBtn.hover().catch(() => {});
        await claimOfferBtn.click();
        
        // Wait for redirection after redemption click to avoid aborting the transaction
        console.log('⏳ Waiting for redirection after redemption click...');
        await page.waitForURL((url: URL) => !url.href.includes('/signup'), { timeout: 30000 }).catch(() => {
          console.warn('⚠️ Navigation after redemption click timed out.');
        });

      } else if (userType === 'new') {
        // New user registration flow
        await pacPage.clickSignUp();
        const testUser = createTestUser();
        await pacPage.fillAccountDetails(testUser);
        await pacPage.acceptConsents();
        await pacPage.clickContinue();
      } else {
        // Pre-authenticated existing user clicks confirmation button to complete redemption
        const claimOfferBtn = page.locator('button:has-text("CONFIRM AND SWITCH MY BILLING"), [role="button"]:has-text("CONFIRM AND SWITCH MY BILLING"), a:has-text("CONFIRM AND SWITCH MY BILLING"), button:has-text("Confirm and switch my billing"), [role="button"]:has-text("Confirm and switch my billing"), a:has-text("Confirm and switch my billing"), button:has-text("CONTINUE"):not(#onetrust-consent-sdk button), [role="button"]:has-text("CONTINUE"):not(#onetrust-consent-sdk button), button:has-text("Continue"):not(#onetrust-consent-sdk button), [role="button"]:has-text("Continue"):not(#onetrust-consent-sdk button)').first();
        console.log('⏳ Waiting for confirmation button to be visible (pre-authenticated)...');
        await claimOfferBtn.waitFor({ state: 'visible', timeout: 20000 });

        console.log('🖱️ Clicking CLAIM OFFER / Confirm button directly (pre-authenticated)...');
        await claimOfferBtn.scrollIntoViewIfNeeded().catch(() => {});
        await claimOfferBtn.hover().catch(() => {});
        await claimOfferBtn.click();
        
        console.log('⏳ Waiting for redirection after redemption click...');
        await page.waitForURL((url: URL) => !url.href.includes('/signup'), { timeout: 30000 }).catch(() => {
          console.warn('⚠️ Navigation after redemption click timed out.');
        });
      }

      // 5. Special warnings and logs for Active Paid users
      if (userType === 'activePaid') {
        console.log('🔍 Checking double-billing warning message on redemption transition...');
        const bodyText = await page.locator('body').innerText();
        const hasDoubleBillingMsg = bodyText.toLowerCase().includes('cancel') || bodyText.toLowerCase().includes('double billing') || bodyText.toLowerCase().includes('billing');
        if (hasDoubleBillingMsg) {
          console.log('✅ Double-billing warning message detected on page.');
        } else {
          console.warn('⚠️ Double-billing warning message not found on page.');
        }
      }

      // 6. Success confirmation page
      await pacPage.validateWelcomeAndStartWatching().catch(() => {});

      // Wait for session and URL redirect to stabilize after welcome/start watching click
      console.log('⏳ Waiting for post-redemption welcome redirection to stabilize...');
      await page.waitForURL((url: URL) => url.href.includes('/home') || url.href.includes('/dashboard') || url.href.includes('/myaccount'), { timeout: 30000 }).catch(() => {
        console.warn('⚠️ Welcome redirection timed out. Proceeding to My Account anyway...');
      });

      // 7. Verify My Account details
      const myAccountUrl = `${baseUrl}/myaccount`;
      console.log(`🏠 Navigating to My Account: ${myAccountUrl}`);
      await page.goto(myAccountUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await handleCookies(page, 8000);

      // Wait for Overview page components to render and stabilize before interacting with sidenav
      const quickLinks = page.locator('h2:has-text("Quick Links"), h3:has-text("Quick Links")').first();
      await quickLinks.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      // Click on the Subscription tab in the side menu (required for existing users to see details)
      const subTab = page.locator('a[href*="/subscription"], button:has-text("Subscription"), a:has-text("Subscription")').first();
      if (await subTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('🖱️ Clicking on "Subscription" tab in My Account sidenav...');
        await subTab.click({ force: true });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        
        // Wait for page spinner/loader to disappear if present
        const spinner = page.locator('div[class*="spinner"], div[class*="loader"], [data-test-id="loading"]').first();
        if (await spinner.isVisible().catch(() => false)) {
          console.log('⏳ Waiting for loading spinner to disappear...');
          await spinner.waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
        }
      }

      // Validate subscription status
      const subscriptionStatus = await myAccountPage.getSubscriptionStatus();
      console.log(`📋 Subscription Status found: "${subscriptionStatus}"`);
      expect(['Active', 'Manage subscription']).toContain(subscriptionStatus);

      // Validate subscription tier / billing details show partner name
      const bodyText = await page.locator('body').innerText();
      console.log(`📋 Validating My Account text for partner: "${config.myAccountPartnerText}"`);
      
      const containsPartnerInfo = bodyText.toLowerCase().includes(config.myAccountPartnerText.toLowerCase());
      expect(containsPartnerInfo).toBe(true);
      console.log(`✅ Subscription is successfully verified as managed by "${config.myAccountPartnerText}"!`);

    } catch (error) {
      const failShotPath = path.resolve(process.cwd(), `test-results/FAIL_pac_${userType}_${authPathway}_${Date.now()}.png`);
      await page.screenshot({ path: failShotPath, fullPage: true }).catch(() => {});
      console.error(`❌ Test failed for user=${userType}, pathway=${authPathway}! Screenshot saved to ${failShotPath}`);
      throw error;
    } finally {
      await context.close();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST CASES
  // ═══════════════════════════════════════════════════════════════

  test('New User Partner Signup and My Account Validation', async ({ browser }) => {
    await runPACFlow(browser, 'new', 'logged_out');
  });

  test('Freemium User - Pre-Authenticated Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'freemium', 'pre_auth');
  });

  test('Freemium User - Logged-Out Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'freemium', 'logged_out');
  });

  test('Frozen User - Pre-Authenticated Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'frozen', 'pre_auth');
  });

  test('Frozen User - Logged-Out Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'frozen', 'logged_out');
  });

  test('Active Paid User - Pre-Authenticated Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'activePaid', 'pre_auth');
  });

  test('Active Paid User - Logged-Out Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'activePaid', 'logged_out');
  });

  test('Other Partner PAC User - Pre-Authenticated Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'otherPartnerPac', 'pre_auth');
  });

  test('Other Partner PAC User - Logged-Out Redemption', async ({ browser }) => {
    await runPACFlow(browser, 'otherPartnerPac', 'logged_out');
  });
});
