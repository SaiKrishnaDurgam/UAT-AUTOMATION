// ─────────────────────────────────────────────────────────────────────────────
// DAZN PPV — iOS Appium Handoff Test
//
// DEVICE: iOS Simulator / Real Device (configured in config/wdio.ios.conf.ts)
// EVENT:  Joshua vs. Prenga
//
// FLOW:
//   1. Open DAZN app
//   2. Dismiss system dialogs & landing page interstitials
//   3. Navigates to Buy button based on SOURCE env var:
//        landing-page-banner     → Hero banner → Buy
//        schedule                → Bottom tab → Schedule → scroll to boxing → find PPV tile → Buy
//        home-boxing-upcoming    → Home Boxing filter → Upcoming Fights → Buy
//        home-boxing-banner      → Home hero banner → Buy
//        home-boxing-tile        → Home Boxing rail → Buy
//        home-page-dont-miss     → Home → Don't Miss rail → PPV tile → Buy
//        search                  → Search icon/tab → Search for event → find PPV tile → Buy
//   4. App opens Safari View Controller or Safari with DAZN checkout URL
//   5. Captures URL via WebView context switch or Safari address bar fallback
//   6. Validates the URL landed in Safari and writes it to mobile_entry_url.txt
//   7. Continues the welcome, signup, plan, and payment journey in Safari's
//      WebdriverIO context (no desktop Playwright browser is used)
//
// HOW TO RUN:
//   cd appium
//   IOS_DEVICE_MODE=real IOS_UDID=<udid> SOURCE=landing-page-banner npx wdio run config/wdio.ios.conf.ts --spec tests/ios/newuserios.spec.ts
// ─────────────────────────────────────────────────────────────────────────────

// WebdriverIO injects `browser` as a global at runtime — declare so TS is happy.
// eslint-disable-next-line no-var
declare var browser: any;
type WdBrowser = any;
type WdElement = any;

import { writeHandoffUrl, clearHandoffUrl } from '../../utils/handoff';
import { prepareIosApp, waitForHomePage } from '../../utils/iosSetup';
import { startIOSRecording, stopIOSRecording } from '../../utils/iosVideoRecorder';
import { loadEventConfig, EventConfig } from '../../utils/eventLoader';
import { openSchedulePPVPaywall } from '../../pages/ios/IOSSchedulePage';
import { IOSSearchPage, openSearchResultPaywall } from '../../pages/ios/IOSSearchPage';
import {
  openHomeBoxingBannerPaywall,
  openHomeBoxingUpcomingPaywall,
  openHomeBoxingDontMissTilePaywall,
} from '../../pages/ios/IOSBoxingPage';
import { completeNativeSignup } from '../../pages/ios/IOSMyAccountPage';
import { openHomeBannerPaywall, openGenericPPVPaywall, openHomePageDontMissPaywall, openHomePagePopupPaywall, openDaznTilePaywall } from '../../pages/ios/IOSHomePage';
import { openLandingBannerPaywall } from '../../pages/ios/IOSLandingPage';
import { getIOSBrowserReentry, getIOSSurfacingPoint, getIOSValidationSheet } from '../../pages/ios/IOSSurfacingPoint';
import {
  validateMobilePaywallPage,
  validateMobileBannerOrTilePage,
  IOSValidationResult,
} from '../../pages/ios/IOSValidationPage';
import {
  IOSFlowHooks,
  captureCheckoutUrl as sharedCaptureCheckoutUrl,
  openCapturedUrlInNewSafariTab as sharedOpenCapturedUrlInNewSafariTab,
  findEl as sharedFindEl,
  findPPVBanner as sharedFindPPVBanner,
  isVisible as sharedIsVisible,
  scrollDown as sharedScrollDown,
  scrollToText as sharedScrollToText,
  swipeLeft as sharedSwipeLeft,
  tapByText as sharedTapByText,
} from '../../pages/ios/IOSBasePage';

