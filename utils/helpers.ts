import { Page, BrowserContext } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────
// SLEEP
// ─────────────────────────────────────────────────────────────────
export const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────
// DAZN OPENING ERROR PAGE
// Some VPN/network/session failures still return a 200 response and keep the
// requested DAZN URL, but render only a `.protected` page saying that DAZN
// cannot be opened.  Detect it before a later selector assertion turns it
// into a misleading PPV/UI failure.  A single reload is worthwhile because
// this page is often transient on shared runners.
// ─────────────────────────────────────────────────────────────────
type DaznOpeningErrorSnapshot = {
  isOpeningError: boolean;
  message: string;
};

async function getDaznOpeningErrorSnapshot(page: Page): Promise<DaznOpeningErrorSnapshot> {
  if (page.isClosed()) return { isOpeningError: false, message: '' };

  return page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const protectedText = (document.querySelector('body > .protected, body .protected')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const text = `${bodyText} ${protectedText}`.toLowerCase();
    const hasProtectedRoot = Boolean(document.querySelector('body > .protected, body .protected'));
    const hasKnownMessage =
      /there'?s a problem opening dazn just now/i.test(text) ||
      /try opening (?:the )?(?:application|app) or (?:the )?browser again later/i.test(text);
    const isOpeningError = hasKnownMessage || (
      hasProtectedRoot && /(?:problem|error).*opening dazn|opening dazn.*(?:problem|error)/i.test(text)
    );

    return {
      isOpeningError,
      message: (protectedText || bodyText).slice(0, 500),
    };
  }).catch(() => ({ isOpeningError: false, message: '' }));
}

/**
 * Reloads the known DAZN "problem opening" page once, then throws a precise
 * access failure if it persists. Safe to call after any DAZN navigation.
 */
