import {
  AndroidBasePage,
  AndroidFlowHooks,
  AndroidPPVSurface,
  WdBrowser,
} from './AndroidBasePage';
import { holdBannerCarousel } from '../../utils/bannerInteraction';

export interface AndroidBannerFlowOptions {
  label: string;
  pageName?: string;
  missingScreenshot: string;
  foundScreenshot: string;
  buyMissingScreenshot: string;
  validateSurface?: AndroidPPVSurface;
  immediatePaywall?: boolean;
  keepCarouselLockedForCopy?: boolean;
  recordPage?: string;
  ensureBannerStillVisibleBeforeBuy?: boolean;
  waitForBannerImageBeforeBuy?: boolean;
  isLandingPage?: boolean;
}

export class AndroidLandingPage extends AndroidBasePage {
  async openBannerPaywall(options: AndroidBannerFlowOptions, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    console.log(`${options.label} -> Find PPV banner -> Buy now`);
    console.log(`  Finding PPV banner for "${this.ppvName}" on ${options.pageName || options.label}...`);

    const isLanding = options.isLandingPage ?? (options.pageName === 'Landing page' || options.label === 'Landing Page');
    const found = await this.findBannerOnCurrentPage(this.ppvName, { isLandingPage: isLanding });
    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot(options.missingScreenshot)
        : await this.driver.saveScreenshot(options.missingScreenshot)
          .then(() => options.missingScreenshot)
          .catch(() => undefined);
      hooks.recordAvailability?.(false, shot, options.recordPage);
      await hooks.generateAvailabilityFailureReport?.(`PPV banner "${this.ppvName}" not found on ${options.pageName || options.label}`);
      throw new Error(`PPV banner "${this.ppvName}" not found. See ${options.missingScreenshot}`);
    }

    hooks.recordAvailability?.(true, undefined, options.recordPage);
    console.log(`  Verified banner title: "${this.ppvName}"`);
    await this.driver.saveScreenshot(options.foundScreenshot);

    if (options.waitForBannerImageBeforeBuy) {
      await this.waitForBannerImageBeforeBuy();
    }

    if (options.validateSurface) {
      await this.runSurfaceValidation(hooks, options.validateSurface);
    }

    if (options.ensureBannerStillVisibleBeforeBuy) {
      const stillOnPPVBanner = await this.findBannerOnCurrentPage(this.ppvName, {
        isLandingPage: isLanding,
        horizontalSwipes: 6,
        verticalScrolls: 0,
      });
      if (!stillOnPPVBanner) {
        await this.driver.saveScreenshot(options.buyMissingScreenshot);
        throw new Error(`PPV banner "${this.ppvName}" moved before Buy CTA tap. See ${options.buyMissingScreenshot}`);
      }
    }

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] PPV banner verified. Skipping Buy click and returning true.');
      return true;
    }

    console.log('  Clicking "Buy now" on the PPV banner...');
    const buyTapped = await this.tapBuyCtaWithFallback();
    if (!buyTapped) {
      await this.driver.saveScreenshot(options.buyMissingScreenshot);
      throw new Error(`Could not tap Buy CTA on PPV banner. See ${options.buyMissingScreenshot}`);
    }

    if (!options.immediatePaywall) {
      await this.driver.pause(3000);
      console.log('  On paywall screen - will capture URL via Copy button');
    } else if (buyTapped && options.keepCarouselLockedForCopy) {
      // The landing CTA exposes its checkout URL on the same auto-advancing
      // carousel. Keep that PPV card active until AndroidPaywallPage clicks
      // Copy, rather than allowing it to change during overlay rendering.
      console.log('  Holding PPV banner while checkout Copy control renders...');
      await holdBannerCarousel(this.driver, this.ppvName);
    }

    return true;
  }

  private async waitForBannerImageBeforeBuy(timeoutMs = 10000): Promise<void> {
    console.log('  Waiting for landing banner image before Buy Now...');
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const source = await this.driver.getPageSource().catch(() => '');
      if (this.hasBannerImage(source)) {
        console.log(`  ✅ Landing banner image detected after ${Date.now() - startedAt}ms`);
        return;
      }
      await this.driver.pause(1000);
    }

    console.log(`  ⚠️ Landing banner image was not detected within ${timeoutMs}ms; running validation with current UI state.`);
  }

  private hasBannerImage(pageSource: string): boolean {
    return (
      pageSource.includes('resource-id="com.dazn:id/search_image"') ||
      pageSource.includes('content-desc="Search result image"') ||
      pageSource.includes('resource-id="com.dazn:id/image"') ||
      /resource-id="[^"]*(image|poster|thumbnail|hero|banner)[^"]*"/i.test(pageSource) ||
      /content-desc="[^"]*(image|poster|thumbnail|hero|banner)[^"]*"/i.test(pageSource) ||
      /android\.widget\.ImageView[^>]*text=""[^>]*content-desc=""/.test(pageSource) ||
      /class="android\.view\.View"[^>]*text=""[^>]*content-desc=""[^>]*bounds="\[\d+,\d+\]\[\d+,\d+\]"/.test(pageSource)
    );
  }

  async openLandingBannerPaywall(hooks: AndroidFlowHooks = {}): Promise<boolean> {
    return this.openBannerPaywall({
      label: 'Landing Page',
      pageName: 'Landing page',
      missingScreenshot: './test-results/android_landing_ppv_banner_not_found.png',
      foundScreenshot: './test-results/android_landing_ppv_banner_found.png',
      buyMissingScreenshot: './test-results/android_landing_buy_cta_not_found.png',
      validateSurface: 'PPV Banner',
      immediatePaywall: true,
      keepCarouselLockedForCopy: true,
      recordPage: 'Landing',
      ensureBannerStillVisibleBeforeBuy: true,
      waitForBannerImageBeforeBuy: true,
    }, hooks);
  }
}

export async function openLandingBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new AndroidLandingPage(driver, ppvName).openLandingBannerPaywall(hooks);
}
