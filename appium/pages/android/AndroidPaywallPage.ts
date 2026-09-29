import {
  AndroidBasePage,
  AndroidCopyResult,
  WdBrowser,
  adbTap,
  getScreenSize,
  adb,
  adbSwipe,
  getChromeUrl,
} from './AndroidBasePage';
import { releaseHeldBannerCarousel } from '../../utils/bannerInteraction';

export interface AndroidCopyOptions {
  screenshotPrefix?: string;
  retrySwipeBackToPPV?: boolean;
  ppvName?: string;
  isLandingPageBanner?: boolean;
}

export class AndroidPaywallPage extends AndroidBasePage {
  private extractCheckoutUrlFromPageSource(pageSource: string): string {
    const matches = pageSource.match(/https?:\/\/[^\s"'<>]+(?:dazn\.com|amazonaws\.com)[^\s"'<>]*/gi) || [];
    const ordered = matches
      .map((raw) => raw.replace(/[),.;]+$/, '').trim())
      .filter((raw) => /dazn\.com|amazonaws\.com/i.test(raw));

    if (!ordered.length) return '';

    const priority = ordered.find((candidate) => /checkout|signup|purchase|paywall|account/i.test(candidate));
    return priority || ordered[0];
  }

  async copyImmediateCheckoutUrl(label: string, options: AndroidCopyOptions = {}): Promise<AndroidCopyResult> {
    const screenshotPrefix = options.screenshotPrefix || label.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const isLandingPageBanner = options.isLandingPageBanner ?? (label === 'landing-page-banner');
    const surfaceLabel = isLandingPageBanner ? 'Landing banner' : 'Paywall overlay';

    // Clear clipboard before clicking to ensure we capture a fresh URL
    console.log('  🧹 Clearing clipboard before copying...');
    try {
      await this.driver.setClipboard(Buffer.from('').toString('base64'), 'plaintext');
    } catch {
      try {
        adb('shell am clipht set ""');
      } catch {}
    }

    console.log(`  🚀 ${surfaceLabel} - FAST copying URL (${label})...`);
    await this.driver.saveScreenshot(`./test-results/android_${screenshotPrefix}_${isLandingPageBanner ? 'banner' : 'paywall'}.png`);

    let copyClicked = false;
    if (isLandingPageBanner && options.ppvName) {
      copyClicked = await this.clickCopyOnLandingBanner(label, options.ppvName);
      if (!copyClicked) {
        console.log('  ⚠️ Landing banner Copy button was not clicked. Clipboard validation will decide next step.');
      }
    } else {
      copyClicked = await this.clickCopyButton(label);
    }

    if (copyClicked) {
      // Verify that the "Copied" or "copied to clipboard" text appeared on screen
      console.log('  ⏳ Verifying copy success indicator on screen ("Copied")...');
      const indicatorVisible = await this.isVisible('Copied', 3000) || await this.isVisible('copied', 1000);
      if (indicatorVisible) {
        console.log('  ✅ Verified copy success indicator text is displayed on the screen.');
      } else {
        console.log('  ⚠️ Copy success indicator text was not detected on screen, but checking clipboard content.');
      }
    }

    await this.driver.pause(500);
    await this.driver.saveScreenshot(`./test-results/android_${screenshotPrefix}_after_copy.png`);

    let url = await this.readClipboardText();
    if (!this.isValidCheckoutUrl(url)) {
      const pageSource = await this.driver.getPageSource().catch(() => '');
      const sourceUrl = this.extractCheckoutUrlFromPageSource(pageSource);
      if (sourceUrl) {
        url = sourceUrl;
      }
    }

    if (!this.isValidCheckoutUrl(url)) {
      const chromeUrl = getChromeUrl();
      if (this.isValidCheckoutUrl(chromeUrl)) {
        url = chromeUrl;
      }
    }

    if (this.isValidCheckoutUrl(url)) {
      console.log(`  ✅ URL captured (${label}): ${url.substring(0, 100)}...`);
      if (isLandingPageBanner) {
        this.closeLandingBannerApp();
      }
      return { captured: true, url };
    }

    const chromeUrl = getChromeUrl();
    if (this.isValidCheckoutUrl(chromeUrl)) {
      console.log(`  ✅ URL recovered from Chrome URL (${label}): ${chromeUrl.substring(0, 100)}...`);
      return { captured: true, url: chromeUrl };
    }

    console.log('  Clipboard did not contain a valid DAZN URL. Will retry in shared block...');

    if (options.retrySwipeBackToPPV && options.ppvName) {
      const retryUrl = await this.retryCopyAfterSwipingBack(options.ppvName, label);
      if (this.isValidCheckoutUrl(retryUrl)) {
        if (isLandingPageBanner) {
          this.closeLandingBannerApp();
        }
        return { captured: true, url: retryUrl };
      }
      url = retryUrl || url;
    }

    return { captured: false, url };
  }

  private async isCopyButtonVisible(): Promise<boolean> {
    const selectors = [
      'android=new UiSelector().textMatches("(?i)^Copy$")',
      'android=new UiSelector().descriptionMatches("(?i)^Copy$")',
      '//android.widget.Button[@text="Copy"]',
      '//android.widget.TextView[@text="Copy"]',
      '//android.widget.Button[translate(@text, "COPY", "copy")="copy"]',
      '//android.widget.TextView[translate(@text, "COPY", "copy")="copy"]',
      '//*[@content-desc="Copy"]',
      '//android.view.View[.//android.widget.TextView[@text="Copy"] or .//android.widget.Button[@text="Copy"]]',
    ];

    for (const selector of selectors) {
      try {
        const copyBtn = await this.driver.$(selector);
        if (await copyBtn.isDisplayed({ timeout: 500 })) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  private async clickCopyButton(label: string): Promise<boolean> {
    const startTime = Date.now();
    const selectors = [
      { label: 'textMatches', selector: 'android=new UiSelector().textMatches("(?i)^Copy$")' },
      { label: 'descMatches', selector: 'android=new UiSelector().descriptionMatches("(?i)^Copy$")' },
      { label: 'textCI', selector: '//android.widget.TextView[translate(@text, "COPY", "copy")="copy"]' },
      { label: 'buttonCI', selector: '//android.widget.Button[translate(@text, "COPY", "copy")="copy"]' },
      { label: 'parent', selector: '//android.view.View[.//android.widget.TextView[@text="Copy"] or .//android.widget.Button[@text="Copy"]]' },
      { label: 'button', selector: '//android.widget.Button[@text="Copy"]' },
      { label: 'text', selector: '//android.widget.TextView[@text="Copy"]' },
      { label: 'content-desc', selector: '//*[@content-desc="Copy"]' },
      { label: 'XPath', selector: '//android.view.View[@resource-id="ItemContent"]/android.view.View/android.widget.Button' },
    ];

    for (const candidate of selectors) {
      try {
        const copyBtn = await this.driver.$(candidate.selector);
        if (!await copyBtn.isDisplayed({ timeout: 800 })) continue;
        await copyBtn.click();
        console.log(`  ⚡ Copy clicked via ${candidate.label} (${Date.now() - startTime}ms)`);
        return true;
      } catch {}
    }

    // Coordinate fallback for landing banner pill button on the right side: (x ~ 81%, y ~ 86%)
    try {
      const { width, height } = await this.driver.getWindowSize();
      const copyX = Math.round(width * 0.81);
      const copyY = Math.round(height * 0.86);
      console.log(`  Trying coordinate tap on Copy button at (${copyX}, ${copyY})...`);
      adbTap(copyX, copyY);
      return true;
    } catch {}

    console.log(`  ⚠️ Copy button not found by any selector (${Date.now() - startTime}ms)`);
    return false;
  }

  private async clickCopyOnLandingBanner(label: string, ppvName: string): Promise<boolean> {
    console.log('  🔍 Landing banner copy controls should be on the banner, not a paywall.');

    // Do not wait for an arbitrary Copy button first: while waiting the
    // carousel can advance and expose the next banner's control. Confirm the
    // detected PPV banner is active, then copy immediately from that card.
    console.log('  Checking whether the PPV banner is active before tapping Copy...');
    const ppvVisible = await this.ensureLandingPPVBannerVisible(ppvName);
    if (!ppvVisible) {
      console.log(`  ⚠️ Could not bring PPV banner "${ppvName}" into view before copying.`);
      await releaseHeldBannerCarousel();
      return false;
    }

    // A short, PPV-guarded retry accommodates a control that is still
    // rendering, without giving the carousel time to switch banners.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.isLandingPPVVisible(ppvName, 300)) {
        if (!await this.ensureLandingPPVBannerVisible(ppvName)) {
          await releaseHeldBannerCarousel();
          return false;
        }
      }
      if (await this.isCopyButtonVisible()) {
        console.log(`  ✅ Copy button is visible on PPV banner (check ${attempt + 1})`);
        // Releasing immediately before the click resets the carousel's touch
        // timer while allowing the native Copy control to receive its tap.
        await releaseHeldBannerCarousel();
        return this.clickCopyButton(label);
      }
      await this.driver.pause(200);
    }

    console.log('  ⚠️ Copy button did not render while PPV banner remained active.');
    await releaseHeldBannerCarousel();
    return false;
  }

  private async isLandingPPVVisible(ppvName: string, timeoutMs: number): Promise<boolean> {
    const normalizedPpvName = ppvName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return (await this.isVisible(ppvName, timeoutMs)) ||
      (normalizedPpvName !== ppvName && await this.isVisible(normalizedPpvName, timeoutMs));
  }

  private async ensureLandingPPVBannerVisible(ppvName: string): Promise<boolean> {
    if (await this.isLandingPPVVisible(ppvName, 1500)) {
      console.log(`  ✅ PPV banner "${ppvName}" is visible`);
      return true;
    }

    console.log(`  ⚡ PPV banner not visible. Swiping carousel to find "${ppvName}"...`);
    const { width, height } = await this.driver.getWindowSize();
    const y = Math.round(height * 0.45);
    const swipeSets = [
      { name: 'right', fromX: Math.round(width * 0.2), toX: Math.round(width * 0.8) },
      { name: 'left', fromX: Math.round(width * 0.8), toX: Math.round(width * 0.2) },
    ];

    for (const swipeSet of swipeSets) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.driver.action('pointer')
          .move({ x: swipeSet.fromX, y })
          .down()
          .move({ x: swipeSet.toX, y })
          .up()
          .perform();
        await this.driver.pause(600);

        if (await this.isLandingPPVVisible(ppvName, 1000)) {
          console.log(`  ✅ PPV banner found after ${attempt + 1} ${swipeSet.name} swipe(s)`);
          return true;
        }
      }
    }

    return false;
  }

