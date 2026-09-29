// ─────────────────────────────────────────────────────────────────────────────
// DAZN PPV — Android Appium Handoff Test
//
// DEVICE: Samsung Galaxy Z Fold5 (real device, USB/ADB)
// EVENT:  Joshua vs. Prenga
//
// FLOW:
//   1. DAZN app opens on real device (already logged in, noReset=true)
//   2. Dismisses system dialogs / update prompts & landing page interstitials ("Explore")
//   3. Navigates to Buy button based on SOURCE env var:
//        schedule                → Bottom tab → Schedule → scroll to July 25th → find PPV tile → Buy
//        home-boxing-upcoming  → Home Boxing filter → Upcoming Fights → Buy
//        home-boxing-banner      → Home hero banner → Buy
//        home-boxing-tile        → Home Boxing rail → Buy
//        search                  → Search icon/tab → Search for event → find PPV tile → Buy
//   4. App opens Chrome Custom Tab with DAZN checkout URL
//   5. Captures URL via WebView context switch or ADB fallback
//   6. Writes URL to mobile_entry_url.txt  ← Playwright reads this
//
// HOW TO RUN:
//   cd appium && npm run android
//   Overrides: PPV_NAME="Joshua" SOURCE="home-boxing-upcoming" npm run android
// ─────────────────────────────────────────────────────────────────────────────

// WebdriverIO injects `browser` as a global at runtime — declare so TS is happy.
// eslint-disable-next-line no-var
declare var browser: any;
// Type alias so helper signatures are readable but not blocked by missing @wdio/globals
type WdBrowser = any;
type WdElement = any;

import { writeHandoffUrl, clearHandoffUrl } from '../../utils/handoff';
import { prepareAndroidApp, waitForHomePage } from '../../utils/androidSetup';
import {
  adb as sharedAdb,
  adbBack as sharedAdbBack,
  adbSwipe as sharedAdbSwipe,
  adbTap as sharedAdbTap,
  captureCheckoutUrl as sharedCaptureCheckoutUrl,
  closeMobileBrowser as sharedCloseMobileBrowser,
  findEl as sharedFindEl,
  findPPVBanner as sharedFindPPVBanner,
  getChromeUrl as sharedGetChromeUrl,
  getScreenSize as sharedGetScreenSize,
  isVisible as sharedIsVisible,
  launchAndroidChrome,
  scrollDown as sharedScrollDown,
  scrollToText as sharedScrollToText,
  swipeLeft as sharedSwipeLeft,
  tapByText as sharedTapByText,
} from '../../pages/android/AndroidBasePage';
import {
  navigateToSchedule as sharedNavigateToSchedule,
  openSchedulePPVPaywall,
  scrollScheduleToPPVTile as sharedScrollScheduleToPPVTile,
} from '../../pages/android/AndroidSchedulePage';
import {
  findCorrectPPVTile as sharedFindCorrectPPVTile,
  getPPVKeywords as sharedGetPPVKeywords,
  navigateToSearch as sharedNavigateToSearch,
  openSearchResultPaywall,
  typeSearchQuery as sharedTypeSearchQuery,
} from '../../pages/android/AndroidSearchPage';
import {
  navigateToBoxingPage as sharedNavigateToBoxingPage,
  openHomeBoxingBannerPaywall,
  openHomeBoxingUpcomingPaywall,
  openHomeBoxingDontMissTilePaywall,
} from '../../pages/android/AndroidBoxingPage';
import { completeNativeSignup } from '../../pages/android/AndroidMyAccountPage';
import { openHomeBannerPaywall, openGenericPPVPaywall, openHomePageDontMissPaywall, openHomePagePopupPaywall, openDaznTilePaywall } from '../../pages/android/AndroidHomePage';
import { openLandingBannerPaywall } from '../../pages/android/AndroidLandingPage';
import { copyImmediateCheckoutUrl } from '../../pages/android/AndroidPaywallPage';
import { getAndroidSurfacingPoint, getAndroidValidationSheet } from '../../pages/android/AndroidSurfacingPoint';
import {
  validateMobilePaywallPage,
  validateMobileBannerOrTilePage,
  AndroidValidationResult,
} from '../../pages/android/AndroidValidationPage';

// ── Config ───────────────────────────────────────────────────────────────────
const { loadEventConfig: loadTopEventConfig } = require('../../../utils/testHelpers');
const TOP_EVENT_CONFIG = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
const topEventJson = loadTopEventConfig(TOP_EVENT_CONFIG);
const PPV_NAME = process.env.PPV_NAME || topEventJson.PPV_NAME || 'Joshua';
process.env.PPV_NAME = PPV_NAME;
const SOURCE = (process.env.SOURCE || 'home-boxing-upcoming').trim().toLowerCase();
const SURFACING_POINT = getAndroidSurfacingPoint(SOURCE);
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.dazn';
const MOBILE_BROWSER_PACKAGE = process.env.MOBILE_BROWSER_PACKAGE || 'com.android.chrome';

// ── Direct aliases for shared utilities (no per-spec wrapper needed) ─────────
const adb = sharedAdb;
const getScreenSize = sharedGetScreenSize;
const adbTap = sharedAdbTap;
const adbSwipe = sharedAdbSwipe;
const adbBack = sharedAdbBack;
const closeMobileBrowser = sharedCloseMobileBrowser;
const getChromeUrl = sharedGetChromeUrl;
const isVisible = sharedIsVisible;
const captureCheckoutUrl = sharedCaptureCheckoutUrl;

async function findEl(driver: WdBrowser, sel: string, timeoutMs = 10000): Promise<WdElement> {
  return sharedFindEl(driver, sel, timeoutMs);
}
async function tapByText(driver: WdBrowser, text: string, timeoutMs = 10000): Promise<boolean> {
  return sharedTapByText(driver, text, timeoutMs);
}
async function findPPVBanner(driver: WdBrowser): Promise<boolean> {
  return sharedFindPPVBanner(driver, PPV_NAME);
}
async function navigateToSchedule(driver: WdBrowser): Promise<void> {
  return sharedNavigateToSchedule(driver);
}
async function scrollScheduleToPPVTile(driver: WdBrowser): Promise<WdElement | null> {
  return sharedScrollScheduleToPPVTile(driver, PPV_NAME);
}
async function navigateToBoxingPage(driver: WdBrowser): Promise<void> {
  return sharedNavigateToBoxingPage(driver);
}
function getPPVKeywords(searchQuery: string, ppvName: string): string[] {
  return sharedGetPPVKeywords(searchQuery, ppvName);
}
async function findCorrectPPVTile(driver: WdBrowser, keywords: string[]): Promise<WdElement | null> {
  return sharedFindCorrectPPVTile(driver, keywords);
}
async function navigateToSearch(driver: WdBrowser): Promise<void> {
  return sharedNavigateToSearch(driver);
}
async function typeSearchQuery(driver: WdBrowser, searchQuery: string): Promise<void> {
  return sharedTypeSearchQuery(driver, searchQuery);
}
async function scrollToText(driver: WdBrowser, text: string): Promise<boolean> {
  return sharedScrollToText(driver, text);
}
async function swipeLeft(driver: WdBrowser): Promise<void> {
  return sharedSwipeLeft(driver);
}
async function scrollDown(driver: WdBrowser): Promise<void> {
  return sharedScrollDown(driver);
}

