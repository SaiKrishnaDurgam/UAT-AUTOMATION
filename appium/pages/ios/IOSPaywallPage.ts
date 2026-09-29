import {
  IOSBasePage,
  WdBrowser,
} from './IOSBasePage';

export interface IOSCopyOptions {
  screenshotPrefix?: string;
  retrySwipeBackToPPV?: boolean;
  ppvName?: string;
  isLandingPageBanner?: boolean;
}

export interface IOSCopyResult {
  captured: boolean;
  url: string;
}

export class IOSPaywallPage extends IOSBasePage {
  async copyImmediateCheckoutUrl(label: string, options: IOSCopyOptions = {}): Promise<IOSCopyResult> {
    console.log(`[IOSPaywallPage] copyImmediateCheckoutUrl called for label: ${label}`);
    // iOS paywall generally redirects directly to Safari after Buy tap, rather than copying a link.
    // However, if we need to capture URL, we trigger the redirect here.
    try {
      const url = await this.captureCheckoutUrl();
      if (url && this.isValidCheckoutUrl(url)) {
        return { captured: true, url };
      }
    } catch (e: any) {
      console.warn(`[IOSPaywallPage] copyImmediateCheckoutUrl redirect capture failed: ${e.message}`);
    }
    return { captured: false, url: '' };
  }

  async captureHandoffUrl(options: { label: string; ppvName?: string }): Promise<string> {
    console.log(`[IOSPaywallPage] captureHandoffUrl called`);
    const url = await this.captureCheckoutUrl();
    if (!url || !this.isValidCheckoutUrl(url)) {
      throw new Error(`❌ Could not capture checkout URL on iOS`);
    }
    return url;
  }
}

export async function copyImmediateCheckoutUrl(
  driver: WdBrowser,
  label: string,
  options: IOSCopyOptions = {},
): Promise<IOSCopyResult> {
  return new IOSPaywallPage(driver).copyImmediateCheckoutUrl(label, options);
}

export async function captureHandoffUrl(
  driver: WdBrowser,
  options: { label: string; ppvName?: string },
): Promise<string> {
  return new IOSPaywallPage(driver).captureHandoffUrl(options);
}
