// ─────────────────────────────────────────────────────────────────────────────
// DAZN PPV — iOS Appium Existing User Test
//
// DEVICE: iOS Simulator / Real Device (configured in config/wdio.ios.conf.ts)
// EVENT:  Configurable via PPV_CONFIG env var
//
// FLOW:
//   1. DAZN app opens (already logged in, noReset=true)
//   2. Dismisses system alerts (ATT, notifications) & landing page interstitials
//   3. Pre-login flow (if My Account source):
//      - Navigate to signin page
//      - Enter email and password
//      - Sign in
//      - Navigate to My Account
//   4. Navigate to PPV buy button based on SOURCE env var:
//        myaccount                → My Account → Find PPV → Buy
//        schedule                 → Bottom tab → Schedule → scroll to event → Buy
//        home-boxing-banner       → Home Boxing filter → Boxing page → hero banner → Buy
//        home-boxing-upcoming     → Home Boxing filter → Upcoming Fights → Buy
//        home-boxing-tile         → Home Boxing rail → Buy
//        home-page-dont-miss      → Home → Don't Miss rail → PPV tile → Buy
//        search                   → Search icon/tab → Search for event → Buy
//   5. App opens Safari View Controller or redirects to Safari
//   6. Captures URL via WebView context switch or Safari address bar fallback
//   7. Writes URL to mobile_entry_url.txt  ← Playwright reads this
//
// HOW TO RUN:
//   cd appium && npm run ios
//   Overrides: PPV_NAME="Joshua" SOURCE="myaccount" USER_STATE="active_standard" npm run ios
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
import { IOSMyAccountPage, openMyAccountPPVPaywall, preLoginFlow as sharedPreLoginFlow } from '../../pages/ios/IOSMyAccountPage';
import { openHomeBannerPaywall, openGenericPPVPaywall, openHomePageDontMissPaywall, openHomePagePopupPaywall, openHomePageSubscribePaywall, openDaznTilePaywall } from '../../pages/ios/IOSHomePage';
import { openLandingBannerPaywall } from '../../pages/ios/IOSLandingPage';
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
import { getIOSBrowserReentry, getIOSSurfacingPoint, getIOSValidationSheet } from '../../pages/ios/IOSSurfacingPoint';
import {
  validateMobilePaywallPage,
  validateMobileBannerOrTilePage,
  validateUltimateFixtureOrPreviewNavigationPage,
  IOSValidationResult,
} from '../../pages/ios/IOSValidationPage';


// ── Config ───────────────────────────────────────────────────────────────────
const event: EventConfig = loadEventConfig();
const PPV_NAME = event.PPV_NAME;
process.env.PPV_NAME = PPV_NAME;
const SCHEDULE_PPV_TITLE = event.PPV_NAME;
const SOURCE: string = (process.env.SOURCE || 'myaccount').trim().toLowerCase();
const USER_STATE = process.env.USER_STATE || 'active_standard_monthly';
process.env.USER_STATE = USER_STATE;
const MODE = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase();
const BUNDLE_ID = process.env.DAZN_BUNDLE_ID || (MODE === 'real' ? 'com.dazn.theApp' : 'com.dazn.enterprise');
const REGION = process.env.DAZN_REGION || 'GB';
const LOGIN_FIRST = (process.env.LOGIN_FIRST || process.env.LOGIN || '').toLowerCase() === 'true';
const LOGIN_FIRST_INVALID_LANDING_SOURCES = new Set<string>([
  'landing-page-banner',
]);

let USER_EMAIL = process.env.USER_EMAIL || '';
let USER_PASSWORD = process.env.USER_PASSWORD || '';

// Dynamically resolve credentials matching the web flow
if (!USER_EMAIL || !USER_PASSWORD) {
  try {
    const fs = require('fs');
    const path = require('path');
    const originalCwd = process.cwd();
    const projectRoot = path.resolve(__dirname, '../../..');
    process.chdir(projectRoot);

    const { buildEventData } = require('../../../utils/buildEventData');
    const { loadEventConfig } = require('../../../utils/testHelpers');
    const eventConfig = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
    const eventJson = loadEventConfig(eventConfig);
    const eventData = buildEventData(eventJson, REGION);
    USER_EMAIL = eventData.USER_EMAIL || '';
    USER_PASSWORD = eventData.USER_PASSWORD || '';
    console.log(`🔑 Resolved credentials from config: ${USER_EMAIL}`);

    process.chdir(originalCwd);
  } catch (e: any) {
    console.warn('⚠️ Failed to resolve credentials from config:', e.message);
  }
}