  private closeLandingBannerApp(): void {
    const appPackage = process.env.APP_PACKAGE || 'com.dazn';
    console.log(`  📱 Closing DAZN app (${appPackage}) before mobile web handoff...`);
    adb(`shell am force-stop ${appPackage}`);
  }

  private async retryCopyAfterSwipingBack(ppvName: string, label: string): Promise<string> {
    const startTime = Date.now();
    console.log('  ⚡ Carousel recovery - swiping back to PPV...');
    const { width, height } = await this.driver.getWindowSize();
    const screen = getScreenSize();
    const copyX = Math.round(screen.width * 0.19);
    const copyY = Math.round(screen.height * 0.89);

    for (let swipeBack = 0; swipeBack < 5; swipeBack++) {
      const ppvVisible = await this.isLandingPPVVisible(ppvName, 800); // Reduced from 1000
      if (!ppvVisible) {
        await this.driver.action('pointer')
          .move({ x: Math.round(width * 0.2), y: Math.round(height * 0.35) })
          .down()
          .move({ x: Math.round(width * 0.8), y: Math.round(height * 0.35) })
          .up()
          .perform();
        await this.driver.pause(600); // Reduced from 800
        continue;
      }

      console.log(`  ✅ Found PPV after ${swipeBack} swipe(s) (${Date.now() - startTime}ms)`);

      // Fast retry loop
      for (let retry = 0; retry < 8; retry++) { // Reduced from 10
        await this.driver.pause(300); // Reduced from 500

        try {
          const copyBtn = await this.driver.$('//android.view.View[@resource-id="ItemContent"]/android.view.View/android.widget.Button');
          if (await copyBtn.isDisplayed({ timeout: 400 })) { // Reduced from 500
            await copyBtn.click();
            console.log(`  ⚡ Copy clicked on retry ${retry + 1} (${Date.now() - startTime}ms)`);
            await this.driver.pause(400); // Reduced from 1000
            const retryUrl = await this.readClipboardText();
            if (this.isValidCheckoutUrl(retryUrl)) {
              console.log(`  ✅ URL recovered in ${Date.now() - startTime}ms`);
              return retryUrl;
            }
            break;
          }
        } catch {}

        // No coordinate tap - only element-based clicks
      }

      // Swipe back right
      await this.driver.action('pointer')
        .move({ x: Math.round(width * 0.2), y: Math.round(height * 0.35) })
        .down()
        .move({ x: Math.round(width * 0.8), y: Math.round(height * 0.35) })
        .up()
        .perform();
      await this.driver.pause(600);
    }

    console.log(`  ⚠️ Copy recovery failed after ${Date.now() - startTime}ms`);
    return '';
  }

