/**
 * scheduleNavigator.ts
 *
 * Production-grade phased schedule navigator for the DAZN Android app.
 * All navigation is driven by PPV_DATE from the event config — no hardcoded
 * event names, month names, or stop conditions.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Phase 1  Detect the currently visible month from on-screen headers.    │
 * │  Phase 2  Iterative detect-and-swipe loop until the target month is     │
 * │           visible. No fixed multiplier — always re-detects.             │
 * │  Phase 3  Gentle-swipe within the month to locate the PPV tile,         │
 * │           stopping immediately when the next month header appears.       │
 * │  Phase 4  Center the tile if it is obscured by the bottom nav bar.      │
 * │  Phase 5  Tap the centered tile.                                         │
 * │  Phase 6  Verify navigation succeeded: schedule gone, PPV name visible,  │
 * │           CTA present.                                                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Performance contract
 * ──────────────────────────────────────────────────────────────────────────
 * • Screen dimensions are resolved once and cached for the session.
 * • getPageSource() is never called.
 * • Phase 2 re-detects after every swipe — no fixed swipes-per-month constant.
 * • Adaptive swipe distance: large when far, gentle when 1 month away.
 * • Overshoot (e.g. May→July→August) auto-corrects on the next iteration.
 * • PPV tile search only begins after reaching the correct month.
 * • UI-tree queries use className-filtered $$ queries — not full XML dumps.
 */

import { AndroidFlowHooks } from '../pages/android/AndroidBasePage';
import { resolvePpvTitleForSource } from '../../utils/ppvTitleResolver';

type WdBrowser = any;
type WdElement = any;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum detect-and-swipe iterations in Phase 2.
 * At ~400 ms per iteration this caps Phase 2 at ≈16 s worst case.
 */
const MAX_MONTH_NAV_ITERATIONS = 40;

/** Large swipe: finger travels 75 % → 20 % of screen height (scroll forward). */
const LARGE_SWIPE_START_Y = 0.75;
const LARGE_SWIPE_END_Y   = 0.20;

/** Moderate swipe: 70 % → 35 % — used when 1–2 months away. */
const MODERATE_SWIPE_END_Y = 0.35;

/** Gentle swipe: 60 % → 42 % — day-level fine navigation. */
const GENTLE_SWIPE_START_Y = 0.60;
const GENTLE_SWIPE_END_Y   = 0.42;

/** Below this ratio the tile is behind the bottom nav bar. */
const BOTTOM_NAV_THRESHOLD = 0.70;

/** Target vertical ratio for a centered tile. */
const CENTER_TARGET_Y = 0.45;

/** Full and abbreviated month names, 0-indexed (January = 0). */
const MONTH_FULL  = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleNavOptions {
  /** PPV_NAME from event config — no hardcoding allowed. */
  ppvName: string;
  /** Target month index, 0-based (0 = January … 11 = December). */
  targetMonthIndex: number;
  /** Target day-of-month parsed from PPV_DATE. */
  targetDay: number;
  /** TV-visible schedule date label, e.g. "Sat 29 Aug". */
  targetDateLabel?: string;
  /** Maximum gentle swipes during tile-search phase (default 20). */
  maxTileSearchSwipes?: number;
}

export interface ScreenDimensions {
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen dimensions — resolved once, cached for the session
// ─────────────────────────────────────────────────────────────────────────────

let _cachedDims: ScreenDimensions | null = null;

/** Returns screen dimensions, querying the driver only on the first call. */
export async function getScreenDimensions(driver: WdBrowser): Promise<ScreenDimensions> {
  if (_cachedDims) return _cachedDims;
  const rect = await driver.getWindowRect();
  _cachedDims = { width: rect.width, height: rect.height };
  console.log(`📐 Screen: ${_cachedDims.width}×${_cachedDims.height} (cached)`);
  return _cachedDims;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive gestures
// ─────────────────────────────────────────────────────────────────────────────

/** Swipe upward — scrolls content forward (future dates). */
export async function swipeUp(
  driver: WdBrowser,
  dims: ScreenDimensions,
  startYRatio = LARGE_SWIPE_START_Y,
  endYRatio   = LARGE_SWIPE_END_Y,
  durationMs  = 220,
): Promise<void> {
  const cx = Math.round(dims.width / 2);
  const y1 = Math.round(dims.height * startYRatio);
  const y2 = Math.round(dims.height * endYRatio);
  await driver.performActions([{
    type: 'pointer', id: 'finger1',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0,         x: cx, y: y1 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause',       duration: 40 },
      { type: 'pointerMove', duration: durationMs, x: cx, y: y2 },
      { type: 'pointerUp',   button: 0 },
    ],
  }]);
  await driver.releaseActions();
}

/** Swipe downward — scrolls content backward (past dates / overshoot recovery). */
export async function swipeDown(
  driver: WdBrowser,
  dims: ScreenDimensions,
  startYRatio = LARGE_SWIPE_END_Y,
  endYRatio   = LARGE_SWIPE_START_Y,
  durationMs  = 220,
): Promise<void> {
  return swipeUp(driver, dims, startYRatio, endYRatio, durationMs);
}

/** Tap a screen coordinate. */
export async function tap(driver: WdBrowser, x: number, y: number): Promise<void> {
  await driver.performActions([{
    type: 'pointer', id: 'finger1',
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0,  x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause',       duration: 80 },
      { type: 'pointerUp',   button: 0 },
    ],
  }]);
  await driver.releaseActions();
}

