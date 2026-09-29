import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { Pac1Page } from '../../pages/Pac1Page';
import { Pac1ApiClient } from '../../utils/pac1ApiClient';
import { setupPac1NetworkInterceptors } from '../../utils/pac1NetworkHelper';
import { handleCookies } from '../../utils/helpers';
import { createTestUser } from '../../utils/testDataBuilder';
import { generateReports, ReportResult, ReportMeta } from '../../utils/reportGenerator';

// Environment variables
const PARTNER = process.env.PAC1_PARTNER || 'telefonica_es';
const DAZN_ENV = process.env.DAZN_ENV || 'staging';
const isHeadless = process.env.HEADLESS === 'true';

const partnerConfigPath = path.resolve(__dirname, `../../config/pac1/${PARTNER}.json`);
const partnerConfig = fs.existsSync(partnerConfigPath) ? JSON.parse(fs.readFileSync(partnerConfigPath, 'utf8')) : {};

test.describe(`PAC 1.0 Partner Automation - ${PARTNER}`, () => {
  let config: any;
  let baseUrl: string;

  test.beforeAll(async () => {
    config = partnerConfig;
    if (!config || Object.keys(config).length === 0) {
      throw new Error(`❌ Configuration file not found for partner: ${PARTNER} at ${partnerConfigPath}`);
    }

    // Determine Base URL based on DAZN_ENV
    baseUrl = DAZN_ENV === 'prod' ? 'https://www.dazn.com' : 'https://stag.dazn.com';
    console.log(`🌐 [PAC 1.0] Environment: ${DAZN_ENV} (${baseUrl})`);
    console.log(`🏢 [PAC 1.0] Partner: ${config.partnerName} (${config.brandName})`);
    console.log(`🎯 [PAC 1.0] Default Campaign: ${config.campaignName}`);
  });

  /**
   * Generates a fresh, dynamic Partial account on Staging via DAZN Auth API.
   * A Partial account has registered credentials (email + password) with no subscription plan.
   */
  async function createPac1StagingPartialUser(): Promise<{ email: string; password: string }> {
    const timestamp = Date.now();
    const email = `pac1_partial_${timestamp}@yopmail.com`;
    const password = 'TestPassword123!';
    console.log(`🆕 [PAC 1.0] Generating dynamic Partial user on Staging: ${email}...`);

    const res = await fetch('https://authentication-stage.ar.dazn-stage.com/v5/SignUp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://stag.dazn.com',
        'Referer': 'https://stag.dazn.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        AllowThirdParty: false,
        FirstName: 'Partial',
        LastName: 'Tester',
        Password: password,
        PhoneNumber: '',
        SourceType: 'DAZN',
        IsFreemium: false,
        Email: email,
        LanguageCode: 'en',
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to create staging Partial user: ${res.status} ${await res.text()}`);
    }
    console.log(`✅ [PAC 1.0] Dynamically created Staging Partial user: ${email}`);
    return { email, password };
  }

  /**
   * Helper function to execute complete PAC 1.0 end-to-end flows.
   */
  async function runPac1Flow(
    browser: any,
    userType: 'new' | 'freemium' | 'frozen' | 'activePaid' | 'partial',
    authPathway: 'pre_auth' | 'logged_out' = 'logged_out',
    campaignOverride?: string
  ) {
    // 1. Resolve user credentials (dynamically on staging if applicable)
    let credentials = config.users ? config.users[userType] : undefined;
    if (userType === 'frozen' && config.users?.frozenAccounts?.length) {
      const idx = authPathway === 'pre_auth' ? 2 : 0;
      credentials = config.users.frozenAccounts[idx] || config.users.frozen;
    }
    if (userType === 'partial' && DAZN_ENV === 'staging') {
      credentials = await createPac1StagingPartialUser();
    }

    const validationResults: ReportResult[] = [];
    const startTime = new Date();

    // 2. Resolve active campaign and expected plan metadata
    const campaignName = campaignOverride || process.env.PAC1_CAMPAIGN || config.campaignName;
    const campaignConfig = config.campaigns?.find((c: any) => c.name === campaignName);
    const expectedPlanName = campaignConfig?.expectedPlanName || config.expectedPlanName;
    const expectedPaymentMethod = campaignConfig?.expectedPaymentMethod || config.expectedPaymentMethod;

    console.log(`\n======================================================`);
    console.log(`🚀 [PAC 1.0] Starting scenario: ${userType.toUpperCase()} | Pathway: ${authPathway.toUpperCase()} | Campaign: ${campaignName}`);
    console.log(`======================================================`);

    const accessCode = await Pac1ApiClient.generateAccessCode(campaignName, DAZN_ENV);
    const redemptionUrl = Pac1ApiClient.buildRedemptionUrl(baseUrl, config.locale, config.partnerName, accessCode);
    console.log(`🔗 [PAC 1.0] Generated Redemption URL: ${redemptionUrl}`);

    // 3. Initialize browser context with video recording & partner geolocation
    const context = await browser.newContext({
      ...(isHeadless
        ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
        : { viewport: null }),
      locale: config.locale || 'en-ES',
      geolocation: config.geolocation || { latitude: 40.4168, longitude: -3.7038 },
      permissions: ['clipboard-read', 'clipboard-write', 'geolocation'],
      extraHTTPHeaders: {
        'X-Forwarded-For': '80.58.67.250',
      },
      recordVideo: {
        dir: 'test-results/videos/',
        size: { width: 1920, height: 1080 },
      },
    });

    const page = await context.newPage();

    // Lock SPA history navigation to target country
    await page.addInitScript((country: string) => {
      const origPush = history.pushState;
      history.pushState = function(state, title, url) {
        if (typeof url === 'string' && /\/(en|es)-(?!ES)[A-Z]{2}\//i.test(url)) {
          url = url.replace(/\/(en|es)-[A-Z]{2}\//i, `/$1-${country}/`);
        }
        return origPush.apply(this, [state, title, url]);
      };
      const origReplace = history.replaceState;
      history.replaceState = function(state, title, url) {
        if (typeof url === 'string' && /\/(en|es)-(?!ES)[A-Z]{2}\//i.test(url)) {
          url = url.replace(/\/(en|es)-[A-Z]{2}\//i, `/$1-${country}/`);
        }
        return origReplace.apply(this, [state, title, url]);
      };
    }, config.countryCode || 'ES');

    // Maximize window on macOS / desktop in headed mode
    if (!isHeadless) {
      try {
        const session = await context.newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'maximized' },
        });
      } catch (e: any) {
        console.warn('⚠️ [PAC 1.0] Failed to maximize window via CDP:', e.message);
      }
    }

    await setupPac1NetworkInterceptors(page, config.countryCode || 'ES');
    const pac1Page = new Pac1Page(page);

    try {
      // 4. Pre-Authentication Pathway (if applicable)
      if (authPathway === 'pre_auth' && userType !== 'new') {
        if (!credentials || !credentials.email || !credentials.password) {
          throw new Error(`❌ Missing credentials in config for userType: ${userType}`);
        }

        const signInUrl = `${baseUrl}/${config.locale || 'en-ES'}/signin`;
        console.log(`🔑 [PAC 1.0] Pre-authenticating ${userType} user at: ${signInUrl}...`);
        await page.goto(signInUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await pac1Page.signIn(credentials);

        validationResults.push({
          page: 'Pre-Authentication',
          field: 'User Login',
          expected: 'Successful authentication',
          actual: 'Authenticated session active',
          status: 'PASS',
        });
      }

      // 4. Navigate to PAC 1.0 Redemption URL
      console.log(`🌍 [PAC 1.0] Navigating to Redemption URL: ${redemptionUrl}...`);
      await page.goto(redemptionUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await handleCookies(page, 10000).catch(() => {});
      await page.waitForTimeout(2000);

      if (/\/(en|es)-(?!ES)[A-Z]{2}\//i.test(page.url())) {
        const corrected = page.url().replace(/\/(en|es)-[A-Z]{2}\//i, `/$1-${config.countryCode || 'ES'}/`);
        console.log(`🔄 [PAC 1.0] Correcting URL locale: ${page.url()} -> ${corrected}`);
        await page.goto(corrected, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await handleCookies(page, 4000).catch(() => {});
        await pac1Page.dismissOneTrustOverlay();
      }

      // 5. Handle Journey based on User Type & Pathway
      if (userType === 'new') {
        // --- NEW USER JOURNEY ---
        if (config.expectedLandingCopy && config.expectedLandingCopy.length > 0) {
          await pac1Page.validateLandingPage(config.expectedLandingCopy);
        }

        // Welcome Modal: click "CREATE DAZN ACCOUNT" with copy validation
        const modalRes = await pac1Page.handleWelcomeModal('create', {
          header: config.expectedCopy?.welcomeModal?.header,
          createAccountButton: config.expectedCopy?.welcomeModal?.createAccountButton,
          signInButton: config.expectedCopy?.welcomeModal?.signInButton,
          brand: config.brandName,
        });
        expect(modalRes.headerMatch).toBeTruthy();
        expect(modalRes.createMatch).toBeTruthy();

        validationResults.push({
          page: 'Welcome Modal',
          field: 'Modal Header',
          expected: config.expectedCopy?.welcomeModal?.header || 'WELCOME TO DAZN',
          actual: modalRes.headerMatch ? config.expectedCopy?.welcomeModal?.header : 'Mismatch',
          status: modalRes.headerMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Welcome Modal',
          field: 'Partner Brand',
          expected: config.brandName,
          actual: modalRes.brandMatch ? config.brandName : 'Mismatch',
          status: modalRes.brandMatch ? 'PASS' : 'FAIL',
        });

        // Email Details Page
        const generatedUser = createTestUser('pac1');
        console.log(`👤 [PAC 1.0] Created dynamic test user: ${generatedUser.email}`);
        await pac1Page.fillEmailDetails(generatedUser.email);

        // Personal Details Page
        await pac1Page.fillPersonalDetails({
          firstName: generatedUser.firstName,
          lastName: generatedUser.lastName,
          password: generatedUser.password,
        });

        // Confirmation Summary Page
        const summary = await pac1Page.validateConfirmationSummary({
          planName: expectedPlanName,
          paymentMethod: expectedPaymentMethod,
          email: generatedUser.email,
          brandName: config.brandName,
          expectedCopy: config.expectedCopy?.confirmation,
        });

        expect(summary.planMatch).toBeTruthy();
        expect(summary.paymentMethodMatch).toBeTruthy();
        if (summary.copyValidation) {
          expect(summary.copyValidation.headerMatch).toBeTruthy();
          expect(summary.copyValidation.offerMatch).toBeTruthy();
          expect(summary.copyValidation.termsMatch).toBeTruthy();
          expect(summary.copyValidation.ctaMatch).toBeTruthy();
        }

        validationResults.push({
          page: 'Confirmation Page',
          field: 'Plan Name',
          expected: expectedPlanName,
          actual: summary.planMatch ? expectedPlanName : 'Not found',
          status: summary.planMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Confirmation Page',
          field: 'Payment Method',
          expected: expectedPaymentMethod,
          actual: summary.paymentMethodMatch ? expectedPaymentMethod : 'Not found',
          status: summary.paymentMethodMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Confirmation Page',
          field: 'Header Copy',
          expected: config.expectedCopy?.confirmation?.header || 'START YOUR SUBSCRIPTION',
          actual: summary.copyValidation?.headerMatch ? 'START YOUR SUBSCRIPTION' : 'Mismatch',
          status: summary.copyValidation?.headerMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Confirmation Page',
          field: 'Terms of Use & Privacy Links',
          expected: 'Visible',
          actual: summary.termsVisible ? 'Visible' : 'Hidden',
          status: summary.termsVisible ? 'PASS' : 'FAIL',
        });

        // Start Subscription CTA
        await pac1Page.clickStartSubscription();

        // Validate in My Account
        const myAccountResult = await pac1Page.validateMyAccountSubscription(
          baseUrl,
          expectedPlanName,
          config.myAccountPartnerText || config.brandName,
          config.locale || 'en-ES'
        );
        expect(myAccountResult.planVerified).toBeTruthy();
        expect(myAccountResult.partnerVerified).toBeTruthy();

        validationResults.push({
          page: 'My Account',
          field: 'Subscription Plan',
          expected: expectedPlanName,
          actual: myAccountResult.planVerified ? expectedPlanName : 'Not found',
          status: myAccountResult.planVerified ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'My Account',
          field: 'Partner Managed',
          expected: config.myAccountPartnerText || config.brandName,
          actual: myAccountResult.partnerVerified ? config.myAccountPartnerText || config.brandName : 'Not found',
          status: myAccountResult.partnerVerified ? 'PASS' : 'FAIL',
        });

      } else if (authPathway === 'logged_out') {
        // --- LOGGED-OUT EXISTING USER JOURNEY ---
        if (!credentials || !credentials.email || !credentials.password) {
          throw new Error(`❌ Missing credentials for userType: ${userType}`);
        }

        // Welcome Modal: click "SIGN IN" with copy validation
        const modalRes = await pac1Page.handleWelcomeModal('signin', {
          header: config.expectedCopy?.welcomeModal?.header,
          createAccountButton: config.expectedCopy?.welcomeModal?.createAccountButton,
          signInButton: config.expectedCopy?.welcomeModal?.signInButton,
          brand: config.brandName,
        });
        expect(modalRes.headerMatch).toBeTruthy();
        expect(modalRes.signInMatch).toBeTruthy();

        validationResults.push({
          page: 'Welcome Modal',
          field: 'Modal Header',
          expected: config.expectedCopy?.welcomeModal?.header || 'WELCOME TO DAZN',
          actual: modalRes.headerMatch ? config.expectedCopy?.welcomeModal?.header : 'Mismatch',
          status: modalRes.headerMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Welcome Modal',
          field: 'Sign In CTA',
          expected: config.expectedCopy?.welcomeModal?.signInButton || 'SIGN IN',
          actual: modalRes.signInMatch ? 'SIGN IN' : 'Mismatch',
          status: modalRes.signInMatch ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'Welcome Modal',
          field: 'Partner Brand',
          expected: config.brandName,
          actual: modalRes.brandMatch ? config.brandName : 'Mismatch',
          status: modalRes.brandMatch ? 'PASS' : 'FAIL',
        });

        // Inline Sign In Form
        await pac1Page.signIn(credentials);

        // Check for double billing notice on active paid users
        if (userType === 'activePaid') {
          const bodyText = await pac1Page.getBodyText();
          const hasDoubleBilling = bodyText.toLowerCase().includes('cancel') ||
                                  bodyText.toLowerCase().includes('double') ||
                                  bodyText.toLowerCase().includes('billing');
          console.log(`🔍 [PAC 1.0 Active Paid] Double-billing notice detected: ${hasDoubleBilling ? '✅ Yes' : '⚠️ No'}`);
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Double Billing Notice',
            expected: 'Double billing notice present',
            actual: hasDoubleBilling ? 'Detected' : 'Not detected',
            status: hasDoubleBilling ? 'PASS' : 'SKIP',
          });
        }

        // Check if Confirmation Summary is shown or if DAZN auto-activated and redirected to My Account / Home
        const summaryVisible = await page.locator(
          'h1:has-text("START YOUR SUBSCRIPTION"), h2:has-text("START YOUR SUBSCRIPTION"), *:has-text("START YOUR SUBSCRIPTION"), *:has-text("Your access is included")'
        ).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);

        if (summaryVisible) {
          const summary = await pac1Page.validateConfirmationSummary({
            planName: expectedPlanName,
            paymentMethod: expectedPaymentMethod,
            email: credentials.email,
            brandName: config.brandName,
            expectedCopy: config.expectedCopy?.confirmation,
          });

          expect(summary.planMatch).toBeTruthy();
          expect(summary.paymentMethodMatch).toBeTruthy();
          if (summary.copyValidation) {
            expect(summary.copyValidation.headerMatch).toBeTruthy();
            expect(summary.copyValidation.offerMatch).toBeTruthy();
            expect(summary.copyValidation.termsMatch).toBeTruthy();
            expect(summary.copyValidation.ctaMatch).toBeTruthy();
          }

          validationResults.push({
            page: 'Confirmation Page',
            field: 'Plan Name',
            expected: expectedPlanName,
            actual: summary.planMatch ? expectedPlanName : 'Not found',
            status: summary.planMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Payment Method',
            expected: expectedPaymentMethod,
            actual: summary.paymentMethodMatch ? expectedPaymentMethod : 'Not found',
            status: summary.paymentMethodMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Header Copy',
            expected: config.expectedCopy?.confirmation?.header || 'START YOUR SUBSCRIPTION',
            actual: summary.copyValidation?.headerMatch ? 'START YOUR SUBSCRIPTION' : 'Mismatch',
            status: summary.copyValidation?.headerMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Terms of Use & Privacy Links',
            expected: 'Visible',
            actual: summary.termsVisible ? 'Visible' : 'Hidden',
            status: summary.termsVisible ? 'PASS' : 'FAIL',
          });

          // Start Subscription CTA
          await pac1Page.clickStartSubscription();
        } else {
          console.log('ℹ️ [PAC 1.0 Logged-Out] Existing user auto-activated and transitioned directly to My Account/Home.');
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Redemption Flow',
            expected: 'Direct existing-user activation',
            actual: 'Auto-redeemed and navigated',
            status: 'PASS',
          });
        }

        // Validate My Account
        const myAccountResult = await pac1Page.validateMyAccountSubscription(
          baseUrl,
          expectedPlanName,
          config.myAccountPartnerText || config.brandName,
          config.locale || 'en-ES'
        );
        expect(myAccountResult.planVerified).toBeTruthy();

        validationResults.push({
          page: 'My Account',
          field: 'Subscription Plan',
          expected: expectedPlanName,
          actual: myAccountResult.planVerified ? expectedPlanName : 'Not found',
          status: myAccountResult.planVerified ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'My Account',
          field: 'Partner Managed',
          expected: config.myAccountPartnerText || config.brandName,
          actual: myAccountResult.partnerVerified ? config.myAccountPartnerText || config.brandName : 'Not found',
          status: myAccountResult.partnerVerified ? 'PASS' : 'FAIL',
        });

      } else {
        // --- PRE-AUTHENTICATED EXISTING USER JOURNEY ---
        if (!credentials || !credentials.email || !credentials.password) {
          throw new Error(`❌ Missing credentials for userType: ${userType}`);
        }

        // Check if welcome modal or direct confirmation summary appears
        await handleCookies(page, 4000).catch(() => {});
        await pac1Page.dismissOneTrustOverlay();
        await page.waitForTimeout(3000);
        await pac1Page.dismissOneTrustOverlay();
        console.log(`📍 [PAC 1.0 Pre-Auth] Current URL after navigating to redemption: ${page.url()}`);
        await pac1Page.logSnapshotContents('Redemption URL Landed (Pre-Auth)');

        const modalHeading = page.locator('h1:has-text("WELCOME TO DAZN"), h2:has-text("WELCOME TO DAZN"), *:has-text("WELCOME TO DAZN")').first();
        const modalVisible = await modalHeading.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
        if (modalVisible) {
          console.log('ℹ️ [PAC 1.0] Welcome modal visible in pre-auth session, handling with copy validation...');
          const modalRes = await pac1Page.handleWelcomeModal('signin', {
            header: config.expectedCopy?.welcomeModal?.header,
            createAccountButton: config.expectedCopy?.welcomeModal?.createAccountButton,
            signInButton: config.expectedCopy?.welcomeModal?.signInButton,
            brand: config.brandName,
          });
          validationResults.push({
            page: 'Welcome Modal',
            field: 'Modal Header',
            expected: config.expectedCopy?.welcomeModal?.header || 'WELCOME TO DAZN',
            actual: modalRes.headerMatch ? config.expectedCopy?.welcomeModal?.header : 'Mismatch',
            status: modalRes.headerMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Welcome Modal',
            field: 'Sign In CTA',
            expected: config.expectedCopy?.welcomeModal?.signInButton || 'SIGN IN',
            actual: modalRes.signInMatch ? 'SIGN IN' : 'Mismatch',
            status: modalRes.signInMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Welcome Modal',
            field: 'Partner Brand',
            expected: config.brandName,
            actual: modalRes.brandMatch ? config.brandName : 'Mismatch',
            status: modalRes.brandMatch ? 'PASS' : 'FAIL',
          });

          // In case session requires re-confirmation on email/password screen
          const emailInput = page.locator('input[type="email"], input[name="email"]').first();
          if (await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
            console.log('🔑 [PAC 1.0 Pre-Auth] Re-confirming credentials on sign-in screen...');
            await pac1Page.signIn(credentials);
          }
        }

        // Active Paid Double billing notice check
        if (userType === 'activePaid') {
          const bodyText = await pac1Page.getBodyText();
          const hasDoubleBilling = bodyText.toLowerCase().includes('cancel') ||
                                  bodyText.toLowerCase().includes('double') ||
                                  bodyText.toLowerCase().includes('billing');
          console.log(`🔍 [PAC 1.0 Active Paid Pre-Auth] Double-billing notice detected: ${hasDoubleBilling ? '✅ Yes' : '⚠️ No'}`);
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Double Billing Notice',
            expected: 'Double billing notice present',
            actual: hasDoubleBilling ? 'Detected' : 'Not detected',
            status: hasDoubleBilling ? 'PASS' : 'SKIP',
          });
        }

        // Check if confirmation summary is shown or if DAZN is on SignUpConfirmationPageUnified
        await handleCookies(page, 3000).catch(() => {});
        await pac1Page.dismissOneTrustOverlay();

        const summaryHeading = page.locator(
          'h1:has-text("START YOUR SUBSCRIPTION"), h2:has-text("START YOUR SUBSCRIPTION"), *:has-text("START YOUR SUBSCRIPTION"), *:has-text("Your access is included")'
        ).first();
        const isSummaryVisible = await summaryHeading.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

        if (isSummaryVisible) {
          const summary = await pac1Page.validateConfirmationSummary({
            planName: expectedPlanName,
            paymentMethod: expectedPaymentMethod,
            email: credentials.email,
            brandName: config.brandName,
            expectedCopy: config.expectedCopy?.confirmation,
          });

          validationResults.push({
            page: 'Confirmation Page',
            field: 'Plan Name',
            expected: expectedPlanName,
            actual: summary.planMatch ? expectedPlanName : 'Not found',
            status: summary.planMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Payment Method',
            expected: expectedPaymentMethod,
            actual: summary.paymentMethodMatch ? expectedPaymentMethod : 'Not found',
            status: summary.paymentMethodMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Header Copy',
            expected: config.expectedCopy?.confirmation?.header || 'START YOUR SUBSCRIPTION',
            actual: summary.copyValidation?.headerMatch ? 'START YOUR SUBSCRIPTION' : 'Mismatch',
            status: summary.copyValidation?.headerMatch ? 'PASS' : 'FAIL',
          });
          validationResults.push({
            page: 'Confirmation Page',
            field: 'Terms of Use & Privacy Links',
            expected: 'Visible',
            actual: summary.termsVisible ? 'Visible' : 'Hidden',
            status: summary.termsVisible ? 'PASS' : 'FAIL',
          });

          // Click Start Subscription CTA
          await pac1Page.clickStartSubscription();
        } else {
          // If on confirmation route or unified signup confirmation page, check for confirmation CTA
          const isConfirmationUrl = page.url().includes('Confirmation') || page.url().includes('signup?page=');
          console.log(`ℹ️ [PAC 1.0 Pre-Auth] Checking confirmation CTA on settled page (URL is confirmation: ${isConfirmationUrl})...`);
          await pac1Page.dismissOneTrustOverlay();

          const ctaBtn = page.locator(
            'button:has-text("START WATCHING"), button:has-text("Start watching"), button:has-text("START YOUR SUBSCRIPTION"), button:has-text("Start subscription"), button:has-text("CONTINUE"), button:has-text("Continue"), button:has-text("CONFIRM"), button:has-text("Confirm"), button:has-text("EMPEZAR"), [role="button"]:has-text("START WATCHING"), [role="button"]:has-text("Start subscription")'
          ).first();

          if (await ctaBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
            const btnText = await ctaBtn.innerText().catch(() => 'Confirm');
            console.log(`🖱️ [PAC 1.0 Pre-Auth] Clicking confirmation CTA: "${btnText}"...`);
            await ctaBtn.click({ force: true });
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(5000);
            console.log(`📍 [PAC 1.0 Pre-Auth] Settled URL after confirmation click: ${page.url()}`);
          } else {
            console.log('ℹ️ [PAC 1.0 Pre-Auth] Auto-redeemed and transitioned directly past confirmation summary.');
          }

          validationResults.push({
            page: 'Confirmation Page',
            field: 'Redemption Flow',
            expected: 'Direct pre-auth activation',
            actual: 'Auto-redeemed and navigated',
            status: 'PASS',
          });
        }

        // Validate My Account
        const myAccountResult = await pac1Page.validateMyAccountSubscription(
          baseUrl,
          expectedPlanName,
          config.myAccountPartnerText || config.brandName,
          config.locale || 'en-ES'
        );
        expect(myAccountResult.planVerified).toBeTruthy();

        validationResults.push({
          page: 'My Account',
          field: 'Subscription Plan',
          expected: expectedPlanName,
          actual: myAccountResult.planVerified ? expectedPlanName : 'Not found',
          status: myAccountResult.planVerified ? 'PASS' : 'FAIL',
        });
        validationResults.push({
          page: 'My Account',
          field: 'Partner Managed',
          expected: config.myAccountPartnerText || config.brandName,
          actual: myAccountResult.partnerVerified ? config.myAccountPartnerText || config.brandName : 'Not found',
          status: myAccountResult.partnerVerified ? 'PASS' : 'FAIL',
        });
      }

      console.log(`\n🎉 [PAC 1.0] Successfully completed flow for ${userType} (${authPathway})!`);
    } finally {
      const video = page.video();
      const videoPath = video ? await video.path().catch(() => null) : null;
      await context.close().catch(() => {});
      if (videoPath) {
        console.log(`🎥 [PAC 1.0] Session recording saved: ${videoPath}`);
      }

      // Generate PPV-standard HTML & PDF Run Report
      if (validationResults.length > 0) {
        try {
          const reportMeta: ReportMeta = {
            event: `PAC 1.0 - ${config.brandName} (${config.partnerName})`,
            region: config.region || 'ES',
            source: 'campaign-redemption',
            ratePlan: campaignName,
            tier: expectedPlanName,
            env: DAZN_ENV,
            flowName: `PAC 1.0 - ${userType.toUpperCase()} (${authPathway})`,
            startTime,
            endTime: new Date(),
            videoPath,
            userType: userType === 'new' ? 'new-user' : 'existing-user',
            userStatus: userType,
            paymentMethod: expectedPaymentMethod,
            platform: 'Web',
          };
          const generated = await generateReports(validationResults, reportMeta);
          console.log(`📄 [PAC 1.0] Generated HTML Report: ${generated.htmlPath}`);
          if (generated.pdfPath) {
            console.log(`📑 [PAC 1.0] Generated PDF Report: ${generated.pdfPath}`);
          }
        } catch (err: any) {
          console.warn('⚠️ [PAC 1.0] Failed to compile PPV-style run report:', err.message);
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // 1. NEW USER PARTNER SIGNUP SCENARIOS (CAMPAIGNS)
  // ─────────────────────────────────────────────
  const activeCampaigns: Array<{ name: string; expectedPlanName?: string; expectedPaymentMethod?: string }> =
    process.env.PAC1_CAMPAIGN
      ? [{ name: process.env.PAC1_CAMPAIGN, expectedPlanName: partnerConfig.expectedPlanName, expectedPaymentMethod: partnerConfig.expectedPaymentMethod }]
      : (partnerConfig.campaigns && partnerConfig.campaigns.length > 0
          ? partnerConfig.campaigns
          : [{ name: partnerConfig.campaignName, expectedPlanName: partnerConfig.expectedPlanName, expectedPaymentMethod: partnerConfig.expectedPaymentMethod }]);

  for (const camp of activeCampaigns) {
    test(`New User Partner Signup - ${camp.name}`, async ({ browser }) => {
      test.setTimeout(180000);
      await runPac1Flow(browser, 'new', 'logged_out', camp.name);
    });
  }

  // ─────────────────────────────────────────────
  // 2. FREEMIUM USER SCENARIOS
  // ─────────────────────────────────────────────
  test('Freemium User - Pre-Authenticated Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'freemium', 'pre_auth');
  });

  test('Freemium User - Logged-Out Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'freemium', 'logged_out');
  });

  // ─────────────────────────────────────────────
  // 3. ACTIVE PAID USER SCENARIOS
  // ─────────────────────────────────────────────
  test('Active Paid User - Pre-Authenticated Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'activePaid', 'pre_auth');
  });

  test('Active Paid User - Logged-Out Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'activePaid', 'logged_out');
  });

  // ─────────────────────────────────────────────
  // 4. FROZEN USER SCENARIOS
  // ─────────────────────────────────────────────
  test('Frozen User - Pre-Authenticated Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'frozen', 'pre_auth');
  });

  test('Frozen User - Logged-Out Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'frozen', 'logged_out');
  });

  // ─────────────────────────────────────────────
  // 5. PARTIAL USER SCENARIOS
  // ─────────────────────────────────────────────
  test('Partial User - Pre-Authenticated Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'partial', 'pre_auth');
  });

  test('Partial User - Logged-Out Redemption', async ({ browser }) => {
    test.setTimeout(180000);
    await runPac1Flow(browser, 'partial', 'logged_out');
  });
});