// ── Config ───────────────────────────────────────────────────────────────────
// Resolve the configured event before any page objects are constructed.  The
// old default of "Joshua" made PPV_EVENT=ppv_t_moses_hergovich validate and
// search for two different events.
const SELECTED_EVENT: EventConfig = loadEventConfig();
const PPV_NAME    = process.env.PPV_NAME    || SELECTED_EVENT.PPV_NAME;
process.env.PPV_NAME = PPV_NAME;
const SOURCE      = (process.env.SOURCE || 'landing-page-banner').trim().toLowerCase();
const SURFACING_POINT = getIOSSurfacingPoint(SOURCE);
const REGION = process.env.DAZN_REGION || 'GB';
const MODE = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase();
const BUNDLE_ID = process.env.DAZN_BUNDLE_ID || (MODE === 'real' ? 'com.dazn.theApp' : 'com.dazn.enterprise');

// ── Direct aliases for shared utilities ─────────
const isVisible = sharedIsVisible;
const captureCheckoutUrl = sharedCaptureCheckoutUrl;
const openCapturedUrlInNewSafariTab = sharedOpenCapturedUrlInNewSafariTab;

async function findEl(driver: WdBrowser, sel: string, timeoutMs = 10000): Promise<WdElement> {
  return sharedFindEl(driver, sel, timeoutMs);
}
async function tapByText(driver: WdBrowser, text: string, timeoutMs = 10000): Promise<boolean> {
  return sharedTapByText(driver, text, timeoutMs);
}
async function findPPVBanner(driver: WdBrowser): Promise<boolean> {
  return sharedFindPPVBanner(driver, PPV_NAME);
}
async function scrollDown(driver: WdBrowser): Promise<void> {
  return sharedScrollDown(driver);
}

const iosAvailabilityResults: IOSValidationResult[] = [];
let iosAvailabilityReportGenerated = false;

function iosAvailabilityPageName(source = SOURCE): string {
  if (source.includes('landing')) return 'Landing';
  if (source.includes('schedule')) return 'Schedule';
  if (source.includes('search')) return 'Search';
  if (source.includes('boxing')) return 'Home of Boxing';
  if (source.includes('home')) return 'Home Page';
  return 'iOS';
}

function iosAvailabilityCheckName(source = SOURCE): string {
  const surface = source.includes('banner') ? 'banner' : 'tile';
  return `${PPV_NAME} ${surface}`;
}

function recordIOSPPVAvailability(available: boolean, screenshot?: string, page?: string): void {
  // Surface validation already records successful source checks from the
  // source worksheet. Keep this availability row only for failure reports.
  if (available) return;
  const pageName = page || iosAvailabilityPageName();
  const field = iosAvailabilityCheckName();
  const existingIndex = iosAvailabilityResults.findIndex(
    r => r.page === pageName && r.field === field,
  );
  const row: IOSValidationResult = {
    page: pageName,
    field,
    expected: PPV_NAME,
    actual: available ? PPV_NAME : `${PPV_NAME} not available`,
    status: available ? 'PASS' as const : 'FAIL' as const,
    screenshot,
  };

  if (existingIndex >= 0) {
    iosAvailabilityResults[existingIndex] = row;
  } else {
    iosAvailabilityResults.push(row);
  }
}

async function saveIOSScreenshot(driver: WdBrowser, relativePath: string): Promise<string | undefined> {
  try {
    await driver.saveScreenshot(relativePath);
    const path = require('path');
    return path.resolve(process.cwd(), relativePath);
  } catch {
    return undefined;
  }
}

