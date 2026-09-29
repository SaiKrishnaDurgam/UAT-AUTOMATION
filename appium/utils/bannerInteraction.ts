/**
 * BannerInteraction
 *
 * Generic, reusable helper for pausing Android banner carousels during automation.
 *
 * Design:
 * - Locates any visible banner element dynamically using getRect().
 * - Locks the carousel with W3C Actions API (pointerDown) before validation.
 * - Releases the lock (pointerUp + releaseActions) after validation completes.
 * - If the touch fails, logs a warning and continues — never fails the test.
 * - Detects whether the carousel actually paused by comparing the element
 *   identity before and after the lock.
 *
 * Usage:
 *
 *   const interaction = new BannerInteraction(driver);
 *   const bannerEl = await interaction.findCurrentBanner();
 *   await interaction.lock(bannerEl);
 *
 *   // ... existing validation logic ...
 *
 *   await interaction.unlock();
 *
 * The lock is held for exactly as long as validation takes (no fixed timeout).
 */

import type { WdBrowser } from '../../appium/pages/android/AndroidBasePage';

export type WdElement = any;

// A landing-banner handoff crosses page objects: the CTA is tapped in
// AndroidLandingPage and the URL is copied in AndroidPaywallPage. Keep the
// active touch here so the carousel remains paused across that boundary.
let heldBannerInteraction: BannerInteraction | null = null;

export class BannerInteraction {
  private driver: WdBrowser;
  private locked: boolean = false;
  private bannerRef: string = ''; // content-desc or text captured at lock time
  private bannerElement: WdElement | null = null;

  constructor(driver: WdBrowser) {
    this.driver = driver;
  }

  private async getBannerReference(bannerElement: WdElement): Promise<string> {
    if (this.driver.isIOS) {
      return await bannerElement.getAttribute('name').catch(() => '')
        || await bannerElement.getAttribute('label').catch(() => '')
        || await bannerElement.getAttribute('value').catch(() => '')
        || await bannerElement.getText().catch(() => '');
    }
    return await bannerElement.getAttribute('content-desc').catch(() => '')
      || await bannerElement.getText().catch(() => '');
  }

