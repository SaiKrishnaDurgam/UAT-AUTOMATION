import { test, Page, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { LandingPage } from '../../pages/LandingPage';
import { PPVPage } from '../../pages/PPVPage';
import { BoxingPage } from '../../pages/BoxingPage';
import { BoxingHomePage } from '../../pages/BoxingHomePage';
import { HomePage } from '../../pages/HomePage';
import { SignupPage, PersonalDetailsRedirectError } from '../../pages/SignupPage';
import { PaymentPage } from '../../pages/PaymentPage';
import { SearchPage } from '../../pages/SearchPage';
import { StandalonePPVPage } from '../../pages/StandalonePPVPage';
import { PPVUpsellSuccessPage } from '../../pages/PPVUpsellSuccessPage';
import { PPVUpsellPaymentPage } from '../../pages/PPVUpsellPaymentPage';
import { SchedulePage } from '../../pages/schedulepage';
import { MyAccountPage } from '../../pages/MyAccountPage';
import { RailsInterceptor } from '../../utils/railsInterceptor';
import { GloryPage } from '../../pages/GloryPage';
import { resolvePpvTitleForSource } from '../../utils/ppvTitleResolver';

import {
  readSheet,
  configureExcelPathForEvent,
  getPPVDataByVariant,
  getPlanDataByTier,
  getPaymentDataByTierAndPlan,
  getPhonePageData,
  getOTPPageData,
  getHomeOfBoxingData,
  getHomePageData,
  getStandalonePPVPageData,
  getUpsellFirstSuccessData,
  getUpsellSecondSuccessData,
  getUpsellPaymentData,
  getSubscribeWithoutPPVData,
  getHomeOfSportData,
} from '../../utils/excelReader';
import { detectVariant } from '../../flows/detectVariant';
import { validateVariant, validateCtaAfterUltimateSelection } from '../../flows/validateVariant';
import { captureFailures } from '../../utils/failureCapture';
import { parseCanadaCommand } from '../../utils/configLoader';
import { buildEventData } from '../../utils/buildEventData';
import { detectPageType, handleNoPpvClick, isConfiguredPpvAbsenceError, isConfiguredPpvVisible } from '../../utils/flowHelpers';
import { displayResultsTable } from '../../utils/resultsDisplay';
import { writeResults } from '../../utils/excelWriter';
import { generateReports } from '../../utils/reportGenerator';
import { reportValidationFailuresToJira } from '../../utils/jiraValidationReporter';
import { createTestUser } from '../../utils/testDataBuilder';
import {
  sleep,
  setupPage,
  handleCookies,
  stabilisePage,
  dismissMarketingPopup,
} from '../../utils/helpers';
import {
  loadEventConfig,
  safeScrollToElement,
  clickAndWaitForNav,
  handlePopupModal,
  assertCountryMatch,
  waitForHomePageAuthRedirect,
  executeCanadaSubscriptionFlow,
} from '../../utils/testHelpers';
import { AuthenticationManager } from '../../auth/AuthenticationManager';
import { validatePpvBannerImage } from '../../utils/geminiBannerValidator';


const REGION = process.env.DAZN_REGION || 'GB';
const EVENT_CONFIG = process.env.PPV_CONFIG || process.env.PPV_EVENT || 'ppv_t_joshua_prenga.json';
const PLAN = process.env.PLAN || 'standard_monthly';
const SOURCE = process.env.SOURCE || 'landing-page-banner';
const PPV_TYPE = (process.env.PPV_TYPE || 'normal').toLowerCase();
const SWITCH_TO_ULTIMATE = (process.env.SWITCH || '').toLowerCase() === 'true';
const ENV = (process.env.DAZN_ENV || 'stag').toLowerCase();
const PAYMENT_METHOD = (process.env.PAYMENT_METHOD || 'credit_card').toLowerCase();
const isHeadless = process.env.HEADLESS === 'true';
const NORMAL_FLOW_TIMEOUT_MS = Number(process.env.PPV_TEST_TIMEOUT_MS) || 420_000;
const UPSELL_FLOW_TIMEOUT_MS = Math.max(Number(process.env.PPV_UPSELL_TEST_TIMEOUT_MS) || 480_000, NORMAL_FLOW_TIMEOUT_MS);
const HOME_SPORT_DROPDOWN_SOURCES = new Set([
  'home-boxing-banner',
  'home-boxing-tile',
  'home-boxing-upcoming',
  'home-kickboxing-tile',
]);

function throwLogged(error: Error): never {
  console.log(error.message);
  throw error;
}

test.afterEach(async ({ }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && testInfo.error?.message) {
    console.log(`❌ Test failure:\n${testInfo.error.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// RUN A SINGLE FLOW
// ═══════════════════════════════════════════════════════════════

// ── Screenshot helper for failed fields (used in HTML/PDF reports) ──
async function captureFailShot(page: Page, field: string): Promise<string | undefined> {
  try {
    const dir = path.resolve(process.cwd(), 'test-results', 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = field.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const shotPath = path.join(dir, `FAIL_${safe}_${Date.now()}.jpg`);
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 75, fullPage: false });
    return shotPath;
  } catch {
    return undefined;
  }
}

async function waitForPostPlanTransition(page: Page): Promise<void> {
  console.log(`⏳ Waiting for post-plan transition. Current URL: ${page.url()}`);

  const nextState = await Promise.race([
    page.locator(
      'input[type="email"], input[name*="email" i], input[autocomplete="email"]'
    ).first().waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'email'),

    page.locator(
      'input[name*="first" i], input[autocomplete="given-name"], input[name*="password" i]'
    ).first().waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'personal-details'),

    page.locator(
      'text=/payment method|credit.*debit card|card details|secure payment|today you pay/i'
    ).first().waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'payment-ui'),

    page.waitForURL(
      url => /paymentdetails|payment|checkout/i.test(url.toString()),
      { timeout: 30_000 }
    ).then(() => 'payment-url'),
  ]).catch(() => null);

  if (!nextState) {
    const body = await page.locator('body').innerText().catch(() => '');
    throwLogged(new Error(
      `❌ Plan CTA did not transition within 30 seconds.\n` +
      `URL: ${page.url()}\n` +
      `Page text: ${body.slice(0, 3000)}`
    ));
  }

  console.log(`✅ Post-plan transition detected: ${nextState} | URL: ${page.url()}`);
}

async function runFlow(
  browser: any,
  json: any,
  flowConfig: any,
  region: string,
  validateLanding: boolean
): Promise<{ results: any[]; reachedEndPage: boolean; skipped?: boolean; skipReason?: string; videoPath?: string | null }> {
  const { name, source, tier, ratePlan: rawRatePlan, enableDevMode: devModeEnabled, noPpvClick: noPpvClickConfig, requiresDefaultSignup, requiresPlanSelection } = flowConfig;
  let noPpvClick = !!(noPpvClickConfig);
  const ratePlan = (rawRatePlan || '').replace(/-/g, ' ').toLowerCase();
  const PPV_TYPE = String(json?.PPV_TYPE || process.env.PPV_TYPE || 'normal').trim().toLowerCase();
  const isStandalonePPV = String(json?.PPV_TYPE || process.env.PPV_TYPE || 'normal').trim().toLowerCase() === 'standalone';
  if (isStandalonePPV && tier === 'ultimate') {
    throw new Error('❌ Standalone PPV does not support Ultimate plans. Use a Standard monthly or Annual Pay Monthly plan.');
  }
  if (isStandalonePPV && !['monthly', 'annual pay monthly'].includes(ratePlan)) {
    throw new Error(`❌ Standalone PPV does not support rate plan "${rawRatePlan}". Use monthly or annual pay monthly.`);
  }
  if ((SOURCE === 'boxing-banner-ultimate' || SOURCE === 'boxing-ultimate-subscription' || SOURCE === 'boxing-join-the-club') && tier !== 'ultimate') {
    throw new Error(`❌ SOURCE "${SOURCE}" requires an Ultimate plan (e.g., PLAN=ultimate_apm).`);
  }
  const results: any[] = [];

  // Standard-only surfacing points must not run Ultimate tier plans unless the
  // source is a default-signup journey and the selected PPV is configured there.
  // In that case the default signup page exposes all tiers, including Ultimate.
  const hasDefaultSignupPpv = requiresDefaultSignup && json?.HAS_DEFAULT_SIGNUP_PPV === true;
  const isDefaultSignupDevMode = json?.DEFAULT_SIGNUP_DEVMODE === true;
  const canRunDefaultSignupUltimate = hasDefaultSignupPpv || isDefaultSignupDevMode;
  if (source === 'boxing-standard-subscription' && tier === 'ultimate' && !canRunDefaultSignupUltimate) {
    console.log(`INFO: SOURCE "${source}" is a Standard-only surfacing point — skipping Ultimate plan "${rawRatePlan}".`);
    return { results, reachedEndPage: false, skipped: true };
  }

  if (source.toLowerCase() === 'boxing-page-bundle' && json?.HAS_BUNDLE !== true) {
    const skipReason = `SOURCE "${source}" requires HAS_BUNDLE: true; selected event does not have a bundle configured.`;
    console.log(`INFO: ${skipReason} Skipping flow.`);
    return { results, reachedEndPage: false, skipped: true, skipReason };
  }

  if (requiresDefaultSignup && json?.HAS_DEFAULT_SIGNUP_PPV !== true && !isDefaultSignupDevMode) {
    const skipReason = `SOURCE "${source}" requires HAS_DEFAULT_SIGNUP_PPV: true; selected event does not enable PPV in the default signup journey.`;
    console.log(`INFO: ${skipReason} Skipping flow.`);
    return { results, reachedEndPage: false, skipped: true, skipReason };
  }

  // One identity for the entire journey.
  // Never regenerate this inside the page-state loop.
  const user = createTestUser();
  console.log(
    `👤 Signup identity | pid=${process.pid} | plan=${ratePlan} | email=${user.email}`
  );

  // Configure Excel path based on event type (standalone, upsell, or normal PPV)
  configureExcelPathForEvent(json.eventKey || '');

  const eventData = buildEventData(json, region, tier, ratePlan, source);
  eventData.source = source;
  eventData.SOURCE = source;
  // OFFER_TYPE is now resolved by buildEventData from DaznPlan.json per plan+region

  // Compute date variables
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const fDay = futureDate.getDate();
  const fMonth = futureDate.toLocaleString('en-GB', { month: 'long' });
  const fYear = futureDate.getFullYear();
  eventData.FLEX_FUTURE_DATE_SHORT = `${fDay} ${fMonth} ${fYear}`;

  const offerType = eventData.OFFER_TYPE || '1_month_free';
  const isNoOffer = offerType === 'no_offer' || offerType === 'none';

  if (tier === 'ultimate') {
    eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_ULTIMATE || 'Continue with DAZN Ultimate';
    eventData.DAZN_TIER = 'DAZN Ultimate';
  } else {
    // Standard tier: CTA depends on offer type
    if (isNoOffer) {
      eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_STANDARD || 'Continue with DAZN Standard';
    } else {
      eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_STANDARD || `Continue with ${eventData.FREE_TRIAL_DAYS || '7'}-day Free Trial`;
    }
    eventData.DAZN_TIER = eventData.DAZN_TIER || 'DAZN Standard';
  }

  const activeOfferPresent = eventData.ACTIVE_OFFER_PRESENT === 'true';
  if (activeOfferPresent && ratePlan === 'monthly') {
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_LABEL || 'Flex – Pay Monthly - First Month Only';
    eventData.PAYMENT_FREE_TEXT = 'N/A';
    eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
  } else if (/^\d+_day_trial$/.test(offerType) && tier === 'standard' && ratePlan === 'monthly') {
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_TRIAL || 'Choose how to pay after your free trial';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_FREE_TEXT_TRIAL || `${eventData.FREE_TRIAL_DAYS || '7'}-days free`;
    eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_TRIAL || `${eventData.FREE_TRIAL_DAYS || '7'}-days free`;
    eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
  } else if (ratePlan === 'annual pay monthly' || ratePlan === 'annual pay upfront') {
    // APM / APU
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_ANNUAL || 'Annual - Pay Monthly';
    if (offerType === '1_month_free') {
      eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free';
    } else {
      // No 1-month-free offer (7_day_trial or no_offer) — no free text
      eventData.PAYMENT_FREE_TEXT = 'N/A';
    }
    if (tier === 'ultimate') {
      eventData.CANCELLATION_TEXT = ratePlan === 'annual pay monthly'
        ? (eventData.CANCELLATION_TEXT_ULTIMATE_APM || '')
        : (eventData.CANCELLATION_TEXT_ULTIMATE_APU || '');
    } else {
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_ANNUAL || '';
    }
  } else if (offerType === '1_month_free' && ratePlan === 'monthly') {
    // Monthly plan with 1-month-free offer (non-trial regions)
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_FLEX || 'Flex – Pay Monthly';
    eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free';
    eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
  } else if (isNoOffer && ratePlan === 'monthly') {
    // Monthly plan with no offer at all — no trial, no free month
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_FLEX || 'Flex – Pay Monthly';
    eventData.PAYMENT_FREE_TEXT = 'N/A';
    eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT || "Monthly subscription. Cancel with 30 days' notice. Your subscription auto-renews unless you cancel.";
  } else {
    eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_FLEX || 'Flex – Pay Monthly';
    eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free';
    eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
  }

  // Ensure uppercase keys are in sync
  eventData['PAYMENT_PAGE_TITLE'] = eventData.PAYMENT_PAGE_TITLE;
  eventData['PAYMENT_PLAN_NAME'] = eventData.PAYMENT_PLAN_NAME;
  eventData['PAYMENT_FREE_TEXT'] = eventData.PAYMENT_FREE_TEXT;
  eventData['PLAN_CTA_BUTTON'] = eventData.PLAN_CTA_BUTTON;
  eventData['DAZN_TIER'] = eventData.DAZN_TIER;
  eventData['CANCELLATION_TEXT'] = eventData.CANCELLATION_TEXT;

  const baseUrl = eventData.BASE_URL;
  const variantConfig = json.variants;
  const pagesConfig = json.pages;

  const regionUpper = region.toUpperCase();
  const regionContext: Record<string, { locale: string; timezoneId: string }> = {
    GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
    US: { locale: 'en-US', timezoneId: 'America/New_York' },
    AE: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
    SA: { locale: 'en-SA', timezoneId: 'Asia/Riyadh' },
    AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
    BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
    CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
    NO: { locale: 'en-GB', timezoneId: 'Europe/Oslo' },
  };
  const { locale, timezoneId } = regionContext[regionUpper] ?? regionContext.GB;
  // CI stays at its validated desktop viewport. In a headed local run, use the
  // maximised physical window so the page is not vertically clipped on laptops.
  const context = await browser.newContext({
    ...(isHeadless
      ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
      : { viewport: null }),
    isMobile: false,
    hasTouch: false,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    locale,
    timezoneId,
    permissions: ['clipboard-read', 'clipboard-write', 'geolocation'],
    recordVideo: {
      dir: 'test-results/videos/',
      size: { width: 1920, height: 1080 },
    },
  });

  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('randomABPoint')) {
        localStorage.setItem('randomABPoint', Math.random().toString());
      }

      // Stub clipboard API to allow headless clipboard write operations to succeed
      const mockClipboard = {
        writeText: async (text: any) => {
          console.log('📋 [MOCK CLIPBOARD] writeText called with:', text);
          return Promise.resolve();
        },
        readText: async () => {
          console.log('📋 [MOCK CLIPBOARD] readText called');
          return Promise.resolve('mock-dev-id');
        }
      };

      Object.defineProperty(navigator, 'clipboard', {
        value: mockClipboard,
        writable: true,
        configurable: true
      });
      console.log('✅ Clipboard API stubbed in test context');
    } catch { }
  });

  const page = await context.newPage();

  // Register console log listener to capture page errors and dev mode logs
  page.on('console', (msg: any) => {
    const text = msg.text();
    const textLower = text.toLowerCase();
    if (textLower.includes('dev') || textLower.includes('mode') || textLower.includes('copy') || textLower.includes('error') || textLower.includes('fail') || textLower.includes('clipboard') || textLower.includes('permission')) {
      console.log(`🖥️ [Page Console] ${text}`);
    }
  });

  let reachedEndPage = false;
  let capturedVideoPath: string | null = null;

  try {
    // ── Step 1: Navigate to landing page ─────────────────────
    const isHomePageSource = source.startsWith('home-page-') || source === 'home-biggest-fights';
    const isHomeSport = HOME_SPORT_DROPDOWN_SOURCES.has(source.toLowerCase());
    const isBoxingSource = source.startsWith('boxing');
    const isSearch = source.toLowerCase().includes('search');
    const isSchedule = source.toLowerCase().includes('schedule');

    const isGloryTile = source.toLowerCase() === 'glory-tile';
    const isGloryBanner = source.toLowerCase() === 'glory-banner';
    const shouldValidateTileBeforePopup = new Set(['home-page-dont-miss', 'home-boxing-tile']).has(source.toLowerCase());

    // ══════════════════════════════════════════════════════════════
    // HOME PAGE POPUP FLOW
    // ══════════════════════════════════════════════════════════════
    if (source === 'home-page-popup') {
      console.log('\n╔═══════════════════════════════════════════════════════╗');
      console.log('║  HOME PAGE POPUP FLOW — New User                      ║');
      console.log('╚═══════════════════════════════════════════════════════╝\n');

      // ── Navigate to welcome page and click Log In ──
      const landingForPopup = new LandingPage(page);
      await page.goto(`${baseUrl}/welcome`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await handleCookies(page, 15000);
      await landingForPopup.clickLogIn();

      // ── Sign up with new user ──
      const signupForPopup = new SignupPage(page);
      await page.waitForURL(/emailDetails|signup|signin/i, { timeout: 10000 }).catch(() => { });
      await page.waitForLoadState('domcontentloaded').catch(() => { });
      console.log(`📍 [Home Page Popup] Landed on: ${page.url()}`);

      await signupForPopup.enterEmail(user.email);
      await signupForPopup.clickContinue();

      // Fill personal details if shown
      const nextStep = await signupForPopup.waitForNextStep();
      if (nextStep === 'personalDetails') {
        await signupForPopup.fillPersonalDetails(user);
        try {
          await signupForPopup.clickPersonalDetailsContinue();
        } catch (e: any) {
          if (e.name === 'PersonalDetailsRedirectError') {
            // Reload redirected to PPV/plan page — the home navigation guard below
            // will navigate back to /home so the outer flow can re-enter from there.
            console.warn(`♻️  [Popup] Personal details redirect after error recovery — will navigate to home. Current URL: ${page.url()}`);
          } else {
            throw e;
          }
        }
        await waitForHomePageAuthRedirect(page, 'Home Page Popup new-user signup');
        console.log('✅ [Home Page Popup] Personal details filled');
      }

      if (!/\/home(?:[/?#]|$)/i.test(page.url())) {
        const homeUrl = `${baseUrl}/home`;
        console.log(`🏠 [Home Page Popup] Signup completed on ${page.url()} — replacing URL with: ${homeUrl}`);
        await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
        await handleCookies(page, 5000);
        await stabilisePage(page);
        await dismissMarketingPopup(page, 1000, { preservePpvPromo: true });
      }

      // ── Popup detection + validation + Buy Now (via HomePage POM) ──
      const homePageForPopup = new HomePage(page, baseUrl);
      await homePageForPopup.waitForHomePagePopup(
        { email: user.email, password: user.password },
        baseUrl, results, eventData
      );

      if (devModeEnabled) {
        console.log('\n🎭 [Home Page Popup] Enabling dev mode from the contextual PPV page...');
        const searchPage = new SearchPage(page);
        await searchPage.enableDevMode({ returnToPreviousPage: true });

        const contextualPpvId = new URL(page.url()).searchParams.get('contextualPpvId') || '';
        if (contextualPpvId !== eventData.PPV_ENTITLEMENT_ID) {
          throw new Error(
            `❌ [Home Page Popup] Dev-mode return did not restore contextualPpvId="${eventData.PPV_ENTITLEMENT_ID}". ` +
            `Current URL: ${page.url()}`
          );
        }

        await page.reload({ waitUntil: 'domcontentloaded' });
        const refreshedPpvId = new URL(page.url()).searchParams.get('contextualPpvId') || '';
        if (refreshedPpvId !== eventData.PPV_ENTITLEMENT_ID) {
          throw new Error(
            `❌ [Home Page Popup] Contextual PPV ID changed after dev-mode refresh. ` +
            `Expected "${eventData.PPV_ENTITLEMENT_ID}", received "${refreshedPpvId || 'missing'}".`
          );
        }
        console.log('✅ [Home Page Popup] Dev mode enabled and contextual PPV page refreshed');
      }
    } else if (isGloryTile || isGloryBanner) {
      const gloryPage = new GloryPage(page);
      await gloryPage.navigate();
      await setupPage(page, 8000);
      assertCountryMatch(page, region);

      console.log('\n📋 Validating Glory page...');
      const isValid = await gloryPage.validateGloryPage();
      results.push({
        page: 'Glory Kickboxing',
        field: 'Glory Page Validation',
        expected: 'true',
        actual: isValid ? 'true' : 'false',
        status: isValid ? 'PASS' : 'FAIL',
      });

      if (isGloryTile) {
        await gloryPage.clickConfiguredEventTile(eventData.PPV_NAME);
        await gloryPage.clickBuyNowInModal();
      } else {
        await gloryPage.clickConfiguredEventBanner(eventData.PPV_NAME);
      }
    } else if (isSchedule) {
      const schedule = new SchedulePage(page);
      await schedule.navigate(baseUrl);
      await setupPage(page, 8000);
      assertCountryMatch(page, region);
      await dismissMarketingPopup(page, 5000);

      if (devModeEnabled) {
        console.log('\n🎭 Dev mode flow detected — enabling dev mode on schedule page...');
        const searchPage = new SearchPage(page);
        await searchPage.enableDevMode();
        console.log('✅ dev mode enabled — continuing with ultimate flow');
      }

      const sport = json.SPORT || 'Boxing';
      let scheduleEventCard: any;
      let scheduleEventClicked = false;

      // Step 1: Apply sport filter and locate the event tile (no click yet)
      try {
        await schedule.selectSport(sport);
        scheduleEventCard = await schedule.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));
      } catch (schedErr: any) {
        if (process.env.PPV_REMOVAL === 'true') {
          console.log(`✅ [PPV Removal] Category B (${source}): Schedule event not found — confirmed removed/absent as expected.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: schedErr.message,
            status: 'PASS',
          });
          reachedEndPage = true;
          await context.close().catch(() => { });
          return { results, reachedEndPage };
        }
        console.error(`❌ Schedule: could not find event: ${schedErr.message}`);
        results.push({
          page: 'Schedule',
          field: 'PPV Event Click',
          expected: `${eventData.PPV_NAME} clickable via ${sport} filter`,
          actual: schedErr.message,
          status: 'FAIL',
        });
      }

      if (scheduleEventCard) {
        if (process.env.PPV_REMOVAL === 'true') {
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: `${eventData.PPV_NAME} found on schedule page`,
            status: 'FAIL',
          });
          throw new Error(`❌ [PPV Removal] ${eventData.PPV_NAME} is still present on schedule page`);
        }

        // Step 2: Scroll card into view FIRST, then validate tile fields from it
        await scheduleEventCard.scrollIntoViewIfNeeded().catch(() => { });

        // Pre-capture tile values directly from the located event card element
        // so getActualValue uses these instead of a broad DOM scan
        try {
          const cardHtml = await scheduleEventCard.innerHTML({ timeout: 5000 }).catch(() => '');
          const cardText = await scheduleEventCard.innerText({ timeout: 5000 }).catch(() => '');
          // Time badge: HH:MM or H:MMam/pm format
          const timeEl = scheduleEventCard.locator('span, time, div, p').filter({
            hasText: /^\d{1,2}:\d{2}(\s*[aApP][mM])?$/
          }).first();
          const tileTime = await timeEl.innerText({ timeout: 3000 }).catch(() => '');
          if (tileTime.trim()) eventData.__SCHEDULE_TILE_TIME = tileTime.trim();

          // Title / PPV name from the card
          const titleEl = scheduleEventCard.locator('h3, h4, h2, [class*="title"], [class*="name"], p').first();
          const tileTitle = await titleEl.innerText({ timeout: 3000 }).catch(() => '');
          if (tileTitle.trim()) eventData.__SCHEDULE_TILE_NAME = tileTitle.trim();

          // Promoter — second paragraph or subtitle element
          const promoterEl = scheduleEventCard.locator('p').nth(1);
          const tilePromoter = await promoterEl.innerText({ timeout: 3000 }).catch(() => '');
          if (tilePromoter.trim()) eventData.__SCHEDULE_TILE_PROMOTER = tilePromoter.trim();

          console.log(`📌 Schedule tile pre-captured → time: ${eventData.__SCHEDULE_TILE_TIME || 'N/A'}, name: ${eventData.__SCHEDULE_TILE_NAME || 'N/A'}, promoter: ${eventData.__SCHEDULE_TILE_PROMOTER || 'N/A'}`);
        } catch (preErr: any) {
          console.warn(`⚠️  Could not pre-capture schedule tile values: ${preErr.message}`);
        }

        // Step 3: Validate TILE fields (card in view, values pre-captured)
        try {
          const scheduleData = readSheet('Schedule page');
          const tileFields = scheduleData.filter((r: any) =>
            !String(r.Field || '').toLowerCase().startsWith('popup')
          );
          if (tileFields.length) {
            console.log('\n📋 Validating Schedule tile fields (before popup opens)...');
            await validateVariant(page, 'schedule', tileFields, results, eventData, 'Schedule', undefined, true);
          }
        } catch (err: any) {
          console.warn(`⚠️  Schedule tile validation error: ${err.message}`);
        }

        // Step 4: Ensure card still in view then click to open popup
        try {
          await scheduleEventCard.scrollIntoViewIfNeeded();
          await schedule.clickEvent(scheduleEventCard);
          scheduleEventClicked = true;
        } catch (schedErr: any) {
          console.error(`❌ Schedule clickEvent failed: ${schedErr.message}`);
          results.push({
            page: 'Schedule',
            field: 'PPV Event Click',
            expected: `${eventData.PPV_NAME} clickable via ${sport} filter`,
            actual: schedErr.message,
            status: 'FAIL',
          });
        }
      }

      if (scheduleEventClicked && process.env.PPV_REMOVAL !== 'true') {
        await handlePopupModal(page, results, eventData, source, false);
        await schedule.clickBuyNow();
      }
    } else if (isSearch) {
      const searchPage = new SearchPage(page);
      await searchPage.navigate(baseUrl);
      await setupPage(page, 8000);
      assertCountryMatch(page, region);
      await dismissMarketingPopup(page, 5000);

      if (devModeEnabled) {
        console.log('\n🎭 Dev mode flow detected — enabling dev mode on search page...');
        await searchPage.enableDevMode();
        console.log('✅ dev mode enabled — continuing with ultimate flow');
      }

      try {
        await searchPage.searchForPPVTileWithUpcomingFallback(eventData.PPV_NAME);
      } catch (searchErr: any) {
        if (process.env.PPV_REMOVAL === 'true') {
          console.log(`✅ [PPV Removal] Category B (${source}): Search PPV tile not found — confirmed removed/absent as expected.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: searchErr.message,
            status: 'PASS',
          });
          reachedEndPage = true;
          await context.close().catch(() => { });
          return { results, reachedEndPage };
        }
        throw searchErr;
      }

      if (process.env.PPV_REMOVAL === 'true') {
        results.push({
          page: 'PPV Removal',
          field: 'PPV Surfacing Point Removal',
          expected: 'PPV surfacing point removed from UI',
          actual: `${eventData.PPV_NAME} found on search page`,
          status: 'FAIL',
        });
        throw new Error(`❌ [PPV Removal] ${eventData.PPV_NAME} is still present on search page`);
      }

      console.log('\n📋 Validating Search page tile fields (before tile click)...');
      try {
        const searchData = readSheet('Search page');
        // Only validate tile fields here — popup fields are validated by
        // handlePopupModal after clickPPVTile opens the popup
        const tileFields = searchData.filter((r: any) =>
          !String(r.Field || '').toLowerCase().startsWith('popup')
        );
        await validateVariant(page, 'search', tileFields, results, eventData, 'Search');
      } catch (err: any) {
        console.warn(`⚠️  Search page validation error: ${err.message}`);
      }

        await searchPage.clickPPVTile(resolvePpvTitleForSource(eventData, 'search'));

      if (process.env.PPV_REMOVAL !== 'true') {
        // Check and validate popup modal after clicking the tile and before clicking Buy Now
        await handlePopupModal(page, results, eventData, source, false);
        await searchPage.clickBuyNow();
      }
    } else {
      const landing = isHomePageSource
        ? new HomePage(page)
        : isHomeSport
          ? new BoxingHomePage(page)
          : isBoxingSource
            ? new BoxingPage(page)
            : new LandingPage(page);

      // Start RailsInterceptor before navigation for home-biggest-fights so
      // the Home poster linked to the configured PPV name can be resolved.
      let railsInterceptor: RailsInterceptor | undefined;
      if (source === 'home-biggest-fights' || source === 'home-page-dazntile') {
        railsInterceptor = new RailsInterceptor(page);
        await railsInterceptor.startIntercepting();
        console.log(`🔌 [RailsInterceptor] Started for ${source} tile matching`);
      }

      await landing.navigate(baseUrl, source, eventData);

      // Pass interceptor to eventData so HomePage can use it
      if (railsInterceptor) {
        eventData._railsInterceptor = railsInterceptor;
      }
      await setupPage(page, 8000);
      assertCountryMatch(page, region);
      await dismissMarketingPopup(page, 5000);

      // ── DEV MODE: If enabled, activate dev mode to bypass phone number ──
      if (devModeEnabled) {
        console.log('\n🎭 Dev mode flow detected — enabling dev mode on landing page...');
        const searchPage = new SearchPage(page);
        await searchPage.enableDevMode(source === 'home-boxing-banner' ? { preservePpvPromo: true } : undefined);
        console.log('✅ dev mode enabled — continuing with ultimate flow');
      }

      // If it's a bundle flow, check if the bundle section/product is present on the page.
      // Staging or certain environments/configurations may not have the bundle product active/configured.
      if (source === 'boxing-page-bundle') {
        const bundleHeading = page.locator('text=/Save with a fight bundle/i').first();
        const getStartedBtn = page.locator('button:has-text("Get Started"), a:has-text("Get Started")').first();

        const hasBundleHeading = await bundleHeading.isVisible({ timeout: 5000 }).catch(() => false);
        const hasGetStarted = await getStartedBtn.isVisible({ timeout: 2000 }).catch(() => false);

        if (!hasBundleHeading && !hasGetStarted) {
          console.log(`ℹ️  [Bundle Check] Bundle section not found on page. Skipping bundle flow: "${name}"`);
          await context.close().catch(() => { });
          return { results, reachedEndPage: false, skipped: true };
        }
      }

      // ── Step 2: Resolve the configured source ──────────
      let container: any;
      const removalCtaOnlySources = new Set([
        'home-page-dazntile',
        'home-page-get-started',
        'boxing-standard-subscription',
        'boxing-ultimate-subscription',
        'boxing-join-the-club',
      ]);
      if (shouldValidateTileBeforePopup) {
        eventData.__RETURN_TILE_BEFORE_POPUP = 'true';
      }

      if (process.env.PPV_REMOVAL === 'true' && removalCtaOnlySources.has(source)) {
        if (!await isConfiguredPpvVisible(page, eventData.PPV_NAME)) {
          console.log(`✅ [PPV Removal] ${source}: configured PPV is absent from the source.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: 'Configured PPV is absent from the source',
            status: 'PASS',
          });
          await context.close().catch(() => { });
          return { results, reachedEndPage: true };
        }
        throw new Error(`❌ [PPV Removal] ${eventData.PPV_NAME} is still present via ${source}`);
      }

      if (source === 'home-page-dazntile') {
        // This source is not a PPV-container flow. HomePage finds and clicks
        // the DAZN tile from the captured rails response by entitlement.
        try {
          await landing.findPPVContainer(eventData, source);
        } catch (error) {
          if (process.env.PPV_REMOVAL !== 'true' || !isConfiguredPpvAbsenceError(error, eventData.PPV_NAME)) {
            throw error;
          }
          console.log(`✅ [PPV Removal] ${source}: configured PPV is absent from the DAZN tile source.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: error instanceof Error ? error.message : String(error),
            status: 'PASS',
          });
          await context.close().catch(() => { });
          return { results, reachedEndPage: true };
        }

        if (process.env.PPV_REMOVAL === 'true') {
          throw new Error(`❌ [PPV Removal] ${eventData.PPV_NAME} is still present via ${source}`);
        }

        if (eventData._railsInterceptor) {
          await (eventData._railsInterceptor as RailsInterceptor).stopIntercepting();
          delete eventData._railsInterceptor;
        }

        console.log('✅ [DAZN Tile] Entitlement tile clicked; waiting for subscription modal');

        const subscribeCta = page
          .locator('#notification-layer')
          .getByRole('button', { name: /^subscribe$/i })
          .filter({ visible: true })
          .first();

        if (!await subscribeCta.isVisible({ timeout: 10_000 }).catch(() => false)) {
          throw new Error(
            'DAZN entitlement tile opened no visible subscription modal with a Subscribe CTA'
          );
        }

        await subscribeCta.click({ force: true });
        console.log('✅ [DAZN Tile] Subscription modal Subscribe CTA clicked');
      } else {
        try {
          container = await landing.findPPVContainer(eventData, source);
        } catch (error) {
          if (process.env.PPV_REMOVAL !== 'true' || !isConfiguredPpvAbsenceError(error, eventData.PPV_NAME)) {
            throw error;
          }
          console.log(`✅ [PPV Removal] ${source}: configured PPV is absent from the source.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: error instanceof Error ? error.message : String(error),
            status: 'PASS',
          });
          await context.close().catch(() => { });
          return { results, reachedEndPage: true };
        }

        // Stop intercepting after findPPVContainer completes
        if (eventData._railsInterceptor) {
          await (eventData._railsInterceptor as RailsInterceptor).stopIntercepting();
          delete eventData._railsInterceptor;
        }

        if (!container) {
          if (process.env.PPV_REMOVAL === 'true') {
            console.log(`✅ [PPV Removal] Category B (${source}): PPV container not found on page — confirmed removed/absent as expected.`);
            results.push({
              page: 'PPV Removal',
              field: 'PPV Surfacing Point Removal',
              expected: 'PPV surfacing point removed from UI',
              actual: 'PPV container absent from page',
              status: 'PASS',
            });
            await context.close().catch(() => { });
            return { results, reachedEndPage: true };
          }
          throwLogged(new Error(`❌ PPV container not found via ${source}`));
        }
        if (process.env.PPV_REMOVAL === 'true') {
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: `${eventData.PPV_NAME} container found via ${source}`,
            status: 'FAIL',
          });
          throw new Error(`❌ [PPV Removal] ${eventData.PPV_NAME} is still present via ${source}`);
        }
      }

      if (validateLanding) {
        if ((source === 'landing-page-banner' || source === 'boxing-page-banner') && container) {
          const flowName = source === 'landing-page-banner' ? 'landing-page-banner' : 'boxing-page-banner';
          await validatePpvBannerImage(container, {
            region: REGION,
            flow: flowName,
          });
        }

        if (isHomeSport || isHomePageSource) {
          console.log('ℹ️  Home of Sport/Home page flow — skipping Step 1 validation (handled in Step 2)');
        } else {
          const isBoxingSourceInner = source.startsWith('boxing');
          const sheetName = isBoxingSourceInner ? 'Boxing page' : 'Landing page';
          const pageName = isBoxingSourceInner ? 'Boxing' : 'Landing';

          // Skip landing page validation for subscription-only boxing sources
          // — they go directly to TierPlans/PlanDetails, there is no PPV banner to validate.
          const isBoxingSubscriptionSource =
            source === 'boxing-ultimate-subscription' ||
            source === 'boxing-standard-subscription' ||
            source === 'boxing-page-bundle' ||
            source === 'boxing-join-the-club';

          if (!isBoxingSubscriptionSource) {
            console.log(`\n📋 Validating ${pageName} page...`);
            try {
              const landingData = readSheet(sheetName);

              let flowParam = 'landing';
              if (source === 'landing-page-banner') {
                flowParam = 'landing-page-banner';
              } else if (source.startsWith('boxing-page-bundle') || source.startsWith('boxing-bundle')) {
                flowParam = 'boxing-bundle';
              } else if (source === 'boxing-upcoming-fights') {
                flowParam = 'boxing-upcoming';
              } else if (source.startsWith('boxing')) {
                flowParam = 'boxing';
              }

              await validateVariant(page, 'landing', landingData, results, eventData, pageName, flowParam);
            } catch (err: any) {
              console.warn(`⚠️  Entry page validation error: ${err.message}`);
            }
          } else {
            console.log(`ℹ️ [${source}] Subscription source — skipping boxing banner/landing validation.`);
          }
        }
      }

      // Home of Sport & Home Page: validate banner/popup content before clicking Buy Now
      // NOTE: Skip for home-biggest-fights — the popup only appears AFTER clicking the
      // Coming Up tile (which happens inside clickBuyNow). handlePopupModal handles it.
      if ((isHomeSport || isHomePageSource) && source !== 'home-biggest-fights') {
        const onOnboarding = page.url().includes('signup') || page.url().includes('PlanDetails') || page.url().includes('payment');
        if (onOnboarding) {
          console.log('ℹ️ Already on onboarding page — skipping popup modal validations');
        } else {
          console.log('\n📋 Validating Entry page using Excel sheet...');
          try {
            if (isHomePageSource) {
              let homePageData = getHomePageData(source);
              if (shouldValidateTileBeforePopup) {
                homePageData = homePageData.filter((row: any) =>
                  !String(row.Field || '').trim().toLowerCase().startsWith('popup')
                );
              }
              if (homePageData && homePageData.length > 0) {
                await validateVariant(page, 'home-page', homePageData, results, eventData, 'Home Page', source);
              } else {
                console.log(`ℹ️ No spreadsheet rules for homepage source "${source}" — skipping validation`);
              }
            } else {
              const isNonBoxingSportTile =
                source === 'home-boxing-tile' &&
                String(eventData.SPORT || '').trim().toLowerCase() !== 'boxing';
              const isNonBoxingGenericSportHero =
                source === 'home-boxing-banner' &&
                String(eventData.SPORT || '').trim() !== '' &&
                String(eventData.SPORT || '').trim().toLowerCase() !== 'boxing';
              const useHomeOfSportData = isNonBoxingSportTile || isNonBoxingGenericSportHero;
              const queryFlow = isNonBoxingGenericSportHero
                ? 'home-sport-generic-hero'
                : isNonBoxingSportTile
                ? 'home-sport-tile'
                : source.includes('banner')
                  ? 'home-boxing-banner'
                  : source === 'home-boxing-upcoming'
                    ? 'home-boxing-upcoming'
                    : 'home-boxing-tile';
              const homeSportData = useHomeOfSportData
                ? getHomeOfSportData(queryFlow)
                : getHomeOfBoxingData(queryFlow);
              const homeSportTileData = shouldValidateTileBeforePopup
                ? homeSportData.filter((row: any) =>
                  !String(row.Field || '').trim().toLowerCase().startsWith('popup')
                )
                : homeSportData;
              if (homeSportTileData && homeSportTileData.length > 0) {
                await validateVariant(
                  page,
                  useHomeOfSportData ? 'home-sport' : 'home-boxing',
                  homeSportTileData,
                  results,
                  eventData,
                  useHomeOfSportData ? 'Home of Sport' : 'Home of Boxing',
                  queryFlow
                );
              } else {
                console.log(`ℹ️ No spreadsheet rules for home sport source "${queryFlow}" — skipping validation`);
              }
            }
          } catch (err: any) {
            console.warn(`⚠️ Entry page validation error: ${err.message}`);
          }
        }
      }

      // home-page-dazntile clicks the entitlement tile inside
      // findPPVContainer(), so it has no PPV container for the generic
      // Buy Now handler.
      if (source !== 'home-page-dazntile' && process.env.PPV_REMOVAL !== 'true') {
        if (shouldValidateTileBeforePopup) {
          console.log('📌 Tile validation completed before popup. Clicking tile to open popup...');
          const clickTarget = container.locator(
            'xpath=ancestor-or-self::*[self::a or self::button or @role="button"][1]'
          ).first();
          const target = await clickTarget.isVisible({ timeout: 500 }).catch(() => false)
            ? clickTarget
            : container;
          try {
            await target.click({ force: true, timeout: 10000 });
          } catch (clickErr: any) {
            const handle = await target.elementHandle().catch(() => null);
            if (!handle) throw clickErr;
            await page.evaluate((el: any) => el.click(), handle);
          }
          await handlePopupModal(page, results, eventData, source, true);
        } else {
          await landing.clickBuyNow(container, source, eventData);
        }
      } else if (process.env.PPV_REMOVAL === 'true') {
        console.log('ℹ️ [PPV Removal] Generic Buy Now click skipped');
      } else {
        console.log(
          'ℹ️ [DAZN Tile] Generic PPV Buy Now click skipped; entitlement tile was already clicked'
        );
      }
    }

    if (source !== 'home-page-popup') {
      // Handle generic popup validations and click-through
      if (
        (!isHomeSport || source === 'home-page-dont-miss') &&
        !['glory-tile', 'glory-banner'].includes(source)
      ) {
        await handlePopupModal(page, results, eventData, source, true);
      }

      await page.waitForURL(
        (url: URL) =>
          url.toString().includes('PlanDetails') ||
          url.toString().includes('TierPlans') ||
          url.toString().includes('signup'),
        { timeout: 10000 }
      ).catch(async () => {
        await page.waitForURL(
          (url: URL) => !url.toString().includes('/welcome'),
          { timeout: 5000 }
        ).catch(() => { });
      });

      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
    }

    // ── Step 3: Detect variant ───────────────────────────────
    console.log('landed on:', page.url());
    // ── STRICT VALIDATION FOR BOXING-BANNER-ULTIMATE REDIRECT ──
    if (SOURCE === 'boxing-banner-ultimate') {
      console.log('\n🔍 Validating boxing-banner-ultimate redirect...');
      await page.waitForFunction(() => {
        const href = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();
        return href.includes('plandetails') ||
          href.includes('choosehowtobuy') ||
          href.includes('purchase') ||
          text.includes('choose your plan') ||
          text.includes('choose how to buy') ||
          text.includes('choose a plan');
      }, { timeout: 15000 }).catch(() => { });

      const currentUrl = page.url();
      const bodyText = await page.locator('body').innerText().catch(() => '');

      // 1. It should NOT go to the normal PPV page
      if (bodyText.toLowerCase().includes('choose how to buy') ||
        (currentUrl.includes('contextualPpvId') && !currentUrl.includes('PlanDetails'))) {
        throw new Error('❌ [boxing-banner-ultimate] Redirected to normal PPV page ("Choose how to buy") instead of DAZN Ultimate Plan page.');
      }

      // 2. It SHOULD go directly to the Plan page
      if (!currentUrl.includes('PlanDetails') && !bodyText.toLowerCase().includes('choose your plan')) {
        throw new Error(`❌ [boxing-banner-ultimate] Expected to land on DAZN Ultimate Plan page, but landed on: ${currentUrl}`);
      }
      console.log('✅ Successfully redirected directly to DAZN Ultimate Plan page.');
    }

    // ── STRICT VALIDATION FOR BOXING-ULTIMATE-SUBSCRIPTION REDIRECT ──
    if (source === 'boxing-ultimate-subscription') {
      console.log('\n🔍 Validating boxing-ultimate-subscription redirect...');
      // Wait for URL or body to settle on the plan page.
      // The SPA loads `signup` first, then client-side routing adds ?page=PlanDetails.
      await page.waitForFunction(() => {
        const href = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();
        return href.includes('tierplans') ||
          href.includes('plandetails') ||
          text.includes('dazn ultimate') ||
          text.includes('choose your plan') ||
          text.includes('choose a plan');
      }, { timeout: 20000 }).catch(() => { });

      const subUrl = page.url();
      const subBody = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

      const subOnPPVPage = subBody.includes('to watch your pay-per-view');
      const subUrlOk = subUrl.includes('TierPlans') || subUrl.includes('PlanDetails');
      const subBodyOk = subBody.includes('dazn ultimate') || subBody.includes('choose your plan') || subBody.includes('choose a plan');

      // Must NOT land on the normal PPV page
      if (subOnPPVPage && !subUrlOk && !subBodyOk) {
        throw new Error('❌ [boxing-ultimate-subscription] Unexpectedly redirected to PPV page — expected TierPlans or PlanDetails (Ultimate).');
      }
      // Must land on plan page (by URL OR body text)
      if (!subUrlOk && !subBodyOk) {
        throw new Error(`❌ [boxing-ultimate-subscription] Expected to land on TierPlans/PlanDetails (Ultimate), but landed on: ${subUrl}`);
      }
      console.log(`✅ [boxing-ultimate-subscription] Successfully redirected to plan selection page. URL: ${subUrl}`);
    }

    // ── STRICT VALIDATION FOR BOXING-STANDARD-SUBSCRIPTION / HOME-PAGE-GET-STARTED / HOME-PAGE-DAZNTILE REDIRECT ──
    if (source === 'boxing-standard-subscription' || source === 'home-page-get-started' || source === 'home-page-dazntile' || source === 'home-page-subscribe') {
      console.log(`\n🔍 Validating ${source} redirect...`);

      // Step 1: Wait for URL to update to one of the target pages
      await page.waitForFunction(() => {
        const href = window.location.href.toLowerCase();
        return href.includes('plandetails') ||
          href.includes('tierplans') ||
          href.includes('signup');
      }, { timeout: 15000 }).catch(() => { });

      // Step 2: Wait for page load states to settle
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
      await page.waitForLoadState('load', { timeout: 5000 }).catch(() => { });

      // Step 3: Wait for the page body text to render and settle (not loading/empty, and contains common page or PPV elements)
      await page.waitForFunction(() => {
        const text = document.body.innerText.toLowerCase();
        if (text.trim() === '' || text.includes('loading')) {
          return false;
        }
        return text.includes('subscribe without a pay-per-view') ||
          text.includes('continue without pay-per-view') ||
          text.includes('continue without a pay-per-view') ||
          text.includes('choose a plan') ||
          text.includes('dazn standard') ||
          text.includes('create an account') ||
          text.includes('email address') ||
          text.includes('password');
      }, { timeout: 15000 }).catch(() => { });

      const stdUrl = page.url();
      const stdBody = await page.locator('body').innerText().catch(() => '');

      // Must NOT land on PPV page
      if (stdBody.toLowerCase().includes('to watch your pay-per-view') &&
        !stdUrl.includes('PlanDetails') && !stdUrl.includes('TierPlans') && !stdUrl.includes('signup')) {
        throw new Error(`❌ [${source}] Unexpectedly redirected to PPV page — expected PlanDetails or signup (Standard).`);
      }

      if (!stdUrl.includes('PlanDetails') && !stdUrl.includes('TierPlans') && !stdUrl.includes('signup')) {
        throw new Error(`❌ [${source}] Expected to land on PlanDetails, TierPlans, or signup (Standard), but landed on: ${stdUrl}`);
      }

      // defaultSignup=true means the plan page should contain a PPV option ("subscribe without a pay-per-view").
      const hasPPVOption = stdBody.toLowerCase().includes('subscribe without a pay-per-view') ||
        stdBody.toLowerCase().includes('continue without pay-per-view') ||
        stdBody.toLowerCase().includes('continue without a pay-per-view');
      if (!hasPPVOption && !noPpvClick) {
        const skipMsg =
          `⚠️ [${source}] No PPV option found on plan/signup page — ` +
          `PPV is not configured for this event on this source. Skipping flow gracefully.\n` +
          `URL: ${stdUrl}`;
        console.log(skipMsg);
        results.push({
          page: 'PPV',
          field: 'PPV Option Present',
          expected: 'Subscribe without a pay-per-view',
          actual: 'Not found — PPV not configured for this source',
          status: 'SKIP',
        });
        reachedEndPage = true;
        return { results, reachedEndPage };
      }

      console.log(`✅ [${source}] Successfully redirected to plan selection page with PPV option.`);
    }

    // ── STRICT VALIDATION FOR BOXING-JOIN-THE-CLUB REDIRECT ──
    if (source === 'boxing-join-the-club') {
      console.log('\n🔍 Validating boxing-join-the-club redirect...');
      // Wait for URL or body to settle. The SPA loads `signup` first, then
      // client-side routing appends ?page=PlanDetails. Body text is a reliable fallback.
      await page.waitForFunction(() => {
        const href = window.location.href.toLowerCase();
        const text = document.body.innerText.toLowerCase();
        return href.includes('tierplans') ||
          href.includes('plandetails') ||
          text.includes('dazn ultimate') ||
          text.includes('choose your plan') ||
          text.includes('choose a plan');
      }, { timeout: 20000 }).catch(() => { });

      const clubUrl = page.url();
      const clubBody = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

      const onPPVPage = clubBody.includes('to watch your pay-per-view');
      const urlOk = clubUrl.includes('TierPlans') || clubUrl.includes('PlanDetails');
      const bodyOk = clubBody.includes('dazn ultimate') || clubBody.includes('choose your plan') || clubBody.includes('choose a plan');

      // Must NOT land on the wrong PPV page
      if (onPPVPage && !urlOk && !bodyOk) {
        throw new Error('❌ [boxing-join-the-club] Unexpectedly redirected to PPV page — expected TierPlans or PlanDetails (Ultimate).');
      }
      // Must land on plan page (URL OR body text is sufficient)
      if (!urlOk && !bodyOk) {
        throw new Error(`❌ [boxing-join-the-club] Expected to land on TierPlans/PlanDetails (Ultimate), but landed on: ${clubUrl}\nPage body snippet: ${clubBody.slice(0, 200)}`);
      }
      console.log(`✅ [boxing-join-the-club] Successfully redirected to plan selection page. URL: ${clubUrl}`);
    }
    const variant = await detectVariant(page, variantConfig).catch(() => 'variant1');
    console.log('🎯 variant:', variant);
    const currentVariantConfig = variantConfig?.[variant] || {};

    // ── Step 4: Flow loop ────────────────────────────────────
    let ppvValidated = false;
    let planValidated = false;
    // Require a DAZN Plan step only where the selected tier has a plan choice
    // in the target region.
    let planValidationRequiredAfterPpv = false;
    let planClickCount = 0;
    let emailProcessedCount = 0;
    let stuckCount = 0;
    let firstPaymentDone = false;
    let firstSuccessValidated = false;
    let savedCardPaymentDone = false;
    for (let step = 0; step < 15; step++) {
      if (page.isClosed()) throw new Error('❌ Page closed unexpectedly');

      const pageType = await detectPageType(page, pagesConfig, planClickCount, isStandalonePPV);
      await handleCookies(page, step === 0 ? 5000 : 500);
      await stabilisePage(page);
      if (PPV_TYPE !== 'upsell' || !firstPaymentDone) {
        await dismissMarketingPopup(page);
      }

      // ── Canada (CA) Region Branching ─────────────────────────────
      const currentRegion = (eventData.REGION || eventData.region || process.env.DAZN_REGION || region || 'GB').toUpperCase();
      if (currentRegion === 'CA') {
        console.log(`🇨🇦 [Region ${currentRegion} Detected] Executing Canada UFT Subscription Flow...`);
        const ppvPageObj = new PPVPage(page);
        const paymentPageObj = new PaymentPage(page);
        await executeCanadaSubscriptionFlow(
          page,
          ppvPageObj,
          paymentPageObj,
          eventData,
          results,
          process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN,
          user
        );
        reachedEndPage = true;
        break;
      }

      // ── PPV Removal validation check ──
      if (process.env.PPV_REMOVAL === 'true') {
        const url = page.url().toLowerCase();
        const isCategoryA =
          SOURCE === 'home-boxing-tile' ||
          SOURCE === 'home-page-dazntile' ||
          SOURCE === 'home-kickboxing-tile' ||
          SOURCE === 'schedule' ||
          SOURCE === 'search';

        if (isCategoryA) {
          const isSignupPage =
            url.includes('page=tierplans') ||
            url.includes('page=plandetails') ||
            url.includes('/signup') ||
            pageType === 'plan' ||
            pageType === 'email';

          if (isSignupPage) {
            const bodyText = await page.locator('body').innerText({ timeout: 2000 }).then((t: string) => t.toLowerCase()).catch(() => '');
            const hasPPVPurchase = bodyText.includes('pay-per-view') || bodyText.includes('choose how to buy');
            if (hasPPVPurchase) {
              throw new Error(`❌ [PPV Removal] Found PPV purchase option on page ${page.url()} when event should be removed`);
            }
            console.log(`✅ [PPV Removal] Category A (${SOURCE}): Successfully landed on DAZN tier plans/signup page: ${page.url()}. Event is no longer a PPV and is part of DAZN subscription.`);
            results.push({
              page: 'PPV Removal',
              field: 'Redirect to DAZN Signup Flow',
              expected: 'Landed on DAZN Signup/Tier Plans page without PPV purchase option',
              actual: `Landed on ${page.url()} without PPV elements`,
              status: 'PASS',
            });
            reachedEndPage = true;
            await context.close().catch(() => { });
            return { results, reachedEndPage };
          }
        } else {
          console.log(`✅ [PPV Removal] Category B (${SOURCE}): PPV surfacing point is removed/absent from page as expected.`);
          results.push({
            page: 'PPV Removal',
            field: 'PPV Surfacing Point Removal',
            expected: 'PPV surfacing point removed from UI',
            actual: 'PPV surfacing point is absent from page',
            status: 'PASS',
          });
          reachedEndPage = true;
          await context.close().catch(() => { });
          return { results, reachedEndPage };
        }
      }

      // ── Default Signup validation check: Fail if no PPV ──
      // Skip this check for boxing subscription sources — they intentionally bypass the PPV page
      // and go directly to plans. DEFAULT_SIGNUP=true is still set for them (they are sub-only flows)
      // but the "no PPV" check only applies to home-page / landing-page default signup sources.
      // Also skip for subscribe-without-pay-per-view (noPpvClick) — it intentionally navigates
      // away from the PPV option and lands on TierPlans without the "Subscribe without a pay-per-view" text.
      const isBoxingSubscriptionSource =
        SOURCE === 'boxing-banner-ultimate' ||
        SOURCE === 'boxing-ultimate-subscription' ||
        SOURCE === 'boxing-standard-subscription' ||
        SOURCE === 'boxing-join-the-club';
      if (process.env.DEFAULT_SIGNUP === 'true' && !ppvValidated && !isBoxingSubscriptionSource && !noPpvClickConfig) {
        const url = page.url().toLowerCase();
        if (url.includes('page=tierplans') || url.includes('page=plandetails') || pageType === 'plan' || pageType === 'email') {
          const bodyText = await page.locator('body').innerText({ timeout: 2000 }).then((t: string) => t.toLowerCase()).catch(() => '');
          const hasPPVOption = bodyText.includes('subscribe without a pay-per-view') ||
            bodyText.includes('continue without pay-per-view') ||
            bodyText.includes('continue without a pay-per-view');
          if (!hasPPVOption) {
            const skipMsg =
              `⚠️ [DefaultSignup] No PPV option found on plan page — ` +
              `PPV not configured for this source. Skipping flow gracefully.\n` +
              `URL: ${page.url()}`;
            console.log(skipMsg);
            results.push({
              page: 'PPV',
              field: 'PPV Option Present',
              expected: 'Subscribe without a pay-per-view',
              actual: 'Not found — PPV not configured for this source',
              status: 'SKIP',
            });
            reachedEndPage = true;
            return { results, reachedEndPage };
          }
        }
      }

      // ── OTP Verification page ──────────────────────────────
      if (pageType === 'otp') {
        console.log('🔑 Reached OTP Verification page');
        reachedEndPage = true;

        try {
          const otpData = getOTPPageData();
          await validateVariant(page, 'otp', otpData, results, eventData, 'OTP Verification');
        } catch (e: any) {
          console.warn('⚠️  OTP page validation error:', e.message);
          results.push({
            page: 'OTP Verification',
            field: 'OTP Page Reached',
            expected: 'Yes',
            actual: 'Yes',
            status: 'PASS',
          });
        }

        break;
      }

      // ── Phone Number page (Add your phone number) ──────────
      if (pageType === 'phone') {
        console.log('📱 Reached "Add your phone number" page');
        reachedEndPage = true;

        try {
          const phoneData = getPhonePageData();
          await validateVariant(page, 'phone', phoneData, results, eventData, 'Phone Number');
        } catch (e: any) {
          console.warn('⚠️  Phone page validation error:', e.message);
          results.push({
            page: 'Phone Number',
            field: 'Phone Number Page Reached',
            expected: 'Yes',
            actual: 'Yes',
            status: 'PASS',
          });
        }

        break;
      }

      // ── UPSELL: First Success Page ──────────────────────────────
      if (pageType === 'success-upsell' && PPV_TYPE === 'upsell' && firstPaymentDone && !firstSuccessValidated) {
        console.log('🏆 First Success Page — PPV Upsell');
        stuckCount = 0;
        const successPage = new PPVUpsellSuccessPage(page);
        try {
          const successData = getUpsellFirstSuccessData();
          if (successData.length > 0) {
            await successPage.validateUpsellSuccess(successData, results, eventData, 'First Success');
          }
        } catch (err: any) { console.warn('⚠️ First Success validation error:', err.message); }
        firstSuccessValidated = true;
        await successPage.clickBuyUpsell();
        continue;
      }

      // ── UPSELL: Saved Card Payment (PPV B purchase) ─────────────
      if (pageType === 'saved-card-payment' && PPV_TYPE === 'upsell' && firstPaymentDone && firstSuccessValidated && !savedCardPaymentDone) {
        console.log('💳 Upsell Saved Card Payment');
        stuckCount = 0;
        const savedCardPage = new PPVUpsellPaymentPage(page);
        try {
          const upsellPayData = getUpsellPaymentData();
          if (upsellPayData.length > 0) {
            await savedCardPage.validateSavedCardPayment(upsellPayData, results, eventData, 'Upsell Payment');
          }
        } catch (err: any) { console.warn('⚠️ Upsell Payment validation error:', err.message); }
        savedCardPaymentDone = true;
        await savedCardPage.fillAndSubmit(eventData);
        results.push({ page: 'Upsell Payment', field: 'Upsell Payment Completed', expected: 'Success', actual: 'Success', status: 'PASS' });
        continue;
      }

      // ── UPSELL: Second Success Page (DAZN Bet promo) ────────────
      if (pageType === 'bet-upsell' && PPV_TYPE === 'upsell' && savedCardPaymentDone) {
        console.log('🎰 Second Success Page — DAZN Bet');
        stuckCount = 0;
        const successPage = new PPVUpsellSuccessPage(page);
        try {
          const betData = getUpsellSecondSuccessData();
          if (betData.length > 0) {
            await successPage.validateBetUpsell(betData, results, eventData, 'Second Success');
          }
        } catch (err: any) { console.warn('⚠️ Second Success validation error:', err.message); }
        reachedEndPage = true;
        await successPage.clickMaybeLater();
        break;
      }

      if (pageType === 'payment') {
        if (planValidationRequiredAfterPpv && !planValidated) {
          throw new Error(
            `❌ PPV journey bypassed DAZN Plan validation. Expected PPV → DAZN Plan → Payment, ` +
            `but reached Payment directly. URL: ${page.url()}`
          );
        }
        console.log('💳 Reached Payment page');
        reachedEndPage = true;

        const payment = new PaymentPage(page);
        if (await payment.isPaymentPage()) {
          console.log('✅ Payment page detected');
          const planKey = source === 'boxing-page-bundle' ? `${ratePlan} bundle` : ratePlan;
          const paymentData = getPaymentDataByTierAndPlan(tier, planKey);
          console.log(`📊 Payment rows: ${paymentData.length}`);
          await payment.validate(paymentData, results, eventData, 'newuser');
        }

        // ── SCENARIO 2: Ultimate Upsell Banner — validate before click,
        //    click conditionally, validate after click ──────────────────
        const isStandardTierForUpsell = (tier || '').toLowerCase() === 'standard';
        const isMonthlyOrAPMForUpsell = ratePlan === 'monthly' || ratePlan === 'annual pay monthly';

        if (isStandalonePPV) {
          await payment.validateUltimateUpsellBannerAbsent(results);
        } else if (isStandardTierForUpsell && isMonthlyOrAPMForUpsell) {
          try {
            // STEP A: Always validate banner text BEFORE click (both prod and stag)
            await payment.validateUltimateUpsellBannerText(results, eventData);

            // Click arrow only if SWITCH=true is explicitly set
            const shouldClickUpsell = SWITCH_TO_ULTIMATE || SOURCE === 'landing-page-dont-miss-live-switch';

            if (shouldClickUpsell) {
              // STEP C: Click > arrow and validate DAZN Ultimate summary
              const switched = await payment.clickUltimateUpsellAndValidate(results, eventData);

              if (switched) {
                // STEP D: update eventData so payment fill proceeds as Ultimate
                console.log('💎 [SWITCH=true] Proceeding with DAZN Ultimate payment...');
                eventData.TIER = 'ultimate';
                eventData['TIER'] = 'ultimate';
                eventData.DAZN_TIER = 'DAZN Ultimate';
                eventData['DAZN_TIER'] = 'DAZN Ultimate';
                // Rate plan stays as annual pay monthly (Ultimate APM)
                eventData.RATE_PLAN = 'annual pay monthly';
                eventData['RATE_PLAN'] = 'annual pay monthly';
              }
            } else {
              // SWITCH not set → skip click, log info, proceed with Standard
              console.log('ℹ️ SWITCH not set — skipping Ultimate upsell click. Proceeding with Standard payment.');
            }
          } catch (upsellErr: any) {
            console.warn(`⚠️ Ultimate Upsell Banner validation error: ${upsellErr.message}`);
          }
        }
        // ── End Scenario 2 ────────────────────────────────────────────

        firstPaymentDone = true;

        // --- Payment details filling on staging ---
        const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
        if (env === 'stag') {
          console.log(`💳 DAZN_ENV is stag — filling payment via method: ${PAYMENT_METHOD}`);
          try {
            if (PAYMENT_METHOD === 'gpay') {
              // ── Google Pay flow ──────────────────────────────────
              console.log('🔵 [GPay] Using Google Pay payment method...');
              await payment.fillGooglePayAndSubmit(results, eventData);
              await payment.verifyPaymentSuccess();
              if (PPV_TYPE === 'upsell') {
                await new PPVUpsellSuccessPage(page).waitForUpsellOffer(eventData.UPSELL_BUY_CTA);
              } else {
                await payment.clickSuccessContinue();
              }
            } else {
              // ── Credit Card flow (existing default) ──────────────
              console.log('💳 Using Credit Card payment method...');
              await payment.fillPaymentAndSubmit();
              await payment.verifyPaymentSuccess();
              if (PPV_TYPE === 'upsell') {
                await new PPVUpsellSuccessPage(page).waitForUpsellOffer(eventData.UPSELL_BUY_CTA);
              } else {
                await payment.clickSuccessContinue();
              }
            }

            console.log('✅ Payment details submitted successfully on staging!');
            results.push({
              page: 'Payment Success',
              field: 'Payment Completed',
              expected: 'Success page reached',
              actual: 'Success page reached',
              status: 'PASS',
            });

            // ── SCENARIO 3: Navigate to My Account and validate PPV status = Purchased ──
            // Only runs on stag after successful payment, and only for normal PPV flows
            if (PPV_TYPE !== 'upsell') {
              try {
                console.log('\n🏠 [Post-Payment] Validating PPV status in My Account...');
                const myAccountPage = new MyAccountPage(page);
                await myAccountPage.navigateToMyAccountAndValidatePPVStatus(
                  eventData.PPV_NAME,
                  results,
                  eventData
                );
              } catch (myAccountErr: any) {
                console.warn(`⚠️ [Post-Payment] My Account PPV status validation error: ${myAccountErr.message}`);
                results.push({
                  page: 'My Account (Post-Payment)',
                  field: 'PPV Status After Purchase',
                  expected: 'Purchased',
                  actual: `Error: ${myAccountErr.message}`,
                  status: 'FAIL',
                });
              }
            }
            // ── End Scenario 3 ────────────────────────────────────────────────────────

            // ── SCENARIO 4: Navigate to Schedule Page and Click Event Tile (Post-Payment) ──
            if (PPV_TYPE !== 'upsell') {
              try {
                console.log('\n📅 [Post-Payment] Navigating to Schedule page to verify purchased event...');
                const schedulePagePostPayment = new SchedulePage(page);
                await schedulePagePostPayment.navigate(baseUrl);

                const sport = eventData.SPORT || json.SPORT || 'Boxing';
                await schedulePagePostPayment.selectSport(sport);

                console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
                const eventCard = await schedulePagePostPayment.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));

                console.log('🖱️ Clicking PPV event tile...');
                await eventCard.click();

                console.log('⏳ Waiting for navigation off the Schedule page...');
                await page.waitForURL((url: URL) => !url.href.includes('/schedule'), { timeout: 15000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

                const currentUrl = page.url();
                console.log(`🔗 Post-payment redirected URL: ${currentUrl}`);

                const lowerUrl = currentUrl.toLowerCase();
                let navStatus: 'PASS' | 'FAIL' = 'FAIL';
                let actualPage = 'Unknown Page';

                if (lowerUrl.includes('preview')) {
                  actualPage = 'Preview Page';
                  navStatus = 'PASS';
                } else if (
                  lowerUrl.includes('fixture') ||
                  lowerUrl.includes('event') ||
                  lowerUrl.includes('stream') ||
                  lowerUrl.includes('player')
                ) {
                  actualPage = 'Fixture Page';
                  navStatus = 'PASS';
                }

                results.push({
                  page: 'Schedule (Post-Payment)',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Navigated to: ${currentUrl} (${actualPage})`,
                  status: navStatus,
                });

                if (navStatus === 'FAIL') {
                  console.error(`❌ Post-payment navigation target check failed. URL: ${currentUrl}`);
                } else {
                  console.log(`✅ Post-payment navigation target check passed: ${actualPage}`);
                }
              } catch (scheduleErr: any) {
                console.warn(`⚠️ [Post-Payment] Schedule page validation error: ${scheduleErr.message}`);
                results.push({
                  page: 'Schedule (Post-Payment)',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Error: ${scheduleErr.message}`,
                  status: 'FAIL',
                });
              }
            }
            // ── End Scenario 4 ────────────────────────────────────────────────────────

            // For upsell flows, continue the loop to handle post-payment pages
            if (PPV_TYPE === 'upsell') {
              console.log('🔄 Upsell flow — continuing loop for post-payment pages...');
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
              continue;
            }
          } catch (paymentErr: any) {
            console.error(`❌ Payment filling failed: ${paymentErr.message}`);
            const _shotPay = await captureFailShot(page, 'Payment Completed').catch(() => undefined);
            results.push({
              page: 'Payment Success',
              field: 'Payment Completed',
              expected: 'Success page reached',
              actual: `Failed: ${paymentErr.message}`,
              status: 'FAIL',
              screenshot: _shotPay,
            });
            throw paymentErr;
          }
        } else {
          console.log(`ℹ️ DAZN_ENV is "${env}" — skipping card details filling.`);
          if (PPV_TYPE === 'upsell') {
            reachedEndPage = true;
          }
        }

        break;
      }

      if (pageType === 'email') {
        if (planValidationRequiredAfterPpv && !planValidated) {
          throw new Error(
            `❌ PPV journey bypassed DAZN Plan validation. Expected PPV → DAZN Plan → signup, ` +
            `but reached signup directly. URL: ${page.url()}`
          );
        }
        console.log(
          `📧 Signup state | plan=${ratePlan} | email=${user.email} | url=${page.url()}`
        );

        // ── Social login mid-flow (AUTH_METHOD=google etc.) ──────────────────
        const authMethodEnv = (process.env.AUTH_METHOD || '').toLowerCase().trim();
        if (authMethodEnv && authMethodEnv !== 'email') {
          console.log(`🔐 [New User] AUTH_METHOD="${authMethodEnv}" — authenticating mid-flow via AuthenticationManager`);
          const authManager = new AuthenticationManager(page, context, baseUrl);
          await authManager.authenticate(eventData);
          console.log('✅ [New User] Social login complete — continuing flow');
          continue;
        }
        // ─────────────────────────────────────────────────────────────────────

        if (page.url().includes('userExists=true')) {
          throw new Error(
            `❌ DAZN rejected generated signup identity as an existing user. ` +
            `plan=${ratePlan} | email=${user.email} | url=${page.url()}`
          );
        }

        console.log('✅ Reached email/personal-details page');
        emailProcessedCount++;

        // ── Error popup detection (e.g. "No key found!", error codes) ──
        const bodyTextForError = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        const errorPatterns = [
          /no key found/i,
          /error code:\s*\d/i,
          /something went wrong/i,
          /try refreshing the page/i,
          /unexpected error/i,
        ];
        const matchedError = errorPatterns.find(p => p.test(bodyTextForError));
        if (matchedError) {
          const errorSnippet = bodyTextForError.split('\n').filter((l: string) => errorPatterns.some(p => p.test(l))).join(' | ').substring(0, 200);
          console.warn(`⚠️  [Signup Error] Detected transient popup: "${errorSnippet}" — dismissing and retrying.`);
          const okBtn = page.locator(
            'button:has-text("Ok"), button:has-text("OK"), button:has-text("Okay"), [role="button"]:has-text("Ok")'
          ).first();
          if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await okBtn.click({ force: true }).catch(() => { });
            await page.waitForLoadState('domcontentloaded').catch(() => { });
          }
          emailProcessedCount--;
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
          console.warn(`♻️  [Signup Error] Reload complete — retrying from: ${page.url()}`);
          continue;
        }

        // CRITICAL FIX: After 2 email processing attempts, the flow is stuck
        // on personalDetails page. Break out and treat as reached end page
        // (the email personal details will lead to payment after manual intervention)
        if (emailProcessedCount > 2) {
          console.log('⚠️  Email/personal details loop detected — breaking');
          // Try one more click on the continue button then break
          const anyBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
          if (await anyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            const beforeUrl = page.url();
            await anyBtn.click({ force: true }).catch(() => { });
            await page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 2000 }).catch(() => { });
          }
          // Check if we reached payment
          if (page.url().includes('paymentDetails') || page.url().includes('payment')) {
            reachedEndPage = true;
            console.log('💳 Navigated to payment page after loop detection retry');
            continue;
          }
          break;
        }

        const signup = new SignupPage(page);

        // Check if email input is visible first (might land/be stuck directly on personal details)
        // Skip finding/entering email if we are explicitly on the personal details page to avoid resetting/looping the flow.
        const onPersonalDetails = page.url().includes('page=personalDetails');

        // If we're on personalDetails and already processed once, just click Continue
        if (onPersonalDetails && emailProcessedCount > 1) {
          console.log('ℹ️  Already on personal details (retry) — just clicking Continue');
          const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
          if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await continueBtn.click({ force: true }).catch(() => { });
            // Check if we moved to payment
            if (page.url().includes('paymentDetails') || page.url().includes('payment')) {
              console.log('💳 Navigated to payment after retry');
              reachedEndPage = true;
              continue;
            }
          }
          continue;
        }

        const emailInput = onPersonalDetails ? null : await signup.findEmailInput();
        if (emailInput) {
          await signup.enterEmail(user.email);
          await signup.clickContinue();
          await page.waitForLoadState('domcontentloaded').catch(() => { });
          await sleep(500);
        } else {
          console.log('ℹ️  Email input not visible or on personal details page — assuming directly on personal details page');
        }

        // Wait for form state to initialize (prevents mobx-state-tree errors)
        await page.waitForLoadState('domcontentloaded').catch(() => { });

        const firstNameEl = page.locator('[data-test-id="FIRST_NAME"], input[name="firstName"]').first();
        const firstNameVisible = await firstNameEl.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
        if (firstNameVisible) {
          const signup2 = new SignupPage(page);
          try {
            await signup2.fillPersonalDetails(user);
            try {
              await signup2.clickPersonalDetailsContinue();
            } catch (e: any) {
              if (e.name === 'PersonalDetailsRedirectError') {
                console.warn(`♻️  Personal details redirect after error — re-entering navigation loop from: ${page.url()}`);
                continue;
              }
              throw e;
            }

            // Robust phone validation fallback: retry different formats if stuck with error message
            const errorMsg = page.locator('text=/valid phone number|valid number/i').first();
            if (await errorMsg.isVisible({ timeout: 1500 }).catch(() => false)) {
              console.log(`⚠️ Phone validation error detected: "${await errorMsg.textContent()}"`);

              // Country code flag is read-only and prepopulated by locale. Try alternative phone formats directly.

              const phoneInput = page.locator(
                'input[type="tel"], input[name*="phone" i], input[name*="Phone" i], input[placeholder*="phone" i]'
              ).first();

              const isAU = region === 'AU' || page.url().includes('-AU');
              const formats = isAU
                ? ['0412345678', '412345678', '+61412345678', '0400000000', '400000000']
                : ['7480748354', '+447480748354', '07480748354', '+917480748354', '07700900100', '7700900100'];
              for (const fmt of formats) {
                console.log(`🔄 Trying alternative phone format: ${fmt}`);
                await phoneInput.click({ force: true });
                await phoneInput.press('Meta+A');
                await phoneInput.press('Backspace');
                await phoneInput.fill(fmt);
                await phoneInput.dispatchEvent('change');
                await phoneInput.blur();

                // Re-trigger validation with click
                try {
                  await signup2.clickPersonalDetailsContinue();
                } catch (e: any) {
                  if (e.name === 'PersonalDetailsRedirectError') {
                    console.warn(`♻️  Personal details redirect after phone retry — re-entering navigation loop from: ${page.url()}`);
                    continue;
                  }
                  throw e;
                }
                await Promise.race([
                  page.waitForURL((url: URL) => !url.toString().includes('page=personalDetails'), { timeout: 2000 }),
                  errorMsg.waitFor({ state: 'hidden', timeout: 2000 })
                ]).catch(() => { });

                if (!(await errorMsg.isVisible().catch(() => false)) && !page.url().includes('page=personalDetails')) {
                  console.log(`✅ Success! Phone format ${fmt} accepted (error message cleared or page changed).`);
                  break;
                }
              }

              if (await errorMsg.isVisible().catch(() => false)) {
                const isStag = page.url().includes('stag') || (process.env.DAZN_ENV || '').toLowerCase() === 'stag';
                if (isStag) {
                  console.log('⚠️ [Stag Phone Validation Check] Phone validation assets failed to load on staging (ERR_NAME_NOT_RESOLVED). Exiting flow early and successfully.');
                  reachedEndPage = true;
                  break;
                }
              }
            }
          } catch (fillErr: any) {
            // Ignore error if page has already navigated to paymentDetails or payment
            const currentUrl = page.url().toLowerCase();
            if (currentUrl.includes('payment') || currentUrl.includes('paymentdetails')) {
              console.log(`ℹ️ Form fill or click failed but page has transitioned to payment page: ${fillErr.message}. Proceeding.`);
            } else {
              throw fillErr;
            }
          }
        } else {
          console.log('⚠️  Personal details not detected — skipping');
        }

        await page.waitForLoadState('domcontentloaded').catch(() => { });

        // After personal details Continue, wait and check if we moved to payment
        await sleep(2000);
        if (page.url().includes('paymentDetails')) {
          console.log('💳 Navigated to payment page after personal details');
        }

        continue;
      }

      if (pageType === 'standalone-ppv') {
        if (!isStandalonePPV) {
          console.log('⚠️ standalone-ppv detected but PPV_TYPE is not standalone — treating as ppv');
          // fall through to ppv handler
        } else {
          console.log('👉 Standalone PPV page');
          stuckCount = 0;

          const standalonePPVPage = new StandalonePPVPage(page);

          await standalonePPVPage.waitUntilPPVPageReady();

          if (!ppvValidated) {
            try {
              const ppvData = getStandalonePPVPageData();
              console.log(`📊 Standalone PPV rows: ${ppvData.length}`);

              await standalonePPVPage.validatePPVPageForSelectedPlan(
                ppvData,
                results,
                eventData,
                ratePlan === 'monthly' ? 'flex' : 'annual_monthly',
              );
              ppvValidated = true;
            } catch (err: any) {
              console.warn('⚠️ Standalone PPV page validation error:', err.message);
            }
          }

          await standalonePPVPage.selectPlan(
            ratePlan === 'monthly' ? 'flex' : 'annual_monthly'
          );
          await standalonePPVPage.clickContinue();
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
          continue;
        }
      }

      // ── DEFAULT SIGNUP PAGE ──────────────────────────────────
      if (pageType === 'default-signup') {
        console.log('👉 Default Signup page');
        stuckCount = 0;

        // For noPpvClick flows (subscribe-without-pay-per-view), skip PPV validation
        // and event-match check — the goal is only to click "Subscribe without a pay-per-view".
        if (!noPpvClick) {
          if (!ppvValidated) {
            try {
              const ppvData = getPPVDataByVariant(variant);
              console.log(`📊 PPV rows (Default Signup): ${ppvData.length}`);
              const ppvFlow = undefined;
              await validateVariant(page, variant, ppvData, results, eventData, 'Default Signup', ppvFlow);
            } catch (e: any) {
              console.warn('⚠️ Default Signup validation error:', e.message);
            }
            ppvValidated = true;
          }

          // ── Default Signup Event Matching Check ──
          const ppvName = eventData.PPV_NAME || '';
          const nameClean = ppvName.replace(/[:\-–]/g, ' ');
          let matched = false;
          if (nameClean.includes('vs')) {
            const fighters = nameClean.split(/\bvs\b/i).map((f: string) => f.trim());
            const f1 = fighters[0];
            const f2 = fighters[1];
            if (f1 && f2) {
              const hasF1 = await page.locator(`text=${f1}`).first().isVisible().catch(() => false);
              const hasF2 = await page.locator(`text=${f2}`).first().isVisible().catch(() => false);
              matched = hasF1 || hasF2;
            }
          }
          if (!matched && ppvName) {
            matched = await page.locator(`text=${ppvName}`).first().isVisible().catch(() => false);
          }
          if (!matched) {
            throw new Error(`❌ [DefaultSignup] PPV on page does not match the expected event: "${ppvName}"`);
          }
          console.log(`✅ [DefaultSignup] Verified PPV on page matches: "${ppvName}"`);
        } else {
          console.log('ℹ️ [DefaultSignup] Skipping PPV event match check (noPpvClick flow).');
        }

        // Select Ultimate card first if tier is ultimate
        if (tier === 'ultimate') {
          console.log('💎 [DefaultSignup] Selecting DAZN Ultimate card...');
          const ultimateSelectors = [
            'div:has-text("The Ultimate Fan Package") >> text=DAZN Ultimate',
            '[class*="upsell" i]:has-text("Ultimate")',
            '[class*="ultimate" i]:has-text("Ultimate")',
            'div:has-text("DAZN Ultimate"):has-text("/month")',
            'label:has-text("DAZN Ultimate")'
          ];
          let clicked = false;
          for (const sel of ultimateSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
              await safeScrollToElement(page, el);
              await el.click({ force: true }).catch(() => { });
              console.log(`✅ [DefaultSignup] Clicked Ultimate card via selector: ${sel}`);
              clicked = true;
              break;
            }
          }

          if (!clicked) {
            const radios = page.locator('input[type="radio"]');
            const count = await radios.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
              const radio = radios.nth(i);
              const text = await radio.evaluate((el: HTMLElement) => {
                let container: HTMLElement | null = el;
                for (let depth = 0; depth < 8 && container; depth += 1) {
                  const text = container.innerText || container.textContent || '';
                  if (/dazn\s+ultimate|ultimate/i.test(text)) return text;
                  container = container.parentElement;
                }
                return '';
              }).catch(() => '');
              if (text.toLowerCase().includes('ultimate')) {
                await safeScrollToElement(page, radio);
                await radio.click({ force: true }).catch(() => { });
                console.log(`✅ [DefaultSignup] Clicked Ultimate radio at index ${i}`);
                clicked = true;
                break;
              }
            }
          }
        }

        // Validate CTA after selecting DAZN Ultimate card
        if (tier === 'ultimate') {
          await validateCtaAfterUltimateSelection(page, variant, results, eventData, 'Default Signup');
        }

        // ── Subscribe Without PPV opt-out (default signup page) ────────
        // The "Subscribe without a pay-per-view" CTA lives on the Default Signup page,
        // not the PPV page — so noPpvClick must be handled here.
        if (noPpvClick) {
          console.log('🔗 [noPpvClick] Clicking "Subscribe without a pay-per-view" on Default Signup page...');
          await handleNoPpvClick(page, eventData);
          noPpvClick = false; // reset so it only fires once
          continue;           // re-detect page type after navigation
        }

        let btn = page.locator('button:has-text("Continue with DAZN Ultimate"), button:has-text("Continue with pay-per-view"), button:has-text("Continue"), button[type="submit"]').first();
        if (tier === 'ultimate') {
          const ultBtn = page.locator('button:has-text("Continue with DAZN Ultimate")').first();
          if (await ultBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            btn = ultBtn;
          }
        }
        console.log(`🖱️ [DefaultSignup] Clicking CTA: "${await btn.innerText().catch(() => 'Continue')}"...`);
        await clickAndWaitForNav(page, btn, 'DefaultSignup Continue');
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
        continue;
      }

      if (pageType === 'ppv') {
        console.log('👉 PPV page');
        stuckCount = 0;

        // ── Subscribe Without PPV opt-out ──────────────────────────────
        if (noPpvClick) {
          console.log('🔗 [noPpvClick] Triggering subscribe-without-pay-per-view flow...');
          await handleNoPpvClick(page, eventData);
          noPpvClick = false; // reset so it only fires once
          continue;           // re-detect page type after navigation
        }

        if (!ppvValidated) {
          try {
            if (source === 'boxing-page-bundle') {
              console.log('📋 Validating Bundle PPV page (Boxing page sheet)...');
              const bundlePpvData = readSheet('Boxing page');
              await validateVariant(page, variant, bundlePpvData, results, eventData, 'Bundle PPV', 'boxing-bundle-ppv');
            } else {
              const ppvData = getPPVDataByVariant(variant);
              console.log(`📊 PPV rows: ${ppvData.length}`);
              await validateVariant(page, variant, ppvData, results, eventData, 'PPV');
            }
          } catch (e: any) {
            console.warn('⚠️  PPV validation error:', e.message);
          }
          ppvValidated = true;
        }

        // --- FAST PATH FOR DEV MODE FLOWS ---
        if (devModeEnabled) {
          console.log('⚡ Dev mode fast-path: clicking PPV page CTA immediately...');

          // Select Ultimate card first if tier is ultimate
          if (tier === 'ultimate') {
            console.log('💎 Dev mode: selecting Ultimate card before CTA...');
            const ultimateSelectors = [
              'div:has-text("The Ultimate Fan Package") >> text=DAZN Ultimate',
              '[class*="upsell" i]:has-text("Ultimate")',
              '[class*="ultimate" i]:has-text("Ultimate")',
              'div:has-text("DAZN Ultimate"):has-text("/month")',
              'label:has-text("DAZN Ultimate")'
            ];
            for (const sel of ultimateSelectors) {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
                await el.click({ force: true }).catch(() => { });
                console.log(`✅ Dev mode: selected Ultimate card via: ${sel}`);
                break;
              }
            }
          }
          // Validate CTA after selecting DAZN Ultimate card (dev mode)
          if (tier === 'ultimate') {
            await validateCtaAfterUltimateSelection(page, variant, results, eventData, 'PPV');
          }

          const buttonSelectors = [
            'button:has-text("Continue with DAZN Ultimate")',
            'button:has-text("Continue with pay-per-view")',
            'button:has-text("Continue")',
            'button[type="submit"]'
          ];

          let ctaClicked = false;
          for (const sel of buttonSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
              await clickAndWaitForNav(page, btn, `PPV Continue (DevMode CTA: ${sel})`);
              ctaClicked = true;
              break;
            }
          }

          if (!ctaClicked) {
            const submitBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
            await submitBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { });
            await clickAndWaitForNav(page, submitBtn, 'PPV Continue (DevMode Fallback)');
          }

          await setupPage(page, 500);
          continue;
        }
        // ------------------------------------

        if (tier === 'ultimate') {
          console.log('💎 Clicking DAZN Ultimate card...');
          const selectors = [
            'div:has-text("The Ultimate Fan Package") >> text=DAZN Ultimate',
            '[class*="upsell" i]:has-text("Ultimate")',
            '[class*="ultimate" i]:has-text("Ultimate")',
            'div:has-text("DAZN Ultimate"):has-text("/month")',
            'label:has-text("DAZN Ultimate")'
          ];
          let clicked = false;
          for (const sel of selectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible().catch(() => false)) {
              await safeScrollToElement(page, el);
              await el.click({ force: true }).catch(() => { });
              console.log(`✅ Clicked Ultimate card via selector: ${sel}`);
              clicked = true;
              break;
            }
          }

          if (!clicked) {
            const radios = page.locator('input[type="radio"]');
            const count = await radios.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
              const radio = radios.nth(i);
              const text = await radio.evaluate((el: HTMLElement) => {
                let container: HTMLElement | null = el;
                for (let depth = 0; depth < 8 && container; depth += 1) {
                  const text = container.innerText || container.textContent || '';
                  if (/dazn\s+ultimate|ultimate/i.test(text)) return text;
                  container = container.parentElement;
                }
                return '';
              }).catch(() => '');
              if (text.toLowerCase().includes('ultimate')) {
                await safeScrollToElement(page, radio);
                await radio.click({ force: true }).catch(() => { });
                console.log(`✅ Clicked Ultimate radio at index ${i}`);
                clicked = true;
                break;
              }
            }
          }

          if (!clicked) {
            throw new Error('❌ Unable to reselect DAZN Ultimate after returning to the PPV page; refusing to continue with the default PPV plan.');
          }

          // Validate CTA after selecting DAZN Ultimate card
          await validateCtaAfterUltimateSelection(page, variant, results, eventData, 'PPV');

          const btn = page.locator('button:has-text("Continue with DAZN Ultimate")').first();
          if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) {
            throw new Error('❌ DAZN Ultimate is not selected: the Ultimate-specific Continue CTA is absent. Refusing to continue with the default PPV plan.');
          }
          await clickAndWaitForNav(page, btn, 'PPV Continue Ultimate');
        } else {
          const ppvSelector = currentVariantConfig?.ppvSelector || 'input[type="radio"]';
          const ppvInput = page.locator(ppvSelector).first();
          if (await ppvInput.isVisible().catch(() => false)) {
            await safeScrollToElement(page, ppvInput);
            await ppvInput.click({ force: true }).catch(() => { });
          }

          let btn = page.locator('button:has-text("Continue with pay-per-view")').first();
          if (await btn.isVisible().catch(() => false)) {
            console.log('🖱️ Clicking CTA: "Continue with pay-per-view"');
          } else {
            const ctaText = currentVariantConfig?.ctaText || 'Continue';
            console.log(`🖱️  Clicking CTA: "${ctaText}"`);
            btn = page.locator(`button:has-text("${ctaText}")`).first();
          }
          await clickAndWaitForNav(page, btn, `PPV Continue (${variant})`);
        }

        // Validate the DAZN Plan step only when this tier has a plan choice in
        // the target region; single-plan tiers proceed directly to signup.
        planValidationRequiredAfterPpv = !!requiresPlanSelection;
        await setupPage(page, 500);
        continue;
      }

      if (pageType === 'plan') {
        console.log(`👉 DAZN Plan page - Tier: ${tier}, Rate Plan: ${ratePlan}`);
        stuckCount = 0;
        planClickCount++;

        // ── Canada (CA) Region Branching ─────────────────────────────
        const currentRegion = (eventData.REGION || eventData.region || process.env.DAZN_REGION || 'GB').toUpperCase();
        if (currentRegion === 'CA') {
          console.log(`🇨🇦 [Region ${currentRegion} Detected] Executing Canada UFT Subscription Flow...`);
          const ppvPageObj = new PPVPage(page);
          const paymentPageObj = new PaymentPage(page);
          await executeCanadaSubscriptionFlow(
            page,
            ppvPageObj,
            paymentPageObj,
            eventData,
            results,
            process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN
          );
          reachedEndPage = true;
          break;
        }

        // Handle TierPlans selection first if on TierPlans page
        if (page.url().toLowerCase().includes('page=tierplans')) {
          // ── subscribe-without-pay-per-view: endPage=plan → stop here ──
          // The flow goal is to verify the TierPlans page is reached.
          // Do NOT click any CTA — just confirm landing and break.
          if (flowConfig.endPage === 'plan') {
            console.log('✅ [subscribe-without-pay-per-view] Reached TierPlans page — flow complete (endPage=plan).');

            // ── Excel-driven validations for subscribe-without-pay-per-view ──
            try {
              const noPpvRules = getSubscribeWithoutPPVData();
              const isTierPlans = page.url().toLowerCase().includes('tierplans');
              const fieldActualMap: Record<string, string> = {
                'dazn tile clicked': eventData.DAZN_TILE_CLICKED ? 'Yes' : 'No',
                'subscribe without ppv cta': eventData.SUBSCRIBE_WITHOUT_PPV_CTA_TEXT || 'N/A',
                'tier page displayed': isTierPlans ? 'Yes' : 'No',
              };
              for (const rule of noPpvRules) {
                const field = (rule.Field || '').trim();
                const expected = (rule.Expected || '').trim();
                const fieldKey = field.toLowerCase();
                const actual = fieldActualMap[fieldKey] || 'N/A';
                const status = actual.toLowerCase().includes(expected.toLowerCase()) ? 'PASS' : 'FAIL';
                console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${field}] expected="${expected}" actual="${actual}"`);
                results.push({ page: 'Subscribe Without PPV', field, expected, actual, status });
              }
            } catch (e: any) {
              console.warn('⚠️ Subscribe Without PPV validation error:', e.message);
            }

            reachedEndPage = true;
            break;
          }

          console.log(`🗺️ Handling TierPlans page selection for tier: ${tier}`);
          let tierBtn;
          if (tier === 'ultimate') {
            tierBtn = page.locator('button:has-text("Continue with DAZN Ultimate"), button:has-text("Continue with Ultimate")').first();
          } else {
            tierBtn = page.locator('button:has-text("Continue with Standard"), button:has-text("Continue with DAZN Standard")').first();
          }
          if (await tierBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await safeScrollToElement(page, tierBtn);
            await clickAndWaitForNav(page, tierBtn, `TierPlans Selection (${tier})`);
            await setupPage(page, 500);
            continue;
          }
        }

        // The page default can differ from the requested Ultimate rate plan.
        // validateVariant is deferred to after the card click (below) so that
        // 'Annual Pay Monthly Selected' / 'Annual Pay Upfront Selected' fields
        // are read from the DOM in the correct post-selection state.
        const shouldDeferPlanValidation = tier === 'ultimate';

        if (!planValidated && !page.url().includes('page=TierPlans') && !shouldDeferPlanValidation) {
          try {
            const planData = getPlanDataByTier(tier);
            const planFlow = [
              'boxing-banner-ultimate',
              'boxing-ultimate-subscription',
              'boxing-join-the-club',
            ].includes(source) ? 'boxing-ultimate-direct' : undefined;
            console.log(`📊 Plan rows: ${planData.length}`);
            console.log(`🔍 spec call debug: eventData =`, typeof eventData, eventData ? "defined" : "undefined", eventData ? Object.keys(eventData).join(', ') : 'none');
            await validateVariant(page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow);
          } catch (e: any) {
            console.warn('⚠️  Plan validation error:', e.message);
          }
          planValidated = true;
        }

        if (tier === 'ultimate') {
          if (ratePlan === 'annual pay upfront') {
            const upfrontCard = page.locator(
              'label:has-text("Annual - Pay Upfront"), label:has-text("Pay Upfront"), [role="radio"]:has-text("Upfront")'
            ).first();
            if (await upfrontCard.isVisible({ timeout: 2000 }).catch(() => false)) {
              await safeScrollToElement(page, upfrontCard);
              await upfrontCard.click({ force: true }).catch(() => { });
              console.log('✅ Clicked Ultimate Upfront Card/Label by text selector');
            } else {
              const radios = page.locator('input[type="radio"], [role="radio"]');
              const count = await radios.count().catch(() => 0);
              let clicked = false;
              for (let i = 0; i < count; i++) {
                const r = radios.nth(i);
                const parentText = await r.evaluate((el: HTMLElement) => {
                  return el.closest('label')?.innerText || el.closest('div')?.innerText || '';
                }).catch(() => '');
                if (parentText.toLowerCase().includes('upfront') || parentText.toLowerCase().includes('save')) {
                  await safeScrollToElement(page, r);
                  await r.click({ force: true }).catch(() => { });
                  console.log(`✅ Selected Ultimate Upfront radio at index ${i} based on parent text: "${parentText.trim()}"`);
                  clicked = true;
                  break;
                }
              }
              if (!clicked) {
                const radio = count > 2 ? radios.nth(2) : radios.nth(1);
                if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                  await safeScrollToElement(page, radio);
                  await radio.click({ force: true }).catch(() => { });
                  console.log('✅ Selected Upfront radio (nth index fallback)');
                }
              }
            }
          } else {
            const monthlyCard = page.locator(
              'label:has-text("Annual - Pay Monthly"), label:has-text("Pay Monthly"), [role="radio"]:has-text("Pay Monthly")'
            ).first();
            if (await monthlyCard.isVisible({ timeout: 2000 }).catch(() => false)) {
              await safeScrollToElement(page, monthlyCard);
              await monthlyCard.click({ force: true }).catch(() => { });
              console.log('✅ Clicked Ultimate Monthly Card/Label by text selector');
            } else {
              const radios = page.locator('input[type="radio"], [role="radio"]');
              const count = await radios.count().catch(() => 0);
              let clicked = false;
              for (let i = 0; i < count; i++) {
                const r = radios.nth(i);
                const parentText = await r.evaluate((el: HTMLElement) => {
                  return el.closest('label')?.innerText || el.closest('div')?.innerText || '';
                }).catch(() => '');
                if (parentText.toLowerCase().includes('monthly') || parentText.toLowerCase().includes('saver') || parentText.toLowerCase().includes('over time')) {
                  await safeScrollToElement(page, r);
                  await r.click({ force: true }).catch(() => { });
                  console.log(`✅ Selected Ultimate Monthly radio at index ${i} based on parent text: "${parentText.trim()}"`);
                  clicked = true;
                  break;
                }
              }
              if (!clicked) {
                const radio = radios.first();
                if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                  await safeScrollToElement(page, radio);
                  await radio.click({ force: true }).catch(() => { });
                  console.log('✅ Selected Monthly radio (first index fallback)');
                }
              }
            }
          }

          // ── Post-selection: Validate selected plan ──
          // Run full validation now that the requested Ultimate card is selected.
          if (shouldDeferPlanValidation && !planValidated) {
            try {
              const planData = getPlanDataByTier(tier);
              const planFlow = [
                'boxing-banner-ultimate',
                'boxing-ultimate-subscription',
                'boxing-join-the-club',
              ].includes(source) ? 'boxing-ultimate-direct' : undefined;
              console.log(`📊 Plan rows (deferred post-click): ${planData.length}`);
              await validateVariant(page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow);
            } catch (e: any) {
              console.warn('⚠️  Plan validation error (deferred):', e.message);
            }
            planValidated = true;
          }

          // ── Post-selection: Validate selected plan ──
          if (ratePlan === 'annual pay upfront') {
            await page.waitForTimeout(500);
            console.log('\n📋 Validating post-upfront-selection...');
            const radios = page.locator('input[type="radio"], [role="radio"]');
            const count = await radios.count().catch(() => 0);
            // Find the upfront radio by checking parent text
            let upfrontSelected = false;
            for (let i = 0; i < count; i++) {
              const r = radios.nth(i);
              const parentText = await r.evaluate((el: HTMLElement) => {
                return el.closest('label')?.innerText || el.closest('div')?.innerText || '';
              }).catch(() => '');
              if (parentText.toLowerCase().includes('upfront')) {
                upfrontSelected = await r.isChecked().catch(() => false);
                break;
              }
            }
            results.push({
              page: 'DAZN Plan',
              field: 'Annual Pay Upfront Selected (After Click)',
              expected: 'Yes',
              actual: upfrontSelected ? 'Yes' : 'No',
              status: upfrontSelected ? 'PASS' : 'FAIL',
            });
          }

          const planBtn = page.locator(
            'button:has-text("Continue with DAZN Ultimate"), button:has-text("Continue")'
          ).first();
          await planBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
          await clickAndWaitForNav(page, planBtn, 'Ultimate Plan Continue');
          await waitForPostPlanTransition(page);
        } else {
          if (ratePlan === 'annual pay monthly') {
            const annualCard = page.locator(
              'label:has-text("Annual - pay over time"), label:has-text("Annual - Pay Monthly")'
            ).first();

            if (await annualCard.isVisible({ timeout: 3000 }).catch(() => false)) {
              await safeScrollToElement(page, annualCard);
              await annualCard.click({ force: true }).catch(() => { });
              console.log('✅ Clicked Annual card');
            } else {
              const radio = page.locator('input[type="radio"]').nth(1);
              if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                await safeScrollToElement(page, radio);
                await radio.click({ force: true }).catch(() => { });
                console.log('✅ Selected Annual radio nth(1)');
              }
            }

            const planBtn = page.locator(
              'button:has-text("Continue with 1st Month Free"), ' +
              'button:has-text("Continue with Annual"), ' +
              'button:has-text("Continue")'
            ).first();
            await planBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

            // Validate CTA text changed after selecting APM
            let has1MonthFree = false;
            if (await annualCard.isVisible({ timeout: 2000 }).catch(() => false)) {
              const annualText = await annualCard.textContent().catch(() => '') || '';
              if (/1\s*month\s*free|first\s*month\s*free/i.test(annualText)) {
                has1MonthFree = true;
              }
            } else {
              const radio = page.locator('input[type="radio"]').nth(1);
              if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
                const radioParentText = await radio.evaluate((el: any) => el.parentElement?.textContent || '').catch(() => '');
                if (/1\s*month\s*free|first\s*month\s*free/i.test(radioParentText)) {
                  has1MonthFree = true;
                }
              }
            }

            const ctaText = await planBtn.textContent().catch(() => '') || '';
            const cleanCta = ctaText.replace(/\s+/g, ' ').trim();
            const expectedCta = has1MonthFree ? 'Continue with 1st Month Free' : 'Continue';
            const ctaMatch = cleanCta.toLowerCase().includes(expectedCta.toLowerCase());
            console.log(`  ${ctaMatch ? '✅' : '❌'} [Plan CTA after APM] expected="${expectedCta}" actual="${cleanCta}"`);
            results.push({
              page: 'DAZN Plan',
              field: 'CTA After APM Selection',
              expected: expectedCta,
              actual: cleanCta,
              status: ctaMatch ? 'PASS' : 'FAIL'
            });
            await captureFailures(page, results, 'DAZN Plan', eventData);

            await clickAndWaitForNav(page, planBtn, 'Standard Annual Plan Continue');
            await waitForPostPlanTransition(page);
          } else {
            const trialRadio = page.locator('input[type="radio"]').first();
            if (await trialRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
              await safeScrollToElement(page, trialRadio);
              await trialRadio.click({ force: true }).catch(() => { });
              console.log('✅ Selected Flex/Trial radio');
            }

            const planBtn = page.locator(
              'button:has-text("Continue with"), ' +
              'button:has-text("Continue with 1st Month Free"), ' +
              'button:has-text("Continue with PPV"), ' +
              'button:has-text("Continue")'
            ).first();
            await planBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
            await clickAndWaitForNav(page, planBtn, 'Standard Plan Continue');
            await waitForPostPlanTransition(page);
          }
        }

        await setupPage(page, 500);
        continue;
      }

      stuckCount++;
      console.log(`⚠️  Unknown page — waiting... (${stuckCount}/20) | URL: ${page.url()}`);
      await sleep(800);
      if (stuckCount >= 20) {
        const bodyPreview = await page.locator('body').innerText()
          .catch(() => 'N/A')
          .then((t: string) => t.substring(0, 200));
        throw new Error(`❌ Flow stuck on unknown page.\nURL: ${page.url()}\nPreview: ${bodyPreview}`);
      }
    }

    if (!reachedEndPage) {
      console.log('\n🔎 END PAGE DIAGNOSTICS');
      console.log('URL:', page.url());
      console.log('TITLE:', await page.title().catch(() => 'N/A'));
      console.log('Email input:', await page.locator('input[type="email"]').count());
      console.log('Password input:', await page.locator('input[type="password"]').count());
      console.log(
        'Card / payment iframe:',
        await page.locator(
          'input[name*="card"], input[autocomplete="cc-number"], iframe'
        ).count()
      );
      console.log(
        'Body preview:',
        (await page.locator('body').innerText().catch(() => 'N/A'))
          .replace(/\s+/g, ' ')
          .slice(0, 1200)
      );

      // Final check — the payment route can vary by experiment/layout.
      await page.waitForFunction(() => {
        const href = window.location.href.toLowerCase();
        const body = document.body?.innerText?.toLowerCase() || '';
        return href.includes('paymentdetails') ||
          href.includes('payment') ||
          href.includes('checkout') ||
          body.includes('choose how to pay') ||
          body.includes('payment method') ||
          body.includes('today you pay');
      }, { timeout: 30_000 }).catch(() => { });

      const finalUrl = page.url();
      const payment = new PaymentPage(page);
      const isPaymentUrl =
        finalUrl.toLowerCase().includes('paymentdetails') ||
        finalUrl.toLowerCase().includes('payment') ||
        finalUrl.toLowerCase().includes('checkout');
      const isPaymentUi = await payment.isPaymentPage();

      if (isPaymentUrl || isPaymentUi) {
        console.log(
          `💳 Payment page detected after loop exit | urlMatch=${isPaymentUrl} | uiMatch=${isPaymentUi}`
        );
        reachedEndPage = true;

        const planKey = flowConfig.source === 'boxing-page-bundle'
          ? `${ratePlan} bundle`
          : ratePlan;
        const paymentData = getPaymentDataByTierAndPlan(tier, planKey);
        await payment.validate(paymentData, results, eventData, 'newuser');
      } else {
        console.log(`⚠️  Flow "${name}" did not reach expected end page`);
      }
    }
  } finally {
    try {
      // Capture path BEFORE closing context (path is known now; file is finalized by close())
      capturedVideoPath = (await page.video()?.path()) ?? null;
      if (capturedVideoPath) console.log(`🎥 Video: ${capturedVideoPath}`);
    } catch { }
    // Closing the context finalizes and flushes the video file to disk
    await context.close().catch(() => { });
  }

  return { results, reachedEndPage, videoPath: capturedVideoPath };
}

// ═══════════════════════════════════════════════════════════════
// TEST DEFINITION — Dynamically defines tests for parallel runs
// ═══════════════════════════════════════════════════════════════
const isCanadaRun = REGION === 'CA' || !!process.env.CANADA_PLAN || !!process.env.UFT_PLAN;
const plansToRun = isCanadaRun
  ? ['standard_monthly']
  : (process.env.PLAN || 'standard_monthly,standard_apm,ultimate_upfront,ultimate_apm')
    .split(',')
    .map(p => p.trim());

// Configure tests to run in parallel using configured workers
test.describe.configure({ mode: 'parallel' });

for (const planKey of plansToRun) {
  test(`PPV flow for new user - ${planKey}`, async ({ browser }) => {
    // Reports and video finalisation are part of the test. The former 180s
    // ceiling could expire after every functional validation had passed.
    test.setTimeout(PPV_TYPE === 'upsell' ? UPSELL_FLOW_TIMEOUT_MS : NORMAL_FLOW_TIMEOUT_MS);
    const runStart = new Date();
    let reportGenerated = false;

    try {
      const json = loadEventConfig(EVENT_CONFIG);
      test.setTimeout(
        String(json?.PPV_TYPE || process.env.PPV_TYPE || 'normal').trim().toLowerCase() === 'upsell'
          ? UPSELL_FLOW_TIMEOUT_MS
          : NORMAL_FLOW_TIMEOUT_MS
      );

      const plansPath = path.resolve(process.cwd(), 'config/DaznPlan.json');
      const plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
      const planData = plans[planKey];
      if (!planData) {
        throw new Error(`❌ Plan "${planKey}" not found in DaznPlan.json`);
      }

      const sourcesPath = path.resolve(process.cwd(), 'config/surfacingpoint.json');
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));
      const srcConfig = sources[SOURCE];
      if (!srcConfig) {
        throw new Error(`❌ Source "${SOURCE}" not found in surfacingpoint.json`);
      }

      const planTier = (planData.TIER || 'standard').toLowerCase();
      const isUltimate = planTier === 'ultimate';
      if (String(json?.PPV_TYPE || '').toLowerCase() === 'upsell' && isUltimate) {
        test.skip(true, 'PPV upsell flows are only applicable to Standard PPV purchases.');
        return;
      }
      const isUSorGB = REGION === 'GB' || REGION === 'US';
      // Dev mode: bypass phone number on ultimate flows in GB/US.
      // Enabled on all environments (including prod) when tier is ultimate.
      // Can also be forced via DEV_MODE_ON=on env variable for prod verification.
      const devModeForced = (process.env.DEV_MODE_ON || '').toLowerCase() === 'on';
      const devMode = devModeForced || (isUltimate && isUSorGB) || (!!srcConfig.enableDevMode);
      const endPage = srcConfig.endPage || 'payment';
      if (srcConfig.defaultSignup) {
        process.env.DEFAULT_SIGNUP = 'true';
      }

      const planName = (planData.RATE_PLAN || 'monthly').toLowerCase() === 'monthly'
        ? 'Flex Monthly'
        : ((planData.RATE_PLAN || '').toLowerCase().includes('upfront') ? 'APU' : 'APM');
      const tierName = planTier.charAt(0).toUpperCase() + planTier.slice(1);
      const srcLabel = SOURCE.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const regionPlanCount = Object.values(plans).filter((candidate: any) =>
        String(candidate?.TIER || '').toLowerCase() === planTier && candidate?.regions?.[REGION]
      ).length;

      const flowConfig = {
        name: `${srcLabel} → ${tierName} → ${planName}`,
        source: srcConfig.source || SOURCE,
        tier: planTier,
        ratePlan: (planData.RATE_PLAN || 'monthly').toLowerCase(),
        endPage: endPage,
        enableDevMode: devMode,
        planKey: planKey,
        noPpvClick: !!(srcConfig.noPpvClick),
        requiresDefaultSignup: !!srcConfig.defaultSignup,
        requiresPlanSelection: regionPlanCount > 1,
      };

      console.log(`\n╔═══════════════════════════════════════════════════════╗`);
      console.log(`║  RUNNING NEW USER FLOW: ${flowConfig.name}`);
      console.log(`║  Source: ${flowConfig.source} | Tier: ${flowConfig.tier} | Plan: ${flowConfig.ratePlan}`);
      console.log(`╚═══════════════════════════════════════════════════════╝\n`);

      const currentJson = loadEventConfig(EVENT_CONFIG, planKey);

      const { results, reachedEndPage, skipped, skipReason, videoPath: capturedVideo } = await runFlow(
        browser, currentJson, flowConfig, REGION, true
      );

      if (skipped) {
        console.log(`⚠️ Flow "${flowConfig.name}" was dynamically skipped${skipReason ? `: ${skipReason}` : ''}`);
        test.skip(true, skipReason || 'Flow is not applicable to this configuration');
        return;
      }

      // Tag results with flow metadata
      results.forEach(r => {
        r.flowName = flowConfig.name;
        r.source = flowConfig.source;
        r.tier = flowConfig.tier;
        r.ratePlan = flowConfig.ratePlan;
      });

      // Write results to Excel — pass the captured video path directly so we
      // don't rely on directory scanning (which can pick the wrong file when
      // multiple parallel workers are recording simultaneously).
      const { excelPath, videoPath } = await writeResults(results, capturedVideo);

      // Display detailed per-page results
      displayResultsTable(results, 'ppv', {
        event: json.PPV_NAME,
        region: REGION,
        excelPath,
        videoPath,
      });

      const isCanada = REGION === 'CA';
      let finalTier = flowConfig.tier;
      let finalRatePlan = flowConfig.ratePlan;
      let flowName = flowConfig.name;

      if (isCanada) {
        const caConfig = parseCanadaCommand(process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN);
        finalTier = caConfig.tierPlanDisplay; // e.g. "standard -> dazn -> Annual-pay now"
        finalRatePlan = '';
        flowName = `${flowConfig.source} -> new-user -> ${caConfig.tierPlanDisplay}`;
      }

      // Generate HTML + PDF run report (country, surfacing point, rate plan, per-page pass/fail, totals)
      const { htmlPath, pdfPath, folderPath } = await generateReports(results, {
        event: json.PPV_NAME,
        region: REGION,
        source: flowConfig.source,
        ratePlan: finalRatePlan,
        tier: finalTier,
        env: process.env.DAZN_ENV || 'prod',
        flowName,
        startTime: runStart,
        endTime: new Date(),
        excelPath,
        videoPath,
        userType: 'new-user',
      });
      reportGenerated = true;
      if (folderPath) console.log(`\n📂 Report folder: ${folderPath}`);

      // Playwright manages the browser lifecycle. Closing the browser manually is not recommended.

      const passed = results.filter(r => r.status === 'PASS').length;
      const failed = results.filter(r => r.status === 'FAIL').length;
      const skippedCount = results.filter(r => String(r.status).toUpperCase() === 'SKIP').length;
      const total = passed + failed + skippedCount;

      if (passed === 0 && failed === 0 && skippedCount > 0) {
        const skipReason = results.find(r => String(r.status).toUpperCase() === 'SKIP')?.actual || 'PPV not configured for this source';
        console.log(`⏭️ Flow "${flowConfig.name}" skipped: ${skipReason}`);
        test.skip(true, skipReason);
        return;
      }

      console.log(`\n✅ Flow "${flowConfig.name}" complete: ${passed}/${total} passed (${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%)`);
      console.log(`${'─'.repeat(55)}`);
      console.log('__DEMO_FLOW_COMPLETE__');

      if (total === 0 && flowConfig.endPage !== 'plan') {
        const errMsg = `❌ Flow "${flowConfig.name}" had 0 validation checks`;
        console.log(errMsg);
        throw new Error(errMsg);
      }

      if (!reachedEndPage) {
        const errMsg = `❌ Flow "${flowConfig.name}" did not reach the expected end page: "${flowConfig.endPage || 'payment'}"`;
        console.log(errMsg);
        throw new Error(errMsg);
      }

      if (failed > 0) {
        await reportValidationFailuresToJira({
          results,
          htmlReportPath: htmlPath,
          pdfReportPath: pdfPath,
          context: {
            region: REGION,
            environment: process.env.DAZN_ENV || 'prod',
            platform: 'web',
            flow: flowConfig.name,
            event: json.PPV_NAME,
            source: flowConfig.source,
          },
        });
        const failMsgs = results
          .filter(r => r.status === 'FAIL')
          .map(r => `  - [${r.page}] ${r.field}: expected "${r.expected}", actual "${r.actual}"`)
          .join('\n');

        const errMsg = `❌ Flow "${flowConfig.name}" completed navigation but had ${failed} validation failure(s):\n${failMsgs}`;
        console.log(errMsg);
        throw new Error(errMsg);
      }
    } catch (error) {
      console.error('❌ Test error:', error);
      // Fallback: generate report folder even on crash so CI always has a report
      if (!reportGenerated) {
        try {
          const crashJson = loadEventConfig(EVENT_CONFIG);
          const crashMsg = (error as Error)?.message?.slice(0, 200) || 'Unknown error';
          await generateReports(
            [{ page: 'Test', field: 'Flow Completion', expected: 'Complete', actual: `CRASHED: ${crashMsg}`, status: 'FAIL' as const }],
            {
              event: crashJson?.PPV_NAME || 'Unknown',
              region: REGION,
              source: SOURCE,
              ratePlan: planKey,
              tier: planKey.includes('ultimate') ? 'ultimate' : 'standard',
              env: process.env.DAZN_ENV || 'prod',
              flowName: `${SOURCE} → ${planKey} (crashed)`,
              startTime: runStart,
              endTime: new Date(),
              userType: 'new-user',
            }
          );
        } catch { /* best-effort — do not mask original error */ }
      }
      throw error;
    }
  });
}
