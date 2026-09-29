import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────
// FAILURE SCREENSHOT CAPTURE
// For each FAILED field on the currently-displayed page, re-locate the
// element by its rendered text, draw a red box around it, and capture a
// screenshot. The screenshot path is attached to the result object so the
// HTML/PDF report can embed it as evidence.
// Must be called while the page is still on the validated screen
// (i.e. before the flow navigates away).
// ─────────────────────────────────────────────────────────────────

const SHOTS_DIR = path.resolve(process.cwd(), 'test-results', 'failure-shots');
const FAILURE_BANNER_MARKER = 'data-ppv-failure-banner';
const FAILURE_FIELD_MARKER = 'data-ppv-failure-field-target';
const BANNER_ROOT_SELECTORS = [
  'main [class*="hero-banner" i]',
  'main [class*="heroBanner" i]',
  'main [class*="herobanner" i]',
  'main div.heroBannerSlider',
  'main [class*="bannersContainer" i]',
  'main [class*="hero-slider" i]',
  'main [class*="heroSlider" i]',
  'main [class*="hero" i] .swiper',
  'main [class*="banner" i] .swiper',
  'main .swiper-container',
].join(', ');

// Values that are not real on-screen text and so can't be boxed directly
const NON_TEXT = new Set(['n/a', 'na', 'yes', 'no', 'true', 'false', '', '—']);

function matchCandidates(result: any): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    let s = String(raw ?? '').replace(/​/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return;
    // Configs use "a|b" to list acceptable alternatives — take the first
    if (s.includes('|')) s = s.split('|')[0].trim();
    if (NON_TEXT.has(s.toLowerCase())) return;
    if (s.length < 2) return;

    if (!out.includes(s)) out.push(s);

    // If it contains newlines or punctuation, try pushing parts
    const parts = s.split(/[\n\r\-–—:•]+/).map(p => p.trim()).filter(p => p.length >= 4);
    for (const part of parts) {
      if (!out.includes(part)) out.push(part);
    }

    // Try first 4 words for long strings
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length > 4) {
      const shortPhrase = words.slice(0, 4).join(' ');
      if (!out.includes(shortPhrase) && shortPhrase.length >= 4) {
        out.push(shortPhrase);
      }
    }
  };
  // Prefer the ACTUAL rendered value (it is what's on the page), then expected
  push(result.actual);
  push(result.expected);
  return out;
}

function safeName(s: string): string {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);
}

async function findTarget(page: any, candidates: string[]): Promise<any | null> {
  for (const text of candidates) {
    try {
      const locator = page.getByText(text, { exact: false });
      const count = await locator.count().catch(() => 0);
      let best: any = null;
      let bestArea = Infinity;
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        if (!await item.isVisible().catch(() => false)) continue;
        // getByText can match both a small date tag and its whole banner parent.
        // Prefer the smallest visible match so the marker surrounds the field.
        const box = await item.boundingBox().catch(() => null);
        const area = box ? box.width * box.height : Infinity;
        if (area > 0 && area < bestArea) {
          best = item;
          bestArea = area;
        }
      }
      if (best) return best;
    } catch { /* try next candidate */ }
  }
  return null;
}

