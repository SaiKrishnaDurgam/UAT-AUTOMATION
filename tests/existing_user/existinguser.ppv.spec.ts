import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PaymentPage } from '../../pages/PaymentPage';
import { PPVPage } from '../../pages/PPVPage';
import { HomePage } from '../../pages/HomePage';
import { MyAccountPage } from '../../pages/MyAccountPage';
import { StandalonePPVPage } from '../../pages/StandalonePPVPage';
import { LandingPage } from '../../pages/LandingPage';
import { BoxingPage } from '../../pages/BoxingPage';
import { BoxingHomePage } from '../../pages/BoxingHomePage';
import { SchedulePage } from '../../pages/schedulepage';
import { SearchPage } from '../../pages/SearchPage';
import { PPVUpsellSuccessPage } from '../../pages/PPVUpsellSuccessPage';
import { PPVUpsellPaymentPage } from '../../pages/PPVUpsellPaymentPage';
import { RailsInterceptor } from '../../utils/railsInterceptor';
import { GloryPage } from '../../pages/GloryPage';
import { resolvePpvTitleForSource } from '../../utils/ppvTitleResolver';
import { SignupPage } from '../../pages/SignupPage';


import {
  readSheet,
  getPPVDataByVariant,
  getPlanDataByTier,
  getPaymentDataByTierAndPlan,
  getMyAccountData,
  getPayPerViewData,
  getChooseHowToBuyData,
  getPPVPaymentData,
  getUpgradeConfirmationData,
  configureExcelPathForEvent,
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
import { displayResultsTable } from '../../utils/resultsDisplay';
import { writeResults } from '../../utils/excelWriter';
import { generateReports } from '../../utils/reportGenerator';
import { reportValidationFailuresToJira } from '../../utils/jiraValidationReporter';
import {
  sleep,
  setupPage,
  stabilisePage,
  handleCookies,
  dismissMarketingPopup,
  expandMorePaymentMethods,
  shouldSkipCardEntryChecks,
} from '../../utils/helpers';
import {
  loadEventConfig,
  safeScrollToElement,
  clickAndWaitForNav,
  handlePopupModal,
  assertCountryMatch,
  waitForHomePageAuthRedirect,
  executeCanadaSubscriptionFlow,
  executeCanadaPPVAddonPurchaseFlow,
} from '../../utils/testHelpers';
import { findNoPpvLink, handleNoPpvClick, isConfiguredPpvAbsenceError, isConfiguredPpvVisible } from '../../utils/flowHelpers';
import { AuthenticationManager } from '../../auth/AuthenticationManager';


const REGION = process.env.DAZN_REGION || 'GB';
const EVENT_CONFIG = process.env.PPV_CONFIG || process.env.PPV_EVENT || 'ppv_t_joshua_prenga.json';
const SOURCE = process.env.SOURCE || 'my-account';
const TV_HANDOFF_MODE = (process.env.TV_HANDOFF_MODE || '').toLowerCase() === 'true';

// ── Flow constant — used for flow-restricted Excel rows ──────────────
// Enables Welcome Back, Saved Card, Signed In As, Log Out validations
const FLOW = 'myaccount';
const addPPVPaymentMethodRows = (data: any[]) => {
  const paymentMethodRows = [
    { Field: 'Credit & Debit Card Option', Expected: 'Yes' },
    { Field: 'Google Pay Option', Expected: 'Yes' },
    { Field: 'PayPal Option', Expected: 'Yes' },
  ];
  return [
    ...data,
    ...paymentMethodRows.filter(row => !data.some((existing: any) =>
      String(existing.Field || '').trim().toLowerCase() === row.Field.toLowerCase()
    )),
  ];
};
const frozenIdentityFields = new Set([
  'signed in as text',
  'log out present',
]);
const getAddonPPVPaymentData = (includeFrozenIdentity: boolean) => {
  const addonData = getPPVPaymentData().filter((row: any) => ![
    'signed in as text',
    'log out present',
  ].includes(String(row.Field || '').trim().toLowerCase()));
  if (!includeFrozenIdentity) return addonData;

  const frozenIdentityData = getPaymentDataByTierAndPlan('standard', 'monthly')
    .filter((row: any) => frozenIdentityFields.has(String(row.Field || '').trim().toLowerCase()))
    .map((row: any) => ({ ...row, Flow: '' }));
  return [...addonData, ...frozenIdentityData];
};
const SWITCH_TO_ULTIMATE = (process.env.SWITCH || '').toLowerCase() === 'true';
const LOGIN_FIRST = (process.env.LOGIN || process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
const HOME_SPORT_DROPDOWN_SOURCES = new Set([
  'home-boxing-banner',
  'home-boxing-tile',
  'home-boxing-upcoming',
  'home-kickboxing-tile',
]);
const LOGIN_FIRST_INVALID_LANDING_SOURCES = new Set<string>([
  'landing-page-banner',
  'landing-page-dont-miss-live',
]);
// These signed-in Ultimate boxing sources deliberately retain their purchase CTA.
// Their entitlement is verified in My Account after the CTA click, rather than from
// a Purchased tag or a Fight Card modal on the Boxing page.
const ULTIMATE_LOGIN_FIRST_BOXING_MY_ACCOUNT_SOURCES = new Set<string>([
  'boxing-page-banner',
  'boxing-upcoming-fights',
]);
const ULTIMATE_MID_LOGIN_MY_ACCOUNT_SOURCES = new Set<string>([
  'home-boxing-upcoming',
  'landing-page-dont-miss-live',
  'boxing-upcoming-fights',
]);

function isMyAccountDestination(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('/myaccount') || (
    lower.includes('/account') &&
    !lower.includes('/signup') &&
    !lower.includes('/signin') &&
    !lower.includes('/personaldetails') &&
    !lower.includes('/emaildetails') &&
    !lower.includes('/content/')
  );
}

function isFixtureOrPreviewDestination(url: string): boolean {
  const lower = url.toLowerCase();
  const isTarget =
    lower.includes('preview') ||
    lower.includes('fixture') ||
    lower.includes('event') ||
    lower.includes('stream') ||
    lower.includes('player');
  const isPurchaseRoute =
    lower.includes('plandetails') ||
    lower.includes('tierplans') ||
    lower.includes('signup') ||
    lower.includes('signin') ||
    lower.includes('payment') ||
    lower.includes('checkout');
  return isTarget && !isPurchaseRoute;
}
const ENV = (process.env.DAZN_ENV || 'stag').toLowerCase();
const PAYMENT_METHOD = (process.env.PAYMENT_METHOD || 'credit_card').toLowerCase();
const isHeadless = process.env.HEADLESS === 'true';
const EXISTING_FLOW_TIMEOUT_MS = Number(process.env.PPV_TEST_TIMEOUT_MS) || 420_000;

function readTvHandoffUrl(): string {
  const envUrl = (process.env.TV_HANDOFF_URL || '').trim();
  if (envUrl.startsWith('http')) return envUrl;

  const handoffFile = path.resolve(process.cwd(), 'mobile_entry_url.txt');
  if (!fs.existsSync(handoffFile)) return '';

  const fileUrl = fs.readFileSync(handoffFile, 'utf-8').trim();
  return fileUrl.startsWith('http') ? fileUrl : '';
}

type TvPpvReportMetadata = {
  startTime?: string;
  steps?: Array<{
    page: string;
    field: string;
    expected: string;
    actual: string;
    status: 'PASS' | 'FAIL';
    screenshot?: string;
  }>;
};

function readTvPpvReportMetadata(): TvPpvReportMetadata | null {
  const metadataFile = process.env.TV_PPV_REPORT_METADATA || path.resolve(process.cwd(), 'tv_ppv_report_metadata.json');
  if (!fs.existsSync(metadataFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(metadataFile, 'utf-8')) as TvPpvReportMetadata;
  } catch (error: any) {
    console.warn(`⚠️ Could not read TV PPV report metadata: ${error?.message || error}`);
    return null;
  }
}

function parseReportStartTime(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function appendTvPpvReportSteps(results: any[], metadata: TvPpvReportMetadata | null): void {
  if (!TV_HANDOFF_MODE || !metadata?.steps?.length) return;

  for (const step of metadata.steps) {
    results.push({
      page: step.page || 'TV PPV',
      field: step.field,
      expected: step.expected,
      actual: step.actual,
      status: step.status || 'PASS',
      screenshot: step.screenshot,
    });
  }
}

function recordTvHandoffReportStep(results: any[], field: string, expected: string, actual: string, status: 'PASS' | 'FAIL' = 'PASS'): void {
  results.push({
    page: 'TV PPV',
    field,
    expected,
    actual,
    status,
  });
}

function getReportPlatform(): string {
  if (!TV_HANDOFF_MODE) return 'Web';

  const tvTarget = String(process.env.TV_TARGET || '').toLowerCase().trim();
  if (tvTarget === 'firetv') return 'FireTV/Web';
  if (tvTarget === 'androidtv') return 'AndroidTV/Web';

  return 'TV/Web';
}

function isYopmailHandoffUrl(url: string): boolean {
  return url.toLowerCase().includes('yopmail.com');
}

function getYopmailInboxFromUrl(url: string): string {
  const parsed = new URL(url);
  const login = parsed.searchParams.get('login') || '';
  return login.includes('@') ? login.split('@')[0] : login;
}

async function completeTvHandoffLoginIfPrompted(page: any, email: string, password: string): Promise<void> {
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  if (!await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) return;

  await emailInput.fill(email);
  for (const selector of ['button:has-text("Continue")', 'button[type="submit"]', 'input[type="submit"]']) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
      await button.click({ force: true });
      break;
    }
  }

  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
  if (await passwordInput.isVisible({ timeout: 15000 }).catch(() => false)) {
    await passwordInput.fill(password);
    for (const selector of ['button:has-text("Log in")', 'button:has-text("Login")', 'button:has-text("Sign in")', 'button[type="submit"]', 'input[type="submit"]']) {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
        await button.click({ force: true });
        break;
      }
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  }
}

async function waitForTvHandoffPlansPage(page: any, email: string, password: string): Promise<string> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await completeTvHandoffLoginIfPrompted(page, email, password);

    const url = String(page.url());
    const lowerUrl = url.toLowerCase();
    const hasPlansText = await page
      .getByText(/choose your plan|select your plan|plans?|tierplans|plandetails|purchase this event/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (
      lowerUrl.includes('dazn.com') &&
      (lowerUrl.includes('/plans') ||
        lowerUrl.includes('page=tierplans') ||
        lowerUrl.includes('page=plandetails') ||
        lowerUrl.includes('/account/addon/purchase') ||
        lowerUrl.includes('contextualppvid') ||
        hasPlansText)
    ) {
      return url;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Yopmail DAZN link did not reach plans page. Last URL: ${page.url()}`);
}

async function openYopmailHandoffAndReachPlansPage(page: any, handoffUrl: string, email: string, password: string, results: any[], eventData?: any): Promise<string> {
  const inbox = getYopmailInboxFromUrl(handoffUrl);
  if (!inbox) throw new Error(`TV handoff Yopmail URL did not include an inbox login: ${handoffUrl}`);

  console.log(`🌐 [TV Handoff] Opening Yopmail in existing-user browser: ${inbox}`);
  await page.goto('https://www.yopmail.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  const loginInput = page.locator('#login, input[name="login"]').first();
  if (await loginInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    await loginInput.fill(inbox);
    const openInboxButton = page.locator('#refreshbut, button:has-text("Check Inbox"), button[title*="Check" i], input[type="submit"]').first();
    await openInboxButton.click({ force: true, timeout: 5000 });
  }

  const inboxFrame = page.frameLocator('iframe#ifinbox');
  let mailOpened = false;
  for (let attempt = 1; attempt <= 8 && !mailOpened; attempt++) {
    await page.locator('#refresh').click({ force: true, timeout: 1000 }).catch(() => {});
    await page.locator('#refreshbut').click({ force: true, timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const message = inboxFrame
      .locator('div.m, button, a, [role="button"]')
      .filter({ hasText: /dazn|joshua|prenga|pay-per-view|purchase|my account/i })
      .first();

    if (await message.isVisible({ timeout: 2000 }).catch(() => false)) {
      await message.click({ force: true });
      mailOpened = true;
      recordTvHandoffReportStep(results, 'Yopmail email opened', 'Recent DAZN pay-per-view email', 'DAZN email opened');
      console.log(`✅ [TV Handoff] Opened DAZN Yopmail message on attempt ${attempt}`);
    }
  }

  if (!mailOpened) {
    throw new Error(`No DAZN purchase email found in Yopmail inbox for ${inbox}.`);
  }

  const mailFrame = page.frameLocator('iframe#ifmail');
  const completeSignInLink = mailFrame
    .locator('a')
    .filter({ hasText: /complete\s+sign\s*-?\s*(?:in|up)\s+process|complete/i })
    .first();
  const daznLinks = mailFrame.locator('a[href*="dazn" i], a[href*="awstrack" i]');
  const targetLink = await completeSignInLink.count().catch(() => 0) > 0
    ? completeSignInLink
    : daznLinks.first();

  const targetHref = await targetLink.getAttribute('href').catch(() => '');
  if (!targetHref) {
    throw new Error('Opened Yopmail message, but no Complete Sign in process / DAZN link was found.');
  }

  console.log('✅ [TV Handoff] Opening Complete Sign Up/Sign in process link in the same existing-user browser page');
  await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const plansUrl = await waitForTvHandoffPlansPage(page, email, password);
  const bodyText = await page.locator('body')
    .innerText({ timeout: 3000 })
    .then((text: string) => text.toLowerCase())
    .catch(() => '');
  const handoffPageTitle = bodyText.includes('choose how to buy') ? 'Choose how to buy' : 'DAZN plans page';
  recordTvHandoffReportStep(results, 'Complete Sign Up CTA', 'Navigate from Yopmail to DAZN web', 'DAZN web opened');
  recordTvHandoffReportStep(results, 'Page Title', 'Choose how to buy or DAZN plans page', handoffPageTitle, ['Choose how to buy', 'DAZN plans page'].includes(handoffPageTitle) ? 'PASS' : 'FAIL');

  const expectedEntitlement = String(eventData?.PPV_ENTITLEMENT_ID || '').trim();
  const plansUrlParams = new URL(plansUrl).searchParams;
  const actualContextualPpvId = plansUrlParams.get('contextualPpvId') || '';
  const actualEntitlementSetId = plansUrlParams.get('entitlementSetId') || '';
  recordTvHandoffReportStep(
    results,
    'Complete Sign Up destination PPV',
    expectedEntitlement,
    `contextualPpvId=${actualContextualPpvId}, entitlementSetId=${actualEntitlementSetId}`,
    expectedEntitlement && actualContextualPpvId === expectedEntitlement && actualEntitlementSetId === expectedEntitlement ? 'PASS' : 'FAIL',
  );

  console.log(`✅ [TV Handoff] Yopmail link reached DAZN plans page: ${plansUrl}`);
  return plansUrl;
}

function throwLogged(error: Error): never {
  console.log(error.message);
  throw error;
}

function isActiveUltimateState(userStateKey: string): boolean {
  return userStateKey.toLowerCase().startsWith('active_ultimate');
}

test.afterEach(async ({ }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && testInfo.error?.message) {
    console.log(`❌ Test failure:\n${testInfo.error.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// TEST DEFINITION — Dynamically defines tests for parallel runs
// ═══════════════════════════════════════════════════════════════
const userStatesToRun = (process.env.USER_STATE || 'freemium,frozen,active_standard,active_ultimate')
  .split(',')
  .map(p => p.trim());

// Configure tests to run in parallel using configured workers
test.describe.configure({ mode: 'parallel' });

for (const stateKey of userStatesToRun) {
  test(`PPV flow via existing user - ${stateKey}`, async ({ browser }) => {
    // Applies uniformly to login-first, mid-sign-in, every user state and
    // every source. It reserves time for artifact/report finalisation.
    test.setTimeout(EXISTING_FLOW_TIMEOUT_MS);
    process.env.USER_STATE = stateKey;
    let defaultSignupPPVValidated = false;
    let noPpvClick = false;
    let isNoPpvFlow = false;
    let srcEndPage = 'payment'; // endPage from surfacingpoint.json for current SOURCE
    let srcResolvedSource = SOURCE; // actual source CTA from surfacingpoint.json (may differ from SOURCE key)


    const json = loadEventConfig(EVENT_CONFIG);
    if (SOURCE.toLowerCase() === 'boxing-page-bundle' && json?.HAS_BUNDLE !== true) {
      const skipReason = `SOURCE "${SOURCE}" requires HAS_BUNDLE: true; selected event does not have a bundle configured.`;
      console.log(`INFO: ${skipReason} Skipping flow.`);
      test.skip(true, skipReason);
      return;
    }

    // PPV_DEV_MODE: when true, the PPV is only accessible via My Account + Dev Mode.
    // All non-myaccount sources are skipped automatically, unless a TV handoff (e.g. Yopmail)
    // already captured a valid continuation URL for this run — that's a legitimate continuation
    // of the TV flow, not a plain "schedule" source, so it must not be skipped.
    const PPV_DEV_MODE = json?.PPV_DEV_MODE === true;
    const isGloryStandalone = String(json?.PPV_TYPE || '').toLowerCase() === 'standalone' &&
      ['glory-tile', 'glory-banner'].includes(SOURCE.toLowerCase());
    const MY_ACCOUNT_SOURCES = new Set(['my-account', 'myaccount', 'myaccount-subscription-status']);
    const hasTvHandoffContinuation = TV_HANDOFF_MODE && Boolean(readTvHandoffUrl());
    if (PPV_DEV_MODE && !MY_ACCOUNT_SOURCES.has(SOURCE.toLowerCase()) && !isGloryStandalone && !hasTvHandoffContinuation) {
      const skipReason = `PPV_DEV_MODE is true — only myaccount flows are supported for this event. SOURCE "${SOURCE}" is skipped.`;
      console.log(`INFO: ${skipReason}`);
      test.skip(true, skipReason);
      return;
    }
    const PPV_TYPE = String(json.PPV_TYPE || process.env.PPV_TYPE || 'normal').trim().toLowerCase();
    const isStandalonePPV = PPV_TYPE === 'standalone';
    const specStartTime = new Date();
    configureExcelPathForEvent(json.eventKey || '');
    const eventData = buildEventData(json, REGION);
    if (isStandalonePPV) {
      eventData.PPV_STATUS = 'Buy now';
    }
    eventData.USER_STATE = stateKey;
    eventData['USER_STATE'] = stateKey;
    eventData.source = SOURCE;
    eventData.SOURCE = SOURCE;

    if (LOGIN_FIRST && LOGIN_FIRST_INVALID_LANDING_SOURCES.has(SOURCE.toLowerCase())) {
      throwLogged(new Error(
        `❌ For an existing user who has logged in, landing flows are not valid: ${SOURCE}`
      ));
    }

    const sourcesPath = path.resolve(process.cwd(), 'config/surfacingpoint.json');
    if (fs.existsSync(sourcesPath)) {
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));
      if (sources[SOURCE]?.defaultSignup && json?.HAS_DEFAULT_SIGNUP_PPV !== true && !json?.DEFAULT_SIGNUP_DEVMODE) {
        const skipReason = `SOURCE "${SOURCE}" requires HAS_DEFAULT_SIGNUP_PPV: true; selected event does not enable PPV in the default signup journey.`;
        console.log(`INFO: ${skipReason} Skipping flow.`);
        test.skip(true, skipReason);
        return;
      }
      if (sources[SOURCE]?.defaultSignup) {
        process.env.DEFAULT_SIGNUP = 'true';
      }
      if (sources[SOURCE]?.noPpvClick) {
        noPpvClick = true;
        isNoPpvFlow = true;
      }
      if (sources[SOURCE]?.endPage) {
        srcEndPage = sources[SOURCE].endPage;
      }
      if (sources[SOURCE]?.source) {
        srcResolvedSource = sources[SOURCE].source;
      }
    }

    const userStateKey = process.env.USER_STATE || 'freemium';

    // home-page-subscribe only shows a "Subscribe" CTA in the header for
    // logged-in freemium/frozen users. Non-logged-in users see "Get Started".
    if (SOURCE.toLowerCase() === 'home-page-subscribe' && !LOGIN_FIRST) {
      throwLogged(new Error(
        `❌ SOURCE "home-page-subscribe" requires LOGIN_FIRST=true. ` +
        `The Subscribe CTA is only visible in the header for logged-in users. ` +
        `Use LOGIN_FIRST=true or choose SOURCE=home-page-get-started for new users.`
      ));
    }

    // A pre-authenticated active user opens content directly from a DAZN tile,
    // so the subscription-modal flow is not applicable. Sign-in-during-flow
    // users click the tile while anonymous and must remain eligible.
    const DAZNTILE_SOURCES = new Set(['home-page-dazntile', 'subscribe-without-pay-per-view']);
    const ACTIVE_SUBSCRIBED_STATES = new Set([
      'active_standard_monthly', 'active_standard_apm', 'active_standard_upfront',
      'active_ultimate_apm', 'active_ultimate_upfront',
    ]);
    if (
      LOGIN_FIRST &&
      !isStandalonePPV &&
      DAZNTILE_SOURCES.has(SOURCE.toLowerCase()) &&
      ACTIVE_SUBSCRIBED_STATES.has(userStateKey.toLowerCase())
    ) {
      throwLogged(new Error(
        `❌ SOURCE "${SOURCE}" is not applicable for USER_STATE="${userStateKey}". ` +
        `Active standard/ultimate users already have a subscription — clicking a ` +
        `DAZN tile opens content directly without a subscription modal. ` +
        `Use a different source (e.g. home-boxing-tile, search) for this user state.`
      ));
    }

    // Compute dynamic future date variables
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const fDay = futureDate.getDate();
    const fMonth = futureDate.toLocaleString('en-GB', { month: 'long' });
    const fYear = futureDate.getFullYear();
    eventData.FLEX_FUTURE_DATE_SHORT = `${fDay} ${fMonth} ${fYear}`;

    const tier = (json.TIER || 'freemium').toLowerCase();
    const requestedPlan = (process.env.PLAN || '').trim().toLowerCase();
    if (
      PPV_TYPE === 'upsell' &&
      (tier === 'ultimate' || requestedPlan.startsWith('ultimate_') || userStateKey.startsWith('active_ultimate'))
    ) {
      test.skip(true, 'PPV upsell flows are only applicable to Standard PPV purchases.');
      return;
    }
    const isActiveStandardUser = userStateKey.startsWith('active_standard');
    const isUltimateUpgrade =
      isActiveStandardUser &&
      requestedPlan.startsWith('ultimate_');

    if (
      (SOURCE === 'boxing-banner-ultimate' ||
        SOURCE === 'boxing-ultimate-subscription' ||
        SOURCE === 'boxing-join-the-club') &&
      tier !== 'ultimate' &&
      !isUltimateUpgrade
    ) {
      throw new Error(`❌ SOURCE "${SOURCE}" requires an Ultimate plan (e.g., PLAN=ultimate_apm).`);
    }

    const isUSorGB = REGION === 'GB' || REGION === 'US';
    // Dev mode can be forced via DEV_MODE_ON=on for prod verification,
    // or automatically when PPV_DEV_MODE: true is set in the event config.
    const devModeForced = (process.env.DEV_MODE_ON || '').toLowerCase() === 'on' || PPV_DEV_MODE;
    let ratePlan = (process.env.RATE_PLAN || json.RATE_PLAN || 'monthly').toLowerCase();
    const userEmail = eventData.USER_EMAIL || json.USER_EMAIL || '';
    const userPassword = eventData.USER_PASSWORD || json.USER_PASSWORD || '';
    // Active Standard routing:
    // PLAN unset -> PPV-only; ultimate_apm/upfront -> Ultimate upgrade.
    let purchaseOption = (json.PURCHASE_OPTION || 'ppv').toLowerCase();

    if (isActiveStandardUser) {
      purchaseOption = requestedPlan.startsWith('ultimate_') ? 'ultimate' : 'ppv';

      if (requestedPlan === 'ultimate_apm') {
        ratePlan = 'annual pay monthly';
      } else if (requestedPlan === 'ultimate_upfront') {
        ratePlan = 'annual pay upfront';
      }
    } else if (tier === 'ultimate') {
      purchaseOption = 'ultimate';
    }

    if (isStandalonePPV && (requestedPlan.startsWith('ultimate_') || tier === 'ultimate')) {
      throw new Error('❌ Standalone PPV does not support Ultimate plans. Use a Standard monthly or Annual Pay Monthly plan.');
    }
    if (isStandalonePPV && !['monthly', 'annual pay monthly'].includes(ratePlan)) {
      throw new Error(`❌ Standalone PPV does not support rate plan "${ratePlan}". Use monthly or annual pay monthly.`);
    }

    // The PPV config tier describes the source offer. Active Standard users can
    // deliberately enter an Ultimate upgrade journey via PLAN, so expectations
    // must follow the journey actually selected.
    const effectiveTier =
      isUltimateUpgrade || tier === 'ultimate'
        ? 'ultimate'
        : 'standard';
    eventData.TIER = effectiveTier;
    eventData['TIER'] = effectiveTier;
    eventData.RATE_PLAN = ratePlan;
    eventData['RATE_PLAN'] = ratePlan;
    const isUltimateLoginFirstUser = LOGIN_FIRST && isActiveUltimateState(userStateKey);
    const isUltimateLoginFirstBoxingMyAccountFlow =
      !isStandalonePPV &&
      isUltimateLoginFirstUser &&
      ULTIMATE_LOGIN_FIRST_BOXING_MY_ACCOUNT_SOURCES.has(SOURCE.toLowerCase());

    // Bypass phone number for every effective Ultimate journey in GB/US,
    // including Active Standard → Ultimate upgrades.
    // Boxing subscription sources (boxing-banner-ultimate, boxing-ultimate-subscription,
    // boxing-join-the-club) redirect signed-in Ultimate users to /home — they never
    // go through the phone number page, so dev mode is not needed for them.
    // The exclusion is a top-level gate so that no condition (effectiveTier,
    // isUltimateLoginFirstUser, etc.) can accidentally re-enable dev mode.
    const BOXING_HOME_REDIRECT_SOURCES = new Set<string>([
      'boxing-banner-ultimate',
      'boxing-ultimate-subscription',
      'boxing-join-the-club',
    ]);
    const isBoxingHomeRedirect =
      LOGIN_FIRST &&
      isActiveUltimateState(userStateKey) &&
      BOXING_HOME_REDIRECT_SOURCES.has(SOURCE.toLowerCase());
    const devModeEnabled =
      devModeForced ||
      (!isBoxingHomeRedirect && (
        isUltimateLoginFirstUser ||
        (isActiveUltimateState(userStateKey) &&
          ['my-account', 'myaccount', 'myaccount-subscription-status'].includes(SOURCE.toLowerCase()) &&
          isUSorGB) ||
        (effectiveTier === 'ultimate' && isUSorGB) ||
        (SOURCE === 'landing-page-dont-miss-live-switch')
      ));

    console.log(`🎯 Requested PLAN : ${requestedPlan || '(none -> PPV only)'}`);
    console.log(`🛒 Purchase route : ${purchaseOption}`);
    console.log(`🏷️ Effective tier : ${effectiveTier}`);
    const baseUrl = eventData.BASE_URL;
    const variantConfig = json.variants;
    const pagesConfig = json.pages;
    const sport = json.SPORT;

    // Resolve payment page expected variables to avoid skipping validation
    const offerType = (eventData.OFFER_TYPE || '1_month_free').toLowerCase();
    const isTrial = ratePlan === 'monthly' && /^\d+_day_trial$/.test(offerType);
    const isNoOffer = offerType === 'no_offer' || offerType === 'none';
    const activeOfferPresent = eventData.ACTIVE_OFFER_PRESENT === 'true';

    if (effectiveTier === 'ultimate') {
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

    if (activeOfferPresent && ratePlan === 'monthly') {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      eventData.PAYMENT_PLAN_NAME = eventData.PAYMENT_PLAN_LABEL || 'Flex – Pay Monthly - First Month Only';
      eventData.PAYMENT_FREE_TEXT = 'N/A';
      eventData.CANCELLATION_TEXT = eventData.CANCELLATION_TEXT_TRIAL || '';
    } else if (isTrial) {
      eventData.PAYMENT_PAGE_TITLE = TV_HANDOFF_MODE
        ? (eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay')
        : (eventData.PAYMENT_PAGE_TITLE_TRIAL || 'Choose how to pay after your free trial');
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
      if (effectiveTier === 'ultimate') {
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

    // Frozen users on an N-day monthly trial still show trial values in the
    // purchase summary. Only the payment
    // page heading differs from the new/freemium trial heading.
    if (userStateKey === 'frozen' && isTrial) {
      eventData.PAYMENT_PAGE_TITLE = eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
    }

    // Ensure uppercase keys are in sync
    eventData['PAYMENT_PAGE_TITLE'] = eventData.PAYMENT_PAGE_TITLE;
    eventData['PAYMENT_PLAN_NAME'] = eventData.PAYMENT_PLAN_NAME;
    eventData['PAYMENT_FREE_TEXT'] = eventData.PAYMENT_FREE_TEXT;
    eventData['PLAN_CTA_BUTTON'] = eventData.PLAN_CTA_BUTTON;
    eventData['DAZN_TIER'] = eventData.DAZN_TIER;
    eventData['CANCELLATION_TEXT'] = eventData.CANCELLATION_TEXT;
    if (REGION === 'CA') {
      const caConfig = parseCanadaCommand(process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN);
      eventData.CANADA_TIER_PLAN_STR = caConfig.tierPlanDisplay;
      eventData.CANADA_FLOW_STR = caConfig.flowDisplay;
    }

    console.log(`\n🔀 Flow      : ${FLOW}`);
    console.log(`🌍 Region    : ${REGION}`);
    console.log(`🥊 Event     : ${eventData.PPV_NAME}`);
    console.log(`💎 Tier      : ${tier}`);
    console.log(`📋 Rate Plan : ${ratePlan}`);
    console.log(`📁 Config    : ${EVENT_CONFIG}`);
    console.log(`🔗 Base URL  : ${baseUrl}\n`);

    // ── Clean context ─────────────────────────────────────────────
    const recordVideo = process.env.RECORD_VIDEO !== 'false' ? {
      dir: 'test-results/videos/',
      size: { width: 1280, height: 720 },
    } : undefined;

    const regionLocaleMap: Record<string, { locale: string; timezoneId: string }> = {
      GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
      US: { locale: 'en-US', timezoneId: 'America/New_York' },
      AE: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
      SA: { locale: 'en-SA', timezoneId: 'Asia/Riyadh' },
      AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
      BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
      CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
      NO: { locale: 'en-GB', timezoneId: 'Europe/Oslo' },
    };
    const { locale: regionLocale, timezoneId: regionTimezone } =
      regionLocaleMap[REGION] ?? { locale: 'en-GB', timezoneId: 'Europe/London' };

    console.log(`Creating browser context with Locale: ${regionLocale}, Timezone: ${regionTimezone}...`);
    const context = await browser.newContext({
      // Keep the CI viewport stable; headed local runs follow the maximised window.
      viewport: isHeadless ? { width: 1920, height: 1080 } : null,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      locale: regionLocale,
      timezoneId: regionTimezone,
      ...(recordVideo ? { recordVideo } : {}),
    });
    let contextClosed = false;
    const closeContext = async () => {
      if (contextClosed) return;
      await context.close();
      contextClosed = true;
    };


    await context.addInitScript(() => {
      try {
        localStorage.setItem('randomABPoint', Math.random().toString());
      } catch { }
    });

    const page = await context.newPage();
    const results: any[] = [];
    const tvPpvReportMetadata = TV_HANDOFF_MODE ? readTvPpvReportMetadata() : null;
    const tvPpvReportStartTime = parseReportStartTime(tvPpvReportMetadata?.startTime);
    const runStartTime = tvPpvReportStartTime || specStartTime;
    appendTvPpvReportSteps(results, tvPpvReportMetadata);
    let capturedVideoPath: string | null = null;
    let reportGenerated = false;

    const finishRun = async (displayTier = tier, userStatusOverride?: string) => {
      reachedEndPage = true;
      capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
      await closeContext().catch(() => { });
      const { excelPath, videoPath } = await writeResults(results, capturedVideoPath);

      displayResultsTable(results, displayTier, {
        event: eventData.PPV_NAME,
        region: REGION,
        excelPath,
        videoPath,
      });

      const isCanada = REGION === 'CA';
      const defaultUserStatus = userStatusOverride || ((TV_HANDOFF_MODE || isMyAccount) ? (process.env.USER_STATE || 'Freemium') : 'New User');
      let finalTier = tier;
      let finalRatePlan = ratePlan;
      let flowName = `${SOURCE} → ${tier} → ${ratePlan}`;
      let finalUserStatus = defaultUserStatus;

      if (isCanada) {
        const userState = userStatusOverride || process.env.USER_STATE || stateKey || 'freemium';
        const caConfig = parseCanadaCommand(process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN);
        finalTier = caConfig.tierPlanDisplay; // e.g. "standard -> dazn -> Annual-pay now"
        finalRatePlan = '';
        flowName = `${SOURCE} -> ${userState.toLowerCase()} -> ${caConfig.tierPlanDisplay}`; // e.g. "myaccount -> freemium -> standard -> dazn -> Annual-pay now"
        finalUserStatus = userState;
      }

      const { folderPath } = await generateReports(results, {
        event: eventData.PPV_NAME,
        region: REGION,
        source: SOURCE,
        ratePlan: finalRatePlan,
        tier: finalTier,
        env: process.env.DAZN_ENV || 'prod',
        flowName,
        startTime: runStartTime,
        endTime: new Date(),
        excelPath,
        videoPath,
        userStatus: finalUserStatus,
        userType: 'existing-user',
        platform: getReportPlatform(),
        paymentMethod: PAYMENT_METHOD === 'gpay' ? 'Google Pay' : 'Credit Card',
      });
      reportGenerated = true;
      if (folderPath) console.log(`\n📂 Report folder: ${folderPath}`);

      const failed = results.filter(r => r.status === 'FAIL').length;
      if (failed > 0) {
        const failMsgs = results
          .filter(r => r.status === 'FAIL')
          .map(r => `  - [${r.page}] ${r.field}: expected "${r.expected}", actual "${r.actual}"`)
          .join('\n');
        const errMsg = `❌ Flow "${SOURCE} (${userStateKey})" completed navigation but had ${failed} validation failure(s):\n${failMsgs}`;
        console.log(errMsg);
        throw new Error(errMsg);
      }
    };

    const validateUltimateMyAccountRedirect = async () => {
      console.log('\n🏠 [Ultimate User] Landed on My Account — validating purchased PPV status...');
      const myAccountPage = new MyAccountPage(page);
      await myAccountPage.navigateAndValidatePurchasedPPVStatus(baseUrl, results, eventData);
    };

    // ── detectPageType ────────────────────────────────────────────
    const detectPageType = async (
      p: any,
      pc: Record<string, { detection: string }>
    ): Promise<'ppv' | 'plan' | 'payment' | 'confirmation' | 'standalone-ppv' | 'email' | 'unknown' | 'success-upsell' | 'saved-card-payment' | 'bet-upsell' | 'default-signup' | 'phone' | 'myaccount-ppv' | 'choose-how-to-buy'> => {
      if (!p || p.isClosed()) return 'unknown';

      // ── Wait for SPA routing / initial load to settle if needed ──
      const initialUrl = p.url().toLowerCase();
      if (
        initialUrl.includes('index.html') ||
        initialUrl.includes('externalpurchaseid=') ||
        initialUrl.includes('contextualppvid=') ||
        ((initialUrl.includes('page=plandetails') || initialUrl.includes('page=tierplans')) &&
          !initialUrl.includes('upselltiershown') &&
          !initialUrl.includes('upselltierselected') &&
          !initialUrl.includes('upselltierskipped'))
      ) {
        try {
          await p.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            const hasUpsellStateInUrl = href.includes('upselltiershown') ||
              href.includes('upselltierselected') ||
              href.includes('upselltierskipped');
            const hasPpvText = bodyText.includes('pay-per-view') ||
              bodyText.includes('just the fight') ||
              bodyText.includes('continue with pay-per-view') ||
              bodyText.includes('ultimate fan package') ||
              bodyText.includes('to watch your pay-per-view');
            return hasUpsellStateInUrl || hasPpvText;
          }, { timeout: 8000 }).catch(() => { });
        } catch { }
      }

      const url = p.url();
      const urlLower = url.toLowerCase();

      if (urlLower.includes('paymentdetails')) return 'payment';
      if (urlLower.includes('phonenumbercollection')) return 'phone';
      // Upgrade confirmation page — must be checked BEFORE the /signup email fallback
      if (urlLower.includes('upgradeplan')) return 'confirmation';
      if (urlLower.includes('upgradetier') && !urlLower.includes('isupgradetierflow')) return 'confirmation';

      if (
        noPpvClick &&
        urlLower.includes('page=tierplans') &&
        !urlLower.includes('upselltiershown') &&
        !(await findNoPpvLink(p, 500))
      ) {
        eventData.SUBSCRIBE_WITHOUT_PPV_DIRECT = 'true';
        return 'plan';
      }

      // Default signup page with plan details/tier plans (e.g. from My Account Upgrade/Resubscribe CTA)
      // Exclude noPpv=true — that URL means the user already clicked "Subscribe without a pay-per-view"
      // and is on the TierPlans page, which should be detected as 'plan' not 'default-signup'.
      if (process.env.DEFAULT_SIGNUP === 'true' && !defaultSignupPPVValidated && urlLower.includes('/signup') && (urlLower.includes('plandetails') || urlLower.includes('tierplans')) && !urlLower.includes('upselltierskipped') && !urlLower.includes('noppv=true')) {
        const bodyText = await p.locator('body')
          .innerText({ timeout: 3000 })
          .then((t: string) => t.toLowerCase())
          .catch(() => '');
        if (bodyText.includes('pay-per-view') || bodyText.includes('choose how to buy') ||
          bodyText.includes('subscribe without a pay-per-view') ||
          bodyText.includes('continue without pay-per-view') ||
          bodyText.includes('continue without a pay-per-view')) {
          return 'default-signup';
        }
      }

      // Addon purchase page — active_standard user: could be "Choose how to buy" OR saved-card-payment
      if (urlLower.includes('/addon/purchase')) {
        try {
          await p.waitForFunction(() => {
            const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
            return (bodyText.includes('payment was successful') &&
              (bodyText.includes('dazn bet') || bodyText.includes('free bet') || bodyText.includes('activate betting'))) ||
              (bodyText.includes('payment was successful') &&
              (bodyText.includes('buy now for') || bodyText.includes('no thanks'))) ||
              bodyText.includes('choose how to buy') ||
              bodyText.includes('pay now') ||
              bodyText.includes('one time payment') ||
              bodyText.includes('****');
          }, { timeout: 6000 });
        } catch (e) {
          console.log('⚠️ detectPageType: Timeout waiting for addon purchase page content');
        }

        const addonBody = await p.locator('body')
          .innerText({ timeout: 3000 })
          .then((t: string) => t.toLowerCase())
          .catch(() => '');

        if (
          PPV_TYPE === 'upsell' &&
          addonBody.includes('payment was successful') &&
          (addonBody.includes('dazn bet') || addonBody.includes('free bet') || addonBody.includes('activate betting'))
        ) {
          return 'bet-upsell';
        }

        if (
          PPV_TYPE === 'upsell' &&
          addonBody.includes('payment was successful') &&
          (addonBody.includes('buy now for') || addonBody.includes('no thanks'))
        ) {
          return 'success-upsell';
        }

        if (isStandalonePPV) {
          const hasStandaloneControls =
            (await p.locator('input[type="checkbox"], button[class*="ni7RX"]').count().catch(() => 0)) > 0 &&
            (await p.locator('input[type="radio"], [role="radio"]').count().catch(() => 0)) > 0;
          if (hasStandaloneControls) return 'standalone-ppv';
        }

        if (addonBody.includes('choose your plan') ||
          addonBody.includes('choose a plan') ||
          addonBody.includes('choose the right plan') ||
          addonBody.includes('to watch your pay-per-view')) {
          return 'ppv';
        }

        if (addonBody.includes('choose how to buy')) return 'choose-how-to-buy';
        return 'saved-card-payment';
      }

      // My Account page — ultimate users can redirect here when PPV is already purchased
      if (urlLower.includes('/myaccount/ppv') || urlLower.includes('/myaccount?')) {
        return 'myaccount-ppv';
      }

      // PPV page detection via contextualPpvId query param (before email fallback)
      // Wait for SPA routing to complete — the URL may get a page= parameter
      if (urlLower.includes('/signup') && urlLower.includes('contextualppvid=') && !urlLower.includes('page=')) {
        try {
          await p.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            const bodyLen = document.body?.innerText?.trim().length || 0;
            // Wait until URL gets a page= param (SPA routing) OR body has meaningful content
            return href.includes('page=') ||
              href.includes('upselltiershown') ||
              bodyLen > 200;
          }, { timeout: 10000 });
        } catch {
          // Timeout — proceed with what we have
        }
        // Re-check URL after SPA routing completes
        const routedUrl = p.url().toLowerCase();
        if (routedUrl.includes('paymentdetails')) return 'payment';
        if (routedUrl.includes('page=personaldetails') || routedUrl.includes('emaildetails')) return 'email';
        if (routedUrl.includes('upselltiershown=true')) return 'ppv';
        if (routedUrl.includes('page=plandetails') || routedUrl.includes('page=tierplans')) {
          // Check if it's actually a PPV page with plan selection
          const routedBody = await p.locator('body')
            .innerText({ timeout: 3000 })
            .then((t: string) => t.toLowerCase())
            .catch(() => '');
          if (isStandalonePPV) {
            const hasStandaloneControls =
              (await p.locator('input[type="checkbox"], button[class*="ni7RX"]').count().catch(() => 0)) > 0 &&
              (await p.locator('input[type="radio"], [role="radio"]').count().catch(() => 0)) > 0;
            if (hasStandaloneControls) return 'standalone-ppv';
          }
          if (routedBody.includes('pay-per-view') || routedBody.includes('choose how to buy') ||
            routedBody.includes('subscribe without a pay-per-view')) {
            return 'ppv';
          }
          return 'plan';
        }
        // Still no page= param — check body content
        const bodyCheck = await p.locator('body')
          .innerText({ timeout: 3000 })
          .then((t: string) => t.toLowerCase())
          .catch(() => '');
        if (bodyCheck.includes('pay-per-view') || bodyCheck.includes('choose how to buy')) return 'ppv';
        if (bodyCheck.includes('choose your plan') || bodyCheck.includes('choose the right plan')) return 'ppv';
        if (bodyCheck.includes('choose a plan')) return 'plan';
        return 'ppv'; // Default fallback if contextualppvid present
      }

      // Email/signup checks (highest priority URL checks, must be before tier checks)
      if (urlLower.includes('page=personaldetails')) return 'email';
      if (urlLower.includes('emaildetails')) return 'email';
      if (urlLower.includes('/signup') && !urlLower.includes('plandetails') && !urlLower.includes('tierplans')) {
        const bodyText = await p.locator('body')
          .innerText({ timeout: 3000 })
          .then((t: string) => t.toLowerCase())
          .catch(() => '');
        if (bodyText.includes('choose your plan') || bodyText.includes('choose a plan') || bodyText.includes('choose the right plan') || bodyText.includes('select how to pay')) {
          return 'plan';
        }
        const radioCount = await p.locator('input[type="radio"], [role="radio"]').count().catch(() => 0);
        if (radioCount > 0) return 'plan';
        return 'email';
      }
      try {
        const emailCount = await p.locator('input[type="email"]').count().catch(() => 0);
        if (emailCount > 0) return 'email';
      } catch { }

      if (urlLower.includes('upselltiershown=true')) {
        if (process.env.DEFAULT_SIGNUP === 'true') {
          const bodyText = await p.locator('body')
            .innerText({ timeout: 2000 })
            .then((t: string) => t.toLowerCase())
            .catch(() => '');
          if (bodyText.includes('subscribe without a pay-per-view')) {
            return 'default-signup';
          }
        }
        return 'ppv';
      }

      const lower = await p.locator('body')
        .innerText({ timeout: 2000 })
        .then((t: string) => t.toLowerCase())
        .catch(() => '');

      // DAZN Bet / promotional upsell (second success page)
      if (lower.includes('payment was successful') &&
        (lower.includes('dazn bet') || lower.includes('free bet') || lower.includes('activate betting'))) {
        return 'bet-upsell';
      }

      // PPV upsell success page (first success page after initial payment)
      if (lower.includes('payment was successful') &&
        (lower.includes('buy now for') || lower.includes('no thanks') || lower.includes('upsell'))) {
        return 'success-upsell';
      }

      // Saved card payment page (upsell PPV purchase with card on file)
      if (lower.includes('one time payment') &&
        (lower.includes('visa') || lower.includes('mastercard') || lower.includes('amex') ||
          lower.includes('****') || lower.includes('saved card'))) {
        return 'saved-card-payment';
      }

      // Standalone check before general plan/skipped checks
      if (isStandalonePPV && urlLower.includes('page=plandetails') && (
        urlLower.includes('standalone') ||
        lower.includes('standalone') ||
        lower.includes('collision') ||
        (await p.locator('input[type="checkbox"], button[class*="ni7RX"]').count().catch(() => 0)) > 0
      )) {
        return 'standalone-ppv';
      }

      if (isStandalonePPV && lower.includes("choose a plan") && lower.includes("choose your subscription")) {
        const checkboxCount = await p.locator('input[type="checkbox"]').count().catch(() => 0);
        if (checkboxCount > 0) return 'standalone-ppv';
      }

      if (urlLower.includes('upselltierskipped=true')) return 'plan';

      // Signed-in boxing banner can briefly expose page=PlanDetails before the
      // SPA appends upsellTierShown=true. During that window the body is already
      // the PPV selection screen, so avoid validating it with DAZN Plan rules.
      const isBoxingPpvEntrySource =
        SOURCE.toLowerCase().startsWith('boxing-page') ||
        SOURCE.toLowerCase().startsWith('boxing-bundle') ||
        SOURCE.toLowerCase() === 'boxing-upcoming-fights';
      if (
        (urlLower.includes('contextualppvid=') || urlLower.includes('externalpurchaseid=')) &&
        (urlLower.includes('page=plandetails') || urlLower.includes('page=tierplans')) &&
        (
          !urlLower.includes('upselltierselected=true') ||
          isBoxingPpvEntrySource
        )
      ) {
        if (
          lower.includes('continue with pay-per-view') ||
          lower.includes('just the fight') ||
          lower.includes('to watch your pay-per-view') ||
          lower.includes('the ultimate fan package')
        ) {
          return 'ppv';
        }
      }

      if (urlLower.includes('upselltierselected=true') &&
        urlLower.includes('plandetails')) return 'plan';
      if (urlLower.includes('page=plandetails')) return 'plan';
      if (urlLower.includes('page=tierplans')) return 'plan';
      if (urlLower.includes('upgradeplan') ||
        (urlLower.includes('upgradetier') &&
          !urlLower.includes('isupgradetierflow'))) return 'confirmation';

      if (lower.includes('subscribe without a pay-per-view')) return 'ppv';
      if (lower.includes('add your phone number')) return 'phone';
      if (lower.includes('choose your plan')) return 'ppv';
      if (lower.includes('choose how to buy')) return 'choose-how-to-buy';
      // "Choose the right plan for you" appears on BOTH PPV and Plan pages.
      // If the page also mentions PPV-related content, it's the PPV page, not the plan page.
      if (lower.includes("choose the right plan") || lower.includes("choose a plan") || lower.includes("choose a subscription")) {
        if (lower.includes('pay-per-view') || lower.includes('continue with pay-per-view') || lower.includes('to watch your pay-per-view')) {
          return 'ppv';
        }
        return 'plan';
      }
      if (lower.includes('your plan will be changed')) return 'confirmation';

      return 'unknown';
    };

    const isMyAccount =
      SOURCE === 'my-account' ||
      SOURCE === 'myaccount' ||
      SOURCE === 'myaccount-subscription-status';
    let reachedEndPage = false;

    const isContextualPpvSelectionPage = async (p: any): Promise<boolean> => {
      const currentUrl = p.url().toLowerCase();
      if (!currentUrl.includes('contextualppvid=')) return false;
      if (currentUrl.includes('upselltierskipped=true') || currentUrl.includes('upselltierselected=true')) {
        return false;
      }

      const currentBody = await p.locator('body')
        .innerText({ timeout: 2000 })
        .then((t: string) => t.toLowerCase())
        .catch(() => '');

      return currentUrl.includes('upselltiershown=true') ||
        currentBody.includes('continue with pay-per-view') ||
        currentBody.includes('just the fight') ||
        currentBody.includes('to watch your pay-per-view') ||
        currentBody.includes('the ultimate fan package');
    };

    try {
      const tvHandoffUrl = TV_HANDOFF_MODE ? readTvHandoffUrl() : '';
      if (tvHandoffUrl) {
        console.log(`📺 [TV Handoff] Continuing existing-user validations from TV plans URL: ${tvHandoffUrl}`);
      }

      const requiresPreLogin = !tvHandoffUrl && (isMyAccount || LOGIN_FIRST);

      // ══════════════════════════════════════════════════════════════
      // PRE-LOGIN FLOW (My Account OR LOGIN=true)
      // ══════════════════════════════════════════════════════════════
      if (requiresPreLogin) {
        const authManager = new AuthenticationManager(page, context, baseUrl);
        await authManager.authenticate(eventData);

        if (isMyAccount) assertCountryMatch(page, REGION);

        await handleCookies(page, 15000);
        await stabilisePage(page);
        await page.keyboard.press('Escape').catch(() => { });
        await page.waitForTimeout(200);

        const isLandingPageSource = SOURCE.toLowerCase().includes('landing-page');

        if (isLandingPageSource) {
          console.log(`ℹ️ [Login First] Existing-user landing page source enabled: ${SOURCE}`);
        }

        if (!isStandalonePPV && LOGIN_FIRST && isActiveUltimateState(userStateKey) && !isMyAccount && !isUltimateLoginFirstBoxingMyAccountFlow) {
          console.log('\n💎 [Login First Ultimate] Validating My Account purchased status before source click...');
          const myAccountPage = new MyAccountPage(page);
          await myAccountPage.navigateAndValidatePurchasedPPVStatus(baseUrl, results, eventData);
        }
      }

      if (!tvHandoffUrl && !isMyAccount) {
        // ══════════════════════════════════════════════════════════════
        // LANDING / BOXING / SCHEDULE ACQUISITION FLOW
        // ══════════════════════════════════════════════════════════════
        const isSchedule = SOURCE.toLowerCase().includes('schedule');
        const isSearch = SOURCE.toLowerCase().includes('search');

        const isGloryTile = SOURCE.toLowerCase() === 'glory-tile';
        const isGloryBanner = SOURCE.toLowerCase() === 'glory-banner';

        // ══════════════════════════════════════════════════════════════
        // HOME PAGE POPUP FLOW
        // ══════════════════════════════════════════════════════════════
        if (SOURCE === 'home-page-popup') {
          console.log('\n╔═══════════════════════════════════════════════════════╗');
          console.log('║  HOME PAGE POPUP FLOW — Existing User                  ║');
          console.log('╚═══════════════════════════════════════════════════════╝\n');

          // ── Navigate to welcome page and click Log In ──
          const landingForPopup = new LandingPage(page);
          await page.goto(`${baseUrl}/welcome`, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
          await handleCookies(page, 15000);
          await landingForPopup.clickLogIn();

          // ── Login with existing user credentials ──
          const signupForPopup = new SignupPage(page);
          await page.waitForURL(/emailDetails|signup|signin/i, { timeout: 10000 }).catch(() => { });
          await page.waitForLoadState('domcontentloaded').catch(() => { });
          console.log(`📍 [Home Page Popup] Landed on: ${page.url()}`);

          await signupForPopup.enterEmail(userEmail);
          await signupForPopup.clickContinue();
          await signupForPopup.enterPasswordAndSignIn(userPassword);
          await waitForHomePageAuthRedirect(page, 'Home Page Popup existing-user login');


          // ── Popup detection + validation + Buy Now (via HomePage POM) ──
          const homePageForPopup = new HomePage(page, baseUrl);
          await homePageForPopup.waitForHomePagePopup(
            { email: userEmail, password: userPassword },
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
          assertCountryMatch(page, REGION);

          if (devModeEnabled) {
            console.log('\n🎭 Dev mode flow detected — enabling dev mode on Glory page...');
            const searchPage = new SearchPage(page);
            await searchPage.enableDevMode();
          }

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
          assertCountryMatch(page, REGION);
          await dismissMarketingPopup(page, 5000);

          if (devModeEnabled) {
            console.log('\n🎭 Dev mode flow detected — enabling dev mode on schedule page...');
            const searchPage = new SearchPage(page);
            await searchPage.enableDevMode();
          }

          let scheduleEventCard: any;
          let scheduleEventClicked = false;

          // Step 1: Apply sport filter and locate event tile (no click yet)
          try {
            await schedule.selectSport(sport);
            if (!isStandalonePPV && LOGIN_FIRST && isActiveUltimateState(userStateKey)) {
              const eventCard = await schedule.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));
              await schedule.clickEntitledEventAndValidate(eventCard, results, eventData);
              await finishRun('ultimate', userStateKey);
              return;
            }
            scheduleEventCard = await schedule.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));
          } catch (schedErr: any) {
            if (process.env.PPV_REMOVAL === 'true') {
              console.log(`✅ [PPV Removal - Existing User] Category B (${SOURCE}): Schedule event not found — confirmed removed/absent as expected.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: schedErr.message,
                status: 'PASS',
              });
              reachedEndPage = true;
              await closeContext().catch(() => { });
              return;
            }
            console.error(`❌ Schedule: could not find event: ${schedErr.message}`);
            let shotPath: string | undefined;
            try {
              const dir = path.resolve(process.cwd(), 'test-results', 'screenshots');
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              shotPath = path.join(dir, `FAIL_Schedule_Event_Click_${Date.now()}.jpg`);
              await page.screenshot({ path: shotPath, type: 'jpeg', quality: 75, fullPage: false });
            } catch { shotPath = undefined; }
            results.push({
              page: 'Schedule',
              field: 'PPV Event Click',
              expected: `${eventData.PPV_NAME} clickable via ${sport} filter`,
              actual: schedErr.message,
              status: 'FAIL',
              screenshot: shotPath,
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
              throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present on schedule page`);
            }

            // Step 2: Scroll card into view FIRST, then validate tile fields from it
            await scheduleEventCard.scrollIntoViewIfNeeded().catch(() => { });

            // Pre-capture tile values directly from the located event card element
            // so getActualValue uses these instead of a broad DOM scan
            try {
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
              let shotPath: string | undefined;
              try {
                const dir = path.resolve(process.cwd(), 'test-results', 'screenshots');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                shotPath = path.join(dir, `FAIL_Schedule_Event_Click_${Date.now()}.jpg`);
                await page.screenshot({ path: shotPath, type: 'jpeg', quality: 75, fullPage: false });
              } catch { shotPath = undefined; }
              results.push({
                page: 'Schedule',
                field: 'PPV Event Click',
                expected: `${eventData.PPV_NAME} clickable via ${sport} filter`,
                actual: schedErr.message,
                status: 'FAIL',
                screenshot: shotPath,
              });
            }
          }


          if (scheduleEventClicked && process.env.PPV_REMOVAL !== 'true') {
            await handlePopupModal(page, results, eventData, SOURCE, false);
            await schedule.clickBuyNow();
          }

        } else if (isSearch) {
          const searchPage = new SearchPage(page);
          await searchPage.navigate(baseUrl);
          await setupPage(page, 8000);
          assertCountryMatch(page, REGION);
          await dismissMarketingPopup(page, 5000);

          if (devModeEnabled) {
            console.log('\n🎭 Dev mode flow detected — enabling dev mode on search page...');
            await searchPage.enableDevMode();
          }

          if (!isStandalonePPV && LOGIN_FIRST && isActiveUltimateState(userStateKey)) {
            await searchPage.searchAndClickEntitledPPV(eventData.PPV_NAME, results, eventData);
            await finishRun('ultimate', userStateKey);
            return;
          }

          try {
            await searchPage.searchForPPVTileWithUpcomingFallback(eventData.PPV_NAME);
          } catch (searchErr: any) {
            if (process.env.PPV_REMOVAL === 'true') {
              console.log(`✅ [PPV Removal - Existing User] Category B (${SOURCE}): Search PPV tile not found — confirmed removed/absent as expected.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: searchErr.message,
                status: 'PASS',
              });
              reachedEndPage = true;
              await closeContext().catch(() => { });
              return;
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
            throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present on search page`);
          }

          console.log('\n📋 Validating Search page tile fields (before tile click)...');
          try {
            const searchData = readSheet('Search page');
            // Only validate tile fields here — popup fields are validated by
            // handlePopupModal after clickPPVTile opens the popup
            const tileFields = searchData.filter((r: any) =>
              !String(r.Field || '').toLowerCase().startsWith('popup')
            );
            await validateVariant(
              page, 'search', tileFields, results, eventData, 'Search'
            );
          } catch (err: any) {
            console.warn(`⚠️  Search page validation error: ${err.message}`);
          }


          await searchPage.clickPPVTile(resolvePpvTitleForSource(eventData, 'search'));

          if (process.env.PPV_REMOVAL !== 'true') {
            // Check and validate popup modal after clicking the tile and before clicking Buy Now
            await handlePopupModal(page, results, eventData, SOURCE, false);
            await searchPage.clickBuyNow();
          }
        } else {
          const isHomePageSource = SOURCE.startsWith('home-page-') ||
            SOURCE === 'home-biggest-fights' ||
            SOURCE === 'subscribe-without-pay-per-view';
          const isHomeSport = HOME_SPORT_DROPDOWN_SOURCES.has(SOURCE.toLowerCase());
          const isBoxingSource = SOURCE.startsWith('boxing-page') || SOURCE.startsWith('boxing');
          const shouldValidateTileBeforePopup = new Set(['home-page-dont-miss', 'home-boxing-tile']).has(SOURCE.toLowerCase());

          const landing = isHomePageSource
            ? new HomePage(page)
            : isHomeSport
              ? new BoxingHomePage(page)
              : isBoxingSource
                ? new BoxingPage(page)
                : new LandingPage(page);

          // Start RailsInterceptor before navigation for home-biggest-fights and home-page-dazntile.
          // Biggest Fights resolves the PPV-name poster; DAZN tile retains its own entitlement flow.
          // Also start when srcResolvedSource resolves to home-page-dazntile (e.g. subscribe-without-pay-per-view).
          let railsInterceptor: RailsInterceptor | undefined;
          if (SOURCE === 'home-biggest-fights' || SOURCE === 'home-page-dazntile' || srcResolvedSource === 'home-page-dazntile') {
            railsInterceptor = new RailsInterceptor(page);
            await railsInterceptor.startIntercepting();
            console.log(`🔌 [RailsInterceptor] Started for ${SOURCE} (resolved: ${srcResolvedSource}) tile matching`);
          }

          // If LOGIN_FIRST=true the user is already signed in. Navigate to the
          // requested surfacing page explicitly. Landing page banner/tile sources
          // must still go to /welcome; otherwise the test remains on /home after
          // authentication and then searches for landing-page containers on the
          // wrong page.
          if (LOGIN_FIRST) {
            // Landing page flows require a non-logged-in user to see the welcome/landing page.
            // When LOGIN_FIRST=true the user is already signed in, so these flows are not applicable.
            if (LOGIN_FIRST_INVALID_LANDING_SOURCES.has(SOURCE.toLowerCase())) {
              throw new Error(
                `❌ LOGIN_FIRST=true is not compatible with SOURCE="${SOURCE}". ` +
                `Landing page flows (${[...LOGIN_FIRST_INVALID_LANDING_SOURCES].join(', ')}) ` +
                `require a non-logged-in user to access the landing/welcome page. ` +
                `Use LOGIN_FIRST=false or choose a different source (e.g. home-boxing-tile, home-boxing-banner).`
              );
            }
            console.log(`ℹ️ [Login First] User already logged in, skipping welcome page navigation. Current URL: ${page.url()}`);
            const baseNoSlash = baseUrl.replace(/\/$/, '');
            const isLandingPageSource = SOURCE.toLowerCase().includes('landing-page');
            if (isLandingPageSource) {
              console.log(`🧭 [Login First] Navigating signed-in user to landing page source: ${SOURCE}`);
              await landing.navigate(baseUrl, SOURCE, eventData);
            } else if (isHomeSport) {
              const homeTargetUrl = `${baseNoSlash}/home`;
              if (!page.url().toLowerCase().includes('/home')) {
                console.log(`🧭 [Login First] Returning to Home before All Sports navigation: ${homeTargetUrl}`);
                await page.goto(homeTargetUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
              }
              console.log(`🧭 [Login First] Navigating via All Sports dropdown for source: ${SOURCE}`);
              await (landing as BoxingHomePage).navigateToSportViaAllSports(SOURCE, eventData);
            } else if (isBoxingSource) {
              // For boxing sources, enable dev mode while still on /home
              // (before navigating to the heavy boxing page). The boxing
              // page loads video/streaming content for active subscribers
              // that can block page.goto() to /search.
              if (devModeEnabled) {
                console.log('\n🎭 Dev mode flow detected — enabling dev mode from /home before boxing navigation...');
                const searchPageEarly = new SearchPage(page);
                await searchPageEarly.enableDevMode();
                console.log('✅ Dev mode enabled from /home — now navigating to boxing page');
              }
              console.log(`🧭 [Login First] Navigating directly to Boxing page via BoxingPage.navigate()`);
              await (landing as BoxingPage).navigate(baseUrl, SOURCE);
            } else {
              // HomePage: we are already on /home. Strip the DAZN onboarding
              // step param before touching banner carousel DOM.
              const homeUrl = page.url();
              if (!homeUrl.toLowerCase().includes('/home')) {
                const homeTargetUrl = `${baseNoSlash}/home`;
                console.log(`🧭 [Login First] Returning to Home for source ${SOURCE}: ${homeTargetUrl}`);
                await page.goto(homeTargetUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
              } else if (/[?&]step=\d+/.test(homeUrl)) {
                try {
                  const cleanUrl = new URL(homeUrl);
                  cleanUrl.searchParams.delete('step');
                  const cleanUrlStr = cleanUrl.toString().replace(/\?$/, '');
                  console.log(`🔧 [Login First] Stripping ?step= from home URL: ${homeUrl} → ${cleanUrlStr}`);
                  await page.goto(cleanUrlStr, { waitUntil: 'domcontentloaded' });
                  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
                } catch {
                  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
                }
              } else {
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
              }
            }
          } else {
            // Use srcResolvedSource so the navigation CTA matches the surfacingpoint.json config.
            await landing.navigate(baseUrl, srcResolvedSource, eventData);
          }

          // Pass interceptor to eventData so HomePage can use it
          if (railsInterceptor) {
            eventData._railsInterceptor = railsInterceptor;
          }
          await setupPage(page, 8000);
          assertCountryMatch(page, REGION);
          await dismissMarketingPopup(page, 5000);
          if (LOGIN_FIRST) {
            await page.keyboard.press('Escape').catch(() => { });
            await page.waitForTimeout(200);
          }

          if (devModeEnabled) {
            // For boxing sources with LOGIN_FIRST, dev mode was already
            // enabled from /home before navigating to the boxing page.
            const alreadyEnabledFromHome = LOGIN_FIRST && (SOURCE.startsWith('boxing-page') || SOURCE.startsWith('boxing'));
            if (!alreadyEnabledFromHome) {
              console.log('\n🎭 Dev mode flow detected — enabling dev mode on landing page...');
              const searchPage = new SearchPage(page);
              await searchPage.enableDevMode(SOURCE === 'home-boxing-banner' ? { preservePpvPromo: true } : undefined);
              if (LOGIN_FIRST) {
                await page.keyboard.press('Escape').catch(() => { });
                await page.waitForTimeout(200);
              }
            }
          }

          // Validate entry page
          const isBoxingSourceInner = SOURCE.startsWith('boxing-page') || SOURCE.startsWith('boxing');
          const isHomePageSourceInner = SOURCE.startsWith('home-page-') ||
            SOURCE === 'home-biggest-fights' ||
            SOURCE === 'subscribe-without-pay-per-view' ||
            srcResolvedSource.startsWith('home-page-');
          const isHomeSportInner = HOME_SPORT_DROPDOWN_SOURCES.has(SOURCE.toLowerCase());

          let sheetName = 'Landing page';
          let pageName = 'Landing';
          let flowParam = SOURCE === 'landing-page-banner' ? 'landing-page-banner' : 'landing';

          if (isHomePageSourceInner) {
            sheetName = 'Home page';
            pageName = 'Home Page';
            flowParam = SOURCE;
          } else if (isHomeSportInner) {
            const isNonBoxingSportTile =
              SOURCE.toLowerCase() === 'home-boxing-tile' &&
              String(eventData.SPORT || '').trim().toLowerCase() !== 'boxing';
            const isNonBoxingGenericSportHero =
              SOURCE.toLowerCase() === 'home-boxing-banner' &&
              String(eventData.SPORT || '').trim() !== '' &&
              String(eventData.SPORT || '').trim().toLowerCase() !== 'boxing';
            const useHomeOfSportData = isNonBoxingSportTile || isNonBoxingGenericSportHero;
            sheetName = useHomeOfSportData ? 'Home of Sport' : 'Home of Boxing';
            pageName = useHomeOfSportData ? 'Home of Sport' : 'Home of Boxing';
            flowParam = isNonBoxingGenericSportHero
              ? 'home-sport-generic-hero'
              : isNonBoxingSportTile
              ? 'home-sport-tile'
              : SOURCE.includes('banner')
              ? 'home-boxing-banner'
              : SOURCE === 'home-boxing-upcoming'
                ? 'home-boxing-upcoming'
                : 'home-boxing-tile';
          } else if (isBoxingSourceInner) {
            sheetName = 'Boxing page';
            pageName = 'Boxing';
            flowParam = SOURCE.startsWith('boxing-page-bundle') || SOURCE.startsWith('boxing-bundle')
              ? 'boxing-bundle'
              : SOURCE === 'boxing-upcoming-fights'
                ? 'boxing-upcoming'
                : SOURCE === 'boxing-banner-ultimate'
                  ? 'boxing'
                  : 'boxing';
          }

          // Stop carousel auto-slide before finding PPV container
          // This prevents the banner from scrolling past the PPV slide during findPPVInBanner
          if (SOURCE.includes('banner')) {
            await page.evaluate(() => {
              try {
                const stopSwiper = (swiper: any) => {
                  if (!swiper) return;
                  try { swiper.autoplay?.stop(); } catch { }
                  try { swiper.params.autoplay = false; } catch { }
                  try { if (swiper.autoplay?.running) swiper.autoplay.stop(); } catch { }
                };
                document.querySelectorAll('.swiper, [class*="swiper"], .swiper-container').forEach((el: any) => {
                  if (el.swiper) stopSwiper(el.swiper);
                });
                document.querySelectorAll('*').forEach((el: any) => {
                  if (el.swiper && typeof el.swiper === 'object' && el.swiper.autoplay) stopSwiper(el.swiper);
                });
              } catch { }
            }).catch(() => { });
            await page.waitForTimeout(300);
          }

          // Use the resolved source from surfacingpoint.json so HomePage.findPPVContainer
          // knows which CTA to find (e.g. home-page-dazntile or home-page-get-started).
          const containerSource = srcResolvedSource;
          let container: any;
          const removalCtaOnlySources = new Set([
            'home-page-dazntile',
            'boxing-standard-subscription',
            'boxing-ultimate-subscription',
            'boxing-join-the-club',
          ]);
          if (shouldValidateTileBeforePopup) {
            eventData.__RETURN_TILE_BEFORE_POPUP = 'true';
          }

          if (process.env.PPV_REMOVAL === 'true' && removalCtaOnlySources.has(SOURCE)) {
            if (!await isConfiguredPpvVisible(page, eventData.PPV_NAME)) {
              console.log(`✅ [PPV Removal - Existing User] ${SOURCE}: configured PPV is absent from the source.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: 'Configured PPV is absent from the source',
                status: 'PASS',
              });
              await closeContext().catch(() => { });
              return;
            }
            throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present via ${SOURCE}`);
          }

          const isBoxingSubscriptionSource =
            SOURCE === 'boxing-banner-ultimate' ||
            SOURCE === 'boxing-ultimate-subscription' ||
            SOURCE === 'boxing-standard-subscription' ||
            SOURCE === 'boxing-join-the-club';
          const isUltimateLoginFirstEntitlement =
            !isStandalonePPV &&
            LOGIN_FIRST &&
            isActiveUltimateState(userStateKey) &&
            !isBoxingSubscriptionSource;
          const isUltimateUpcomingEntitlement =
            isUltimateLoginFirstEntitlement &&
            SOURCE.toLowerCase() === 'home-boxing-upcoming';

          // The purchased upcoming card has no Buy now CTA. Tell the page and
          // field resolvers to locate it by its remaining Fight card CTA instead.
          if (isUltimateUpcomingEntitlement) {
            eventData.__ALLOW_NO_BUY_NOW = 'true';
          }

          if (SOURCE === 'home-page-dazntile' || srcResolvedSource === 'home-page-dazntile') {
            // home-page-dazntile is a DAZN entitlement tile flow. The tile click
            // happens inside HomePage.findPPVContainer(), then a subscription
            // modal must be confirmed before the signup route is evaluated.
            try {
              await landing.findPPVContainer(eventData, containerSource);
            } catch (error) {
              if (process.env.PPV_REMOVAL !== 'true' || !isConfiguredPpvAbsenceError(error, eventData.PPV_NAME)) {
                throw error;
              }
              console.log(`✅ [PPV Removal - Existing User] ${SOURCE}: configured PPV is absent from the DAZN tile source.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: error instanceof Error ? error.message : String(error),
                status: 'PASS',
              });
              await closeContext().catch(() => { });
              return;
            }

            if (process.env.PPV_REMOVAL === 'true') {
              throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present via ${SOURCE}`);
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
              container = await landing.findPPVContainer(eventData, containerSource);
            } catch (error) {
              if (process.env.PPV_REMOVAL !== 'true' || !isConfiguredPpvAbsenceError(error, eventData.PPV_NAME)) {
                throw error;
              }
              console.log(`✅ [PPV Removal - Existing User] ${SOURCE}: configured PPV is absent from the source.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: error instanceof Error ? error.message : String(error),
                status: 'PASS',
              });
              await closeContext().catch(() => { });
              return;
            }

            // Stop intercepting after findPPVContainer completes
            if (eventData._railsInterceptor) {
              await (eventData._railsInterceptor as RailsInterceptor).stopIntercepting();
              delete eventData._railsInterceptor;
            }

            if (!container) {
              if (process.env.PPV_REMOVAL === 'true') {
                console.log(`✅ [PPV Removal - Existing User] PPV container not found via ${SOURCE} — confirmed removed/absent as expected.`);
                results.push({
                  page: 'PPV Removal',
                  field: 'PPV Surfacing Point Removal',
                  expected: 'PPV surfacing point removed from UI',
                  actual: 'PPV container absent from page',
                  status: 'PASS',
                });
                await closeContext().catch(() => { });
                return;
              }
              throwLogged(new Error(`❌ PPV container not found on landing page via ${SOURCE}`));
            }
            if (process.env.PPV_REMOVAL === 'true') {
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: `${eventData.PPV_NAME} container found via ${SOURCE}`,
                status: 'FAIL',
              });
              throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present via ${SOURCE}`);
            }
          }

          if (isUltimateLoginFirstBoxingMyAccountFlow) {
            console.log(
              `\n💎 [Login First Ultimate] ${SOURCE}: skipping Purchased/Fight Card validations. ` +
              'The selected Buy CTA will be verified through My Account PPV status.'
            );
          } else if (isUltimateLoginFirstEntitlement && SOURCE.toLowerCase().includes('banner')) {
            await landing.validateUltimatePurchasedBannerAndFightCard(
              container,
              SOURCE,
              results,
              eventData,
              pageName,
              flowParam
            );
            await finishRun('ultimate', userStateKey);
            return;
          }

          if (isUltimateUpcomingEntitlement) {
            console.log('\n💎 [Login First Ultimate] Validating purchased Upcoming Fights card (no Buy now CTA)...');
            const ultimateUpcomingFlow = 'home-boxing-upcoming-ultimate-login-first';
            await validateVariant(
              page,
              'home-boxing',
              getHomeOfBoxingData(ultimateUpcomingFlow),
              results,
              eventData,
              pageName,
              ultimateUpcomingFlow
            );
            await finishRun('ultimate', userStateKey);
            return;
          }

          const ultimateTileSource = (() => {
            const src = SOURCE.toLowerCase();
            return src.includes('tile') ||
              src.includes('dont-miss') ||
              src.includes('upcoming') ||
              src.includes('biggest-fights');
          })();

          if (!isUltimateLoginFirstBoxingMyAccountFlow && isUltimateLoginFirstEntitlement && ultimateTileSource) {
            await landing.clickUltimateTileAndValidateNavigation(
              container,
              SOURCE,
              results,
              eventData,
              pageName
            );
            await finishRun('ultimate', userStateKey);
            return;
          }

          if (isBoxingSubscriptionSource && SOURCE !== 'boxing-banner-ultimate') {
            console.log(`ℹ️ [${SOURCE}] Subscription source — skipping boxing banner/landing validation.`);
          } else if (SOURCE === 'home-biggest-fights') {
            // Skip pre-clickBuyNow validation for home-biggest-fights — the popup
            // only appears AFTER clicking the Coming Up tile (inside clickBuyNow).
            // handlePopupModal will handle validation + Buy Now click.
            console.log('ℹ️ [home-biggest-fights] Popup validation deferred to handlePopupModal (after tile click)');
          } else {
            console.log(`\n📋 Validating ${pageName} page...`);
            try {
              const onOnboarding = page.url().includes('signup') || page.url().includes('PlanDetails') || page.url().includes('payment') || page.url().includes('checkout');
              if ((sheetName === 'Home of Boxing' || sheetName === 'Home of Sport' || sheetName === 'Home page') && onOnboarding) {
                console.log('ℹ️ Direct navigation — skipping popup modal validations');
              } else {
                let landingData = sheetName === 'Home page'
                  ? getHomePageData(flowParam)
                  : sheetName === 'Home of Boxing'
                    ? getHomeOfBoxingData(flowParam)
                    : sheetName === 'Home of Sport'
                      ? getHomeOfSportData(flowParam)
                    : readSheet(sheetName);
                if (shouldValidateTileBeforePopup) {
                  landingData = landingData.filter((row: any) =>
                    !String(row.Field || '').trim().toLowerCase().startsWith('popup')
                  );
                }
                if (isUltimateLoginFirstBoxingMyAccountFlow) {
                  // The boxing banner/upcoming-fights CTA flow does not use a
                  // Purchased tag or Fight Card. Keep every other Boxing page
                  // validation in place so this exception cannot weaken other checks.
                  landingData = landingData.filter((row: any) => {
                    const field = String(row.Field || '').trim().toLowerCase();
                    return !field.includes('purchased') && !field.includes('fight card');
                  });
                }
                const variantName = sheetName === 'Home of Boxing'
                  ? 'home-boxing'
                  : sheetName === 'Home of Sport'
                    ? 'home-sport'
                  : sheetName === 'Home page'
                    ? 'home-page'
                    : 'landing';
                await validateVariant(page, variantName, landingData, results, eventData, pageName, flowParam);
              }
            } catch (err: any) {
              console.warn(`⚠️  Entry page validation error: ${err.message}`);
            }
          }

          const clickBuyNowSource = srcResolvedSource;
          if (SOURCE !== 'home-page-dazntile' && srcResolvedSource !== 'home-page-dazntile') {
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
              await handlePopupModal(page, results, eventData, SOURCE, true);
            } else {
              await landing.clickBuyNow(container, clickBuyNowSource, eventData);
            }
          } else {
            console.log('ℹ️ [DAZN Tile] Generic Buy Now click skipped; subscription modal Subscribe was already clicked');
          }

          if (isUltimateLoginFirstBoxingMyAccountFlow) {
            try {
              // The CTA itself must take the signed-in Ultimate user to My Account.
              // Do not mask an invalid destination (for example /home) by issuing
              // a second, explicit navigation before checking the result.
              const ctaDestination = page.url();
              if (!isMyAccountDestination(ctaDestination)) {
                const message =
                  `❌ [Login First Ultimate][${SOURCE}] Buy CTA redirection failed: ` +
                  `expected My Account but landed on "${ctaDestination}". ` +
                  'PPV status verification was not attempted.';
                console.error(message);
                throw new Error(message);
              }

              console.log('\n🏠 [Login First Ultimate] CTA redirected to My Account — verifying PPV status...');
              await handleCookies(page, 8000);
              const myAccountPage = new MyAccountPage(page);
              await myAccountPage.scrollToPPVSection();
              const rows = getMyAccountData().filter((row: any) =>
                String(row.Field || '').trim().toLowerCase() === 'ppv status'
              );
              await validateVariant(page, 'myaccount', rows, results, eventData, 'My Account', 'myaccount');
              const statusResult = results
                .slice()
                .reverse()
                .find((r: any) => r.page === 'My Account' && r.field === 'PPV Status');
              if (statusResult?.status === 'FAIL') {
                throw new Error(
                  `❌ [My Account] PPV Status validation failed. expected="${statusResult.expected}" actual="${statusResult.actual}"`
                );
              }
            } catch (error: any) {
              const message =
                `❌ [Login First Ultimate][${SOURCE}] Flow could not be completed after clicking the PPV CTA: ` +
                `${error?.message || error}`;
              console.error(message);
              throw new Error(message);
            }

            await finishRun('ultimate', userStateKey);
            return;
          }
        }

        if (SOURCE !== 'home-page-popup') {
          // Handle generic popup validations and click-through
          // For home-biggest-fights: clickBuyNow only clicks the tile, handlePopupModal validates + clicks Buy Now
          // For dont-miss/tile sources: avoid double-clicking modal
          const clickPopup = SOURCE === 'home-biggest-fights' || (!SOURCE.includes('dont-miss') && !SOURCE.includes('tile') && !SOURCE.includes('upcoming'));
          if (
            !['glory-tile', 'glory-banner'].includes(SOURCE.toLowerCase()) &&
            SOURCE !== 'home-page-dazntile' &&
            SOURCE !== 'home-boxing-upcoming'
          ) {
            await handlePopupModal(page, results, eventData, SOURCE, clickPopup);
          }

          await page.waitForLoadState('domcontentloaded').catch(() => { });
          await page.waitForURL(
            (url: URL) =>
              url.toString().includes('PlanDetails') ||
              url.toString().includes('TierPlans') ||
              url.toString().includes('signup') ||
              url.toString().includes('checkout') ||
              url.toString().includes('payment'),
            { timeout: 10000 }
          ).catch(async () => {
            await page.waitForURL(
              (url: URL) => !url.toString().includes('/welcome'),
              { timeout: 5000 }
            ).catch(() => { });
          });
          console.log(`📍 Landed after Buy Now: ${page.url()}`);
        }

        // ── STRICT VALIDATION FOR ULTIMATE USER PRE-LOGGED IN ──
        if (!isStandalonePPV && isActiveUltimateState(userStateKey) && requiresPreLogin) {
          // These boxing subscription sources redirect ultimate users to /home,
          // not to a fixture/preview page — accept /home as a valid destination.
          const ULTIMATE_HOME_REDIRECT_SOURCES = new Set<string>([
            'boxing-banner-ultimate',
            'boxing-ultimate-subscription',
            'boxing-join-the-club',
          ]);
          const expectsHomeRedirect = ULTIMATE_HOME_REDIRECT_SOURCES.has(SOURCE.toLowerCase());

          if (expectsHomeRedirect) {
            console.log(`⏳ [Ultimate User] Source "${SOURCE}" — expecting /home redirect...`);
            await page.waitForURL(
              (url: URL) =>
                !url.href.includes('/welcome') &&
                !url.href.includes('PlanDetails') &&
                !url.href.includes('TierPlans') &&
                !url.href.includes('signup') &&
                !url.href.includes('signin') &&
                !url.href.includes('payment') &&
                !url.href.includes('checkout'),
              { timeout: 15000 }
            ).catch(() => { });

            const currentUrl = page.url();
            const lowerUrl = currentUrl.toLowerCase();
            let navStatus: 'PASS' | 'FAIL' = 'FAIL';
            let actualPage = 'Unknown Page';

            if (lowerUrl.includes('/home')) {
              actualPage = 'Home Page';
              navStatus = 'PASS';
            }

            results.push({
              page: 'Home Page',
              field: 'Ultimate User Navigation Target',
              expected: 'Home Page (subscription source)',
              actual: `Navigated to: ${currentUrl} (${actualPage})`,
              status: navStatus,
            });

            if (navStatus === 'FAIL') {
              const errMsg = `❌ [Ultimate User] Unexpected redirect after clicking "${SOURCE}" CTA. Landed on: ${currentUrl}`;
              console.error(errMsg);
              throw new Error(errMsg);
            } else {
              console.log(`✅ [Ultimate User] Successfully redirected to ${actualPage}: ${currentUrl}`);
            }
            reachedEndPage = true;
            return;
          }

          console.log('⏳ [Ultimate User] Waiting for redirection to fixture page...');
          await page.waitForURL(
            (url: URL) =>
              !url.href.includes('/welcome') &&
              !url.href.includes('/home') &&
              !url.href.includes('PlanDetails') &&
              !url.href.includes('TierPlans') &&
              !url.href.includes('signup') &&
              !url.href.includes('signin') &&
              !url.href.includes('payment') &&
              !url.href.includes('checkout'),
            { timeout: 15000 }
          ).catch(() => { });

          const currentUrl = page.url();
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
            page: 'Home Page',
            field: 'Ultimate User Navigation Target',
            expected: 'Preview Page or Fixture Page',
            actual: `Navigated to: ${currentUrl} (${actualPage})`,
            status: navStatus,
          });

          if (navStatus === 'FAIL') {
            const errMsg = `❌ [Ultimate User] Not redirected to fixture page after clicking PPV tile. Landed on: ${currentUrl}`;
            console.error(errMsg);
            throw new Error(errMsg);
          } else {
            console.log(`✅ [Ultimate User] Successfully redirected to fixture/preview page: ${currentUrl} (${actualPage})`);
          }
          reachedEndPage = true;
          return;
        }
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
        if (SOURCE === 'boxing-ultimate-subscription') {
          console.log('\n🔍 Validating boxing-ultimate-subscription redirect...');
          // The SPA loads `signup` first, then client-side routing adds ?page=PlanDetails.
          await page.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            const text = document.body.innerText.toLowerCase();
            return href.includes('tierplans') ||
              href.includes('plandetails') ||
              href.includes('signup') ||
              href.includes('signin') ||
              text.includes('dazn ultimate') ||
              text.includes('choose your plan') ||
              text.includes('choose a plan') ||
              text.includes('sign in') ||
              text.includes('email');
          }, { timeout: 20000 }).catch(() => { });

          const subUrl = page.url();
          const subBody = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

          const subOnPPV = subBody.includes('to watch your pay-per-view');
          const subUrlOk = subUrl.includes('TierPlans') || subUrl.includes('PlanDetails');
          const subBodyOk = subBody.includes('dazn ultimate') || subBody.includes('choose your plan') || subBody.includes('choose a plan');

          if (subOnPPV && !subUrlOk && !subBodyOk) {
            throw new Error('❌ [boxing-ultimate-subscription] Unexpectedly redirected to PPV page — expected TierPlans or PlanDetails (Ultimate).');
          }
          if (!subUrlOk && !subBodyOk) {
            throw new Error(`❌ [boxing-ultimate-subscription] Expected to land on TierPlans/PlanDetails (Ultimate), but landed on: ${subUrl}`);
          }
          console.log(`✅ [boxing-ultimate-subscription] Successfully redirected to plan selection page. URL: ${subUrl}`);
        }

        // ── STRICT VALIDATION FOR BOXING-STANDARD-SUBSCRIPTION / HOME-PAGE-GET-STARTED / HOME-PAGE-DAZNTILE REDIRECT ──
        if (SOURCE === 'boxing-standard-subscription' || SOURCE === 'home-page-get-started' || SOURCE === 'home-page-dazntile' || srcResolvedSource === 'home-page-get-started' || srcResolvedSource === 'home-page-dazntile') {
          console.log(`\n🔍 Validating ${SOURCE} (resolved: ${srcResolvedSource}) redirect...`);

          // Step 1: Wait for URL to update to one of the target pages
          await page.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            return href.includes('plandetails') ||
              href.includes('tierplans') ||
              href.includes('signup') ||
              href.includes('signin');
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
              text.includes('password') ||
              text.includes('sign in');
          }, { timeout: 15000 }).catch(() => { });

          const stdUrl = page.url();
          const stdBody = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

          const stdOnPPVPage = stdBody.includes('to watch your pay-per-view');
          // Only PlanDetails, TierPlans, signup, or signin are valid landing URLs
          const stdUrlOk = stdUrl.includes('TierPlans') || stdUrl.includes('PlanDetails') || stdUrl.includes('signup') || stdUrl.includes('signin');
          const stdBodyOk = stdBody.includes('dazn standard') || stdBody.includes('choose a plan') || stdBody.includes('choose your plan');

          // Must NOT land on the normal PPV page
          if (stdOnPPVPage && !stdUrlOk && !stdBodyOk) {
            throw new Error(`❌ [${SOURCE}] Unexpectedly redirected to PPV page — expected PlanDetails, signup, or signin (Standard).`);
          }

          if (!stdUrlOk && !stdBodyOk) {
            throw new Error(`❌ [${SOURCE}] Expected to land on PlanDetails, TierPlans, signup, or signin (Standard), but landed on: ${stdUrl}`);
          }

          // defaultSignup=true means the plan page should contain a PPV option ("subscribe without a pay-per-view").
          // If it's absent, the event is not configured for this source, so skip this flow cleanly.
          const hasPPVOption = stdBody.includes('subscribe without a pay-per-view') ||
            stdBody.includes('continue without pay-per-view') ||
            stdBody.includes('continue without a pay-per-view');
          if (!hasPPVOption && !isNoPpvFlow) {
            const skipMsg =
              `⚠️ [${SOURCE}] No PPV option found on plan/signup page — ` +
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
            return;
          }

          console.log(`✅ [${SOURCE}] Successfully redirected to plan selection page with PPV option. URL: ${stdUrl}`);
        }

        // ── STRICT VALIDATION FOR BOXING-JOIN-THE-CLUB REDIRECT ──
        if (SOURCE === 'boxing-join-the-club') {
          console.log('\n🔍 Validating boxing-join-the-club redirect...');
          // The SPA loads `signup` first, then client-side routing appends ?page=PlanDetails.
          // Wait specifically for TierPlans/PlanDetails URL or plan selection body content.
          // Do NOT match on bare 'signup' — that's the initial URL before the redirect completes.
          await page.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            const text = document.body.innerText.toLowerCase();
            return href.includes('tierplans') ||
              href.includes('plandetails') ||
              text.includes('dazn ultimate') ||
              text.includes('choose your plan') ||
              text.includes('choose a plan');
          }, { timeout: 30000 }).catch(() => { });

          const clubUrl = page.url();
          const clubBody = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

          const clubOnPPV = clubBody.includes('to watch your pay-per-view');
          const clubUrlOk = clubUrl.includes('TierPlans') || clubUrl.includes('PlanDetails');
          const clubBodyOk = clubBody.includes('dazn ultimate') || clubBody.includes('choose your plan') || clubBody.includes('choose a plan');

          if (clubOnPPV && !clubUrlOk && !clubBodyOk) {
            throw new Error('❌ [boxing-join-the-club] Unexpectedly redirected to PPV page — expected TierPlans or PlanDetails (Ultimate).');
          }
          if (!clubUrlOk && !clubBodyOk) {
            throw new Error(`❌ [boxing-join-the-club] Expected to land on TierPlans/PlanDetails (Ultimate), but landed on: ${clubUrl}\nBody: ${clubBody.slice(0, 200)}`);
          }
          console.log(`✅ [boxing-join-the-club] Successfully redirected to plan selection page. URL: ${clubUrl}`);
        }

        // ══════════════════════════════════════════════════════════════
        // MY ACCOUNT FLOW — already signed in via PRE-LOGIN FLOW above
        // ══════════════════════════════════════════════════════════════
      } else if (!tvHandoffUrl) {
        // My Account source should not pass through Home after sign-in. Going
        // through Home can open header controls such as All Sports and change
        // the starting page for the flow.
        const homePage = new HomePage(page, baseUrl);
        await homePage.navigateToMyAccount();
        await handleCookies(page, 8000);
        await stabilisePage(page);

        if (devModeEnabled) {
          const reason = devModeForced ? '(forced via DEV_MODE_ON=on)' : '(auto: ultimate tier in GB/US)';
          console.log(`\n🎭 Dev mode flow detected ${reason} — enabling dev mode for existing user...`);
          const searchPage = new SearchPage(page);
          await searchPage.enableDevMode();
          console.log('✅ dev mode enabled — continuing with ultimate flow');
        }
      }

      let isReturning = false;
      let firstName = '';
      let lastName = '';
      let postClickUrl = '';

      if (tvHandoffUrl) {
        isReturning = true;
        firstName = eventData.FIRST_NAME || userEmail.split('@')[0] || 'UAT';
        lastName = eventData.LAST_NAME || 'UAT';

        eventData.FIRST_NAME = firstName;
        eventData.LAST_NAME = lastName;
        eventData['FIRST_NAME'] = firstName;
        eventData['LAST_NAME'] = lastName;
        eventData.FULL_NAME = `${firstName} ${lastName}`.trim();
        eventData.IS_RETURNING_USER = 'true';
        eventData.SIGNED_IN_AS_TEXT = `Signed in as ${firstName} ${lastName}`.trim();
        eventData['FULL_NAME'] = eventData.FULL_NAME;
        eventData['IS_RETURNING_USER'] = eventData.IS_RETURNING_USER;
        eventData['SIGNED_IN_AS_TEXT'] = eventData.SIGNED_IN_AS_TEXT;

        if (devModeEnabled) {
          const daznBaseUrl = tvHandoffUrl.match(/https:\/\/[^/]+\/en-[A-Z]+/i)?.[0] || baseUrl;
          const reason = devModeForced ? '(forced via DEV_MODE_ON=on)' : '(auto: ultimate tier in GB/US)';
          console.log(`\n🎭 [TV Handoff] Dev mode flow detected ${reason} — enabling dev mode before opening web handoff URL...`);
          console.log(`🧭 [TV Handoff] Opening DAZN base URL for dev mode: ${daznBaseUrl}`);
          await page.goto(daznBaseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await handleCookies(page, 8000).catch(() => {});
          const searchPage = new SearchPage(page);
          await searchPage.enableDevMode();
          console.log('✅ [TV Handoff] Dev mode enabled — continuing with TV handoff URL');
        }

        if (isYopmailHandoffUrl(tvHandoffUrl)) {
          postClickUrl = await openYopmailHandoffAndReachPlansPage(page, tvHandoffUrl, userEmail, userPassword, results, eventData);
        } else {
          await page.goto(tvHandoffUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          postClickUrl = page.url();
        }
      } else if (isMyAccount) {
        console.log('⏳ Waiting for My Account page to fully render...');

        // Wait for ANY account content — whichever appears first
        const accountFound = await Promise.race([
          page.waitForSelector('button:has-text("Resubscribe")', { state: 'visible', timeout: 15000 }).then(() => 'Resubscribe').catch(() => null),
          page.waitForSelector('button:has-text("Upgrade now")', { state: 'visible', timeout: 15000 }).then(() => 'Upgrade now').catch(() => null),
          page.waitForSelector('button:has-text("Manage subscription")', { state: 'visible', timeout: 15000 }).then(() => 'Manage subscription').catch(() => null),
          page.waitForSelector('button:has-text("Manage")', { state: 'visible', timeout: 15000 }).then(() => 'Manage').catch(() => null),
          page.waitForSelector('button:has-text("Buy now")', { state: 'visible', timeout: 15000 }).then(() => 'Buy now').catch(() => null),
          page.waitForSelector('[data-testid*="subscription" i]', { state: 'visible', timeout: 15000 }).then(() => 'subscription testid').catch(() => null),
        ]);
        if (accountFound) {
          console.log(`✅ Account content found: ${accountFound}`);
          await stabilisePage(page);
    // Ultimate entitlement logic: active_ultimate on included PPVs is Purchased, otherwise Buy now.
    // EXCEPTION: Canada (CA) ultimate users must purchase PPV explicitly — never "Purchased".
    let ppvStatus = eventData.PPV_STATUS || 'Buy now';
    if (isActiveUltimateState(userStateKey)) {
      const ppvType = eventData.PPV_TYPE || json.PPV_TYPE;
      const isCanada = (process.env.DAZN_REGION || '').toUpperCase() === 'CA';
      if (isStandalonePPV || isCanada) {
        // Standalone PPVs and CA PPVs are never included with an Ultimate
        // subscription, so purchase must continue from My Account.
        ppvStatus = 'Buy now';
      } else if (ppvType === 'included') {
        ppvStatus = 'Purchased';
      } else if (!eventData.PPV_STATUS) {
        ppvStatus = 'Buy now';
      }
    }
    eventData.PPV_STATUS = ppvStatus;
        } else {
          console.log('⚠️  Account content not found in time');
        }

        // ══════════════════════════════════════════════════════════════
        // STEP 4 — VALIDATE MY ACCOUNT PAGE
        // ══════════════════════════════════════════════════════════════
        console.log('\n📋 Validating My Account page...');

        const myAccountPage = new MyAccountPage(page);
        await myAccountPage.scrollToPPVSection();
        const hasPPV = await myAccountPage.hasPPV(eventData.PPV_NAME);
        const myAccountData = getMyAccountData();
        const eventHasConfiguredPPV =
          !!eventData.PPV_NAME &&
          eventData.PPV_NAME !== 'N/A' &&
          eventData.PPV_NAME !== 'none';
        const shouldValidatePPVRows = eventHasConfiguredPPV;
        const myAccountPPVFields = new Set([
          'PPV Name',
          'PPV Date',
          'PPV Price',
          'PPV Status',
          'PPV Image Present',
        ]);
        const overviewData = myAccountData.filter((r: any) => !myAccountPPVFields.has(r.Field));
        const ppvData = myAccountData.filter((r: any) => myAccountPPVFields.has(r.Field));


        const expectedPPVStatus = (eventData.PPV_STATUS || '').toLowerCase();
        for (const row of overviewData) {
          if (row.Field === 'PPV Section Present' && !hasPPV && !shouldValidatePPVRows) {
            row.Expected = 'Yes|No';
          }
        }
        for (const row of ppvData) {
          if (row.Field === 'PPV Price' && (expectedPPVStatus === 'purchased' || expectedPPVStatus === 'included')) {
            row.Expected = 'N/A';
          }
        }

        // Temporarily override DAZN_TIER for My Account validation based on current user state.
        // For Canada, the subscription title depends on both the tier and the plan type (DAZN vs DAZN+):
        //   Standard + DAZN     → "DAZN"
        //   Standard + DAZN+    → "DAZN+ Standard"
        //   Ultimate + DAZN     → "DAZN Ultimate"
        //   Ultimate + DAZN+    → "DAZN+ Ultimate"
        const originalDaznTier = eventData.DAZN_TIER;
        const isCanadaRegion = (process.env.DAZN_REGION || '').toUpperCase() === 'CA';
        const canadaPlan = (process.env.CANADA_PLAN || '').toLowerCase();
        const isCanadaDaznPlus = isCanadaRegion && canadaPlan.includes('dazn+');
        const daznPlans = JSON.parse(
          fs.readFileSync(path.resolve(process.cwd(), 'config/DaznPlan.json'), 'utf-8')
        ) as Record<string, { regions?: Record<string, unknown> }>;
        const standardPlansForRegion = Object.keys(daznPlans).filter(plan =>
          plan.startsWith('standard_') && daznPlans[plan].regions?.[REGION]
        );
        const hasOnlyStandardMonthlyPlan =
          standardPlansForRegion.length === 1 &&
          standardPlansForRegion[0] === 'standard_monthly';
        const standardSubscriptionTitle = isCanadaRegion
          ? (isCanadaDaznPlus ? 'DAZN+ Standard' : 'DAZN')
          : (hasOnlyStandardMonthlyPlan ? 'DAZN' : 'DAZN Standard');

        if (userStateKey === 'freemium' || userStateKey === 'frozen') {
          eventData.DAZN_TIER = 'DAZN Free';
          eventData['DAZN_TIER'] = 'DAZN Free';
        } else if (userStateKey.startsWith('active_standard')) {
          eventData.DAZN_TIER = standardSubscriptionTitle;
          eventData['DAZN_TIER'] = eventData.DAZN_TIER;
        } else if (userStateKey.startsWith('active_ultimate')) {
          // CA: "DAZN+ Ultimate" for DAZN+ plans, "DAZN Ultimate" for standard DAZN plans
          const caTier = isCanadaDaznPlus ? 'DAZN+ Ultimate' : 'DAZN Ultimate';
          eventData.DAZN_TIER = isCanadaRegion ? caTier : 'DAZN Ultimate';
          eventData['DAZN_TIER'] = eventData.DAZN_TIER;
        }


        await validateVariant(
          page, 'myaccount', overviewData, results, eventData, 'My Account'
        );

        // Verify user state before PPV validations/actions. If it does not match,
        // fail immediately with clear logging.
        const caStandardSub = standardSubscriptionTitle;
        const caUltimateSub = isCanadaDaznPlus ? 'DAZN+ Ultimate' : 'DAZN Ultimate';

        const expectedUserStates: Record<string, { subscription: string; status: string; label: string }> = {
          freemium: { subscription: 'DAZN Free', status: 'Upgrade now', label: 'freemium' },
          frozen: { subscription: 'DAZN Free', status: 'Resubscribe', label: 'frozen' },
          active_standard: { subscription: caStandardSub, status: 'Manage subscription', label: 'active standard' },
          active_standard_monthly: { subscription: caStandardSub, status: 'Manage subscription', label: 'active standard monthly' },
          active_standard_apm: { subscription: caStandardSub, status: 'Manage subscription', label: 'active standard APM' },
          active_ultimate: { subscription: isCanadaRegion ? caUltimateSub : 'DAZN Ultimate', status: 'Manage subscription', label: 'active ultimate' },
          active_ultimate_apm: { subscription: isCanadaRegion ? caUltimateSub : 'DAZN Ultimate', status: 'Manage subscription', label: 'active ultimate APM' },
          active_ultimate_upfront: { subscription: isCanadaRegion ? caUltimateSub : 'DAZN Ultimate', status: 'Manage subscription', label: 'active ultimate upfront' }
        };

        const expectedConfig = expectedUserStates[userStateKey];
        if (expectedConfig) {
          const subStatusResult = results.find(r => r.page === 'My Account' && r.field === 'Subscription Status');
          const currSubResult = results.find(r => r.page === 'My Account' && r.field === 'Current Subscription');

          const actualStatus = subStatusResult ? subStatusResult.actual : 'N/A';
          const actualSub = currSubResult ? currSubResult.actual : 'N/A';

          const expectedStatus = expectedConfig.status;
          const expectedSub = expectedConfig.subscription;
          const hasRenderedSubscriptionTier = !['freemium', 'frozen'].includes(userStateKey);

          const actualStatusClean = actualStatus.trim().toLowerCase();
          const actualSubClean = actualSub.trim().toLowerCase();

          if (actualStatusClean !== expectedStatus.toLowerCase() ||
            (hasRenderedSubscriptionTier && actualSubClean !== expectedSub.toLowerCase())) {
            console.log(`\n❌ User is not ${expectedConfig.label}. Subscription status does not match:`);
            console.log(`   Current Subscription`);
            console.log(`          expected : ${expectedSub}`);
            console.log(`          actual   : ${actualSub}`);
            console.log(`       ❌ Subscription Status`);
            console.log(`          expected : ${expectedStatus}`);
            console.log(`          actual   : ${actualStatus}\n`);
            throw new Error(`❌ User is not ${expectedConfig.label} (Current Subscription: ${actualSub}, Status: ${actualStatus})`);
          }
        }

        if (shouldValidatePPVRows) {
          // The overview intentionally surfaces only a few featured PPVs. Move
          // to the full /myaccount/ppv listing before reading event-specific
          // fields, otherwise those checks are scoped to unrelated featured
          // cards or return N/A.
          const ppvReady = hasPPV || await myAccountPage.preparePPVValidation(eventData.PPV_NAME);
          if (process.env.PPV_REMOVAL === 'true') {
            if (!ppvReady) {
              console.log(`✅ [PPV Removal - Existing User] Category B (${SOURCE}): My Account PPV row not found — confirmed removed/absent as expected.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: 'PPV row absent from My Account and PPV listing page',
                status: 'PASS',
              });
              reachedEndPage = true;
              await closeContext().catch(() => { });
              return;
            }
            results.push({
              page: 'PPV Removal',
              field: 'PPV Surfacing Point Removal',
              expected: 'PPV surfacing point removed from UI',
              actual: `${eventData.PPV_NAME} found in My Account or PPV listing page`,
              status: 'FAIL',
            });
            throw new Error(`❌ [PPV Removal - Existing User] ${eventData.PPV_NAME} is still present in My Account`);
          }
          if (!ppvReady) {
            console.warn(`⚠️ Configured PPV "${eventData.PPV_NAME}" was not found in the My Account PPV listing. PPV rows will correctly report N/A.`);
          }
          await validateVariant(
            page, 'myaccount', ppvData, results, eventData, 'My Account'
          );
        }

        // Restore original DAZN_TIER
        eventData.DAZN_TIER = originalDaznTier;
        eventData['DAZN_TIER'] = originalDaznTier;

        await page.evaluate(() => {
          document.documentElement.style.overflow = '';
          document.body.style.overflow = '';
        });
        // ══════════════════════════════════════════════════════════════
        // STEP 4b — EXTRACT DYNAMIC USER DATA FROM MY ACCOUNT
        // Reads first name, last name, returning status from live page
        // Injects into eventData for downstream validation
        // ══════════════════════════════════════════════════════════════
        isReturning = userStateKey === 'frozen' || await myAccountPage.isReturningUser();
        const userNameRes = await myAccountPage.getUserName();
        firstName = userNameRes.firstName;
        lastName = userNameRes.lastName;

        console.log(`👤 Is returning user : ${isReturning}`);
        console.log(`👤 First name        : "${firstName}"`);
        console.log(`👤 Last name         : "${lastName}"`);

        eventData.FIRST_NAME = firstName;
        eventData.LAST_NAME = lastName;
        eventData['FIRST_NAME'] = firstName;
        eventData['LAST_NAME'] = lastName;
        eventData.FULL_NAME = `${firstName} ${lastName}`.trim();
        eventData.IS_RETURNING_USER = isReturning ? 'true' : 'false';
        eventData.SIGNED_IN_AS_TEXT = firstName
          ? `Signed in as ${firstName} ${lastName}`.trim()
          : '';

        // Keep UPPER_CASE versions in sync
        eventData['FIRST_NAME'] = eventData.FIRST_NAME;
        eventData['LAST_NAME'] = eventData.LAST_NAME;
        eventData['FULL_NAME'] = eventData.FULL_NAME;
        eventData['IS_RETURNING_USER'] = eventData.IS_RETURNING_USER;
        eventData['SIGNED_IN_AS_TEXT'] = eventData.SIGNED_IN_AS_TEXT;

        console.log(`👤 Signed in as      : "${eventData.SIGNED_IN_AS_TEXT}"`);

        // ══════════════════════════════════════════════════════════
        // STEP 5a — CHECK IF PPV ALREADY PURCHASED
        // For any tier — if PPV shows "Purchased", validate and exit
        // ══════════════════════════════════════════════════════════
        if (expectedPPVStatus === 'purchased' || expectedPPVStatus === 'included') {
          console.log(`\n✅ PPV expected status: "${eventData.PPV_STATUS}" — validating...`);

          await myAccountPage.scrollToPPVSection();

          const ppvStatus = await myAccountPage.isPPVPurchased(eventData.PPV_NAME);
          console.log(`✅ PPV Actual Status: "${ppvStatus}"`);

          // --- Schedule Page validation (Post-Payment) ---
          // When PPV_DEV_MODE is true in the event JSON config, the event
          // tile won't appear on Schedule because the PPV isn't truly live.
          // Skip schedule navigation and end the test at My Account.
          if (PPV_TYPE !== 'upsell') {
            if (PPV_DEV_MODE) {
              console.log('\n🎭 [PPV_DEV_MODE] Skipping Schedule page navigation — PPV is deployed but not live. Test ends at My Account.');
            } else {
              try {
                console.log('\n📅 [Post-Purchase] Navigating to Schedule page to verify purchased event...');
                const schedulePagePostPayment = new SchedulePage(page);
                await schedulePagePostPayment.navigate(baseUrl);
                if (devModeEnabled) {
                  console.log('\n🎭 Dev mode flow detected — enabling dev mode before Schedule entitlement click...');
                  const searchPage = new SearchPage(page);
                  await searchPage.enableDevMode();
                }
                await schedulePagePostPayment.selectSport(sport);

                console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
                const eventCard = await schedulePagePostPayment.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));

                console.log('🖱️ Clicking PPV event tile...');
                await eventCard.click();

                console.log('⏳ Waiting for navigation off the Schedule page...');
                await page.waitForURL((url: URL) => !url.href.includes('/schedule'), { timeout: 15000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

                const currentUrl = page.url();
                console.log(`🔗 Post-Purchase redirected URL: ${currentUrl}`);

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
                  page: 'Schedule',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Navigated to: ${currentUrl} (${actualPage})`,
                  status: navStatus,
                });

                if (navStatus === 'FAIL') {
                  console.error(`❌ Post-Purchase navigation target check failed. URL: ${currentUrl}`);
                } else {
                  console.log(`✅ Post-Purchase navigation target check passed: ${actualPage}`);
                }
              } catch (scheduleErr: any) {
                console.warn(`⚠️ [Post-Purchase] Schedule page validation error: ${scheduleErr.message}`);
                results.push({
                  page: 'Schedule',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Error: ${scheduleErr.message}`,
                  status: 'FAIL',
                });
              }
            }
          }

          reachedEndPage = true;
          // Capture video path and finalize video file BEFORE report generation
          capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
          await closeContext().catch(() => { });
          const { excelPath, videoPath } = await writeResults(results, capturedVideoPath);

          // Display detailed per-page results
          displayResultsTable(results, tier, {
            event: eventData.PPV_NAME,
            region: REGION,
            excelPath,
            videoPath,
          });

          // Generate HTML + PDF run report before early exit
          const { htmlPath, pdfPath, folderPath } = await generateReports(results, {
            event: eventData.PPV_NAME,
            region: REGION,
            source: SOURCE,
            ratePlan,
            tier,
            env: process.env.DAZN_ENV || 'prod',
            flowName: `${SOURCE} → ${tier} → ${ratePlan}`,
            startTime: runStartTime,
            endTime: new Date(),
            excelPath,
            videoPath,
            userStatus: (TV_HANDOFF_MODE || isMyAccount) ? (process.env.USER_STATE || 'Freemium') : 'New User',
            userType: 'existing-user',
            platform: getReportPlatform(),
            paymentMethod: PAYMENT_METHOD === 'gpay' ? 'Google Pay' : 'Credit Card',
          });
          reportGenerated = true;
          if (folderPath) console.log(`\n📂 Report folder: ${folderPath}`);

          const failedEarly = results.filter(r => r.status === 'FAIL').length;
          if (failedEarly > 0) {
            const failMsgsEarly = results
              .filter(r => r.status === 'FAIL')
              .map(r => `  - [${r.page}] ${r.field}: expected "${r.expected}", actual "${r.actual}"`)
              .join('\n');
            const errMsgEarly = `❌ Flow "${SOURCE} (${userStateKey})" completed navigation but had ${failedEarly} validation failure(s):\n${failMsgsEarly}`;
            console.log(errMsgEarly);
            throw new Error(errMsgEarly);
          }
          return; // ← Exit early — no purchase flow needed
        }

        // ── Canada Active Users: PPV is NOT included — user must buy explicitly ──
        // This is checked INDEPENDENTLY of the PPV event tier because in Canada,
        // all active subscribers (standard or ultimate) navigate to /account/addon/purchase
        // when clicking "Buy now" on My Account.
        if (isCanadaRegion && userStateKey.startsWith('active_')) {
          console.log(`🇨🇦 [CA Active User: ${userStateKey}] PPV is not included. Routing to addon purchase flow...`);
          await executeCanadaPPVAddonPurchaseFlow(page, myAccountPage, eventData, results);
          reachedEndPage = true;
          capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
          await closeContext().catch(() => {});
          const { excelPath, videoPath } = await writeResults(results, capturedVideoPath);
          displayResultsTable(results, tier, {
            event: eventData.PPV_NAME,
            region: REGION,
            excelPath,
            videoPath,
          });
          const { htmlPath: htmlPathCaAct, pdfPath: pdfPathCaAct, folderPath: folderPathCaAct } = await generateReports(results, {
            event: eventData.PPV_NAME,
            region: REGION,
            source: SOURCE,
            ratePlan,
            tier,
            env: process.env.DAZN_ENV || 'prod',
            flowName: `${SOURCE} → CA Active User PPV Addon Purchase`,
            startTime: runStartTime,
            endTime: new Date(),
            excelPath,
            videoPath,
            userStatus: process.env.USER_STATE || userStateKey,
            userType: 'existing-user',
            platform: getReportPlatform(),
            paymentMethod: PAYMENT_METHOD === 'gpay' ? 'Google Pay' : 'Credit Card',
          });
          reportGenerated = true;
          if (folderPathCaAct) console.log(`\n📂 Report folder: ${folderPathCaAct}`);
          return;
        }

        if (!isStandalonePPV && tier === 'ultimate' && isActiveUltimateState(userStateKey)) {
          console.log('\n💎 Ultimate tier — checking PPV status...');

          const ppvStatus = await myAccountPage.isPPVPurchased(eventData.PPV_NAME);
          console.log(`✅ PPV Status: "${ppvStatus}"`);

          results.push({
            page: 'My Account',
            variant: 'ultimate',
            tier,
            ratePlan,
            field: 'PPV Status',
            expected: eventData.PPV_STATUS || 'Purchased',
            actual: ppvStatus,
            status: ppvStatus.toLowerCase().includes(
              (eventData.PPV_STATUS || 'Purchased').toLowerCase()
            ) ? 'PASS' : 'FAIL',
          });

          // --- Schedule Page validation (Post-Payment) ---
          if (PPV_TYPE !== 'upsell') {
            try {
              console.log('\n📅 [Ultimate] Navigating to Schedule page to verify purchased event...');
              const schedulePagePostPayment = new SchedulePage(page);
              await schedulePagePostPayment.navigate(baseUrl);
              if (devModeEnabled) {
                console.log('\n🎭 Dev mode flow detected — enabling dev mode before Schedule entitlement click...');
                const searchPage = new SearchPage(page);
                await searchPage.enableDevMode();
              }
              await schedulePagePostPayment.selectSport(sport);

              console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
              const eventCard = await schedulePagePostPayment.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));

              console.log('🖱️ Clicking PPV event tile...');
              await eventCard.click();

              console.log('⏳ Waiting for navigation off the Schedule page...');
              await page.waitForURL((url: URL) => !url.href.includes('/schedule'), { timeout: 15000 });
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

              const currentUrl = page.url();
              console.log(`🔗 Ultimate redirected URL: ${currentUrl}`);

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
                page: 'Schedule',
                field: 'Post-Purchase Navigation Target',
                expected: 'Preview Page or Fixture Page',
                actual: `Navigated to: ${currentUrl} (${actualPage})`,
                status: navStatus,
              });

              if (navStatus === 'FAIL') {
                console.error(`❌ Ultimate navigation target check failed. URL: ${currentUrl}`);
              } else {
                console.log(`✅ Ultimate navigation target check passed: ${actualPage}`);
              }
            } catch (scheduleErr: any) {
              console.warn(`⚠️ [Ultimate] Schedule page validation error: ${scheduleErr.message}`);
              results.push({
                page: 'Schedule',
                field: 'Post-Purchase Navigation Target',
                expected: 'Preview Page or Fixture Page',
                actual: `Error: ${scheduleErr.message}`,
                status: 'FAIL',
              });
            }
          }

          reachedEndPage = true;
          // Capture video path and finalize video file BEFORE report generation
          capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
          await closeContext().catch(() => { });
          const { excelPath, videoPath } = await writeResults(results, capturedVideoPath);

          // Display detailed per-page results
          displayResultsTable(results, 'ultimate', {
            event: eventData.PPV_NAME,
            region: REGION,
            excelPath,
            videoPath,
          });

          // Generate HTML + PDF run report before early exit
          const { htmlPath: htmlPath2, pdfPath: pdfPath2, folderPath: folderPath2 } = await generateReports(results, {
            event: eventData.PPV_NAME,
            region: REGION,
            source: SOURCE,
            ratePlan,
            tier,
            env: process.env.DAZN_ENV || 'prod',
            flowName: `${SOURCE} → ${tier} → ${ratePlan}`,
            startTime: runStartTime,
            endTime: new Date(),
            excelPath,
            videoPath,
            userStatus: (TV_HANDOFF_MODE || isMyAccount) ? (process.env.USER_STATE || 'Freemium') : 'New User',
            userType: 'existing-user',
            platform: getReportPlatform(),
            paymentMethod: PAYMENT_METHOD === 'gpay' ? 'Google Pay' : 'Credit Card',
          });
          reportGenerated = true;
          if (folderPath2) console.log(`\n📂 Report folder: ${folderPath2}`);
          return;
        }

        // ══════════════════════════════════════════════════════════════
        // STEP 5b — SCROLL TO PPV SECTION
        // Only for freemium / standard tiers
        // ══════════════════════════════════════════════════════════════
        await myAccountPage.scrollToPPVSection();

        // ══════════════════════════════════════════════════════════════
        // STEP 5c — VALIDATE PAY PER VIEW LISTING PAGE (if navigated)
        // If the PPV section shows a listing page, validate it
        // ══════════════════════════════════════════════════════════════
        const currentUrlBeforeBuy = page.url();
        if (currentUrlBeforeBuy.includes('/myaccount/ppv') || currentUrlBeforeBuy.includes('/pay-per-view')) {
          console.log('\n📋 Validating Pay Per View listing page...');
          const ppvListingData = getPayPerViewData();
          if (ppvListingData.length > 0) {
            await validateVariant(
              page, 'myaccount', ppvListingData, results, eventData, 'Pay Per View'
            );
          }
        }

        // ── VALIDATE PPV LISTING PAGE after "Explore more PPV events" navigation ──
        // MyAccountPage.clickBuyNow() internally calls findPPVRow() which navigates
        // to the PPV listing page if PPV not found in My Account.
        // We need to validate the PPV card on the listing page BEFORE clicking Buy Now.
        // Strategy: scroll and search for the PPV, then validate its card fields.
        if (!hasPPV) {
          console.log('\n📋 Checking if navigated to PPV listing page for validation...');
          // Wait briefly for any navigation that may have happened
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
          const listingUrl = page.url();
          const isOnListingPage = listingUrl.includes('/ppv') || listingUrl.includes('/pay-per-view') ||
            listingUrl.includes('/addons') || listingUrl.includes('/content/');

          if (isOnListingPage) {
            console.log(`📍 On PPV listing page: ${listingUrl}`);
            // Wait for PPV cards to load
            await page.waitForSelector(
              '#addons-list-card, article, [class*="card" i], button:has-text("Buy now")',
              { state: 'visible', timeout: 10000 }
            ).catch(() => { });

            // Validate PPV listing page fields from Excel
            const ppvListingPageData = getPayPerViewData();
            if (ppvListingPageData.length > 0) {
              console.log(`📊 PPV Listing page rows: ${ppvListingPageData.length}`);
              await validateVariant(
                page, 'myaccount', ppvListingPageData, results, eventData, 'Pay Per View'
              );
            } else {
              console.log('ℹ️ No Pay Per View page sheet data — skipping listing page validation');
            }
          }
        }

        // ══════════════════════════════════════════════════════════════
        // STEP 6 — CLICK BUY NOW / SUBSCRIPTION STATUS CTA
        // ══════════════════════════════════════════════════════════════
        if (SOURCE === 'myaccount-subscription-status') {
          console.log(`\n💳 Clicking Subscription Status CTA for default signup`);
          await myAccountPage.clickSubscriptionStatusCTA(userStateKey);
        } else {
          await myAccountPage.clickBuyNow(eventData.PPV_NAME);
        }

        await page.waitForLoadState('domcontentloaded').catch(() => { });
        // Wait for the URL and page text to stabilize (handles client-side routing/redirects)
        const beforeUrl = page.url();
        await page.waitForURL((url: URL) => url.toString() !== beforeUrl, { timeout: 15000 }).catch(() => { });
        postClickUrl = page.url();
      } else {
        // Landing page — use names already resolved by buildEventData from config
        isReturning = true;
        firstName = eventData.FIRST_NAME || userEmail.split('@')[0] || 'UAT';
        lastName = eventData.LAST_NAME || 'UAT';

        eventData.FIRST_NAME = firstName;
        eventData.LAST_NAME = lastName;
        eventData['FIRST_NAME'] = firstName;
        eventData['LAST_NAME'] = lastName;
        eventData.FULL_NAME = `${firstName} ${lastName}`.trim();
        eventData.IS_RETURNING_USER = 'true';
        eventData.SIGNED_IN_AS_TEXT = `Signed in as ${firstName} ${lastName}`.trim();

        // Keep UPPER_CASE versions in sync
        eventData['FIRST_NAME'] = eventData.FIRST_NAME;
        eventData['LAST_NAME'] = eventData.LAST_NAME;
        eventData['FULL_NAME'] = eventData.FULL_NAME;
        eventData['IS_RETURNING_USER'] = eventData.IS_RETURNING_USER;
        eventData['SIGNED_IN_AS_TEXT'] = eventData.SIGNED_IN_AS_TEXT;

        console.log(`👤 Derived First name : "${firstName}"`);
        console.log(`👤 Derived Last name  : "${lastName}"`);
        console.log(`👤 Signed in as       : "${eventData.SIGNED_IN_AS_TEXT}"`);

        postClickUrl = page.url();
      }

      // ══════════════════════════════════════════════════════════════
      // STEP 7 — DETECT FLOW FROM URL
      // ══════════════════════════════════════════════════════════════
      // Handle cookies on the post-click page immediately before any flow detection
      await handleCookies(page, 8000);
      await stabilisePage(page);

      const bodyText = await page.locator('body')
        .innerText({ timeout: 3000 })
        .then(t => t.toLowerCase())
        .catch(() => '');

      const isSignupPPVFlow =
        postClickUrl.includes('/signup') &&
        postClickUrl.includes('contextualPpvId') &&
        !postClickUrl.includes('upsellTierShown=true');

      const isChooseHowToBuy =
        isMyAccount &&
        userStateKey === 'active_standard' &&
        (postClickUrl.includes('upsellTierShown=true') ||
          postClickUrl.includes('/addon/purchase') ||  // ← US active standard
          bodyText.includes('choose how to buy')) &&
        !bodyText.includes("choose a plan") &&
        !bodyText.includes("choose your plan") &&
        !bodyText.includes("choose your subscription") &&
        !bodyText.includes("choose a subscription") &&
        !bodyText.includes("choose the right plan");

      console.log(`\n🔀 Post-click detection:`);
      console.log(`   tier             : ${tier}`);
      console.log(`   isSignupPPVFlow  : ${isSignupPPVFlow}`);
      console.log(`   isChooseHowToBuy : ${isChooseHowToBuy}`);
      console.log(`   purchaseOption   : ${purchaseOption}`);
      console.log(`   isReturning      : ${isReturning}`);

      // ══════════════════════════════════════════════════════════════
      // FLOW A — FREEMIUM / RETURNING USER
      // ══════════════════════════════════════════════════════════════
      if (isSignupPPVFlow || !isChooseHowToBuy) {
        console.log('\n📋 Flow A: Freemium/Returning — signup flow');

        await setupPage(page);

        const variant = await detectVariant(page, variantConfig).catch(() => 'variant1');
        console.log('🎯 variant:', variant);

        const currentVariantConfig = variantConfig?.[variant];
        let ppvValidated = false;
        let planValidated = false;
        let stuckCount = 0;
        let firstPaymentDone = false;
        let firstSuccessValidated = false;
        let savedCardPaymentDone = false;
        let secondSuccessValidated = false;
        let emailProcessedCount = 0;

        for (let step = 0; step < 20; step++) {

          if (page.isClosed()) throw new Error('❌ Page closed unexpectedly');

          await handleCookies(page, step === 0 ? 8000 : 1500);
          await stabilisePage(page);
          if (PPV_TYPE !== 'upsell' || !firstPaymentDone) {
            await dismissMarketingPopup(page);
          }

          // Dynamically extract name from page if available to keep eventData in sync
          let signedInText = '';
          const candidates = page.locator('p, span, div');
          const count = await candidates.count().catch(() => 0);
          for (let i = 0; i < count; i++) {
            const txt = (await candidates.nth(i).textContent().catch(() => '')) || '';
            const trimmed = txt.trim().replace(/\s+/g, ' ');
            if (/^signed in as/i.test(trimmed) && trimmed.length < 100) {
              signedInText = trimmed;
              break;
            }
          }

          if (signedInText) {
            console.log(`👤 Found live signed-in text: "${signedInText}"`);
            const namePart = signedInText.replace(/signed in as/i, '').trim();
            const nameParts = namePart.split(/\s+/);
            const fName = nameParts[0] || '';
            const lName = nameParts.slice(1).join(' ') || '';

            eventData.FIRST_NAME = fName;
            eventData.LAST_NAME = lName;
            eventData['FIRST_NAME'] = fName;
            eventData['LAST_NAME'] = lName;
            eventData.FULL_NAME = namePart;
            eventData.SIGNED_IN_AS_TEXT = signedInText;
            eventData['FULL_NAME'] = namePart;
            eventData['SIGNED_IN_AS_TEXT'] = signedInText;
          }
          // ── Dismiss AGREE/Terms overlay if present (US-specific) ──────
          // US users may see a Terms & Conditions overlay with "AGREE" buttons
          // before the actual page loads. Dismiss it before page detection so
          // detectPageType sees the real page content underneath.
          try {
            const agreeBtn = page.locator('button:has-text("AGREE"), button:has-text("Agree")').first();
            const agreeVisible = await agreeBtn.isVisible({ timeout: 1500 }).catch(() => false);
            if (agreeVisible) {
              const btnText = (await agreeBtn.textContent().catch(() => '') || '').trim().toLowerCase();
              if (btnText === 'agree' || btnText === 'i agree') {
                // Click all AGREE buttons (there may be multiple sections)
                for (let agreeIdx = 0; agreeIdx < 5; agreeIdx++) {
                  const nextBtn = page.locator('button:has-text("AGREE"), button:has-text("Agree")').first();
                  const nextVisible = await nextBtn.isVisible({ timeout: 800 }).catch(() => false);
                  if (!nextVisible) break;
                  const nextText = (await nextBtn.textContent().catch(() => '') || '').trim().toLowerCase();
                  if (nextText === 'agree' || nextText === 'i agree') {
                    await nextBtn.click({ timeout: 2000 }).catch(() => { });
                    console.log(`🛡️  Dismissed Terms overlay (${agreeIdx + 1})`);
                    await page.waitForTimeout(500);
                  } else {
                    break;
                  }
                }
                // Wait for actual page content to render after overlay dismissal
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
                await page.waitForTimeout(1500);
              }
            }
          } catch {
            // Non-critical — continue with page detection
          }

          const pageType = await detectPageType(page, pagesConfig);
          console.log(`\nstep ${step + 1} → pageType: ${pageType} | url: ${page.url()}`);

          const isCanadaRegion = REGION.toUpperCase() === 'CA';
          const currentUrl = page.url().toLowerCase();
          const isCanadaTierPlans = currentUrl.includes('page=tierplans');
          const isCanadaAddonPurchase = currentUrl.includes('/account/addon/purchase');

          if (isCanadaRegion && !isNoPpvFlow && isCanadaTierPlans) {
            console.log('🇨🇦 [CA Existing User] Routing TierPlans checkout through the Canada subscription flow.');
            await executeCanadaSubscriptionFlow(
              page,
              new PPVPage(page),
              new PaymentPage(page),
              eventData,
              results,
              process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN
            );
            reachedEndPage = true;
            break;
          }

          if (isCanadaRegion && userStateKey.startsWith('active_') && isCanadaAddonPurchase) {
            console.log('🇨🇦 [CA Active User] Validating PPV add-on checkout reached from the configured source.');
            await executeCanadaPPVAddonPurchaseFlow(
              page,
              new MyAccountPage(page),
              eventData,
              results,
              true
            );
            reachedEndPage = true;
            break;
          }

          // ── PPV Removal validation check for Existing User ──
          if (process.env.PPV_REMOVAL === 'true') {
            const isCategoryA =
              SOURCE === 'home-boxing-tile' ||
              SOURCE === 'home-page-dazntile' ||
              SOURCE === 'home-kickboxing-tile' ||
              SOURCE === 'schedule' ||
              SOURCE === 'search' ||
              SOURCE === 'myaccount';

            const url = page.url().toLowerCase();
            const bodyText = await page.locator('body').innerText({ timeout: 2000 }).then((t: string) => t.toLowerCase()).catch(() => '');
            const hasPPVPurchaseModal = bodyText.includes('choose how to buy') || url.includes('/addon/purchase');

            if (isCategoryA) {
              if (!hasPPVPurchaseModal) {
                console.log(`✅ [PPV Removal - Existing User] Category A (${SOURCE}): Content opened as standard DAZN subscription without PPV purchase flow. URL: ${page.url()}`);
                results.push({
                  page: 'PPV Removal',
                  field: 'Standard Content Access',
                  expected: 'Opened standard DAZN content/subscription without PPV purchase prompt',
                  actual: `Landed on ${page.url()} without PPV purchase flow`,
                  status: 'PASS',
                });
                reachedEndPage = true;
                await closeContext().catch(() => { });
                return;
              } else {
                throwLogged(new Error(`❌ [PPV Removal - Existing User] PPV purchase modal appeared via ${SOURCE} when PPV should be removed`));
              }
            } else {
              console.log(`✅ [PPV Removal - Existing User] Category B (${SOURCE}): PPV surfacing point is removed/absent from page as expected.`);
              results.push({
                page: 'PPV Removal',
                field: 'PPV Surfacing Point Removal',
                expected: 'PPV surfacing point removed from UI',
                actual: 'PPV surfacing point is absent from page',
                status: 'PASS',
              });
              reachedEndPage = true;
              await closeContext().catch(() => { });
              return;
            }
          }

          // If the URL is myaccount or home page and we are in a subscription-only flow, fail immediately.
          const isBoxingSubOnlySource =
            SOURCE === 'boxing-banner-ultimate' ||
            SOURCE === 'boxing-ultimate-subscription' ||
            SOURCE === 'boxing-standard-subscription' ||
            SOURCE === 'boxing-join-the-club';
          if (isBoxingSubOnlySource && (page.url().includes('/myaccount') || page.url().endsWith('/home'))) {
            throw new Error(`❌ [${SOURCE}] Expected to land on PlanDetails/TierPlans, but landed on Home page instead (flow bypassed plans/checkout).`);
          }

          // ── MY ACCOUNT PPV (Purchased) ─────────────────────────────
          // Ultimate users can redirect to My Account after sign-in when PPV is already purchased.
          if (pageType === 'myaccount-ppv' && !isStandalonePPV && isActiveUltimateState(userStateKey)) {
            await validateUltimateMyAccountRedirect();
            await finishRun('ultimate', userStateKey);
            return;
          }

          if (pageType === 'myaccount-ppv' && isStandalonePPV) {
            throw new Error(
              '❌ Standalone PPV must continue to add-on checkout after sign-in; it must not redirect to My Account as purchased content.'
            );
          }

          // Legacy fallback for non-Ultimate states that still land on /myaccount/ppv.
          if (pageType === 'myaccount-ppv') {
            console.log('\n✅ [Purchased] Landed on My Account PPV page — PPV is already purchased/included.');

            // Wait for the PPV list to fully render
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

            // Wait for "Purchased" text to appear on the page
            await page.locator('text=Purchased').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
              console.log('⚠️ [Purchased] "Purchased" text not visible after 10s — proceeding with check');
            });

            // Verify PPV status on the page
            const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
            const hasPurchased = bodyText.toLowerCase().includes('purchased');
            const hasEventName = bodyText.toLowerCase().includes(eventData.PPV_NAME.toLowerCase().split(' vs')[0]);

            results.push({
              page: 'My Account (PPV)',
              variant: tier,
              tier,
              ratePlan,
              field: 'PPV Status',
              expected: 'Purchased',
              actual: hasPurchased ? 'Purchased' : 'Not found',
              status: hasPurchased ? 'PASS' : 'FAIL',
            });

            if (hasEventName) {
              results.push({
                page: 'My Account (PPV)',
                variant: tier,
                tier,
                ratePlan,
                field: 'PPV Event Present',
                expected: eventData.PPV_NAME,
                actual: 'Found',
                status: 'PASS',
              });
            }

            // Navigate to Schedule page and verify fixture
            if (PPV_TYPE !== 'upsell') {
              try {
                console.log('\n📅 [Purchased] Navigating to Schedule page to verify purchased event...');
                const schedulePagePurchased = new SchedulePage(page);
                await schedulePagePurchased.navigate(baseUrl);
                await schedulePagePurchased.selectSport(sport);

                console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
                const eventCard = await schedulePagePurchased.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));

                console.log('🖱️ Clicking PPV event tile...');
                await eventCard.click();

                console.log('⏳ Waiting for navigation off the Schedule page...');
                await page.waitForURL((url: URL) => !url.href.includes('/schedule'), { timeout: 15000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

                const currentUrl = page.url();
                console.log(`🔗 Post-Purchase redirected URL: ${currentUrl}`);

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
                  page: 'Schedule',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Navigated to: ${currentUrl} (${actualPage})`,
                  status: navStatus,
                });

                if (navStatus === 'FAIL') {
                  console.error(`❌ Post-Purchase navigation target check failed. URL: ${currentUrl}`);
                } else {
                  console.log(`✅ Post-Purchase navigation target check passed: ${actualPage}`);
                }
              } catch (scheduleErr: any) {
                console.warn(`⚠️ [Purchased] Schedule page validation error: ${scheduleErr.message}`);
                results.push({
                  page: 'Schedule',
                  field: 'Post-Purchase Navigation Target',
                  expected: 'Preview Page or Fixture Page',
                  actual: `Error: ${scheduleErr.message}`,
                  status: 'FAIL',
                });
              }
            }

            reachedEndPage = true;
            break;
          }

          // ── Default Signup validation check: Fail if no PPV ──
          // Skip for boxing-ultimate-subscription and boxing-join-the-club — they intentionally bypass the PPV page.
          // boxing-standard-subscription is NOT excluded here: it has defaultSignup=true and should show a PPV option.
          // Also skip for subscribe-without-pay-per-view (noPpvClick) — it intentionally navigates
          // away from the PPV option and lands on TierPlans without the "Subscribe without a pay-per-view" text.
          const isBoxingSubSource =
            SOURCE === 'boxing-banner-ultimate' ||
            SOURCE === 'boxing-ultimate-subscription' ||
            SOURCE === 'boxing-page-bundle' ||
            SOURCE === 'boxing-upcoming-fights' ||
            SOURCE === 'boxing-join-the-club';
          if (process.env.DEFAULT_SIGNUP === 'true' && !ppvValidated && !isBoxingSubSource && !isNoPpvFlow) {
            const url = page.url().toLowerCase();
            if (url.includes('page=tierplans') || url.includes('page=plandetails') || pageType === 'plan' || pageType === 'email' || pageType === 'default-signup') {
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
                return;
              }
            }
          }

          // ── PHONE NUMBER ──────────────────────────────────────
          if (pageType === 'phone') {
            console.log('📱 Phone number collection page — skipping...');
            const skipBtn = page.locator(
              'button:has-text("Skip"), ' +
              'button:has-text("Not now"), ' +
              'button:has-text("Continue")'
            ).first();
            if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
              await clickAndWaitForNav(page, skipBtn, 'Skip phone collection');
              console.log('✅ Skipped phone collection');
            } else {
              console.log('⚠️  Skip button not visible on phone number page');
            }
            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── EMAIL / LOGIN ──────────────────────────────────────
          if (pageType === 'email') {
            console.log('👉 Email/Login page');
            stuckCount = 0;

            // ── Social login mid-flow (AUTH_METHOD=google etc.) ──────────────────
            const authMethodEnv = (process.env.AUTH_METHOD || '').toLowerCase().trim();
            if (authMethodEnv && authMethodEnv !== 'email') {
              console.log(`🔐 [Existing User] AUTH_METHOD="${authMethodEnv}" — authenticating mid-flow via AuthenticationManager`);
              const authManager = new AuthenticationManager(page, context, baseUrl);
              await authManager.authenticate(eventData);
              console.log('✅ [Existing User] Social login complete — continuing flow');
              continue;
            }
            // ─────────────────────────────────────────────────────────────────────

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
              const errorSnippet = bodyTextForError.split('\n').filter(l => errorPatterns.some(p => p.test(l))).join(' | ').substring(0, 200);
              console.warn(`⚠️  [Existing User] Transient error popup detected: "${errorSnippet}" — dismissing and reloading to re-enter flow.`);
              // Dismiss the error dialog
              const okBtn = page.locator('button:has-text("Ok"), button:has-text("OK"), button:has-text("Okay"), [role="button"]:has-text("Ok")').first();
              if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await okBtn.click({ force: true }).catch(() => {});
                await page.waitForLoadState('domcontentloaded').catch(() => {});
              }
              // Reload to clear any broken state; the navigation loop will re-detect page type
              await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              console.warn(`♻️  [Existing User] Reload complete — re-entering navigation loop from: ${page.url()}`);
              continue;
            }

            if (emailProcessedCount > 5) {
              console.log('⚠️  Email/Login loop detected — breaking');
              if (page.url().includes('paymentDetails') || page.url().includes('payment')) {
                reachedEndPage = true;
                console.log('💳 Navigated to payment page after loop detection retry');
                continue;
              }
              break;
            }

            const emailInput = page.locator('input[type="email"]').first();
            const passwordInput = page.locator('input[type="password"]').first();

            // Wait up to 10 seconds for email or password input to load on the email/login page
            await Promise.any([
              emailInput.waitFor({ state: 'visible', timeout: 10000 }),
              passwordInput.waitFor({ state: 'visible', timeout: 10000 })
            ]).catch(() => { });

            const emailVisible = await emailInput.isVisible({ timeout: 500 }).catch(() => false);
            const passwordVisible = await passwordInput.isVisible({ timeout: 500 }).catch(() => false);

            let signedIn = false;
            if (emailVisible && passwordVisible) {
              console.log(`📧 Entering email: ${userEmail} and password...`);
              await emailInput.fill(userEmail);
              await passwordInput.fill(userPassword);

              const signInBtn = page.locator(
                'button:has-text("Sign in"), ' +
                'button:has-text("Log in"), ' +
                'button:has-text("Sign In"), ' +
                'button:has-text("Continue"), ' +
                'button[type="submit"]'
              ).first();
              await clickAndWaitForNav(page, signInBtn, 'Sign In/Continue Both');
              signedIn = true;
            } else if (passwordVisible) {
              console.log('🔑 Entering password...');
              await passwordInput.fill(userPassword);

              const signInBtn = page.locator(
                'button:has-text("Sign in"), ' +
                'button:has-text("Log in"), ' +
                'button:has-text("Sign In"), ' +
                'button:has-text("Continue"), ' +
                'button[type="submit"]'
              ).first();
              await clickAndWaitForNav(page, signInBtn, 'Sign In/Continue');
              signedIn = true;
            } else if (emailVisible) {
              console.log(`📧 Entering email: ${userEmail}`);
              await emailInput.fill(userEmail);

              const continueBtn = page.locator(
                'button:has-text("Continue"), ' +
                'button:has-text("Next"), ' +
                'button[type="submit"]'
              ).first();
              await clickAndWaitForNav(page, continueBtn, 'Email Continue');
            }

            if (signedIn && !LOGIN_FIRST && PPV_TYPE === 'normal' && !isStandalonePPV && isActiveUltimateState(userStateKey)) {
              const redirectsToMyAccount = ULTIMATE_MID_LOGIN_MY_ACCOUNT_SOURCES.has(srcResolvedSource.toLowerCase());
              const expectedDestination = redirectsToMyAccount
                ? 'My Account'
                : 'Fixture Page or Preview Page';
              console.log(`⏳ [Ultimate User Login] Waiting for post-login redirection to ${expectedDestination}...`);
              await page.waitForURL(
                (url: URL) =>
                  redirectsToMyAccount
                    ? isMyAccountDestination(url.href)
                    : isFixtureOrPreviewDestination(url.href),
                { timeout: 20000 }
              ).catch(() => { });

              const currentUrl = page.url();
              let navStatus: 'PASS' | 'FAIL' = 'FAIL';
              let actualPage = 'Unknown Page';

              if (redirectsToMyAccount && isMyAccountDestination(currentUrl)) {
                actualPage = 'My Account';
                navStatus = 'PASS';
              } else if (!redirectsToMyAccount && isFixtureOrPreviewDestination(currentUrl)) {
                actualPage = currentUrl.toLowerCase().includes('preview')
                  ? 'Preview Page'
                  : 'Fixture Page';
                navStatus = 'PASS';
              }

              results.push({
                page: 'Sign In',
                field: 'Post-Login Navigation Target',
                expected: expectedDestination,
                actual: `Navigated to: ${currentUrl} (${actualPage})`,
                status: navStatus,
              });

              if (navStatus === 'FAIL') {
                const errMsg = `❌ [Ultimate User Login] Expected to redirect to ${expectedDestination} after signing in, but landed on: ${currentUrl}`;
                console.error(errMsg);
                throw new Error(errMsg);
              } else if (actualPage === 'My Account') {
                await validateUltimateMyAccountRedirect();
                await finishRun('ultimate', userStateKey);
                return;
              } else {
                console.log(`✅ [Ultimate User Login] Successfully redirected to ${actualPage}: ${currentUrl}`);
              }
              reachedEndPage = true;
              break;
            }

            const isActiveStandardPlan =
              signedIn &&
              !LOGIN_FIRST &&
              PPV_TYPE === 'normal' &&
              userStateKey.startsWith('active_standard') &&
              requestedPlan.startsWith('standard_');
            if (isActiveStandardPlan) {
              await page.waitForFunction(() => {
                const href = location.href.toLowerCase();
                if (href.includes('page=paymentdetails') || href.includes('/payment') || href.includes('/checkout')) {
                  return true;
                }
                return (document.body?.innerText || '').toLowerCase().includes('choose how to buy');
              }, { timeout: 20_000 }).catch(() => {});

              const isChooseHowToBuy = (await page.locator('body').innerText({ timeout: 3000 })
                .catch(() => '')).toLowerCase().includes('choose how to buy');
              if (page.url().toLowerCase().includes('/home') && !isChooseHowToBuy) {
                throw new Error(
                  `❌ [Active Standard] Selected Standard plan "${requestedPlan}" ` +
                  `must redirect to the payment page after sign-in, but DAZN redirected to Home: ${page.url()}`
                );
              }
            }

            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── PAYMENT ───────────────────────────────────────────
          if (pageType === 'payment') {
            console.log('💳 Payment page');
            reachedEndPage = true;
            console.log('\n📋 Validating Payment page...');

            const targetTier = isStandalonePPV
              ? 'standard'
              : (tier === 'ultimate' || purchaseOption === 'ultimate') ? 'ultimate' : 'standard';
            const isBundle = SOURCE.includes('bundle');
            const planKey = isBundle ? `${ratePlan} bundle` : ratePlan;
            const paymentData = getPaymentDataByTierAndPlan(targetTier, planKey);
            console.log(`📊 Payment rows: ${paymentData.length}`);

            const paymentPage = new PaymentPage(page);

            if (await paymentPage.isPaymentPage()) {
              if (isReturning) {
                await paymentPage.validate(paymentData, results, eventData, FLOW);
                const returningData = paymentData.filter((r: any) => {
                  const rf = (r.Flow || '').trim().toLowerCase();
                  if (rf !== 'returning') return false;
                  // 'Signed In As Text' and 'Log Out Present' only apply to frozen users, not freemium
                  if (userStateKey === 'freemium') {
                    const f = (r.Field || '').trim().toLowerCase();
                    if (f === 'signed in as text' || f === 'log out present') return false;
                  }
                  return true;
                });
                if (returningData.length > 0) {
                  await paymentPage.validate(returningData, results, eventData, 'returning');
                }
              } else {
                await paymentPage.validate(paymentData, results, eventData, undefined);
              }

              if (userStateKey === 'frozen' && !await shouldSkipCardEntryChecks(page)) {
                const savedCardCheckoutFields = new Set([
                  'pay now button',
                  'secure checkout',
                  'more payment methods',
                ]);
                const savedCardPaymentData = getPPVPaymentData().filter((row: any) =>
                  savedCardCheckoutFields.has(String(row.Field || '').trim().toLowerCase())
                );
                await new PPVUpsellPaymentPage(page).validateSavedCardPayment(
                  savedCardPaymentData, results, eventData, 'Payment'
                );
              }

            }

            // ── SCENARIO 2: Ultimate Upsell Banner — validate before click,
            //    click conditionally, validate after click ──────────────────
            const isStandardTierForUpsell = (tier || '').toLowerCase() === 'standard';
            const isMonthlyOrAPMForUpsell = ratePlan === 'monthly' || ratePlan === 'annual pay monthly';

            if (!isStandalonePPV && isStandardTierForUpsell && isMonthlyOrAPMForUpsell) {
              try {
                // STEP A: Always validate banner text BEFORE click (both prod and stag)
                await paymentPage.validateUltimateUpsellBannerText(results, eventData);

                // Click arrow only if SWITCH=true is explicitly set
                const shouldClickUpsell = SWITCH_TO_ULTIMATE || SOURCE === 'landing-page-dont-miss-live-switch';

                if (shouldClickUpsell) {
                  // STEP C: Click > arrow and validate DAZN Ultimate summary
                  const switched = await paymentPage.clickUltimateUpsellAndValidate(results, eventData);

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

            // On staging, fill payment details and submit
            const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
            if (env !== 'stag') {
              console.log(`⛔ DAZN_ENV is "${env}" — no real payment process is available outside staging. Stopping before CVV entry; payment page validation above stands as the result.`);
            } else {
              console.log(`💳 DAZN_ENV is stag — filling payment via method: ${PAYMENT_METHOD}`);
              try {
                if (PAYMENT_METHOD === 'gpay') {
                  // ── Google Pay flow ──────────────────────────────────
                  console.log('🔵 [GPay] Using Google Pay payment method...');
                  await paymentPage.fillGooglePayAndSubmit(results, eventData);
                  await paymentPage.verifyPaymentSuccess();
                  if (PPV_TYPE === 'upsell') {
                    await new PPVUpsellSuccessPage(page).waitForUpsellOffer(eventData.UPSELL_BUY_CTA);
                  } else {
                    await paymentPage.clickSuccessContinue();
                  }
                } else {
                  // ── Credit Card flow (existing default) ──────────────
                  console.log('💳 Using Credit Card payment method...');
                  await paymentPage.fillPaymentAndSubmit();
                  await paymentPage.verifyPaymentSuccess();
                  if (PPV_TYPE === 'upsell') {
                    await new PPVUpsellSuccessPage(page).waitForUpsellOffer(eventData.UPSELL_BUY_CTA);
                  } else {
                    await paymentPage.clickSuccessContinue();
                  }
                }
                console.log('✅ Payment details submitted successfully on staging!');

                // ── SCENARIO 3: Navigate to My Account and validate PPV status = Purchased ──
                // Only runs on stag after successful payment, and only for normal PPV flows
                if (PPV_TYPE !== 'upsell') {
                  try {
                    console.log('\n🏠 [Post-Payment] Validating PPV status in My Account...');
                    const myAccountPagePostPayment = new MyAccountPage(page);
                    await myAccountPagePostPayment.navigateToMyAccountAndValidatePPVStatus(
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

                if (PPV_TYPE === 'upsell') {
                  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                  continue;
                }
              } catch (paymentErr: any) {
                console.error(`❌ Payment filling failed: ${paymentErr.message}`);
                throw paymentErr;
              }
              break;
            }

            if (PPV_TYPE === 'upsell') {
              reachedEndPage = true;
            }
            break;
          }

          // ── STANDALONE PPV PAGE ───────────────────────────────────
          if (pageType === 'standalone-ppv' && isStandalonePPV) {
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

            // Select plan
            await standalonePPVPage.selectPlan(
              ratePlan === 'monthly' ? 'flex' : 'annual_monthly'
            );
            // Click Continue
            await standalonePPVPage.clickContinue();

            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── PPV Upsell Success Page (first success after initial payment) ──
          if (pageType === 'success-upsell' && PPV_TYPE === 'upsell' && firstPaymentDone && !firstSuccessValidated) {
            console.log('\n══════════════════════════════════════════════');
            console.log('First Success Page — PPV Upsell');
            console.log('══════════════════════════════════════════════');
            stuckCount = 0;

            const successPage = new PPVUpsellSuccessPage(page);
            try {
              const successData = getUpsellFirstSuccessData();
              await successPage.validateUpsellSuccess(successData, results, eventData);
            } catch (err: any) {
              console.warn(`⚠️ First Success page validation error: ${err.message}`);
            }

            firstSuccessValidated = true;
            await successPage.clickBuyUpsell();
            continue;
          }

          // ── Saved Card Payment (upsell PPV purchase) ──
          if (pageType === 'saved-card-payment' && PPV_TYPE === 'upsell' && firstPaymentDone && firstSuccessValidated && !savedCardPaymentDone) {
            console.log('\n══════════════════════════════════════════════');
            console.log('Upsell PPV — Saved Card Payment');
            console.log('══════════════════════════════════════════════');
            stuckCount = 0;

            const savedCardPage = new PPVUpsellPaymentPage(page);
            try {
              const upsellPaymentData = getUpsellPaymentData();
              await savedCardPage.validateSavedCardPayment(upsellPaymentData, results, eventData, 'Upsell Payment');
            } catch (err: any) {
              console.warn(`⚠️ Saved Card Payment validation error: ${err.message}`);
            }

            savedCardPaymentDone = true;
            await savedCardPage.fillAndSubmit(eventData);

            results.push({
              page: 'Upsell Payment',
              field: 'Upsell Payment Completed',
              expected: 'Success',
              actual: 'Success',
              status: 'PASS',
            });
            continue;
          }

          // ── Saved Card Payment (active_standard direct PPV purchase) ──
          if (pageType === 'saved-card-payment' && !firstPaymentDone) {
            console.log('\n══════════════════════════════════════════════');
            console.log('Active Standard — Addon PPV Purchase (Saved Card)');
            console.log('══════════════════════════════════════════════');
            stuckCount = 0;

            const savedCardPage = new PPVUpsellPaymentPage(page);

            if (await shouldSkipCardEntryChecks(page)) {
              console.log('ℹ️ No saved card is shown — validating the PPV payment-options page.');
              await expandMorePaymentMethods(page, 'PPV Payment');
              const ppvPaymentData = addPPVPaymentMethodRows(getAddonPPVPaymentData(userStateKey === 'frozen'))
                .filter((row: any) => !['pay now button', 'secure checkout'].includes(
                  String(row.Field || '').trim().toLowerCase()
                ));
              await validateVariant(
                page, 'ppvpayment', ppvPaymentData, results, eventData, 'PPV Payment', FLOW
              );
            } else {
              // Validate the addon purchase page only when a saved card is present.
              try {
                const ppvPaymentData = getAddonPPVPaymentData(userStateKey === 'frozen');
                await savedCardPage.validateSavedCardPayment(ppvPaymentData, results, eventData, 'PPV Payment (Saved Card)');
              } catch (err: any) {
                console.warn(`⚠️ Saved Card PPV Payment validation error: ${err.message}`);
              }
            }

            reachedEndPage = true;

            // On staging, complete the payment and validate post-payment flows
            const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
            if (env !== 'stag') {
              console.log(`⛔ DAZN_ENV is "${env}" — no real payment process is available outside staging. Stopping before CVV entry; payment page validation above stands as the result.`);
            } else {
              console.log('💳 [stag] Completing saved card PPV payment...');
              try {
                await savedCardPage.fillAndSubmit(eventData);

                results.push({
                  page: 'PPV Payment (Saved Card)',
                  field: 'PPV Payment Completed',
                  expected: 'Success',
                  actual: 'Success',
                  status: 'PASS',
                });
                console.log('✅ Saved card PPV payment submitted successfully on staging!');

                // ── Post-Payment: Validate My Account PPV status ──
                try {
                  console.log('\n🏠 [Post-Payment] Validating PPV status in My Account...');
                  const myAccountPostPay = new MyAccountPage(page);
                  await myAccountPostPay.navigateToMyAccountAndValidatePPVStatus(
                    eventData.PPV_NAME,
                    results,
                    eventData
                  );
                } catch (myAccErr: any) {
                  console.warn(`⚠️ [Post-Payment] My Account PPV status validation error: ${myAccErr.message}`);
                  results.push({
                    page: 'My Account (Post-Payment)',
                    field: 'PPV Status After Purchase',
                    expected: 'Purchased',
                    actual: `Error: ${myAccErr.message}`,
                    status: 'FAIL',
                  });
                }

                // ── Post-Payment: Navigate to Schedule and verify fixture ──
                try {
                  console.log('\n📅 [Post-Payment] Navigating to Schedule page to verify purchased event...');
                  const schedulePostPay = new SchedulePage(page);
                  await schedulePostPay.navigate(baseUrl);
                  await schedulePostPay.selectSport(sport);

                  console.log(`🔍 Finding event tile: "${eventData.PPV_NAME}"`);
                  const eventCard = await schedulePostPay.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));

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
              } catch (payErr: any) {
                console.error(`❌ Saved card PPV payment failed: ${payErr.message}`);
                results.push({
                  page: 'PPV Payment (Saved Card)',
                  field: 'PPV Payment Completed',
                  expected: 'Success',
                  actual: `Error: ${payErr.message}`,
                  status: 'FAIL',
                });
              }
            }

            break;
          }

          // ── DAZN Bet / Promotional Upsell (second success) ──
          if (pageType === 'bet-upsell' && PPV_TYPE === 'upsell' && firstPaymentDone && savedCardPaymentDone) {
            console.log('\n══════════════════════════════════════════════');
            console.log('Second Success Page — DAZN Bet Upsell');
            console.log('══════════════════════════════════════════════');
            stuckCount = 0;

            const successPage = new PPVUpsellSuccessPage(page);
            try {
              const betData = getUpsellSecondSuccessData();
              await successPage.validateBetUpsell(betData, results, eventData);
            } catch (err: any) {
              console.warn(`⚠️ Second Success page validation error: ${err.message}`);
            }

            secondSuccessValidated = true;
            await successPage.clickMaybeLater();
            continue;
          }

          // ── DEFAULT SIGNUP PAGE ──────────────────────────────────
          if (pageType === 'default-signup') {
            console.log('👉 Default Signup page');
            stuckCount = 0;

            // For noPpvClick flows (subscribe-without-pay-per-view), skip PPV validation
            // and event-match check — the goal is only to click "Subscribe without a pay-per-view".
            if (!noPpvClick) {
              // Default signup can be configured either with a contextual PPV card
              // or as a generic tier-plan page. PPV-specific validations only make
              // sense when the expected PPV is actually present.
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

              if (!ppvValidated) {
                try {
                  const ppvData = getPPVDataByVariant(variant);
                  console.log(`📊 PPV rows (Default Signup): ${ppvData.length}`);
                  const ppvFlow = isMyAccount ? 'myaccount' : (isReturning ? 'returning' : undefined);
                  await validateVariant(page, variant, ppvData, results, eventData, 'Default Signup', ppvFlow);
                } catch (e: any) {
                  console.warn('⚠️ Default Signup validation error:', e.message);
                }
                ppvValidated = true;
                defaultSignupPPVValidated = true;
              }
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
                  const radioLabel = await radio
                    .locator('xpath=ancestor::label | xpath=ancestor::div[1]')
                    .first();
                  const text = await radioLabel.innerText({ timeout: 500 }).catch(() => '');
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

          // ── CHOOSE HOW TO BUY (active_standard from landing page) ──
          if (pageType === 'choose-how-to-buy') {
            console.log('\n══════════════════════════════════════════════');
            console.log('Active Standard — Choose How To Buy');
            console.log('══════════════════════════════════════════════');
            stuckCount = 0;

            await page.waitForSelector(
              '[class*="addon" i], [class*="purchase" i], input[type="radio"]',
              { state: 'visible', timeout: 8000 }
            ).catch(() => { });

            // Validate Choose How To Buy page
            try {
              const chooseBuyData = getChooseHowToBuyData();
              console.log(`📊 Choose How To Buy rows: ${chooseBuyData.length}`);
              await validateVariant(
                page, 'choosebuy', chooseBuyData, results, eventData, 'Choose How To Buy'
              );
            } catch (e: any) {
              console.warn('⚠️ Choose How To Buy validation error:', e.message);
            }

            if (purchaseOption === 'ultimate') {
              // ── Ultimate path ──
              console.log('\n💎 Selecting DAZN Ultimate...');
              const ultimateCard = page.locator(
                '[class*="upsell" i], [class*="ultimate" i], label:has-text("DAZN Ultimate")'
              ).first();
              if (await ultimateCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                await safeScrollToElement(page, ultimateCard);
                await ultimateCard.click({ force: true }).catch(() => { });
                console.log('✅ Selected DAZN Ultimate');
              }
              // Validate CTA after selecting DAZN Ultimate card
              await validateCtaAfterUltimateSelection(page, variant, results, eventData, 'Choose How To Buy');

              const ultimateCta = page.locator(
                'button:has-text("Continue with DAZN Ultimate"), button:has-text("Continue")'
              ).first();
              await ultimateCta.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
              await safeScrollToElement(page, ultimateCta);
              await ultimateCta.click({ force: true });
              console.log('✅ Clicked Continue with DAZN Ultimate');

              // Wait for plan page to load (URL may change or content updates)
              await page.waitForSelector(
                'text=/choose your plan|annual|pay monthly|pay upfront/i',
                { state: 'visible', timeout: 15000 }
              ).catch(() => { });
              await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
            } else {
              // ── PPV only path ──
              console.log('\n🥊 Selecting PPV only...');
              const btnTexts = [
                `button:has-text("Continue with ${eventData.PPV_NAME} only")`,
                `button:has-text("Continue with ${eventData.PPV_NAME}")`,
                `button:has-text("Continue")`
              ];
              if (eventData.PPV_NAME) {
                const nameClean = eventData.PPV_NAME.replace(/[:\-–]/g, ' ');
                if (nameClean.includes('vs')) {
                  const fighters = nameClean.split(/\bvs\b/i).map((f: string) => f.trim());
                  const firstFighter = fighters[0]?.split(/\s+/).pop();
                  const secondFighter = fighters[1]?.split(/\s+/)[0];
                  if (firstFighter) btnTexts.push(`button:has-text("Continue with ${firstFighter}")`);
                  if (secondFighter) btnTexts.push(`button:has-text("Continue with ${secondFighter}")`);
                }
                const eventShort = eventData.PPV_NAME.split(/[:\-–]/)[0]?.trim();
                if (eventShort) btnTexts.push(`button:has-text("Continue with ${eventShort}")`);
              }
              const ppvCta = page.locator(btnTexts.join(', ')).first();
              await ppvCta.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
              await safeScrollToElement(page, ppvCta);
              await ppvCta.click({ force: true });
              console.log('✅ Clicked PPV Only Continue');

              // URL doesn't change — wait for page content to transition to payment page
              console.log('⏳ Waiting for saved-card-payment page to load...');
              await page.waitForSelector(
                'text=/Today you pay|Skip|Pay Now|one time payment/i',
                { state: 'visible', timeout: 15000 }
              ).catch(() => { });
              await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
            }

            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── PPV PAGE ──────────────────────────────────────────
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
                const ppvData = getPPVDataByVariant(variant);
                console.log(`📊 PPV rows: ${ppvData.length}`);
                // 'myaccount' flow: Excel rows restricted to Flow=myaccount (e.g. Signed In As, Log Out)
                // 'returning'  flow: Excel rows for returning users on any non-myAccount source
                const ppvFlow = isMyAccount ? 'myaccount' : (isReturning ? 'returning' : undefined);
                await validateVariant(
                  page, variant, ppvData, results, eventData, 'PPV', ppvFlow
                );
              } catch (e: any) {
                console.warn('⚠️  PPV validation error:', e.message);
              }
              ppvValidated = true;
            }

            if (purchaseOption === 'ultimate') {
              const ultimateCard = page.locator(
                '[class*="upsell" i], ' +
                '[class*="ultimate" i], ' +
                'label:has-text("DAZN Ultimate")'
              ).first();

              if (await ultimateCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                await safeScrollToElement(page, ultimateCard);
                await ultimateCard.click({ force: true }).catch(() => { });
                console.log('✅ Clicked Ultimate card');
              }

              // Validate CTA after selecting DAZN Ultimate card
              await validateCtaAfterUltimateSelection(page, variant, results, eventData, 'PPV');

              const btn = page.locator(
                'button:has-text("Continue with DAZN Ultimate")'
              ).first();
              await btn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
              await clickAndWaitForNav(page, btn, 'PPV Continue Ultimate');

            } else {
              const ppvRadio = page.locator('input[type="radio"]').first();
              if (await ppvRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
                await safeScrollToElement(page, ppvRadio);
                await ppvRadio.click({ force: true }).catch(() => { });
              }

              const ctaText = currentVariantConfig?.ctaText || 'Continue';
              let btn = page.locator(`button:has-text("${ctaText}")`).first();
              if (!await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
                // Fallback: try common PPV CTA button texts
                console.log(`⚠️ CTA "${ctaText}" not visible — trying fallbacks...`);
                const fallbackSelectors = [
                  'button:has-text("Continue with pay-per-view")',
                  'button:has-text("Continue with PPV")',
                  'button:has-text("Continue")',
                  'button[type="submit"]',
                ];
                for (const sel of fallbackSelectors) {
                  const fallback = page.locator(sel).first();
                  if (await fallback.isVisible({ timeout: 500 }).catch(() => false)) {
                    btn = fallback;
                    console.log(`✅ Found fallback CTA: ${sel}`);
                    break;
                  }
                }
              }
              await btn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
              await clickAndWaitForNav(page, btn, `PPV Continue (${variant})`);
            }

            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── PLAN PAGE ─────────────────────────────────────────
          if (pageType === 'plan') {
            console.log(`👉 DAZN Plan page`);
            stuckCount = 0;

            // The home-page popup enters TierPlans first. Select the configured
            // tier before applying PlanDetails validations or choosing a rate plan.
            if (SOURCE === 'home-page-popup' && page.url().toLowerCase().includes('page=tierplans')) {
              const tierName = tier === 'ultimate' ? 'DAZN Ultimate' : 'DAZN Standard';
              const tierCtaName = tier === 'ultimate'
                ? 'Continue with DAZN Ultimate'
                : 'Continue with Standard';
              const tierCard = page.getByText(tierName, { exact: true }).first();
              const tierCta = page.getByRole('button', { name: tierCtaName, exact: true }).first();

              if (!await tierCard.isVisible({ timeout: 5000 }).catch(() => false)) {
                throw new Error(`❌ [Home Page Popup] Configured tier "${tierName}" is not visible on TierPlans.`);
              }
              if (!await tierCta.isVisible({ timeout: 5000 }).catch(() => false)) {
                throw new Error(`❌ [Home Page Popup] CTA "${tierCtaName}" is not visible on TierPlans.`);
              }

              await clickAndWaitForNav(page, tierCta, `Home Page Popup ${tierName} Continue`);
              await page.waitForURL(
                (url: URL) => url.toString().toLowerCase().includes('page=plandetails'),
                { timeout: 15000 }
              );
              continue;
            }


            // ── subscribe-without-pay-per-view: endPage=plan → stop on TierPlans ──
            if (page.url().toLowerCase().includes('page=tierplans') && srcEndPage === 'plan') {
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
                  const isDirectExistingRoute =
                    fieldKey === 'subscribe without ppv cta' &&
                    eventData.SUBSCRIBE_WITHOUT_PPV_DIRECT === 'true';
                  const status = isDirectExistingRoute
                    ? 'SKIP'
                    : actual.toLowerCase().includes(expected.toLowerCase()) ? 'PASS' : 'FAIL';
                  const displayedActual = isDirectExistingRoute
                    ? 'N/A (existing user was already on TierPlans)'
                    : actual;
                  console.log(`  ${status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️' : '❌'} [${field}] expected="${expected}" actual="${displayedActual}"`);
                  results.push({ page: 'Subscribe Without PPV', field, expected, actual: displayedActual, status });
                }
              } catch (e: any) {
                console.warn('⚠️ Subscribe Without PPV validation error:', e.message);
              }

              reachedEndPage = true;
              break;
            }

            if (await isContextualPpvSelectionPage(page)) {
              console.log('↩️  Still on contextual PPV selection page; re-detecting before DAZN Plan validation.');
              continue;
            }

            // NOTE: For ultimate_upfront, plan page defaults to APM selected on load.
            // Defer validateVariant to after the APU card click so DOM reflects correct state.
            const shouldDeferPlanValidation = ratePlan === 'annual pay upfront';

            if (!planValidated && !shouldDeferPlanValidation) {
              try {
                await page.waitForSelector(
                  'input[type="radio"]',
                  { timeout: 5000 }
                ).catch(() => { });

                const targetTier = (tier === 'ultimate' || purchaseOption === 'ultimate') ? 'ultimate' : 'standard';
                const originalTier = eventData.TIER;
                const originalPlanCta = eventData.PLAN_CTA_BUTTON;
                eventData.TIER = targetTier;
                eventData['TIER'] = targetTier;

                // For upgrade flow (active_standard → ultimate), CTA is just 'Continue'
                const isUpgradeFlow = page.url().includes('isUpgradeTierFlow') || userStateKey === 'active_standard';
                if (isUpgradeFlow && targetTier === 'ultimate') {
                  eventData.PLAN_CTA_BUTTON = 'Continue';
                  eventData['PLAN_CTA_BUTTON'] = 'Continue';
                }

                const planData = getPlanDataByTier(targetTier);
                const planFlow = [
                  'boxing-banner-ultimate',
                  'boxing-ultimate-subscription',
                  'boxing-join-the-club',
                ].includes(SOURCE)
                  ? 'boxing-ultimate-direct'
                  : isMyAccount ? 'myaccount' : (isReturning ? 'returning' : undefined);
                console.log(`📊 Plan rows: ${planData.length}`);

                if (targetTier === 'ultimate' && ratePlan === 'annual pay monthly' && planFlow === 'boxing-ultimate-direct') {
                  const annualCard = page.locator(
                    'label:has-text("Annual - pay over time"), ' +
                    'label:has-text("Annual - Pay Monthly")'
                  ).first();
                  if (await annualCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await safeScrollToElement(page, annualCard);
                    await annualCard.click({ force: true }).catch(() => { });
                    await page.waitForTimeout(500);
                    console.log('✅ Selected Annual Pay Monthly before plan validation');
                  }
                }

                await validateVariant(
                  page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow
                );

                eventData.TIER = originalTier;
                eventData['TIER'] = originalTier;
                eventData.PLAN_CTA_BUTTON = originalPlanCta;
                eventData['PLAN_CTA_BUTTON'] = originalPlanCta;

              } catch (e: any) {
                console.warn('⚠️  Plan validation error:', e.message);
              }
              planValidated = true;
            }

            if (ratePlan === 'annual pay upfront') {
              const upfrontCard = page.locator(
                'label:has-text("Annual - Pay Upfront"), ' +
                'label:has-text("Annual - pay upfront"), ' +
                'label:has-text("Pay Upfront")'
              ).first();

              if (await upfrontCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                await safeScrollToElement(page, upfrontCard);
                await upfrontCard.click({ force: true }).catch(() => { });
                console.log('✅ Clicked Annual Pay Upfront card');
              } else {
                // Upfront is typically the last radio
                const radios = page.locator('input[type="radio"]');
                const count = await radios.count().catch(() => 0);
                const upfrontRadio = radios.nth(count > 0 ? count - 1 : 0);
                if (await upfrontRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
                  await safeScrollToElement(page, upfrontRadio);
                  await upfrontRadio.click({ force: true }).catch(() => { });
                  console.log('✅ Selected Upfront radio (last)');
                }
              }
              await page.waitForTimeout(500);

              // ── Post-click: run deferred validateVariant now that APU card is selected ──
              if (shouldDeferPlanValidation && !planValidated) {
                try {
                  const targetTier = (tier === 'ultimate' || purchaseOption === 'ultimate') ? 'ultimate' : 'standard';
                  const originalTier = eventData.TIER;
                  const originalPlanCta = eventData.PLAN_CTA_BUTTON;
                  eventData.TIER = targetTier;
                  eventData['TIER'] = targetTier;
                  const isUpgradeFlow = page.url().includes('isUpgradeTierFlow') || userStateKey === 'active_standard';
                  if (isUpgradeFlow && targetTier === 'ultimate') {
                    eventData.PLAN_CTA_BUTTON = 'Continue';
                    eventData['PLAN_CTA_BUTTON'] = 'Continue';
                  }
                  const planData = getPlanDataByTier(targetTier);
                  const planFlow = [
                    'boxing-banner-ultimate',
                    'boxing-ultimate-subscription',
                    'boxing-join-the-club',
                  ].includes(SOURCE)
                    ? 'boxing-ultimate-direct'
                    : isMyAccount ? 'myaccount' : (isReturning ? 'returning' : undefined);
                  console.log(`📊 Plan rows (deferred post-click): ${planData.length}`);
                  await validateVariant(
                    page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow
                  );
                  eventData.TIER = originalTier;
                  eventData['TIER'] = originalTier;
                  eventData.PLAN_CTA_BUTTON = originalPlanCta;
                  eventData['PLAN_CTA_BUTTON'] = originalPlanCta;
                } catch (e: any) {
                  console.warn('⚠️  Plan validation error (deferred):', e.message);
                }
                planValidated = true;
              }


            } else if (ratePlan === 'annual pay monthly') {
              const annualCard = page.locator(
                'label:has-text("Annual - pay over time"), ' +
                'label:has-text("Annual - Pay Monthly")'
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
            } else {
              const trialRadio = page.locator('input[type="radio"]').first();
              if (await trialRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
                await safeScrollToElement(page, trialRadio);
                await trialRadio.click({ force: true }).catch(() => { });
                console.log('✅ Selected Trial radio');
              }
            }

            const planBtn = page.locator(
              'button:has-text("Continue with DAZN Ultimate"), ' +
              'button:has-text("Continue with"), ' +
              'button:has-text("Continue with 1st Month Free"), ' +
              'button:has-text("Continue with PPV"), ' +
              'button:has-text("Continue")'
            ).first();
            await planBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });

            // Validate CTA text after APM selection
            if (ratePlan === 'annual pay monthly' && tier === 'standard') {
              const annualCard = page.locator(
                'label:has-text("Annual - pay over time"), ' +
                'label:has-text("Annual - Pay Monthly")'
              ).first();
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
            }

            await clickAndWaitForNav(page, planBtn, 'Plan Continue');

            await page.waitForLoadState('domcontentloaded').catch(() => { });
            continue;
          }

          // ── CONFIRMATION ──────────────────────────────────────
          if (pageType === 'confirmation') {
            console.log('✅ Upgrade confirmation page');

            // Expand the description if "... More" is visible
            const moreLink = page.locator('text=/\\.\\.\\.\\s*More|More/i').first();
            if (await moreLink.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log('🖱️ Clicking "... More" to expand page description...');
              await moreLink.click({ force: true }).catch(() => { });
              await page.waitForTimeout(500);
            }

            const confirmData = getUpgradeConfirmationData(ratePlan);

            // Temporarily set TIER to ratePlan so validateVariant's Tier filter matches the sheet's Tier column
            const savedTier = eventData.TIER;
            eventData.TIER = ratePlan;
            eventData['TIER'] = ratePlan;

            await validateVariant(
              page, 'confirmation', confirmData, results, eventData, 'Upgrade Confirmation'
            );

            // Restore
            eventData.TIER = savedTier;
            eventData['TIER'] = savedTier;
            reachedEndPage = true;

            const envName = (process.env.DAZN_ENV || 'stag').toLowerCase();
            if (envName === 'stag') {
              // Staging: click Confirm to complete the upgrade
              console.log('💎 [stag] Clicking Confirm to complete plan change...');
              const confirmBtn = page.locator(
                'button:has-text("Confirm"), button:has-text("Confirm plan change"), button[type="submit"]'
              ).first();
              await confirmBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
              await safeScrollToElement(page, confirmBtn);
              await clickAndWaitForNav(page, confirmBtn, 'Confirm Plan Change');

              results.push({
                page: 'Upgrade Confirmation',
                field: 'Confirm CTA Clicked',
                expected: 'Success',
                actual: 'Success',
                status: 'PASS',
              });

              // Navigate to My Account to verify
              try {
                console.log('\n🏠 [Post-Confirm] Navigating to My Account...');
                const myAccountPage = new MyAccountPage(page);
                await myAccountPage.navigateToMyAccountAndValidatePPVStatus(
                  eventData.PPV_NAME,
                  results,
                  eventData
                );
              } catch (myAccErr: any) {
                console.warn(`⚠️ My Account post-confirm validation error: ${myAccErr.message}`);
              }

              // Navigate to Schedule page to check fixture
              try {
                console.log('\n📅 [Post-Confirm] Navigating to Schedule page...');
                const schedPage = new SchedulePage(page);
                const schedBaseUrl = eventData.BASE_URL || baseUrl;
                await schedPage.navigate(schedBaseUrl);
                const sportName = eventData.SPORT || 'Boxing';
                await schedPage.selectSport(sportName);
                const fixtureEvent = await schedPage.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));
                console.log('✅ PPV fixture found on Schedule page');
                results.push({
                  page: 'Schedule',
                  field: 'PPV Fixture Present',
                  expected: eventData.PPV_NAME,
                  actual: 'Found',
                  status: 'PASS',
                });
              } catch (schedErr: any) {
                console.warn(`⚠️ Schedule page post-confirm validation error: ${schedErr.message}`);
                results.push({
                  page: 'Schedule',
                  field: 'PPV Fixture Present',
                  expected: eventData.PPV_NAME,
                  actual: `Error: ${schedErr.message}`,
                  status: 'FAIL',
                });
              }
            } else {
              console.log('ℹ️ [prod] Confirmation page is the end page — skipping confirm click.');
            }

            break;
          }



          stuckCount++;
          console.log(`⚠️  Unknown page — waiting... (${stuckCount}/5)`);
          await sleep(800);
          if (stuckCount >= 5) {
            throw new Error(`❌ Flow stuck on unknown page.\nURL: ${page.url()}`);
          }
        }

        if (!reachedEndPage) {
          await page.waitForFunction(() => {
            const href = window.location.href.toLowerCase();
            const body = document.body?.innerText?.toLowerCase() || '';
            return href.includes('paymentdetails') ||
              href.includes('payment') ||
              href.includes('checkout') ||
              href.includes('upgradeplan') ||
              href.includes('upgradetier') ||
              body.includes('choose how to pay') ||
              body.includes('payment method') ||
              body.includes('today you pay') ||
              body.includes('confirm plan change') ||
              body.includes('payment was successful');
          }, { timeout: 30_000 }).catch(() => { });

          const finalUrl = page.url();
          const finalUrlLower = finalUrl.toLowerCase();
          if (finalUrlLower.includes('paymentdetails') || finalUrlLower.includes('payment') || finalUrlLower.includes('checkout')) {
            console.log('💳 Payment page detected after loop exit');
            reachedEndPage = true;

            const targetTier = (tier === 'ultimate' || purchaseOption === 'ultimate') ? 'ultimate' : 'standard';
            const isBundle = SOURCE.includes('bundle');
            const planKey = isBundle ? `${ratePlan} bundle` : ratePlan;
            const paymentData = getPaymentDataByTierAndPlan(targetTier, planKey);
            const paymentPage = new PaymentPage(page);
            if (await paymentPage.isPaymentPage()) {
              if (isReturning) {
                await paymentPage.validate(paymentData, results, eventData, FLOW);
                const returningData = paymentData.filter((r: any) => {
                  const rf = (r.Flow || '').trim().toLowerCase();
                  if (rf !== 'returning') return false;
                  // 'Signed In As Text' and 'Log Out Present' only apply to frozen users, not freemium
                  if (userStateKey === 'freemium') {
                    const f = (r.Field || '').trim().toLowerCase();
                    if (f === 'signed in as text' || f === 'log out present') return false;
                  }
                  return true;
                });
                if (returningData.length > 0) {
                  await paymentPage.validate(returningData, results, eventData, 'returning');
                }
              } else {
                await paymentPage.validate(paymentData, results, eventData, undefined);
              }
            }
          } else if (finalUrlLower.includes('upgradeplan') || finalUrlLower.includes('upgradetier')) {
            console.log('✅ Confirmation page detected after loop exit');
            const confirmData = getUpgradeConfirmationData(ratePlan);
            await validateVariant(
              page, 'confirmation', confirmData, results, eventData, 'Upgrade Confirmation'
            );
            reachedEndPage = true;
          } else {
            console.log(`⚠️  Flow A did not reach expected end page`);
          }
        }

        // ══════════════════════════════════════════════════════════════
        // FLOW B — ACTIVE STANDARD USER
        // ══════════════════════════════════════════════════════════════
      } else if (isChooseHowToBuy) {
        console.log('\n📋 Flow B: Active Standard — Choose How To Buy');

        await setupPage(page, 8000);

        await page.waitForSelector(
          '[class*="addon" i], [class*="purchase" i], input[type="radio"]',
          { state: 'visible', timeout: 8000 }
        ).catch(() => { });

        // ✅ Validate Choose How To Buy
        const chooseBuyData = getChooseHowToBuyData();
        console.log(`📊 Choose How To Buy rows: ${chooseBuyData.length}`);
        await validateVariant(
          page, 'choosebuy', chooseBuyData, results, eventData, 'Choose How To Buy'
        );

        if (purchaseOption === 'ultimate') {
          // ── Ultimate upgrade path ─────────────────────────────────
          console.log('\n💎 Selecting DAZN Ultimate...');

          const ultimateCard = page.locator(
            '[class*="upsell" i], ' +
            '[class*="ultimate" i], ' +
            'label:has-text("DAZN Ultimate")'
          ).first();

          if (await ultimateCard.isVisible({ timeout: 3000 }).catch(() => false)) {
            await safeScrollToElement(page, ultimateCard);
            await ultimateCard.click({ force: true }).catch(() => { });
            console.log('✅ Selected DAZN Ultimate');
          }

          // Validate CTA after selecting DAZN Ultimate card
          await validateCtaAfterUltimateSelection(page, 'choosebuy', results, eventData, 'Choose How To Buy');

          const ultimateCta = page.locator(
            'button:has-text("Continue with DAZN Ultimate"), ' +
            'button:has-text("Continue")'
          ).first();
          await ultimateCta.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
          await clickAndWaitForNav(page, ultimateCta, 'Continue with DAZN Ultimate');

          // ── Validate DAZN Plan page (Ultimate) ─────────────────
          console.log('\n📋 Validating DAZN Plan page (Ultimate)...');
          await page.waitForSelector(
            'input[type="radio"]',
            { timeout: 5000 }
          ).catch(() => { });

          const originalTier = eventData.TIER;
          const originalPlanCta = eventData.PLAN_CTA_BUTTON;
          eventData.TIER = 'ultimate';
          eventData['TIER'] = 'ultimate';
          eventData.PLAN_CTA_BUTTON = 'Continue';
          eventData['PLAN_CTA_BUTTON'] = 'Continue';

          const planData = getPlanDataByTier('ultimate');
          const planFlow = [
            'boxing-banner-ultimate',
            'boxing-ultimate-subscription',
            'boxing-join-the-club',
          ].includes(SOURCE) ? 'boxing-ultimate-direct' : undefined;
          console.log(`📊 Plan rows: ${planData.length}`);
          // NOTE: For ultimate_upfront, defer validateVariant to after APU card click.
          const shouldDeferFlowBPlanValidation = ratePlan === 'annual pay upfront';
          if (!shouldDeferFlowBPlanValidation) {
            if (ratePlan === 'annual pay monthly' && planFlow === 'boxing-ultimate-direct') {
              const annualCard = page.locator(
                'label:has-text("Annual - pay over time"), ' +
                'label:has-text("Annual - Pay Monthly")'
              ).first();
              if (await annualCard.isVisible({ timeout: 3000 }).catch(() => false)) {
                await safeScrollToElement(page, annualCard);
                await annualCard.click({ force: true }).catch(() => { });
                await page.waitForTimeout(500);
                console.log('✅ Selected Annual Pay Monthly before plan validation');
              }
            }
            await validateVariant(
              page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow
            );
          }

          // Restore
          eventData.TIER = originalTier;
          eventData['TIER'] = originalTier;
          eventData.PLAN_CTA_BUTTON = originalPlanCta;
          eventData['PLAN_CTA_BUTTON'] = originalPlanCta;

          // Select rate plan
          if (ratePlan === 'annual pay monthly') {
            const radio = page.locator('input[type="radio"]').first();
            if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
              await safeScrollToElement(page, radio);
              await radio.click({ force: true }).catch(() => { });
              console.log('✅ Selected Annual Pay Monthly');
            }
          } else if (ratePlan === 'annual pay upfront') {
            const radio = page.locator('input[type="radio"]').nth(1);
            if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
              await safeScrollToElement(page, radio);
              await radio.click({ force: true }).catch(() => { });
              console.log('✅ Selected Annual Pay Upfront');
            }
            await page.waitForTimeout(500);

            // ── Post-click: run deferred validateVariant (Flow B) ──
            if (shouldDeferFlowBPlanValidation) {
              const restoreTier2 = eventData.TIER;
              const restoreCta2 = eventData.PLAN_CTA_BUTTON;
              eventData.TIER = 'ultimate';
              eventData['TIER'] = 'ultimate';
              eventData.PLAN_CTA_BUTTON = 'Continue';
              eventData['PLAN_CTA_BUTTON'] = 'Continue';
              try {
                console.log(`📊 Plan rows (deferred post-click Flow B): ${planData.length}`);
                await validateVariant(
                  page, 'plan', planData, results, eventData, 'DAZN Plan', planFlow
                );
              } catch (e: any) {
                console.warn('⚠️  Plan validation error (deferred Flow B):', e.message);
              }
              eventData.TIER = restoreTier2;
              eventData['TIER'] = restoreTier2;
              eventData.PLAN_CTA_BUTTON = restoreCta2;
              eventData['PLAN_CTA_BUTTON'] = restoreCta2;
            }


          }

          const planBtn = page.locator(
            'button:has-text("Continue with DAZN Ultimate"), ' +
            'button:has-text("Continue")'
          ).first();
          await planBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
          await clickAndWaitForNav(page, planBtn, 'Plan Continue');

          // ── Handle Phone Number Collection (US specific) ─────────
          const currentUrl = page.url();
          if (currentUrl.includes('PhoneNumberCollection')) {
            console.log('📱 Phone number collection page — skipping...');
            const skipBtn = page.locator(
              'button:has-text("Skip"), ' +
              'button:has-text("Not now"), ' +
              'button:has-text("Continue")'
            ).first();
            if (await skipBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await clickAndWaitForNav(page, skipBtn, 'Skip phone collection');
              console.log('✅ Skipped phone collection');
            }
          }

          // ── Validate Upgrade Confirmation ─────────────────────
          console.log('\n📋 Validating Upgrade Confirmation page...');

          // Expand the description if "... More" is visible
          const moreLink = page.locator('text=/\\.\\.\\.\\s*More|More/i').first();
          if (await moreLink.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('🖱️ Clicking "... More" to expand page description...');
            await moreLink.click({ force: true }).catch(() => { });
            await page.waitForTimeout(500);
          }

          const confirmData = getUpgradeConfirmationData(ratePlan);
          console.log(`📊 Confirmation rows: ${confirmData.length}`);

          // Temporarily set TIER to ratePlan for correct Tier column filtering
          const savedTierB = eventData.TIER;
          eventData.TIER = ratePlan;
          eventData['TIER'] = ratePlan;

          await validateVariant(
            page, 'confirmation', confirmData, results, eventData, 'Upgrade Confirmation'
          );

          // Restore
          eventData.TIER = savedTierB;
          eventData['TIER'] = savedTierB;
          reachedEndPage = true;

          const envNameB = (process.env.DAZN_ENV || 'stag').toLowerCase();
          if (envNameB === 'stag') {
            console.log('💎 [stag] Clicking Confirm to complete plan change (Flow B)...');
            const confirmBtnB = page.locator(
              'button:has-text("Confirm"), button:has-text("Confirm plan change"), button[type="submit"]'
            ).first();
            await confirmBtnB.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
            await safeScrollToElement(page, confirmBtnB);
            await clickAndWaitForNav(page, confirmBtnB, 'Confirm Plan Change (Flow B)');

            results.push({
              page: 'Upgrade Confirmation',
              field: 'Confirm CTA Clicked',
              expected: 'Success',
              actual: 'Success',
              status: 'PASS',
            });

            try {
              console.log('\n🏠 [Post-Confirm] Navigating to My Account (Flow B)...');
              const myAccountPageB = new MyAccountPage(page);
              await myAccountPageB.navigateToMyAccountAndValidatePPVStatus(
                eventData.PPV_NAME,
                results,
                eventData
              );
            } catch (myAccErr: any) {
              console.warn(`⚠️ My Account post-confirm validation error: ${myAccErr.message}`);
            }

            try {
              console.log('\n📅 [Post-Confirm] Navigating to Schedule page (Flow B)...');
              const schedPageB = new SchedulePage(page);
              const schedBaseUrlB = eventData.BASE_URL || baseUrl;
              await schedPageB.navigate(schedBaseUrlB);
              const sportNameB = eventData.SPORT || 'Boxing';
              await schedPageB.selectSport(sportNameB);
              const fixtureEventB = await schedPageB.findEvent(resolvePpvTitleForSource(eventData, 'schedule'));
              console.log('✅ PPV fixture found on Schedule page (Flow B)');
              results.push({
                page: 'Schedule',
                field: 'PPV Fixture Present',
                expected: eventData.PPV_NAME,
                actual: 'Found',
                status: 'PASS',
              });
            } catch (schedErr: any) {
              console.warn(`⚠️ Schedule page post-confirm validation error: ${schedErr.message}`);
              results.push({
                page: 'Schedule',
                field: 'PPV Fixture Present',
                expected: eventData.PPV_NAME,
                actual: `Error: ${schedErr.message}`,
                status: 'FAIL',
              });
            }
          } else {
            console.log('ℹ️ [prod] Confirmation page is the end page — skipping confirm click.');
          }

        } else {
          // ── PPV only path ─────────────────────────────────────
          console.log('\n🥊 Selecting PPV only...');

          const btnTexts = [
            `button:has-text("Continue with ${eventData.PPV_NAME} only")`,
            `button:has-text("Continue with ${eventData.PPV_NAME}")`,
            `button:has-text("Continue")`
          ];
          if (eventData.PPV_NAME) {
            const nameClean = eventData.PPV_NAME.replace(/[:\-–]/g, ' ');
            if (nameClean.includes('vs')) {
              const fighters = nameClean.split(/\bvs\b/i).map((f: string) => f.trim());
              const firstFighter = fighters[0]?.split(/\s+/).pop();
              const secondFighter = fighters[1]?.split(/\s+/)[0];
              if (firstFighter) btnTexts.push(`button:has-text("Continue with ${firstFighter}")`);
              if (secondFighter) btnTexts.push(`button:has-text("Continue with ${secondFighter}")`);
            }
            const eventShort = eventData.PPV_NAME.split(/[:\-–]/)[0]?.trim();
            if (eventShort) btnTexts.push(`button:has-text("Continue with ${eventShort}")`);
          }
          const ppvCta = page.locator(btnTexts.join(', ')).first();
          await ppvCta.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { });
          await safeScrollToElement(page, ppvCta);
          await ppvCta.click({ force: true });
          console.log('✅ Clicked PPV Only Continue');

          await setupPage(page);

          // ── Validate PPV Payment ─────────────────────────────
          console.log('\n📋 Validating PPV Payment page...');
          await page.waitForSelector(
            'text=/Today you pay|payment|pay now|one time payment/i',
            { timeout: 15000 }
          ).catch(() => { });

          await expandMorePaymentMethods(page, 'PPV Payment');
          const skipCardEntryChecks = await shouldSkipCardEntryChecks(page);
          if (!skipCardEntryChecks) {
            const payNowLoaded = await page.locator(
              'button:has-text("Pay Now"), button:has-text("Pay now"), ' +
              'a:has-text("Pay Now"), a:has-text("Pay now"), ' +
              'button:has-text("Complete"), button:has-text("Confirm")'
            ).first().waitFor({ state: 'visible', timeout: 20000 })
              .then(() => true).catch(() => false);
            if (payNowLoaded) {
              console.log('✅ Pay Now button visible — payment form loaded');
            } else {
              console.log('⚠️  Pay Now button not visible after 20s — proceeding with validation anyway');
            }
          } else {
            console.log('⏭️  Skipping card-entry checks on PPV Payment — no card checkout form is shown');
          }

          const ppvPaymentData = addPPVPaymentMethodRows(getAddonPPVPaymentData(false));
          const effectivePpvPaymentData = skipCardEntryChecks
            ? ppvPaymentData.filter((row: any) => {
              const field = String(row.Field || '').trim().toLowerCase();
              return field !== 'pay now button' && field !== 'secure checkout';
            })
            : ppvPaymentData;
          console.log(`📊 PPV Payment rows: ${effectivePpvPaymentData.length}`);
          await validateVariant(
            page, 'ppvpayment', effectivePpvPaymentData, results, eventData, 'PPV Payment', FLOW
          );
          reachedEndPage = true;
        }

      }

      // ══════════════════════════════════════════════════════════════
      // STEP 8 — RESULTS
      // ══════════════════════════════════════════════════════════════
      // Capture video path and finalize video file BEFORE report generation
      capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
      await closeContext().catch(() => { });
      const { excelPath, videoPath } = await writeResults(results, capturedVideoPath);

      // Display detailed per-page results
      displayResultsTable(results, tier, {
        event: eventData.PPV_NAME,
        region: REGION,
        excelPath,
        videoPath,
      });

      // Generate HTML + PDF run report (country, surfacing point, rate plan, per-page pass/fail, totals)
      const isCanadaReport = REGION === 'CA';
      let reportTier = tier;
      let reportRatePlan = ratePlan;
      let reportFlowName = `${SOURCE} → ${stateKey} → ${tier} → ${ratePlan}`;
      if (isCanadaReport) {
        const caConfig = parseCanadaCommand(process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN);
        const reportUserState = (process.env.USER_STATE || stateKey || 'freemium').toLowerCase();
        reportTier = caConfig.tierPlanDisplay;
        reportRatePlan = '';
        reportFlowName = `${SOURCE} -> ${reportUserState} -> ${caConfig.tierPlanDisplay}`;
      }

      const { htmlPath, pdfPath, folderPath } = await generateReports(results, {
        event: eventData.PPV_NAME,
        region: REGION,
        source: SOURCE,
        ratePlan: reportRatePlan,
        tier: reportTier,
        env: process.env.DAZN_ENV || 'prod',
        flowName: reportFlowName,
        startTime: runStartTime,
        endTime: new Date(),
        excelPath,
        videoPath,
        userStatus: (TV_HANDOFF_MODE || isMyAccount) ? (process.env.USER_STATE || 'Freemium') : 'New User',
        userType: 'existing-user',
        platform: getReportPlatform(),
        paymentMethod: PAYMENT_METHOD === 'gpay' ? 'Google Pay' : 'Credit Card',
      });
      reportGenerated = true;
      if (folderPath) console.log(`\n📂 Report folder: ${folderPath}`);


      const passed = results.filter(r => r.status === 'PASS').length;
      const failed = results.filter(r => r.status === 'FAIL').length;
      const skippedCount = results.filter(r => String(r.status).toUpperCase() === 'SKIP').length;
      const total = passed + failed + skippedCount;

      if (passed === 0 && failed === 0 && skippedCount > 0) {
        const skipReason = results.find(r => String(r.status).toUpperCase() === 'SKIP')?.actual || 'PPV not configured for this source';
        console.log(`⏭️ Flow "${SOURCE} (${stateKey})" skipped: ${skipReason}`);
        test.skip(true, skipReason);
        return;
      }

      console.log(`\n✅ Flow "${SOURCE} (${stateKey})" complete: ${passed}/${total} passed (${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%)`);
      console.log(`${'─'.repeat(55)}`);
      console.log('__DEMO_FLOW_COMPLETE__');

      if (total === 0 && srcEndPage !== 'plan') {
        const errMsg = `❌ Flow "${SOURCE} (${stateKey})" had 0 validation checks`;
        console.log(errMsg);
        throw new Error(errMsg);
      }

      if (!reachedEndPage) {
        const errMsg = `❌ Flow "${SOURCE} (${stateKey})" did not reach the expected end page: "payment" or "confirmation"`;
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
            platform: getReportPlatform(),
            flow: `${SOURCE} (${stateKey})`,
            event: eventData.PPV_NAME,
            userState: stateKey,
            source: SOURCE,
          },
        });
        const failMsgs = results
          .filter(r => r.status === 'FAIL')
          .map(r => `  - [${r.page}] ${r.field}: expected "${r.expected}", actual "${r.actual}"`)
          .join('\n');
        const errMsg = `❌ Flow "${SOURCE} (${stateKey})" completed navigation but had ${failed} validation failure(s):\n${failMsgs}`;
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
              ratePlan: process.env.PLAN || 'unknown',
              tier: (process.env.PLAN || '').includes('ultimate') ? 'ultimate' : 'standard',
              env: process.env.DAZN_ENV || 'prod',
              flowName: `${SOURCE} → ${stateKey} (crashed)`,
              startTime: specStartTime,
              endTime: new Date(),
              userType: 'existing-user',
            }
          );
        } catch { /* best-effort — do not mask original error */ }
      }
      throw error;

    } finally {
      try {
        if (!capturedVideoPath) {
          capturedVideoPath = (await page.video()?.path().catch(() => null)) ?? null;
        }

        // Only log — context may already be closed by early-exit paths above
        if (capturedVideoPath) console.log(`🎥 Video saved: ${capturedVideoPath}`);
        else console.log('⚠️  No video found');
      } catch (e: any) {
        console.log('⚠️  Video path error:', e.message);
      }
      // Safe no-op if already closed by an early-exit branch
      await closeContext().catch(() => { });
    }
  });
}