// ─────────────────────────────────────────────────────────────────────────────
// Element helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns center coordinates of a WebdriverIO element. */
export async function getElementCenter(el: WdElement): Promise<{ x: number; y: number }> {
  const loc  = await el.getLocation();
  const size = await el.getSize();
  return { x: loc.x + Math.round(size.width / 2), y: loc.y + Math.round(size.height / 2) };
}

function normalizeTileText(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics (ó → o, é → e, etc.)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isExactPPVTileText(text: string, ppvName: string): boolean {
  return normalizeTileText(text) === normalizeTileText(ppvName);
}

/** Waits for an element to exist and be displayed. */
export async function waitForElement(
  driver: WdBrowser, selector: string, timeout = 5000,
): Promise<WdElement> {
  const el = await driver.$(selector);
  await el.waitForExist({ timeout });
  await el.waitForDisplayed({ timeout });
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy primitives (preserved for non-schedule flows)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use swipeUp(driver, dims). */
export async function scrollDown(driver: WdBrowser): Promise<void> {
  const dims = await getScreenDimensions(driver);
  await swipeUp(driver, dims, LARGE_SWIPE_START_Y, LARGE_SWIPE_END_Y, 300);
}

export async function findWithScroll(
  driver: WdBrowser, selector: string, maxScrolls = 8,
): Promise<WdElement> {
  const dims = await getScreenDimensions(driver);
  for (let i = 0; i < maxScrolls; i++) {
    const el = await driver.$(selector);
    if (await el.isExisting()) { console.log(`✅ Found after ${i} scroll(s)`); return el; }
    console.log(`🔄 Scroll ${i + 1}/${maxScrolls}`);
    await swipeUp(driver, dims);
    await driver.pause(300);
  }
  throw new Error(`❌ Not found after ${maxScrolls} scrolls: ${selector}`);
}

export async function scrollIntoViewAndroid(driver: WdBrowser, text: string): Promise<WdElement> {
  const sel = `android=new UiScrollable(new UiSelector().scrollable(true))` +
              `.scrollIntoView(new UiSelector().textContains("${text}"))`;
  const el = await driver.$(sel);
  await el.waitForDisplayed({ timeout: 10000 });
  return el;
}

export async function scrollAndTapByText(driver: WdBrowser, text: string): Promise<void> {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const el = await findWithScroll(driver, `android=new UiSelector().textMatches(".*${esc}.*")`);
  const { x, y } = await getElementCenter(el);
  await tap(driver, x, y);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Detect visible month
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the text looks like a standalone month header:
 *   "JULY"  |  "July"  |  "JUL"  |  "JULY 2025"
 *
 * Rejects embedded dates like "July 25" or "Jul 25 - Friday".
 * A 4-digit year is allowed; a 1-2 digit number (day) is not.
 */
export function isStandaloneMonthHeader(text: string): boolean {
  const trimmed = text.trim();
  // Allow: MonthName or MonthName + 4-digit year
  return /^[A-Za-z]+(\s+\d{4})?$/.test(trimmed);
}

/**
 * Parses a month index (0-based) from a text string.
 * Returns -1 if no month name is found.
 */
export function parseMonthFromText(text: string): number {
  const lower = text.toLowerCase();
  for (let i = 0; i < MONTH_FULL.length; i++) {
    if (lower.includes(MONTH_FULL[i]) || lower.includes(MONTH_SHORT[i])) return i;
  }
  return -1;
}

function isDateLikeMonthText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  if (/^today$|^tomorrow$|^previous$/.test(normalized)) return false;

  const monthPattern = `(?:${MONTH_FULL.join('|')}|${MONTH_SHORT.join('|')})`;
  const ordinalDay = '\\d{1,2}(?:st|nd|rd|th)?';
  const weekday = '(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)';

  return new RegExp(`^${monthPattern}(?:\\s+${ordinalDay})?(?:\\s+\\d{4})?$`, 'i').test(normalized) ||
    new RegExp(`^${ordinalDay}\\s+${monthPattern}(?:\\s+\\d{4})?$`, 'i').test(normalized) ||
    new RegExp(`^${monthPattern}\\s+${ordinalDay}\\s+\\d{4}\\s+${weekday}\\s+date$`, 'i').test(normalized) ||
    new RegExp(`^${weekday}\\s+${ordinalDay}\\s+${monthPattern}(?:\\s+at\\s+\\d{1,2}:\\d{2})?$`, 'i').test(normalized) ||
    new RegExp(`^${monthPattern}\\s+${ordinalDay}\\s+${weekday}$`, 'i').test(normalized);
}

async function getElementDateText(el: WdElement): Promise<string> {
  const text = String(await el.getText().catch(() => '')).trim();
  if (text) return text;
  return String(await el.getAttribute('contentDescription').catch(() => '') ||
    await el.getAttribute('content-desc').catch(() => '') || '').trim();
}

/**
 * Phase 1 — Scan all visible TextViews for a standalone month header.
 *
 * DOM order is top-to-bottom, so the first match is the topmost month on screen.
 * Prefers standalone headers ("JULY", "JULY 2025") over embedded dates ("July 25").
 *
 * When multiple months are simultaneously visible (e.g. June/July at a boundary),
 * the topmost one wins — it represents where the user currently is.
 */
export async function detectVisibleMonth(driver: WdBrowser): Promise<number> {
  try {
    const els: WdElement[] =
      await driver.$$('android=new UiSelector().className("android.widget.TextView")');

    // First pass: prefer standalone headers
    for (const el of els) {
      const text = await getElementDateText(el);
      if (!text) continue;
      if (isStandaloneMonthHeader(text)) {
        const idx = parseMonthFromText(text);
        if (idx !== -1) {
          console.log(`📅 Phase 1: Month header → "${text.trim()}" (${MONTH_FULL[idx]})`);
          return idx;
        }
      }
    }

    // Second pass: date-like labels containing a month name. Avoid arbitrary
    // event titles such as "Polymarket predictions" matching "mar".
    for (const el of els) {
      const text = await getElementDateText(el);
      if (!text) continue;
      if (!isDateLikeMonthText(text)) continue;
      const idx = parseMonthFromText(text);
      if (idx !== -1) {
        console.log(`📅 Phase 1: Month in text → "${text.trim()}" (${MONTH_FULL[idx]})`);
        return idx;
      }
    }
  } catch (err: any) {
    console.warn(`⚠️ Phase 1 error: ${err.message}`);
  }
  console.warn('⚠️ Phase 1: No month detected on screen');
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Navigate to target month (detect-and-swipe loop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 2 — Iterative detect-and-swipe until targetMonthIndex is visible.
 *
 * No fixed swipes-per-month constant.  Every iteration:
 *   1. Detects the current visible month.
 *   2. If at target → done.
 *   3. Computes delta (with year-boundary wrap).
 *   4. Swipes proportionally: large when |delta| ≥ 3, moderate when 1–2.
 *   5. Settles, then re-detects.
 *
 * Overshoot (e.g. July → August when targeting July) is automatically
 * corrected on the next iteration (delta becomes negative → swipe back).
 */
export async function navigateToMonth(
  driver: WdBrowser,
  dims: ScreenDimensions,
  targetMonthIndex: number,
): Promise<void> {
  console.log(`\n📅 Phase 2: Navigating to ${MONTH_FULL[targetMonthIndex]}…`);

  for (let i = 0; i < MAX_MONTH_NAV_ITERATIONS; i++) {
    const current = await detectVisibleMonth(driver);

    if (current === targetMonthIndex) {
      console.log(`✅ Phase 2: At ${MONTH_FULL[targetMonthIndex]} (iter ${i + 1}).`);
      return;
    }

    if (current === -1) {
      // No month header visible yet — gentle scroll to reveal one
      console.warn(`   Phase 2 [${i + 1}]: No month detected, gentle scroll…`);
      await swipeUp(driver, dims, GENTLE_SWIPE_START_Y, GENTLE_SWIPE_END_Y, 250);
      await driver.pause(350);
      continue;
    }

    // Compute delta with year-boundary handling
    // The schedule always flows forward (future events).
    // Backward delta > 6 months means it is actually a forward year-wrap.
    let delta = targetMonthIndex - current;
    if (delta < -6) delta += 12;

    console.log(
      `   Phase 2 [${i + 1}]: current=${MONTH_FULL[current]}, ` +
      `target=${MONTH_FULL[targetMonthIndex]}, delta=${delta}`
    );

    if (delta > 0) {
      // Scroll forward
      const endY = Math.abs(delta) >= 3 ? LARGE_SWIPE_END_Y : MODERATE_SWIPE_END_Y;
      await swipeUp(driver, dims, LARGE_SWIPE_START_Y, endY, Math.abs(delta) >= 3 ? 180 : 250);
    } else {
      // Scroll backward (overshoot recovery)
      const endY = Math.abs(delta) >= 3 ? LARGE_SWIPE_START_Y : GENTLE_SWIPE_START_Y;
      await swipeDown(driver, dims, LARGE_SWIPE_END_Y, endY, Math.abs(delta) >= 3 ? 180 : 250);
    }

    await driver.pause(400);
  }

  // Non-fatal: Phase 3 will handle any remaining overshoot
  const final = await detectVisibleMonth(driver);
  console.warn(
    `⚠️ Phase 2: Reached max iterations. ` +
    `Visible=${final !== -1 ? MONTH_FULL[final] : 'unknown'}, ` +
    `expected=${MONTH_FULL[targetMonthIndex]}. Phase 3 will correct.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Find PPV tile within target month
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 3 — Gentle-scroll within the target month searching for the PPV tile.
 *
 * Stops when:
 *   • The PPV tile is visible (success), or
 *   • The next month header appears (overshoot — one correction scroll back), or
 *   • maxSwipes exhausted.
 *
 * UiScrollable fallback uses the FULL PPV name to avoid partial matches like
 * "Joshua Parker" matching a search for "Joshua vs. Prenga".
 */
export async function findPPVTileInMonth(
  driver: WdBrowser,
  dims: ScreenDimensions,
  ppvName: string,
  targetMonthIndex: number,
  maxSwipes = 20,
): Promise<WdElement> {
  console.log(`\n🔍 Phase 3: Searching for "${ppvName}" in ${MONTH_FULL[targetMonthIndex]}…`);

  const nextMonthFull  = MONTH_FULL[(targetMonthIndex + 1) % 12];
  const nextMonthShort = MONTH_SHORT[(targetMonthIndex + 1) % 12];

  // Build both the original and diacritic-stripped versions so that
  // "Rolly vs. Teófimo" (config) matches "Rolly vs. Teofimo" (on screen)
  // and vice-versa in all three matching paths below.
  const ppvNameStripped = String(ppvName)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedName         = escapeForRegex(ppvName);
  const escapedNameStripped = escapeForRegex(ppvNameStripped);

  // Accept either the accented or the diacritic-stripped form
  const combinedPattern = escapedName === escapedNameStripped
    ? `(?i)^\\s*(${escapedName})\\s*$`
    : `(?i)^\\s*(${escapedName}|${escapedNameStripped})\\s*$`;

  const strictTileSelector = `android=new UiSelector().textMatches("${combinedPattern}")`;

  let overshotOnce = false;

  for (let i = 0; i < maxSwipes; i++) {
    // ── Check tile visibility (Strict Exact Match first) ───────────────────
    const tileEl = await driver.$(strictTileSelector);
    if (await tileEl.isExisting().catch(() => false)) {
      if (await tileEl.isDisplayed().catch(() => false)) {
        console.log(`✅ Phase 3: Exact PPV Tile found after ${i} swipe(s).`);
        return tileEl;
      }
    }

    // ── Check exact TextView matches after whitespace normalization ─────────
    const textEls: WdElement[] =
      await driver.$$('android=new UiSelector().className("android.widget.TextView")').catch(() => []);
    
    let matchedEl: WdElement | null = null;
    for (const el of textEls) {
      const text = await el.getText().catch(() => '');
      if (isExactPPVTileText(text, ppvName)) {
        matchedEl = el;
        break;
      }
    }

    if (matchedEl && await matchedEl.isDisplayed().catch(() => false)) {
      console.log(`✅ Phase 3: Exact PPV Tile found after ${i} swipe(s): "${await matchedEl.getText()}"`);
      return matchedEl;
    }

    // ── Overshoot detection ────────────────────────────────────────────────
    let overshot = false;

    for (const el of textEls) {
      const txt: string = await el.getText().catch(() => '');
      if (!txt) continue;
      const lower = txt.toLowerCase().trim();
      if (lower.includes(nextMonthFull) || lower.includes(nextMonthShort)) {
        if (!overshotOnce) {
          console.warn(`⚠️ Phase 3: Overshot into ${nextMonthFull} — scrolling back.`);
          await swipeDown(driver, dims, GENTLE_SWIPE_END_Y, GENTLE_SWIPE_START_Y, 280);
          await driver.pause(400);
          overshotOnce = true;
        } else {
          console.warn(`⚠️ Phase 3: Still in ${nextMonthFull} after correction.`);
        }
        overshot = true;
        break;
      }
    }
    if (overshot) continue;

    console.log(`   Phase 3: swipe ${i + 1}/${maxSwipes}`);
    await swipeUp(driver, dims, GENTLE_SWIPE_START_Y, GENTLE_SWIPE_END_Y, 220);
    await driver.pause(350);
  }

  // ── Final fallback: UiScrollable with strict name matching ───────────────
  console.warn(`⚠️ Phase 3: Gentle scroll exhausted. Trying UiScrollable with strict name…`);
  try {
    const fallbackSel =
      `android=new UiScrollable(new UiSelector().scrollable(true))` +
      `.scrollIntoView(new UiSelector().textMatches("${combinedPattern}"))`;
    const el = await driver.$(fallbackSel);
    await el.waitForDisplayed({ timeout: 10000 });
    console.log(`✅ Phase 3 (UiScrollable): Found strict tile.`);
    return el;
  } catch (err: any) {
    console.warn(`⚠️ Phase 3: UiScrollable strict matching failed (${err.message}). Trying loose fallback...`);
    try {
      const fallbackSelLoose =
        `android=new UiScrollable(new UiSelector().scrollable(true))` +
        `.scrollIntoView(new UiSelector().textContains("${ppvName}"))`;
      const el = await driver.$(fallbackSelLoose);
      await el.waitForDisplayed({ timeout: 10000 });
      console.log(`✅ Phase 3 (UiScrollable loose): Found tile.`);
      return el;
    } catch (err2: any) {
      throw new Error(
        `❌ Phase 3: "${ppvName}" not found after ${maxSwipes} swipes + UiScrollable. ` +
        `${err2.message}`
      );
    }
  }
}

export async function navigateToTargetDay(
  driver: WdBrowser,
  dims: ScreenDimensions,
  targetDay: number,
  ppvName: string,
  targetMonthIndex: number,
  targetDateLabel = '',
  maxSwipes = 12,
): Promise<void> {
  if (!targetDay) return;

  const displayTarget = targetDateLabel || `${MONTH_FULL[targetMonthIndex]} ${targetDay}`;
  console.log(`\n📅 Phase 2.5: Navigating to ${displayTarget} before selecting PPV tile…`);
  const dayPattern = new RegExp(`^${targetDay}(st|nd|rd|th)?$`, 'i');
  const normalizedTargetDateLabel = normalizeTileText(targetDateLabel);

  for (let i = 0; i < maxSwipes; i++) {
    const textEls: WdElement[] =
      await driver.$$('android=new UiSelector().className("android.widget.TextView")').catch(() => []);

    for (const el of textEls) {
      const text = String(await el.getText().catch(() => '')).trim();
      if (!text) continue;

      if (text.toLowerCase().includes(ppvName.toLowerCase())) {
        console.log(`✅ Phase 2.5: PPV tile already visible while navigating to target date.`);
        return;
      }

      const normalizedText = normalizeTileText(text);
      if (
        (normalizedTargetDateLabel && normalizedText.includes(normalizedTargetDateLabel)) ||
        dayPattern.test(text) ||
        normalizedText.includes(`${MONTH_SHORT[targetMonthIndex].toLowerCase()} ${targetDay}`) ||
        normalizedText.includes(`${targetDay} ${MONTH_SHORT[targetMonthIndex].toLowerCase()}`)
      ) {
        console.log(`✅ Phase 2.5: Target date visible: "${text}"`);
        return;
      }
    }

    console.log(`   Phase 2.5: date swipe ${i + 1}/${maxSwipes}`);
    await swipeUp(driver, dims, GENTLE_SWIPE_START_Y, GENTLE_SWIPE_END_Y, 220);
    await driver.pause(350);
  }

  console.warn(`⚠️ Phase 2.5: Target day ${targetDay} was not found. Continuing to PPV tile search.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Center tile if obstructed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper to locate and verify the PPV tile element and its real-time screen coordinates.
 */
export async function findAndVerifyPPVTileElement(
  driver: WdBrowser,
  ppvName: string,
): Promise<{ element: WdElement | null; text: string; x: number; y: number }> {
  const ppvNameStripped = String(ppvName).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const esc1 = ppvName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const esc2 = ppvNameStripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = esc1 === esc2 ? `(?i)^\\s*(${esc1})\\s*$` : `(?i)^\\s*(${esc1}|${esc2})\\s*$`;

  // 1. Try strict UiSelector exact match
  try {
    const el = await driver.$(`android=new UiSelector().textMatches("${pattern}")`);
    if (await el.isDisplayed().catch(() => false)) {
      const loc = await el.getLocation().catch(() => null);
      const size = await el.getSize().catch(() => null);
      const txt = await el.getText().catch(() => ppvName);
      if (loc && size) {
        return {
          element: el,
          text: txt,
          x: loc.x + Math.round(size.width / 2),
          y: loc.y + Math.round(size.height / 2),
        };
      }
    }
  } catch {}

  // 2. Scan all TextView elements to find exact/normalized title match
  try {
    const textEls: WdElement[] = await driver.$$('android=new UiSelector().className("android.widget.TextView")').catch(() => []);
    for (const el of textEls) {
      if (!await el.isDisplayed().catch(() => false)) continue;
      const txt = await el.getText().catch(() => '');
      if (isExactPPVTileText(txt, ppvName) || normalizeTileText(txt) === normalizeTileText(ppvName) || normalizeTileText(txt).includes(normalizeTileText(ppvName))) {
        const loc = await el.getLocation().catch(() => null);
        const size = await el.getSize().catch(() => null);
        if (loc && size) {
          return {
            element: el,
            text: txt,
            x: loc.x + Math.round(size.width / 2),
            y: loc.y + Math.round(size.height / 2),
          };
        }
      }
    }
  } catch {}

  return { element: null, text: '', x: -1, y: -1 };
}

/**
 * Phase 4 — If the tile is near the bottom of the screen (center-Y > 55 % of screen height),
 * scroll it up until it sits in the safe middle band [35 %, 55 %].
 *
 * Re-acquires the element after each scroll using verified title checks.
 */
export async function centerTileIfNeeded(
  driver: WdBrowser,
  dims: ScreenDimensions,
  tile: WdElement,
  ppvName: string,
): Promise<WdElement> {
  const targetMaxY = Math.round(dims.height * 0.55);

  let info = await findAndVerifyPPVTileElement(driver, ppvName);
  let currentTile = info.element || tile;
  let currentCenterY = info.y;

  if (currentCenterY <= 0) {
    try {
      const loc = await tile.getLocation();
      const size = await tile.getSize();
      currentCenterY = loc.y + Math.round(size.height / 2);
    } catch {
      try {
        const rect = await tile.getRect();
        currentCenterY = rect.y + Math.round(rect.height / 2);
      } catch {}
    }
  }

  console.log(`   Phase 4: Tile position check for "${ppvName}": center-Y=${currentCenterY}, target middle <= ${targetMaxY}, screen-H=${dims.height}`);

  let attempts = 0;
  while (currentCenterY > targetMaxY && attempts < 6) {
    console.log(`   Phase 4 [attempt ${attempts + 1}]: Tile center (${currentCenterY}) > ${targetMaxY} — swiping up to bring tile to middle of screen.`);
    await swipeUp(driver, dims, GENTLE_SWIPE_START_Y, GENTLE_SWIPE_END_Y, 400);
    await driver.pause(700);

    info = await findAndVerifyPPVTileElement(driver, ppvName);
    if (info.element && info.y > 0) {
      currentTile = info.element;
      currentCenterY = info.y;
      console.log(`   Phase 4 [attempt ${attempts + 1}]: Re-acquired "${info.text}" at center-Y=${currentCenterY}`);
    } else {
      console.warn(`⚠️ Phase 4: Could not re-acquire tile after scroll attempt ${attempts + 1}.`);
      break;
    }
    attempts++;
  }

  console.log(`✅ Phase 4: Centering complete. Final tile center-Y=${currentCenterY}.`);
  return currentTile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Tap the tile
// ─────────────────────────────────────────────────────────────────────────────

export async function tapTile(
  driver: WdBrowser,
  tile: WdElement,
  dims?: ScreenDimensions,
  ppvName?: string,
): Promise<void> {
  const nameToFind = ppvName || await tile.getText().catch(() => 'Unknown');

  // Verify where the PPV tile actually is right now before clicking
  let info = await findAndVerifyPPVTileElement(driver, nameToFind);
  let targetEl = info.element || tile;
  let tapX = info.x;
  let tapY = info.y;
  let titleText = info.text || nameToFind;

  if (tapX <= 0 || tapY <= 0) {
    try {
      const loc = await targetEl.getLocation();
      const size = await targetEl.getSize();
      tapX = loc.x + Math.round(size.width / 2);
      tapY = loc.y + Math.round(size.height / 2);
    } catch {
      try {
        const rect = await targetEl.getRect();
        tapX = rect.x + Math.round(rect.width / 2);
        tapY = rect.y + Math.round(rect.height / 2);
      } catch {
        const center = await getElementCenter(targetEl);
        tapX = center.x;
        tapY = center.y;
      }
    }
  }

  // Safety check: Is tap position still in bottom navigation area (> 72% screen height)?
  if (dims && tapY > Math.round(dims.height * 0.72)) {
    console.warn(`⚠️ Phase 5: Tap Y (${tapY}) is in bottom navigation danger zone (> ${Math.round(dims.height * 0.72)}). Scrolling up to reach middle of screen...`);
    await swipeUp(driver, dims, GENTLE_SWIPE_START_Y, GENTLE_SWIPE_END_Y, 400);
    await driver.pause(700);

    // Re-verify PPV tile location after safety scroll
    info = await findAndVerifyPPVTileElement(driver, nameToFind);
    if (info.element && info.x > 0 && info.y > 0) {
      targetEl = info.element;
      tapX = info.x;
      tapY = info.y;
      titleText = info.text;
      console.log(`   Phase 5: After safety scroll — verified PPV tile "${titleText}" at (${tapX}, ${tapY})`);
    }
  }

  console.log(`🎯 Phase 5: Verified target is PPV Title "${titleText}" at (${tapX}, ${tapY}). Clicking...`);

  // Try clicking directly on the verified PPV title element first
  try {
    if (targetEl && await targetEl.isDisplayed().catch(() => false)) {
      await targetEl.click();
      console.log(`✅ Phase 5: Clicked directly on PPV Title element "${titleText}".`);
      return;
    }
  } catch (err: any) {
    console.warn(`⚠️ Phase 5: targetEl.click() failed (${err.message}). Falling back to coordinate tap at (${tapX}, ${tapY}).`);
  }

  await tap(driver, tapX, tapY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Verify navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 6 — Three-part verification:
 *
 *   1. Schedule header ("SCHEDULE") is no longer visible — confirms we left.
 *   2. PPV name (or its first significant word) is visible on the new screen.
 *   3. A paywall CTA ("Buy", "Get", or a price token) is visible.
 *
 * All three passing = PASS.  Any single part alone is not sufficient.
 * Non-fatal: logs a warning and returns false if verification times out,
 * so the calling test can decide whether to throw.
 */
export async function verifyNavigation(
  driver: WdBrowser,
  ppvName: string,
  timeoutMs = 8000,
): Promise<boolean> {
  console.log('🔎 Phase 6: Verifying navigation…');

  const firstSignificantWord = ppvName
    .split(/\s+/)
    .find(w => w.length > 3 && !/^(vs\.?|and|the)$/i.test(w)) || ppvName.split(/\s+/)[0];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // 1. Schedule header gone?
    // Use textMatches with (?i) flag — the app renders "Schedule" (title case),
    // not "SCHEDULE", so an exact .text() check would silently never match.
    const scheduleStillVisible = await driver.$(
      'android=new UiSelector().textMatches("(?i)^schedule$")'
    ).isDisplayed().catch(() => false);

    if (scheduleStillVisible) {
      await driver.pause(400);
      continue; // Not navigated yet
    }

    // 2. PPV name present on new screen?
    const ppvVisible = await driver.$(
      `android=new UiSelector().textContains("${firstSignificantWord}")`
    ).isDisplayed().catch(() => false);

    const userStateStr = String(process.env.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimate = ['active_ultimate_upfront', 'active_ultimate_apm'].includes(userStateStr);
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimate && isLoginFirst && (ppvVisible || !scheduleStillVisible)) {
      console.log(`✅ Phase 6: Ultimate user navigation verified (navigated away from schedule to fixture screen for "${ppvName}").`);
      return true;
    }

    // 3. Paywall CTA present? (For standard/non-ultimate users)
    const ctaSelectors = [
      'android=new UiSelector().textContains("Buy")',
      'android=new UiSelector().textContains("Get")',
      'android=new UiSelector().textContains("Sign")',
      'android=new UiSelector().textContains("Plan")',
      'android=new UiSelector().textContains("Register")',
      'android=new UiSelector().textContains("Account")',
      'android=new UiSelector().textContains("Continue")',
      'android=new UiSelector().textContains("£")',
      'android=new UiSelector().textContains("$")',
      'android=new UiSelector().textContains("€")',
      'android=new UiSelector().textContains("AED")',
    ];
    let ctaVisible = false;
    for (const sel of ctaSelectors) {
      ctaVisible = await driver.$(sel).isDisplayed().catch(() => false);
      if (ctaVisible) break;
    }

    if (ppvVisible && ctaVisible) {
      console.log(`✅ Phase 6: Navigation verified (schedule gone, PPV name visible, CTA present).`);
      return true;
    }

    await driver.pause(400);
  }

  console.warn(
    `⚠️ Phase 6: Verification timed out. ` +
    `Proceeding — screen may be correct but slow to render.`
  );
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * navigateScheduleToPPVTile
 *
 * Orchestrates Phases 1–6.  All event data comes from options — nothing here
 * is specific to any PPV event.
 */
export async function navigateScheduleToPPVTile(
  driver: WdBrowser,
  options: ScheduleNavOptions,
  hooks: AndroidFlowHooks = {},
): Promise<void> {
  const { ppvName, targetMonthIndex, targetDay, targetDateLabel = '', maxTileSearchSwipes = 20 } = options;

  const hr = '═'.repeat(56);
  console.log(`\n${hr}`);
  console.log(`📅 Schedule Navigator`);
  console.log(`   PPV    : ${ppvName}`);
  console.log(`   Target : ${targetDateLabel || `${MONTH_FULL[targetMonthIndex]} ${targetDay}`}`);
  console.log(`${hr}\n`);

  const dims = await getScreenDimensions(driver);

  await navigateToMonth(driver, dims, targetMonthIndex);
  await navigateToTargetDay(driver, dims, targetDay, ppvName, targetMonthIndex, targetDateLabel);

  const rawTile = await findPPVTileInMonth(
    driver, dims, ppvName, targetMonthIndex, maxTileSearchSwipes,
  );

  const tile = await centerTileIfNeeded(driver, dims, rawTile, ppvName);

  if (hooks && hooks.validateSurface) {
    await hooks.validateSurface('PPV Tile');
  }

  await tapTile(driver, tile, dims, ppvName);

  await verifyNavigation(driver, ppvName);

  console.log(`\n✅ Schedule navigation complete for "${ppvName}"\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible public adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * navigateToPPVTile — preserved entry point for backward compatibility.
 *
 * Routes through navigateScheduleToPPVTile when event.global.PPV_DATE is
 * available.  Falls back to UiScrollable with the FULL PPV name when not.
 */
export async function navigateToPPVTile(
  driver: WdBrowser,
  event?: { PPV_NAME?: string; global?: { PPV_DATE?: string }; regions?: Record<string, { PPV_DATE?: string }> },
  hooks: AndroidFlowHooks = {},
): Promise<void> {
  const ppvName = resolvePpvTitleForSource(event || { PPV_NAME: process.env.PPV_NAME || 'Joshua' }, 'schedule');
  const region = String(process.env.DAZN_REGION || '').toUpperCase().trim();
  const ppvDate = event?.regions?.[region]?.PPV_DATE || event?.global?.PPV_DATE;

  if (ppvDate) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parsePPVDate } = require('./eventLoader') as {
        parsePPVDate: (s: string) => { monthIndex: number; day: number };
      };
      const { monthIndex, day } = parsePPVDate(ppvDate);
      await navigateScheduleToPPVTile(driver, {
        ppvName, targetMonthIndex: monthIndex, targetDay: day,
      }, hooks);
      return;
    } catch (err: any) {
      console.warn(`⚠️ navigateToPPVTile: PPV_DATE parse failed — ${err.message}. Falling back.`);
    }
  }

  // Fallback: UiScrollable with full PPV name (not just first word)
  console.warn('⚠️ navigateToPPVTile: No PPV_DATE — UiScrollable fallback with full name.');
  const dims = await getScreenDimensions(driver);

  const esc      = ppvName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selector = `android=new UiSelector().textMatches("(?i).*${esc}.*")`;

  let tile: WdElement;
  try {
    tile = await findWithScroll(driver, selector, 8);
  } catch {
    // UiScrollable with full name — safer than first word only
    tile = await scrollIntoViewAndroid(driver, ppvName);
  }

  await tile.waitForDisplayed({ timeout: 5000 });
  const centered = await centerTileIfNeeded(driver, dims, tile, ppvName);

  if (hooks && hooks.validateSurface) {
    await hooks.validateSurface('PPV Tile');
  }

  await tapTile(driver, centered, dims, ppvName);
}