// If still missing, try reading directly from userstatus.json (avoids loadEventConfig dependency)
if (!USER_EMAIL || !USER_PASSWORD) {
  try {
    const fs = require('fs');
    const path = require('path');
    const statusPath = path.resolve(__dirname, '../../../config/userstatus.json');
    const userStatuses = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    const state = userStatuses[USER_STATE];
    const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
    const regionBlock = state?.regions?.[REGION] ?? state?.regions?.UK ?? {};
    const envBlock = regionBlock?.environments?.[env] ?? {};
    USER_EMAIL = USER_EMAIL || envBlock.USER_EMAIL || regionBlock.USER_EMAIL || '';
    USER_PASSWORD = USER_PASSWORD || envBlock.USER_PASSWORD || regionBlock.USER_PASSWORD || '';
    if (USER_EMAIL) console.log(`🔑 Resolved credentials from userstatus.json: ${USER_EMAIL}`);
  } catch (e: any) {
    console.warn('⚠️ Failed to read userstatus.json:', e.message);
  }
}

// Write resolved credentials back to process.env so page objects can read them
if (USER_EMAIL) process.env.USER_EMAIL = USER_EMAIL;
if (USER_PASSWORD) process.env.USER_PASSWORD = USER_PASSWORD;

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
async function scrollDown(driver: WdBrowser): Promise<void> {
  return sharedScrollDown(driver);
}

const iosAvailabilityResults: IOSValidationResult[] = [];
let iosAvailabilityReportGenerated = false;

