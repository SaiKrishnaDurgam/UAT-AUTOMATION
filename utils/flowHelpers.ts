import { Page } from '@playwright/test';

export function isConfiguredPpvAbsenceError(error: unknown, ppvName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const ppvWords = ppvName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
  const normalizedMessage = message.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  return ppvWords.some(word => normalizedMessage.includes(word)) &&
    /\b(?:absent|missing|not configured|not found|could not find|no matching|no competition tile found)\b/i.test(message);
}

export async function isConfiguredPpvVisible(page: Page, ppvName: string): Promise<boolean> {
  const ppvWords = ppvName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);

  if (ppvWords.length === 0) {
    throw new Error('Cannot check PPV removal without a configured PPV name.');
  }

  const includesPpv = (value: string): boolean => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    return ppvWords.every(word => normalized.includes(word));
  };

  const bodyText = await page.locator('body').innerText({ timeout: 5000 });
  if (includesPpv(bodyText)) return true;

  const accessibleText = await page.locator('[alt], [aria-label], [title]').evaluateAll(elements =>
    elements
      .filter((element: Element) => {
        const htmlElement = element as HTMLElement;
        return htmlElement.offsetWidth > 0 && htmlElement.offsetHeight > 0;
      })
      .map(element => [
        element.getAttribute('alt'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).join(' '))
  );

  return accessibleText.some(includesPpv);
}

