import { getDynamicDateBadge, getDynamicDateTimeBadge, getNowForRegion, parseConfigDate } from './dateUtils';
import { resolvePpvTitleForSurface } from './ppvTitleResolver';

const DEFAULT_PPV_POPUP_DESCRIPTION = 'Catch the biggest moment of the year. Select a DAZN plan to pair with your pay-per-view.';
const ACTIVE_STANDARD_PPV_POPUP_DESCRIPTION = 'Catch the biggest moment of the year. Add this pay-per-view to your DAZN plan.';

function replacePlaceholders(template: string, eventData: Record<string, string>): string {
  let result = template;
  for (let pass = 0; pass < 2; pass++) {
    result = result.replace(/\{\{(.*?)\}\}/g, (match, key) => {
      const k = key.trim();
      let value =
        eventData[k] ??
        eventData[k.toUpperCase()] ??
        eventData[k.toLowerCase()] ??
        eventData[k.replace(/\s+/g, '_').toUpperCase()] ??
        eventData[k.replace(/\s+/g, '_')];

      if (value === undefined && (k.toUpperCase() === 'MOBILE_PPV_PROMOTER' || k.toUpperCase() === 'PPV_PROMOTER')) {
        value = eventData.MOBILE_PPV_PROMOTER || eventData.PPV_PROMOTER;
      }

      if (value === undefined) {
        return match;
      }
      return String(value);
    });
    if (!result.includes('{{')) break;
  }
  return result;
}

function withCurrency(value: string | undefined, currency: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const curr = String(currency || '').trim();
  if (curr.toLowerCase() === 'kr') {
    return /\bkr$/i.test(raw) ? raw : `${raw} ${curr}`;
  }
  if (!curr || raw.startsWith(curr) || /^[A-Z]{3}\s/i.test(raw) || /^[£$€₹]/.test(raw)) {
    return raw;
  }
  if (/^[A-Z]{3}$/.test(curr)) {
    return `${curr} ${raw}`;
  }
  return `${curr}${raw}`;
}

/**
 * Relative DAZN labels are only valid for values that explicitly contain both
 * a calendar date and a time.  Checking this before date parsing prevents a
 * date-only or time-only chip from being accidentally treated as tomorrow.
 */
function hasExplicitDateAndTime(value: string): boolean {
  const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const datePattern = new RegExp(`(?:\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${month}\\b|\\b${month}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)`, 'i');
  const timePattern = /\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:a\.?m\.?|p\.?m\.?)?\b/i;

  return value.split('|').some(candidate => datePattern.test(candidate) && timePattern.test(candidate));
}

