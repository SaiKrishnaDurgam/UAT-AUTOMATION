import * as XLSX from 'xlsx';
import * as path from 'path';

let FILE_PATH = path.resolve(__dirname, '../data/PPV_Input.xlsx');

export function configureExcelPathForEvent(eventKey: string) {
  FILE_PATH = path.resolve(__dirname, '../data/PPV_Input.xlsx');
  console.log(`📊 excelReader configured path: ${FILE_PATH}`);
}

// =========================
// READ SHEET
// =========================
export const readSheet = (sheetName: string) => {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    const available = workbook.SheetNames.join(', ');
    throw new Error(
      `❌ Sheet not found: "${sheetName}"\n` +
      `   Available sheets: ${available}`
    );
  }

  const rawData: any[] = XLSX.utils.sheet_to_json(sheet);

  if (!rawData.length) {
    throw new Error(`❌ Sheet is empty: "${sheetName}"`);
  }

  return rawData;
};

const readFirstAvailableSheet = (sheetNames: string[]) => {
  let lastError: any;
  for (const sheetName of sheetNames) {
    try {
      return {
        sheetName,
        data: readSheet(sheetName),
      };
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError;
};

// =========================
// LANDING DATA (Field | Value)
// =========================
export const getLandingData = () => {
  let data;
  try {
    data = readSheet('Landing-page-banner');
    console.log(`📊 Landing Banner rows: ${data.length}`);
  } catch {
    data = readSheet('Landing page');
    console.log(`📊 Landing rows: ${data.length}`);
  }
  return data;
};

// =========================
// PPV DATA BY VARIANT (Variant | Field | Expected)
// =========================
export const getPPVDataByVariant = (variant: string) => {
  const data = readSheet('PPV page');

  const normalize = (val: any) =>
    val?.toString().trim().toLowerCase();

  // If no Variant column exists, return all rows (backward compatible)
  if (data.length > 0 && !('Variant' in data[0])) {
    console.log('ℹ️  No Variant column in PPV page — returning all rows');
    return data;
  }

  const variantData = data.filter(
    (d: any) => normalize(d.Variant) === normalize(variant)
  );

  if (!variantData.length) {
    const available = [...new Set(data.map((d: any) => d.Variant))].join(', ');
    throw new Error(
      `❌ No data found for variant: "${variant}"\n` +
      `   Available variants: ${available}`
    );
  }

  console.log(`🧠 Variant: ${variant}`);
  console.log(`📊 PPV rows: ${variantData.length}`);

  return variantData;
};

// =========================
// PLAN DATA BY TIER (Tier | Field | Expected)
// =========================
export const getPlanDataByTier = (tier: string) => {
  const data = readSheet('Dazn Plan page');

  const normalize = (val: any) =>
    val?.toString().trim().toLowerCase();

  // If no Tier column exists, return all rows (backward compatible)
  if (data.length > 0 && !('Tier' in data[0])) {
    console.log('ℹ️  No Tier column in Dazn Plan page — returning all rows');
    return data;
  }

  const tierData = data.filter(
    (d: any) => normalize(d.Tier) === normalize(tier)
  );

  if (!tierData.length) {
    const available = [...new Set(
      data.map((d: any) => d.Tier).filter(Boolean)
    )].join(', ');
    throw new Error(
      `❌ No data found for tier: "${tier}"\n` +
      `   Available tiers: ${available}`
    );
  }

  console.log(`💎 Tier     : ${tier}`);
  console.log(`📊 Plan rows: ${tierData.length}`);

  return tierData;
};

// =========================
// SUBSCRIBE WITHOUT PPV DATA (Field | Expected)
// =========================
export const getSubscribeWithoutPPVData = () => {
  const data = readSheet('Subscribe Without PPV');
  console.log(`📊 Subscribe Without PPV rows: ${data.length}`);
  return data;
};

// =========================
// PAYMENT DATA BY TIER & RATE PLAN (Tier | Rate Plan | Field | Expected)
// =========================
export const getPaymentDataByTierAndPlan = (
  tier: string,
  ratePlan: string
) => {
  const data = readSheet('Payment page');

  const normalize = (val: any) =>
    val?.toString().trim().toLowerCase();

  const rawRatePlan = normalize(ratePlan);

  const ratePlanAliases: Record<string, string> = {
    monthly: 'monthly',

    standard_monthly: 'monthly',
    ultimate_monthly: 'monthly',

    standard_apm: 'annual pay monthly',
    ultimate_apm: 'annual pay monthly',
    annual_pay_monthly: 'annual pay monthly',

    standard_apu: 'annual pay upfront',
    ultimate_apu: 'annual pay upfront',
    ultimate_upfront: 'annual pay upfront',
    annual_pay_upfront: 'annual pay upfront',

    standard_monthly_bundle: 'monthly bundle',
    ultimate_monthly_bundle: 'monthly bundle',

    standard_apm_bundle: 'annual pay monthly bundle',
    ultimate_apm_bundle: 'annual pay monthly bundle',
    annual_pay_monthly_bundle: 'annual pay monthly bundle',

    standard_apu_bundle: 'annual pay upfront bundle',
    ultimate_apu_bundle: 'annual pay upfront bundle',
    annual_pay_upfront_bundle: 'annual pay upfront bundle',
  };

  const resolvedRatePlan = ratePlanAliases[rawRatePlan] ?? rawRatePlan;

  if (data.length > 0 && !('Tier' in data[0])) {
    console.log('ℹ️  No Tier column in Payment page — returning all rows');
    return data;
  }

  if (data.length > 0 && !('Rate Plan' in data[0])) {
    console.log('ℹ️  No Rate Plan column in Payment page — filtering by Tier only');
    return data.filter((d: any) => normalize(d.Tier) === normalize(tier));
  }

  const commonData = data.filter(
    (d: any) =>
      normalize(d.Tier) === 'common' &&
      normalize(d['Rate Plan']) === 'all'
  );

  const tierPlanData = data.filter(
    (d: any) =>
      normalize(d.Tier) === normalize(tier) &&
      normalize(d['Rate Plan']) === resolvedRatePlan
  );

  if (!tierPlanData.length) {
    const available = [
      ...new Set(
        data
          .filter((d: any) => d.Tier && d['Rate Plan'])
          .map((d: any) => `${d.Tier} - ${d['Rate Plan']}`)
      ),
    ].join(', ');

    throw new Error(
      `❌ No data found for tier: "${tier}" + rate plan: "${ratePlan}"
` +
      `   Resolved Excel rate plan: "${resolvedRatePlan}"
` +
      `   Available combinations: ${available}`
    );
  }

  const combined = [...commonData, ...tierPlanData];

  console.log(`💎 Tier              : ${tier}`);
  console.log(`📋 Raw Rate Plan     : ${ratePlan}`);
  console.log(`📋 Excel Rate Plan   : ${resolvedRatePlan}`);
  console.log(`📊 Common rows       : ${commonData.length}`);
  console.log(`📊 Specific rows     : ${tierPlanData.length}`);
  console.log(`📊 Total rows        : ${combined.length}`);

  return combined;
};

// =========================
// MY ACCOUNT DATA
// =========================
export const getMyAccountData = () => {
  const data = readSheet('My Account page');
  console.log(`📊 My Account rows: ${data.length}`);
  return data;
};

// =========================
// PAY PER VIEW LISTING DATA
// =========================
export const getPayPerViewData = () => {
  try {
    const data = readSheet('Pay Per View page');
    console.log(`📊 Pay Per View rows: ${data.length}`);
    return data;
  } catch {
    console.log('ℹ️  No Pay Per View page sheet found — skipping');
    return [];
  }
};

// =========================
// CHOOSE HOW TO BUY DATA
// =========================
export const getChooseHowToBuyData = () => {
  const data = readSheet('Choose How To Buy page');
  console.log(`📊 Choose How To Buy rows: ${data.length}`);
  return data;
};

// =========================
// PPV PAYMENT DATA
// =========================
export const getPPVPaymentData = () => {
  const data = readSheet('PPV Payment page');
  // The saved-card checkout is the only PPV payment surface that shows the
  // region-specific tax disclaimer. Keep this runtime rule until the shared
  // spreadsheet contains it, and never duplicate it if it is added later.
  const hasExcludingTaxRule = data.some((row: any) =>
    ['excluding tax text', 'excluding tax'].includes(
      String(row.Field || '').trim().toLowerCase()
    )
  );
  const paymentData = hasExcludingTaxRule
    ? data
    : [...data, { Field: 'Excluding Tax Text', Expected: '(excluding tax)' }];
  console.log(`📊 PPV Payment rows: ${paymentData.length}`);
  return paymentData;
};

// =========================
// UPGRADE CONFIRMATION DATA BY RATE PLAN
// =========================
export const getUpgradeConfirmationData = (ratePlan: string) => {
  const data = readSheet('Upgrade Confirmation page');

  const normalize = (val: any) =>
    val?.toString().trim().toLowerCase();

  const commonData = data.filter(
    (d: any) => normalize(d.Tier) === 'common'
  );

  const ratePlanData = data.filter(
    (d: any) => normalize(d.Tier) === normalize(ratePlan)
  );

  if (!ratePlanData.length) {
    const available = [...new Set(
      data.map((d: any) => d.Tier).filter(Boolean)
    )].join(', ');
    throw new Error(
      `❌ No data found for rate plan: "${ratePlan}"\n` +
      `   Available: ${available}`
    );
  }

  const combined = [...commonData, ...ratePlanData];

  console.log(`📋 Rate Plan     : ${ratePlan}`);
  console.log(`📊 Total rows    : ${combined.length}`);

  return combined;
};

// =========================
// PHONE NUMBER PAGE DATA
// =========================
export const getPhonePageData = () => {
  const data = readSheet('Phone Number page');
  console.log(`📱 Phone page rows: ${data.length}`);
  return data;
};

// =========================
// OTP VERIFICATION PAGE DATA
// =========================
export const getOTPPageData = () => {
  const data = readSheet('OTP page');
  console.log(`🔑 OTP page rows: ${data.length}`);
  return data;
};

// =========================
export const getHomeOfBoxingData = (flowName: string) => {
  const normalize = (val: any) => val?.toString().trim().toLowerCase();
  if (normalize(flowName) === 'home-boxing-banner') {
    try {
      const data = readSheet('Home-boxing-banner');
      console.log(`🥊 Boxing Banner rows: ${data.length}`);
      return data;
    } catch {}
  }
  if (normalize(flowName) === 'home-boxing-upcoming') {
    try {
      const data = readSheet('Home-boxing-upcoming');
      console.log(`🥊 Boxing Tile rows: ${data.length}`);
      return data;
    } catch {}
  }

  const data = readSheet('Home of Boxing');
  const queryFlow = flowName;
  const flowData = data.filter(
    (d: any) => normalize(d.Flow) === normalize(queryFlow)
  );
  console.log(`🥊 Home of Boxing Flow: ${flowName} (mapped to ${queryFlow})`);
  console.log(`📊 Home of Boxing rows: ${flowData.length}`);
  return flowData;
};

// =========================
// HOME OF SPORT DATA
// Used only by the legacy `home-boxing-tile` source when the configured
// PPV SPORT is not Boxing. The source name is retained for compatibility;
// its sport page has a "Coming Up" rail rather than Boxing's rail.
// =========================
export const getHomeOfSportData = (flowName: string = 'home-sport-tile') => {
  const normalize = (val: any) => val?.toString().trim().toLowerCase();
  const data = readSheet('Home of Sport');
  const flowData = data.filter(
    (d: any) => normalize(d.Flow) === normalize(flowName)
  );
  console.log(`🏟️ Home of Sport Flow: ${flowName}`);
  console.log(`📊 Home of Sport rows: ${flowData.length}`);
  return flowData;
};

// =========================
// SEARCH PAGE POPUP DATA
// Returns popup- fields from the Search page sheet
// =========================
export const getSearchPagePopupData = () => {
  const data = readSheet('Search page');
  const popupData = data.filter(
    (r: any) => String(r.Field || '').trim().toLowerCase().startsWith('popup')
  );
  console.log(`🔍 Search page popup rows: ${popupData.length}`);
  return popupData;
};

// =========================
// SCHEDULE PAGE POPUP DATA
// Returns popup- fields from the Schedule page sheet
// =========================
export const getSchedulePagePopupData = () => {
  const data = readSheet('Schedule page');
  const popupData = data.filter(
    (r: any) => String(r.Field || '').trim().toLowerCase().startsWith('popup')
  );
  console.log(`📅 Schedule page popup rows: ${popupData.length}`);
  return popupData;
};

// =========================
// HOME PAGE DATA BY FLOW
// =========================
export const getHomePageData = (flowName: string) => {
  let data;
  const normalize = (val: any) => val?.toString().trim().toLowerCase();
  if (normalize(flowName) === 'home-page-banner') {
    try {
      data = readSheet('Home-page-banner');
      console.log(`🏠 Home Banner rows: ${data.length}`);
      return data;
    } catch {}
  }

  data = readSheet('Home page');
  const flowData = data.filter(
    (d: any) => normalize(d.Flow) === normalize(flowName)
  );
  console.log(`🏠 Home Page Flow: ${flowName}`);
  console.log(`📊 Home Page rows: ${flowData.length}`);
  return flowData;
};

// =========================
// ANDROID LANDING PAGE DATA
// =========================
export const getAndroidLandingPageData = () => {
  try {
    const data = readSheet('Andriod_Landing_Page');
    console.log(`📱 Android Landing Page rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Landing Page sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// ANDROID HOME PAGE DATA
// =========================
export const getAndroidHomePageData = () => {
  try {
    const data = readSheet('Andriod_Home_Page');
    console.log(`📱 Android Home Page rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Home Page sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// ANDROID HOME BOXING PAGE DATA
// =========================
export const getAndroidHomeBoxingPageData = () => {
  try {
    const data = readSheet('Andriod_Home_Boxing_Page');
    console.log(`📱 Android Home Boxing Page rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Home Boxing Page sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// ANDROID SEARCH PAGE DATA
// =========================
export const getAndroidSearchPageData = () => {
  try {
    const data = readSheet('Andriod_Search_Page');
    console.log(`📱 Android Search Page rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Search Page sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// ANDROID SCHEDULE PAGE DATA
// =========================
export const getAndroidSchedulePageData = () => {
  try {
    const data = readSheet('Andriod_Schedule_Page');
    console.log(`📱 Android Schedule Page rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Schedule Page sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// ANDROID PAYWALL DATA
// =========================
export const getAndroidPaywallData = () => {
  try {
    const data = readSheet('Andriod_Paywall');
    console.log(`📱 Android Paywall rows: ${data.length}`);
    return data;
  } catch (err: any) {
    console.warn(`⚠️ Android Paywall sheet not found: ${err.message}`);
    return [];
  }
};

// =========================
// STANDALONE PPV PAGE DATA
// =========================
export const getStandalonePPVPageData = () => {
  const data = readSheet('Standalone PPV page');
  console.log(`📊 Standalone PPV page rows: ${data.length}`);
  return data;
};

// =========================
// UPSELL FIRST SUCCESS PAGE
// =========================
export const getUpsellFirstSuccessData = () => {
  try {
    const data = readSheet('Upsell First Success page');
    console.log(`📊 Upsell First Success rows: ${data.length}`);
    return data;
  } catch {
    console.log('ℹ️ No Upsell First Success page sheet');
    return [];
  }
};

// =========================
// UPSELL SECOND SUCCESS PAGE
// =========================
export const getUpsellSecondSuccessData = () => {
  try {
    const data = readSheet('Upsell Second Success page');
    console.log(`📊 Upsell Second Success rows: ${data.length}`);
    return data;
  } catch {
    console.log('ℹ️ No Upsell Second Success page sheet');
    return [];
  }
};

// =========================
// UPSELL PAYMENT PAGE
// =========================
export const getUpsellPaymentData = () => {
  try {
    const data = readSheet('Upsell Payment page');
    console.log(`📊 Upsell Payment rows: ${data.length}`);
    return data;
  } catch {
    console.log('ℹ️ No Upsell Payment page sheet');
    return [];
  }
};

// =========================
// MOBILE NATIVE PAYWALL PAGE DATA
// =========================
export const getMobilePaywallData = () => {
  const { sheetName, data } = readFirstAvailableSheet([
    'Andriod_Paywall',
    'Mobile Paywall',
    'paywall',
  ]);
  console.log(`📊 Mobile Paywall rows: ${data.length} (sheet: ${sheetName})`);
  return data;
};