  /**
   * Try to find a visible banner-like element on the current screen.
   * Uses a set of generic XPath selectors — no source/PPV names.
   * Returns null if nothing is found.
   */
  async findCurrentBanner(referenceText = ''): Promise<WdElement | null> {
    if (this.driver.isIOS && referenceText) {
      const escapedText = referenceText.replace(/'/g, "\\'");
      const selector = `-ios predicate string:(type == "XCUIElementTypeStaticText" OR type == "XCUIElementTypeButton") AND (name CONTAINS[c] '${escapedText}' OR label CONTAINS[c] '${escapedText}' OR value CONTAINS[c] '${escapedText}')`;
      try {
        const titles = await this.driver.$$(selector);
        for (const title of titles) {
          if (await title.isDisplayed()) {
            console.log(`[BannerLock] Found current iOS PPV banner by title "${referenceText}"`);
            return title;
          }
        }
      } catch {
        // Continue with platform-specific fallbacks below.
      }
    }

    // Compose landing pages expose the carousel container with this resource
    // id. Prefer it because it receives the paging touch even when the title
    // itself is a non-interactive child.
    try {
      const carousel = await this.driver.$('//*[@resource-id="CarouselBox"]');
      if (await carousel.isDisplayed()) {
        console.log('[BannerLock] Found carousel container "CarouselBox"');
        return carousel;
      }
    } catch {
      // Other surfaces do not use this Compose resource id.
    }

    // Prefer the PPV text that was just detected.  Some carousel
    // implementations do not expose their image as an ImageView, but do
    // expose the banner title. Holding the title area pauses the same card.
    if (!this.driver.isIOS && referenceText) {
      try {
        const ancillaryTerms = ['official preview', 'preview', 'locked in', 'press conference', 'weigh-in', 'highlights', 'prelims'];
        const titles = await this.driver.$$(
          `android=new UiSelector().textContains("${referenceText.replace(/"/g, '\\"')}")`,
        );
        const screenHeight = (await this.driver.getWindowSize()).height;
        for (const title of titles) {
          if (await title.isDisplayed().catch(() => false)) {
            const txt = (await title.getText().catch(() => '')).toLowerCase();
            if (ancillaryTerms.some(term => txt.includes(term))) continue;
            const loc = await title.getLocation().catch(() => null);
            if (!loc || loc.y < screenHeight * 0.55) {
              console.log(`[BannerLock] Found current PPV banner by title "${referenceText}" at y=${loc?.y ?? 0}`);
              return title;
            }
          }
        }
      } catch {
        // Continue with generic carousel selectors below.
      }
    }

    const selectors = [
      '//*[@content-desc="Banner image"]',
      '//*[contains(@content-desc, "banner")]',
      '//*[contains(@class, "ImageView") and contains(@content-desc, "banner")]',
      '//android.widget.ImageView[contains(@content-desc, "banner")]',
    ];

    for (const selector of selectors) {
      try {
        const els = await this.driver.$$(selector);
        if (els.length > 0) {
          if (await els[0].isDisplayed()) {
            console.log(`[BannerLock] Found banner element by "${selector}"`);
            return els[0];
          }
        }
      } catch {
        // selector failed, try next
      }
    }

    // Fallback: any large ImageView near the top of the screen
    try {
      const allImgs = await this.driver.$$('//android.widget.ImageView');
      const screenHeight = (await this.driver.getWindowSize()).height;
      for (const img of allImgs) {
        try {
          const rect = await img.getRect();
          if (rect.y < screenHeight * 0.35 && rect.width > 200 && rect.height > 100) {
            console.log(`[BannerLock] Found banner via fallback (y=${rect.y}, w=${rect.width}, h=${rect.height})`);
            return img;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // fallback failed
    }

    return null;
  }

  /**
   * Lock the carousel by pressing down on the given banner element.
   * The finger stays down until unlock() is called.
   */
  async lock(bannerElement: WdElement): Promise<void> {
    if (!bannerElement) {
      console.log('[BannerLock] No banner element provided, skipping lock.');
      return;
    }

    try {
      console.log('[BannerLock] Attempting to pause carousel...');

      const rect = typeof bannerElement.getRect === 'function'
        ? await bannerElement.getRect()
        : await Promise.all([bannerElement.getLocation(), bannerElement.getSize()])
          .then(([location, size]: any[]) => ({
            x: location.x,
            y: location.y,
            width: size.width,
            height: size.height,
          }));
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;

      // Capture a reference to detect carousel drift
      this.bannerRef = await this.getBannerReference(bannerElement) || `${centerX},${centerY}`;

      this.bannerElement = bannerElement;

      // W3C Actions API: pointerDown only — finger stays pressed
      await this.driver.performActions([
        {
          type: 'pointer',
          id: 'banner_lock',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(centerX), y: Math.round(centerY) },
            { type: 'pointerDown', button: 0 },
          ],
        },
      ]);

      this.locked = true;
      console.log('[BannerLock] Finger placed on banner.');
      console.log(`[BannerLock] Carousel locked (banner at ${Math.round(centerX)}, ${Math.round(centerY)}).`);
    } catch (e: any) {
      console.warn(`[BannerLock] Carousel did not pause; application ignored touch.`);
      console.warn(`[BannerLock] Reason: ${e.message}`);
      this.locked = false;
    }
  }

  /**
   * Unlock the carousel by releasing the touch.
   * Also detects if the carousel advanced despite the lock.
   */
  async unlock(): Promise<void> {
    if (!this.locked) {
      return;
    }

    try {
      // Release the touch
      await this.driver.releaseActions();
      this.locked = false;
      console.log('[BannerLock] Validation complete.');
      console.log('[BannerLock] Carousel released.');

      // Detect if carousel advanced despite lock
      if (this.bannerElement) {
        try {
          const currentRef = await this.getBannerReference(this.bannerElement);
          if (currentRef && currentRef !== this.bannerRef) {
            console.log('[BannerLock] Carousel did not pause; application ignored touch.');
          }
        } catch {
          // element disappeared — carousel definitely advanced
          console.log('[BannerLock] Carousel did not pause; application ignored touch.');
        }
      }
    } catch (e: any) {
      console.warn(`[BannerLock] Failed to release carousel: ${e.message}`);
      this.locked = false;
    }
  }

  /**
   * Convenience: find, lock, run callback, unlock.
   * If lock fails, callback still runs.
   */
  async withLock(runWhileLocked: () => Promise<void>, referenceText = ''): Promise<void> {
    const banner = await this.findCurrentBanner(referenceText);
    await this.lock(banner);
    try {
      await runWhileLocked();
    } finally {
      await this.unlock();
    }
  }
}

/** Hold a banner carousel across the CTA → Copy overlay handoff. */
export async function holdBannerCarousel(driver: WdBrowser, referenceText = ''): Promise<void> {
  await releaseHeldBannerCarousel();
  const interaction = new BannerInteraction(driver);
  const banner = await interaction.findCurrentBanner(referenceText);
  await interaction.lock(banner);
  heldBannerInteraction = interaction;
}

/** Release a carousel hold immediately before tapping the Copy control. */
export async function releaseHeldBannerCarousel(): Promise<void> {
  if (!heldBannerInteraction) return;
  const interaction = heldBannerInteraction;
  heldBannerInteraction = null;
  await interaction.unlock();
}