// ═══════════════════════════════════════════════════════════════
// PAGE TYPE DETECTION (fixed for plan loop)
// ═══════════════════════════════════════════════════════════════
export async function detectPageType(
  p: any,
  pc: Record<string, { detection: string }>,
  planClickCount: number,
  isStandalonePPV: boolean = false
): Promise<'ppv' | 'plan' | 'email' | 'payment' | 'phone' | 'otp' | 'unknown' | 'standalone-ppv' | 'success-upsell' | 'saved-card-payment' | 'bet-upsell' | 'default-signup' | 'choose-how-to-buy' | 'confirmation' | 'myaccount-ppv' | 'welcome'> {
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
      }, { timeout: 8000 }).catch(() => {});
    } catch {}
  }

  // ── Body text detection FIRST for highly specific pages (OTP & Phone) ──
  // This prevents URL-based false positives when SPA navigation updates UI before URL changes
  const body = await p.locator('body')
    .innerText({ timeout: 2000 })
    .then((t: string) => t.toLowerCase())
    .catch(() => '');

  // ── Post-payment pages (must check BEFORE OTP/phone to avoid false positives) ──

  // DAZN Bet / promotional upsell (second success page)
  // Generic: "payment was successful" + bet/promo indicators
  if (body.includes('payment was successful') &&
      (body.includes('dazn bet') || body.includes('free bet') || body.includes('activate betting'))) {
    return 'bet-upsell';
  }

  // PPV upsell success page (first success page after initial payment)
  // Generic: "payment was successful" + upsell buy CTA or dismiss link
  if (body.includes('payment was successful') &&
      (body.includes('buy now for') || body.includes('no thanks'))) {
    return 'success-upsell';
  }

  // Saved card payment page (upsell PPV purchase with card on file)
  // Generic: "one time payment" + any saved card brand/pattern
  if (body.includes('one time payment') &&
      (body.includes('visa') || body.includes('mastercard') || body.includes('amex') ||
       body.includes('****') || body.includes('saved card'))) {
    return 'saved-card-payment';
  }

  // OTP verification page
  if (body.includes('enter the code below') || body.includes('4-digit code') || body.includes('resend code') || body.includes('verify your phone') || body.includes('enter your code')) {
    return 'otp';
  }

  // Phone number page
  if (body.includes('add your phone number')) {
    return 'phone';
  }

  // ── URL-based detection ──────────────
  const url = p.url();
  const urlLower = url.toLowerCase();

  if (urlLower.includes('/welcome')) return 'welcome';

  // My Account PPV page — ultimate users auto-redirected here after login.
  // After login, the URL may STILL show page=emailDetails (DAZN SPA doesn't change it)
  // but the page TITLE changes to "My Account" / "Account" / "PPV" etc.
  // → Use page title as the primary signal when URL has /myaccount.
  const isMyAccountUrl =
    urlLower.includes('/myaccount') ||
    urlLower.endsWith('/account') ||
    urlLower.endsWith('/account/') ||
    urlLower.includes('/account?');

  if (isMyAccountUrl) {
    const pageTitle = await p.title().catch(() => '');
    const titleLower = pageTitle.toLowerCase();
    console.log(`  [detectPageType] /myaccount URL — title: "${pageTitle}"`);

    // If title contains login/signup keywords, we're still on the sign-in step
    const isStillLoginPage =
      titleLower.includes('sign in') ||
      titleLower.includes('sign up') ||
      titleLower.includes('log in') ||
      titleLower.includes('create account') ||
      titleLower.includes('email');

    if (!isStillLoginPage) {
      // Title no longer shows sign-in content — we're on the real My Account page
      return 'myaccount-ppv';
    }
    // Still on login step within /myaccount URL — fall through to email detection
  }


  // Phone/OTP pages (highest priority URL checks)
  if (urlLower.includes('phonenumbercollection')) return 'phone';
  if (urlLower.includes('phoneverification') || urlLower.includes('otpverification')) return 'otp';

  // Upgrade confirmation page (after clicking Upgrade to Ultimate)
  if (urlLower.includes('upgradeplan')) return 'confirmation';
  if (urlLower.includes('upgradetier') && !urlLower.includes('isupgradetierflow')) return 'confirmation';

  // Choose How To Buy page (active existing user addon purchase)
  if (urlLower.includes('/addon/purchase')) {
    if (urlLower.includes('redirecturl=') || urlLower.includes('/auth/login') || urlLower.includes('/login')) {
      // Don't detect as choose-how-to-buy. Let it fall through to email / login check.
    } else if (
      urlLower.includes('/payment') ||
      urlLower.includes('/checkout') ||
      urlLower.includes('/pay') ||
      urlLower.includes('paymentdetails') ||
      body.includes('today you pay') ||
      body.includes('pay now') ||
      body.includes('payment method')
    ) {
      return 'saved-card-payment';
    } else {
      return 'choose-how-to-buy';
    }
  }

  // Payment page
  if (
    urlLower.includes('paymentdetails') ||
    urlLower.includes('page=payment') ||
    urlLower.includes('/addon/purchase/payment') ||
    urlLower.includes('/addon/purchase/checkout') ||
    urlLower.includes('/addon/purchase/pay')
  ) {
    const userState = (process.env.USER_STATE || '').toLowerCase().trim();
    if (userState.startsWith('active_')) {
      return 'saved-card-payment';
    }
    return 'payment';
  }

  // Body-text payment detection — SPA can render payment UI before URL updates.
  // Must check BEFORE email/plan URL fallbacks to avoid false 'email' detection.
  if (
    body.includes('payment method') ||
    body.includes('choose how to pay') ||
    body.includes('today you pay')
  ) {
    console.log('  [detectPageType] Payment page detected via body text (SPA URL may lag)');
    return 'payment';
  }

  // Personal details / Email page — MUST be before upsellTierSelected check
  if (urlLower.includes('page=personaldetails')) return 'email';
  if (urlLower.includes('emaildetails')) return 'email';

  // Plan page detection with planClickCount guard
  if (urlLower.includes('upselltierselected=true')) {
    if (planClickCount >= 1) return 'email';
    return 'plan';
  }

  // ── Default Signup page detection (must check BEFORE general PPV) ──
  // The Default Signup page has the same URL pattern (upsellTierShown=true)
  // as the normal PPV page, but uniquely contains "subscribe without a pay-per-view".
  // Normal PPV page only has "Continue with pay-per-view".
  if (
    process.env.DEFAULT_SIGNUP === 'true' &&
    urlLower.includes('upselltiershown=true') &&
    body.includes('subscribe without a pay-per-view')
  ) {
    return 'default-signup';
  }

  if (urlLower.includes('upselltiershown=true')) return 'ppv';
  if (urlLower.includes('upselltierskipped=true')) return 'plan';
  
  // Standalone/Glory PPV page detection (must be before general page=PlanDetails check)
  // Relies on structural indicators (checkbox/toggle) rather than event-name keywords
  // which could appear on ANY page (e.g., "GLORY Collision 9" in headers/breadcrumbs).
  if (isStandalonePPV && urlLower.includes('page=plandetails') && (
    urlLower.includes('standalone') ||
    body.toLowerCase().includes('standalone') ||
    (body.includes('choose your subscription') &&
      /flex\s*[–-]?\s*pay monthly/i.test(body) &&
      /annual\s*[–-]?\s*pay monthly/i.test(body))
  )) {
    return 'standalone-ppv';
  }

  // page=PlanDetails can appear before the SPA appends upsellTierShown=true.
  // If contextual PPV-only copy is already rendered, this is still the PPV
  // selection page and must not be validated as a DAZN Plan page.
  if (
    (urlLower.includes('contextualppvid=') || urlLower.includes('externalpurchaseid=')) &&
    (urlLower.includes('page=plandetails') || urlLower.includes('page=tierplans')) &&
    !urlLower.includes('upselltierselected=true') &&
    (
      body.includes('continue with pay-per-view') ||
      body.includes('just the fight') ||
      body.includes('to watch your pay-per-view') ||
      body.includes('the ultimate fan package')
    )
  ) {
    return 'ppv';
  }

  if (urlLower.includes('page=plandetails')) return 'plan';
  if (urlLower.includes('page=tierplans')) return 'plan';

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

  // ── Rest of fallbacks ─────────────────────────
  // Email/signup page
  if (urlLower.includes('/signup') && !urlLower.includes('plandetails')) return 'email';

  try {
    const emailCount = await p.locator('input[type="email"]').count();
    if (emailCount > 0) return 'email';
  } catch {}

  try {
    const nameCount = await p.locator('[data-test-id="FIRST_NAME"], input[name="firstName"]').count();
    if (nameCount > 0) return 'email';
  } catch {}

  if (body.includes('first name') && body.includes('last name')) return 'email';

  // PPV page detection
  const ppvDetect = pc?.ppv?.detection?.toLowerCase() || '';
  if (ppvDetect && body.includes(ppvDetect)) return 'ppv';
  if (body.includes('subscribe without a pay-per-view')) return 'ppv';
  if (body.includes('choose your plan')) return 'ppv';
  if (body.includes('choose how to buy')) return 'ppv';

  // Standalone/Glory PPV page detection
  if (isStandalonePPV && body.includes("choose a plan that's right") && body.includes("choose your subscription")) {
    if (/flex\s*[–-]?\s*pay monthly/i.test(body) && /annual\s*[–-]?\s*pay monthly/i.test(body)) {
      return 'standalone-ppv';
    }
  }

  // Plan page detection (body text fallback)
  if (body.includes("choose a plan that's right")) return 'plan';
  if (body.includes('pick a plan to go with')) return 'plan';

  return 'unknown';
}

