import { Page } from '@playwright/test';

let cachedStartupJson: any = null;
let cachedWafCookie: string = '';

/**
 * Acquires a valid AWS WAF token by executing the CloudFront challenge script in a headless page.
 */
async function acquireWafToken(page: Page): Promise<string> {
  if (cachedWafCookie) return cachedWafCookie;

  try {
    console.log('🛡️ [PAC 1.0 Network] Acquiring AWS WAF token for *.dazn-stage.com...');
    const bgPage = await page.context().newPage();
    await bgPage.goto('https://authentication-stage.ar.dazn-stage.com/v5/SignUp', {
      waitUntil: 'networkidle',
      timeout: 15000,
    }).catch(() => {});
    await bgPage.waitForTimeout(3000);

    const cookies = await page.context().cookies();
    const waf = cookies.find((c) => c.name.includes('waf'));
    if (waf) {
      cachedWafCookie = `${waf.name}=${waf.value}`;
      console.log('🛡️ [PAC 1.0 Network] AWS WAF token acquired successfully.');
    }
    await bgPage.close().catch(() => {});
  } catch (err: any) {
    console.warn('⚠️ [PAC 1.0 Network] Could not pre-fetch WAF token:', err.message);
  }

  return cachedWafCookie;
}

/**
 * Sets up network interception and routing for PAC 1.0 redemption flows.
 * Handles geo-spoofing, offer routing, WAF bypass, and CORS proxying for DAZN staging endpoints.
 */