// A payment summary contains the PPV price twice: once beside the PPV name
// and once beside "Today you pay".  Generic text matching always picks the
// first occurrence, which made failure evidence box the wrong price.  Scope
// this field to the price in the same row as the Today-you-pay label.
async function findTodayYouPayPriceTarget(page: any): Promise<any | null> {
  const marked = await page.evaluate((marker: string) => {
    const clean = (value: string | null | undefined) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const isPrice = (value: string) => /^(?:(?:AED\s?|[£$€₹])\s*\d+(?:[.,]\d{2})?|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr)$/.test(clean(value));

    document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
    const labels = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,span,strong,b,div'))
      .filter(el => isVisible(el) && el.children.length <= 2 && /^today\s+you\s+pay$/i.test(clean(el.innerText || el.textContent)));
    for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      let parent: HTMLElement | null = label.parentElement;
      for (let depth = 0; depth < 6 && parent; depth++, parent = parent.parentElement) {
        const prices = Array.from(parent.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,span,strong,b,div'))
          .filter(el => isVisible(el) && el.children.length === 0 && !el.closest('del,s'))
          .map(el => ({ el, rect: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent) }))
          .filter(item => isPrice(item.text) && item.rect.top >= labelRect.top - 8);
        if (prices.length) {
          prices.sort((a, b) => {
            const aDistance = Math.abs(a.rect.top - labelRect.top) + Math.abs(a.rect.left - labelRect.left) / 100;
            const bDistance = Math.abs(b.rect.top - labelRect.top) + Math.abs(b.rect.left - labelRect.left) / 100;
            return aDistance - bDistance;
          });
          prices[0].el.setAttribute(marker, 'true');
          return true;
        }
      }
    }
    return false;
  }, FAILURE_FIELD_MARKER).catch(() => false);

  if (!marked) return null;
  const target = page.locator(`[${FAILURE_FIELD_MARKER}="true"]`).first();
  await target.waitFor({ state: 'visible', timeout: 1000 }).catch(() => { });
  return target;
}

async function findBoxingUpcomingDateTarget(
  page: any,
  field: string,
  candidates: string[],
  context?: Record<string, any>
): Promise<any | null> {
  const source = String(context?.SOURCE || context?.source || '').toLowerCase();
  const fieldKey = String(field || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (source !== 'boxing-upcoming-fights' || !fieldKey.includes('date')) return null;

  const ppvName = String(context?.PPV_NAME || context?.PPV_DISPLAY_NAME || '').trim();
  if (!ppvName) return null;

  const marked = await page.evaluate(({ marker, ppvName, candidates }: {
    marker: string;
    ppvName: string;
    candidates: string[];
  }) => {
    const clean = (value: string | null | undefined) =>
      String(value ?? '').replace(/\s+/g, ' ').trim();
    const normalise = (value: string) =>
      clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const words = normalise(ppvName)
      .replace(/\bppv\b/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2);
    const wantedDates = candidates
      .map(normalise)
      .filter(value => /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(value));

    document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
    if (!words.length || !wantedDates.length) return false;

    const elements = Array.from(document.querySelectorAll<HTMLElement>('article, li, section, div'));
    let best: HTMLElement | null = null;
    let bestArea = Infinity;

    for (const el of elements) {
      if (!isVisible(el)) continue;
      const text = clean(el.innerText || el.textContent);
      if (text.length < 10 || text.length > 800) continue;
      const normalizedText = normalise(text);
      const nameHits = words.filter(word => normalizedText.includes(word)).length;
      if (nameHits < Math.min(2, words.length)) continue;

      const dateNodes = Array.from(el.querySelectorAll<HTMLElement>('time, span, p, div, strong, b'))
        .filter(node => isVisible(node) && node.children.length === 0)
        .map(node => ({ node, text: clean(node.innerText || node.textContent), rect: node.getBoundingClientRect() }))
        .filter(item => {
          const textKey = normalise(item.text);
          const looksLikeDate = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(textKey) &&
            /\b\d{1,2}\b/.test(textKey);
          return item.text.length <= 30 && looksLikeDate &&
            wantedDates.some(date => textKey === date || textKey.includes(date) || date.includes(textKey));
        });

      for (const item of dateNodes) {
        const area = item.rect.width * item.rect.height;
        if (area > 0 && area < bestArea) {
          best = item.node;
          bestArea = area;
        }
      }
    }

    if (!best) return false;
    best.setAttribute(marker, 'true');
    return true;
  }, { marker: FAILURE_FIELD_MARKER, ppvName, candidates }).catch(() => false);

  if (!marked) return null;
  const target = page.locator(`[${FAILURE_FIELD_MARKER}="true"]`).first();
  await target.waitFor({ state: 'visible', timeout: 1000 }).catch(() => { });
  return target;
}

async function findPpvTitleTarget(page: any, field: string, candidates: string[]): Promise<any | null> {
  const fieldKey = String(field || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!['event name', 'ppv name', 'ppv card title'].includes(fieldKey)) return null;

  const marked = await page.evaluate(({ marker, fieldKey, candidates }: {
    marker: string;
    fieldKey: string;
    candidates: string[];
  }) => {
    const clean = (value: string | null | undefined) =>
      String(value ?? '').replace(/\s+/g, ' ').trim();
    const comparable = (value: string) =>
      clean(value)
        .replace(/\bppv\b/gi, '')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const wanted = candidates
      .map(comparable)
      .filter(value => value.length > 2);
    if (!wanted.length) return false;

    document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));

    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0';
    };

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(
      'h1,h2,h3,h4,h5,p,span,strong,b,div'
    ));

    let best: HTMLElement | null = null;
    let bestScore = -Infinity;

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = clean(node.innerText || node.textContent);
      if (text.length < 2 || text.length > 100) continue;

      const normalizedText = comparable(text);
      const isMatch = wanted.some(value =>
        normalizedText === value ||
        (normalizedText.includes(value) && normalizedText.length <= value.length + 20)
      );
      if (!isMatch) continue;

      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const fontSize = Number.parseFloat(style.fontSize || '0') || 0;
      const parentText = clean((node.parentElement?.innerText || node.parentElement?.textContent || '')).toLowerCase();
      const grandText = clean((node.parentElement?.parentElement?.innerText || node.parentElement?.parentElement?.textContent || '')).toLowerCase();
      const surroundingText = `${parentText} ${grandText}`;
      const nearPpvDetails = /(?:AED\s?|[£$€₹]\s?)\d|\d[\d\s]*(?:[.,]\d{2,3})?\s*kr|\/fight|\b(?:sun|mon|tue|wed|thu|fri|sat)day?\b|\b\d{1,2}:\d{2}\b/i.test(surroundingText);
      const nearCardCopy = surroundingText.includes('just the fight') || surroundingText.includes('pay-per-view');

      let score = 100;
      score -= rect.top / 100;

      if (fieldKey === 'ppv card title') {
        score += fontSize * 8;
        if (nearCardCopy) score += 40;
        if (nearPpvDetails) score -= 20;
      } else {
        if (nearPpvDetails) score += 70;
        score -= fontSize * 2;
        if (fieldKey === 'event name' && /\b(?:sun|mon|tue|wed|thu|fri|sat)day?\b|\b\d{1,2}:\d{2}\b/i.test(surroundingText)) {
          score += 25;
        }

      }

      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    if (!best) return false;
    best.setAttribute(marker, 'true');
    return true;
  }, { marker: FAILURE_FIELD_MARKER, fieldKey, candidates }).catch(() => false);

  if (!marked) return null;
  const target = page.locator(`[${FAILURE_FIELD_MARKER}="true"]`).first();
  await target.waitFor({ state: 'visible', timeout: 1000 }).catch(() => { });
  return target;
}

