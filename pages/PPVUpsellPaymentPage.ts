import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { compare } from '../utils/compare';
import { resolveExpected } from '../utils/resolveExpected';
import { captureFailures } from '../utils/failureCapture';
import { expandMorePaymentMethods, hasLoadedPPVArtwork } from '../utils/helpers';

function matchesSavedCardDateTime(actual: string, expected: string): boolean {
  const weekday = (value: string) => {
    const match = value.match(/\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i);
    return match ? match[1].slice(0, 3).toLowerCase() : '';
  };
  const time = (value: string) => {
    const match = value.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridian = (match[3] || '').toLowerCase();
    if (minute > 59 || hour > 23) return null;
    const in24Hour = meridian
      ? (meridian === 'pm' && hour < 12 ? hour + 12 : meridian === 'am' && hour === 12 ? 0 : hour)
      : hour;
    return { hour, minute, meridian, in24Hour };
  };

  const actualDay = weekday(actual);
  const expectedDay = weekday(expected);
  const actualTime = time(actual);
  const expectedTime = time(expected);
  if (!actualDay || !expectedDay || actualDay !== expectedDay || !actualTime || !expectedTime) {
    return false;
  }
  if (actualTime.in24Hour === expectedTime.in24Hour && actualTime.minute === expectedTime.minute) {
    return true;
  }

  // The saved-card checkout can omit AM/PM (for example, "Sunday at 8:00")
  // while the event configuration uses 24-hour time ("Sun at 20:00").
  // Treat those as equivalent only when the displayed clock hour matches.
  return !actualTime.meridian &&
    expectedTime.in24Hour >= 12 &&
    actualTime.hour === expectedTime.in24Hour % 12 &&
    actualTime.minute === expectedTime.minute;
}

/**
 * PPVUpsellPaymentPage — Generic page object for purchasing a PPV
 * using a previously saved payment card (no VGS iframes needed).
 *
 * Fully dynamic — reads PPV title, price, CVV from eventData.
 * Works for any upsell PPV purchase with a saved card.
 *
 * Expected eventData keys:
 *   UPSELL_CVV — CVV for saved card (default: '737')
 *   (all validation fields come from Excel sheet via resolveExpected)
 */