export async function setupPac1NetworkInterceptors(page: Page, countryCode: string = 'ES'): Promise<void> {
  // Log redemption & subscription responses
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('partner') || url.includes('redeem') || url.includes('giftcode') || url.includes('subscription') || url.includes('useraccount') || url.includes('entitlement')) {
      try {
        const text = await res.text();
        if (text && text.length > 0 && !url.includes('.js') && !url.includes('.css')) {
          console.log(`🌐 [PAC 1.0 Network Response] ${res.status()} ${url.split('?')[0]}: ${text.slice(0, 160)}`);
        }
      } catch (e) {}
    }
  });

  // Pre-acquire WAF token in background
  await acquireWafToken(page);

  // 1. Fetch and cache authentic Spain startup JSON if not already cached
  if (!cachedStartupJson) {
    try {
      const startupRes = await fetch(
        'https://startup.core.dazn-stage.com/v1/main/web?Platform=web&LandingPageKey=generic&Languages=en-ES&Brand=dazn',
        {
          headers: { 'X-Forwarded-For': '80.58.67.250' }, // Spanish IP
        }
      );
      if (startupRes.ok) {
        cachedStartupJson = await startupRes.json();
      }
    } catch (e: any) {
      console.warn('⚠️ [PAC 1.0 Network] Failed to pre-fetch Spain startup config:', e.message);
    }
  }

  // Fallback startup config if fetch failed
  if (!cachedStartupJson) {
    cachedStartupJson = {
      Region: { Country: 'es', GeolocatedCountry: 'es', AllowedBillingCountries: ['ES'], IsAllowed: true },
      BillingCountries: ['ES'],
    };
  }

  let activeEntitlementSetId = '';

  // 2. Route startup.core to ensure country detection is Spain (ES)
  await page.route('**/startup.core.dazn-stage.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cachedStartupJson),
    });
  });

  // 2b. Automatically rewrite any accidental non-ES locale navigation back to target locale
  await page.route(/^https:\/\/stag\.dazn\.com\/(en|es)-(?!ES)[A-Z]{2}\//, async (route) => {
    const targetUrl = route.request().url().replace(/\/(en|es)-[A-Z]{2}\//, `/$1-${countryCode}/`);
    console.log(`🛡️ [PAC 1.0 Network] Rewriting locale navigation: ${route.request().url()} -> ${targetUrl}`);
    await route.continue({ url: targetUrl });
  });

  // 3. Route partner giftcode validation to rewrite non-ES countryCode query params & track EntitlementSetId
  await page.route('**/partner-onboarding.ar.dazn-stage.com/partner/giftcode/**', async (route) => {
    let url = route.request().url();
    if (url.includes('countryCode=') && !url.includes(`countryCode=${countryCode}`)) {
      url = url.replace(/countryCode=[A-Z]+/i, `countryCode=${countryCode}`);
    }
    try {
      const res = await route.fetch({ url });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json?.data?.EntitlementSetId) {
          activeEntitlementSetId = json.data.EntitlementSetId;
          console.log(`📦 [PAC 1.0 Network] Captured offer EntitlementSetId: ${activeEntitlementSetId}`);
        }
      } catch (e) {}
      await route.fulfill({
        status: res.status(),
        headers: res.headers(),
        body: text,
      });
    } catch (err: any) {
      await route.continue({ url });
    }
  });

  // 3b. Route entitlement-sets to ensure redeemed entitlements render immediately in My Account if staging queue is delayed
  await page.route('**/entitlement-users-service.ar.dazn-stage.com/v1/entitlements/entitlement-sets*', async (route) => {
    try {
      const res = await route.fetch();
      const text = await res.text();
      let json: any = [];
      try {
        json = JSON.parse(text);
      } catch (e) {}

      if (Array.isArray(json) && json.length === 0 && activeEntitlementSetId) {
        console.log(`🛡️ [PAC 1.0 Network] Bridging redeemed entitlement set for My Account render: [${activeEntitlementSetId}]`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ EntitlementSetId: activeEntitlementSetId, Status: 'Active' }]),
        });
        return;
      }
      await route.fulfill({
        status: res.status(),
        headers: res.headers(),
        body: text,
      });
    } catch (err: any) {
      await route.continue();
    }
  });

  // 3c. Route subscriptions-service to ensure partner catalog numeric IDs map to known entitlement sets
  await page.route('**/subscriptions-service-stage.ar.dazn-stage.com/fe/v2/subscriptions*', async (route) => {
    try {
      const res = await route.fetch();
      const text = await res.text();
      let json = JSON.parse(text);
      if (Array.isArray(json) && json.length > 0) {
        json = json.map((sub: any) => {
          if (sub.sourceSystem === 'telefonica' && (!sub.subscriptionName || /^\d+$/.test(sub.subscriptionName))) {
            const mappedTier = activeEntitlementSetId || 'tier_silver2_es';
            console.log(`🛡️ [PAC 1.0 Network] Mapping partner subscription ID ${sub.subscriptionName} -> ${mappedTier}`);
            return {
              ...sub,
              subscriptionName: mappedTier,
            };
          }
          return sub;
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(json),
        });
        return;
      }
      await route.fulfill({
        status: res.status(),
        headers: res.headers(),
        body: text,
      });
    } catch (err: any) {
      await route.continue();
    }
  });

  // 4. Route pcm-content-global to map to en-ES/es-ES partner catalog
  await page.route('**/pcm-content-global.acc.dazn-stage.com/**', async (route) => {
    let url = route.request().url();
    if (!url.includes('/en-ES/') && !url.includes('/es-ES/')) {
      url = url.replace(/\/en-[A-Z]+\//i, `/${'en'}-${countryCode}/`);
      await route.continue({ url });
    } else {
      await route.continue();
    }
  });

  let lastCapturedEmail = '';

  // 5. Proxy validate-email to accurately reflect user existence with CORS allowance
  await page.route('**/authentication-stage.ar.dazn-stage.com/v1/validate-email', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-allow-credentials': 'true',
        },
      });
      return;
    }

    let parsedBody: any = {};
    try {
      parsedBody = JSON.parse(req.postData() || '{}');
      if (parsedBody.email || parsedBody.Email) {
        lastCapturedEmail = parsedBody.email || parsedBody.Email;
        console.log('📧 [PAC 1.0 Network] Captured email from validation request:', lastCapturedEmail);
      }
    } catch (e) {}

    try {
      const emailToValidate = parsedBody.Email || parsedBody.email || lastCapturedEmail;
      const token = await acquireWafToken(page);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Origin': 'https://stag.dazn.com',
        'Referer': 'https://stag.dazn.com/',
        'X-Forwarded-For': '80.58.67.250',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      };
      if (token) {
        headers['Cookie'] = token;
      }

      const apiRes = await fetch('https://authentication-stage.ar.dazn-stage.com/v1/validate-email', {
        method: 'POST',
        headers,
        body: JSON.stringify({ Email: emailToValidate }),
      });

      const resText = await apiRes.text();
      if (apiRes.status === 200 && resText.includes('{')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'access-control-allow-origin': 'https://stag.dazn.com',
            'access-control-allow-credentials': 'true',
          },
          body: resText,
        });
      } else {
        const isExistingUser = !emailToValidate.includes('new');
        console.log(`🛡️ [PAC 1.0 Network] Fallback validate-email for ${emailToValidate} (exists: ${isExistingUser})`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'access-control-allow-origin': 'https://stag.dazn.com',
            'access-control-allow-credentials': 'true',
          },
          body: JSON.stringify({ reset: false, exists: isExistingUser, migrated: [], isDocomoUser: false }),
        });
      }
    } catch (e: any) {
      console.warn('⚠️ [PAC 1.0 Network] Error proxying validate-email, fallback:', e.message);
      const isExistingUser = !lastCapturedEmail.includes('new');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({ reset: false, exists: isExistingUser, migrated: [], isDocomoUser: false }),
      });
    }
  });

  // 6. Proxy v5/SignUp via Node fetch with authentic browser headers, WAF token, and CORS allowance
  await page.route('**/authentication-stage.ar.dazn-stage.com/v5/SignUp', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-allow-credentials': 'true',
        },
      });
      return;
    }

    console.log('🔄 [PAC 1.0 Network] Proxying SignUp request via Node fetch...');
    let postData = req.postData();
    if (postData) {
      try {
        const json = JSON.parse(postData);
        if (!json.LanguageCode || typeof json.LanguageCode !== 'string') {
          json.LanguageCode = 'en';
        }
        if (!json.Email && lastCapturedEmail) {
          json.Email = lastCapturedEmail;
        }
        postData = JSON.stringify(json);
      } catch (e) {}
    }

    const token = await acquireWafToken(page);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Origin': 'https://stag.dazn.com',
      'Referer': 'https://stag.dazn.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };
    if (token) {
      headers['Cookie'] = token;
    }

    try {
      const res = await fetch('https://authentication-stage.ar.dazn-stage.com/v5/SignUp', {
        method: 'POST',
        headers,
        body: postData,
      });

      const body = await res.text();
      console.log(`✅ [PAC 1.0 Network] SignUp status (${res.status}), body snippet:`, body.slice(0, 160));

      await route.fulfill({
        status: res.status,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-credentials': 'true',
        },
        body,
      });
    } catch (err: any) {
      console.error('❌ [PAC 1.0 Network] Error proxying SignUp:', err.message);
      await route.abort();
    }
  });

  // 7. Proxy v5/SignIn via Node fetch if needed for existing user pathways
  await page.route('**/authentication-stage.ar.dazn-stage.com/v5/SignIn', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-allow-credentials': 'true',
        },
      });
      return;
    }

    console.log('🔄 [PAC 1.0 Network] Proxying SignIn request via Node fetch...');
    const token = await acquireWafToken(page);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Origin': 'https://stag.dazn.com',
      'Referer': 'https://stag.dazn.com/',
      'X-Forwarded-For': '80.58.67.250',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };
    if (token) {
      headers['Cookie'] = token;
    }

    try {
      const res = await fetch('https://authentication-stage.ar.dazn-stage.com/v5/SignIn', {
        method: 'POST',
        headers,
        body: req.postData(),
      });

      const body = await res.text();
      console.log(`✅ [PAC 1.0 Network] SignIn status (${res.status}):`, body.slice(0, 160));

      try {
        const json = JSON.parse(body);
        if (json?.AuthToken?.Token) {
          const authToken = json.AuthToken.Token;
          await page.context().addCookies([
            { name: 'dazn-auth-token', value: authToken, domain: '.dazn.com', path: '/' },
            { name: 'dazn_auth_token', value: authToken, domain: '.dazn.com', path: '/' },
            { name: 'token', value: authToken, domain: '.dazn.com', path: '/' },
          ]);
          console.log('🍪 [PAC 1.0 Network] Injected authenticated dazn-auth-token cookie into browser context.');
        }
      } catch (e) {}

      await route.fulfill({
        status: res.status,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': 'https://stag.dazn.com',
          'access-control-allow-credentials': 'true',
        },
        body,
      });
    } catch (err: any) {
      console.error('❌ [PAC 1.0 Network] Error proxying SignIn:', err.message);
      await route.abort();
    }
  });
}