async function findStandalonePageHeadingTarget(
  page: any,
  field: string,
  context?: Record<string, any>
): Promise<any | null> {
  const fieldKey = String(field || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (fieldKey !== 'page heading') return null;

  const titlePrefix = String(
    context?.PPV_DISPLAY_NAME || context?.PPV_CARD_TITLE || context?.PPV_NAME || ''
  ).split(/[:\-–]/)[0].trim();

  const marked = await page.evaluate(({ marker, titlePrefix }: { marker: string; titlePrefix: string }) => {
    document.querySelectorAll(`[${marker}]`).forEach(element => element.removeAttribute(marker));
    const normalizedPrefix = titlePrefix.toLowerCase();
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, p, span, div'))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (!normalizedPrefix || text.includes(normalizedPrefix)) &&
          /free trial|free with an annual plan/i.test(text);
      })
      .map(element => {
        const rect = element.getBoundingClientRect();
        const fontSize = Number.parseFloat(window.getComputedStyle(element).fontSize) || 0;
        return { element, fontSize, area: rect.width * rect.height, textLength: (element.innerText || '').trim().length };
      })
      .sort((a, b) =>
        b.fontSize - a.fontSize ||
        a.textLength - b.textLength ||
        b.area - a.area
      );

    if (!candidates.length) return false;
    candidates[0].element.setAttribute(marker, 'true');
    return true;
  }, { marker: FAILURE_FIELD_MARKER, titlePrefix }).catch(() => false);

  if (!marked) return null;
  const heading = page.locator(`[${FAILURE_FIELD_MARKER}="true"]`).first();
  return await heading.isVisible({ timeout: 1000 }).catch(() => false) ? heading : null;
}