function iosAvailabilityPageName(source = SOURCE): string {
  if (source.includes('landing')) return 'Landing';
  if (source.includes('schedule')) return 'Schedule';
  if (source.includes('search')) return 'Search';
  if (source.includes('myaccount')) return 'My Account';
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
      flowName: `iOS ${USER_STATE}: ${srcLabel}`,
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
      flowName: `iOS ${USER_STATE}: ${srcLabel}`,
      startTime: new Date(),
      endTime: new Date(),
      excelPath,
      videoPath,
      userType: 'existing-user',
      userStatus: USER_STATE,
      platform: 'iOS',
    });
    console.log(`📊 iOS PPV availability failure report generated: ${errorMessage}`);
  } catch (reportErr: any) {
    console.error(`⚠️ Failed to generate iOS availability failure report: ${reportErr.message}`);
  } finally {
    process.chdir(originalCwd);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST
// ════════════════════════════════════════════════════════════════════════════
describe('DAZN iOS PPV — Existing User Flow', () => {
  before(async () => {
    if (SOURCE === 'home-page-popup' && !LOGIN_FIRST) {
      throw new Error('SOURCE="home-page-popup" requires LOGIN_FIRST=true for existing iOS users.');
    }
    if (SOURCE === 'home-page-subscribe' && (USER_STATE.toLowerCase() !== 'freemium' || !LOGIN_FIRST)) {
      throw new Error('SOURCE="home-page-subscribe" requires USER_STATE="freemium" and LOGIN_FIRST=true.');
    }
    clearHandoffUrl();
    require('fs').mkdirSync('./test-results', { recursive: true });
    console.log(`\n╔════════════════════════════════════════════════════╗`);
    console.log(`║  DAZN iOS PPV — Existing User                     ║`);
    console.log(`║  Event  : ${PPV_NAME.padEnd(40)}║`);
    console.log(`║  Source : ${SOURCE.padEnd(40)}║`);
    console.log(`║  User   : ${USER_STATE.padEnd(40)}║`);
    console.log(`╚════════════════════════════════════════════════════╝\n`);

    await startIOSRecording(browser);

    const isLandingPageBanner = SOURCE === 'landing-page-banner';
    await prepareIosApp(browser, {
      clearAppData: false, // iOS simulator/real devices preserve cache
      acceptCookiesOnly: LOGIN_FIRST || isLandingPageBanner || undefined,
      waitForHome: !LOGIN_FIRST && !isLandingPageBanner,
    });
  });

  it('navigates to PPV buy button as existing user, opens Safari, captures checkout URL', async () => {
    const driver = browser;
    const baseUrl = 'https://www.dazn.com';

    console.log('✅ Startup handled by prepareIosApp; beginning existing-user PPV navigation');

    let buyTapped = false;
    let paywallValidated = false;
    const paywallValidatedRef = { value: false };

    const isMyAccount = SOURCE === 'myaccount' || SOURCE === 'myaccount-subscription-status';
    const appiumResults: any[] = [];

    const fs = require('fs');
    const path = require('path');
    const { buildEventData } = require('../../../utils/buildEventData');
    const { loadEventConfig } = require('../../../utils/testHelpers');
    const EVENT_CONFIG = process.env.PPV_CONFIG || 'ppv_t_joshua_prenga.json';
    const PLAN = process.env.PLAN || 'standard_monthly';
    const json = loadEventConfig(EVENT_CONFIG, PLAN);
    const plansPath = path.resolve(__dirname, '../../..', 'config/DaznPlan.json');
    const plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
    const planData = plans[PLAN] || { TIER: 'standard', RATE_PLAN: 'monthly' };
    const planTier = (planData.TIER || 'standard').toLowerCase();
    const ratePlan = (planData.RATE_PLAN || 'monthly').toLowerCase();
    const isStandalonePPV = String(json.PPV_TYPE || process.env.PPV_TYPE || '').toLowerCase() === 'standalone';
    if (isStandalonePPV && (planTier === 'ultimate' || !['monthly', 'annual pay monthly'].includes(ratePlan))) {
      throw new Error(
        `Standalone PPV supports only Standard monthly or Annual Pay Monthly plans; received "${PLAN}".`,
      );
    }
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

    const eventData = buildEventData(json, REGION, planTier, ratePlan.replace(/-/g, ' '), SOURCE);

    if (LOGIN_FIRST && LOGIN_FIRST_INVALID_LANDING_SOURCES.has(SOURCE)) {
      throw new Error(
        `❌ LOGIN_FIRST=true is not compatible with SOURCE="${SOURCE}". Landing page flows require a non-logged-in user.`,
      );
    }
    // Merge mobile overrides
    try {
      let mobileConfigPath = path.resolve(__dirname, '../../config/events', EVENT_CONFIG);
      if (!fs.existsSync(mobileConfigPath) && json.eventKey) {
        mobileConfigPath = path.resolve(__dirname, '../../config/events', `${json.eventKey}.json`);
      }
      if (fs.existsSync(mobileConfigPath)) {
        const mobileJson = JSON.parse(fs.readFileSync(mobileConfigPath, 'utf8'));
        // Merge top-level fields (e.g. SPORT) from mobile config
        if (mobileJson.SPORT) eventData.SPORT = mobileJson.SPORT;
        if (mobileJson.PPV_ENTITLEMENT_ID) eventData.PPV_ENTITLEMENT_ID = mobileJson.PPV_ENTITLEMENT_ID;
        const mobileRegional = mobileJson.regions?.[REGION] || {};
        Object.assign(eventData, mobileRegional);
        console.log(`📱 Loaded mobile-specific overrides from ${mobileConfigPath}`);
      } else {
        console.warn(`⚠️ Mobile config override file not found: ${EVENT_CONFIG}`);
      }
    } catch (e: any) {
      console.warn(`⚠️ Failed to load mobile overrides: ${e.message}`);
    }

    // validateMobilePaywall
    async function validateMobilePaywall() {
      await validateMobilePaywallPage(driver, eventData, SOURCE, iosAvailabilityResults, paywallValidatedRef);
      paywallValidated = paywallValidatedRef.value;
    }

    // validateMobileBannerOrTile
    async function validateMobileBannerOrTile(surface: 'PPV Banner' | 'PPV Tile') {
      await validateMobileBannerOrTilePage(driver, surface, eventData, SOURCE, iosAvailabilityResults);
    }

    async function validateFixtureOrPreviewNavigation() {
      await validateUltimateFixtureOrPreviewNavigationPage(driver, eventData, iosAvailabilityResults);
    }

    // ── Pre-Login Phase ───────────────────────────────────────────────────
    if (isMyAccount || LOGIN_FIRST) {
      if (!USER_EMAIL || !USER_PASSWORD) {
        throw new Error(
          `LOGIN_FIRST requires USER_EMAIL and USER_PASSWORD. No credentials resolved for USER_STATE="${USER_STATE}"`,
        );
      }
      await sharedPreLoginFlow(driver, baseUrl, { email: USER_EMAIL, password: USER_PASSWORD });
      console.log('🔍 Waiting for post-login cleanup...');
      await waitForHomePage(driver, 120000, { preservePpvPopup: SOURCE === 'home-page-popup' });
    }

    const iosFlowHooks: IOSFlowHooks = {
      validateSurface: validateMobileBannerOrTile,
      validatePaywall: validateMobilePaywall,
      validateFixtureOrPreview: validateFixtureOrPreviewNavigation,
      recordAvailability: recordIOSPPVAvailability,
      saveScreenshot: (relativePath) => saveIOSScreenshot(driver, relativePath),
      generateAvailabilityFailureReport: generateIOSAvailabilityFailureReport,
    };

    if (SOURCE === 'home-page-popup' && USER_STATE.toLowerCase().trim().startsWith('active_ultimate')) {
      console.log('⏭️ SOURCE="home-page-popup" is not applicable to active Ultimate users; skipping checkout cleanly.');
      return;
    }

    // ── myaccount ─────────────────────────────────────────────────────────
    if (isMyAccount) {
      const myAccountPage = new IOSMyAccountPage(driver, PPV_NAME);
      const ppvStatus = await myAccountPage.getPPVStatus(PPV_NAME);
      if (ppvStatus === 'Purchased' || ppvStatus === 'Included') {
        console.log(`\n✅ [Already Purchased] PPV "${PPV_NAME}" status: ${ppvStatus}`);
        console.log('   Skipping buy flow — PPV is already owned by this user.');

        const imagePresent = await myAccountPage.hasPPVImage(PPV_NAME);
        appiumResults.push({
          page: 'My Account',
          field: 'PPV Image Present',
          expected: 'Yes',
          actual: imagePresent ? 'Yes' : 'No',
          status: imagePresent ? 'PASS' : 'FAIL',
        });

        const title = await myAccountPage.getPPVName(PPV_NAME);
        const expectedTitle = eventData.PPV_NAME || PPV_NAME;
        const titleStatus = title.toLowerCase().includes(expectedTitle.toLowerCase()) ? 'PASS' : 'FAIL';
        appiumResults.push({
          page: 'My Account',
          field: 'PPV Title',
          expected: expectedTitle,
          actual: title,
          status: titleStatus,
        });

        const dateTime = await myAccountPage.getPPVDate(PPV_NAME);
        appiumResults.push({
          page: 'My Account',
          field: 'PPV Date & Time',
          expected: eventData.PPV_DATE || '',
          actual: dateTime,
          status: dateTime !== 'N/A' ? 'PASS' : 'FAIL',
        });

        buyTapped = true;
      } else {
        console.log(`\n🛒 PPV "${PPV_NAME}" not yet purchased (status: ${ppvStatus}) — proceeding with buy flow`);
        buyTapped = await openMyAccountPPVPaywall(driver, PPV_NAME, iosFlowHooks);
      }
    }
    // ── schedule ────────────────────────────────────────────────────────────
    else if (SOURCE === 'schedule') {
      buyTapped = await openSchedulePPVPaywall(driver, PPV_NAME, eventData, iosFlowHooks);
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
          }
        }
      } catch {}

      if (searchQuery.includes(':')) {
        searchQuery = searchQuery.split(':').pop()?.trim() || searchQuery;
      }
      searchQuery = searchQuery.replace(/\./g, '');
      buyTapped = await openSearchResultPaywall(driver, PPV_NAME, searchQuery, iosFlowHooks, eventData);
    }
    // ── home-boxing-upcoming ──────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-upcoming') {
      buyTapped = await openHomeBoxingUpcomingPaywall(driver, PPV_NAME, event, iosFlowHooks);
    }
    // ── home-boxing-banner ────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-banner') {
      buyTapped = await openHomeBoxingBannerPaywall(driver, PPV_NAME, event, iosFlowHooks);
    }
    // ── home-boxing-tile ──────────────────────────────────────────────────
    else if (SOURCE === 'home-boxing-tile') {
      buyTapped = await openHomeBoxingDontMissTilePaywall(driver, PPV_NAME, event, iosFlowHooks);
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
    else if (SOURCE === 'home-page-subscribe') {
      buyTapped = await openHomePageSubscribePaywall(driver);
    }
    // ── landing-page-banner ───────────────────────────────────────────────
    else if (SOURCE === 'landing-page-banner') {
      buyTapped = await openLandingBannerPaywall(driver, PPV_NAME, iosFlowHooks);
    }
    // ── home-page-dazntile / subscribe-without-pay-per-view ──────────────
    else if (SOURCE === 'home-page-dazntile' || SOURCE === 'subscribe-without-pay-per-view') {
      buyTapped = await openDaznTilePaywall(driver, iosFlowHooks);
    }
    // A source-specific iOS run must never silently switch to a Home flow.
    else {
      throw new Error(`Unsupported iOS SOURCE="${SOURCE}". No fallback navigation is allowed.`);
    }

    if (!buyTapped) {
      await driver.saveScreenshot('./test-results/ios_buy_not_found.png');
      throw new Error(`❌ Could not tap Buy CTA. SOURCE="${SOURCE}". See test-results/ios_buy_not_found.png`);
    }

    const isUltimateLoginFirstNativeEndFlow =
      ['home-page-banner', 'home-boxing-banner', 'schedule', 'search', 'home-boxing-upcoming', 'home-boxing-tile', 'home-page-dont-miss'].includes(SOURCE) &&
      USER_STATE.toLowerCase().trim().startsWith('active_ultimate') &&
      LOGIN_FIRST;
    if (isUltimateLoginFirstNativeEndFlow) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] Native source validated. Ending iOS existing-user case before checkout handoff.');
      const { writeResults } = require('../../../utils/excelWriter');
      const { displayResultsTable } = require('../../../utils/resultsDisplay');
      const { generateReports } = require('../../../utils/reportGenerator');
      const videoOutputPath = await stopIOSRecording(browser);
      const { excelPath, videoPath } = await writeResults(iosAvailabilityResults, videoOutputPath);
      const srcLabel = SOURCE.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const formattedUserState = USER_STATE
        .split('_')
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      displayResultsTable(iosAvailabilityResults, 'ppv', {
        event: PPV_NAME,
        region: REGION,
        excelPath,
        videoPath,
      });
      await generateReports(iosAvailabilityResults, {
        event: PPV_NAME,
        region: REGION,
        source: SOURCE,
        ratePlan,
        tier: planTier,
        env: (process.env.DAZN_ENV || 'stag').toLowerCase(),
        flowName: `iOS ${formattedUserState}: ${srcLabel}`,
        startTime: new Date(),
        endTime: new Date(),
        excelPath,
        videoPath,
        userType: 'existing-user',
        userStatus: USER_STATE,
        platform: 'iOS',
      });
      const passed = iosAvailabilityResults.filter((r: any) => r.status === 'PASS').length;
      const failed = iosAvailabilityResults.filter((r: any) => r.status === 'FAIL').length;
      const total = passed + failed;
      console.log(`\n📊 iOS native flow complete: ${passed}/${total} passed, ${failed} failed`);
      if (failed > 0) {
        throw new Error(`❌ ${failed} of ${total} iOS native validation(s) failed. See report for details.`);
      }
      return;
    }

    // ── Step 3: Capture checkout URL from paywall screen ──────────────────
    console.log("📋 Capturing checkout URL from paywall...");
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
    console.log('\u2705 URL written to mobile_entry_url.txt');

    const safariContext = await openCapturedUrlInNewSafariTab(driver, checkoutUrl);

    // ── Safari-only Web Checkout Phase (mirrors newuserios.spec.ts) ──────────────────────
    // Do NOT terminate the app or launch a desktop Playwright browser.
    // Stay in the Safari WebView context and walk through sign-in, plan,
    // and payment pages — exactly as newuserios.spec.ts does for new users.
    const { configureExcelPathForEvent } = require('../../../utils/excelReader');
    configureExcelPathForEvent(json.eventKey || '');

    // Keep Safari validations in the shared accumulator so a later checkout
    // failure still produces a complete report instead of a native-only one.
    iosAvailabilityResults.push(...appiumResults);
    const safariResults = iosAvailabilityResults;
    const browserReentry = getIOSBrowserReentry(SOURCE);
    if (!browserReentry.supported) {
      throw new Error(
        `iOS Safari re-entry via welcome page is not yet verified for SOURCE="${SOURCE}". ` +
        `Add it to getIOSBrowserReentry() in IOSSurfacingPoint.ts once confirmed on device.`
      );
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
    const videoOutputPath = await stopIOSRecording(browser);
    const { excelPath, videoPath } = await writeResults(safariResults, videoOutputPath);

    const srcLabel = SOURCE.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const formattedUserState = USER_STATE
      .split('_')
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    displayResultsTable(safariResults, 'ppv', {
      event: PPV_NAME,
      region: REGION,
      excelPath,
      videoPath,
    });
    await generateReports(safariResults, {
      event: PPV_NAME,
      region: REGION,
      source: SOURCE,
      ratePlan,
      tier: planTier,
      env: (process.env.DAZN_ENV || 'stag').toLowerCase(),
      flowName: `iOS ${formattedUserState}: ${srcLabel}`,
      startTime: new Date(),
      endTime: new Date(),
      excelPath,
      videoPath,
      userType: 'existing-user',
      userStatus: USER_STATE,
      platform: 'iOS',
    });

    // Fail the test if any Safari web validation failed
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