async function generateIOSAvailabilityFailureReport(errorMessage: string, executionFailure = false): Promise<void> {
  if (iosAvailabilityReportGenerated) return;
  iosAvailabilityReportGenerated = true;

  if (!iosAvailabilityResults.length) {
    if (executionFailure) {
      iosAvailabilityResults.push({
        page: 'iOS',
        field: 'Test execution',
        expected: 'Test completes and report is generated',
        actual: errorMessage,
        status: 'FAIL',
      });
    } else {
      recordIOSPPVAvailability(false);
    }
  }

  const originalCwd = process.cwd();
  try {
    const path = require('path');
    const projectRoot = path.resolve(__dirname, '../../..');
    process.chdir(projectRoot);

    const { writeResults } = require('../../../utils/excelWriter');
    const { generateReports } = require('../../../utils/reportGenerator');
    const { displayResultsTable } = require('../../../utils/resultsDisplay');

    const srcLabel = SOURCE.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const rows = iosAvailabilityResults.map(r => ({
      ...r,
      flowName: `iOS New User: ${srcLabel}`,
      source: SOURCE,
      tier: 'standard',
      ratePlan: 'monthly',
    }));

    const videoOutputPath = await stopIOSRecording(browser);
    const { excelPath, videoPath } = await writeResults(rows, videoOutputPath);
    displayResultsTable(rows, 'ppv', {
      event: PPV_NAME,
      region: REGION,
      excelPath,
      videoPath,
    });
    await generateReports(rows, {
      event: PPV_NAME,
      region: REGION,
      source: SOURCE,
      ratePlan: 'monthly',
      tier: 'standard',
      env: (process.env.DAZN_ENV || 'stag').toLowerCase(),
      flowName: `iOS New User: ${srcLabel}`,
      startTime: new Date(),
      endTime: new Date(),
      excelPath,
      videoPath,
      userType: 'new-user',
      userStatus: 'new',
      platform: 'iOS',
    });
    console.log(`📊 iOS PPV availability failure report generated: ${errorMessage}`);
  } catch (reportErr: any) {
    console.error(`⚠️ Failed to generate iOS availability failure report: ${reportErr.message}`);
  } finally {
    process.chdir(originalCwd);
  }
}

