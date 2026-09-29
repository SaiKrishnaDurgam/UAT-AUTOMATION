import * as fs from 'fs';
import * as path from 'path';
import {
  getNow,
  getNowForRegion,
  formatNextPaymentDate,
  formatNextPaymentDateMonthly,
  formatNextPaymentDateYearly,
  formatNextPaymentDateMonthlyUS,
  formatNextPaymentDateYearlyUS,
  formatNextPaymentDateUS,
  formatFlexFutureDate,
  formatRenewalDate,
  formatRenewalDateUS,
} from './dateUtils';

function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      base[key] !== undefined &&
      typeof base[key] === 'object'
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function formatHomeBoxingUpcomingDate(value: string): string {
  const clean = String(value || '').trim();
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthIndex = monthNames.findIndex(month =>
    new RegExp(`\\b${month}\\b|\\b${month.slice(0, 3)}\\b`, 'i').test(clean)
  );
  const dayMatch = clean.match(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/i);
  if (monthIndex === -1 || !dayMatch) return clean;

  const day = Number(dayMatch[1]);
  const now = getNowForRegion();
  const date = new Date(now.getFullYear(), monthIndex, day);
  if (date.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
    date.setFullYear(now.getFullYear() + 1);
  }

  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${weekday} ${day}${ordinalSuffix(day)} ${monthNames[monthIndex]}`;
}

function formatHomeBoxingUpcomingTime(...values: Array<string | undefined>): string {
  for (const value of values) {
    const clean = String(value || '').trim();
    if (!clean) continue;

    const timeMatches = Array.from(clean.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi));
    const match = timeMatches[timeMatches.length - 1];
    if (!match) continue;

    let hours = Number(match[1]);
    const minutes = match[2];
    const marker = (match[3] || '').toUpperCase();
    if (marker === 'PM' && hours < 12) hours += 12;
    if (marker === 'AM' && hours === 12) hours = 0;

    const suffix = hours >= 12 ? 'PM' : 'AM';
    const displayHour = hours % 12 || 12;
    return `${displayHour}:${minutes}${suffix}`;
  }

  return '';
}

function isDayTrialOffer(offerType: unknown): boolean {
  return /^(?:\d+)_day_trial$/.test(String(offerType || '').toLowerCase());
}

function getTrialDays(value: unknown): number {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : 7;
}

function replaceTrialDayPlaceholders(value: unknown, trialDays: number): unknown {
  return typeof value === 'string'
    ? value.replace(/\{\{FREE_TRIAL_DAYS\}\}/g, String(trialDays))
    : value;
}

function normalizeRegionKey(region: string): string {
  return (region || 'GB').toUpperCase();
}

const GLOBAL_DEFAULTS: Record<string, string> = {
  PPV_CTA_TEXT: "Continue with pay-per-view",
  PLAN_PAGE_TITLE: "Choose a plan that's right for you|Choose the right plan for you|Choose the right plan for you.|Choose your plan|Choose a plan",
  PLAN_CTA_BUTTON_ULTIMATE: "Continue with DAZN Ultimate",
  PPV_PAGE_TITLE: "Choose the right plan for you.",
  PPV_PAGE_SUBTITLE: "To watch your pay-per-view, you'll need a DAZN plan.",
  UPSELL_BADGE: "The Ultimate Fan Package",
  UPSELL_OFFER_TEXT: "N/A",
  UPSELL_SECTION_HEADING: "All these fights included and more.",
  UPSELL_FEATURE_1: "Minimum 12 pay-per-views a year included at no extra cost.",
  UPSELL_FEATURE_2: "185+ fights a year from the world's best promoters.",
  UPSELL_FEATURE_3: "HDR and Dolby 5.1 surround sound on select events.",
  FLEX_DESCRIPTION: "Only pay for the fight. Cancel anytime before the end of the trial.",
  FLEX_FUTURE_TEXT: "You will start your DAZN Standard plan at {{CURRENCY}}{{MONTHLY_PRICE}}/month. Cancel anytime before the end of the trial.",
  ANNUAL_BADGE: "1 MONTH FREE",
  ANNUAL_SAVINGS_BADGE: "SAVE {{CURRENCY}}135.99 A YEAR",
  ANNUAL_PRICE_TEXT: "then {{CURRENCY}}{{ANNUAL_PRICE}}/month for 11 months",
  ANNUAL_FEATURE_1: "185+ fights a year from the world's best promoters.",
  ANNUAL_FEATURE_2: "Additional cost for pay-per-view events.",
  ANNUAL_FEATURE_3: "Full HD video resolution.",
  ANNUAL_PAY_MONTHLY_CONTRACT_TEXT: "Annual contract. Auto renews.",
  ANNUAL_PAY_UPFRONT_CONTRACT_TEXT: "",
  PAYMENT_PAGE_TITLE_TRIAL: "Choose how to pay after your free trial",
  PAYMENT_PAGE_TITLE_STANDARD: "Choose how to pay",
  PAYMENT_FREE_TEXT_MONTHLY: "First month free",
  CANCELLATION_TEXT_ANNUAL: "First month free, then {{CURRENCY}}{{ANNUAL_PRICE}}/month for 11 months ({{CURRENCY}}{{ANNUAL_TOTAL}} total over 12 months). 12-month minimum term. On {{RENEWAL_DATE}} your plan renews automatically|First month free, then {{CURRENCY}}{{ANNUAL_PRICE}}/month for 11 months",
  CANCELLATION_TEXT_ULTIMATE_APM: "Your Annual (pay over time) plan will renew automatically on {{RENEWAL_DATE}}. Manage or cancel your annual renewal anytime in My Account. 12-month minimum term",
  CANCELLATION_TEXT_ULTIMATE_APU: "You can cancel the renewal to this subscription in My Account. You will still have full access to DAZN until the end of your annual cycle.",
  ULTIMATE_FEATURE_1: "Minimum 12 pay-per-views a year included at no extra cost.",
  ULTIMATE_FEATURE_2: "Every match from Lega Serie A, and highlights from LALIGA, Bundesliga and the Saudi Pro League.",
  ULTIMATE_FEATURE_3: "HDR and Dolby 5.1 surround sound on select events.",
  UPSELL_CROSSED_PRICE: "N/A",
  UPSELL_PRICE_LENGTH: "month for 12 months",
  PPV1_UPSELL_TILE_DATE: "{{LANDING_PAGE_PPV_DATE}}",
  BUNDLE_MONTHLY_PRICE: "N/A",
  // ── Plan Details card descriptions (shown when no promotional offer is active) ──
  PLAN_DETAILS_FLEX_DESC: "Billed monthly. Cancel anytime.",
  PLAN_DETAILS_ANNUAL_MONTHLY_DESC: "Annual contract. Auto renews.",
  PLAN_DETAILS_ANNUAL_UPFRONT_DESC: "Annual contract. Auto renews. Pay for a year upfront to get the best value deal.",
  // ── Payment page legal / cancel notice lines (no-offer fallback) ──
  PAYMENT_FLEX_CANCEL_NOTICE: "Cancel with 30 days' notice.",
  PAYMENT_FLEX_LEGAL_TEXT: "Monthly subscription. Cancel with 30 days' notice. Your subscription auto-renews unless you cancel.",
};

export function buildEventData(
  json: any,
  region: string,
  tier?: string,
  ratePlan?: string,
  source?: string
): Record<string, any> {

  const merged = json;
  const regionalBase = {};
  const regionKey = normalizeRegionKey(region);

  let eventRegional = json.regions?.[regionKey];
  if (!eventRegional) {
    // Backward-compat: if region is GB but config only has UK
    if (regionKey === 'GB') {
      eventRegional = json.regions?.UK;
    } else if (region === 'IE') {
      eventRegional = json.regions?.GB || json.regions?.UK;
    }
  }

  if (!eventRegional) {
    const available = Object.keys(json.regions || {}).join(', ');
    throw new Error(
      `❌ Region "${region}" not found in config.\n` +
      `   Available regions: ${available}`
    );
  }

  const regional = deepMerge(
    deepMerge(deepMerge(GLOBAL_DEFAULTS, merged.global || {}), regionalBase),
    eventRegional
  );

  const base: Record<string, any> = {
    PPV_NAME: merged.PPV_NAME,
    PPV_FULL_NAME: merged.PPV_FULL_NAME || merged.PPV_NAME,
    PPV_DISPLAY_NAME: merged.PPV_DISPLAY_NAME || merged.PPV_NAME,
    PPV_SURFACING_NAME: merged.PPV_SURFACING_NAME,
    SPORT: merged.SPORT,
    PPV_TYPE: merged.PPV_TYPE,
    SECONDARY_PPV: merged.SECONDARY_PPV,
    // Event configuration owns the duration, so a PPV can have a different
    // trial from the next PPV while still sharing the same plan definition.
    FREE_TRIAL_DAYS: merged.global?.FREE_TRIAL_DAYS ?? merged.FREE_TRIAL_DAYS,
    ...merged.global,
    ...regional,
  };

  // OFFER_TYPE priority: DaznPlan.json (per plan+region) → event config → default
  // Plan-level OFFER_TYPE is already merged by configLoader.ts (deepMerge(planData, eventData)).
  // Since event configs no longer define OFFER_TYPE, the plan value flows through.
  // This fallback handles the case where neither plan nor event defines it.
  if (!base.OFFER_TYPE) {
    base.OFFER_TYPE = '1_month_free';
  }

  // Canadian PPV checkout has no trial or free-month offer, regardless of the
  // subscription plan's default offer. Other Canadian subscription journeys
  // continue to use their configured plan-level offer.
  const isCanadaPPVCheckout = regionKey === 'CA' && Boolean(base.PPV_NAME);
  if (isCanadaPPVCheckout) {
    base.OFFER_TYPE = 'none';
    base.FLEX_BADGE = 'N/A';
    base.FLEX_DESCRIPTION = base.PLAN_DETAILS_FLEX_DESC;
    base.FLEX_TODAY_TEXT = 'N/A';
    base.FLEX_FUTURE_TEXT = 'N/A';
    base.PAYMENT_FREE_TEXT_TRIAL = 'N/A';
    base.PAYMENT_PAGE_TITLE_TRIAL = 'N/A';
    base.CANCELLATION_TEXT_TRIAL = 'N/A';
    base.ANNUAL_BADGE = 'N/A';
    base.CANCELLATION_TEXT_ANNUAL = 'N/A';
  }

  // FREE_TRIAL_DAYS is global within an event (across its regions). It controls
  // every displayed duration and date offset; OFFER_TYPE remains the stable
  // plan identifier (for example, "7_day_trial").
  const hasConfiguredTrialDuration =
    !isCanadaPPVCheckout &&
    base.FREE_TRIAL_DAYS !== undefined &&
    base.FREE_TRIAL_DAYS !== '';
  const trialDays = getTrialDays(base.FREE_TRIAL_DAYS);
  base.FREE_TRIAL_DAYS = String(trialDays);
  const hasDayTrial = isDayTrialOffer(base.OFFER_TYPE);
  // The plan page can show the monthly Flex option while an annual plan is
  // selected. Its trial card still uses the PPV's configured duration, so
  // populate display values whenever the event defines FREE_TRIAL_DAYS.
  if (hasConfiguredTrialDuration || hasDayTrial) {
    if (!base.FLEX_BADGE) base.FLEX_BADGE = `${trialDays} DAY FREE TRIAL`;
    if (!base.PLAN_CTA_BUTTON_STANDARD) base.PLAN_CTA_BUTTON_STANDARD = `Continue with ${trialDays}-day Free Trial`;
    if (!base.PAYMENT_FREE_TEXT_TRIAL) base.PAYMENT_FREE_TEXT_TRIAL = `${trialDays}-days free`;
    if (!base.PAYMENT_PAGE_TITLE_TRIAL) base.PAYMENT_PAGE_TITLE_TRIAL = 'Choose how to pay after your free trial';
    if (!base.CANCELLATION_TEXT_TRIAL) base.CANCELLATION_TEXT_TRIAL = `In ${trialDays} days, you'll be charged {{CURRENCY}}{{MONTHLY_PRICE}}/month. Cancel anytime before the end of the trial.`;
    if (!base.FLEX_TODAY_TEXT) base.FLEX_TODAY_TEXT = `Only pay for the fight and start your ${trialDays}-day free trial of DAZN Standard`;
    if (!base.FLEX_FUTURE_TEXT) base.FLEX_FUTURE_TEXT = 'You will start your DAZN Standard plan at {{CURRENCY}}{{MONTHLY_PRICE}}/month. Cancel anytime before the end of the trial.';
  }
  // Only an actual monthly N-day offer changes the next-payment offset.
  // Annual plans may still display the Flex trial card, but keep their normal
  // annual payment schedule.
  if (hasDayTrial) base.NEXT_PAYMENT_DAYS_OFFSET = trialDays;

  // Regional wording may differ (for example, currency spacing), but it must
  // never carry its own trial duration.
  for (const key of Object.keys(base)) {
    base[key] = replaceTrialDayPlaceholders(base[key], trialDays);
  }

  // PPV1_UPSELL_TILE_DATE: fallback to LANDING_PAGE_PPV_DATE (same short-date format)
  if (!base.PPV1_UPSELL_TILE_DATE && base.LANDING_PAGE_PPV_DATE) {
    base.PPV1_UPSELL_TILE_DATE = base.LANDING_PAGE_PPV_DATE;
  }

  if (!base.BOXING_UPCOMING_DATE) {
    base.BOXING_UPCOMING_DATE = base.LANDING_PAGE_PPV_DATE || base.PPV_DATE || '';
  }

  // Auto-compute NEXT_PAYMENT_DAYS_OFFSET from OFFER_TYPE if not explicitly set
  if (!base.NEXT_PAYMENT_DAYS_OFFSET) {
    const ot = (base.OFFER_TYPE || '1_month_free').toLowerCase();
    if (isDayTrialOffer(ot)) {
      base.NEXT_PAYMENT_DAYS_OFFSET = trialDays;
    } else if (ot === 'no_offer' || ot === 'none') {
      base.NEXT_PAYMENT_DAYS_OFFSET = 30; // No trial/free period, next payment in ~1 month
    } else {
      base.NEXT_PAYMENT_DAYS_OFFSET = 30;
    }
  }

  const env = (process.env.DAZN_ENV || 'stag').toLowerCase();
  let domain = 'stag.dazn.com';
  if (env === 'beta') domain = 'beta.dazn.com';
  if (env === 'prod') domain = 'www.dazn.com';

  if (base.BASE_URL) {
    base.BASE_URL = base.BASE_URL.replace(/(www\.)?dazn\.com/, domain);
  } else {
    // Derive BASE_URL from region + environment when the event config omits it.
    // Maps ISO 3166-1 alpha-2 region codes to DAZN locale path segments.
    const regionLocaleMap: Record<string, string> = {
      GB: 'en-GB', UK: 'en-GB',
      IE: 'en-IE',
      US: 'en-US',
      AU: 'en-AU',
      AE: 'en-AE',
      SA: 'en-SA',
      IN: 'en-IN',
      CA: 'en-CA',
      ES: 'es-ES',
      IT: 'it-IT',
      DE: 'de-DE',
      FR: 'fr-FR',
      JP: 'ja-JP',
    };
    const locale = regionLocaleMap[regionKey] || `en-${regionKey}`;
    base.BASE_URL = `https://${domain}/${locale}`;
    console.log(`💡 Derived BASE_URL: https://${domain}/${locale} (region="${region}", env="${env}")`);
  }

  base.TIER = (tier || merged.TIER || 'standard').toLowerCase();
  base.RATE_PLAN = (ratePlan || merged.RATE_PLAN || 'monthly').toLowerCase();

  console.log(`💎 Tier      : ${base.TIER}`);
  console.log(`📋 Rate Plan : ${base.RATE_PLAN}`);



  const getPriceWithCurrency = (val: string) => {
    if (!val) return '';
    const curr = base.CURRENCY || '';
    if (curr.toLowerCase() === 'kr') {
      const amount = val.replace(/\s*kr$/i, '').trim();
      return `${formatPriceAmount(Number.NaN, amount)} ${curr}`;
    }
    return val.startsWith(curr) ? val : `${curr}${val}`;
  };
  const parsePriceAmount = (val: string) => {
    const raw = String(val || '');
    if (base.CURRENCY?.toLowerCase() !== 'kr') {
      return parseFloat(raw.replace(/[^0-9.]/g, ''));
    }
    const amount = raw.replace(/\bkr\b/gi, '').replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
    return parseFloat(/,\d{2}$/.test(amount) ? amount.replace(',', '.') : amount.replace(/,/g, ''));
  };
  const formatPriceAmount = (amount: number, rawAmount?: string) => {
    if (base.CURRENCY?.toLowerCase() === 'kr') {
      const raw = String(rawAmount ?? amount).trim();
      const nok = raw.match(/^(\d[\d\s]*)(?:,(\d{1,2}))?$/);
      if (!nok) return raw;
      const whole = nok[1].replace(/\s+/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      return nok[2] ? `${whole},${nok[2].padEnd(2, '0')}` : whole;
    }
    const formatted = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
    return formatted;
  };
  const formatSavingsBadge = (amount: string) =>
    base.CURRENCY?.toLowerCase() === 'kr'
      ? `SAVE ${amount} ${base.CURRENCY.toUpperCase()} A YEAR`
      : `SAVE ${getPriceWithCurrency(amount)} A YEAR`;

  // Default TODAY_YOU_PAY_PRICE for ultimate tier (as PPV is included in Ultimate)
  if (base.TIER === 'ultimate') {
    if (base.ULTIMATE_ANNUAL_PAY_MONTHLY_PRICE) {
      base.ANNUAL_PAY_MONTHLY_PRICE = base.ULTIMATE_ANNUAL_PAY_MONTHLY_PRICE;
    } else if (base.UPSELL_PRICE) {
      base.ANNUAL_PAY_MONTHLY_PRICE = base.UPSELL_PRICE;
    }

    if (base.RATE_PLAN === 'annual pay upfront') {
      base.TODAY_YOU_PAY_PRICE = base.ANNUAL_UPFRONT_PRICE;
    } else if (base.RATE_PLAN === 'annual pay monthly') {
      if (base.TODAY_YOU_PAY_ULTIMATE_APM) {
        base.TODAY_YOU_PAY_PRICE = base.TODAY_YOU_PAY_ULTIMATE_APM;
      } else {
        base.TODAY_YOU_PAY_PRICE = base.ANNUAL_PAY_MONTHLY_PRICE;
      }
    }
  }

  // Load DaznPlan.json dynamically to read plan-level offers
  const configDirPlan = fs.existsSync(path.resolve(process.cwd(), 'config/DaznPlan.json'))
    ? path.resolve(process.cwd(), 'config')
    : path.resolve(__dirname, '..', 'config');
  const plansPath = path.join(configDirPlan, 'DaznPlan.json');
  let plans: any = {};
  try {
    plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
    if (plans) {
      for (const key of Object.keys(plans)) {
        if (plans[key].regions && !plans[key].regions.SA) {
          plans[key].regions.SA = JSON.parse(JSON.stringify(plans[key].regions.AE || plans[key].regions.GB || {}));
          if (plans[key].regions.SA) {
            plans[key].regions.SA.CURRENCY = 'SAR';
            if (plans[key].regions.SA.BASE_URL) {
              plans[key].regions.SA.BASE_URL = plans[key].regions.SA.BASE_URL.replace(/\/en-AE$/i, '/en-SA');
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.warn('⚠️ buildEventData: Failed to read DaznPlan.json:', e.message);
  }

  const planKey = json.planKey || 'standard_monthly';
  const planData = plans[planKey];
  const planRegionalOffers = planData?.regions?.[regionKey]?.offers || [];
  const eventRegionalOffers = eventRegional?.offers || [];

  // Combine offers: event-level offers override plan-level offers by name
  const allOffers = [...eventRegionalOffers];
  for (const planOffer of planRegionalOffers) {
    if (!allOffers.some(o => o.name === planOffer.name)) {
      allOffers.push(planOffer);
    }
  }

  // Filter offers matching current environment, region, and enabled flag
  const matchedOffers = allOffers.filter(offer => {
    if (offer.enabled !== true) return false;

    // Match environment
    const targetEnvs = offer.environments || ['stag', 'beta', 'prod'];
    if (!targetEnvs.includes(env)) return false;

    // Match region (backward compat)
    if (offer.target_region && offer.target_region.length > 0) {
      const matchedRegion = offer.target_region.some((r: string) => normalizeRegionKey(r) === regionKey);
      if (!matchedRegion) return false;
    }

    return true;
  });

  let activeOffer: any = null;
  let activeOfferType: string = 'default';

  // Identify flow context
  const sourceLower = String(source || json.SOURCE || json.source || process.env.SOURCE || '').toLowerCase();
  const isBundleFlow = sourceLower.includes('bundle');
  const isPPVFlow = sourceLower.includes('ppv') || json.PPV_TYPE === 'standalone';

  // Contextual Precedence:
  if (isBundleFlow) {
    activeOffer = matchedOffers.find(o => o.name === 'bundle_offer');
    if (activeOffer) activeOfferType = 'bundle_offer';
  } else if (isPPVFlow) {
    activeOffer = matchedOffers.find(o => o.name === 'ppv_only_offer');
    if (activeOffer) activeOfferType = 'ppv_only_offer';
  } else {
    // Subscription Flow / Upsell Flow
    if (base.TIER === 'ultimate' && base.RATE_PLAN === 'annual pay monthly') {
      activeOffer = matchedOffers.find(o => o.name === 'ultimate_offer');
      if (activeOffer) activeOfferType = 'ultimate_offer';
    } else if (base.TIER === 'standard' && base.RATE_PLAN === 'monthly') {
      activeOffer = matchedOffers.find(o => o.name === 'standard_flex_offer');
      if (activeOffer) activeOfferType = 'standard_flex_offer';
    }
  }

  // Map active offer parameters dynamically if present
  if (activeOffer) {
    base.ACTIVE_OFFER_PRESENT = 'true';
    base.ACTIVE_OFFER_TYPE = activeOfferType;
    base.ACTIVE_OFFER = activeOffer;

    // Dynamically assign all keys from activeOffer to base
    Object.assign(base, activeOffer);

    // Format derived values
    const offerPrice = getPriceWithCurrency(activeOffer.OFFER_PRICE);
    const origPrice = getPriceWithCurrency(activeOffer.ORIGINAL_PRICE);

    base.DISCOUNT_BADGE = activeOffer.DISCOUNT_BADGE || 'N/A';
    if (activeOffer.PLAN_LABEL) {
      base.PAYMENT_PLAN_LABEL = activeOffer.PLAN_LABEL;
      base.RATE_PLAN_LABEL = activeOffer.PLAN_LABEL;
    }
    if (origPrice) {
      base.RATE_PLAN_ORIGINAL_PRICE = origPrice;
    }

    // Handle specific offer types
    if (activeOfferType === 'bundle_offer') {
      base.BUNDLE_PRICE = offerPrice;
      base.BUNDLE_ORIGINAL_PRICE = origPrice;
      base.BUNDLE_DISCOUNT = activeOffer.DISCOUNT_BADGE || '';
      base.BUNDLE_SAVE_BADGE = activeOffer.DISCOUNT_BADGE || '';
      base.BUNDLE_OFFER_PRICE = offerPrice;
      base.BUNDLE_OFFER_ORIGINAL_PRICE = origPrice;
      base.BUNDLE_OFFER_DISCOUNT_AMOUNT = activeOffer.DISCOUNT_BADGE || '';
      base.BUNDLE_OFFER_SAVE_BADGE = activeOffer.DISCOUNT_BADGE || '';
      base.BUNDLE_OFFER_DESCRIPTION = activeOffer.OFFER_DESCRIPTION || '';
      base.TODAY_YOU_PAY_PRICE = offerPrice;
    } else if (activeOfferType === 'ppv_only_offer') {
      base.OFFER_EFFECTIVE_PPV_PRICE = offerPrice;
      base.OFFER_ORIGINAL_PPV_PRICE = origPrice;
      base.OFFER_DISCOUNT_AMOUNT = activeOffer.DISCOUNT_BADGE || '0';
      base.OFFER_BADGE = activeOffer.DISCOUNT_BADGE || '';
      base.OFFER_DESCRIPTION = activeOffer.OFFER_DESCRIPTION || '';
      base.TODAY_YOU_PAY_PRICE = offerPrice;
    } else if (activeOfferType === 'standard_flex_offer') {
      base.FLEX_OFFER_PRICE = offerPrice;
      base.FLEX_ORIGINAL_PRICE = origPrice;
      base.PLAN_CTA_BUTTON_STANDARD = "Continue with Flex - Pay Monthly";
      base.CANCELLATION_TEXT_TRIAL = activeOffer.CANCELLATION_TEXT || '';
      base.TODAY_YOU_PAY_PRICE = activeOffer.TODAY_YOU_PAY ? getPriceWithCurrency(activeOffer.TODAY_YOU_PAY) : offerPrice;
      if (activeOffer.TODAY_YOU_PAY_ORIGINAL) {
        base.TODAY_YOU_PAY_ORIGINAL_PRICE = getPriceWithCurrency(activeOffer.TODAY_YOU_PAY_ORIGINAL);
      }

      // Dynamic Annual Savings Badge calculation
      const flexOfferPriceNum = parseFloat(activeOffer.OFFER_PRICE);
      const flexOrigPriceNum = parseFloat(activeOffer.ORIGINAL_PRICE || base.MONTHLY_PRICE || '');
      const annualPriceNum = parseFloat(base.ANNUAL_PRICE || '');
      if (!isNaN(flexOfferPriceNum) && !isNaN(flexOrigPriceNum) && !isNaN(annualPriceNum)) {
        const savingsVal = flexOfferPriceNum + (flexOrigPriceNum * 11) - (annualPriceNum * 11);
        base.ANNUAL_SAVINGS_BADGE = formatSavingsBadge(savingsVal.toFixed(2).replace('.00', ''));
      }
    } else if (activeOfferType === 'ultimate_offer') {
      base.ANNUAL_PAY_MONTHLY_PRICE = offerPrice;
      base.ANNUAL_PAY_MONTHLY_ORIGINAL_PRICE = origPrice;
      base.UPSELL_PRICE = offerPrice;
      base.UPSELL_ORIGINAL_PRICE = origPrice;
      base.UPSELL_CROSSED_PRICE = origPrice;
      base.UPSELL_OFFER_TEXT = activeOffer.OFFER_DESCRIPTION || '';
      base.CANCELLATION_TEXT_ULTIMATE_APM = activeOffer.CANCELLATION_TEXT || '';
      base.ANNUAL_PAY_MONTHLY_CONTRACT_TEXT = activeOffer.OFFER_DESCRIPTION || '';
      base.TODAY_YOU_PAY_PRICE = offerPrice;
    }
  } else {
    base.ACTIVE_OFFER_PRESENT = 'false';
    base.ACTIVE_OFFER_TYPE = 'default';
    base.ACTIVE_OFFER = null;
    base.DISCOUNT_BADGE = 'N/A';
    if (base.RATE_PLAN === 'annual pay monthly') {
      base.PAYMENT_PLAN_LABEL = 'Annual - Pay Monthly';
    } else if (base.RATE_PLAN === 'annual pay upfront') {
      base.PAYMENT_PLAN_LABEL = 'Annual - Pay Upfront';
    } else if (base.RATE_PLAN === 'monthly') {
      base.PAYMENT_PLAN_LABEL = 'Flex – Pay Monthly';
    }
  }

  // Flatten ultimate offer template variables for backward compatibility
  base['ULTIMATE_OFFER.enabled'] = String(activeOffer && activeOffer.name === 'ultimate_offer');
  base['ULTIMATE_OFFER.OFFER_PRICE'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.OFFER_PRICE : '';
  base['ULTIMATE_OFFER.ORIGINAL_PRICE'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.ORIGINAL_PRICE : '';
  base['ULTIMATE_OFFER.DISCOUNT_BADGE'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.DISCOUNT_BADGE : '';
  base['ULTIMATE_OFFER.PLAN_LABEL'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.PLAN_LABEL : '';
  base['ULTIMATE_OFFER.OFFER_DESCRIPTION'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.OFFER_DESCRIPTION : '';
  base['ULTIMATE_OFFER.CANCELLATION_TEXT'] = activeOffer && activeOffer.name === 'ultimate_offer' ? activeOffer.CANCELLATION_TEXT : '';
  // ──────────────────────────────────────────────────────────

  if (regional.DAZN_TIER ?? merged.DAZN_TIER) base.DAZN_TIER = regional.DAZN_TIER ?? merged.DAZN_TIER;

  // Resolve userState values from central userstatus.json file.
  // USER_STATE is ONLY set by existing-user flows (existinguser.ppv.spec.ts sets
  // process.env.USER_STATE explicitly). New-user flows never set it, so its
  // absence means the caller is a brand-new account with no subscription state.
  const userStateKey = process.env.USER_STATE || '';

  const isActiveStandard = [
    'active_standard',
    'active_standard_monthly',
    'active_standard_apm',
  ].includes(userStateKey);

  const isActiveUltimate = [
    'active_ultimate',
    'active_ultimate_apm',
    'active_ultimate_upfront',
  ].includes(userStateKey);

  // Only load user-state config when an existing-user state is explicitly provided.
  // For new users, leave USER_STATE unset so resolveExpected can detect them correctly.
  if (userStateKey) {
    base.USER_STATE = userStateKey;

    const configDirUser = fs.existsSync(path.resolve(process.cwd(), 'config/userstatus.json'))
      ? path.resolve(process.cwd(), 'config')
      : path.resolve(__dirname, '..', 'config');
    const userStatesPath = path.join(configDirUser, 'userstatus.json');
    let userStates: Record<string, any> = {};
    if (fs.existsSync(userStatesPath)) {
      userStates = JSON.parse(fs.readFileSync(userStatesPath, 'utf-8'));
    }
    const userStateConfig = userStates[userStateKey] || {};

    // Apply general user state configuration
    for (const key of Object.keys(userStateConfig)) {
      if (key !== 'regions') {
        base[key] = userStateConfig[key];
      }
    }

    // Apply regional overrides from user state config
    let userStateRegional = userStateConfig.regions?.[regionKey];
    if (!userStateRegional) {
      // Backward-compat: if region is GB but config only has UK
      if (regionKey === 'GB') {
        userStateRegional = userStateConfig.regions?.UK;
      } else if (region === 'IE') {
        userStateRegional = userStateConfig.regions?.GB || userStateConfig.regions?.UK;
      }
    }
    if (userStateRegional) {
      const envKey = (process.env.DAZN_ENV || 'stag').toLowerCase();
      const envOverrides = userStateRegional.environments?.[envKey];
      const finalRegional = envOverrides
        ? { ...userStateRegional, ...envOverrides }
        : userStateRegional;

      for (const key of Object.keys(finalRegional)) {
        if (key !== 'environments') {
          base[key] = finalRegional[key];
        }
      }
    }

    // Ultimate entitlement logic: active_ultimate on included PPVs is Purchased, otherwise Buy now.
    // EXCEPTION: Canada (CA) ultimate users must purchase PPV explicitly — never "Purchased".
    // Note: base.PPV_STATUS may already be "Purchased" from userstatus.json, so we
    // must force override it for CA — not rely on !base.PPV_STATUS being falsy.
    let ppvStatus = base.PPV_STATUS || 'Buy now';
    if (isActiveUltimate) {
      const ppvType = merged.PPV_TYPE || json.PPV_TYPE;
      const isCanada = (process.env.DAZN_REGION || '').toUpperCase() === 'CA';
      if (isCanada) {
        // CA ultimate users always buy PPV explicitly — force Buy now
        ppvStatus = 'Buy now';
      } else if (ppvType === 'included') {
        ppvStatus = 'Purchased';
      } else if (!base.PPV_STATUS) {
        ppvStatus = 'Buy now';
      }
    }
    base.PPV_STATUS = ppvStatus;


  } // end if (userStateKey)

  if (!base.RATE_PLAN_LABEL && (regional.RATE_PLAN_LABEL ?? merged.RATE_PLAN_LABEL)) base.RATE_PLAN_LABEL = regional.RATE_PLAN_LABEL ?? merged.RATE_PLAN_LABEL;
  if (!base.USER_EMAIL && (regional.USER_EMAIL ?? merged.USER_EMAIL)) base.USER_EMAIL = regional.USER_EMAIL ?? merged.USER_EMAIL;
  if (!base.USER_PASSWORD && (regional.USER_PASSWORD ?? merged.USER_PASSWORD)) base.USER_PASSWORD = regional.USER_PASSWORD ?? merged.USER_PASSWORD;
  if (!base.PURCHASE_OPTION && (regional.PURCHASE_OPTION ?? merged.PURCHASE_OPTION)) base.PURCHASE_OPTION = regional.PURCHASE_OPTION ?? merged.PURCHASE_OPTION;

  if (!base.RATE_PLAN_LABEL) {
    const rp = base.RATE_PLAN.toLowerCase();
    if (rp === 'monthly') {
      base.RATE_PLAN_LABEL = base.PAYMENT_PLAN_NAME_FLEX || base.FLEX_TITLE || 'Flex – Pay Monthly';
    } else if (rp === 'annual pay monthly') {
      base.RATE_PLAN_LABEL = base.PAYMENT_PLAN_NAME_ANNUAL || base.ANNUAL_TITLE || 'Annual - Pay Monthly';
    } else if (rp === 'annual pay upfront') {
      base.RATE_PLAN_LABEL = 'Annual - Pay Upfront';
    }
  }
  if (merged.FLOW_FROM_POPUP !== undefined) {
    base.FLOW_FROM_POPUP = String(merged.FLOW_FROM_POPUP);
  }

  const planPage = regional.pages?.plan ?? merged.pages?.plan ?? {};
  if (planPage.PAGE_TITLE) base.PLAN_PAGE_TITLE = planPage.PAGE_TITLE;
  if (planPage.CTA_BUTTON) base.PLAN_CTA_BUTTON = planPage.CTA_BUTTON;
  if (planPage.SELECTED_PLAN) base.PLAN_SELECTED = planPage.SELECTED_PLAN;

  const directFields = [
    'PPV_CTA_TEXT',
    'PLAN_PAGE_TITLE',
    'PLAN_CTA_BUTTON',
    'ANNUAL_PAY_MONTHLY_CONTRACT_TEXT',
    'ULTIMATE_FEATURE_2',
    'ULTIMATE_FEATURE_3',
    'SPORT',
    'PPV_LOCATION',
    'BUNDLE_NAME',
    'BUNDLE_DESCRIPTION',
    'BUNDLE_ORIGINAL_PRICE',
    'BUNDLE_PRICE',
    'BUNDLE_SAVE_BADGE',
    'BUNDLE_DISCOUNT',
    'BUNDLE_FIGHT_COUNT',
    'BUNDLE_SECTION_TITLE',
    'BUNDLE_SECTION_SUBTITLE',
    'BUNDLE_PPV_CARD_DESCRIPTION',
    'BUNDLE_PPV1_NAME',
    'BUNDLE_PPV1_FULL_NAME',
    'BUNDLE_PPV1_DATE',
    'BUNDLE_PPV1_LANDING_DATE',
    'BUNDLE_PPV2_NAME',
    'BUNDLE_PPV2_FULL_NAME',
    'BUNDLE_PPV2_DATE',
    'BUNDLE_PPV2_LANDING_DATE',
    'BUNDLE_TODAY_YOU_PAY_STANDARD',
    'OFFER_BADGE',
    'OFFER_DESCRIPTION',
    'UPSELL_CROSSED_PRICE',
    'BUNDLE_MONTHLY_PRICE',
  ];
  for (const field of directFields) {
    const val = regional[field] ?? merged.global?.[field] ?? merged[field];
    if (val !== undefined) base[field] = val;
  }

  const isBoxingUltimateDirectSource = [
    'boxing-banner-ultimate',
    'boxing-ultimate-subscription',
    'boxing-join-the-club',
  ].includes(sourceLower);

  if (isBoxingUltimateDirectSource) {
    base.ULTIMATE_FEATURE_1 = 'Minimum 12 pay-per-views a year included at no extra cost.';
    base.ULTIMATE_FEATURE_2 = "185+ fights a year from the world's best promoters.";
    base.ULTIMATE_FEATURE_3 = 'HDR and Dolby 5.1 surround sound on select events.';
  }

  // Active standard user: CTA must be set AFTER directFields to avoid being clobbered
  if (isActiveStandard) {
    base.PPV_CTA_TEXT = `Continue with ${base.PPV_NAME} only|Continue with pay-per-view`;
  }

  const isUSRegion = (base.BASE_URL || '').includes('/en-US');
  const ratePlanLower = base.RATE_PLAN.toLowerCase();

  // Today's date for Upgrade Confirmation legal text
  const todayIST = getNowForRegion();
  const dd = String(todayIST.getDate()).padStart(2, '0');
  const mm = String(todayIST.getMonth() + 1).padStart(2, '0');
  const yyyy = todayIST.getFullYear();
  base.TODAY_DATE = isUSRegion ? `${mm}/${dd}/${yyyy}` : `${dd}/${mm}/${yyyy}`;

  if (ratePlanLower === 'annual pay upfront') {
    base.NEXT_PAYMENT_DATE = isUSRegion
      ? formatNextPaymentDateYearlyUS()
      : formatNextPaymentDateYearly();
    base.RENEWAL_DATE = isUSRegion
      ? formatNextPaymentDateYearlyUS()
      : formatNextPaymentDateYearly();
  } else if (ratePlanLower === 'annual pay monthly') {
    base.NEXT_PAYMENT_DATE = isUSRegion
      ? formatNextPaymentDateMonthlyUS()
      : formatNextPaymentDateMonthly();
    base.RENEWAL_DATE = isUSRegion
      ? formatNextPaymentDateYearlyUS()
      : formatNextPaymentDateYearly();
  } else if (base.NEXT_PAYMENT_DAYS_OFFSET !== undefined) {
    base.NEXT_PAYMENT_DATE = isUSRegion
      ? formatNextPaymentDateUS(Number(base.NEXT_PAYMENT_DAYS_OFFSET))
      : formatNextPaymentDate(Number(base.NEXT_PAYMENT_DAYS_OFFSET));
    base.RENEWAL_DATE = isUSRegion
      ? formatNextPaymentDateYearlyUS()
      : formatNextPaymentDateYearly();
  } else {
    base.NEXT_PAYMENT_DATE = isUSRegion
      ? formatNextPaymentDateMonthlyUS()
      : formatNextPaymentDateMonthly();
    base.RENEWAL_DATE = isUSRegion
      ? formatNextPaymentDateYearlyUS()
      : formatNextPaymentDateYearly();
  }

  if (
    (base.PPV_TYPE !== 'standalone' || !base.UPFRONT_SAVE_AMOUNT) &&
    base.ANNUAL_PAY_MONTHLY_PRICE &&
    base.ANNUAL_UPFRONT_PRICE
  ) {
    const monthly = parsePriceAmount(base.ANNUAL_PAY_MONTHLY_PRICE);
    const upfront = parsePriceAmount(base.ANNUAL_UPFRONT_PRICE);
    if (!isNaN(monthly) && !isNaN(upfront)) {
      const saved = Math.round((monthly * 12 - upfront) * 100) / 100;
      base.UPFRONT_SAVE_AMOUNT = formatPriceAmount(saved);
    }
  }

  if (!base.ANNUAL_TOTAL && base.ANNUAL_PRICE) {
    const annualPriceNum = parsePriceAmount(base.ANNUAL_PRICE);
    if (!isNaN(annualPriceNum)) {
      const total = annualPriceNum * 11;
      base.ANNUAL_TOTAL = formatPriceAmount(total);
    }
  }

  const offerType = (base.OFFER_TYPE || '1_month_free').toLowerCase();
  if (isDayTrialOffer(offerType)) {
    base.FLEX_FUTURE_DATE = formatFlexFutureDate(trialDays);
    // Trial payment page shows trial cancellation text, not legacy "Cancel with 30 days' notice"
    base.PAYMENT_FLEX_CANCEL_NOTICE = 'N/A';
    base.PAYMENT_FLEX_LEGAL_TEXT = 'N/A';
  } else if (offerType === '1_month_free') {
    const futureDate = getNow();
    futureDate.setMonth(futureDate.getMonth() + 1);
    const day = futureDate.getDate();
    const month = futureDate.toLocaleString('en-GB', { month: 'long' });
    const year = futureDate.getFullYear();
    base.FLEX_FUTURE_DATE = `In 1 month • ${day} ${month} ${year}`;
    // 1-month free also uses different cancellation text, not "Cancel with 30 days' notice"
    base.PAYMENT_FLEX_CANCEL_NOTICE = 'N/A';
    base.PAYMENT_FLEX_LEGAL_TEXT = 'N/A';
  } else if (offerType === 'no_offer' || offerType === 'none') {
    // No offer — keep default "Cancel with 30 days' notice" messaging
    base.FLEX_FUTURE_DATE = 'N/A';
  } else {
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 1);
    const day = futureDate.getDate();
    const month = futureDate.toLocaleString('en-GB', { month: 'long' });
    const year = futureDate.getFullYear();
    base.FLEX_FUTURE_DATE = `In 1 month • ${day} ${month} ${year}`;
  }

  if (base.PPV_TYPE === 'standalone') {
    base.STANDALONE_FLEX_FUTURE_DATE = formatFlexFutureDate(trialDays);
  }

  // ── Dynamic calculations for non-1-month-free plans ──
  // When the event overrides OFFER_TYPE away from 1_month_free, recalculate
  // savings badge and Today You Pay price dynamically.
  if (offerType !== '1_month_free') {
    const isAnnualFreeMonth = (base.ANNUAL_FREE_BADGE || base.ANNUAL_BADGE || '').toLowerCase().includes('1 month free') || (base.ANNUAL_FREE_BADGE || base.ANNUAL_BADGE || '').toLowerCase().includes('1 month');
    // Annual Savings Badge:
    // - With free month: (MONTHLY_PRICE * 12) - (ANNUAL_PRICE * 11)
    // - Without free month: (MONTHLY_PRICE - ANNUAL_PRICE) * 12
    // Recalculate for ALL plans since the DAZN Plan page shows both flex and annual options
    const monthlyNum = parsePriceAmount(base.MONTHLY_PRICE);
    const annualNum = parsePriceAmount(base.ANNUAL_PRICE);
    if (!isNaN(monthlyNum) && !isNaN(annualNum) && monthlyNum > annualNum) {
      const savings = isAnnualFreeMonth
        ? Math.round(((monthlyNum * 12) - (annualNum * 11)) * 100) / 100
        : Math.round((monthlyNum - annualNum) * 12 * 100) / 100;
      const savingsStr = formatPriceAmount(savings);
      base.ANNUAL_SAVINGS_BADGE = formatSavingsBadge(savingsStr);
      console.log(`💡 Recalculated ANNUAL_SAVINGS_BADGE (isAnnualFreeMonth: ${isAnnualFreeMonth}): ${base.ANNUAL_SAVINGS_BADGE}`);
    }

    // Today You Pay: depends on tier
    // - Ultimate: PPV is included, so Today You Pay = plan price only
    // - Standard: PPV + plan price (no free month discount)
    const isAnnualPlan = base.RATE_PLAN && base.RATE_PLAN.toLowerCase().includes('annual');
    if (isAnnualPlan && base.TIER !== 'ultimate') {
      const ppvPriceNum = parsePriceAmount(base.PPV_PRICE);
      const planPriceNum = parsePriceAmount(base.ANNUAL_PRICE || base.ANNUAL_PAY_MONTHLY_PRICE);
      if (!isNaN(ppvPriceNum) && !isNaN(planPriceNum)) {
        const totalPay = Math.round((ppvPriceNum + planPriceNum) * 100) / 100;
        const totalPayStr = formatPriceAmount(totalPay);
        base.TODAY_YOU_PAY_PRICE = getPriceWithCurrency(totalPayStr);
        console.log(`💡 Recalculated TODAY_YOU_PAY_PRICE for standard annual: ${base.TODAY_YOU_PAY_PRICE}`);
      }
    }
    // For ultimate plans, TODAY_YOU_PAY_PRICE stays as set from event/plan config (plan price only)
    // For monthly plans, TODAY_YOU_PAY_PRICE stays as PPV_PRICE (set from event config)
  }

  // ── FLATTEN upsell_ppv SECTION ─────────────────────────────────────
  // Cross-PPV references (buy PPV A → success screen promotes PPV B → buy PPV B)
  // Regional overrides take priority — only set if not already present in base
  const upsellPpv = merged.upsell_ppv;
  if (upsellPpv && typeof upsellPpv === 'object') {
    for (const [key, val] of Object.entries(upsellPpv)) {
      if (typeof val === 'string' && !base[key]) {
        base[key] = val;
      }
    }
  }

  if (!base.FIRST_NAME) base.FIRST_NAME = 'UAT';
  if (!base.LAST_NAME) base.LAST_NAME = 'UAT';

  if (!base.NEXT_PAYMENT_PRICE) {
    base.NEXT_PAYMENT_PRICE = getPriceWithCurrency(base.MONTHLY_PRICE);
  }

  // Dynamically resolve UPSELL_PRICE and UPSELL_ORIGINAL_PRICE from ultimate_apm plan + event overrides
  if (!base.UPSELL_PRICE) {
    try {
      const ultimateApmPlan = plans.ultimate_apm;
      const ultimateApmRegion = ultimateApmPlan?.regions?.[regionKey] || {};
      const ultimatePlanOffers = ultimateApmRegion.offers || [];

      // Merge with event-level overrides
      const combinedUltimateOffers = [...eventRegionalOffers];
      for (const planOffer of ultimatePlanOffers) {
        if (!combinedUltimateOffers.some(o => o.name === planOffer.name)) {
          combinedUltimateOffers.push(planOffer);
        }
      }

      const ultimateOffer = combinedUltimateOffers.find(o => o.name === 'ultimate_offer' && o.enabled === true);
      if (ultimateOffer) {
        base.UPSELL_PRICE = getPriceWithCurrency(ultimateOffer.OFFER_PRICE);
        base.UPSELL_ORIGINAL_PRICE = getPriceWithCurrency(ultimateOffer.ORIGINAL_PRICE);
        base.UPSELL_CROSSED_PRICE = getPriceWithCurrency(ultimateOffer.ORIGINAL_PRICE);
        base.UPSELL_OFFER_TEXT = ultimateOffer.OFFER_DESCRIPTION || '';
        console.log(`💡 Resolved dynamic UPSELL_PRICE from ultimate_offer: ${base.UPSELL_PRICE}`);
      } else {
        const standardUltimatePrice = ultimateApmRegion.ANNUAL_PAY_MONTHLY_PRICE || '';
        base.UPSELL_PRICE = getPriceWithCurrency(standardUltimatePrice);
        base.UPSELL_ORIGINAL_PRICE = getPriceWithCurrency(standardUltimatePrice);
        base.UPSELL_CROSSED_PRICE = 'N/A';
        base.UPSELL_OFFER_TEXT = '';
        console.log(`💡 Resolved fallback UPSELL_PRICE: ${base.UPSELL_PRICE}`);
      }
    } catch (e: any) {
      console.warn('⚠️ Failed to resolve UPSELL_PRICE: ', e.message);
    }
  }

  const upsellPrice = base.UPSELL_PRICE || '';
  const ppvPrice = base.PPV_PRICE || '';
  const offerAvailable = base.OFFER_AVAILABLE === 'true';
  const basePriceNum = parseFloat(ppvPrice.replace(/[^0-9.]/g, ''));
  const upsellPriceNum = upsellPrice ? parseFloat(upsellPrice.replace(/[^0-9.]/g, '')) : NaN;

  base.OFFER_AVAILABLE = String(offerAvailable);
  base.OFFER_EFFECTIVE_PPV_PRICE = upsellPrice && offerAvailable ? upsellPrice : ppvPrice;
  base.OFFER_ORIGINAL_PPV_PRICE = ppvPrice;
  base.OFFER_DISCOUNT_AMOUNT = offerAvailable && basePriceNum > parseFloat(upsellPrice.replace(/[^0-9.]/g, ''))
    ? String(Math.round(basePriceNum - parseFloat(upsellPrice.replace(/[^0-9.]/g, ''))))
    : '0';
  base.OFFER_BADGE = base.OFFER_BADGE || '';
  base.OFFER_DESCRIPTION = base.OFFER_DESCRIPTION || '';

  if (offerAvailable && base.OFFER_EFFECTIVE_PPV_PRICE) {
    base.TODAY_YOU_PAY_PRICE = base.OFFER_EFFECTIVE_PPV_PRICE;
  }

  base.PPV_PRICE_DISPLAY = getPriceWithCurrency(base.PPV_PRICE);

  base.UPSELL_PRICE_DISPLAY = getPriceWithCurrency(base.UPSELL_PRICE);

  base.UPSELL_SUB_TEXT = `Then ${getPriceWithCurrency(base.ANNUAL_PRICE)} /month for ${base.ANNUAL_MONTHS} months.`;
  base.TRIAL_MONTHLY_TEXT = getPriceWithCurrency(base.MONTHLY_PRICE);

  if (base.ANNUAL_PAY_MONTHLY_PRICE) {
    base.ANNUAL_PAY_MONTHLY_PRICE_DISPLAY = getPriceWithCurrency(base.ANNUAL_PAY_MONTHLY_PRICE);
  }

  if (base.ANNUAL_UPFRONT_PRICE) {
    base.ANNUAL_UPFRONT_PRICE_DISPLAY = getPriceWithCurrency(base.ANNUAL_UPFRONT_PRICE);
  }

  if (base.UPFRONT_SAVE_AMOUNT) {
    const savedVal = parseFloat(base.UPFRONT_SAVE_AMOUNT);
    if (!isNaN(savedVal) && savedVal <= 0) {
      base.UPFRONT_SAVE_AMOUNT_DISPLAY = 'N/A';
    } else {
      base.UPFRONT_SAVE_AMOUNT_DISPLAY = getPriceWithCurrency(base.UPFRONT_SAVE_AMOUNT);
    }
  }

  if (base.UPSELL_FEATURE_1) {
    base.UPSELL_FEATURE_1 = base.UPSELL_FEATURE_1.replace(
      /\{\{PPV_NAME\}\}/g,
      base.PPV_NAME
    );
  } else {
    base.UPSELL_FEATURE_1 =
      `Pay-per-views included at no extra cost. Minimum of 12 events per year including ${base.PPV_NAME}.`;
  }

  if (base.ANNUAL_TOTAL) {
    if (!base.ANNUAL_TOTAL.startsWith(base.CURRENCY)) {
      base.ANNUAL_TOTAL_DISPLAY = getPriceWithCurrency(base.ANNUAL_TOTAL);
    } else {
      base.ANNUAL_TOTAL_DISPLAY = base.ANNUAL_TOTAL;
    }
  }

  if (!base.HOME_BOXING_UPCOMING_DATE) {
    base.HOME_BOXING_UPCOMING_DATE = formatHomeBoxingUpcomingDate(
      base.HOME_BOXING_UPCOMING_RAW_DATE ||
      base.MOBILE_PPV_DATE ||
      base.LANDING_PAGE_PPV_DATE ||
      base.BOXING_UPCOMING_DATE ||
      base.PPV_DATE ||
      ''
    );
  }

  if (!base.HOME_BOXING_UPCOMING_TIME) {
    base.HOME_BOXING_UPCOMING_TIME = formatHomeBoxingUpcomingTime(
      base.HOME_BOXING_UPCOMING_RAW_TIME,
      base.MOBILE_PPV_DATE,
      base.BOXING_BANNER_SUBTITLE,
      base.PPV_TIME,
      base.PPV_DATE
    );
  }

  if (!base.HOME_BOXING_UPCOMING_DATE_TIME_TEXT) {
    base.HOME_BOXING_UPCOMING_DATE_TIME_TEXT =
      `WATCH LIVE ${base.HOME_BOXING_UPCOMING_DATE} at ${base.HOME_BOXING_UPCOMING_TIME}`.trim();
  }

  if (isBundleFlow && base.TIER !== 'ultimate') {
    base.TODAY_YOU_PAY_PRICE = base.BUNDLE_TODAY_YOU_PAY_STANDARD || base.BUNDLE_PRICE || base.TODAY_YOU_PAY_PRICE;
  }

  if (!base.BUNDLE_MONTHLY_PRICE || base.BUNDLE_MONTHLY_PRICE === 'N/A') {
    if (base.BUNDLE_PRICE && base.BUNDLE_PRICE !== 'N/A') {
      base.BUNDLE_MONTHLY_PRICE = base.BUNDLE_PRICE;
    }
  }

  // Prepend currency to raw price fields if currency is missing in expected event data
  const currencySymbol = base.CURRENCY || '';
  if (currencySymbol) {
    const priceKeysToPrepend = [
      'MONTHLY_PRICE',
      'ANNUAL_PRICE',
      'ANNUAL_PAY_MONTHLY_PRICE',
      'ANNUAL_UPFRONT_PRICE',
      'PPV_PRICE',
      'TODAY_YOU_PAY_PRICE',
      'UPSELL_PRICE',
      'UPSELL_CROSSED_PRICE',
      'BUNDLE_PRICE',
      'BUNDLE_ORIGINAL_PRICE',
      'FLEX_OFFER_PRICE',
      'FLEX_ORIGINAL_PRICE',
      'ANNUAL_PAY_MONTHLY_ORIGINAL_PRICE',
      'UPSELL_ORIGINAL_PRICE',
      'NEXT_PAYMENT_PRICE',
      'TRIAL_MONTHLY_PRICE',
      'BUNDLE_MONTHLY_PRICE',
      'ANNUAL_TOTAL',
      'ULTIMATE_ANNUAL_PAY_MONTHLY_PRICE',
      'TODAY_YOU_PAY_ULTIMATE_APM',
      'OFFER_PRICE',
      'ORIGINAL_PRICE',
      'TODAY_YOU_PAY',
      'TODAY_YOU_PAY_ORIGINAL'
    ];

    for (const key of priceKeysToPrepend) {
      if (base[key] && typeof base[key] === 'string' && base[key] !== 'N/A' && base[key] !== '') {
        const val = base[key].trim();
        const isSuffixCurrency = currencySymbol.toLowerCase() === 'kr';
        if (!(isSuffixCurrency ? val.toLowerCase().endsWith(currencySymbol.toLowerCase()) : val.startsWith(currencySymbol))) {
          // Guard: skip if the value already carries this currency prefix.
          // Needed for multi-letter codes like AED, SAR, R$ where the raw
          // value in DaznPlan.json may already include the symbol (e.g. "SAR 55.99").
          const valUpper = val.toUpperCase();
          const symUpper = currencySymbol.toUpperCase();
          if (valUpper.startsWith(symUpper)) {
            continue;
          }
          // Norwegian kr is rendered after the amount; other currencies remain prefixes.
          if (currencySymbol.toLowerCase() === 'kr') {
            base[key] = `${val} ${currencySymbol}`;
          } else {
            const sep = currencySymbol.length === 1 ? '' : ' ';
            base[key] = `${currencySymbol}${sep}${val}`;
          }
        }
      }
    }
  }

  // Direct event fields are merged later in this function, so materialize any
  // duration tokens once more before the data is exposed to tests.
  for (const key of Object.keys(base)) {
    base[key] = replaceTrialDayPlaceholders(base[key], trialDays);
  }

  const keys = Object.keys(base);
  for (const k of keys) {
    const upper = k.toUpperCase();
    if (!(upper in base)) base[upper] = base[k];
  }

  console.log('📦 eventData built:', JSON.stringify(base, null, 2));
  return base;
}