  async captureHandoffUrl(options: { label: string; ppvName?: string }): Promise<string> {
    console.log("\n── Capturing Handoff URL from Paywall Screen ──────────────────");
    
    // First, scroll up slightly to ensure Copy button is fully visible
    console.log("  Scrolling up to ensure Copy button is visible...");
    const screenSize = getScreenSize();
    
    adbSwipe(Math.round(screenSize.width / 2), 
             Math.round(screenSize.height * 0.85), 
             Math.round(screenSize.width / 2), 
             Math.round(screenSize.height * 0.75));
    await this.driver.pause(1000);
    
    // Try clicking the parent element of the Copy button
    try {
      const parentCopyBtn = await this.driver.$('//android.view.View[./android.widget.TextView[@text="Copy"]]');
      console.log("  Found parent of Copy button, waiting for display...");
      await parentCopyBtn.waitForDisplayed({ timeout: 5000 });
      console.log("  Parent displayed, attempting click...");
      await parentCopyBtn.click();
      console.log("  ✅ Clicked parent of Copy button");
      await this.driver.pause(2000);
      await this.driver.saveScreenshot("./test-results/android_after_copy_click.png");
    } catch (e: any) {
      console.log(`  ❌ Failed to click parent: ${e.message}`);
      console.log("  Trying coordinate tap as fallback...");
      
      const copyBtnX = Math.round(screenSize.width * 0.19);
      const copyBtnY = Math.round(screenSize.height * 0.89);
      
      console.log(`  Tapping Copy button at coordinates (${copyBtnX}, ${copyBtnY})`);
      adbTap(copyBtnX, copyBtnY);
      await this.driver.pause(2000);
      await this.driver.saveScreenshot("./test-results/android_after_copy_tap.png");
    }
    
    let checkoutUrl = '';
    try {
      const base64Content = await this.driver.getClipboard();
      checkoutUrl = Buffer.from(base64Content, 'base64').toString('utf8');
      console.log(`  Appium clipboard content: ${checkoutUrl.substring(0, 100)}...`);
    } catch (e: any) {
      console.log(`  Failed to get clipboard via Appium: ${e.message}`);
      checkoutUrl = adb("shell am clipht get");
      console.log(`  ADB Clipboard content: ${checkoutUrl.substring(0, 100)}...`);
    }

    if (checkoutUrl && (checkoutUrl.includes("dazn.com") || checkoutUrl.includes("amazonaws.com"))) {
      console.log("✅ URL captured from clipboard");
    } else {
      await this.driver.saveScreenshot("./test-results/android_url_not_found.png");
      throw new Error(`❌ Could not capture checkout URL from paywall.\n   Clipboard content: ${checkoutUrl}`);
    }

    return checkoutUrl;
  }
}

export async function copyImmediateCheckoutUrl(
  driver: WdBrowser,
  label: string,
  options: AndroidCopyOptions = {},
): Promise<AndroidCopyResult> {
  return new AndroidPaywallPage(driver).copyImmediateCheckoutUrl(label, options);
}

export async function captureHandoffUrl(
  driver: WdBrowser,
  options: { label: string; ppvName?: string },
): Promise<string> {
  return new AndroidPaywallPage(driver).captureHandoffUrl(options);
}