export async function assertDaznPageAvailable(
  page: Page,
  stage: string = 'page load'
): Promise<void> {
  const initial = await getDaznOpeningErrorSnapshot(page);
  if (!initial.isOpeningError) return;

  console.warn(
    `⚠️ [DAZN Access Error] Detected DAZN's "There's a problem opening DAZN just now" page during ${stage}. ` +
    'Refreshing once before failing…'
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((error: Error) => {
    console.warn(`⚠️ [DAZN Access Error] Refresh did not complete cleanly: ${error.message}`);
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

  const afterRefresh = await getDaznOpeningErrorSnapshot(page);
  if (!afterRefresh.isOpeningError) {
    console.log(`✅ [DAZN Access Error] Page recovered after one refresh during ${stage}. URL: ${page.url()}`);
    return;
  }

  const renderedMessage = afterRefresh.message || initial.message;
  throw new Error(
    `❌ [DAZN Access Error] DAZN still displays "There's a problem opening DAZN just now" after one refresh during ${stage}. ` +
    'This is a DAZN/VPN/network access issue, not a PPV or selector validation failure. ' +
    `URL: ${page.url()}` +
    (renderedMessage ? `\nRendered error: ${renderedMessage}` : '')
  );
}


// ─────────────────────────────────────────────────────────────────
// HANDLE COOKIES — dismiss cookie banner via UI click
// ── Called after every navigation. Dismisses cookie consent banner
//    by clicking the Accept button. Only runs once per BrowserContext.
// ─────────────────────────────────────────────────────────────────

const _dismissedContexts = new WeakSet<BrowserContext>();

export async function handleCookies(page: Page, timeout: number = 8000): Promise<void> {
  if (page.isClosed()) return;

  // This is called immediately after DAZN navigations throughout new-user,
  // existing-user, login-first, and sign-in-during-flow journeys.
  await assertDaznPageAvailable(page, 'post-navigation cookie check');

  const context = page.context();

  // If already dismissed in this context, do a fast visible check first
  // and only proceed if the banner reappeared (e.g. on a new page/redirect)
  if (_dismissedContexts.has(context)) {
    const isVisibleNow = await page.locator('#onetrust-accept-btn-handler')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (!isVisibleNow) return;
    console.log('🍪 Cookie banner reappeared after initial dismissal — dismissing again...');
  }

  // ── DAZN pattern: wait the full timeout for the Accept button ─────
  // Always use the caller-provided timeout so late-loading banners
  // (e.g. on signin page) are caught reliably.
  const cookieAcceptBtn = page.locator('#onetrust-accept-btn-handler');
  const isVisible = await cookieAcceptBtn
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

  if (isVisible) {
    try {
      await cookieAcceptBtn.click({ timeout: 3000 });
      console.log('🍪 Accepted cookies via #onetrust-accept-btn-handler');
      _dismissedContexts.add(context);
      // Wait for banner to disappear after clicking
      await page.locator('#onetrust-banner-sdk')
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() => { });
      await stabilisePage(page);
      return;
    } catch {
      // Force click fallback
      try {
        await cookieAcceptBtn.click({ force: true, timeout: 3000 });
        console.log('🍪 Accepted cookies via forced click');
        _dismissedContexts.add(context);
        await stabilisePage(page);
        return;
      } catch {
        // JS click as last resort
        const handle = await cookieAcceptBtn.elementHandle({ timeout: 2000 }).catch(() => null);
        if (handle) {
          await page.evaluate((el: any) => el.click(), handle).catch(() => { });
          console.log('🍪 Accepted cookies via JS click');
          _dismissedContexts.add(context);
          await stabilisePage(page);
          return;
        }
      }
    }
  }

  // ── Fallback: try other common cookie accept selectors ───────
  const fallbackSelectors = [
    '[data-test-id="COOKIE_BUTTON"]',
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Allow all")',
  ];

  for (const selector of fallbackSelectors) {
    const btn = page.locator(selector).first();
    const btnVisible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (btnVisible) {
      try {
        await btn.click({ timeout: 3000 });
        console.log(`🍪 Accepted cookies via fallback: ${selector}`);
        _dismissedContexts.add(context);
        await stabilisePage(page);
        return;
      } catch {
        // continue to next selector
      }
    }
  }

  // Cookie banner not displayed
  console.log('🍪 Cookie banner not displayed — skipping');
}

// ─────────────────────────────────────────────────────────────────
// STABILISE PAGE — remove cookie overlays from DOM
// ─────────────────────────────────────────────────────────────────
export async function stabilisePage(page: Page): Promise<void> {
  if (page.isClosed()) return;
  // Cap at 3s: page.evaluate() has no built-in timeout and will hang
  // indefinitely on a CPU-starved runner until the test timeout kills it.
  const evalWork = page.evaluate(() => {
    if (window.location.href.includes('/myaccount')) return;
    [
      '#onetrust-banner-sdk',
      '#onetrust-consent-sdk',
      '#onetrust-pc-sdk',
      '.onetrust-pc-dark-filter',
      '[class*="cookie-banner" i]',
      '[class*="consent-banner" i]',
      '[class*="cookie-disclaimer" i]',
      '[data-test-id="COOKIE_CONTAINER"]',
    ].forEach(sel =>
      document.querySelectorAll<HTMLElement>(sel)
        .forEach(el => el.remove())
    );
  }).catch(() => { });
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
  await Promise.race([evalWork, timeout]);
}

// ─────────────────────────────────────────────────────────────────
// DISMISS MARKETING POPUP ("Unlock exclusive content")
// ─────────────────────────────────────────────────────────────────
export async function dismissMarketingPopup(
  page: Page,
  timeout: number = 0,
  options: { preservePpvPromo?: boolean } = {}
): Promise<void> {
  if (page.isClosed()) return;
  try {
    const paymentUpdateClosePoint = await page.evaluate(() => {
      const textMatches = (text: string) =>
        /update your payment method|latest payment.*didn.?t go through/i.test(text);
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i]'
      ));
      const dialog = dialogs
        .filter(el => isVisible(el) && textMatches(el.innerText || el.textContent || ''))
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        })[0];
      if (!dialog) return null;

      const buttons = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button, [role="button"], [aria-label], [data-testid], [onclick]'
      ))
        .filter(isVisible)
        .filter(el => !/update now/i.test((el.innerText || el.textContent || '').trim()));
      const close = buttons.find(el =>
        /close|dismiss/i.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''} ${el.innerText || ''}`)
      );
      const dialogRect = dialog.getBoundingClientRect();
      const closeTarget = close || buttons
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left > dialogRect.left + dialogRect.width * 0.55)
        .sort((a, b) => b.rect.left - a.rect.left || a.rect.top - b.rect.top)[0]?.el;
      const rect = closeTarget?.getBoundingClientRect();
      return rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
    }).catch((): { x: number; y: number } | null => null);

    if (paymentUpdateClosePoint) {
      await page.mouse.click(paymentUpdateClosePoint.x, paymentUpdateClosePoint.y);
      const paymentUpdateStillVisible = await page.getByText(/update your payment method/i)
        .first().isVisible({ timeout: 1500 }).catch(() => false);
      if (!paymentUpdateStillVisible) {
        console.log('✅ Dismissed payment update popup');
        return;
      }
      console.warn('⚠️ Payment update popup is still visible after clicking its close control');
    }

    const dismissSelectors = [
      'button:has-text("Keep me updated")',
      'button:has-text("Keep Me Updated")',
      'button:has-text("Maybe later")',
      'button:has-text("Maybe Later")',
      'button:has-text("No thanks")',
      'button:has-text("No Thanks")',
      'button:has-text("Not now")',
      'button:has-text("Not Now")',
      'button:has-text("Close")',
      'button:has-text("Dismiss")',
      '[aria-label="Close"]',
      '[aria-label="close"]',
      '[aria-label*="close" i]',
      '[data-testid*="close" i]',
      'div[class*="content-promotion__modal-close"]',
    ].join(', ');

    const popup = page.locator(dismissSelectors).first();

    let isVisible = false;
    if (timeout > 0) {
      isVisible = await popup.waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
    } else {
      isVisible = await popup.isVisible().catch(() => false);
    }

    if (isVisible) {
      if (options.preservePpvPromo) {
        const ppvPromo = page.locator(
          '[role="dialog"], [aria-modal="true"], [class*="content-promotion" i], [class*="modal" i], [class*="popup" i]'
        ).filter({ hasText: /buy now/i }).first();
        if (await ppvPromo.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log('ℹ️ PPV promo detected — preserving it for validation and Buy Now flow');
          return;
        }
      }
      const btnText = await popup.textContent().catch(() => '');

      // When preservePpvPromo is set, skip dismissing PPV purchase prompts
      // so the home-page-popup flow can interact with the Buy Now CTA.
      if (options.preservePpvPromo && btnText) {
        const lower = btnText.toLowerCase();
        const isPpvPopup =
          lower.includes('buy now') ||
          lower.includes('get it now') ||
          lower.includes('ppv') ||
          lower.includes('pay-per-view');
        if (isPpvPopup) {
          console.log(`🛡️ PPV promo popup preserved ("${btnText.trim().substring(0, 80)}")`);
          return;
        }
      }

      console.log(`🔔 Marketing popup detected ("${btnText?.trim()}"). Dismissing...`);
      await popup.click({ force: true }).catch(() => { });
      console.log('✅ Dismissed marketing popup');
    }
  } catch (e) {
    console.warn('⚠️ Error in dismissMarketingPopup:', e);
  }
}

export async function expandMorePaymentMethods(page: Page, pageName = 'Payment Page'): Promise<boolean> {
  if (page.isClosed()) return false;

  const disclosure = await page.evaluate(() => {
    const isVisible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    };
    const alternativesVisible = Array.from(document.querySelectorAll<HTMLElement>(
      'section[id], button, [role="button"], label, [class*="accordion" i]'
    )).some(element => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return isVisible(element) && /^(?:google pay|paypal|apple pay)\b/i.test(text);
    });
    const control = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], summary, a, div'))
      .find(element => /^more payment methods$/i.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!control) {
      return { expanded: alternativesVisible, hasControl: false, x: 0, y: 0 };
    }
    control.scrollIntoView({ block: 'center' });
    const rect = control.getBoundingClientRect();
    const ariaExpanded = control.getAttribute('aria-expanded');
    return {
      expanded: ariaExpanded === 'true',
      hasControl: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }).catch((): { expanded: boolean; hasControl: boolean; x: number; y: number } | null => null);

  if (disclosure?.hasControl && !disclosure.expanded) {
    console.log(`👇 [${pageName}] Clicking "More payment methods" to expand payment options...`);
    await page.mouse.click(disclosure.x, disclosure.y);
    const expanded = await page.waitForFunction(() => {
      const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      };
      const controlExpanded = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], summary, a, div'))
        .some(element =>
          /^more payment methods$/i.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()) &&
          element.getAttribute('aria-expanded') === 'true'
        );
      const alternativesVisible = Array.from(document.querySelectorAll<HTMLElement>(
        'section[id], button, [role="button"], label, [class*="accordion" i]'
      )).some(element => {
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        return isVisible(element) && /^(?:google pay|paypal|apple pay)\b/i.test(text);
      });
      return controlExpanded || alternativesVisible;
    }, { timeout: 8000 }).then(() => true).catch(() => {
      console.warn(`⚠️ [${pageName}] "More payment methods" did not report as expanded after clicking it.`);
      return false;
    });
    return expanded;
  }

  return disclosure?.expanded ?? false;
}

export async function hasLoadedPPVArtwork(
  scope: any,
  ppvName = '',
  entitlementId = '',
  requireEventMetadata = false
): Promise<boolean> {
  const nameTerms = ppvName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 3);
  const normalizedEntitlementId = entitlementId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const media = scope.locator('img, picture, [role="img"], [style*="background-image"]');
  const count = await media.count().catch(() => 0);

  for (let index = 0; index < count; index++) {
    const candidate = media.nth(index);
    const validCandidate = await candidate.evaluate(
      (
        node: HTMLElement,
        args: { nameTerms: string[]; entitlementId: string; requireEventMetadata: boolean }
      ) => {
        const image = node instanceof HTMLImageElement
          ? node
          : node.querySelector<HTMLImageElement>('img');
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const source = [
          image?.currentSrc,
          image?.src,
          node.getAttribute('src'),
          node.getAttribute('srcset'),
          style.backgroundImage,
        ].filter(Boolean).join(' ').toLowerCase();
        const label = [
          image?.alt,
          node instanceof HTMLImageElement ? null : node.getAttribute('alt'),
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
        const searchable = [
          source,
          label,
          node.getAttribute('data-testid'),
          node.getAttribute('data-test-id'),
          node.className,
        ].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

        const isDaznPlaceholder =
          /^(?:dazn|dazn logo|placeholder|default image|image unavailable|no image)$/i.test(label) ||
          /(?:^|[\/_.-])(?:dazn[-_ ]?(?:logo|placeholder|default)|(?:placeholder|default|no[-_ ]image)[-_ ]?(?:image|artwork)?)(?:[\/_.-]|$)/i.test(source);
        if (isDaznPlaceholder) return false;

        const hasLoadedImage = image
          ? image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
          : !!style.backgroundImage && style.backgroundImage !== 'none';
        if (
          !hasLoadedImage ||
          rect.width < 80 ||
          rect.height < 45 ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          return false;
        }

        if (!args.requireEventMetadata) return true;
        return (
          (!!args.entitlementId && searchable.includes(args.entitlementId)) ||
          args.nameTerms.some(term => searchable.includes(term)) ||
          /(?:^|\s)ppv(?:\s|$)/.test(searchable)
        );
      },
      {
        nameTerms,
        entitlementId: normalizedEntitlementId,
        requireEventMetadata,
      }
    ).catch(() => false);
    if (!validCandidate) continue;

    const screenshot = await candidate.screenshot({ type: 'png' }).catch((error: Error) => {
      console.warn(`⚠️ Unable to inspect PPV artwork pixels: ${error.message}`);
      return null;
    });
    if (screenshot) {
      try {
        const jimpModule = require('jimp');
        const Jimp = jimpModule.Jimp || jimpModule;
        const image = await Jimp.read(screenshot);
        const pixels = image.bitmap.data;
        let whitePixels = 0;
        let neutralPixels = 0;
        let saturatedPixels = 0;
        let darkPixels = 0;
        const totalPixels = image.bitmap.width * image.bitmap.height;

        for (let offset = 0; offset < pixels.length; offset += 4) {
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const max = Math.max(red, green, blue);
          const min = Math.min(red, green, blue);
          if (red >= 235 && green >= 235 && blue >= 235) whitePixels++;
          if (max - min <= 18) neutralPixels++;
          if (max - min >= 45) saturatedPixels++;
          if (red <= 60 && green <= 60 && blue <= 60) darkPixels++;
        }

        const isMonochromeDaznPlaceholder =
          totalPixels > 0 &&
          whitePixels / totalPixels >= 0.45 &&
          neutralPixels / totalPixels >= 0.92 &&
          saturatedPixels / totalPixels <= 0.03 &&
          darkPixels / totalPixels >= 0.02;
        if (isMonochromeDaznPlaceholder) continue;
      } catch (error: any) {
        console.warn(`⚠️ Unable to analyse PPV artwork pixels: ${error.message}`);
      }
    }

    return true;
  }

  return false;
}

export async function shouldSkipCardEntryChecks(page: Page): Promise<boolean> {
  if (page.isClosed()) return true;

  const pageText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const hasSavedCard = /\*{4}\s*\d{2,4}|saved card|(?:visa|mastercard|amex).{0,50}(?:\bending in\b|\bexp(?:iry)?\b)/i.test(pageText);
  return !hasSavedCard;
}

// ─────────────────────────────────────────────────────────────────
// WAIT FOR SPA READY
// ─────────────────────────────────────────────────────────────────
export async function waitForSPAReady(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.waitForLoadState('domcontentloaded').catch(() => { });
}

// ─────────────────────────────────────────────────────────────────
// TRIGGER LAZY LOAD — only called explicitly after selectSport()
// ─────────────────────────────────────────────────────────────────
export async function triggerLazyLoad(page: Page): Promise<void> {
  if (page.isClosed()) return;
  const url = page.url();
  if (!url.includes('/schedule')) return;
  await page.evaluate(() => {
    const target = Math.min(
      document.body.scrollHeight,
      window.innerHeight * 3
    );
    window.scrollTo(0, target);
  }).catch(() => { });
  await sleep(150);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
}

// ─────────────────────────────────────────────────────────────────
// SETUP PAGE — single call after navigation (safety net only)
// ─────────────────────────────────────────────────────────────────
export async function setupPage(page: Page, _cookieTimeout: number = 500): Promise<void> {
  if (page.isClosed()) return;
  await handleCookies(page, _cookieTimeout);
}

// ─────────────────────────────────────────────────────────────────
// SCROLL TO CENTER
// ─────────────────────────────────────────────────────────────────
export async function scrollToCenter(
  page: Page,
  selector: string
): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, selector).catch(() => { });
}

// ─────────────────────────────────────────────────────────────────
// DOM NODE INTERFACE
// ─────────────────────────────────────────────────────────────────
export interface DOMNode {
  tag: string;
  text: string;
  classes: string;
  childCount: number;
  isInModal: boolean;
  isStrike?: boolean;
  isChecked?: boolean;
  type?: string;
  src?: string;
  href?: string;
  ariaPressed?: string;
  ariaChecked?: string;
  id?: string;
  hasCheckedSvg?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// GET PAGE SNAPSHOT — bulk DOM read in one JS call
// ─────────────────────────────────────────────────────────────────
export async function getPageSnapshot(page: Page): Promise<DOMNode[]> {
  if (page.isClosed()) return [];
  try {
    return await page.evaluate((): any[] => {
      // Initialize global __name helper to prevent ReferenceError in transpiled bundles
      const g = typeof window !== 'undefined' ? window : globalThis;
      (g as any).__name = (g as any).__name || ((target: any) => target);

      const clean = (s: string) =>
        s.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();


      const getElementClasses = (el: Element): string =>
        (el.getAttribute('class') || '')
          .trim()
          .replace(/\s+/g, ' ');


      const modalSelectors = [
        '[role="dialog" i]',
        '[aria-modal="true"]',
        '[class*="modal" i]',
        '[class*="overlay" i]',
        '[class*="popup" i]',
      ];

      const isInModal = (el: Element): boolean =>
        modalSelectors.some(sel => {
          const closest = el.closest(sel);
          return closest !== null && closest.tagName !== 'BODY' && closest.tagName !== 'HTML';
        });

      const isInInactiveSlide = (el: any): boolean => {
        const slide = el.closest('.swiper-slide, [class*="swiper-slide"]');
        if (!slide) return false;
        const isHero = el.closest([
          'main [class*="banner"]',
          'main [class*="hero"]',
          'main .swiper',
          'section[class*="banner"]',
          '[class*="heroBanner"]',
          '[class*="hero-banner"]',
        ].join(', '));
        if (!isHero) return false;
        return slide.closest('.swiper-slide-active, [class*="swiper-slide-active"]') === null;
      };

      // OPTIMIZED: avoid getComputedStyle — use offsetWidth/Height + inline style checks
      const isRendered = (el: HTMLElement): boolean => {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (!isMobile && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
        const style = el.style;
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        if (el.hidden) return false;
        if (isInInactiveSlide(el)) return false;
        return true;
      };

      // OPTIMIZED: avoid getComputedStyle — use only DOM-based checks, except for price elements
      const isStrikethrough = (el: HTMLElement): boolean => {
        if (el.closest('del, s') !== null) return true;
        if (el.closest('[style*="line-through"]') !== null) return true;
        if (el.closest('[class*="strike" i], [class*="line-through" i], [class*="crossed" i], [class*="original" i]') !== null) return true;

        // Target specifically text elements that look like prices or contain numbers
        const txt = el.textContent || '';
        if (txt.includes('£') || txt.includes('$') || txt.includes('€') || txt.includes('₹') || /\d/.test(txt)) {
          let current: HTMLElement | null = el;
          for (let depth = 0; depth < 8 && current; depth++) {
            try {
              const style = window.getComputedStyle(current);
              if (style.textDecoration.includes('line-through') || style.textDecorationLine.includes('line-through')) {
                return true;
              }
            } catch (e) { }
            current = current.parentElement;
          }
        }
        return false;
      };

      const getNonStrikeText = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent || '';
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const htmlEl = node as HTMLElement;
          const tagName = htmlEl.tagName.toUpperCase();
          if (tagName === 'SCRIPT' || tagName === 'STYLE') {
            return '';
          }
          if (isStrikethrough(htmlEl)) {
            return '';
          }
          let text = '';
          for (let i = 0; i < htmlEl.childNodes.length; i++) {
            text += getNonStrikeText(htmlEl.childNodes[i]);
          }
          return text;
        }
        return '';
      };

      const tags = [
        'button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5',
        'p', 'span', 'li', 'label',
        'small', 'time', 'strong', 'b', 'em', 'div',
        'img', 'input'
      ];

      const results: any[] = [];
      const seen = new Set<string>();
      let totalProcessed = 0;
      const MAX_ELEMENTS = 5000; // Performance budget: stop after processing this many elements

      for (const tag of tags) {
        const els = document.querySelectorAll<HTMLElement>(tag);
        for (const el of els) {
          totalProcessed++;
          if (totalProcessed > MAX_ELEMENTS) break;
          if (!isRendered(el)) continue;
          const text = isStrikethrough(el) ? clean(el.textContent || '') : clean(getNonStrikeText(el));
          const isInteractive = ['button', 'a', 'img', 'input'].includes(tag);
          if (!isInteractive && (!text || text.length < 2 || text.length > 500)) continue;
          const key = text ? `${tag}:${text}` : `${tag}:${getElementClasses(el)}:${results.length}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const hasCheckedSvg = (() => {
            const svgs = el.getElementsByTagName('svg');
            for (let i = 0; i < svgs.length; i++) {
              const svg = svgs[i];
              const classes = (svg.getAttribute('class') || '').toLowerCase();
              if (classes.includes('checked') || classes.includes('checkmark')) return true;
            }
            const children = el.getElementsByTagName('*');
            for (let i = 0; i < children.length; i++) {
              const child = children[i];
              const classes = (child.getAttribute('class') || '').toLowerCase();
              if (classes.includes('checked') || classes.includes('checkmark')) return true;
            }
            return false;
          })();

          results.push({
            tag,
            text,
            classes: getElementClasses(el),
            childCount: el.children.length,
            isInModal: isInModal(el),
            isStrike: isStrikethrough(el),
            isChecked: (el as HTMLInputElement).checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true',
            type: el.getAttribute('type') || undefined,
            src: (el as HTMLImageElement).src || el.getAttribute('src') || undefined,
            href: (el as HTMLAnchorElement).href || el.getAttribute('href') || undefined,
            ariaPressed: el.getAttribute('aria-pressed') || undefined,
            ariaChecked: el.getAttribute('aria-checked') || undefined,
            id: el.id || undefined,
            hasCheckedSvg,
          });
          if (results.length >= 2000) break;
        }
        if (results.length >= 2000 || totalProcessed > MAX_ELEMENTS) break;
      }
      return results;
    });
  } catch (err: any) {
    console.error('❌ getPageSnapshot page.evaluate failed:', err);
    return [];
  }
}