async function findHomeBoxingUpcomingCtaTarget(
  page: any,
  field: string,
  candidates: string[],
  context?: Record<string, any>
): Promise<any | null> {
  const source = String(context?.SOURCE || context?.source || '').toLowerCase();
  if (source !== 'home-boxing-upcoming') return null;

  const fieldKey = String(field || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/(fight card|buy now|cta|button)/i.test(fieldKey)) return null;

  const ppvName = String(context?.PPV_NAME || context?.PPV_DISPLAY_NAME || '').trim();
  if (!ppvName) return null;

  const marked = await page.evaluate(({ marker, ppvName, candidates }: {
    marker: string;
    ppvName: string;
    candidates: string[];
  }) => {
    const clean = (value: string | null | undefined) =>
      String(value ?? '').replace(/\s+/g, ' ').trim();
    const normalise = (value: string) =>
      clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const words = normalise(ppvName)
      .replace(/\bppv\b/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2);
    const nameParts = ppvName
      .split(/[:\-–]/)
      .map(part => normalise(part).split(/\s+/).filter(word => word.length > 2))
      .filter(partWords => partWords.length > 0);
    const buttonTexts = candidates
      .map(normalise)
      .filter(value => value && !['yes', 'no', 'n a', 'na'].includes(value));

    if (!words.length && !nameParts.length) return false;
    document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));

    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
    };
    const matchesName = (text: string) => {
      const normalisedText = normalise(text);
      return nameParts.some(partWords => partWords.every(word => normalisedText.includes(word))) ||
        words.every(word => normalisedText.includes(word));
    };
    const matchesButton = (text: string) => {
      const normalisedText = normalise(text);
      return buttonTexts.some(candidate => normalisedText.includes(candidate)) ||
        /fight card|buy now/.test(normalisedText);
    };

    const roots = Array.from(document.querySelectorAll<HTMLElement>(
      'article, li, [class*="card" i], [class*="tile" i], [class*="event" i], main div'
    ));

    let bestRoot: HTMLElement | null = null;
    let bestScore = -Infinity;
    for (const root of roots) {
      if (!isVisible(root)) continue;
      const rect = root.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 50 || rect.width > 1800 || rect.height > 900) continue;

      const text = clean(root.innerText || root.textContent);
      if (!matchesName(text)) continue;

      const actions = Array.from(root.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
        .filter(action => isVisible(action) && matchesButton(clean(action.innerText || action.textContent)));
      if (!actions.length) continue;

      const normalisedText = normalise(text);
      const nameScore = words.filter(word => normalisedText.includes(word)).length * 20;
      const score = nameScore + actions.length * 10 - (rect.width * rect.height) / 100000;
      if (score > bestScore) {
        bestRoot = root;
        bestScore = score;
      }
    }

    if (!bestRoot) return false;

    const target = Array.from(bestRoot.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
      .filter(action => isVisible(action) && matchesButton(clean(action.innerText || action.textContent)))
      .sort((a, b) => {
        const aText = normalise(clean(a.innerText || a.textContent));
        const bText = normalise(clean(b.innerText || b.textContent));
        const aExact = buttonTexts.some(candidate => aText === candidate) ? 1 : 0;
        const bExact = buttonTexts.some(candidate => bText === candidate) ? 1 : 0;
        return bExact - aExact;
      })[0];

    if (!target) return false;
    target.setAttribute(marker, 'true');
    return true;
  }, { marker: FAILURE_FIELD_MARKER, ppvName, candidates }).catch(() => false);

  if (!marked) return null;
  const target = page.locator(`[${FAILURE_FIELD_MARKER}="true"]`).first();
  await target.waitFor({ state: 'visible', timeout: 1000 }).catch(() => { });
  return target;
}

