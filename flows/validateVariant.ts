import { resolveExpected }          from '../utils/resolveExpected';
import { getActualValue }           from '../utils/getActualValue';
import { compare }                  from '../utils/compare';
import { getPageSnapshot, DOMNode, stabilisePage } from '../utils/helpers';
import { captureFailures }          from '../utils/failureCapture';

async function getVisibleTextList(locator: any): Promise<string[]> {
  try {
    return await locator.evaluate((el: HTMLElement) => {
      (globalThis as any).__name = (f: any, n: string) => f;

      const clean = (s: string) => s.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
      const texts: string[] = [];
      const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = clean(node.textContent || '');
          if (t.length > 0) texts.push(t);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const htmlEl = node as HTMLElement;
          const tag = htmlEl.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE') return;
          const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
          if (!isMobile && htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) return;
          for (let i = 0; i < htmlEl.childNodes.length; i++) {
            walk(htmlEl.childNodes[i]);
          }
        }
      };
      walk(el);
      return texts;
    });
  } catch {
    return [];
  }
}

async function capturePreValidationState(
  page: any,
  pageName: string,
  eventData: Record<string, string>,
): Promise<void> {
  const source = (eventData.SOURCE || eventData.source || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const mode = String(eventData.MOBILE_WEB_HANDOFF || '').toLowerCase() === 'true'
    ? 'android-handoff'
    : 'desktop-web';
  const safePageName = pageName.replace(/[^a-z0-9_-]/gi, '_');
  const url = page.url();
  const viewport = page.viewportSize?.() || null;

  console.log(`🔎 [PreValidation:${pageName}] mode=${mode}`);
  console.log(`🔎 [PreValidation:${pageName}] source=${source}`);
  console.log(`🔎 [PreValidation:${pageName}] url=${url}`);
  if (viewport) {
    console.log(`🔎 [PreValidation:${pageName}] viewport=${viewport.width}x${viewport.height}`);
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.resolve(process.cwd(), 'test-results', 'pre-validation');
    fs.mkdirSync(dir, { recursive: true });

    const base = `${mode}_${source}_${safePageName}`;
    const html = await page.content().catch(() => '');
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    fs.writeFileSync(path.join(dir, `${base}.url.txt`), `${url}\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, `${base}.html`), html, 'utf-8');
    fs.writeFileSync(path.join(dir, `${base}.txt`), text, 'utf-8');
    console.log(`🔎 [PreValidation:${pageName}] DOM saved: ${path.join(dir, base)}.{url.txt,html,txt}`);
  } catch (error: any) {
    console.log(`⚠️ [PreValidation:${pageName}] Could not save DOM snapshot: ${error?.message || error}`);
  }
}

export const validateVariant = async (
  page:      any,
  variant:   string,
  data:      any[],
  results:   any[],
  eventData: Record<string, string>,
  pageName:  string = 'PPV',
  flow?:     string,   // ← optional: 'myaccount' | 'landing' | undefined
  skipLazyScroll?: boolean  // ← when true, skip the full-page lazy-load scroll
) => {
  if (process.env.PPV_REMOVAL === 'true') {
    console.log(`ℹ️ [PPV Removal] Skipping spreadsheet validation for page "${pageName}".`);
    return;
  }
  console.log(`🔍 validateVariant entry: pageName = "${pageName}", variant = "${variant}", hasEventData = ${!!eventData}, typeof eventData = ${typeof eventData}, keys = ${eventData ? Object.keys(eventData).join(', ') : 'none'}`);
  if (!eventData) throw new Error('❌ eventData is missing');

  // Set page context dynamically so resolveExpected can apply page-specific overrides
  eventData.CURRENT_PAGE = pageName;
  eventData['CURRENT_PAGE'] = pageName;

  const normalizedVariant = variant.trim().toLowerCase();
  const normalizedFlow    = (flow || '').trim().toLowerCase();

  // ── Read tier & ratePlan from eventData ───────────────────────
  const tier     = (eventData.TIER      || 'standard').toLowerCase();
  const ratePlan = (eventData.RATE_PLAN || 'monthly').toLowerCase();

  let rules = data.filter(r => {
    const rv = (r.Variant  || '').trim().toLowerCase();
    const rt = (r.Tier     || '').trim().toLowerCase();
    const rf = (r.Flow     || '').trim().toLowerCase(); // ← new Flow column

    // ── Flow filtering ────────────────────────────────────────────
    // If row has a Flow restriction:
    //   - Only include if current flow matches
    //   - If no flow provided to validateVariant → exclude flow-restricted rows
    if (rf) {
      if (!normalizedFlow)          return false; // no flow context → skip restricted rows
      // Exact flow match required. Flow='landing' rows only match flow='landing'
      // or tile-based landing flows (dont-miss) that don't have their own dedicated rows.
      // Banner flow has its own rows (Flow='landing-page-banner'), so exclude generic 'landing' rows.
      if (rf !== normalizedFlow) {
        if (rf === 'landing' && (normalizedFlow === 'landing-page-dont-miss-live' || normalizedFlow === 'landing-page-dont-miss')) {
          // Allow: tile flows without dedicated rows fall back to generic 'landing' rows
        } else {
          return false; // flow mismatch → skip
        }
      }
    }

    // ── Variant / Tier filtering (existing logic) ─────────────────
    if (rv) return rv === normalizedVariant;
    if (rt) return rt === tier || rt === 'common';

    // No filter column — include all rows (Landing, Schedule, etc.)
    return true;
  });

  const pageNameLower = pageName.trim().toLowerCase();
  const popupValidationFields = new Set([
    'popup - event title',
    'popup - event date',
    'popup - promoter',
    'popup - buy now cta',
    'popup - event description',
    'popup - close button',
  ]);

  if (pageNameLower === 'popup modal') {
    rules = rules.filter(r => popupValidationFields.has(String(r.Field || '').trim().toLowerCase()));
  }

  if (!rules.length) {
    throw new Error(`❌ No rules for variant: "${variant}" / tier: "${tier}"`);
  }

  console.log(`\n🔍 Validating ${pageName} — ${rules.length} fields`);
  console.log(`   💎 Tier: ${tier} | 📋 Rate Plan: ${ratePlan}`);
  if (normalizedFlow) {
    console.log(`   🔀 Flow: ${normalizedFlow}`);
  }

  // ── Scroll to trigger lazy load before snapshot ───────────────
  // Only scroll on pages that need lazy loading
  const url = page.url();
  const urlLower = url.toLowerCase();
  const isModalOpen = await page.locator('[role="dialog"], [aria-modal="true"], [class*="modal" i]').first().isVisible().catch(() => false);
  const needsScroll =
    (urlLower.includes('/schedule') && !isModalOpen) ||
    urlLower.includes('/addon/purchase') ||     // Choose How To Buy
    urlLower.includes('upselltiershown=true') || // PPV page — upsell section is below fold
    urlLower.includes('/myaccount') ||           // My Account — PPV section is lazy-loaded below fold
    (urlLower.includes('page=plandetails') && !urlLower.includes('upselltiershown=true'));

  if (needsScroll && !skipLazyScroll) {
    // Save original scroll position
    const originalScrollY = await page.evaluate(() => window.scrollY).catch(() => 0);

    // Multiple scroll passes to trigger all lazy-loaded content
    for (let pass = 0; pass < 3; pass++) {
      await page.evaluate(async () => {
        await new Promise<void>(resolve => {
          let scrolled = 0;
          const step   = 300;
          const delay  = 50;
          const timer  = setInterval(() => {
            window.scrollBy(0, step);
            scrolled += step;
            if (scrolled >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, delay);
        });
      }).catch(() => {});

      // Wait for lazy content to render between passes
      await page.waitForTimeout(300);
    }

    // Restore original scroll position instead of scrolling back to top (0, 0)
    // to prevent unwanted jumping/scrolling effects when clicking Buy Now.
    await page.evaluate((y: number) => window.scrollTo(0, y), originalScrollY).catch(() => {});
    await page.waitForTimeout(500);
  }

  // ── Wait for page content if on plan/upgrade/PPV pages ──────
  const snapUrl = page.url();
  const snapUrlLower = snapUrl.toLowerCase();
  if (snapUrlLower.includes('plandetails') || pageName.toLowerCase().includes('ppv')) {
    // Wait for page to load — look for radio buttons or continue button
    await page.waitForSelector('input[type="radio"], button:has-text("Continue"), [data-test-id*="radio" i]', 
      { state: 'visible', timeout: 5000 }
    ).catch(() => {});

    // FIX: If upgrade tier flow — wait for h1 to update from stale value
    // h1 may still show "Choose how to buy" from previous page
    if (snapUrl.includes('isUpgradeTierFlow=true')) {
      try {
        await page.waitForFunction(
          () => {
            const h1 = document.querySelector('h1');
            return h1 &&
              !h1.innerText.toLowerCase().includes('choose how to buy') &&
              h1.innerText.trim().length > 3;
          },
          { timeout: 4000 }
        );
        console.log('✅ h1 updated — taking snapshot');
      } catch {
        console.log('⚠️  h1 still stale — proceeding anyway');
      }
    }
  }
  if (snapUrl.includes('UpgradePlan')) {
    // Wait for confirm button
    await page.waitForSelector('button:has-text("Confirm")',
      { state: 'visible', timeout: 3000 }
    ).catch(() => {});
  }


  // Wait for loading and stabilize page
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
    await page.waitForLoadState('load', { timeout: 8000 });
  } catch (e) {
    console.log('⚠️ Timeout waiting for load states in validateVariant');
  }
  await stabilisePage(page);

  // Wait for dynamic text content to be populated (minimum length for SPA rendering)
  try {
    const minChars = parseInt(process.env.VALIDATION_MIN_CHARS || '30', 10);
    await page.waitForFunction((len: number) => {
      const text = document.body ? document.body.innerText.trim() : '';
      return text.length >= len;
    }, minChars, { timeout: 5000 });
    console.log(`✅ Page body text reached minimum length of ${minChars} chars`);
  } catch (e) {
    console.log('⚠️ Timeout waiting for body text rendering in validateVariant');
  }

  await capturePreValidationState(page, pageName, eventData);

  // ── Pre-fetch DOM snapshot ONCE ───────────────────────────────
  const snapshot = await getPageSnapshot(page);
  console.log(`📸 ${pageName} snapshot: ${snapshot.length} nodes`);

  // ── DEBUG — log all snapshot texts ───────────────────────────
  if (pageName === 'Schedule' || pageName === 'Home of Boxing' || pageName === 'PPV' || pageName === 'DAZN Plan' || pageName === 'Upgrade Confirmation' || pageName === 'Payment' || pageName === 'Bundle PPV' || pageName === 'Boxing') {
    console.log(`\n📋 Snapshot contents for ${pageName}:`);
    snapshot.forEach((n, i) => {
      console.log(
        `  [${i}] ${n.tag.padEnd(6)} | ` +
        `children:${n.childCount} | ` +
        `modal:${n.isInModal} | ` +
        `classes:"${n.classes.substring(0, 40)}" | ` +
        `"${n.text.substring(0, 60)}"`
      );
    });
    console.log(`📋 End snapshot\n`);
  }

  // ── Validate one field ────────────────────────────────────────
  const validateRule = async (rule: any) => {
    const field = (rule.Field || '').trim();
    if (!field) return null;
    const fieldLowerNormalized = field.toLowerCase().replace(/\s+/g, ' ').trim();

    if (
      pageNameLower.startsWith('search') &&
      (fieldLowerNormalized === 'buy now button' || fieldLowerNormalized === 'buy now cta')
    ) {
      console.log(`  ⏭️  Skipping [${field}] — Search validates the PPV tile and popup, not the Buy Now CTA`);
      return null;
    }

    // Skip welcome back banner fields because there is no welcome back banner in the new UI
    if (field.toLowerCase().includes('welcome back')) {
      console.log(`  ⏭️  Skipping welcome back banner field validation: "${field}"`);
      return null;
    }

    // ── Skip rate plan rows that don't match current rate plan ───
    const rowRatePlan = (rule['Rate Plan'] || '').trim().toLowerCase();
    if (
      rowRatePlan &&
      rowRatePlan !== 'all' &&
      rowRatePlan !== ratePlan
    ) {
      console.log(
        `  ⏭️  Skipping [${field}] — rate plan "${rowRatePlan}" != "${ratePlan}"`
      );
      return null;
    }

    let expected: string;
    try {
      console.log(`🔍 validateVariant loop: field = "${field}", typeof eventData = ${typeof eventData}, eventData =`, eventData ? "defined" : "undefined");
      expected = resolveExpected(rule, eventData);
    } catch (e: any) {
      console.error(`❌ resolveExpected threw error for ${field}:`, e);
      expected = String(rule.Expected ?? '');
    }

    // Skip validation if expected is 'N/A' or empty
    const expectedNorm = (expected || '').trim().toUpperCase();
    const expectedOptions = expectedNorm.split('|').map(opt => opt.trim());
    const isAllNAOrEmpty = expectedOptions.every(opt => opt === 'N/A' || opt === '');
    if (isAllNAOrEmpty) {
      console.log(`  ⏭️  Skipping [${field}] — expected is "${expected}"`);
      return null;
    }

    let actual: string;
    try {
      actual = await getActualValue(page, field, variant, eventData, snapshot);
    } catch (err: any) {
      actual = 'N/A';
      console.warn(`  ⚠️ getActualValue threw for [${field}]: ${err?.message?.substring(0, 80) || 'unknown'}`);
    }

    // ── Live DOM fallback: when actual is 'N/A' but expected is real text,
    //    try to extract what IS actually present in the DOM so the report
    //    shows real content instead of unhelpful 'N/A'. ──────────────────
    const isPresenceCheck = expectedNorm === 'YES' || expectedNorm === 'NO' || expectedNorm === 'VISIBLE' || expectedNorm === 'NOT VISIBLE' || expectedNorm === 'PRESENT' || expectedNorm === 'NOT FOUND';
    const isExpectedNA = expectedNorm === 'N/A' || expectedNorm === '';
    const strictActualFields = new Set([
      'page title',
      'pagetitle',
      'currency',
      'biggest fights section',
      // A missing save badge must remain missing. The generic text fallback can
      // otherwise incorrectly report a neighbouring plan-card title as a badge.
      'annual pay upfront save badge',
        // Or separator must report N/A when missing. The fallback can incorrectly
        // report other banner text (title, CTA) instead of the missing separator.
        'or separator',
    ]);
    const fieldLowerForFallback = field.toLowerCase().replace(/\s+/g, ' ').trim();
    const requiresExactActual = strictActualFields.has(fieldLowerForFallback);
    const isMyAccountPPVField =
      pageName.trim().toLowerCase() === 'my account' &&
      ['ppv name', 'ppv date', 'ppv price', 'ppv status', 'ppv image present'].includes(fieldLowerForFallback);

    if (actual === 'N/A' && !isExpectedNA && !isPresenceCheck && !requiresExactActual && !isMyAccountPPVField) {
      try {
        const fieldLower = fieldLowerForFallback;
        const isPopupField = fieldLower.startsWith('popup');
        const isBannerField = fieldLower.startsWith('banner');

        // Determine DOM context: modal for popup fields, page for others
        if (isPopupField) {
          // Search visible modal/dialog for text content
          const modalSels = ['[role="dialog"]', '[aria-modal="true"]', '[class*="modal" i]', '[class*="popup" i]'];
          for (const sel of modalSels) {
            const modal = page.locator(sel).first();
            if (!await modal.isVisible({ timeout: 500 }).catch(() => false)) continue;
            const allText = await getVisibleTextList(modal);
            const cleanTexts = allText
              .map((t: string) => t.replace(/\s+/g, ' ').trim())
              .filter((t: string) => t.length > 2 && t.length < 200);

            if (cleanTexts.length > 0) {
              // Find the most relevant text based on field name keywords
              const fieldWords = fieldLower.replace(/popup\s*[-]?\s*/i, '').split(/\s+/).filter((w: string) => w.length > 2);
              let bestMatch = '';
              for (const txt of cleanTexts) {
                const tl = txt.toLowerCase();
                const matchScore = fieldWords.filter((w: string) => tl.includes(w)).length;
                if (matchScore > 0 && (!bestMatch || txt.length < bestMatch.length)) {
                  bestMatch = txt;
                }
              }
              // If no keyword match, return concatenated summary of modal content
              if (!bestMatch && cleanTexts.length > 0) {
                bestMatch = `[Modal content] ${cleanTexts.slice(0, 5).join(' | ')}`.substring(0, 200);
              }
              if (bestMatch) {
                actual = bestMatch;
                console.log(`  🔄 [${field}] Live DOM fallback from modal: "${actual.substring(0, 60)}"`);
              }
            }
            break;
          }
        } else if (isBannerField) {
          // Search banner/hero section
          const bannerSel = 'main [class*="banner"], main [class*="hero"], .swiper-slide-active';
          const banner = page.locator(bannerSel).first();
          if (await banner.isVisible({ timeout: 500 }).catch(() => false)) {
            const allText = await getVisibleTextList(banner);
            const cleanTexts = allText
              .map((t: string) => t.replace(/\s+/g, ' ').trim())
              .filter((t: string) => t.length > 2 && t.length < 200);
            if (cleanTexts.length > 0) {
              const fieldWords = fieldLower.replace(/banner\s*[-]?\s*/i, '').split(/\s+/).filter((w: string) => w.length > 2);
              let bestMatch = '';
              for (const txt of cleanTexts) {
                const tl = txt.toLowerCase();
                const matchScore = fieldWords.filter((w: string) => tl.includes(w)).length;
                if (matchScore > 0 && (!bestMatch || txt.length < bestMatch.length)) {
                  bestMatch = txt;
                }
              }
              if (!bestMatch && cleanTexts.length > 0) {
                bestMatch = `[Banner content] ${cleanTexts.slice(0, 5).join(' | ')}`.substring(0, 200);
              }
              if (bestMatch) {
                actual = bestMatch;
                console.log(`  🔄 [${field}] Live DOM fallback from banner: "${actual.substring(0, 60)}"`);
              }
            }
          }
        } else {
          // General fallback for ALL other fields (schedule tiles, PPV page, landing page, etc.)
          // Search the main visible content area for relevant text
          const isTileField = fieldLower.includes('tile') || fieldLower.includes('ppv');
          const isLandingField = fieldLower.includes('landing');

          let containerSel: string;
          if (isTileField) {
            // For tile/ppv fields, search inside articles first, then main
            containerSel = 'article, main, [class*="content" i]';
          } else if (isLandingField) {
            // For landing page fields, search main content
            containerSel = 'main, [class*="content" i], [class*="landing" i]';
          } else {
            // For any other field, search visible main area
            containerSel = 'main, [class*="content" i], body';
          }

          const containers = page.locator(containerSel);
          const containerCount = await containers.count().catch(() => 0);
          for (let ci = 0; ci < Math.min(containerCount, 3); ci++) {
            const container = containers.nth(ci);
            if (!await container.isVisible({ timeout: 500 }).catch(() => false)) continue;
            const allText = await getVisibleTextList(container);
            const cleanTexts = allText
              .map((t: string) => t.replace(/\s+/g, ' ').trim())
              .filter((t: string) => t.length > 2 && t.length < 200);

            if (cleanTexts.length > 0) {
              // Strip common field prefixes to get relevant keywords
              const stripped = fieldLower
                .replace(/^(ppv|landing\s*page?|schedule|home|tile|page)\s*[-]?\s*/i, '')
                .replace(/\s*(on\s+tile|present|visible)\s*$/i, '');
              const fieldWords = stripped.split(/\s+/).filter((w: string) => w.length > 2);

              let bestMatch = '';
              for (const txt of cleanTexts) {
                const tl = txt.toLowerCase();
                const matchScore = fieldWords.filter((w: string) => tl.includes(w)).length;
                if (matchScore > 0 && (!bestMatch || txt.length < bestMatch.length)) {
                  bestMatch = txt;
                }
              }
              if (!bestMatch && cleanTexts.length > 0) {
                const label = isTileField ? 'Tile content' : isLandingField ? 'Landing content' : 'Page content';
                bestMatch = `[${label}] ${cleanTexts.slice(0, 5).join(' | ')}`.substring(0, 200);
              }
              if (bestMatch) {
                actual = bestMatch;
                console.log(`  🔄 [${field}] Live DOM fallback from page: "${actual.substring(0, 60)}"`);
                break;
              }
            }
          }
        }
      } catch (fallbackErr: any) {
        console.warn(`  ⚠️ Live DOM fallback failed for [${field}]: ${fallbackErr?.message?.substring(0, 60) || 'unknown'}`);
      }
    }

    const status = compare(actual, expected, rule.Type) ? 'PASS' : 'FAIL';
    return { field, expected, actual, status };
  };

  // The My Account PPV fields all query the same card. Running them in
  // parallel allows their locator searches to race over the dynamically
  // rendered card DOM, producing a title from one element and N/A for its
  // sibling values. Keep normal pages parallel, but resolve My Account in
  // rule order so every PPV field reads a stable, fully rendered page.
  const serializeMyAccount = pageNameLower === 'my account';
  const validationResults: Array<{ field: string; expected: string; actual: string; status: string } | null> = [];
  if (serializeMyAccount) {
    for (const rule of rules) {
      validationResults.push(await validateRule(rule));
    }
  } else {
    validationResults.push(...await Promise.all(rules.map(validateRule)));
  }

  for (const result of validationResults) {
    if (!result) continue;
    const { field, expected, actual, status } = result;
    console.log(
      `  ${status === 'PASS' ? '✅' : '❌'} [${field}]` +
      `  expected="${expected}"  actual="${actual}"`
    );

    // Print descriptive failure reason for each failed validation
    if (status === 'FAIL') {
      if (actual === 'N/A' || actual === 'Not found' || actual === 'Not found in banner' || actual === 'Not visible') {
        console.log(`  ⛔ FAIL REASON: ${field} not found in ${pageName} page`);
      } else {
        console.log(`  ⛔ FAIL REASON: ${field} mismatch in ${pageName} — expected "${expected}" but got "${actual}"`);
      }
    }

    results.push({
      page:     pageName,
      variant,
      tier,
      ratePlan,
      field,
      expected,
      actual,
      status,
    });
  }

  // ── Capture red-boxed screenshots for any failed fields ──────────
  await captureFailures(page, results, pageName, eventData);
};

/**
 * Validates the CTA button text after selecting DAZN Ultimate card.
 * Uses the proper validateVariant system (getActualValue + resolveExpected).
 * Only call this AFTER the Ultimate card has been clicked/selected.
 */
export const validateCtaAfterUltimateSelection = async (
  page: any,
  variant: string,
  results: any[],
  eventData: Record<string, string>,
  pageName: string
) => {
  try {
    await validateVariant(
      page, variant,
      [{ Field: 'CTA After Ultimate Selection', Expected: '{{PLAN_CTA_BUTTON}}', Tier: 'ultimate' }],
      results, eventData, pageName, undefined, true
    );
  } catch (e: any) {
    console.warn('⚠️ CTA after Ultimate selection validation error:', e.message);
  }
};