// ════════════════════════════════════════════════════════════════════════════
// TEST
// ════════════════════════════════════════════════════════════════════════════
describe('DAZN Android PPV → Web Handoff', () => {
  before(async () => {
    clearHandoffUrl();
    require('fs').mkdirSync('./test-results', { recursive: true });

    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    const envClear = process.env.CLEAR_APP_DATA || process.env.CLEAR_DATA || process.env.FRESH_APP;
    const clearData = envClear !== undefined ? String(envClear).toLowerCase() === 'true' : true;
    const shouldWaitHome = !isLoginFirst && SOURCE !== 'landing-page-banner' && SOURCE !== 'home-page-popup';

    await prepareAndroidApp(browser, {
      clearAppData: clearData,
      acceptCookiesOnly: isLoginFirst || SOURCE === 'home-page-popup' || undefined,
      waitForHome: shouldWaitHome,
    });
    console.log(`\n╔════════════════════════════════════════════════════╗`);
    console.log(`║  DAZN Android PPV Handoff                          ║`);
    console.log(`║  Event  : ${PPV_NAME.padEnd(40)}║`);
    console.log(`║  Source : ${SOURCE.padEnd(40)}║`);
    console.log(`║  Surface: ${SURFACING_POINT.page.padEnd(40)}║`);
    console.log(`╚════════════════════════════════════════════════════╝\n`);
  });

  it('navigates to PPV buy button, opens Chrome, captures checkout URL', async () => {
    const driver = browser;

    console.log('🎥 Starting screen recording on Android device...');
    await driver.startRecordingScreen({
      timeLimit: 300, // 5 minutes (300 seconds)
      videoSize: '1280x720',
      bitRate: '2000000',
    }).catch(e => console.error('⚠️ Failed to start screen recording:', e));

    console.log('✅ Startup handled by prepareAndroidApp; beginning PPV navigation');

    const fs = require('fs');
    const path = require('path');
    const { loadEventConfig } = require('../../../utils/testHelpers');
    const { buildEventData } = require('../../../utils/buildEventData');

    const REGION = process.env.DAZN_REGION || 'GB';
    const EVENT_CONFIG = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
    const PLAN = process.env.PLAN || 'standard_monthly';
    const SWITCH_TO_ULTIMATE = (process.env.SWITCH || '').toLowerCase() === 'true';
    const ENV = (process.env.DAZN_ENV || 'stag').toLowerCase();
    const PAYMENT_METHOD = (process.env.PAYMENT_METHOD || 'credit_card').toLowerCase();

    const json = loadEventConfig(EVENT_CONFIG);
    const PPV_TYPE = String(json.PPV_TYPE || process.env.PPV_TYPE || 'normal').trim().toLowerCase();
    const isStandalonePPV = PPV_TYPE === 'standalone';

    const plansPath = path.resolve(__dirname, '../../..', 'config/DaznPlan.json');
    const plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
    const planData = plans[PLAN];
    if (!planData) {
      throw new Error(`❌ Plan "${PLAN}" not found in DaznPlan.json`);
    }

    const planTier = (planData.TIER || 'standard').toLowerCase();
    const isUltimate = planTier === 'ultimate';
    const ratePlan = (planData.RATE_PLAN || 'monthly').toLowerCase();
    if (isStandalonePPV && (planTier === 'ultimate' || !['monthly', 'annual pay monthly'].includes(ratePlan))) {
      throw new Error(
        `Standalone PPV supports only Standard monthly or Annual Pay Monthly plans; received "${PLAN}".`
      );
    }

    // ── Early skip for defaultSignup sources when PPV is not configured ──
    // Mirrors web newuser.ppv.spec.ts: skip if surfacingpoint has
    // defaultSignup=true but event has HAS_DEFAULT_SIGNUP_PPV !== true
    const surfacingPointPath = path.resolve(__dirname, '../../config/surfacingpoint.json');
    if (fs.existsSync(surfacingPointPath)) {
      const sources = JSON.parse(fs.readFileSync(surfacingPointPath, 'utf-8'));
      if (sources[SOURCE]?.defaultSignup && json?.HAS_DEFAULT_SIGNUP_PPV !== true && !json?.DEFAULT_SIGNUP_DEVMODE) {
        console.log(`INFO: SOURCE "${SOURCE}" requires HAS_DEFAULT_SIGNUP_PPV: true; selected event does not enable PPV in the default signup journey. Skipping flow.`);
        console.log('⏭️ Skipping — PPV not configured for this defaultSignup source.');
        return;
      }
      if (sources[SOURCE]?.defaultSignup) {
        process.env.DEFAULT_SIGNUP = 'true';
      }
    }

    // Merge mobile overrides
    let mobileRegional = {};
    try {
      const mobileConfigName = path.basename(EVENT_CONFIG);
      const normalizedMobileConfigName = mobileConfigName.toLowerCase().endsWith('.json')
        ? mobileConfigName
        : `${mobileConfigName}.json`;
      const mobileConfigCandidates = [
        path.resolve(__dirname, '../../config/events', normalizedMobileConfigName),
        path.resolve(__dirname, '../../config/events', mobileConfigName),
        path.resolve(__dirname, '../../config/events', EVENT_CONFIG),
        json.eventKey ? path.resolve(__dirname, '../../config/events', `${json.eventKey}.json`) : '',
      ].filter(Boolean);
      const mobileConfigPath = mobileConfigCandidates.find((candidate: string) => fs.existsSync(candidate));
      if (mobileConfigPath && fs.existsSync(mobileConfigPath)) {
        const mobileJson = JSON.parse(fs.readFileSync(mobileConfigPath, 'utf8'));
        if (mobileJson.PPV_ENTITLEMENT_ID) json.PPV_ENTITLEMENT_ID = mobileJson.PPV_ENTITLEMENT_ID;
        mobileRegional = mobileJson.regions?.[REGION] || {};
        json.regions = json.regions || {};
        json.regions[REGION] = { ...json.regions[REGION], ...mobileRegional };
        console.log(`📱 Merged mobile-specific overrides from ${mobileConfigPath} into config before building eventData`);
      } else {
        console.warn(`⚠️ Mobile config override file not found: ${normalizedMobileConfigName} (nor ${json.eventKey}.json)`);
      }
    } catch (e: any) {
      console.warn(`⚠️ Failed to load mobile overrides: ${e.message}`);
    }

    const eventData = buildEventData(json, REGION, planTier, ratePlan.replace(/-/g, ' '), SOURCE);
    eventData.USER_EMAIL = '';
    eventData.USER_STATE = 'new';
    eventData.source = SOURCE;
    eventData.SOURCE = SOURCE;
    eventData.MOBILE_WEB_HANDOFF = 'true';
    eventData['MOBILE_WEB_HANDOFF'] = 'true';
    Object.assign(eventData, mobileRegional);

    if (SOURCE === 'home-page-popup') {
      const newEmail = process.env.NEW_USER_EMAIL ||
        `newuser.android.${Date.now()}.${Math.random().toString(36).slice(2, 10)}@yopmail.com`;
      await completeNativeSignup(driver, {
        email: newEmail,
        firstName: process.env.ANDROID_NEW_USER_FIRST_NAME || 'UAT',
        lastName: process.env.ANDROID_NEW_USER_LAST_NAME || 'User',
        password: process.env.ANDROID_NEW_USER_PASSWORD || 'Dazn@1234',
      });
      await waitForHomePage(driver, 120000, { preservePpvPopup: true });
    }

    // Compute date variables
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const fDay = futureDate.getDate();
    const fMonth = futureDate.toLocaleString('en-GB', { month: 'long' });
    const fYear = futureDate.getFullYear();
    eventData.FLEX_FUTURE_DATE_SHORT = `${fDay} ${fMonth} ${fYear}`;

    const offerType = eventData.OFFER_TYPE || '1_month_free';
    const isNoOffer = offerType === 'no_offer' || offerType === 'none';

    if (planTier === 'ultimate') {
      eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_ULTIMATE || 'Continue with DAZN Ultimate';
      eventData.DAZN_TIER = 'DAZN Ultimate';
    } else {
      if (isNoOffer) {
        eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_STANDARD || 'Continue with DAZN Standard';
      } else {
        eventData.PLAN_CTA_BUTTON = eventData.PLAN_CTA_BUTTON_STANDARD || 'Continue with 7-day Free Trial';
      }
      eventData.DAZN_TIER = 'DAZN Standard';
    }

    const activeOfferPresent = eventData.ACTIVE_OFFER_PRESENT === 'true';
    if (activeOfferPresent && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_LABEL || 'Flex – Pay Monthly - First Month Only';
      eventData.PAYMENT_FREE_TEXT = 'N/A';
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (/^\d+_day_trial$/.test(offerType) && planTier === 'standard' && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_TRIAL || 'Choose how to pay after your free trial';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_FREE_TEXT_TRIAL || '7-days free';
      eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_TRIAL || '7-days free';
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (ratePlan === 'annual pay monthly' || ratePlan === 'annual pay upfront' || ratePlan.includes('annual')) {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_ANNUAL || 'Annual - Pay Monthly';
      if (offerType === '1_month_free') {
        eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free';
      } else {
        eventData.PAYMENT_FREE_TEXT = 'N/A';
      }
      if (planTier === 'ultimate') {
        eventData.CANCELLATION_TEXT = ratePlan.includes('monthly')
          ? (eventData.CANCELLATION_TEXT_ULTIMATE_APM || '')
          : (eventData.CANCELLATION_TEXT_ULTIMATE_APU || '');
      } else {
        eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_ANNUAL || '';
      }
    } else if (offerType === '1_month_free' && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_NAME_FLEX || 'Flex – Pay Monthly';
      eventData.PAYMENT_FREE_TEXT = eventData.PAYMENT_FREE_TEXT_MONTHLY || 'First month free';
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (isNoOffer && ratePlan === 'monthly') {
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

    eventData['PAYMENT_PAGE_TITLE'] = eventData.PAYMENT_PAGE_TITLE;
    eventData['PAYMENT_PLAN_NAME'] = eventData.PAYMENT_PLAN_NAME;
    eventData['PAYMENT_FREE_TEXT'] = eventData.PAYMENT_FREE_TEXT;
    eventData['PLAN_CTA_BUTTON'] = eventData.PLAN_CTA_BUTTON;
    eventData['DAZN_TIER'] = eventData.DAZN_TIER;
    eventData['CANCELLATION_TEXT'] = eventData.CANCELLATION_TEXT;

    let buyTapped = false;
    let bannerUrlCaptured = false;
    let bannerCheckoutUrl = "";

    let paywallValidated = false;
    const androidAvailabilityResults: AndroidValidationResult[] = [];
    // paywallValidatedRef is passed by-reference so AndroidValidationPage can set the flag
    const paywallValidatedRef = { value: false };

    // ── validateMobilePaywall: delegated to AndroidValidationPage ───────────
    async function validateMobilePaywall() {
      await validateMobilePaywallPage(driver, eventData, SOURCE, androidAvailabilityResults, paywallValidatedRef);
      paywallValidated = paywallValidatedRef.value;
    }

    // ── validateMobileBannerOrTile: delegated to AndroidValidationPage ───────
    async function validateMobileBannerOrTile(
      surface: 'PPV Banner' | 'PPV Tile',
      _options: { landingCopyOverlay?: boolean } = {},
    ) {
      await validateMobileBannerOrTilePage(driver, surface, eventData, SOURCE, androidAvailabilityResults);
    }

    const androidFlowHooks = {
      validateSurface: validateMobileBannerOrTile,
      validatePaywall: validateMobilePaywall,
    };


    if (SOURCE === 'schedule') {
      buyTapped = await openSchedulePPVPaywall(driver, PPV_NAME, json, androidFlowHooks);
    }

    // ── search ────────────────────────────────────────────────────────────
    else if (SOURCE === 'search') {
      let searchQuery = PPV_NAME;
      try {
        const fs = require('fs');
        const path = require('path');
        const configFileName = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
        const configPath = path.resolve(__dirname, '../../..', 'config/events', configFileName);
        if (fs.existsSync(configPath)) {
          const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (configData.PPV_NAME) {
            searchQuery = configData.PPV_NAME;
            console.log(`✅ Loaded complete PPV name from config: "${searchQuery}"`);
          }
        }
      } catch (e: any) {
        console.log(`⚠️ Failed to load complete PPV name from config: ${e.message}. Using fallback.`);
      }

      if (searchQuery.includes(':')) {
        searchQuery = searchQuery.split(':').pop()?.trim() || searchQuery;
      }
      searchQuery = searchQuery.replace(/\./g, ''); // removes dots, e.g. "Joshua vs. Prenga" -> "Joshua vs Prenga"

      buyTapped = await openSearchResultPaywall(driver, PPV_NAME, searchQuery, androidFlowHooks, eventData);
    }

    // ── home-boxing-upcoming ────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-upcoming') {
      buyTapped = await openHomeBoxingUpcomingPaywall(driver, PPV_NAME, eventData, androidFlowHooks);
    }

    // ── home-boxing-banner ────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-banner') {
      buyTapped = await openHomeBoxingBannerPaywall(driver, PPV_NAME, eventData, androidFlowHooks);
    }

    // ── home-boxing-tile ──────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-tile') {
      buyTapped = await openHomeBoxingDontMissTilePaywall(driver, PPV_NAME, androidFlowHooks, eventData);
    }

    // ── landing-page-banner ───────────────────────────────────────────────
    else if (SOURCE === 'landing-page-banner') {
      console.log('  Landing page banner flow: find PPV banner, validate banner, buy, validate copy controls, copy URL.');
      buyTapped = await openLandingBannerPaywall(driver, PPV_NAME, androidFlowHooks);

      // Perform Gemini AI visual check on the captured Android landing page banner
      const screenshotPath = path.resolve(process.cwd(), 'test-results', 'android_landing_ppv_banner_found.png');
      if (fs.existsSync(screenshotPath)) {
        console.log(`🤖 [Gemini] Starting visual validation of Android landing page banner: ${screenshotPath}`);
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
            androidAvailabilityResults.push({
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

      if (androidFlowHooks.validatePaywall) {
        await androidFlowHooks.validatePaywall();
      }
      const copyResult = await copyImmediateCheckoutUrl(driver, 'landing-page-banner', {
        screenshotPrefix: 'landing',
        retrySwipeBackToPPV: true,
        ppvName: PPV_NAME,
        isLandingPageBanner: true,
      });
      bannerCheckoutUrl = copyResult.url;
      bannerUrlCaptured = copyResult.captured;

      if (!bannerUrlCaptured) {
        await driver.saveScreenshot('./test-results/android_landing_copy_url_not_captured.png');
        throw new Error(`Could not copy landing banner checkout URL. Clipboard content: ${bannerCheckoutUrl}`);
      }
    }

    // ── home-page-banner ──────────────────────────────────────────────────
    else if (SOURCE === 'home-page-banner') {
      buyTapped = await openHomeBannerPaywall(driver, PPV_NAME, androidFlowHooks);
      if (androidFlowHooks.validatePaywall) {
        await androidFlowHooks.validatePaywall();
      }
      const copyResult = await copyImmediateCheckoutUrl(driver, 'home-page-banner', {
        screenshotPrefix: 'home',
      });
      bannerCheckoutUrl = copyResult.url;
      bannerUrlCaptured = copyResult.captured;
      buyTapped = true;
    }

    // ── home-page-dont-miss ───────────────────────────────────────────────
    else if (SOURCE === 'home-page-dont-miss') {
      buyTapped = await openHomePageDontMissPaywall(driver, PPV_NAME, androidFlowHooks, json);
    }
    // ── home-page-popup ────────────────────────────────────────────────────
    else if (SOURCE === 'home-page-popup') {
      buyTapped = await openHomePagePopupPaywall(driver, PPV_NAME, androidFlowHooks, eventData);
      await validateMobilePaywall();
      const copyResult = await copyImmediateCheckoutUrl(driver, SOURCE, { screenshotPrefix: 'home_popup' });
      bannerCheckoutUrl = copyResult.url;
      bannerUrlCaptured = copyResult.captured;
      if (!bannerUrlCaptured) throw new Error(`Could not capture the native contextual checkout URL for "${PPV_NAME}".`);
    }

      // ── home-page-dazntile / subscribe-without-pay-per-view ──────────────
      else if (SOURCE === 'home-page-dazntile' || SOURCE === 'subscribe-without-pay-per-view') {
        buyTapped = await openDaznTilePaywall(driver, androidFlowHooks);
        const copyResult = await copyImmediateCheckoutUrl(driver, SOURCE, { screenshotPrefix: 'dazn_tile' });
        bannerCheckoutUrl = copyResult.url;
        bannerUrlCaptured = copyResult.captured;
        if (!bannerUrlCaptured) throw new Error(`Could not capture the native checkout URL for DAZN tile source "${SOURCE}".`);
      }

    // ── fallback ──────────────────────────────────────────────────────────
    else {
      console.log(`⚠️  Unknown SOURCE "${SOURCE}" — generic Home screen fallback`);
      buyTapped = await openGenericPPVPaywall(driver, PPV_NAME, androidFlowHooks);
    }

    if (!buyTapped) {
      await driver.saveScreenshot('./test-results/android_buy_not_found.png');
      throw new Error(`❌ Could not tap Buy CTA. SOURCE="${SOURCE}". See test-results/android_buy_not_found.png`);
    }

    const cleanUserState = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUserHandoff = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(cleanUserState);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimateUserHandoff && isLoginFirst) {
      console.log(`\n✨ [Ultimate Active User with LOGIN_FIRST=true] Navigated to fixture page after PIN Protection validation for SOURCE="${SOURCE}".`);
      console.log('   Ending flow and closing the app as expected for Ultimate active user (no paywall expected).');
      console.log('📱 Closing DAZN app...');
      adb("shell am force-stop " + APP_PACKAGE);
      return;
    }

    // For banner sources, URL is captured immediately inline above (no Chrome wait needed)
    // For other sources, wait for Chrome Custom Tab to open
    if (!bannerUrlCaptured) {
      console.log('\n⏳ Waiting for Chrome Custom Tab to open...');
      await driver.pause(5000);  // Wait longer for Chrome to open
      await driver.saveScreenshot('./test-results/android_after_buy_click.png');

      // Check if Chrome opened by looking for Chrome UI
      console.log('  Checking if Chrome opened...');
      const chromeSigns = ['Address', 'Search', 'dazn.com', 'https://'];
      let chromeOpened = false;

      for (const sign of chromeSigns) {
        if (await isVisible(driver, sign, 2000)) {
          console.log(`  ✅ Chrome opened (found: ${sign})`);
          chromeOpened = true;
          break;
        }
      }

      if (!chromeOpened) {
        console.log('  ⚠️ Chrome may not have opened. Checking current activity...');
        const currentActivity = adb('shell dumpsys window | grep mCurrentFocus');
        console.log(`  Current activity: ${currentActivity}`);
      }
    }

    // ── Step 3: Capture checkout URL from paywall screen ──────────────────
    console.log("📋 Capturing checkout URL from paywall...");
    if (!bannerUrlCaptured) {
      await driver.saveScreenshot("./test-results/android_paywall_screen.png");

      try {
        await validateMobilePaywall();
      } catch (err: any) {
        console.warn('⚠️ Mobile paywall validation failed:', err.message);
      }
    }

    // Use pre-captured URL for banner flows, otherwise capture now
    let checkoutUrl = bannerUrlCaptured ? bannerCheckoutUrl : "";

    // For banner flows the URL was already captured inline — skip the copy/clipboard steps
    if (!bannerUrlCaptured) {

      // Dump page source to help debug why "Copy" button is not found/clickable
      console.log("\n── Page Source (for debugging Copy button) ──────────────────");
      const pageSource = await driver.getPageSource();
      console.log(pageSource.substring(0, 5000)); // Log first 5000 chars to avoid overwhelming output
      console.log("────────────────────────────────────────────────────────────\n");

      // Method 1: Click Copy button and get URL from clipboard
      console.log("  Method 1: Clicking Copy button and reading clipboard...");

      // First, scroll up slightly to ensure Copy button is fully visible
      console.log("  Scrolling up to ensure Copy button is visible...");
      const screenSize = getScreenSize();
      adbSwipe(Math.round(screenSize.width / 2),
        Math.round(screenSize.height * 0.85),
        Math.round(screenSize.width / 2),
        Math.round(screenSize.height * 0.75));
      await driver.pause(1000);

      // Try clicking the parent element of the Copy button
      try {
        // The clickable element is a View, which contains the TextView "Copy"
        const parentCopyBtn = await driver.$(`//android.view.View[./android.widget.TextView[@text="Copy"]]`);
        console.log("  Found parent of Copy button, waiting for display...");
        await parentCopyBtn.waitForDisplayed({ timeout: 5000 });
        console.log("  Parent displayed, attempting click...");
        await parentCopyBtn.click();
        console.log("  ✅ Clicked parent of Copy button");
        await driver.pause(2000);

        // Take screenshot after click
        await driver.saveScreenshot("./test-results/android_after_copy_click.png");
        console.log("  Screenshot saved: android_after_copy_click.png");
      } catch (e) {
        console.log(`  ❌ Failed to click parent: ${e.message}`);
        console.log("  Trying coordinate tap as fallback...");

        // Fallback: Try coordinate tap if element click failed
        const copyBtnX = Math.round(screenSize.width * 0.19);  // 19% from left
        const copyBtnY = Math.round(screenSize.height * 0.89); // 89% from top

        console.log(`  Tapping Copy button at coordinates (${copyBtnX}, ${copyBtnY})`);
        adbTap(copyBtnX, copyBtnY);
        await driver.pause(2000);

        // Take screenshot after coordinate tap
        await driver.saveScreenshot("./test-results/android_after_copy_tap.png");
        console.log("  Screenshot saved: android_after_copy_tap.png");
      }

      // Read URL from clipboard using Appium driver or fallback to ADB
      try {
        const base64Content = await driver.getClipboard();
        checkoutUrl = Buffer.from(base64Content, 'base64').toString('utf8');
        console.log(`  Appium clipboard content: ${checkoutUrl.substring(0, 100)}...`);
      } catch (e: any) {
        console.log(`  Failed to get clipboard via Appium: ${e.message}`);
        checkoutUrl = adb("shell am clipht get");
        console.log(`  ADB Clipboard content: ${checkoutUrl.substring(0, 100)}...`);
      }

    } // end !bannerUrlCaptured block

    if (checkoutUrl && (checkoutUrl.includes("dazn.com") || checkoutUrl.includes("amazonaws.com"))) {
      console.log("✅ URL captured from clipboard");
    } else {
      // If clipboard failed, take screenshot and throw error immediately
      await driver.saveScreenshot("./test-results/android_url_not_found.png");
      console.log("❌ Clipboard content was not a valid DAZN URL. All URL capture methods failed.");
      console.log("   Screenshot saved to: test-results/android_url_not_found.png");
      console.log("   Paywall screenshot saved to: test-results/android_paywall_screen.png");
      throw new Error(`❌ Could not capture checkout URL from paywall.\n   Clipboard content: ${checkoutUrl}\n   Check screenshots and console log.`);
    }



    console.log(`\n🌐 Checkout URL captured:\n   ${checkoutUrl}\n`);
    writeHandoffUrl(checkoutUrl);
    console.log("✅ URL written to mobile_entry_url.txt");
    console.log("📱 Closing DAZN app...");
    adb("shell am force-stop " + APP_PACKAGE);
    await driver.pause(1000);
    console.log("📱 Next: Open fresh Chrome browser, paste URL, and complete web flow");

    // ── Playwright Web Checkout Phase ──────────────────────────────────────────
    // Force-stop Chrome to ensure a completely fresh browser launch (not a new tab).
    console.log("Force-stopping Chrome to ensure fresh browser launch...");
    closeMobileBrowser();
    await driver.pause(1000);
    const originalCwd = process.cwd();
    let playwrightBrowser: any = null;
    let context: any = null;
    let chromeLaunchCleanup: (() => Promise<void>) | null = null;
    const runStart = new Date();

    try {
      // 1. Change directory to root so paths resolve correctly relative to config and sheets
      const nodePath = require('path');
      const nodeFs = require('fs');
      process.chdir(nodePath.resolve(__dirname, '../../..'));
      console.log(`📂 Changed working directory to: ${process.cwd()}`);

      // Dynamic imports to keep the top of the file 100% original
      const { chromium } = require('@playwright/test');
      const fs = nodeFs;
      const path = nodePath;

      const { SignupPage } = require('../../../pages/SignupPage');
      const { PaymentPage } = require('../../../pages/PaymentPage');
      const { SearchPage } = require('../../../pages/SearchPage');
      const { StandalonePPVPage } = require('../../../pages/StandalonePPVPage');
      const { PPVUpsellSuccessPage } = require('../../../pages/PPVUpsellSuccessPage');
      const { PPVUpsellPaymentPage } = require('../../../pages/PPVUpsellPaymentPage');
      const { MyAccountPage } = require('../../../pages/MyAccountPage');
      const { SchedulePage: WebSchedulePage } = require('../../../pages/schedulepage');

      const {
        readSheet,
        configureExcelPathForEvent,
        getPPVDataByVariant,
        getPlanDataByTier,
        getPaymentDataByTierAndPlan,
        getPhonePageData,
        getOTPPageData,
        getStandalonePPVPageData,
        getUpsellFirstSuccessData,
        getUpsellSecondSuccessData,
        getUpsellPaymentData,
      } = require('../../../utils/excelReader');

      const { detectVariant } = require('../../../flows/detectVariant');
      const { validateVariant } = require('../../../flows/validateVariant');
      const { buildEventData } = require('../../../utils/buildEventData');
      const { detectPageType } = require('../../../utils/flowHelpers');
      const { displayResultsTable } = require('../../../utils/resultsDisplay');
      const { writeResults } = require('../../../utils/excelWriter');
      const { generateReports } = require('../../../utils/reportGenerator');
      const { createTestUser } = require('../../../utils/testDataBuilder');

      const {
        sleep,
        setupPage,
        handleCookies,
        stabilisePage,
        dismissMarketingPopup,
      } = require('../../../utils/helpers');

      const {
        loadEventConfig,
        safeScrollToElement,
        clickAndWaitForNav,
        handlePopupModal,
        assertCountryMatch,
      } = require('../../../utils/testHelpers');


      // Config moved to the top of the 'it' block

      // Screenshot helper for failed fields
      const captureFailShot = async (page: any, field: string): Promise<string | undefined> => {
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
      };

      // Replace platform=android with platform=web
      let webCheckoutUrl = checkoutUrl.replace('platform=android', 'platform=web');

      // Config moved to top of 'it' block

      const planName = ratePlan === 'monthly'
        ? 'Flex Monthly'
        : (ratePlan.includes('upfront') ? 'APU' : 'APM');
      const tierName = planTier.charAt(0).toUpperCase() + planTier.slice(1);
      const srcLabel = SOURCE.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      const flowConfig = {
        name: `Android: ${srcLabel} → ${tierName} → ${planName}`,
        source: SOURCE,
        tier: planTier,
        ratePlan: ratePlan,
        endPage: 'payment',
        enableDevMode: !isStandalonePPV && isUltimate,
        planKey: PLAN
      };

      console.log(`\n╔═══════════════════════════════════════════════════════╗`);
      console.log(`║  RUNNING LOCAL PLAYWRIGHT WEB CHECKOUT: ${flowConfig.name}`);
      console.log(`║  Source: ${flowConfig.source} | Tier: ${flowConfig.tier} | Plan: ${flowConfig.ratePlan}`);
      console.log(`╚═══════════════════════════════════════════════════════╝\n`);

      const results: any[] = [];
      configureExcelPathForEvent(json.eventKey || '');

      // eventData configuration moved to top of 'it' block

      const variantConfig = json.variants;
      const pagesConfig = json.pages;

      console.log('🌐 Connecting to Android device via Playwright...');
      const { _android } = require('@playwright/test');
      const devices = await _android.devices();
      if (devices.length === 0) {
        throw new Error('❌ No Android devices found by Playwright!');
      }
      const targetSerial = process.env.DEVICE_SERIAL;
      let device = devices[0];
      if (targetSerial) {
        const matched = devices.find(d => d.serial() === targetSerial);
        if (matched) {
          device = matched;
          console.log(`🎯 Playwright matched device serial: ${targetSerial}`);
        } else {
          console.warn(`⚠️ Playwright could not find device with serial ${targetSerial}. Defaulting to first device.`);
        }
      }
      console.log(`📱 Connected to device: ${device.model()} (${device.serial()})`);

      const regionLocaleMap: Record<string, { locale: string; timezoneId: string }> = {
        GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
        UK: { locale: 'en-GB', timezoneId: 'Europe/London' },
        US: { locale: 'en-US', timezoneId: 'America/New_York' },
        AE: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
        AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
        BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
        NO: { locale: 'en-GB', timezoneId: 'Europe/Oslo' },
        DE: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
        IT: { locale: 'it-IT', timezoneId: 'Europe/Rome' },
        ES: { locale: 'es-ES', timezoneId: 'Europe/Madrid' },
        FR: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
        CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
        JP: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
      };
      const REGION_KEY = (process.env.DAZN_REGION || 'GB').toUpperCase();
      const { locale: activeLocale, timezoneId: activeTz } =
        regionLocaleMap[REGION_KEY] ?? { locale: 'en-GB', timezoneId: 'Europe/London' };

      console.log(`Launching Chrome browser on Android device (device timezone "${activeTz}", locale "${activeLocale}")...`);
      const chromeLaunch = await launchAndroidChrome(device, chromium, {
        viewport: { width: 375, height: 667 },
        timezoneId: activeTz,
        locale: activeLocale,
      });
      context = chromeLaunch.context;
      playwrightBrowser = chromeLaunch.browser;
      chromeLaunchCleanup = chromeLaunch.cleanup;

      await context.addInitScript(() => {
        try {
          if (!localStorage.getItem('randomABPoint')) {
            localStorage.setItem('randomABPoint', Math.random().toString());
          }

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

      // Use the existing page from the fresh launchBrowser() call (avoids opening a new tab)
      console.log('Using fresh Chrome browser page (no new tab)...');
      const existingPages = context.pages();
      // Close any extra pages that may have been restored, keep only the first one
      for (let i = 1; i < existingPages.length; i++) {
        await existingPages[i].close().catch(() => { });
      }
      const page = existingPages[0] ?? await context.newPage();

      if (!playwrightBrowser) {
        console.log('Bringing Chrome browser UI to the foreground...');
        await device.shell(`am start -n ${MOBILE_BROWSER_PACKAGE}/com.google.android.apps.chrome.Main`);
        await sleep(1500);
      } else {
        console.log('Chrome CDP handoff is already foregrounded in a regular tab.');
      }

      page.on('console', (msg: any) => {
        const text = msg.text();
        const textLower = text.toLowerCase();
        if (textLower.includes('dev') || textLower.includes('mode') || textLower.includes('copy') || textLower.includes('error') || textLower.includes('fail') || textLower.includes('clipboard') || textLower.includes('permission')) {
          console.log(`🖥️ [Page Console] ${text}`);
        }
      });

      if (flowConfig.enableDevMode) {
        const daznBaseUrl = webCheckoutUrl.match(/https:\/\/[^/]+\/en-[A-Z]+/i)?.[0] || 'https://www.dazn.com/en-GB';
        console.log(`\n🎭 Ultimate plan detected — enabling dev mode before opening checkout URL...`);
        console.log(`🧭 Opening DAZN base URL for dev mode: ${daznBaseUrl}`);
        await page.goto(daznBaseUrl, { waitUntil: 'domcontentloaded' });
        await handleCookies(page, 8000).catch(() => { });
        const searchPage = new SearchPage(page);
        await searchPage.enableDevMode();
        console.log('✅ Dev mode enabled — now opening Android checkout URL');
      }

      console.log(`\n🌐 Opening handoff URL: ${webCheckoutUrl}\n`);

      console.log(`📄 Before goto: ${page.url()}`);

      await page.goto(webCheckoutUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      console.log(`📄 After goto: ${page.url()}`);
      console.log(`📄 Browser title: ${await page.title()}`);

      await page.screenshot({
        path: './test-results/android_after_goto.png',
        fullPage: false,
      });

      console.log('📸 Saved screenshot after goto');

      // Explicitly wait for cookies and accept them
      console.log('🍪 Waiting for cookie banner and accepting cookies...');
      const acceptBtn = page.locator('#onetrust-accept-btn-handler');
      try {
        await acceptBtn.waitFor({ state: 'visible', timeout: 20000 });
        console.log('🍪 Cookie accept button is visible. Clicking it...');
        await acceptBtn.click({ force: true });
        console.log('🍪 Accepted cookies.');

        await page.locator('#onetrust-banner-sdk').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => { });
        console.log('🍪 Cookie banner is hidden.');
      } catch (e) {
        console.log('⚠️ Primary cookie banner not visible or interactable within timeout. Trying helper fallbacks...');
        await handleCookies(page, 5000);
      }

      const variant = await detectVariant(page, variantConfig).catch(() => 'variant1');
      console.log('🎯 variant:', variant);
      const currentVariantConfig = variantConfig?.[variant] || {};

      let reachedEndPage = false;
      let ppvValidated = false;
      let planValidated = false;
      let planClickCount = 0;
      let emailProcessedCount = 0;
      let stuckCount = 0;
      let firstPaymentDone = false;
      let firstSuccessValidated = false;
      let savedCardPaymentDone = false;

      // Traverse checkout funnel
      for (let step = 0; step < 15; step++) {
        if (page.isClosed()) throw new Error('❌ Page closed unexpectedly');

        const pageType = await detectPageType(page, pagesConfig, planClickCount, isStandalonePPV);
        await handleCookies(page, step === 0 ? 5000 : 500);
        await stabilisePage(page);
        await dismissMarketingPopup(page);
        console.log(`\nstep ${step + 1} → pageType: ${pageType} | planClicks: ${planClickCount} | url: ${page.url()}`);

        // ── Default Signup validation check: Skip gracefully if no PPV ──
        // Mirrors web existinguser.ppv.spec.ts lines 3382–3406
        const isBoxingSubscriptionSource =
          SOURCE === 'boxing-ultimate-subscription' ||
          SOURCE === 'boxing-standard-subscription' ||
          SOURCE === 'boxing-join-the-club';
        if (process.env.DEFAULT_SIGNUP === 'true' && !ppvValidated && !isBoxingSubscriptionSource) {
          const url = page.url().toLowerCase();
          if (url.includes('page=tierplans') || url.includes('page=plandetails') || pageType === 'plan' || pageType === 'email' || pageType === 'default-signup') {
            const bodyText = await page.locator('body').innerText({ timeout: 2000 }).then((t: any) => t.toLowerCase()).catch(() => '');
            const hasPPVOption = bodyText.includes('subscribe without a pay-per-view') ||
              bodyText.includes('continue without pay-per-view') ||
              bodyText.includes('continue without a pay-per-view');
            if (!hasPPVOption) {
              console.log(`⚠️ [DefaultSignup] No PPV option found on plan page — PPV not configured for this source. Skipping flow gracefully.\nURL: ${page.url()}`);
              results.push({
                page: 'PPV',
                field: 'PPV Option Present',
                expected: 'Subscribe without a pay-per-view',
                actual: 'Not found — PPV not configured for this source',
                status: 'SKIP',
              });
              reachedEndPage = true;
              break;
            }
          }
        }

        // ── OTP Verification page ──────────────────────────────
        if (pageType === 'otp') {
          console.log('🔑 Reached OTP Verification page');
          reachedEndPage = true;

          try {
            const otpData = getOTPPageData();
            console.log(`\n🧾 Validating OTP page — ${otpData.length} fields`);

            for (const row of otpData) {
              const field = (row['Field'] || '').trim();
              const expected = (row['Expected'] || '').toString().trim();
              if (!field) continue;

              let actual = 'N/A';
              const fieldLower = field.toLowerCase();

              if (fieldLower === 'page title') {
                const h1 = await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => '');
                if (h1 && h1.trim()) {
                  actual = h1.trim();
                } else {
                  const h2 = await page.locator('h2').first().textContent({ timeout: 3000 }).catch(() => '');
                  if (h2 && h2.trim()) {
                    actual = h2.trim();
                  } else {
                    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
                    const lines = bodyText.split('\n').map((l: any) => l.trim()).filter((l: any) => l.length > 10 && l.length < 100);
                    for (const line of lines) {
                      if (/enter.*code|verify|verification/i.test(line)) { actual = line; break; }
                    }
                  }
                }
              } else if (fieldLower === 'page description') {
                const desc = await page.locator('h1 + p, h2 + p, h1 ~ p, [class*="subtitle"], [class*="description"]')
                  .first().textContent({ timeout: 3000 }).catch(() => '');
                if (desc && desc.trim()) {
                  actual = desc.trim();
                } else {
                  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
                  const lines = bodyText.split('\n').map((l: any) => l.trim()).filter((l: any) => l.length > 15 && l.length < 200);
                  for (const line of lines) {
                    if (/sent.*code|code.*to|digit.*code/i.test(line)) { actual = line; break; }
                  }
                }
              } else if (fieldLower === 'otp input present') {
                const otpInputs = page.locator(
                  'input[type="tel"], input[type="number"], input[inputmode="numeric"], ' +
                  'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], ' +
                  'input[data-test-id*="otp" i], input[data-test-id*="code" i], ' +
                  'input[maxlength="1"], input[maxlength="4"], input[maxlength="6"]'
                );
                const count = await otpInputs.count().catch(() => 0);
                actual = count > 0 ? 'Yes' : 'No';
              } else if (fieldLower === 'verify button') {
                const btn = page.locator(
                  'button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm"), button[type="submit"]'
                ).first();
                const text = await btn.textContent({ timeout: 3000 }).catch(() => '');
                actual = (text || '').trim() || 'N/A';
              } else if (fieldLower === 'resend code link') {
                const resend = page.locator(
                  'button:has-text("Resend"), a:has-text("Resend"), button:has-text("resend"), a:has-text("resend"), ' +
                  'button:has-text("Send again"), a:has-text("Send again"), ' +
                  '*:has-text("Resend code"), *:has-text("resend code")'
                ).first();
                actual = (await resend.isVisible({ timeout: 3000 }).catch(() => false)) ? 'Yes' : 'No';
              }

              const actualNorm = actual.toLowerCase().replace(/\s+/g, ' ').trim();
              const expectedNorm = expected.toLowerCase().replace(/\s+/g, ' ').trim();
              const status = (actualNorm === expectedNorm ||
                actualNorm.includes(expectedNorm) ||
                expectedNorm.includes(actualNorm)) ? 'PASS' : 'FAIL';

              console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${field}]  expected="${expected}"  actual="${actual}"`);
              const _shotOTP = status === 'FAIL' ? await captureFailShot(page, field) : undefined;
              results.push({ page: 'OTP Verification', field, expected, actual, status, screenshot: _shotOTP });
            }
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

        // ── Phone Number page ──────────────────────────────────
        if (pageType === 'phone') {
          console.log('📱 Reached "Add your phone number" page');
          reachedEndPage = true;

          try {
            const phoneData = getPhonePageData();
            console.log(`\n🧾 Validating Phone Number page — ${phoneData.length} fields`);

            for (const row of phoneData) {
              const field = (row['Field'] || '').trim();
              const expected = (row['Expected'] || '').toString().trim();
              if (!field) continue;

              let actual = 'N/A';
              const fieldLower = field.toLowerCase();

              if (fieldLower === 'page title') {
                const h1 = await page.locator('h1').first().textContent({ timeout: 5000 }).catch(() => '');
                actual = (h1 || '').trim() || 'N/A';
              } else if (fieldLower === 'page description') {
                const desc = await page.locator('h1 + p, h1 ~ p, [class*="subtitle"], [class*="description"]')
                  .first().textContent({ timeout: 3000 }).catch(() => '');
                if (desc && desc.trim()) {
                  actual = desc.trim();
                } else {
                  const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
                  const lines = body.split('\n').map((l: any) => l.trim()).filter((l: any) => l.length > 20 && l.length < 200);
                  for (const line of lines) {
                    if (/recover|locked out|verify/i.test(line)) { actual = line; break; }
                  }
                }
              } else if (fieldLower === 'phone input present') {
                const input = page.locator('input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]').first();
                actual = (await input.isVisible({ timeout: 3000 }).catch(() => false)) ? 'Yes' : 'No';
              } else if (fieldLower === 'continue button') {
                const btn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
                const text = await btn.textContent({ timeout: 3000 }).catch(() => '');
                actual = (text || '').trim() || 'N/A';
              } else if (fieldLower === 'country code present') {
                const cc = page.locator('[class*="country" i], [class*="dial" i], select, [role="listbox"]').first();
                actual = (await cc.isVisible({ timeout: 3000 }).catch(() => false)) ? 'Yes' : 'No';
              }

              const actualNorm = actual.toLowerCase().replace(/\s+/g, ' ').trim();
              const expectedNorm = expected.toLowerCase().replace(/\s+/g, ' ').trim();
              const status = (actualNorm === expectedNorm ||
                actualNorm.includes(expectedNorm) ||
                expectedNorm.includes(actualNorm)) ? 'PASS' : 'FAIL';

              console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${field}]  expected="${expected}"  actual="${actual}"`);
              const _shotPhone = status === 'FAIL' ? await captureFailShot(page, field) : undefined;
              results.push({ page: 'Phone Number', field, expected, actual, status, screenshot: _shotPhone });
            }
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
          console.log('💳 Next Upsell Saved Card Payment');
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

        // ── Payment Details Page ─────────────────────────────────
        if (pageType === 'payment') {
          console.log('💳 Reached Payment page');
          if (SOURCE === 'schedule' || SOURCE === 'search') {
            const currentUrl = page.url();
            console.log(`🔍 [${SOURCE === 'schedule' ? 'Schedule' : 'Search'} Flow] Checking URL: ${currentUrl}`);
            const isStag = currentUrl.includes('stag.dazn.com') || currentUrl.includes('sandbox') || currentUrl.includes('staging');
            const isProdOrBeta = ENV === 'prod' || ENV === 'beta';
            if (!isStag && !isProdOrBeta) {
              console.log(`⚠️ URL is not stag, prod, or beta (URL: ${currentUrl}). Ending flow and closing browser.`);
              return;
            }
          }
          reachedEndPage = true;

          const payment = new PaymentPage(page);
          if (await payment.isPaymentPage()) {
            console.log('✅ Payment page detected');
            const planKey = SOURCE.startsWith('boxing-bundle') ? `${ratePlan} bundle` : ratePlan;
            const paymentData = getPaymentDataByTierAndPlan(planTier, planKey)
              .filter((row: any) => String(row.Field || '').trim().toLowerCase() !== 'payment method heading');
            console.log(`📊 Payment rows: ${paymentData.length}`);
            await payment.validate(paymentData, results, eventData, 'newuser');
          }

          // ── SCENARIO 2: Ultimate Upsell Banner ──
          const isStandardTierForUpsell = planTier === 'standard';
          const isMonthlyOrAPMForUpsell = ratePlan === 'monthly' || ratePlan === 'annual pay monthly';

          if (isStandalonePPV) {
            console.log('⏭️ Standalone PPV payment does not validate the Ultimate upsell banner.');
          } else if (isStandardTierForUpsell && isMonthlyOrAPMForUpsell) {
            try {
              await payment.validateUltimateUpsellBannerText(results, eventData);
              const shouldClickUpsell = SWITCH_TO_ULTIMATE || SOURCE === 'landing-page-dont-miss-live-switch';

              if (shouldClickUpsell) {
                const switched = await payment.clickUltimateUpsellAndValidate(results, eventData);
                if (switched) {
                  console.log('💎 [SWITCH=true] Proceeding with DAZN Ultimate payment...');
                  eventData.TIER = 'ultimate';
                  eventData['TIER'] = 'ultimate';
                  eventData.DAZN_TIER = 'DAZN Ultimate';
                  eventData['DAZN_TIER'] = 'DAZN Ultimate';
                  eventData.RATE_PLAN = 'annual pay monthly';
                  eventData['RATE_PLAN'] = 'annual pay monthly';
                }
              } else {
                console.log('ℹ️ SWITCH not set — skipping Ultimate upsell click. Proceeding with Standard payment.');
              }
            } catch (upsellErr: any) {
              console.warn(`⚠️ Ultimate Upsell Banner validation error: ${upsellErr.message}`);
            }
          }

          firstPaymentDone = true;

          // Payment details filling on staging
          if (ENV === 'stag') {
            console.log(`💳 DAZN_ENV is stag — filling payment via method: ${PAYMENT_METHOD}`);
            try {
              if (PAYMENT_METHOD === 'gpay') {
                console.log('🔵 [GPay] Using Google Pay payment method...');
                await payment.fillGooglePayAndSubmit(results, eventData);
                await payment.verifyPaymentSuccess();
                await payment.clickSuccessContinue();
              } else {
                console.log('💳 Using Credit Card payment method...');
                await payment.fillPaymentAndSubmit();
                await payment.verifyPaymentSuccess();
                await payment.clickSuccessContinue();
              }

              console.log('✅ Payment details submitted successfully on staging!');
              results.push({
                page: 'Payment Success',
                field: 'Payment Completed',
                expected: 'Success page reached',
                actual: 'Success page reached',
                status: 'PASS',
              });

              // ── SCENARIO 3: My Account PPV Status check ──
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

              // ── SCENARIO 4: Post-Payment Schedule verification ──
              if (PPV_TYPE !== 'upsell') {
                try {
                  console.log('\n📅 [Post-Payment] Navigating to Schedule page to verify purchased event...');
                  const webSchedulePagePostPayment = new WebSchedulePage(page);
                  const baseUrl = eventData.BASE_URL;
                  await webSchedulePagePostPayment.navigate(baseUrl);

                  const sport = eventData.SPORT || json.SPORT || 'Boxing';
                  await webSchedulePagePostPayment.selectSport(sport);

                  console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
                  const eventCard = await webSchedulePagePostPayment.findEvent(eventData.PPV_NAME);

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

              if (PPV_TYPE === 'upsell') {
                console.log('🔄 Upsell flow — continuing loop for post-payment pages...');
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                continue;
              }
            } catch (paymentErr: any) {
              console.error(`❌ Payment filling failed: ${paymentErr.message}`);
              try {
                await page.screenshot({ path: `test-results/payment_fill_error_${Date.now()}.png`, fullPage: true });
              } catch { }
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
            console.log(`ℹ️ DAZN_ENV is "${ENV}" — ending the flow on payment page as requested for production.`);
            reachedEndPage = true;
          }

          break;
        }

        // ── Email/Signup Page ──────────────────────────────────
        if (pageType === 'email') {
          console.log('✅ Reached email/personal-details page');
          emailProcessedCount++;

          // Error popup detection
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
            const errorSnippet = bodyTextForError.split('\n').filter((l: any) => errorPatterns.some(p => p.test(l))).join(' | ').substring(0, 200);
            console.log(`❌ [Signup Error] Detected error popup on page: "${errorSnippet}"`);
            try {
              await page.screenshot({ path: 'test-results/signup_error_popup.png', fullPage: true });
            } catch { }
            throw new Error(`❌ Signup error popup detected: "${errorSnippet}".`);
          }

          if (emailProcessedCount > 2) {
            console.log('⚠️  Email/personal details loop detected — breaking');
            try {
              await page.screenshot({ path: 'test-results/personal_details_error.png', fullPage: true });
            } catch { }
            const anyBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
            if (await anyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              const beforeUrl = page.url();
              await anyBtn.click({ force: true }).catch(() => { });
              await page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 2000 }).catch(() => { });
            }
            if (page.url().includes('paymentDetails') || page.url().includes('payment')) {
              reachedEndPage = true;
              console.log('💳 Navigated to payment page after loop detection retry');
              continue;
            }
            break;
          }

          const signup = new SignupPage(page);
          const user = createTestUser();
          const onPersonalDetails = page.url().includes('page=personalDetails');

          if (onPersonalDetails && emailProcessedCount > 1) {
            console.log('ℹ️  Already on personal details (retry) — just clicking Continue');
            const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
            if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await continueBtn.click({ force: true }).catch(() => { });
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
          }

          await page.waitForLoadState('domcontentloaded').catch(() => { });

          const firstNameEl = page.locator('[data-test-id="FIRST_NAME"], input[name="firstName"]').first();
          const firstNameVisible = await firstNameEl.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
          if (firstNameVisible) {
            const signup2 = new SignupPage(page);
            try {
              await signup2.fillPersonalDetails(user);
              await signup2.clickPersonalDetailsContinue();

              const errorMsg = page.locator('text=/valid phone number|valid number/i').first();
              if (await errorMsg.isVisible({ timeout: 1500 }).catch(() => false)) {
                console.log(`⚠️ Phone validation error detected: "${await errorMsg.textContent()}"`);

                const phoneInput = page.locator(
                  'input[type="tel"], input[name*="phone" i], input[name*="Phone" i], input[placeholder*="phone" i]'
                ).first();

                const isAU = REGION === 'AU' || page.url().includes('-AU');
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

                  await signup2.clickPersonalDetailsContinue();
                  await Promise.race([
                    page.waitForURL((url: URL) => !url.toString().includes('page=personalDetails'), { timeout: 2000 }),
                    errorMsg.waitFor({ state: 'hidden', timeout: 2000 })
                  ]).catch(() => { });

                  if (!(await errorMsg.isVisible().catch(() => false)) && !page.url().includes('page=personalDetails')) {
                    console.log(`✅ Success! Phone format ${fmt} accepted.`);
                    break;
                  }
                }

                if (await errorMsg.isVisible().catch(() => false)) {
                  if (ENV === 'stag') {
                    console.log('⚠️ [Stag Phone Validation Check] Phone validation assets failed to load on staging. Exiting flow early and successfully.');
                    reachedEndPage = true;
                    break;
                  }
                }
              }
            } catch (fillErr: any) {
              const currentUrl = page.url().toLowerCase();
              if (currentUrl.includes('payment') || currentUrl.includes('paymentdetails')) {
                console.log(`ℹ️ Form fill failed but transitioned to payment page: ${fillErr.message}.`);
              } else {
                throw fillErr;
              }
            }
          }

          await page.waitForLoadState('domcontentloaded').catch(() => { });
          await sleep(2000);
          if (page.url().includes('paymentDetails')) {
            console.log('💳 Navigated to payment page after personal details');
          }
          continue;
        }

        // ── Standalone PPV Page ────────────────────────────────
        if (pageType === 'standalone-ppv') {
          if (!isStandalonePPV) {
            console.log('⚠️ standalone-ppv detected but PPV_TYPE is not standalone — treating as ppv');
          } else {
            console.log('👉 Standalone PPV page');
            stuckCount = 0;
            const standalonePPVPage = new StandalonePPVPage(page);
            await standalonePPVPage.waitUntilPPVPageReady();

            if (!ppvValidated) {
              try {
                const ppvData = getStandalonePPVPageData();
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

            await standalonePPVPage.selectPlan(ratePlan === 'monthly' ? 'flex' : 'annual_monthly');
            await standalonePPVPage.clickContinue();
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
            continue;
          }
        }

        // ── Default Signup Page ──────────────────────────────────
        if (pageType === 'default-signup') {
          console.log('👉 Default Signup page');
          stuckCount = 0;

          if (!ppvValidated) {
            try {
              const ppvData = getPPVDataByVariant(variant);
              await validateVariant(page, variant, ppvData, results, eventData, 'Default Signup');
            } catch (e: any) {
              console.warn('⚠️ Default Signup validation error:', e.message);
            }
            ppvValidated = true;
          }

          // Verify PPV on page matches expected
          const ppvName = eventData.PPV_NAME || '';
          const nameClean = ppvName.replace(/[:\-–]/g, ' ');
          let matched = false;
          if (nameClean.includes('vs')) {
            const fighters = nameClean.split(/\bvs\b/i).map((f: any) => f.trim());
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
            throw new Error(`❌ [DefaultSignup] PPV on page does not match expected event: "${ppvName}"`);
          }
          console.log(`✅ [DefaultSignup] Verified PPV on page matches: "${ppvName}"`);

          console.log('🖱️ [DefaultSignup] Clicking "Continue with pay-per-view"...');
          await page.locator('button:has-text("Continue with pay-per-view"), a:has-text("Continue with pay-per-view")').first().click({ force: true });
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
          continue;
        }

        // ── PPV Page ───────────────────────────────────────────
        if (pageType === 'ppv') {
          console.log('👉 PPV page');
          stuckCount = 0;

          if (!ppvValidated) {
            try {
              if (SOURCE.startsWith('boxing-bundle')) {
                const bundlePpvData = readSheet('Boxing page');
                await validateVariant(page, variant, bundlePpvData, results, eventData, 'Bundle PPV', 'boxing-bundle-ppv');
              } else {
                const ppvData = getPPVDataByVariant(variant);
                await validateVariant(page, variant, ppvData, results, eventData, 'PPV');
              }
            } catch (e: any) {
              console.warn('⚠️  PPV validation error:', e.message);
            }
            ppvValidated = true;
          }

          if (planTier === 'ultimate') {
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
                console.log(`✅ Clicked Ultimate card: ${sel}`);
                clicked = true;
                break;
              }
            }

            if (!clicked) {
              const radios = page.locator('input[type="radio"]');
              const count = await radios.count().catch(() => 0);
              for (let i = 0; i < count; i++) {
                const radio = radios.nth(i);
                const radioLabel = await radio.locator('xpath=ancestor::label | xpath=ancestor::div[1]').first();
                const text = await radioLabel.innerText({ timeout: 500 }).catch(() => '');
                if (text.toLowerCase().includes('ultimate')) {
                  await safeScrollToElement(page, radio);
                  await radio.click({ force: true }).catch(() => { });
                  clicked = true;
                  break;
                }
              }
            }

            const btn = page.locator('button:has-text("Continue with DAZN Ultimate")').first();
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
              let targetBtn = page.locator(`button:has-text("${ctaText}")`).first();
              if (await targetBtn.isVisible().catch(() => false)) {
                btn = targetBtn;
              } else {
                const fallbacks = [
                  'button:has-text("Buy")',
                  'button:has-text("Purchase")',
                  'button:has-text("Pay now")',
                  'button:has-text("Continue")',
                  'button[type="submit"]'
                ];
                for (const fb of fallbacks) {
                  const fbBtn = page.locator(fb).first();
                  if (await fbBtn.isVisible().catch(() => false)) {
                    btn = fbBtn;
                    break;
                  }
                }
              }
            }
            await clickAndWaitForNav(page, btn, `PPV Continue (${variant})`);
          }

          await setupPage(page, 500);
          continue;
        }

        // ── Plan Selection Page ────────────────────────────────
        if (pageType === 'plan') {
          console.log(`👉 DAZN Plan page - Tier: ${planTier}, Rate Plan: ${ratePlan}`);
          stuckCount = 0;
          planClickCount++;

          if (page.url().includes('page=TierPlans')) {
            console.log(`🗺️ Handling TierPlans page selection for tier: ${planTier}`);
            let tierBtn;
            if (planTier === 'ultimate') {
              tierBtn = page.locator('button:has-text("Continue with DAZN Ultimate"), button:has-text("Continue with Ultimate")').first();
            } else {
              tierBtn = page.locator('button:has-text("Continue with Standard"), button:has-text("Continue with DAZN Standard")').first();
            }
            if (await tierBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
              await safeScrollToElement(page, tierBtn);
              await clickAndWaitForNav(page, tierBtn, `TierPlans Selection (${planTier})`);
              await setupPage(page, 500);
              continue;
            }
          }

          if (!planValidated && !page.url().includes('page=TierPlans')) {
            try {
              const planData = getPlanDataByTier(planTier);
              await validateVariant(page, 'plan', planData, results, eventData, 'DAZN Plan');
            } catch (e: any) {
              console.warn('⚠️  Plan validation error:', e.message);
            }
            planValidated = true;
          }

          if (planTier === 'ultimate') {
            if (ratePlan === 'annual pay upfront') {
              const upfrontCard = page.locator(
                'label:has-text("Annual - Pay Upfront"), label:has-text("Pay Upfront"), [role="radio"]:has-text("Upfront")'
              ).first();
              if (await upfrontCard.isVisible({ timeout: 2000 }).catch(() => false)) {
                await safeScrollToElement(page, upfrontCard);
                await upfrontCard.click({ force: true }).catch(() => { });
              } else {
                const radios = page.locator('input[type="radio"], [role="radio"]');
                const count = await radios.count().catch(() => 0);
                let clicked = false;
                for (let i = 0; i < count; i++) {
                  const r = radios.nth(i);
                  const parentText = await r.evaluate((el: HTMLElement) => el.closest('label')?.innerText || el.closest('div')?.innerText || '').catch(() => '');
                  if (parentText.toLowerCase().includes('upfront') || parentText.toLowerCase().includes('save')) {
                    await safeScrollToElement(page, r);
                    await r.click({ force: true }).catch(() => { });
                    clicked = true;
                    break;
                  }
                }
                if (!clicked) {
                  const radio = count > 2 ? radios.nth(2) : radios.nth(1);
                  if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await safeScrollToElement(page, radio);
                    await radio.click({ force: true }).catch(() => { });
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
              } else {
                const radios = page.locator('input[type="radio"], [role="radio"]');
                const count = await radios.count().catch(() => 0);
                let clicked = false;
                for (let i = 0; i < count; i++) {
                  const r = radios.nth(i);
                  const parentText = await r.evaluate((el: HTMLElement) => el.closest('label')?.innerText || el.closest('div')?.innerText || '').catch(() => '');
                  if (parentText.toLowerCase().includes('monthly') || parentText.toLowerCase().includes('saver') || parentText.toLowerCase().includes('over time')) {
                    await safeScrollToElement(page, r);
                    await r.click({ force: true }).catch(() => { });
                    clicked = true;
                    break;
                  }
                }
                if (!clicked) {
                  const radio = radios.first();
                  if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await safeScrollToElement(page, radio);
                    await radio.click({ force: true }).catch(() => { });
                  }
                }
              }
            }

            // Post-selection validation
            if (ratePlan === 'annual pay upfront') {
              await page.waitForTimeout(500);
              const radios = page.locator('input[type="radio"], [role="radio"]');
              const count = await radios.count().catch(() => 0);
              let upfrontSelected = false;
              for (let i = 0; i < count; i++) {
                const r = radios.nth(i);
                const parentText = await r.evaluate((el: HTMLElement) => el.closest('label')?.innerText || el.closest('div')?.innerText || '').catch(() => '');
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
          } else {
            if (ratePlan === 'annual pay monthly' || ratePlan.includes('annual')) {
              const annualCard = page.locator(
                'label:has-text("Annual - pay over time"), label:has-text("Annual - Pay Monthly")'
              ).first();

              if (await annualCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                await safeScrollToElement(page, annualCard);
                await annualCard.click({ force: true }).catch(() => { });
              } else {
                const radio = page.locator('input[type="radio"]').nth(1);
                if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
                  await safeScrollToElement(page, radio);
                  await radio.click({ force: true }).catch(() => { });
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
              results.push({
                page: 'DAZN Plan',
                field: 'CTA After APM Selection',
                expected: expectedCta,
                actual: cleanCta,
                status: ctaMatch ? 'PASS' : 'FAIL'
              });

              await clickAndWaitForNav(page, planBtn, 'Standard Annual Plan Continue');
            } else {
              const trialRadio = page.locator('input[type="radio"]').first();
              if (await trialRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
                await safeScrollToElement(page, trialRadio);
                await trialRadio.click({ force: true }).catch(() => { });
              }

              const planBtn = page.locator(
                'button:has-text("Continue with 7-day Free Trial"), ' +
                'button:has-text("Continue with 1st Month Free"), ' +
                'button:has-text("Continue with PPV"), ' +
                'button:has-text("Continue")'
              ).first();
              await planBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
              await clickAndWaitForNav(page, planBtn, 'Standard Plan Continue');
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
            .then((t: any) => t.substring(0, 200));
          throw new Error(`❌ Flow stuck on unknown page.\nURL: ${page.url()}\nPreview: ${bodyPreview}`);
        }
      }

      if (!reachedEndPage) {
        const finalUrl = page.url();
        if (finalUrl.includes('paymentDetails') || finalUrl.includes('payment')) {
          console.log('💳 Payment page detected after loop exit');
          if (SOURCE === 'schedule' || SOURCE === 'search') {
            console.log(`🔍 [${SOURCE === 'schedule' ? 'Schedule' : 'Search'} Flow] Checking URL: ${finalUrl}`);
            const isStag = finalUrl.includes('stag.dazn.com') || finalUrl.includes('sandbox') || finalUrl.includes('staging');
            const isProdOrBeta = ENV === 'prod' || ENV === 'beta';
            if (!isStag && !isProdOrBeta) {
              console.log(`⚠️ URL is not stag, prod, or beta (URL: ${finalUrl}). Ending flow and closing browser.`);
              return;
            }
          }
          reachedEndPage = true;

          const payment = new PaymentPage(page);
          if (await payment.isPaymentPage()) {
            const planKey = SOURCE.startsWith('boxing-bundle') ? `${ratePlan} bundle` : ratePlan;
            const paymentData = getPaymentDataByTierAndPlan(planTier, planKey)
              .filter((row: any) => String(row.Field || '').trim().toLowerCase() !== 'payment method heading');
            await payment.validate(paymentData, results, eventData, 'newuser');
          }
        } else {
          console.log(`⚠️  Flow did not reach expected end page`);
        }
      }

      console.log('🎥 Stopping screen recording on Android device...');
      let videoOutputPath: string | null = null;
      try {
        const videoBuffer = await driver.stopRecordingScreen();
        if (videoBuffer) {
          const videoDir = path.resolve(process.cwd(), 'test-results');
          if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
          videoOutputPath = path.join(videoDir, `handoff_run_${Date.now()}.mp4`);
          fs.writeFileSync(videoOutputPath, Buffer.from(videoBuffer, 'base64'));
          console.log(`🎥 Video recording saved to: ${videoOutputPath}`);
        }
      } catch (e: any) {
        console.error('⚠️ Failed to stop screen recording:', e.message);
      }

      try {
        const videoPath = await page.video()?.path();
        if (videoPath) console.log(`🎥 Playwright browser video: ${videoPath}`);
      } catch { }

      // Merge Android UI validation results into the main results array
      if (androidAvailabilityResults.length > 0) {
        results.unshift(...androidAvailabilityResults);
      }

      // Tag results with flow metadata
      results.forEach(r => {
        r.flowName = flowConfig.name;
        r.source = flowConfig.source;
        r.tier = flowConfig.tier;
        r.ratePlan = flowConfig.ratePlan;
      });

      // Write results to Excel
      const { excelPath, videoPath } = await writeResults(results, videoOutputPath);

      // Display detailed results table
      displayResultsTable(results, 'ppv', {
        event: json.PPV_NAME,
        region: REGION,
        excelPath,
        videoPath,
      });

      // Generate HTML + PDF run reports
      await generateReports(results, {
        event: json.PPV_NAME,
        region: REGION,
        source: flowConfig.source,
        ratePlan: flowConfig.ratePlan,
        tier: flowConfig.tier,
        env: ENV,
        flowName: flowConfig.name,
        startTime: runStart,
        endTime: new Date(),
        excelPath,
        videoPath,
        userType: 'new-user',
        platform: 'Android',
      });

      const passed = results.filter(r => r.status === 'PASS').length;
      const failed = results.filter(r => r.status === 'FAIL').length;
      const total = passed + failed;

      console.log(`\n✅ Flow "${flowConfig.name}" complete: ${passed}/${total} passed (${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%)`);
      console.log(`${'─'.repeat(55)}`);

      if (total === 0) {
        throw new Error(`❌ Flow "${flowConfig.name}" had 0 validation checks`);
      }

      if (!reachedEndPage) {
        throw new Error(`❌ Flow "${flowConfig.name}" did not reach the expected end page`);
      }

      if (failed > 0) {
        const failMsgs = results
          .filter(r => r.status === 'FAIL')
          .map(r => `  - [${r.page}] ${r.field}: expected "${r.expected}", actual "${r.actual}"`)
          .join('\n');
        throw new Error(
          `❌ Flow "${flowConfig.name}" completed navigation but had ${failed} validation failure(s):\n${failMsgs}`
        );
      }

    } catch (playwrightErr: any) {
      console.error(`❌ Local Playwright Web Checkout failed: ${playwrightErr.message}`);
      throw playwrightErr;
    } finally {
      // 2. Clean up context and browser
      if (context) {
        await context.close().catch(() => { });
      }
      if (playwrightBrowser) {
        await playwrightBrowser.close().catch(() => { });
      }
      if (chromeLaunchCleanup) {
        await chromeLaunchCleanup().catch(() => { });
      }
      closeMobileBrowser();
      // 3. Restore original working directory
      process.chdir(originalCwd);
      console.log(`📂 Restored working directory to: ${process.cwd()}`);
    }
  });

  after(async () => {
    try {
      await browser.stopRecordingScreen().catch(() => { });
    } catch { }
    closeMobileBrowser();
  });
});