function withUpcomingWeekdayCandidates(value: string, eventData: Record<string, string>): string {
  const raw = String(value || '').trim();
  if (!raw || raw.toUpperCase() === 'N/A') return raw;

  const regionFromBaseUrl = String(eventData.BASE_URL || '').match(/\/en-([A-Z]{2})\b/i)?.[1];
  const region = eventData.DAZN_REGION || eventData.REGION || regionFromBaseUrl || process.env.DAZN_REGION;
  const referenceDate = getNowForRegion(region);
  const eventDate = parseConfigDate(raw, referenceDate);
  const refDateStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const eventDateStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const diffDays = Math.round((eventDateStart.getTime() - refDateStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0 || diffDays > 7) return raw;

  const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDay = shortDays[eventDate.getDay()];
  const fullDay = fullDays[eventDate.getDay()];
  const hours = eventDate.getHours();
  const relativeLabels: string[] = [];

  if (diffDays === 0) {
    relativeLabels.push('Today');
    if (hours >= 5 && hours <= 11) {
      relativeLabels.push('This morning');
    } else if (hours >= 12 && hours <= 16) {
      relativeLabels.push('This afternoon');
    } else if (hours >= 17 && hours <= 20) {
      relativeLabels.push('This evening', 'Tonight');
    } else {
      relativeLabels.push('Tonight', 'This night');
    }
  } else if (diffDays === 1) {
    relativeLabels.push('Tomorrow');
  }

  return Array.from(new Set([
    raw,
    ...relativeLabels.flatMap(label => [label, label.toUpperCase(), label.toLowerCase()]),
    fullDay,
    fullDay.toUpperCase(),
    fullDay.toLowerCase(),
    shortDay,
    shortDay.toUpperCase(),
    shortDay.toLowerCase(),
  ])).join('|');
}

export function resolveExpected(
  rule: any,
  eventData: Record<string, string>
): string {
  if (typeof rule === 'string') {
    return replacePlaceholders(rule, eventData);
  }
  if (!rule || typeof rule !== 'object') {
    return String(rule || '');
  }
  const rawField = rule.Field || rule.field || '';
  const field = rawField.trim().toLowerCase();
  const rawTier = rule.Tier || rule.tier || '';
  const tier = rawTier.trim().toLowerCase();
  const rawRatePlan = rule['Rate Plan'] || rule.ratePlan || rule['RatePlan'] || '';
  const ratePlan = rawRatePlan.trim().toLowerCase();

  const rawPage = rule.Page || rule.page || eventData.CURRENT_PAGE || eventData.current_page || '';
  const pageName = rawPage.trim().toLowerCase();
  const normalizedPageName = pageName.replace(/[\s_-]+/g, ' ').trim();
  const isUnspecifiedPage = normalizedPageName === '';
  const isPlanPage = normalizedPageName === 'dazn plan' || normalizedPageName === 'plan' || isUnspecifiedPage;
  const isPaymentPage = normalizedPageName === 'payment';
  // The add-on checkout has its own price semantics.  For this page the
  // amount beside "Today you pay" is the one-time PPV charge, even when the
  // account is already on an annual standard plan (whose plan total is also
  // present in eventData.TODAY_YOU_PAY_PRICE).
  const isPpvPaymentPage = normalizedPageName.includes('ppv payment') ||
    normalizedPageName.includes('upsell payment') ||
    pageName.includes('/addon/purchase');
  const isUpsellPpvPayment = isPpvPaymentPage &&
    String(eventData.PPV_TYPE || '').toLowerCase() === 'upsell';
  const ppvPaymentPrice = isUpsellPpvPayment
    ? eventData.UPSELL_PPV_TODAY || eventData.UPSELL_PPV_PRICE || ''
    : eventData.OFFER_EFFECTIVE_PPV_PRICE || eventData.PPV_PRICE || eventData.TODAY_YOU_PAY_PRICE || '';
  const currentUserState = String(eventData.USER_STATE || process.env.USER_STATE || '').trim().toLowerCase();
  const paymentProfile = String(eventData.PAYMENT_PROFILE || process.env.PAYMENT_PROFILE || '').trim().toLowerCase();
  const isGiftCodePaymentProfile = paymentProfile === 'giftcode' || paymentProfile === 'gift_code' || paymentProfile === 'gift-code';
  const isGooglePayPaymentProfile = paymentProfile === 'googlepay' || paymentProfile === 'google_pay' || paymentProfile === 'google-pay';
  const hasNoSavedCardPaymentProfile = isGiftCodePaymentProfile || isGooglePayPaymentProfile;
  const isActiveStandardUser = [
    'active_standard',
    'active_standard_monthly',
    'active_standard_apm',
  ].includes(currentUserState);

  if (field === 'current subscription' && ['freemium', 'frozen'].includes(currentUserState)) {
    return 'N/A';
  }

  if (field === 'instruction header' && (pageName.includes('paywall') || pageName.includes('mobile'))) {
    const isNewUser = !currentUserState || currentUserState === 'new' || currentUserState === 'anonymous';
    const isLoginFirst = String(eventData.LOGIN_FIRST ?? process.env.LOGIN_FIRST ?? '').toLowerCase() === 'true';
    if (!isNewUser && isLoginFirst) {
      const email = eventData.USER_EMAIL || process.env.USER_EMAIL || '';
      return `To watch this and more check the email we just sent to ${email}`.trim();
    } else {
      return 'How to watch this and more?';
    }
  }

  if (field === 'instruction text' && (pageName.includes('paywall') || pageName.includes('mobile'))) {
    if (isActiveStandardUser) {
      return 'Paste this link on your browser and add this pay-per-view to your plan';
    } else {
      return 'Paste this link on your browser and choose the plan that’s right for you';
    }
  }

  if (
    field === 'banner - fight card cta' &&
    pageName.includes('landing') &&
    !String(rule.Flow || rule.flow || '').toLowerCase().includes('ultimate')
  ) {
    return 'N/A';
  }

  if (field === 'upsell feature 1' && pageName === 'ppv') {
    return 'Minimum 12 pay-per-views a year included at no extra cost.';
  }

  if (isActiveStandardUser && normalizedPageName === 'choose how to buy') {
    if (field === 'upsell feature 1') {
      // Prefer the event-specific UPSELL_FEATURE_1 (may include PPV name suffix);
      // fall back to the standard wording used on this page.
      const dynamicVal = eventData.UPSELL_FEATURE_1;
      const standardVal = 'Pay-per-views included at no extra cost. Minimum of 12 events per year.';
      return dynamicVal ? `${dynamicVal}|${standardVal}` : standardVal;
    }
    if (field === 'upsell feature 2') {
      // On the Choose How To Buy page the order is: PPV bullet → HDR bullet → 185+ fights bullet
      // UPSELL_FEATURE_3 holds the HDR text in GLOBAL_DEFAULTS; use it for slot 2 on this page.
      return (
        eventData.UPSELL_FEATURE_3 ||
        'HDR and Dolby 5.1 surround sound on select events.'
      );
    }
    if (field === 'upsell feature 3') {
      // UPSELL_FEATURE_2 holds "185+ fights" in GLOBAL_DEFAULTS; it appears 3rd on this page.
      const baseExpected = eventData.UPSELL_FEATURE_2 || "185+ fights a year from the world's best promoters.";
      return baseExpected.includes('promoters')
        ? `${baseExpected}|${baseExpected.replace(/promoters/g, 'promotors')}`
        : baseExpected;
    }
    if (field === 'upsell feature 4') {
      const region = (eventData.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase();
      if (region === 'NO' || region === 'AE' || region === 'AU') {
        return 'Highlights from LALIGA, Bundesliga and Saudi Pro League.';
      }
      if (eventData.UPSELL_FEATURE_4) return eventData.UPSELL_FEATURE_4;
      if (region === 'US') {
        return 'Exclusive UFEA Champions League and Serie A in Spanish language, plus highlights from LALIGA, Bundesliga and Saudi Pro League.';
      }
      return 'Every match from Lega Serie A, and highlights from LALIGA, Bundesliga and the Saudi Pro League.';
    }
  }

  // CTA after selecting DAZN Ultimate card — applies to Choose How To Buy, Default Signup, PPV pages
  if (field === 'cta after ultimate selection') {
    return eventData.PLAN_CTA_BUTTON || 'Continue with DAZN Ultimate';
  }
  if (isPaymentPage) {
    const isMobileWebHandoff = String(eventData.MOBILE_WEB_HANDOFF || eventData.mobile_web_handoff || '').toLowerCase() === 'true';

    // Mobile checkout does not render the desktop purchase-summary heading.
    // Returning N/A lets validateVariant skip them via its existing not-required path.
    if (
      isMobileWebHandoff &&
      field === 'purchase summary heading'
    ) {
      return 'N/A';
    }

    const isReturning =
      String(rule.Flow || rule.flow).toLowerCase() === 'returning' ||
      ['frozen', 'sub_active', 'cancelled'].includes(String(eventData.USER_STATE || process.env.USER_STATE || '').toLowerCase().trim());

    if (!isReturning) {
      if (field === 'signed in as text') return 'N/A';
      if (field === 'log out present') return 'No';
    }
    if (field === 'saved card present') {
      const userState = (eventData.USER_STATE || process.env.USER_STATE || 'freemium').trim().toLowerCase();
      if (hasNoSavedCardPaymentProfile) return 'No';
      return userState === 'freemium' ? 'No' : 'Yes';
    }
    if (isGiftCodePaymentProfile && field === 'more payment methods') {
      return 'N/A';
    }

    // ── Next Payment fields: skip for GB, IE, and N-day trials ──
    if (field === 'next payment label' || field === 'next payment price') {
      const region = (eventData.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase();
      const offerType = (eventData.OFFER_TYPE || '').toLowerCase();
      if (region === 'GB' || region === 'IE' || /^\d+_day_trial$/.test(offerType)) {
        return 'N/A';
      }
    }
  }

  if (isPpvPaymentPage) {
    if (hasNoSavedCardPaymentProfile && (field === 'saved card' || field === 'card on file')) {
      return 'N/A';
    }
    if (isGiftCodePaymentProfile && field === 'more payment methods') {
      return 'N/A';
    }
  }

  // ── Excluding Tax ──────────────────────────────────────────────
  if (field === 'excluding tax text' || field === 'excluding tax') {
    const isUS = (eventData.BASE_URL || '').includes('/en-US') ||
      (eventData.DAZN_REGION || process.env.DAZN_REGION || '') === 'US';
    return isUS ? '(excluding tax)' : 'N/A';
  }

  // ── Annual plan selection: flip Yes/No based on actual RATE_PLAN ─────────
  // Excel default assumes APM selected (ultimate_apm). For APU plans, invert.
  if (field === 'annual pay monthly selected' || field === 'annual pay upfront selected') {
    const rp = (eventData.RATE_PLAN || eventData.rate_plan || '').toLowerCase().trim();
    const isAPU = rp.includes('upfront');
    if (field === 'annual pay monthly selected') return isAPU ? 'No' : 'Yes';
    if (field === 'annual pay upfront selected') return isAPU ? 'Yes' : 'No';
  }
  // ─────────────────────────────────────────────────────────────────────────

  let raw = rule?.Expected ?? rule?.Value ?? rule?.expected ?? rule?.value ?? '';
  // Keep the spreadsheet expression so relative-date formatting can be scoped
  // to the specific configured event-date fields after placeholders resolve.
  const rawExpectation = String(raw ?? '');


  const currentSource = (eventData.SOURCE || eventData.source || '').trim().toLowerCase();
  const isLoginFirst = String(eventData.LOGIN_FIRST ?? process.env.LOGIN_FIRST ?? process.env.LOGIN ?? '').toLowerCase() === 'true';
  const isDiscoveryMobileSurface = normalizedPageName === 'mobile' &&
    ['search', 'schedule', 'home-boxing-tile'].includes(currentSource);
  const isPaywallSurface = normalizedPageName.includes('paywall');
  const isPopupField = field.startsWith('popup ');

  // Some AEW discovery cards and their paywalls render the configured event
  // with a location suffix. Keep PPV_NAME canonical everywhere else.
  if (
    ['ppv name', 'event name', 'ppv title', 'event title', 'popup - event title', 'popup ppv name'].includes(field) &&
    (isDiscoveryMobileSurface || isPaywallSurface || isPopupField)
  ) {
    const displayTitle = resolvePpvTitleForSurface(eventData, currentSource, rawPage);
    if (displayTitle) return displayTitle;
  }

  if (
    field === 'popup - event description' &&
    isLoginFirst &&
    ['active_standard_monthly', 'active_standard_apm'].includes(currentUserState)
  ) {
    return ACTIVE_STANDARD_PPV_POPUP_DESCRIPTION;
  }

  if (
    (field === 'cta button' || field === 'cta button text') &&
    isPlanPage &&
    tier === 'ultimate' &&
    isLoginFirst &&
    ['active_standard_monthly', 'active_standard_apm'].includes(currentUserState) &&
    ['boxing-banner-ultimate', 'boxing-ultimate-subscription', 'boxing-join-the-club'].includes(currentSource)
  ) {
    return eventData.PLAN_CTA_BUTTON_ULTIMATE || 'Continue with DAZN Ultimate';
  }

  if (
    field === 'biggest fights section' &&
    currentSource === 'home-biggest-fights' &&
    eventData.HOME_BIGGEST_FIGHTS_SECTION_HEADING
  ) {
    return String(eventData.HOME_BIGGEST_FIGHTS_SECTION_HEADING);
  }

  if (pageName === 'default signup') {
    // The Default Signup page upsell section always shows Ultimate APM pricing
    // in split format regardless of which plan the user is testing:
    //   - Upsell Price:  £24.99           (no /month suffix)
    //   - Upsell Price Length: /month for 12 months
    // This is fixed content in the upsell card — not plan-dependent.
    if (field === 'upsell price') {
      raw = '{{UPSELL_PRICE}}';
    } else if (field === 'upsell price length') {
      raw = '/month for 12 months';
    }
  }


  // Banner date resolution: mobile uses MOBILE_BANNER_DATE_TIME; landing pages use LANDING_BANNER_DATE
  if (field === 'banner - event date') {
    const isMobilePage = (pageName || '').toLowerCase().includes('mobile') ||
      (pageName || '').toLowerCase().includes('ppv banner') ||
      (eventData.CURRENT_PAGE || '').toLowerCase().includes('ppv banner');
    if (isMobilePage && eventData.MOBILE_BANNER_DATE_TIME) {
      raw = String(eventData.MOBILE_BANNER_DATE_TIME);
    }
    if (
      !isMobilePage &&
      (pageName || '').toLowerCase().startsWith('landing') &&
      eventData.LANDING_BANNER_DATE
    ) {
      raw = String(eventData.LANDING_BANNER_DATE);
    }
  }


  // Page-specific date expectations
  if (field === 'ppv date and time text') {
    switch ((pageName || "").toLowerCase()) {
      case 'landing':
      case 'landing page':
        if (eventData.LANDING_BANNER_DATE) {
          raw = String(eventData.LANDING_BANNER_DATE);
        }
        break;

      case 'ppv':
        if (eventData.PPV_PAGE_DATE) raw = String(eventData.PPV_PAGE_DATE);
        break;
    }

    if ((raw === undefined || raw === null || raw === '') && eventData.PPV_PAGE_DATE_TIME) {
      raw = String(eventData.PPV_PAGE_DATE_TIME);
    }
  }

  // Page-specific subtitle expectations
  if (field === 'event subtitle' && (pageName || "").toLowerCase() === 'boxing' && eventData.BOXING_BANNER_SUBTITLE) {
    return String(eventData.BOXING_BANNER_SUBTITLE);
  }

  // Boxing banner date (tag chip above event title on /boxing page)
  if (field === 'boxing banner date' && eventData.BOXING_BANNER_DATE) {
    return withUpcomingWeekdayCandidates(String(eventData.BOXING_BANNER_DATE), eventData);
  }


  if (field === 'banner - event description' && eventData.BANNER_DESCRIPTION) {
    return String(eventData.BANNER_DESCRIPTION);
  }

  if (field === 'banner description' && ['ppv banner', 'mobile'].includes(normalizedPageName) && eventData.MOBILE_BANNER_DESCRIPTION) {
    return String(eventData.MOBILE_BANNER_DESCRIPTION);
  }

  // home-page-dazntile opens the first eligible DAZN entitlement tile.
  // That tile is not guaranteed to be the configured PPV event, so
  // PPV-specific event-date assertions are not valid for this source.
  if (
    currentSource === 'home-page-dazntile' &&
    (
      field === 'ppv date and time text' ||
      field === 'ppv date' ||
      field === 'ppv time' ||
      field === 'banner - event date'
    )
  ) {
    return 'N/A';
  }

  // Non-Boxing sport pages surface their PPV in a "Coming Up" tile. The
  // Home of Sport spreadsheet intentionally uses SEARCH_PPV_DATE_TIME for
  // this field, so do not run the value through the generic date-only badge
  // formatter (which would discard the time component).
  if (
    field === 'ppv date' &&
    pageName === 'home of sport' &&
    currentSource === 'home-boxing-tile'
  ) {
    return replacePlaceholders(String(raw ?? ''), eventData);
  }

  // Check if a PPV event is active. If a PPV event is active, the boxing subscription-only sources
  // will render the PPV-bundled offers on the live site, so they should be validated using the PPV rules.
  const hasPPVEvent = eventData.PPV_NAME && eventData.PPV_NAME !== 'N/A' && eventData.PPV_NAME !== 'none';
  const isSubscriptionOnly =
    (currentSource === 'boxing-ultimate-subscription' ||
      currentSource === 'boxing-standard-subscription' ||
      currentSource === 'boxing-join-the-club') &&
    !hasPPVEvent;

  if (isSubscriptionOnly) {
    // In subscription-only flow (no PPV), the plans page shows default descriptions
    // instead of trial/offer text — no trial badge, no trial description
    if (field === 'ppv name' || field === 'ppv price') {
      return 'N/A| |';
    }
    // Flex: no trial badge/today/future text, but show default description
    if (field === 'flex badge') {
      return 'N/A| |';
    }
    if (field === 'flex description') {
      return eventData.PLAN_DETAILS_FLEX_DESC || 'Billed monthly. Cancel anytime.|N/A| |';
    }
    if (field === 'flex today text' || field === 'flex future text') {
      return 'N/A| |';
    }
    // Annual: no 1-month-free badge, but show default description
    if (field === 'annual badge') {
      return 'N/A| |';
    }
    if (field === 'annual price text') {
      return eventData.PLAN_DETAILS_ANNUAL_MONTHLY_DESC || 'Annual contract. Auto renews.|N/A| |';
    }
    if (
      field === 'annual feature 1' ||
      field === 'annual feature 2' ||
      field === 'annual feature 3' ||
      field === 'rate plan original price' ||
      field === 'rate plan discounted price'
    ) {
      return 'N/A| |';
    }
    if (field === 'cta button' || field === 'cta button text' || field === 'cta after apm selection') {
      const currentTierVal = (eventData.TIER || '').toLowerCase();
      if (currentTierVal === 'ultimate') {
        return 'Continue with DAZN Ultimate|Continue';
      } else {
        return 'Continue with DAZN Standard|Continue';
      }
    }
    if (field === 'today you pay price' || field === 'today price' || (field.includes('today you pay') && !field.includes('text'))) {
      if (isPpvPaymentPage) return ppvPaymentPrice;
      const currentTierVal = (eventData.TIER || '').toLowerCase();
      if (currentTierVal === 'ultimate') {
        return eventData.ANNUAL_PAY_MONTHLY_PRICE || '';
      } else {
        return eventData.CURRENCY && eventData.ANNUAL_PRICE ? `${eventData.CURRENCY}${eventData.ANNUAL_PRICE}` : '';
      }
    }
    if (field === 'cancellation text' || field === 'cancel text') {
      const currentTierVal = (eventData.TIER || '').toLowerCase();
      const currentRatePlanVal = (eventData.RATE_PLAN || '').replace(/-/g, ' ').toLowerCase();
      if (currentTierVal === 'ultimate' && currentRatePlanVal.includes('annual pay monthly')) {
        return eventData.CANCELLATION_TEXT_ULTIMATE_APM || '';
      } else if (currentTierVal === 'ultimate' && currentRatePlanVal.includes('annual pay upfront')) {
        return eventData.CANCELLATION_TEXT_ULTIMATE_APU || '';
      } else if (currentRatePlanVal.includes('annual')) {
        const renewalDate = eventData.RENEWAL_DATE || '';
        let cancelText = eventData.CANCELLATION_TEXT_STANDARD_APM || `Your Annual (pay over time) plan will renew automatically on ${renewalDate}. Manage or cancel your annual renewal anytime in My Account. 12-month minimum term`;
        cancelText = cancelText.replace(/\{\{RENEWAL_DATE\}\}/g, renewalDate)
          .replace(/\{\{CURRENCY\}\}/g, eventData.CURRENCY || '')
          .replace(/\{\{MONTHLY_PRICE\}\}/g, eventData.MONTHLY_PRICE || '');
        return cancelText;
      }
    }
    if (field === 'annual savings badge' || field === 'save badge') {
      return eventData.ANNUAL_SAVINGS_BADGE || 'N/A';
    }
  }

  // ── Non-1-month-free offer handling (7_day_trial, no_offer, etc.) ──
  // When OFFER_TYPE is not 1_month_free, the DAZN Plan page should not show
  // 1-month-free promotional expectations (badge, features, price text).
  const currentOfferType = (eventData.OFFER_TYPE || '1_month_free').toLowerCase();
  const currentRatePlan = (eventData.RATE_PLAN || '').replace(/-/g, ' ').toLowerCase();
  const currentTier = (eventData.TIER || '').toLowerCase();
  const isNonFreeMonthOffer = currentOfferType !== '1_month_free';
  const isAnnualFreeMonth = (eventData.ANNUAL_FREE_BADGE || eventData.ANNUAL_BADGE || '').toLowerCase().includes('1 month free') || (eventData.ANNUAL_FREE_BADGE || eventData.ANNUAL_BADGE || '').toLowerCase().includes('1 month');

  if (
    field === 'flex future date' &&
    isPlanPage
  ) {
    const isMonthlyTrial =
      /^\d+_day_trial$/.test(currentOfferType) &&
      (currentRatePlan === 'monthly' || currentRatePlan === '' || currentRatePlan.includes('flex'));

    if (!isMonthlyTrial) {
      return 'N/A| |';
    }
  }

  if (isNonFreeMonthOffer && !isSubscriptionOnly) {
    // DAZN Plan page: no "1 MONTH FREE" badge, no promotional features/price text
    if (isPlanPage) {
      if (field === 'annual badge') {
        return isAnnualFreeMonth ? replacePlaceholders(eventData.ANNUAL_FREE_BADGE || eventData.ANNUAL_BADGE || '', eventData) : 'N/A| |';
      }
      if (field === 'annual price text') {
        if (isAnnualFreeMonth) {
          return replacePlaceholders(eventData.ANNUAL_PRICE_TEXT || '', eventData);
        }
        const annualPrice = withCurrency(eventData.ANNUAL_PRICE, eventData.CURRENCY);
        return annualPrice ? `${annualPrice}/month for 12 months` : 'N/A| |';
      }
      if (
        field === 'annual feature 1' ||
        field === 'annual feature 2' ||
        field === 'annual feature 3'
      ) {
        if (isAnnualFreeMonth) {
          const featKey = field.toUpperCase().replace(/\s+/g, '_');
          return replacePlaceholders(eventData[featKey] || '', eventData);
        }
        return 'N/A| |';
      }
      if (field === 'annual savings badge') {
        return replacePlaceholders(eventData.ANNUAL_SAVINGS_BADGE || 'N/A', eventData);
      }
    }

    // Payment page overrides for non-1-month-free offers
    if (isPaymentPage || isUnspecifiedPage) {
      // Payment page header for an N-day trial (monthly only — APM/APU always shows 'Choose how to pay')
      if (/^\d+_day_trial$/.test(currentOfferType) && !currentRatePlan.includes('annual') && (field === 'header' || field === 'payment page title')) {
        return eventData.PAYMENT_PAGE_TITLE || eventData.PAYMENT_PAGE_TITLE_TRIAL || 'Choose how to pay after your free trial';
      }
      if (field === 'rate plan original price' || field === 'rate plan discounted price') {
        return 'N/A| |';
      }
      if (field === 'today you pay price' || field === 'today price' || (field.includes('today you pay') && !field.includes('text'))) {
        return isPpvPaymentPage ? ppvPaymentPrice : (eventData.TODAY_YOU_PAY_PRICE || '');
      }
      if (currentRatePlan.includes('annual')) {
        if (field === 'cancellation text' || field === 'cancel text') {
          if (currentTier === 'ultimate' && currentRatePlan.includes('annual pay monthly')) {
            return eventData.CANCELLATION_TEXT_ULTIMATE_APM || '';
          }
          if (currentTier === 'ultimate' && currentRatePlan.includes('annual pay upfront')) {
            return eventData.CANCELLATION_TEXT_ULTIMATE_APU || '';
          }
          // Standard APM with no 1-month-free: use region-specific standard APM text
          const renewalDate = eventData.RENEWAL_DATE || '';
          let cancelText = eventData.CANCELLATION_TEXT_STANDARD_APM || eventData.CANCELLATION_TEXT_APM_NO_FREE || '';
          if (!cancelText) {
            cancelText = `Your Annual (pay over time) plan will renew automatically on ${renewalDate}. Manage or cancel your annual renewal anytime in My Account. 12-month minimum term`;
          }
          cancelText = cancelText.replace(/\{\{CURRENCY\}\}/g, eventData.CURRENCY || '')
            .replace(/\{\{MONTHLY_PRICE\}\}/g, eventData.MONTHLY_PRICE || '')
            .replace(/\{\{ANNUAL_PRICE\}\}/g, eventData.ANNUAL_PRICE || '')
            .replace(/\{\{ANNUAL_TOTAL\}\}/g, eventData.ANNUAL_TOTAL || '')
            .replace(/\{\{RENEWAL_DATE\}\}/g, renewalDate);
          return cancelText;
        }
      }
    }
  }

  // ── Monthly flex with no offer at all (no_offer / none) ──
  // For PPVs/regions with no N-day trial and no 1-month-free
  const isNoOffer = currentOfferType === 'no_offer' || currentOfferType === 'none';
  const isMonthlyNoOffer = isNoOffer && (currentRatePlan === 'monthly' || currentRatePlan === '');

  if (isMonthlyNoOffer && !isSubscriptionOnly) {
    // DAZN Plan page: no trial badge, no trial description
    if (isPlanPage) {
      if (field === 'flex badge') {
        return 'N/A| |';
      }
      if (field === 'flex description') {
        return eventData.PLAN_DETAILS_FLEX_DESC || 'Billed monthly. Cancel anytime.|N/A| |';
      }
      if (field === 'flex today text' || field === 'flex future text') {
        return 'N/A| |';
      }
      // Annual fields: no 1 MONTH FREE badge either
      if (field === 'annual badge') {
        return 'N/A| |';
      }
      if (field === 'annual price text') {
        const annualPrice = withCurrency(eventData.ANNUAL_PRICE, eventData.CURRENCY);
        return annualPrice ? `${annualPrice}/month for 12 months` : 'N/A| |';
      }
      if (
        field === 'annual feature 1' ||
        field === 'annual feature 2' ||
        field === 'annual feature 3'
      ) {
        return 'N/A| |';
      }
    }

    // Payment page: no free pricing
    if (isPaymentPage || isUnspecifiedPage) {
      if (field === 'first month free price' || field === 'first month free text') {
        return 'N/A| |';
      }
      if (field === 'today you pay price' || field === 'today price' || (field.includes('today you pay') && !field.includes('text'))) {
        return isPpvPaymentPage ? ppvPaymentPrice : (eventData.TODAY_YOU_PAY_PRICE || '');
      }
      if (field === 'cancellation text' || field === 'cancel text') {
        return eventData.CANCELLATION_TEXT || "Monthly subscription. Cancel with 30 days' notice. Your subscription auto-renews unless you cancel.";
      }
    }
  }

  // ── PPV_POPUP_DATE: dedicated field for popup modal date chip ───────────────
  // Resolves {{PPV_POPUP_DATE}} → eventData.PPV_POPUP_DATE (set per event/region)
  if (raw && typeof raw === 'string' && raw.includes('PPV_POPUP_DATE')) {
    const popupDate = eventData.PPV_POPUP_DATE || '';
    if (popupDate) raw = popupDate;
  }

  // ── popup - event date: use PPV_POPUP_DATE for all sources ────────────────────
  // Some sources (e.g. home-biggest-fights) have {{PPV_DATE}} in the Excel template
  // but the popup card shows PPV_POPUP_DATE format (e.g. "25 JUL 4:00PM"). Convert
  // explicit dates to relative candidates when the modal renders a same-day badge.
  if (field === 'popup - event date' && eventData.PPV_POPUP_DATE) {
    const popupDate = String(eventData.PPV_POPUP_DATE);
    return hasExplicitDateAndTime(popupDate) ? getDynamicDateTimeBadge(popupDate) : popupDate;
  }


  if (field === 'popup date') {
    const pDate = eventData.PPV_DATE || '';
    const lpDate = eventData.LANDING_PAGE_PPV_DATE || '';
    if (pDate && lpDate) {
      raw = `${pDate}|${lpDate}`;
    }
  }

  // Popup descriptions are content-managed in PPV_Input.xlsx. Do not replace
  // the spreadsheet expectation with JSON or user-state-specific copy.

  if (raw !== undefined && raw !== null) {
    const currentRatePlan = (eventData.RATE_PLAN || eventData.ratePlan || '').trim().toLowerCase();
    const currentSource = (eventData.SOURCE || eventData.source || '').trim().toLowerCase();

    if (field === 'header' || field === 'page header') {
      if (isPaymentPage) {
        raw = eventData.PAYMENT_PAGE_TITLE || eventData.PAYMENT_PAGE_TITLE_STANDARD || 'Choose how to pay';
      } else if (eventData.PAYMENT_HEADER) {
        raw = eventData.PAYMENT_HEADER;
      } else if (raw && typeof raw === 'string') {
        raw = raw + '|N/A';
      }
    }

    if (field === 'annual pay upfront save badge' || field === 'save badge') {
      const upfrontSaveDisplay = eventData.UPFRONT_SAVE_AMOUNT_DISPLAY || eventData.UPFRONT_SAVE_AMOUNT;
      // The APU saving is a price comparison, not a promotional offer. Validate
      // it whenever the configured monthly and upfront prices yield a saving.
      if (upfrontSaveDisplay === 'N/A' || !upfrontSaveDisplay || parseFloat(upfrontSaveDisplay.replace(/[^\d.-]/g, '')) <= 0) {
        raw = 'N/A';
      }
    }
    const currentTier = (eventData.TIER || '').trim().toLowerCase();
    const isDefaultSignup =
      process.env.DEFAULT_SIGNUP === 'true' ||
      currentSource === 'home-page-get-started' ||
      currentSource === 'home-page-dazntile' ||
      currentSource === 'boxing-ultimate-subscription' ||
      currentSource === 'boxing-standard-subscription' ||
      currentSource === 'boxing-join-the-club' ||
      currentSource === 'boxing-banner-ultimate';

    if (field === 'upsell offer text' && (!eventData.UPSELL_PRICE || eventData.UPSELL_PRICE.trim() === '' || eventData.UPSELL_PRICE.trim().toUpperCase() === 'N/A')) {
      raw = 'N/A';
    } else if (field === 'annual pay monthly contract text' && (!eventData.UPSELL_PRICE || eventData.UPSELL_PRICE.trim() === '' || eventData.UPSELL_PRICE.trim().toUpperCase() === 'N/A')) {
      raw = 'Annual contract. Auto renews.';
    } else if (field === 'ppv name' && isDefaultSignup && (!hasPPVEvent || currentTier === 'ultimate')) {
      raw = 'N/A';
    } else if (field === 'ppv price' && isDefaultSignup && (!hasPPVEvent || currentTier === 'ultimate')) {
      raw = 'N/A';
    } else if (field === 'ultimate feature 1' || field === 'ultimate feature 2' || field === 'ultimate feature 3') {
      if (
        currentSource !== 'boxing-ultimate' &&
        currentSource !== 'boxing-banner-ultimate' &&
        currentSource !== 'boxing-ultimate-subscription' &&
        currentSource !== 'boxing-join-the-club'
      ) {
        raw = 'N/A';
      }
    } else if (field === 'next payment label') {
      if (ratePlan.includes('annual pay monthly')) {
        raw = 'Next payment on {{NEXT_PAYMENT_DATE}}';
      } else if (ratePlan.includes('annual pay upfront')) {
        raw = 'Next Annual payment on {{NEXT_PAYMENT_DATE}}';
      }
    } else if (field === 'next payment price') {
      if (ratePlan.includes('annual pay monthly')) {
        raw = '{{ANNUAL_PAY_MONTHLY_PRICE}}';
      } else if (ratePlan.includes('annual pay upfront')) {
        raw = '{{ANNUAL_UPFRONT_PRICE}}';
      }
    } else if (field === 'cancellation text' && tier === 'ultimate') {
      if (ratePlan.includes('annual pay monthly')) {
        raw = '{{CANCELLATION_TEXT_ULTIMATE_APM}}';
      } else if (ratePlan.includes('annual pay upfront')) {
        raw = '{{CANCELLATION_TEXT_ULTIMATE_APU}}';
      }
    } else if (field === 'cta button' && (rule.Flow === 'boxing-bundle-ppv' || rule.flow === 'boxing-bundle-ppv')) {
      const currentTier = (eventData.TIER || eventData.tier || '').trim().toLowerCase();
      if (currentTier === 'ultimate') {
        raw = 'Continue with DAZN Ultimate|Continue with pay-per-view';
      } else {
        raw = 'Continue with pay-per-view';
      }
    } else if (field === 'offer original price' || field === 'offer price original') {
      const offerAvailable = String(eventData.OFFER_AVAILABLE || 'false').toLowerCase() === 'true';
      if (!offerAvailable) {
        raw = 'N/A';
      } else if (raw && raw.includes('{{')) {
        const resolved = raw.replace(/\{\{(.*?)\}\}/g, (match: string, k: string) => {
          const val = eventData[k] || eventData[k.toUpperCase()] || eventData[k.toLowerCase()] || eventData[k.replace(/\s+/g, '_').toUpperCase()] || eventData[k.replace(/\s+/g, '_')];
          return val !== undefined ? String(val) : `{{${k}}}`;
        });
        raw = resolved;
      }
    } else if (field === 'offer discount' || field === 'offer discount amount' || field === 'offer save amount') {
      const offerAvailable = String(eventData.OFFER_AVAILABLE || 'false').toLowerCase() === 'true';
      if (!offerAvailable) {
        raw = 'N/A';
      } else if (raw && raw.includes('{{')) {
        const discountNum = parseFloat(String(eventData.OFFER_DISCOUNT_AMOUNT || '').replace(/[^0-9.]/g, ''));
        const discountText = !isNaN(discountNum) && discountNum > 0 ? `Save ${discountNum.toFixed(0)}%` : 'N/A';
        raw = raw.replace(/\{\{OFFER_DISCOUNT_AMOUNT\}\}/g, discountText).replace(/\{\{(.*?)\}\}/g, (match: string, k: string) => {
          const val = eventData[k] || eventData[k.toUpperCase()] || eventData[k.toLowerCase()] || eventData[k.replace(/\s+/g, '_').toUpperCase()] || eventData[k.replace(/\s+/g, '_')];
          return val !== undefined ? String(val) : `{{${k}}}`;
        });
      }
    } else if (field === 'offer badge' || field === 'offer description') {
      const offerAvailable = String(eventData.OFFER_AVAILABLE || 'false').toLowerCase() === 'true';
      if (!offerAvailable) {
        raw = 'N/A';
      } else if (raw && raw.includes('{{')) {
        const offerBadge = String(eventData.OFFER_BADGE || '');
        const offerDesc = String(eventData.OFFER_DESCRIPTION || '');
        if (field === 'offer badge') {
          raw = raw.replace(/\{\{OFFER_BADGE\}\}/g, offerBadge || 'N/A').replace(/\{\{(.*?)\}\}/g, (match: string, k: string) => {
            const val = eventData[k] || eventData[k.toUpperCase()] || eventData[k.toLowerCase()] || eventData[k.replace(/\s+/g, '_').toUpperCase()] || eventData[k.replace(/\s+/g, '_')];
            return val !== undefined ? String(val) : `{{${k}}}`;
          });
        } else {
          raw = raw.replace(/\{\{OFFER_DESCRIPTION\}\}/g, offerDesc || 'N/A').replace(/\{\{(.*?)\}\}/g, (match: string, k: string) => {
            const val = eventData[k] || eventData[k.toUpperCase()] || eventData[k.toLowerCase()] || eventData[k.replace(/\s+/g, '_').toUpperCase()] || eventData[k.replace(/\s+/g, '_')];
            return val !== undefined ? String(val) : `{{${k}}}`;
          });
        }
      }
    } else if (field === 'today you pay price' || field === 'today price' || (field.includes('today you pay') && !field.includes('text'))) {
      if (eventData.TODAY_YOU_PAY_PRICE) {
        raw = isPpvPaymentPage ? ppvPaymentPrice : eventData.TODAY_YOU_PAY_PRICE;
      } else {
        const offerAvailable = String(eventData.OFFER_AVAILABLE || 'false').toLowerCase() === 'true';
        if (offerAvailable && (eventData.OFFER_EFFECTIVE_PPV_PRICE || eventData.UPSELL_PRICE)) {
          raw = eventData.OFFER_EFFECTIVE_PPV_PRICE || eventData.UPSELL_PRICE || raw;
        }
      }
    }
  }

  const activeOfferPresent = String(eventData.ACTIVE_OFFER_PRESENT || 'false').toLowerCase() === 'true';
  const offerType = eventData.ACTIVE_OFFER_TYPE || 'default';

  if (activeOfferPresent) {
    if (field === 'ppv price' && offerType === 'ppv_only_offer') {
      return eventData.OFFER_EFFECTIVE_PPV_PRICE || '';
    }
    if (field === 'offer original price' || field === 'offer price original' || field === 'original price' || field === 'was price') {
      if (offerType === 'ppv_only_offer') return eventData.OFFER_ORIGINAL_PPV_PRICE || '';
      return eventData.RATE_PLAN_ORIGINAL_PRICE || 'N/A';
    }
    if (field === 'offer discount' || field === 'offer discount amount' || field === 'offer save amount' || field === 'discount badge') {
      if (offerType === 'ppv_only_offer') return eventData.OFFER_DISCOUNT_AMOUNT || '';
      return eventData.DISCOUNT_BADGE || 'N/A';
    }
    if (field === 'offer badge' || field === 'flex badge') {
      if (offerType === 'ppv_only_offer') return eventData.OFFER_BADGE || '';
      return 'N/A';
    }
    if (field === 'offer description' || field === 'flex description' || field === 'ppv card description') {
      if (offerType === 'ppv_only_offer') {
        if (field === 'flex description') return 'N/A';
        return eventData.OFFER_DESCRIPTION || '';
      }
      return eventData.OFFER_DESCRIPTION || '';
    }
    if (field === 'cancellation text' || field === 'cancel text') {
      let cancelTemplate = eventData.CANCELLATION_TEXT || '';
      for (let pass = 0; pass < 2; pass++) {
        cancelTemplate = cancelTemplate.replace(/\{\{(.*?)\}\}/g, (match, key) => {
          const k = key.trim();
          const val = eventData[k] ?? eventData[k.toUpperCase()] ?? eventData[k.toLowerCase()] ?? eventData[k.replace(/\s+/g, '_').toUpperCase()] ?? eventData[k.replace(/\s+/g, '_')];
          return val !== undefined ? String(val) : match;
        });
        if (!cancelTemplate.includes('{{')) break;
      }
      return cancelTemplate;
    }
    if (field === 'today you pay price' || field === 'today price' || (field.includes('today you pay') && !field.includes('text'))) {
      return isPpvPaymentPage ? ppvPaymentPrice : (eventData.TODAY_YOU_PAY_PRICE || '');
    }
    if (field === 'plan name' || field === 'plan label') {
      return eventData.PAYMENT_PLAN_LABEL || eventData.PLAN_LABEL || '';
    }
    if (field === 'flex today text' || field === 'flex future text' || field === 'first month free price' || field === 'first month free text') {
      return offerType === 'ppv_only_offer' ? 'N/A' : '';
    }
    if (field === 'bundle price' && offerType === 'bundle_offer') {
      return eventData.BUNDLE_PRICE || '';
    }
    if (field === 'bundle original price' && offerType === 'bundle_offer') {
      return eventData.BUNDLE_ORIGINAL_PRICE || '';
    }
    if (field === 'bundle save badge' && offerType === 'bundle_offer') {
      return eventData.BUNDLE_SAVE_BADGE || '';
    }
    if (field === 'bundle discount' && offerType === 'bundle_offer') {
      return eventData.BUNDLE_DISCOUNT || '';
    }
    if (field === 'bundle description' && offerType === 'bundle_offer') {
      return eventData.OFFER_DESCRIPTION || '';
    }
  }

  if (field === 'ppv card description') {
    const isStag = (process.env.DAZN_ENV || 'stag').toLowerCase().includes('stag');
    if (isStag && process.env.DEFAULT_SIGNUP === 'true') {
      raw = eventData.DEFAULT_SIGNUP_PPV_DESCRIPTION || 'The fight, including one month of discounted DAZN Standard plan';
    }
  } else if (field === 'upsell section heading') {
    if (process.env.DEFAULT_SIGNUP === 'true' && !hasPPVEvent) {
      raw = 'N/A';
    }
  }

  if (raw === undefined || raw === null || raw === '') {
    return '';
  }

  let template = String(raw);

  // Run replacement twice to handle nested placeholders
  // e.g., {{CANCELLATION_TEXT}} → "...{{NEXT_PAYMENT_DATE}}..." → "...23/06/2026..."
  for (let pass = 0; pass < 2; pass++) {
    template = template.replace(/\{\{(.*?)\}\}/g, (match, key) => {
      const k = key.trim();

      // Override PPV_DATE specifically for landing/boxing/home pages
      // BUT NOT for banner fields — banners show the full PPV_DATE (e.g. 'Sat 27th Jun at 16:30')
      // AND NOT for home-page-popup — the auto-popup shows the full PPV_DATE in the badge
      const pageNameLower = pageName.toLowerCase();
      const isBannerField = field.startsWith('banner');
      const resolveSource = (eventData.SOURCE || eventData.source || '').trim().toLowerCase();
      const isHomePagePopup = resolveSource === 'home-page-popup';
      if (k.toUpperCase() === 'PPV_DATE' && !isBannerField && !isHomePagePopup && (pageNameLower === 'landing' || pageNameLower === 'boxing' || pageNameLower.includes('home') || pageNameLower.includes('popup'))) {
        if (eventData.LANDING_PAGE_PPV_DATE) {
          return String(eventData.LANDING_PAGE_PPV_DATE);
        }
      }

      let searchKey = k;
      if (searchKey.toUpperCase() === 'PPV_DATE' && (pageName.toLowerCase().includes('mobile') || pageName.toLowerCase().includes('paywall'))) {
        if (eventData.MOBILE_PPV_DATE) {
          searchKey = 'MOBILE_PPV_DATE';
        }
      }

      const value =
        eventData[searchKey] ??
        eventData[searchKey.toUpperCase()] ??
        eventData[searchKey.toLowerCase()] ??
        eventData[searchKey.replace(/\s+/g, '_').toUpperCase()] ??
        eventData[searchKey.replace(/\s+/g, '_')];

      if (value === undefined) {
        if (pass === 0) return match;
        console.warn(`⚠️  resolveExpected: no value for {{${k}}} — leaving as-is`);
        return match;
      }

      return String(value);
    });

    if (!template.includes('{{')) break;
  }

  if (field === 'cta button' || field === 'cta button text') {
    const trialDays = eventData.FREE_TRIAL_DAYS || '7';
    if (/^Continue with PPV \+ \d+-day free trial$/i.test(template.trim())) {
      template = `Continue with ${trialDays}-day Free Trial`;
    }
  } else if (field === 'cancellation text' || field === 'cancel text') {
    const currentTierVal = (eventData.TIER || '').toLowerCase();
    const currentRatePlanVal = (eventData.RATE_PLAN || '').replace(/-/g, ' ').toLowerCase();
    const offerTypeVal = (eventData.OFFER_TYPE || '').toLowerCase();

    if (currentTierVal === 'ultimate' && currentRatePlanVal.includes('annual pay monthly')) {
      // Ultimate Annual Pay Monthly
      template = eventData.CANCELLATION_TEXT_ULTIMATE_APM || '';
    } else if (currentTierVal === 'ultimate' && currentRatePlanVal.includes('annual pay upfront')) {
      // Ultimate Annual Pay Upfront
      template = eventData.CANCELLATION_TEXT_ULTIMATE_APU || '';
    } else if (currentRatePlanVal.includes('annual')) {
      // Standard Annual — if we have a 1-month free offer, prefer offer-specific CANCELLATION_TEXT_ANNUAL
      if (offerTypeVal === '1_month_free') {
        template = eventData.CANCELLATION_TEXT_ANNUAL || eventData.CANCELLATION_TEXT_STANDARD_APM || '';
      } else {
        template = eventData.CANCELLATION_TEXT_STANDARD_APM || eventData.CANCELLATION_TEXT_ANNUAL || '';
      }
    } else if (/^\d+_day_trial$/.test(offerTypeVal)) {
      // N-day trial (monthly flex)
      const trialDays = eventData.FREE_TRIAL_DAYS || '7';
      template = eventData.CANCELLATION_TEXT_TRIAL || `In ${trialDays} days, you'll be charged {{CURRENCY}}{{MONTHLY_PRICE}}/month. Cancel anytime before the end of the trial.`;
    } else if (offerTypeVal === '1_month_free') {
      // 1 month free (non-trial regions or monthly flex with 1-month offer)
      template = eventData.CANCELLATION_TEXT || eventData.CANCELLATION_TEXT_TRIAL || '';
    } else {
      // Default monthly — use pre-set CANCELLATION_TEXT if available
      template = eventData.CANCELLATION_TEXT || "Monthly subscription. Cancel with 30 days' notice. Your subscription auto-renews unless you cancel.";
    }

    // Resolve any remaining template placeholders
    template = template.replace(/\{\{CURRENCY\}\}/g, eventData.CURRENCY || '')
      .replace(/\{\{MONTHLY_PRICE\}\}/g, eventData.MONTHLY_PRICE || '')
      .replace(/\{\{ANNUAL_PRICE\}\}/g, eventData.ANNUAL_PRICE || '')
      .replace(/\{\{ANNUAL_TOTAL\}\}/g, eventData.ANNUAL_TOTAL || '')
      .replace(/\{\{RENEWAL_DATE\}\}/g, eventData.RENEWAL_DATE || '');
  }

  // Clean up any duplicate currency symbols (e.g., $$ or ££ or "SAR SAR")
  const currencySymbol = eventData.CURRENCY || '';
  if (currencySymbol) {
    // Adjacent duplicate: SARSAR → SAR, $$ → $
    const doubleCurrency = `${currencySymbol}${currencySymbol}`;
    while (template.includes(doubleCurrency)) {
      template = template.replace(doubleCurrency, currencySymbol);
    }
    // Space-separated duplicate for multi-letter codes: "SAR SAR" → "SAR", "AED AED" → "AED"
    if (currencySymbol.length > 1) {
      const doubleCurrencySpaced = `${currencySymbol} ${currencySymbol}`;
      while (template.includes(doubleCurrencySpaced)) {
        template = template.replace(doubleCurrencySpaced, currencySymbol);
      }
    }
  }
  if (currencySymbol.toLowerCase() === 'kr') {
    template = template.replace(/\bkr((?:\d(?:\d|[^\S\r\n])*\d|\d)(?:,\d{1,2})?)[^\S\r\n]*kr\b/gi, '$1 kr');
    template = template.replace(/\bkr(\d[\d\s]*(?:,\d{1,2})?)/gi, '$1 kr');
  }

  // Date-only fields — use getDynamicDateBadge (generates candidates with and without time)
  const dateOnlyFields = [
    'ppv date badge',
    'date badge',
    'banner date badge',
    'upsell date badge',
    'tile date badge',
    'ppv date',
    'popup date',
    'welcome tile date',
    'event date',
    'fury payment date',
    'landing page ppv date',
    'ppv1 upsell tile date',
    'ppv2 upsell tile date',
  ];
  if (dateOnlyFields.includes(field)) {
    // Some spreadsheets use a date-labelled field for a chip that contains a
    // full event date and time.  Treat the value, not the field name, as the
    // source of truth so every surface receives relative-date candidates.
    if (hasExplicitDateAndTime(template)) {
      return getDynamicDateTimeBadge(template);
    }
    if (pageName.toLowerCase().includes('mobile') || pageName.toLowerCase().includes('paywall')) {
      return template;
    }
    // My Account shows the full date+time (e.g. "Sat 29th Aug at 17:00") — do not
    // strip it down to date-only candidates; use the date+time badge instead.
    // Prepend the raw value so the report displays the full expected format first.
    if (field === 'ppv date' && pageName.toLowerCase().includes('my account')) {
      const candidates = getDynamicDateTimeBadge(template);
      return candidates ? `${template}|${candidates}` : template;
    }
    return getDynamicDateBadge(template);
  }

  // Date+Time fields — use getDynamicDateTimeBadge (only generates candidates WITH time)
  const dateTimeFields = [
    'ppv date and time',
    'ppv date and time expected',
    'ppv date and time text',
    'included ppv date and time',
    'ppv1 date and time text on bundle',
    'event date and time',
  ];
  if (dateTimeFields.includes(field)) {
    return hasExplicitDateAndTime(template) ? getDynamicDateTimeBadge(template) : template;
  }

  // WATCH LIVE fields (e.g. search, home-boxing-upcoming cards)
  if (/watch live/i.test(template)) {
    const match = template.match(/(watch live\s*)/i);
    const prefix = match ? match[1] : 'WATCH LIVE ';

    let dynamicCandidates = '';
    try {
      const { calculateDynamicPpvBannerDate } = require('./dateUtils');
      if (calculateDynamicPpvBannerDate && eventData && Object.keys(eventData).length > 0) {
        dynamicCandidates = calculateDynamicPpvBannerDate(eventData);
      }
    } catch {}

    if (!dynamicCandidates) {
      const datePart = template.replace(/watch live\s*/i, '').trim();
      if (datePart && hasExplicitDateAndTime(datePart)) {
        dynamicCandidates = getDynamicDateTimeBadge(datePart);
      }
    }

    if (dynamicCandidates) {
      const candidatesList = dynamicCandidates.split('|');
      const prefixed = candidatesList.map(c => `${prefix}${c}`);
      prefixed.push(template);
      return Array.from(new Set(prefixed)).join('|');
    }
  }

  // Standard relative date sources (for example, "Tomorrow at 16:00")
  const relativeDateSource = /\{\{\s*(?:PPV_DATE|PPV_PAGE_DATE|LANDING_BANNER_DATE)\s*\}\}/i.test(rawExpectation) ||
    field === 'banner - event date' ||
    field === 'ppv date and time text';
  if (relativeDateSource && hasExplicitDateAndTime(template)) {
    if (normalizedPageName === 'choose how to buy') return template;
    return getDynamicDateTimeBadge(template);
  }

  if (/^upsell feature [1-4]$/.test(field) && template.includes('185+ fights') && template.includes('promoters')) {
    template = `${template}|${template.replace(/promoters/g, 'promotors')}`;
  }

  return template;
}