export const NO_PPV_SELECTORS = [
  'a:has-text("Subscribe without a pay-per-view")',
  'button:has-text("Subscribe without a pay-per-view")',
  'a:has-text("Subscribe without pay-per-view")',
  'a:has-text("Continue without pay-per-view")',
  'a:has-text("Continue without a pay-per-view")',
  '[class*="ctaWithoutPPV" i]',
];

export async function findNoPpvLink(
  page: any,
  timeout = 3000
): Promise<{ element: any; selector: string } | null> {
  for (const selector of NO_PPV_SELECTORS) {
    const element = page.locator(selector).first();
    if (await element.isVisible({ timeout }).catch(() => false)) {
      return { element, selector };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// HANDLE NO-PPV CLICK — for "Subscribe without a pay-per-view" flow
// Called when surfacingpoint.json has noPpvClick: true
// ─────────────────────────────────────────────────────────────────
export async function handleNoPpvClick(
  page: any,
  eventData: Record<string, any>
): Promise<void> {
  console.log('🔗 [handleNoPpvClick] Looking for "Subscribe without a pay-per-view" link...');

  const foundLink = await findNoPpvLink(page);

  if (!foundLink) {
    throw new Error(
      '❌ [handleNoPpvClick] "Subscribe without a pay-per-view" link not found on page'
    );
  }

  const noPpvLink = foundLink.element;
  console.log(`✅ [handleNoPpvClick] Found link via: ${foundLink.selector}`);
  const beforeUrl = page.url();
  const ctaText = await noPpvLink.innerText().catch(() => 'Subscribe without a pay-per-view');
  eventData.SUBSCRIBE_WITHOUT_PPV_CTA_TEXT = ctaText.trim();
  await noPpvLink.click({ force: true });
  console.log(`✅ [handleNoPpvClick] Clicked "${ctaText.trim()}"`);

  await page.waitForURL(
    (url: URL) =>
      url.toString().includes('noPpv=true') ||
      url.toString().includes('tierplans') ||
      url.toString().includes('plandetails') ||
      url.toString() !== beforeUrl,
    { timeout: 10000 }
  ).catch(() => {
    console.log(
      `⚠️ [handleNoPpvClick] URL did not change as expected. Current: ${page.url()}`
    );
  });

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  console.log(`✅ [handleNoPpvClick] Navigated to: ${page.url()}`);

  process.env.SUBSCRIBE_WITHOUT_PPV = 'true';
  eventData.SUBSCRIBE_WITHOUT_PPV = 'true';
}
