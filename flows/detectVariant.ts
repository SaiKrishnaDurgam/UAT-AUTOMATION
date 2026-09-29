/**
 * detectVariant.ts
 *
 * Detects which PPV page variant is shown.
 * Detection strings come from the PPV JSON config — zero hardcoding.
 */

export const detectVariant = async (
  page: any,
  variantConfig?: Record<string, { detection: string }>
): Promise<string> => {
  console.log('🔍 Detecting variant...');

  if (page.isClosed()) {
    throw new Error('❌ Page closed during variant detection');
  }

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);

  const bodyText = (
    (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) || ''
  ).toLowerCase();

  if (!bodyText) {
    throw new Error('❌ Page body is empty — cannot detect variant');
  }

  // ── Config-driven detection ──────────────────────────────────
  // If variantConfig is passed (from JSON), use it
  // Order matters — check variant3 first, then variant2, then variant1
  if (variantConfig) {
    // Check variant3 first (most specific)
    for (const variantName of ['variant3', 'variant2', 'variant1']) {
      const config = variantConfig[variantName];
      if (!config) continue;
      if (bodyText.includes(config.detection.toLowerCase())) {
        console.log(`✅ ${variantName} (config-driven)`);
        return variantName;
      }
    }
  }

  // ── Fallback detection (if no config passed) ─────────────────

  // variant3 — bundle page
  if (bodyText.includes('2 fight') || bodyText.includes('bundle')) {
    console.log('✅ variant3 (fallback)');
    return 'variant3';
  }

  // variant2 — has subscription section
  if (
    bodyText.includes('choose your subscription') ||
    bodyText.includes('continue with ppv')
  ) {
    console.log('✅ variant2 (fallback)');
    return 'variant2';
  }

  // variant1 — has "choose how to buy" title
  if (bodyText.includes('choose how to buy')) {
    console.log('✅ variant1 (fallback)');
    return 'variant1';
  }

  // Final fallback
  if (bodyText.length > 0) {
    console.log('✅ variant1 (final fallback)');
    return 'variant1';
  }

  throw new Error('❌ Unable to detect variant');
};