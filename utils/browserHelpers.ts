/**
 * Smart scroll that only scrolls if element is not in viewport
 * Checks viewport position before scrolling to avoid unnecessary animations
 * @param page - Playwright page object
 * @param locator - Element locator to scroll into view
 * @param label - Descriptive label for logging
 * @returns Promise<boolean> - True if element is in viewport or scroll succeeded
 */
export async function scrollIntoViewSmart(page: any, locator: any, label: string = 'element'): Promise<boolean> {
  try {
    // Check if element is already in viewport
    const isInViewport = await locator.evaluate((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
      const windowWidth = window.innerWidth || document.documentElement.clientWidth;
      
      const verticallyVisible = rect.top >= 0 && rect.bottom <= windowHeight && (rect.bottom - rect.top) >= 100;
      const horizontallyVisible = rect.left >= 0 && rect.right <= windowWidth;
      
      return verticallyVisible && horizontallyVisible;
    });

    if (isInViewport) {
      console.log(`✅ ${label} already in viewport`);
      return true;
    }

    console.log(`📜 Scrolling ${label} into viewport...`);
    
    await locator.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    });
    
   await page.waitForLoadState('domcontentloaded').catch(() => {});
    
    const nowInViewport = await locator.evaluate((el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
      return rect.top >= 0 && rect.bottom <= windowHeight;
    });

    if (nowInViewport) {
      console.log(`✅ ${label} scrolled into viewport`);
      return true;
    } else {
      console.log(`⚠️ ${label} scroll completed, attempting fallback`);
      await locator.scrollIntoViewIfNeeded();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
  } catch (error) {
    console.log(`⚠️ Error scrolling ${label}:`, error);
    return false;
  }
}

/**
 * Smart click with retry logic and state validation
 * Handles disabled buttons, overlays, and navigation detection
 * @param page - Playwright page object
 * @param locator - Element locator to click
 * @param label - Descriptive label for logging
 * @param options - Configuration options (waitForNav, maxRetries)
 * @returns Promise<boolean> - True if click succeeded
 */
export async function smartClick(
  page: any,
  locator: any,
  label: string = 'button',
  options: { waitForNav?: boolean; maxRetries?: number } = {}
): Promise<boolean> {
  const maxRetries = options.maxRetries || 2;
  const waitForNav = options.waitForNav !== false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🖱️ Attempt ${attempt}/${maxRetries}: Clicking ${label}...`);

      await locator.waitFor({ state: 'visible', timeout: 5000 });

      const isEnabled = await locator.isEnabled().catch(() => false);
      if (!isEnabled) {
        console.log(`⚠️ ${label} is disabled, retrying...`);
        continue;
      }
const isVisible = await locator.isVisible().catch(() => false);

if (!isVisible) {
  console.log(`📜 Scrolling ${label} into viewport...`);
  await locator.scrollIntoViewIfNeeded();
}
await scrollIntoViewSmart(page, locator, label);

      // ✅ CLICK + NAVIGATION (CORRECT WAY)
      if (waitForNav) {
        await Promise.all([
          page.waitForLoadState('load').catch(() => {}),
          locator.click({ timeout: 5000 })
        ]);
      } else {
        await locator.click({ timeout: 5000 });
      }

      console.log(`✅ ${label} clicked successfully`);
      return true; // ✅ EXIT IMMEDIATELY ON SUCCESS

    } catch (error) {
      console.log(`⚠️ Attempt ${attempt} failed:`, error);

      if (attempt === maxRetries) {
        console.log(`🔄 Final attempt: JavaScript click for ${label}...`);
        try {
          await locator.evaluate((el: HTMLElement) => el.click());
          console.log(`✅ JavaScript click successful`);
          return true;
        } catch {
          throw new Error(`❌ Failed to click ${label} after ${maxRetries} attempts`);
        }
      }

      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }

  return false;
}