/**
 * Banner carousels may rotate after validation but before a failure screenshot
 * is taken. Re-select the PPV slide and mark it so evidence is scoped to the
 * content that was actually validated, not the currently active promotion.
 */
async function activatePpvBannerForEvidence(page: any, ppvName: string): Promise<any | null> {
  const activated = await page.evaluate(({ marker, name, selector }: {
    marker: string;
    name: string;
    selector: string;
  }) => {
    const words = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !/^\d+$/.test(word));
    if (!words.length) return false;

    document.querySelectorAll(`[${marker}]`).forEach(node => node.removeAttribute(marker));
    const roots = Array.from(document.querySelectorAll(selector)) as HTMLElement[];

    for (const root of roots) {
      const slides = Array.from(
        root.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate)')
      ) as HTMLElement[];
      const target = slides.find(slide => {
        const text = (slide.innerText || slide.textContent || '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, ' ')
          .replace(/\s+/g, ' ');
        return words.every(word => text.includes(word));
      });
      if (!target) continue;

      const swiperElement = [root, ...Array.from(
        root.querySelectorAll<HTMLElement>('.swiper, .swiper-container, [class*="swiper" i]')
      )].find((element: any) => element.swiper);
      const swiper = (swiperElement as any)?.swiper;
      if (!swiper) continue;

      const logicalIndex = Number(target.getAttribute('data-swiper-slide-index'));
      const slideIndex = slides.indexOf(target);
      try { swiper.autoplay?.stop(); } catch { }
      if (Number.isInteger(logicalIndex) && typeof swiper.slideToLoop === 'function') {
        swiper.slideToLoop(logicalIndex, 0);
      } else {
        swiper.slideTo(slideIndex, 0);
      }
      target.setAttribute(marker, 'true');
      return true;
    }
    return false;
  }, { marker: FAILURE_BANNER_MARKER, name: ppvName, selector: BANNER_ROOT_SELECTORS }).catch(() => false);

  if (!activated) return null;

  const target = page.locator(`[${FAILURE_BANNER_MARKER}]`).last();
  for (let attempt = 0; attempt < 5; attempt++) {
    const active = await target.evaluate((node: HTMLElement) =>
      node.classList.contains('swiper-slide-active')
    ).catch(() => false);
    if (active) break;
    await page.waitForTimeout(200);
  }
  if (!await target.evaluate((node: HTMLElement) => node.classList.contains('swiper-slide-active')).catch(() => false)) {
    return null;
  }
  console.log(`✅ [Fail Shot] Re-activated PPV banner "${ppvName}" before evidence capture.`);
  return target;
}

async function findPopupContainer(page: any): Promise<any | null> {
  const selectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="content-promotion" i]',
    '[class*="modal-dialog" i]',
    '[class*="modal" i]',
    '[class*="popup" i]',
  ];

  let best: any = null;
  let bestScore = -Infinity;
  let bestArea = Infinity;

  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 80); i++) {
      const candidate = loc.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;

      const info = await candidate.evaluate((el: HTMLElement) => {
        const clean = (value: string | null | undefined) =>
          String(value ?? '').replace(/\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        const text = clean(el.innerText || el.textContent).toLowerCase();
        const classText = clean(el.className as any).toLowerCase();
        const area = rect.width * rect.height;
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        let score = 0;

        if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') score += 35;
        if (classText.includes('modal-dialog') || classText.includes('content-promotion')) score += 45;
        if (classText.includes('modal') || classText.includes('popup')) score += 15;
        if (text.includes('buy now')) score += 60;
        if (el.querySelector('img')) score += 15;
        if (el.querySelector('button, a')) score += 12;
        if (el.querySelector('[aria-label*="close" i], [class*="close" i]')) score += 8;
        if (rect.width < 180 || rect.height < 120) score -= 80;
        if (area > viewportArea * 0.7) score -= 70;
        else score += 30;
        if (classText.includes('header') || classText.includes('nav') || classText.includes('menu')) score -= 100;

        return { score, area };
      }).catch(() => null);

      if (!info || info.score < 20) continue;
      if (info.score > bestScore || (info.score === bestScore && info.area < bestArea)) {
        best = candidate;
        bestScore = info.score;
        bestArea = info.area;
      }
    }
  }

  return best;
}