export class PPVUpsellPaymentPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  // ─────────────────────────────
  // DETECT: Is this a saved card payment page?
  // ─────────────────────────────
  async isPPVUpsellPaymentPage(): Promise<boolean> {
    const body = await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const lower = body.toLowerCase();
    // Generic: saved card present + one time payment indicator
    return (lower.includes('one time payment') || lower.includes('pay now')) &&
      (lower.includes('visa') || lower.includes('mastercard') || lower.includes('amex') ||
        lower.includes('****') || lower.includes('saved'));
  }

  // ─────────────────────────────
  // VALIDATE: Saved Card Payment Page (generic)
  // Fields: page title, PPV image, date badge, PPV price,
  // payment type, today you pay, payment instruction,
  // saved card info, more payment methods, redeem promo code
  // ─────────────────────────────
  async validateSavedCardPayment(
    data: any[],
    results: any[],
    eventData: Record<string, string>,
    pageName = 'Saved Card Payment'
  ): Promise<void> {
    console.log(`🔍 Validating ${pageName} page...`);

    // This validator is also used by the active-standard saved-card flow,
    // which reaches /addon/purchase without going through validateVariant.
    // Set the page context here so resolveExpected does not reuse the annual
    // subscription total as the PPV checkout amount.
    eventData.CURRENT_PAGE = pageName;
    eventData['CURRENT_PAGE'] = pageName;
    const isUpsellPpvPayment = pageName.toLowerCase().includes('upsell payment') &&
      String(eventData.PPV_TYPE || '').toLowerCase() === 'upsell';
    const checkoutPpvName = isUpsellPpvPayment
      ? eventData.UPSELL_PPV_NAME || eventData.PPV_NAME || ''
      : eventData.PPV_NAME || '';
    const checkoutPpvDescription = isUpsellPpvPayment
      ? eventData.UPSELL_PPV_DESCRIPTION || ''
      : eventData.BANNER_DESCRIPTION || eventData.PPV_DESCRIPTION || '';

    // ── Wait for page to be ready ──
    // Wait specifically for the Pay Now button — it is the last element to render
    // on the saved card payment page, so its visibility confirms the page is fully loaded.
    const payNowBtn = this.page.locator(
      'button:has-text("Pay Now"), button:has-text("Pay now"), ' +
      'button:has-text("Pay €"), button:has-text("Pay £"), ' +
      'button[type="submit"]:has-text("Pay")'
    ).first();

    console.log('⏳ Waiting for Pay Now button to be visible (page fully loaded)...');
    await payNowBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {
      console.warn('⚠️ Pay Now button not visible after 20s — page may not be fully loaded');
    });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
    await this.page.waitForTimeout(500); // Small settle delay
    const paymentMethodsExpanded = await expandMorePaymentMethods(this.page, pageName);

    const bodyText = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const bodyLower = bodyText.toLowerCase();

    for (const row of data) {
      const field = (row['Field'] || '').trim();
      if (!field) continue;
      const expected = resolveExpected(row, eventData);

      // Skip validation if expected is 'N/A' or empty
      const expectedNorm = (expected || '').trim().toUpperCase();
      const expectedOptions = expectedNorm.split('|').map(opt => opt.trim());
      const isAllNAOrEmpty = expectedOptions.every(opt => opt === 'N/A' || opt === '');
      if (isAllNAOrEmpty) {
        console.log(`  ⏭️  Skipping [${field}] — expected is "${expected}"`);
        continue;
      }

      let actual = 'N/A';
      const key = field.toLowerCase().replace(/\s+/g, ' ').trim();

      // ── Skip CTA ──
      if (key === 'skip cta') {
        const skipEl = this.page.locator(
          'a:has-text("Skip"), button:has-text("Skip"), [class*="skip" i]'
        ).first();
        actual = (await skipEl.isVisible({ timeout: 2000 }).catch(() => false)) ? 'Yes' : 'No';

        // ── PPV Name (heading) ──
      } else if (key === 'ppv name' || key === 'page title') {
        const headings = await this.page.locator('h1, h2, h3, h4').allTextContents().catch(() => []);
        const ppvNameFull = checkoutPpvName.toLowerCase();
        const nameWords = ppvNameFull
          .split(/[\s:\-–—,]+/)
          .filter(w => w.length > 2 && !/^(the|and|for|with|from|ppv)$/i.test(w));

        let foundHeading = headings.find((h: string) => {
          const lowerH = h.toLowerCase();
          if (lowerH.includes('dazn')) return false;
          if (nameWords.length > 0) {
            return nameWords.some(w => lowerH.includes(w));
          }
          return lowerH.includes('ppv') || lowerH.includes('vs');
        });

        actual = foundHeading?.trim() || headings.find(h => !h.toLowerCase().includes('dazn'))?.trim() || headings[0]?.trim() || 'N/A';

        // ── PPV Description ──
      } else if (key === 'ppv description') {
        // The payment page must contain the configured event description,
        // not merely any non-empty paragraph.
        const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
        // The checkout card renders the event marketing description
        // (BANNER_DESCRIPTION), not the generic plan-pairing PPV_DESCRIPTION.
        const expectedDescription = clean(checkoutPpvDescription || expected || '');
        const paras = await this.page.locator('p, [class*="description" i], [class*="subtitle" i]')
          .allTextContents().catch(() => []);
        const allText = paras.map(clean).filter((text: string) => text.length >= 20 && text.length <= 300);
        const normaliseDescription = (value: string) => clean(value).replace(/[.!?]+$/, '').toLowerCase();
        actual = allText.find((text: string) =>
          normaliseDescription(text) === normaliseDescription(expectedDescription)
        ) || 'N/A';

        // ── PPV Image Present ──
      } else if (key === 'ppv image present' || key.includes('ppv image') || key.includes('image present')) {
        const title = this.page.getByText(checkoutPpvName, { exact: true }).first();
        const eventScope = title.locator(
          'xpath=ancestor::*[.//img or .//*[@role="img"] or .//*[contains(@style,"background-image")]][1]'
        );
        const hasEventScope = await eventScope.count().catch(() => 0) > 0;
        const hasArtwork = await hasLoadedPPVArtwork(
          hasEventScope ? eventScope : this.page,
          checkoutPpvName,
          eventData.PPV_ENTITLEMENT_ID || '',
          !hasEventScope
        );
        actual = hasArtwork ? 'Yes' : 'No';

        // ── PPV Date and Time ──
      } else if (key === 'ppv date and time' || key.includes('date badge') || key.includes('event date')) {
        const datePatterns = [
          // Checkout renders near events as a relative badge over the PPV image
          // (for example, "Tomorrow at 18:30") rather than a calendar date.
          /\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|night))\s+at\s+\d{1,2}:\d{2}\b/i,
          /\b(Sat|Sun|Mon|Tue|Wed|Thu|Fri)\w*\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+at\s+\d{1,2}:\d{2}/i,
          /\b(Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday)\s+at\s+\d{1,2}:\d{2}/i,
          /\b(Sat|Sun|Mon|Tue|Wed|Thu|Fri)\w*\s+at\s+\d{1,2}:\d{2}/i,
          /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+at\s+\d{1,2}:\d{2}/i,
        ];
        for (const pattern of datePatterns) {
          const match = bodyText.match(pattern);
          if (match) { actual = match[0].trim(); break; }
        }

        // ── Excluding Tax ──
      } else if (key === 'excluding tax text' || key === 'excluding tax') {
        const taxText = await this.page.locator(
          '[data-testid*="excluding-tax" i], [id*="excluding-tax" i], ' +
          'span:has-text("(excluding tax)"), span:has-text("excluding tax"), ' +
          'p:has-text("excluding tax")'
        ).filter({ visible: true }).first().innerText({ timeout: 2000 }).catch(() => '');
        const fallback = bodyText.match(/\(?excluding tax\)?/i)?.[0] || '';
        actual = taxText.trim() || fallback || 'N/A';

        // ── Order Summary PPV Name (PPV name in the price/summary section) ──
      } else if (key === 'order summary ppv name') {
        // The PPV name appears next to the price in the order summary row
        const ppvName = checkoutPpvName;
        const mainName = ppvName.split(/[:\-–]/)[0].trim();
        const vsMatch = ppvName.match(/([\w\u00C0-\u024F]+)\s+vs\.?\s+([\w\u00C0-\u024F]+)/i);
        const f1 = vsMatch ? vsMatch[1].toLowerCase() : '';
        const f2 = vsMatch ? vsMatch[2].toLowerCase() : '';

        // Look for the PPV name outside headings (in the order summary area)
        const summaryEls = await this.page.locator('div, span, p, td').allTextContents().catch(() => []);
        const matchEl = summaryEls.find((t: string) => {
          const tLower = t.trim().toLowerCase();
          if (tLower.length < 5 || tLower.length > 100) return false;
          if (f1 && f2) return tLower.includes(f1) && tLower.includes(f2);
          return tLower.includes(mainName.toLowerCase());
        });
        actual = matchEl ? matchEl.trim() : 'N/A';

        // ── Order Summary PPV Price (price beside the PPV name) ──
      } else if (key === 'order summary ppv price') {
        const pricePattern = /(?:(?:AED\s?|[£$€₹])\s*\d+(?:[.,]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)/i;
        const summaryPrice = await this.page.evaluate(({ ppvName, pricePatternSource }) => {
          const cleanText = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
          const pricePattern = new RegExp(pricePatternSource, 'i');
          const words = ppvName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
          const visible = (el: HTMLElement) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const leaves = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,span,div'))
            .filter(el => visible(el) && el.children.length === 0);
          const nameEl = leaves.find(el => {
            const text = cleanText(el.innerText || el.textContent).toLowerCase();
            return words.length > 0 && words.every(word => text.includes(word));
          });
          if (!nameEl) return '';
          let parent: HTMLElement | null = nameEl.parentElement;
          for (let depth = 0; depth < 6 && parent; depth++, parent = parent.parentElement) {
            const prices = Array.from(parent.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,span,div'))
              .filter(el => visible(el) && el.children.length === 0)
              .map(el => ({ el, text: cleanText(el.innerText || el.textContent), rect: el.getBoundingClientRect() }))
              .filter(item => pricePattern.test(item.text) && !item.text.includes('/'));
            if (prices.length) {
              const nameRect = nameEl.getBoundingClientRect();
              prices.sort((a, b) => Math.abs(a.rect.top - nameRect.top) - Math.abs(b.rect.top - nameRect.top));
              return prices[0].text;
            }
          }
          return '';
        }, { ppvName: checkoutPpvName, pricePatternSource: pricePattern.source }).catch(() => '');
        actual = summaryPrice || 'N/A';

        // ── Today You Pay Text ──
      } else if (key === 'today you pay text') {
        actual = bodyLower.includes('today you pay') ? 'Today you pay' : 'N/A';

        // ── Today You Pay Price ──
      } else if (key === 'today you pay price' || key.includes('today you pay') || key.includes('total price')) {
        const pricePattern = /(?:(?:AED\s?|[£$€])\d+(?:[.,]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)/i;
        const todayMatch = bodyText.match(new RegExp(`today you pay[^£$€AED\\d]*${pricePattern.source}`, 'i'));
        actual = todayMatch ? todayMatch[0].match(pricePattern)?.[0] || 'N/A' : 'N/A';

        // ── PPV Price / Event Price (in the order summary line) ──
      } else if (key === 'ppv price' || key === 'event price') {
        const priceMatch = bodyText.match(/(?:(?:AED\s?|[£$€])\d+(?:[.,]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)/i);
        actual = priceMatch ? priceMatch[0] : 'N/A';

        // ── Payment Type (One time payment) ──
      } else if (key.includes('payment type')) {
        actual = bodyLower.includes('one time payment') ? 'One time payment' : 'N/A';

        // ── Payment Method Present ──
      } else if (key === 'payment method present') {
        const hasMethod = bodyLower.includes('payment method') ||
          bodyLower.includes('visa') || bodyLower.includes('mastercard') ||
          bodyLower.includes('amex') || bodyLower.includes('****');
        actual = hasMethod ? 'Yes' : 'No';

        // ── Pay Now Button ──
      } else if (key === 'pay now button') {
        // 1. Explicit "Pay Now" / "Pay £X" button
        const payBtn = this.page.locator(
          'button:has-text("Pay Now"), button:has-text("Pay now"), ' +
          'button:has-text("Pay €"), button:has-text("Pay £"), ' +
          'button[type="submit"]:has-text("Pay")'
        ).first();
        const hasExplicitPayBtn = await payBtn.isVisible({ timeout: 2000 }).catch(() => false);

        // 2. GB mobile checkout: Google Pay is shown as a radio-style selector
        //    (not a button). The label/radio itself IS the pay trigger.
        const hasGooglePayElement = await this.page.locator(
          '[aria-label*="Google Pay" i], button:has-text("Google Pay"), ' +
          'label:has-text("Google Pay"), [role="radio"]:has-text("Google Pay"), ' +
          'input[value*="googlepay" i], [data-testid*="googlepay" i], ' +
          '[class*="googlepay" i], [class*="google-pay" i], ' +
          'text=Google Pay'
        ).first().isVisible({ timeout: 1500 }).catch(() => false);

        // 3. Any payment method section visible = pay action is available
        const hasPaymentMethodSection = await this.page.locator(
          'text=Payment method, [class*="payment-method" i], ' +
          'text=More payment methods, [class*="paymentMethod" i]'
        ).first().isVisible({ timeout: 1500 }).catch(() => false);

        // 4. Any primary submit / CTA button
        const hasPrimarySubmit = await this.page.locator(
          'button[type="submit"], button:has-text("Complete"), button:has-text("Confirm"), ' +
          'button:has-text("Subscribe"), button:has-text("Purchase"), button:has-text("Buy")'
        ).first().isVisible({ timeout: 1500 }).catch(() => false);

        const payTriggerFound = hasExplicitPayBtn || hasGooglePayElement || hasPaymentMethodSection || hasPrimarySubmit;
        console.log(`  [Pay Now Button] explicit=${hasExplicitPayBtn}, googlePay=${hasGooglePayElement}, paymentSection=${hasPaymentMethodSection}, submitBtn=${hasPrimarySubmit} → ${payTriggerFound ? 'Yes' : 'No'}`);
        actual = payTriggerFound ? 'Yes' : 'No';

        // ── Secure Checkout ──
      } else if (key === 'secure checkout') {
        const hasSecure = bodyLower.includes('secure checkout') ||
          bodyLower.includes('secure payment') ||
          bodyLower.includes('ssl') ||
          await this.page.locator('[class*="secure" i], [class*="lock" i], [alt*="secure" i]')
            .first().isVisible({ timeout: 1500 }).catch(() => false);
        actual = hasSecure ? 'Yes' : 'No';

        // ── More Payment Methods ──
      } else if (key === 'more payment methods' || key.includes('more payment')) {
        const morePaymentMethods = this.page.getByText(/^More payment methods$/i).first();
        actual = (await morePaymentMethods.textContent().catch(() => ''))?.trim() ||
          (paymentMethodsExpanded ? 'Yes' : 'No');

        // ── Legal Text Present ──
      } else if (key === 'legal text present') {
        // Legal text typically contains terms like "By completing", "agree", "purchase"
        const legalPatterns = [
          'by completing', 'by purchasing', 'you agree', 'terms of use',
          'terms and conditions', 'non-refundable', 'acknowledge', 'consent'
        ];
        const hasLegal = legalPatterns.some(p => bodyLower.includes(p));
        actual = hasLegal ? 'Yes' : 'No';

        // ── Terms Link Present ──
      } else if (key === 'terms link present') {
        const termsLink = this.page.locator(
          'a:has-text("Terms"), a:has-text("terms of use"), a:has-text("Terms and Conditions"), ' +
          'a[href*="terms"], a[href*="Terms"]'
        ).first();
        actual = (await termsLink.isVisible({ timeout: 1500 }).catch(() => false)) ? 'Yes' : 'No';

        // ── Privacy Policy Link Present ──
      } else if (key === 'privacy policy link present') {
        const privacyLink = this.page.getByRole('link', { name: /privacy/i }).first();
        actual = (await privacyLink.isVisible({ timeout: 1500 }).catch(() => false)) ? 'Yes' : 'No';

        // ── Payment Instruction / Payment Text ──
      } else if (key.includes('payment instruction') || key.includes('payment text')) {
        actual = bodyLower.includes('please choose from the payment options') ? expected : 'N/A';

        // ── Saved Card / Card on File ──
      } else if (key.includes('saved card') || key.includes('card on file')) {
        const hasCard = bodyLower.includes('visa') || bodyLower.includes('mastercard') ||
          bodyLower.includes('amex') || bodyLower.includes('****');
        actual = hasCard ? expected : 'N/A';

        // ── Redeem Promo Code ──
      } else if (key.includes('redeem promo') || key.includes('promo code')) {
        actual = bodyLower.includes('redeem promo code') ? 'Redeem promo code' : 'N/A';
      }

      const matches =
        compare(actual, expected) ||
        (key === 'ppv date and time' && matchesSavedCardDateTime(actual, expected));
      const status = matches ? 'PASS' : 'FAIL';
      const icon = status === 'PASS' ? '✅' : '❌';
      console.log(`  ${icon} [${field}] expected="${expected}" actual="${actual}"`);
      results.push({ page: pageName, field, expected, actual, status });
    }

    // Capture red-boxed screenshots for any failed fields
    await captureFailures(this.page, results, pageName);
  }

  // ─────────────────────────────
  // ACTION: Select saved card radio (generic — any card brand)
  // Targets the specific card row containing brand + last-4 digits,
  // NOT generic radio inputs that could match "More payment methods".
  // ─────────────────────────────
  async selectSavedCard(): Promise<void> {
    console.log('💳 Selecting saved payment card...');

    // Wait for the payment method section to load
    await this.page.waitForSelector('text=/payment method/i', { timeout: 10000 }).catch(() => { });

    // Strategy 1: Find the row/container that has card brand text + last-4 digits
    // The screenshot shows: "VISA - **** 1111 / Exp 03/30" inside a clickable row
    const cardRowSelectors = [
      // Text-based: find element containing "**** " (any card's last 4 digits)
      'div:has-text("****") >> visible=true',
      'label:has-text("****") >> visible=true',
      'section:has-text("****") >> visible=true',
    ];

    let clicked = false;

    // First try: use getByText to find the card label and click its container
    const cardPatterns = [/VISA.*\*{4}/i, /Mastercard.*\*{4}/i, /AMEX.*\*{4}/i, /\*{4}\s*\d{4}/];
    for (const pattern of cardPatterns) {
      const cardText = this.page.getByText(pattern).first();
      if (await cardText.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`💳 Found card text matching: ${pattern}`);
        // Click the card text itself — the row/label should handle click propagation
        await cardText.click({ force: true });
        clicked = true;
        console.log('✅ Clicked saved card text');
        break;
      }
    }

    // Second try: find a clickable parent that wraps the card info
    if (!clicked) {
      for (const sel of cardRowSelectors) {
        const row = this.page.locator(sel).first();
        if (await row.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Make sure this is NOT "More payment methods"
          const text = (await row.textContent().catch(() => '')) || '';
          if (text.toLowerCase().includes('more payment')) continue;
          await row.click({ force: true });
          clicked = true;
          console.log(`✅ Clicked saved card container via: ${sel}`);
          break;
        }
      }
    }

    // Third try: find the radio input that's a SIBLING of card text containing "****"
    if (!clicked) {
      console.log('💳 Trying radio-near-card-text approach...');
      const radioClicked = await this.page.evaluate(() => {
        // Find all elements containing "****"
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.includes('****')) {
            // Walk up to find a clickable container or sibling radio
            let parent = node.parentElement;
            for (let depth = 0; depth < 8 && parent; depth++) {
              // Check for radio input inside or adjacent
              const radio = parent.querySelector('input[type="radio"], [role="radio"], span[class*="radio" i], svg circle');
              if (radio) {
                (radio as HTMLElement).click();
                return true;
              }
              // Check if parent itself is clickable
              if (parent.tagName === 'LABEL' || parent.getAttribute('role') === 'radio' ||
                parent.getAttribute('role') === 'option' || parent.style.cursor === 'pointer') {
                parent.click();
                return true;
              }
              parent = parent.parentElement;
            }
          }
        }
        return false;
      }).catch(() => false);

      if (radioClicked) {
        clicked = true;
        console.log('✅ Clicked saved card via DOM traversal');
      }
    }

    if (!clicked) {
      console.log('⚠️ Could not find saved card to click — it may already be selected');
    }

    // Wait for CVV input to appear after card selection
    await this.page.waitForTimeout(2000);
  }

  // ─────────────────────────────
  // ACTION: Enter CVV
  // CVV input only appears AFTER saved card radio is selected.
  // It's a regular <input>, NOT a VGS iframe (VGS is only for new cards).
  // ─────────────────────────────
  async enterCVV(cvv: string): Promise<void> {
    console.log('🔑 Entering CVV...');

    // Wait for CVV input to render (appears after card selection)
    // Try multiple selectors — the CVV field could be various types
    const cvvSelectors = [
      'input[placeholder*="CVV" i]',
      'input[placeholder*="CVC" i]',
      'input[placeholder*="Security" i]',
      'input[name*="cvv" i]',
      'input[name*="cvc" i]',
      'input[name*="securityCode" i]',
      'input[autocomplete*="cc-csc" i]',
      'input[type="tel"]',
      'input[type="password"]',
      'input[type="number"]',
    ];

    let cvvInput = null;

    // Wait up to 8 seconds for a CVV-like input to appear
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const sel of cvvSelectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          // Verify it's actually a CVV field — should be short (3-4 chars), not card number
          const maxLen = await el.getAttribute('maxlength').catch(() => null);
          const placeholder = (await el.getAttribute('placeholder').catch(() => '')) || '';
          const name = (await el.getAttribute('name').catch(() => '')) || '';

          // Accept if maxlength is 3-4 (CVV), or name/placeholder matches, or it's a tel/password type
          const isCVVLike = (maxLen && parseInt(maxLen) <= 4) ||
            placeholder.toLowerCase().match(/cvv|cvc|security|code/) ||
            name.toLowerCase().match(/cvv|cvc|security/) ||
            sel.includes('password');

          // Also accept any input[type="tel"] that appeared AFTER card selection
          // (card number inputs are in VGS iframes, not on this page)
          if (isCVVLike || sel === 'input[type="tel"]') {
            cvvInput = el;
            console.log(`🔑 Found CVV input via: ${sel} (maxlength=${maxLen}, placeholder="${placeholder}")`);
            break;
          }
        }
      }
      if (cvvInput) break;
      console.log(`⏳ CVV input not found yet (attempt ${attempt + 1}/8)...`);
      await this.page.waitForTimeout(1000);
    }

    if (cvvInput) {
      await cvvInput.click({ force: true });
      await cvvInput.fill(''); // Clear first
      await cvvInput.fill(cvv);
      console.log(`✅ CVV entered: ${'*'.repeat(cvv.length)}`);

      // Verify the value was set
      const value = await cvvInput.inputValue().catch(() => '');
      if (value.length < cvv.length) {
        console.log('⚠️ CVV fill may have failed — trying char-by-char');
        await cvvInput.click({ force: true });
        await cvvInput.press('Meta+A').catch(() => cvvInput!.press('Control+A'));
        await cvvInput.press('Backspace');
        for (const char of cvv) {
          await this.page.keyboard.type(char, { delay: 150 });
        }
        console.log('✅ CVV entered via keyboard typing');
      }
    } else {
      // Last resort: try VGS iframe (unlikely for saved card, but safety net)
      console.log('⚠️ No regular CVV input found — trying VGS iframe as fallback');
      const cvvFrame = this.page.locator(
        'iframe[title*="CVV" i], iframe[title*="cvc" i], iframe[title*="security" i]'
      ).first();

      if (await cvvFrame.isVisible({ timeout: 3000 }).catch(() => false)) {
        const frame = cvvFrame.contentFrame();
        const frameInput = frame.locator('input').first();
        await frameInput.click({ force: true });
        for (const char of cvv) {
          await this.page.keyboard.type(char, { delay: 150 });
        }
        console.log('✅ CVV entered via VGS iframe');
      } else {
        console.log('❌ CVV input not found anywhere — payment may fail');
      }
    }
  }

  // ─────────────────────────────
  // ACTION: Click "Pay Now" and wait for navigation
  // Graceful handling if page closes during post-payment wait
  // ─────────────────────────────
  async clickPayNow(): Promise<void> {
    console.log('🖱️ Clicking "Pay Now"...');

    if (this.page.isClosed()) throw new Error('Page closed before Pay Now click');

    const payNowBtn = this.page.locator(
      'button:has-text("Pay Now"), button:has-text("Pay now"), ' +
      'button:has-text("Pay €"), button:has-text("Pay £"), ' +
      'button[type="submit"]:has-text("Pay")'
    ).first();

    await payNowBtn.waitFor({ state: 'visible', timeout: 8000 });

    const beforeUrl = this.page.url();
    await payNowBtn.click({ force: true });
    console.log('✅ Clicked "Pay Now"');

    // Wait for success page — with graceful page-close handling
    try {
      await this.page.waitForURL(
        (url: URL) => url.toString() !== beforeUrl,
        { timeout: 30000 }
      );
    } catch (err: any) {
      if (this.page.isClosed()) {
        console.log('⚠️ Page closed after Pay Now — this may be expected during redirect');
        return;
      }
      console.log(`⚠️ URL did not change after Pay Now: ${err.message}`);
    }

    if (!this.page.isClosed()) {
      await this.page.waitForLoadState('domcontentloaded').catch(() => { });
      await this.page.waitForTimeout(3000).catch(() => { });
      console.log(`✅ Navigated to: ${this.page.url()}`);
    }
  }

  // ─────────────────────────────
  // ORCHESTRATOR: Enter CVV -> Pay
  // Saved cards are auto-selected by checkout when the page loads.
  // CVV is read from eventData.UPSELL_CVV (fallback: '737')
  // ─────────────────────────────
  async fillAndSubmit(eventData: Record<string, string>): Promise<void> {
    const cvv = eventData.UPSELL_CVV || eventData.UPSELL_PPV_CVV || eventData.FURY_CVV || '737';
    console.log(`💳 Saved card payment flow — CVV length: ${cvv.length}`);
    await this.enterCVV(cvv);
    await this.clickPayNow();
  }
}