// ─── Test Definition ───
describe('DAZN iOS PPV — New User Handoff Flow', () => {
  before(async () => {
    clearHandoffUrl();
    require('fs').mkdirSync('./test-results/gemini-banner', { recursive: true });

    // Record the complete native journey, including DAZN launch and startup
    // dialogs, rather than beginning only after Home is ready.
    await startIOSRecording(browser);

    const shouldWaitHome = SOURCE !== 'landing-page-banner' && SOURCE !== 'home-page-popup';
    const clearData = SOURCE === 'landing-page-banner' || SOURCE === 'home-page-popup';
    await prepareIosApp(browser, { clearAppData: clearData, waitForHome: shouldWaitHome });

    console.log(`\n╔════════════════════════════════════════════════════╗`);
    console.log(`║  DAZN iOS PPV Handoff                              ║`);
    console.log(`║  Event  : ${PPV_NAME.padEnd(40)}║`);
    console.log(`║  Source : ${SOURCE.padEnd(40)}║`);
    console.log(`║  Surface: ${SURFACING_POINT.page.padEnd(40)}║`);
    console.log(`╚════════════════════════════════════════════════════╝\n`);
  });

  it('navigates to PPV buy button, opens Safari, captures checkout URL', async () => {
    const driver = browser;

    console.log('✅ Startup handled by prepareIosApp; beginning PPV navigation');

    const fs = require('fs');
    const path = require('path');
    const { loadEventConfig } = require('../../../utils/testHelpers');
    const { buildEventData } = require('../../../utils/buildEventData');

    const EVENT_CONFIG = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
    const PLAN = process.env.PLAN || 'standard_monthly';
    const ENV = (process.env.DAZN_ENV || 'stag').toLowerCase();
    const PAYMENT_METHOD = (process.env.PAYMENT_METHOD || 'credit_card').toLowerCase();

    // Use the same config-loader entry point as the web flow, including the
    // requested PLAN.  Loading the event alone silently defaults to
    // standard_monthly, which makes Safari validate the wrong prices, offers
    // and payment copy for APM/APU and Ultimate journeys.
    const json = loadEventConfig(EVENT_CONFIG, PLAN);

    const plansPath = path.resolve(__dirname, '../../..', 'config/DaznPlan.json');
    const plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
    const planData = plans[PLAN];
    if (!planData) {
      throw new Error(`❌ Plan "${PLAN}" not found in DaznPlan.json`);
    }

    const planTier = (planData.TIER || 'standard').toLowerCase();
    const ratePlan = (planData.RATE_PLAN || 'monthly').toLowerCase();
    const isStandalonePPV = String(json.PPV_TYPE || process.env.PPV_TYPE || '').toLowerCase() === 'standalone';
    if (isStandalonePPV && (planTier === 'ultimate' || !['monthly', 'annual pay monthly'].includes(ratePlan))) {
      throw new Error(
        `Standalone PPV supports only Standard monthly or Annual Pay Monthly plans; received "${PLAN}".`,
      );
    }
    // IOSSignupPage performs the Safari contextual-plan selection. Keep its
    // choice aligned with the canonical DaznPlan.json entry used to build the
    // validations, rather than relying on a default inferred from the URL.
    process.env.TIER = planTier;
    process.env.RATE_PLAN = ratePlan;

    // ── DefaultSignup early skip — mirrors Android + web ──
    const surfacingPointPath = path.resolve(__dirname, '../../config/surfacingpoint.json');
    if (fs.existsSync(surfacingPointPath)) {
      const sources = JSON.parse(fs.readFileSync(surfacingPointPath, 'utf-8'));
      if (sources[SOURCE]?.defaultSignup && json?.HAS_DEFAULT_SIGNUP_PPV !== true && !json?.DEFAULT_SIGNUP_DEVMODE) {
        console.log(`ℹ️ SOURCE "${SOURCE}" requires HAS_DEFAULT_SIGNUP_PPV: true; selected event does not enable PPV in the default signup journey. Skipping.`);
        return;
      }
      if (sources[SOURCE]?.defaultSignup) {
        process.env.DEFAULT_SIGNUP = 'true';
      }
    }

    // Merge mobile overrides
    let mobileRegional = {};
    try {
      let mobileConfigPath = path.resolve(__dirname, '../../config/events', EVENT_CONFIG);
      if (!fs.existsSync(mobileConfigPath) && json.eventKey) {
        mobileConfigPath = path.resolve(__dirname, '../../config/events', `${json.eventKey}.json`);
      }
      if (fs.existsSync(mobileConfigPath)) {
        const mobileJson = JSON.parse(fs.readFileSync(mobileConfigPath, 'utf8'));
        // Merge top-level fields (e.g. SPORT) from mobile config
        if (mobileJson.SPORT) json.SPORT = mobileJson.SPORT;
        if (mobileJson.PPV_ENTITLEMENT_ID) json.PPV_ENTITLEMENT_ID = mobileJson.PPV_ENTITLEMENT_ID;
        mobileRegional = mobileJson.regions?.[REGION] || {};
        json.regions = json.regions || {};
        json.regions[REGION] = { ...json.regions[REGION], ...mobileRegional };
        console.log(` Merged mobile overrides into eventData`);
      }
    } catch (e: any) {
      console.warn(` Failed to load mobile overrides: ${e.message}`);
    }

    const eventData = buildEventData(json, REGION, planTier, ratePlan.replace(/-/g, ' '), SOURCE);
    eventData.USER_EMAIL = '';
    eventData.USER_STATE = 'new';
    eventData.source = SOURCE;
    eventData.SOURCE = SOURCE;
    eventData.MOBILE_WEB_HANDOFF = 'true';
    Object.assign(eventData, mobileRegional);

    if (SOURCE === 'home-page-popup') {
      const newEmail = process.env.NEW_USER_EMAIL ||
        `newuser.ios.${Date.now()}.${Math.random().toString(36).slice(2, 10)}@yopmail.com`;
      const password = process.env.IOS_NEW_USER_PASSWORD || 'Dazn@1234';
      await completeNativeSignup(driver, {
        email: newEmail,
        firstName: process.env.IOS_NEW_USER_FIRST_NAME || 'UAT',
        lastName: process.env.IOS_NEW_USER_LAST_NAME || 'User',
        password,
      });
      // Safari does not share the app's authentication session. Reuse the
      // account created in the native flow when the contextual URL requests
      // sign-in, without re-entering the generic Welcome journey.
      process.env.USER_EMAIL = newEmail;
      process.env.USER_PASSWORD = password;
      await waitForHomePage(driver, 120000, { preservePpvPopup: true });
    }

    // Keep Safari's shared Excel validation data aligned with the established
    // web flow. The workbook uses these derived fields as {{...}} templates;
    // without them, the iOS report records literal placeholders instead of
    // validating the selected plan.
    const offerType = String(eventData.OFFER_TYPE || '1_month_free').toLowerCase();
    const isNoOffer = offerType === 'no_offer' || offerType === 'none';
    const activeOfferPresent = String(eventData.ACTIVE_OFFER_PRESENT || '').toLowerCase() === 'true';
    eventData.DAZN_TIER = planTier === 'ultimate' ? 'DAZN Ultimate' : 'DAZN Standard';
    eventData.PLAN_CTA_BUTTON = planTier === 'ultimate'
      ? (eventData.PLAN_CTA_BUTTON_ULTIMATE || 'Continue with DAZN Ultimate')
      : (offerType === '1_month_free' && ratePlan.includes('annual')
        ? 'Continue with 1st Month Free'
      : (isNoOffer
        ? (eventData.PLAN_CTA_BUTTON_STANDARD || 'Continue with DAZN Standard')
        : (eventData.PLAN_CTA_BUTTON_STANDARD || `Continue with ${eventData.FREE_TRIAL_DAYS || '7'}-day Free Trial`)));

    if (activeOfferPresent && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_LABEL || 'Flex – Pay Monthly - First Month Only';
      eventData.PAYMENT_FREE_TEXT = 'N/A';
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (/^\d+_day_trial$/.test(offerType) && planTier === 'standard' && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_TRIAL || 'Choose how to pay after your free trial';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_FREE_TEXT_TRIAL || `${eventData.FREE_TRIAL_DAYS || '7'}-days free`;
      eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_TRIAL || `${eventData.FREE_TRIAL_DAYS || '7'}-days free`;
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (ratePlan === 'annual pay monthly' || ratePlan === 'annual pay upfront') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_ANNUAL ||
        (ratePlan === 'annual pay upfront' ? 'Annual - Pay Upfront' : 'Annual - Pay Monthly');
      eventData.PAYMENT_FREE_TEXT = offerType === '1_month_free'
        ? (eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free')
        : 'N/A';
      eventData.CANCELLATION_TEXT = planTier === 'ultimate'
        ? (ratePlan === 'annual pay monthly'
          ? (eventData.CANCELLATION_TEXT_ULTIMATE_APM || '')
          : (eventData.CANCELLATION_TEXT_ULTIMATE_APU || ''))
        : (eventData.CANCELLATION_TEXT_ANNUAL || '');
    } else {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_FLEX || 'Flex – Pay Monthly';
      eventData.PAYMENT_FREE_TEXT = isNoOffer ? 'N/A' : (eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free');
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    }
    eventData.DAZN_REGION = REGION;

    let buyTapped = false;
    let paywallValidatedRef = { value: false };

    async function validateMobilePaywall() {
      await validateMobilePaywallPage(driver, eventData, SOURCE, iosAvailabilityResults, paywallValidatedRef);
    }

    async function validateMobileBannerOrTile(surface: 'PPV Banner' | 'PPV Tile') {
      await validateMobileBannerOrTilePage(driver, surface, eventData, SOURCE, iosAvailabilityResults);
    }

    const iosFlowHooks: IOSFlowHooks = {
      validateSurface: validateMobileBannerOrTile,
      validatePaywall: validateMobilePaywall,
      recordAvailability: recordIOSPPVAvailability,
      saveScreenshot: (relativePath) => saveIOSScreenshot(driver, relativePath),
      generateAvailabilityFailureReport: generateIOSAvailabilityFailureReport,
    };

    // ── landing-page-banner ───────────────────────────────────────────────
    if (SOURCE === 'landing-page-banner') {
      console.log('  Landing page banner flow: find PPV banner, buy, validate.');
      buyTapped = await openLandingBannerPaywall(driver, PPV_NAME, iosFlowHooks);

      // Perform Gemini AI visual check on the captured iOS landing page banner
      const screenshotPath = path.resolve(process.cwd(), 'test-results', 'ios_landing_ppv_banner_found.png');
      if (fs.existsSync(screenshotPath)) {
        console.log(`🤖 [Gemini] Starting visual validation of iOS landing page banner: ${screenshotPath}`);
        const mockBanner = {
          screenshot: async () => fs.readFileSync(screenshotPath)
        };
        try {
          const { validatePpvBannerImage } = require('../../../utils/geminiBannerValidator');
          const geminiResult = await validatePpvBannerImage(mockBanner, {
            region: REGION,
            flow: 'landing-page-banner',
          });

          if (geminiResult) {
            console.log(`🤖 [Gemini] Visual validation complete. Passed: ${geminiResult.passed}`);
            iosAvailabilityResults.push({
              page: 'Landing Page',
              field: 'Visual Banner Quality (Gemini)',
              expected: 'pass',
              actual: geminiResult.passed ? 'pass' : 'fail',
              status: geminiResult.passed ? 'PASS' : 'FAIL',
            });
          }
        } catch (err: any) {
          console.error(`⚠️ [Gemini] Visual validation failed with error: ${err.message}`);
        }
      }
    }
    // ── schedule ────────────────────────────────────────────────────────────
    else if (SOURCE === 'schedule') {
      buyTapped = await openSchedulePPVPaywall(driver, PPV_NAME, eventData, iosFlowHooks);
    }
    // ── search ────────────────────────────────────────────────────────────
    else if (SOURCE === 'search') {
      let searchQuery = PPV_NAME;
      if (searchQuery.includes(':')) {
        searchQuery = searchQuery.split(':').pop()?.trim() || searchQuery;
      }
      searchQuery = searchQuery.replace(/\./g, '');
      buyTapped = await openSearchResultPaywall(driver, PPV_NAME, searchQuery, iosFlowHooks, eventData);
    }
    // ── home-boxing-upcoming ────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-upcoming') {
      buyTapped = await openHomeBoxingUpcomingPaywall(driver, PPV_NAME, json, iosFlowHooks);
    }
    // ── home-boxing-banner ────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-banner') {
      buyTapped = await openHomeBoxingBannerPaywall(driver, PPV_NAME, json, iosFlowHooks);
    }
    // ── home-boxing-tile ──────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-tile') {
      buyTapped = await openHomeBoxingDontMissTilePaywall(driver, PPV_NAME, json, iosFlowHooks);
    }
    // ── home-page-banner ──────────────────────────────────────────────────
    else if (SOURCE === 'home-page-banner') {
      buyTapped = await openHomeBannerPaywall(driver, PPV_NAME, iosFlowHooks);
    }
    // ── home-page-dont-miss ───────────────────────────────────────────────
    else if (SOURCE === 'home-page-dont-miss') {
      buyTapped = await openHomePageDontMissPaywall(driver, PPV_NAME, iosFlowHooks);
    }
    // ── home-page-popup ─────────────────────────────────────────────────────
    else if (SOURCE === 'home-page-popup') {
      buyTapped = await openHomePagePopupPaywall(driver, PPV_NAME, iosFlowHooks, eventData);
    }
    // ── home-page-dazntile / subscribe-without-pay-per-view ──────────────
    else if (SOURCE === 'home-page-dazntile' || SOURCE === 'subscribe-without-pay-per-view') {
      buyTapped = await openDaznTilePaywall(driver, iosFlowHooks);
    }
    // Do not substitute a Home flow for an unsupported source.  A run must
    // exercise exactly the source supplied in SOURCE.
    else {
      throw new Error(`Unsupported iOS SOURCE="${SOURCE}". No fallback navigation is allowed.`);
    }

    if (!buyTapped) {
      await driver.saveScreenshot('./test-results/ios_buy_not_found.png');
      throw new Error(`❌ Could not tap Buy CTA. SOURCE="${SOURCE}". See test-results/ios_buy_not_found.png`);
    }

    // ── Capture checkout URL ─────────────────────────────────────────────
    console.log("📋 Capturing checkout URL from Safari...");
    if (!paywallValidatedRef.value) {
      console.warn('⚠️ Native paywall validation was not recorded by this source flow before URL capture.');
    }

    const checkoutUrl = await captureCheckoutUrl(driver);

    if (checkoutUrl && (checkoutUrl.includes("dazn.com") || checkoutUrl.includes("amazonaws.com"))) {
      console.log("✅ Checkout URL captured successfully");
    } else {
      await driver.saveScreenshot("./test-results/ios_url_not_found.png");
      throw new Error(`❌ Could not capture checkout URL from Safari.\n   Got: ${checkoutUrl}`);
    }

    console.log(`\n🌐 Checkout URL captured:\n   ${checkoutUrl}\n`);

    writeHandoffUrl(checkoutUrl);
    console.log("✅ URL written to mobile_entry_url.txt");

    const safariContext = await openCapturedUrlInNewSafariTab(driver, checkoutUrl);

    // Continue in the newly opened native Safari tab. Do not terminate DAZN or
    // create a desktop Playwright browser: both sever the iOS journey.
    const { configureExcelPathForEvent } = require('../../../utils/excelReader');
    configureExcelPathForEvent(json.eventKey || '');

    // Keep Safari validations in the shared accumulator so a later checkout
    // failure still produces a complete report instead of a native-only one.
    const safariResults = iosAvailabilityResults;
    const browserReentry = getIOSBrowserReentry(SOURCE);
    if (!browserReentry.supported) {
      throw new Error(`iOS Safari re-entry via welcome page is not yet verified for SOURCE="${SOURCE}". Add it to getIOSBrowserReentry() in IOSSurfacingPoint.ts once confirmed on device.`);
    }
    await new IOSSearchPage(driver, PPV_NAME).continueSafariCheckout({
      capturedUrl: checkoutUrl,
      safariContext,
      eventName: PPV_NAME,
      results: safariResults,
      eventData: eventData,
    });
    const { writeResults } = require('../../../utils/excelWriter');
    const { displayResultsTable } = require('../../../utils/resultsDisplay');
    const { generateReports } = require('../../../utils/reportGenerator');
    const videoOutputPath = await stopIOSRecording(driver);
    const { excelPath, videoPath } = await writeResults(safariResults, videoOutputPath);
    displayResultsTable(safariResults, 'ppv', { event: json.PPV_NAME, region: REGION, excelPath, videoPath });
    await generateReports(safariResults, {
      event: json.PPV_NAME, region: REGION, source: SOURCE, ratePlan, tier: planTier,
      env: ENV, flowName: `iOS Safari: ${SOURCE}`, startTime: new Date(), endTime: new Date(),
      excelPath, videoPath, userType: 'new-user', platform: 'iOS',
    });

    // ── Check for failures (same as web) ──────────────────────────
    const passed = safariResults.filter((r: any) => r.status === 'PASS').length;
    const failed = safariResults.filter((r: any) => r.status === 'FAIL').length;
    const total = passed + failed;
    console.log(`\n📊 iOS Safari flow complete: ${passed}/${total} passed, ${failed} failed`);
    if (failed > 0) {
      throw new Error(`❌ ${failed} of ${total} Safari web validation(s) failed. See report for details.`);
    }
  });



  after(async function () {
    try {
      const videoPath = await stopIOSRecording(browser);
      const failed = this.currentTest?.state === 'failed';
      if (videoPath && failed) {
        await generateIOSAvailabilityFailureReport(
          this.currentTest?.err?.message || 'iOS test failed before report generation',
          true,
        );
      } else if (videoPath) {
        console.log(`🎥 Failure/debug video available: ${videoPath}`);
      }
    } catch {}
  });
});