async function findPopupTarget(page: any, candidates: string[]): Promise<any | null> {
  const popup = await findPopupContainer(page);
  if (!popup) return null;

  for (const text of candidates) {
    try {
      const locator = popup.getByText(text, { exact: false });
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

export async function captureFailures(
  page: any,
  results: any[],
  pageName: string,
  context?: Record<string, any>
): Promise<void> {
  if (!page || page.isClosed()) return;

  const fails = results.filter(
    (r) => r && r.page === pageName && r.status === 'FAIL' && !r.__shotDone
  );
  if (!fails.length) return;

  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

  for (const r of fails) {
    r.__shotDone = true; // mark so we don't re-capture if called again
    const field = r.field || 'field';
    const file = path.join(
      SHOTS_DIR,
      `${safeName(pageName)}_${safeName(field)}_${Date.now()}.png`
    );

    let handle: any = null;
    let overlayId: string | null = null;
    try {
      const candidates = matchCandidates(r);
      const isPopupField = String(field).toLowerCase().replace(/\s+/g, ' ').trim().startsWith('popup');
      const isBannerField = String(field).toLowerCase().includes('banner');
      const source = String(context?.SOURCE || context?.source || '').toLowerCase();
      const ppvName = String(context?.PPV_NAME || context?.PPV_DISPLAY_NAME || '').trim();
      const isTileSource = source.includes('tile') || source.includes('dont-miss') ||
        source.includes('upcoming') || source.includes('rail');
      const popup = isTileSource ? await findPopupContainer(page) : null;
      const tilePopupOpen = !!popup;
      const banner = isBannerField && source.includes('banner') && ppvName
        ? await activatePpvBannerForEvidence(page, ppvName)
        : null;
      const normalizedField = String(field).toLowerCase().replace(/\s+/g, ' ').trim();
      const isHomeBoxingUpcomingCtaField =
        source === 'home-boxing-upcoming' &&
        /(fight card|buy now|cta|button)/i.test(normalizedField);

      // A missing separator has no rendered text to locate. Highlight the
      // nearest CTA group containing both banner buttons instead.
      let orSeparatorTarget: any = null;
      if (normalizedField === 'or separator' && source.includes('banner')) {
        const bannerCtas = page.locator(BANNER_ROOT_SELECTORS).first().locator('button, a');
        if (await bannerCtas.count().catch(() => 0) >= 2) {
          const ctaGroup = bannerCtas.first()
            .locator('xpath=ancestor::*[count(.//button | .//a) >= 2][1]');
          if (await ctaGroup.isVisible().catch(() => false)) {
            orSeparatorTarget = ctaGroup;
          }
        }
      }

      // Tile fields were captured before the click. Once a tile popup is open,
      // do not hunt for those fields in the dimmed page: the same event can be
      // present in the hero banner and scrollIntoView would replace the tile
      // evidence with an unrelated banner screenshot.
      const target = tilePopupOpen && !isPopupField
        ? null
        : normalizedField === 'or separator'
          ? orSeparatorTarget
        : isHomeBoxingUpcomingCtaField
          ? await findHomeBoxingUpcomingCtaTarget(page, field, candidates, context)
          : (normalizedField === 'today you pay price'
          ? await findTodayYouPayPriceTarget(page)
          : null) ||
          await findBoxingUpcomingDateTarget(page, field, candidates, context) ||
          (isPopupField ? await findPopupTarget(page, candidates) : null) ||
          (isPopupField && popup ? await findTarget(popup, candidates) : null) ||
          await findStandalonePageHeadingTarget(page, field, context) ||
          await findPpvTitleTarget(page, field, candidates) ||
          (banner ? await findTarget(banner, candidates) : null) ||
          await findTarget(page, candidates);

      if (tilePopupOpen && !isPopupField) {
        console.log(`ℹ️ [Fail Shot] Keeping tile-popup background fixed for "${field}"; no background target will be highlighted.`);
      }

      if (target) {
        console.log(`🎯 [Fail Shot] Highlight target found for field "${field}": "${(await target.textContent().catch(() => '')).trim().substring(0, 50)}"`);
        await target.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });
        handle = await target.elementHandle().catch(() => null);
        if (handle) {
          // Draw a red highlight box around the failing element
          await page.evaluate((el: HTMLElement) => {
            (el as any).__prevOutline = el.style.outline;
            (el as any).__prevShadow = el.style.boxShadow;
            (el as any).__prevOffset = el.style.outlineOffset;
            (el as any).__prevBackground = el.style.backgroundColor;
            el.style.setProperty('outline', '4px solid #ff1744', 'important');
            el.style.setProperty('outline-offset', '2px', 'important');
            el.style.setProperty('box-shadow', '0 0 0 4px rgba(255,23,68,0.35)', 'important');
            el.style.setProperty('background-color', 'rgba(255, 23, 68, 0.2)', 'important');
            el.scrollIntoView({ block: 'center', inline: 'center' });
          }, handle).catch(() => { });
          await page.waitForTimeout(150);
        }

        const box = await target.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          overlayId = `ppv-failure-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          await page.evaluate(({ id, rect }: {
            id: string;
            rect: { x: number; y: number; width: number; height: number };
          }) => {
            document.getElementById(id)?.remove();
            const marker = document.createElement('div');
            marker.id = id;
            marker.setAttribute('data-ppv-failure-marker', 'true');
            Object.assign(marker.style, {
              position: 'fixed',
              left: `${Math.max(0, rect.x - 4)}px`,
              top: `${Math.max(0, rect.y - 4)}px`,
              width: `${Math.max(24, rect.width + 8)}px`,
              height: `${Math.max(24, rect.height + 8)}px`,
              border: '4px solid #ff1744',
              borderRadius: '4px',
              boxSizing: 'border-box',
              background: 'rgba(255, 23, 68, 0.18)',
              zIndex: '2147483647',
              pointerEvents: 'none',
            });
            document.body.appendChild(marker);
          }, {
            id: overlayId,
            rect: box,
          }).catch(() => { });
          await page.waitForTimeout(100);
        }
      }

      // Remove any overflow:hidden that causes dark/clipped screenshots
      await page.evaluate(() => {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      }).catch(() => { });
      await page.waitForTimeout(100);
      // Viewport screenshot (element is centered & boxed when found)
      await page.screenshot({ path: file, fullPage: false }).catch(() => { });
      if (fs.existsSync(file)) {
        r.screenshot = file;
        console.log(`📸 [Fail Shot] ${pageName} · ${field} → ${file}`);
      }
    } catch (e: any) {
      console.warn(`⚠️  [Fail Shot] could not capture "${field}": ${e?.message || e}`);
    } finally {
      // Always remove the highlight so later screenshots aren't polluted
      if (handle) {
        await page.evaluate((el: HTMLElement) => {
          el.style.outline = (el as any).__prevOutline || '';
          el.style.boxShadow = (el as any).__prevShadow || '';
          el.style.outlineOffset = (el as any).__prevOffset || '';
          el.style.backgroundColor = (el as any).__prevBackground || '';
        }, handle).catch(() => { });
      }
      if (overlayId) {
        await page.evaluate((id: string) => document.getElementById(id)?.remove(), overlayId).catch(() => { });
      }
      await page.locator(`[${FAILURE_BANNER_MARKER}]`).evaluateAll((nodes: Element[]) => {
        nodes.forEach((node: Element) => node.removeAttribute(FAILURE_BANNER_MARKER));
      }).catch(() => { });
      await page.locator(`[${FAILURE_FIELD_MARKER}]`).evaluateAll((nodes: Element[]) => {
        nodes.forEach((node: Element) => node.removeAttribute(FAILURE_FIELD_MARKER));
      }).catch(() => { });
    }
  }
}
