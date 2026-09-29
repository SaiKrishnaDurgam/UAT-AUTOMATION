import { BannerInteraction } from '../../utils/bannerInteraction';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type WdBrowser = any;
export type WdElement = any;

export interface IOSScreenSize {
  width: number;
  height: number;
}

export type IOSPPVSurface = 'PPV Banner' | 'PPV Tile' | 'PPV Popup';

export interface IOSFlowHooks {
  validateSurface?: (surface: IOSPPVSurface) => Promise<void>;
  validatePaywall?: () => Promise<void>;
  validateFixtureOrPreview?: () => Promise<void>;
  recordAvailability?: (available: boolean, screenshot?: string, page?: string) => void;
  saveScreenshot?: (relativePath: string) => Promise<string | undefined>;
  generateAvailabilityFailureReport?: (errorMessage: string) => Promise<void>;
}

export class IOSBasePage {
  private static readonly safariCookieConsentHandledDrivers = new WeakSet<object>();
  private static readonly bannerValidationSnapshots = new WeakMap<object, string>();
  private static readonly bannerValidationScreenshots = new WeakMap<object, string>();
  private appStoreRetryAttempted = false;

  constructor(protected driver: WdBrowser, protected ppvName = process.env.PPV_NAME || 'Joshua') { }

  protected normalisePpvMatchText(value: string): string {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Discovery-only allowance for a promotion title with its event number omitted. */
  protected isPpvDiscoveryTitle(actual: string, expected = this.ppvName): boolean {
    const clean = (value: string) => this.normalisePpvMatchText(
      String(value || '').replace(/-List:[^\s]+$/i, '').replace(/,\s*(?:article|button)$/i, ''),
    );
    if (clean(actual) === clean(expected)) return true;

    const expectedParts = String(expected || '').match(/^\s*(.+?)\s+(\d+)\s*:\s*(.+?)\s*$/);
    const actualParts = String(actual || '').match(/^\s*(.+?)\s*:\s*(.+?)\s*$/);
    return Boolean(
      expectedParts && actualParts &&
      this.normalisePpvMatchText(expectedParts[1]) === this.normalisePpvMatchText(actualParts[1]) &&
      this.normalisePpvMatchText(expectedParts[3]) === this.normalisePpvMatchText(actualParts[2]),
    );
  }

  protected ppvDiscoveryTitleQuery(value = this.ppvName): string {
    const parts = String(value || '').match(/^\s*(.+?)\s+\d+\s*:\s*(.+?)\s*$/);
    return parts ? `${parts[1]}: ${parts[2]}`.trim() : String(value || '').trim();
  }

  protected ppvTitleTerms(value = this.ppvName): string[] {
    return this.normalisePpvMatchText(value)
      .split(/\s+/)
      .filter(term => term.length >= 3 && !['the', 'and', 'vs'].includes(term));
  }

  protected ppvTitleTermVariants(value = this.ppvName): string[][] {
    const rawTerms = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ')
      .split(/\s+/)
      .filter(term => term.length >= 3 && !['the', 'and', 'vs'].includes(term));
    return this.ppvTitleTerms(value).map((term, index) =>
      [...new Set([rawTerms[index], term].filter(Boolean))]
    );
  }

  protected iosPredicateValue(value: string): string {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
  }

  protected iosXPathValue(value: string): string {
    return value.includes("'")
      ? `concat('${value.split("'").join(`', "'", '`)}')`
      : `'${value}'`;
  }

  /** Finds the rendered Continue label when the App Store sheet has no XCUITest node. */
  private async findRenderedAppStoreContinue(): Promise<{ x: number; y: number } | null> {
    let screenshotPath = '';
    try {
      const screenshot = await this.driver.takeScreenshot();
      screenshotPath = path.join(os.tmpdir(), `dazn-app-store-continue-${process.pid}-${Date.now()}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));

      const swiftVisionScript = `
        import AppKit
        import Vision

        guard CommandLine.arguments.count > 1,
              let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
          exit(1)
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])
        let values = (request.results ?? []).compactMap { observation -> [String: Any]? in
          guard let text = observation.topCandidates(1).first?.string else { return nil }
          let box = observation.boundingBox
          return ["text": text, "xPercent": box.midX, "yPercent": 1 - box.midY]
        }
        let data = try JSONSerialization.data(withJSONObject: values)
        print(String(data: data, encoding: .utf8)!)
      `;
      const output = execFileSync('/usr/bin/swift', ['-e', swiftVisionScript, screenshotPath], {
        encoding: 'utf8',
        timeout: 30000,
      });
      const observations = JSON.parse(output) as Array<{ text: string; xPercent: number; yPercent: number }>;
      const continueText = observations.find(observation => /^continue$/i.test(observation.text.trim()));
      if (!continueText) return null;

      const { width, height } = await this.driver.getWindowSize();
      return {
        x: Math.round(width * continueText.xPercent),
        y: Math.round(height * continueText.yPercent),
      };
    } catch (error: any) {
      console.warn(`⚠️ Could not locate App Store Continue text on screen: ${error.message}`);
      return null;
    } finally {
      if (screenshotPath && fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    }
  }

  private async captureCurrentBannerValidationSnapshot(): Promise<void> {
    if (!this.driver.isIOS) return;
    const [source, screenshot] = await Promise.all([
      this.driver.getPageSource().catch(() => ''),
      this.driver.takeScreenshot().catch(() => ''),
    ]);
    if (source) {
      IOSBasePage.bannerValidationSnapshots.set(this.driver as object, source);
      if (screenshot) IOSBasePage.bannerValidationScreenshots.set(this.driver as object, screenshot);
      console.log('[BannerSnapshot] Captured the verified iOS PPV banner before auto-rotation.');
    }
  }

  protected takeCurrentBannerValidationSnapshot(): string {
    const driverKey = this.driver as object;
    const source = IOSBasePage.bannerValidationSnapshots.get(driverKey) || '';
    IOSBasePage.bannerValidationSnapshots.delete(driverKey);
    return source;
  }

  protected getCurrentBannerValidationScreenshot(): string {
    return IOSBasePage.bannerValidationScreenshots.get(this.driver as object) || '';
  }

  protected async browserText(): Promise<string> {
    return this.driver.execute(() => document.body?.innerText || '').catch(() => '');
  }

  /**
   * WebKit script execution can block while a Safari document is navigating.
   * Use a regular WebDriver element query for readiness polling so a loading
   * document simply returns false and the next poll can proceed.
   */
  protected async browserDocumentReady(): Promise<boolean> {
    try {
      const body = await this.driver.$('body');
      return await body.isDisplayed().catch(() => false);
    } catch {
      return false;
    }
  }

  protected async browserLoadComplete(): Promise<boolean> {
    return this.driver.execute(() => document.readyState === 'complete').catch(() => false);
  }

  protected async browserPageContentReady(): Promise<boolean> {
    return this.driver.execute(() => {
      if (document.readyState !== 'complete') return false;
      const isVisible = (element: HTMLElement): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 ||
          rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return false;
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
            node.getAttribute('aria-busy') === 'true') return false;
        }
        return true;
      };
      if (Array.from(document.querySelectorAll<HTMLElement>(
        '.splash-container, #onetrust-banner-sdk, .onetrust-pc-dark-filter',
      )).some(isVisible)) return false;

      // A loaded document and header can precede the actual hero/feed content.
      return Array.from(document.querySelectorAll<HTMLElement>(
        'main h1, main h2, main h3, main p, section[data-target="rail"] article[data-target="tile"]',
      )).some(element => {
        if (!isVisible(element) || !(element.innerText || '').trim()) return false;
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2,
          (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2,
        );
        return Boolean(hit && element.contains(hit));
      });
    });
  }

  protected async browserFirstVisible(selectors: string[]): Promise<WdElement | null> {
    for (const selector of selectors) {
      try {
        const elements = await this.driver.$$(selector);
        for (const element of elements) {
          if (await element.isDisplayed().catch(() => false)) return element;
        }
      } catch { }
    }
    return null;
  }

  /**
   * Dismiss the DAZN OneTrust banner in a Safari/WKWebView context.
   * Every iOS page object inherits this so any browser handoff can call the
   * same behaviour immediately after its navigation.
   */
  async handleSafariCookies(timeoutMs = 20000): Promise<void> {
    const driverKey = this.driver as object;
    const alreadyHandled = IOSBasePage.safariCookieConsentHandledDrivers.has(driverKey);
    const effectiveTimeout = alreadyHandled ? Math.min(timeoutMs, 2000) : timeoutMs;
    const acceptSelectors = [
      // OneTrust expanded preference centre. Prefer the explicit "Accept
      // All" control; it is different from the first-layer banner button.
      '#accept-recommended-btn-handler',
      '#onetrust-accept-btn-handler',
      '[data-testid="accept-all"]',
      'button*=Accept All',
      '#onetrust-pc-sdk .save-preference-btn-handler',
      'button*=Confirm My Choices',
      'button[aria-label="Accept"]',
      '//button[normalize-space(.)="Accept"]',
      'button*=Accept',
      '[role="button"]*=Accept',
    ];
    const consentCopy = /select your cookie preferences|essential cookies only|manage preferences|privacy preference center|cookie list|list of partners/i;
    const isConsentOverlayVisible = async (): Promise<boolean> => this.driver.execute(() => {
      const overlay = document.querySelector<HTMLElement>(
        '#onetrust-banner-sdk, #onetrust-consent-sdk, #onetrust-pc-sdk, .onetrust-pc-dark-filter'
      );
      if (!overlay) return false;
      const style = window.getComputedStyle(overlay);
      const box = overlay.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.opacity !== '0' && box.width > 0 && box.height > 0;
    }).catch(() => false);
    const waitForConsentToClose = async (): Promise<void> => {
      await this.driver.waitUntil(async () => !(await isConsentOverlayVisible()), {
        timeout: 8000,
        timeoutMsg: 'DAZN cookie banner remained visible after clicking Accept.',
      });
      IOSBasePage.safariCookieConsentHandledDrivers.add(driverKey);
      await this.driver.waitUntil(async () =>
        await this.browserDocumentReady() && await this.browserLoadComplete(), {
        timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
        interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 500),
        timeoutMsg: 'Safari did not finish rendering after cookie consent was dismissed.',
      });
      console.log('✅ DAZN cookie banner is hidden.');
    };
    const deadline = Date.now() + effectiveTimeout;
    // A new private Safari tab can render OneTrust after the welcome page has
    // settled. Keep polling for the requested timeout instead of treating an
    // initially empty consent state as a final absence.
    const noConsentDeadline = alreadyHandled ? Date.now() : deadline;
    let consentWasSeen = false;

    while (Date.now() < deadline) {
      const pageText = await this.browserText();
      const consentIsVisible = consentCopy.test(pageText);
      const overlayVisible = consentIsVisible || await isConsentOverlayVisible();
      if (!overlayVisible) {
        const url = await this.driver.getUrl().catch(() => '');
        if (Date.now() >= noConsentDeadline && (pageText.trim().length > 0 || /\/account\//i.test(url))) break;
        await this.driver.pause(250);
        continue;
      }

      consentWasSeen = true;
      const accept = await this.browserFirstVisible(acceptSelectors);
      if (accept) {
        await accept.scrollIntoView().catch(() => { });
        const clickedByUi = await accept.click().then(() => true).catch(() => false);
        if (!clickedByUi) {
          const clickedByDom = await this.driver.execute(() => {
            const button = document.querySelector<HTMLElement>('#accept-recommended-btn-handler, #onetrust-accept-btn-handler')
              || Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
                .find(element => ['accept all', 'accept', 'confirm my choices'].includes((element.innerText || element.textContent || '').trim().toLowerCase()));
            if (!button) return false;
            button.click();
            return true;
          }).catch(() => false);
          if (!clickedByDom) {
            await this.driver.pause(250);
            continue;
          }
          console.log('🍪 Accepted cookies via DOM-click fallback.');
        } else {
          console.log('🍪 Accepted cookies via #onetrust-accept-btn-handler.');
        }

        await waitForConsentToClose();
        return;
      }

      // On some iOS Safari sessions the visible "Accept" control is rendered
      // in the page but is not returned by WebDriver's element query. Only
      // use the DOM fallback while an actual OneTrust overlay is visible, and
      // verify that the overlay closes before letting the journey continue.
      const clickedWelcomeAccept = await this.driver.execute(() => {
        const button = document.querySelector<HTMLElement>('#accept-recommended-btn-handler, #onetrust-accept-btn-handler')
          || Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
            .find(element => ['accept all', 'accept', 'confirm my choices'].includes(
              (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase(),
            ));
        if (!button) return false;
        button.click();
        return true;
      }).catch(() => false);
      if (clickedWelcomeAccept) {
        console.log('🍪 Accepted Safari Welcome cookies via DOM fallback.');
        await waitForConsentToClose();
        return;
      }

      if (consentIsVisible) consentWasSeen = true;
      await this.driver.pause(250);
    }

    if (consentWasSeen) {
      await this.driver.saveScreenshot('./test-results/ios_safari_cookie_consent_not_actionable.png').catch(() => { });
      throw new Error('DAZN cookie consent was displayed but its Accept button was not actionable.');
    }
    console.log('ℹ️ No DAZN cookie consent was shown in Safari.');
  }

  /**
   * Reset the per-session cookie-consent cache so the next call to
   * handleSafariCookies() gets the full timeout. Call this whenever the flow
   * navigates to a new URL that may show the OneTrust banner again.
   */
  resetCookieConsentCache(): void {
    IOSBasePage.safariCookieConsentHandledDrivers.delete(this.driver as object);
  }

  async findEl(sel: string, timeoutMs = 10000): Promise<WdElement> {
    try {
      const el = await this.driver.$(sel);
      await el.waitForDisplayed({ timeout: timeoutMs });
      return el;
    } catch {
      return null;
    }
  }

  // iOS-specific find helper using predicate string or class chain if prefix matches, or fallback
  async findByText(text: string, timeoutMs = 10000): Promise<WdElement> {
    const escapedText = text.replace(/'/g, "\\'");
    const sel = `-ios predicate string:label CONTAINS[c] '${escapedText}' OR name CONTAINS[c] '${escapedText}'`;
    let visibleElement: WdElement | null = null;
    await this.driver.waitUntil(async () => {
      const elements = await this.driver.$$(sel).catch(() => []);
      for (const element of elements) {
        if (await element.isDisplayed().catch(() => false)) {
          visibleElement = element;
          return true;
        }
      }
      return false;
    }, { timeout: timeoutMs, interval: 200 }).catch(() => { });
    return visibleElement as WdElement;
  }

  async tapByText(text: string, timeoutMs = 10000): Promise<boolean> {
    const el = await this.findByText(text, timeoutMs);
    if (!el) return false;
    await el.click();
    return true;
  }

  async tapFirstText(texts: string[], timeoutMs = 6000): Promise<string> {
    for (const text of texts) {
      if (await this.tapByText(text, timeoutMs)) {
        console.log(`Tapped "${text}"`);
        return text;
      }
    }
    return '';
  }

  private async findBannerCtaForVerifiedPpv(ctas: string[], ppvName = this.ppvName): Promise<WdElement | null> {
    if (!ppvName.trim() || !ctas.length) {
      console.log('  Cannot verify a PPV banner without its configured title and CTA labels.');
      return null;
    }
    const promotions = await this.driver.$$('-ios predicate string:type == "XCUIElementTypeOther" AND name == "Featured promotions"');
    if (promotions.length) {
      const title = this.iosXPathValue(ppvName);
      const titleQuery = this.iosXPathValue(this.ppvDiscoveryTitleQuery(ppvName));
      const selectedTitle = this.iosXPathValue(`${ppvName},`);
      const selectedTitleQuery = this.iosXPathValue(`${this.ppvDiscoveryTitleQuery(ppvName)},`);
      const ctaPredicate = ctas.map(cta => `@name=${this.iosXPathValue(cta)} or @label=${this.iosXPathValue(cta)}`).join(' or ');
      // The embedded web carousel reports its rendered heading/CTA as invisible.
      // Its selected pagination item and exact slide heading establish ownership instead.
      const selector = `//XCUIElementTypeOther[@name="Featured promotions" and @visible="true"]` +
        `[XCUIElementTypeOther[@name="Slide pagination"]/XCUIElementTypeOther[contains(@traits,"Selected") and (starts-with(substring-after(@name,": "),${selectedTitle}) or starts-with(substring-after(@name,": "),${selectedTitleQuery}))]]` +
        `/XCUIElementTypeOther[@name=${title} or @label=${title} or contains(@name,${titleQuery}) or contains(@label,${titleQuery})]` +
        `[XCUIElementTypeOther[contains(@traits,"Header") and (@name=${title} or @label=${title} or contains(@name,${titleQuery}) or contains(@label,${titleQuery}))]]` +
        `/XCUIElementTypeButton[(${ctaPredicate}) and @enabled="true"]`;
      const buttons = await this.driver.$$(selector);
      if (buttons.length !== 1) {
        console.log(`  Featured promotion does not expose one selected "${ppvName}" banner CTA (matches: ${buttons.length}).`);
        return null;
      }
      const button = buttons[0];
      const viewport = await this.driver.getWindowRect();
      let location: { x: number; y: number };
      let size: { width: number; height: number };
      try {
        location = await button.getLocation();
        size = await button.getSize();
      } catch (error) {
        if (!(error instanceof Error) || !/stale element/i.test(error.message)) throw error;
        console.log('  PPV banner changed during CTA lookup; discarding the stale element.');
        return null;
      }
      const centerX = location.x + size.width / 2;
      const centerY = location.y + size.height / 2;
      if (size.width <= 0 || size.height <= 0 || centerX < 0 || centerX >= viewport.width || centerY < 0 || centerY >= viewport.height) {
        console.log('  Selected PPV banner CTA is outside the viewport; refusing to tap.');
        return null;
      }
      return button;
    }

    const titleQuery = this.ppvDiscoveryTitleQuery(ppvName);
    const titleSelector = `-ios predicate string:name CONTAINS[cd] '${this.iosPredicateValue(titleQuery)}' OR label CONTAINS[cd] '${this.iosPredicateValue(titleQuery)}'`;
    const [viewport, titleElements] = await Promise.all([
      this.driver.getWindowRect().catch(() => null),
      this.driver.$$(titleSelector).catch(() => []),
    ]);
    if (!viewport) return null;

    // The PPV name can appear more than once on screen at the same time —
    // for example the hero banner title and an unrelated content rail
    // heading below it sharing the same event name. Collect every visible,
    // matching title candidate instead of taking only the first one, so the
    // CTA lookup below can find the candidate that actually owns a CTA.
    const titleLocations: Array<{ x: number; y: number }> = [];
    for (const title of titleElements) {
      if (!(await title.isDisplayed().catch(() => false))) continue;
      const titleText = (await title.getAttribute('label').catch(() => '')) ||
        (await title.getAttribute('name').catch(() => ''));
      if (!this.isPpvDiscoveryTitle(titleText, ppvName)) continue;
      const location = await title.getLocation().catch(() => null);
      const size = await title.getSize().catch(() => null);
      if (!location || !size) continue;
      const centerX = location.x + size.width / 2;
      const centerY = location.y + size.height / 2;
      if (centerX >= 0 && centerX < viewport.width && centerY >= 0 && centerY < viewport.height) {
        titleLocations.push(location);
      }
    }
    if (!titleLocations.length) return null;

    let targetButton: WdElement | null = null;
    let closestBelow = Number.POSITIVE_INFINITY;
    for (const cta of ctas) {
      const ctaSelector = `-ios predicate string:name == '${this.iosPredicateValue(cta)}' OR label == '${this.iosPredicateValue(cta)}'`;
      const buttons = await this.driver.$$(ctaSelector).catch(() => []);
      for (const button of buttons) {
        if (!(await button.isDisplayed().catch(() => false))) continue;
        const location = await button.getLocation().catch(() => null);
        const size = await button.getSize().catch(() => null);
        if (!location || !size) continue;
        const centerX = location.x + size.width / 2;
        const centerY = location.y + size.height / 2;
        if (centerX < 0 || centerX >= viewport.width || centerY < 0 || centerY >= viewport.height) continue;
        for (const titleLocation of titleLocations) {
          const verticalDistance = location.y - titleLocation.y;
          if (
            verticalDistance < 0 || verticalDistance > viewport.height * 0.55 ||
            verticalDistance >= closestBelow
          ) continue;
          targetButton = button;
          closestBelow = verticalDistance;
        }
      }
    }
    return targetButton;
  }

  protected async tapBannerCtaForVerifiedPpv(
    ctas: string[],
    timeoutMs = 6000,
    options: { swipeDirection?: 'left' | 'right'; maxSwipes?: number } = {},
  ): Promise<string> {
    const tryTap = async (): Promise<string> => {
      const targetButton = await this.findBannerCtaForVerifiedPpv(ctas);
      if (targetButton) {
        let label: string;
        try {
          label = await targetButton.getAttribute('label');
          await targetButton.click();
        } catch (error) {
          if (!(error instanceof Error) || !/stale element/i.test(error.message)) throw error;
          console.log('  PPV banner changed before CTA tap; reacquiring the verified banner.');
          return '';
        }
        console.log(`Tapped verified PPV banner CTA "${label || ctas[0]}"`);
        return label || ctas[0];
      }
      return '';
    };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tapped = await tryTap();
      if (tapped) return tapped;
      await this.driver.pause(200);
    }

    // The carousel can rotate the verified banner off-screen between the
    // active-banner recheck and this click. Swipe to bring it back into
    // view instead of failing on a banner that briefly stepped away.
    console.log(`  Verified banner CTA not immediately visible. Swiping ${options.swipeDirection || 'left'} to reacquire "${this.ppvName}"...`);
    const reacquisitionDeadline = Date.now() + Number(process.env.IOS_BANNER_SEARCH_TIMEOUT_MS || 30000);
    let swipes = 0;
    while (Date.now() < reacquisitionDeadline && (options.maxSwipes === undefined || swipes < options.maxSwipes)) {
      if (options.swipeDirection === 'right') await this.swipeRight();
      else await this.swipeLeft();
      swipes++;
      const tapped = await tryTap();
      if (tapped) return tapped;
    }

    return '';
  }

  async isVisible(text: string, timeoutMs = 3000): Promise<boolean> {
    return Boolean(await this.findByText(text, timeoutMs));
  }

  async scrollToText(text: string): Promise<boolean> {
    // On iOS, scroll down using mobile action until text is visible or max swipes reached
    const sel = `-ios predicate string:label CONTAINS[c] '${text}' OR name CONTAINS[c] '${text}'`;
    try {
      for (let i = 0; i < 15; i++) {
        const el = await this.driver.$(sel);
        if (await el.isDisplayed().catch(() => false)) {
          return true;
        }
        await this.scrollDown();
      }
    } catch { }
    return false;
  }

  async swipeLeft(): Promise<void> {
    const { width, height } = await this.driver.getWindowSize();
    await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ duration: 0, x: Math.round(width * 0.8), y: Math.round(height * 0.35) })
      .down()
      .pause(250)
      .move({ duration: 300, x: Math.round(width * 0.2), y: Math.round(height * 0.35) })
      .up()
      .perform();
  }

  async swipeRight(): Promise<void> {
    const { width, height } = await this.driver.getWindowSize();
    await this.driver.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ duration: 0, x: Math.round(width * 0.2), y: Math.round(height * 0.35) })
      .down()
      .pause(250)
      .move({ duration: 300, x: Math.round(width * 0.8), y: Math.round(height * 0.35) })
      .up()
      .perform();
  }

  async scrollDown(): Promise<void> {
    const { width, height } = await this.driver.getWindowSize();
    await this.driver.action('pointer')
      .move({ x: Math.round(width / 2), y: Math.round(height * 0.7) })
      .down()
      .pause(250)
      .move({ x: Math.round(width / 2), y: Math.round(height * 0.3) })
      .up()
      .perform();
    await this.driver.pause(600);
  }

  async findPPVBanner(ppvName = this.ppvName): Promise<boolean> {
    const simplifiedName = this.ppvDiscoveryTitleQuery(ppvName).split(/ vs/i)[0].trim().replace(/\./g, '');
    const normalisedName = this.normalisePpvMatchText(simplifiedName);
    if (await this.isVisible(simplifiedName, 4000) || await this.isVisible(normalisedName, 400)) return true;
    for (let i = 0; i < 5; i++) {
      await this.swipeLeft();
      if (await this.isVisible(simplifiedName, 1500) || await this.isVisible(normalisedName, 200)) return true;
    }
    if (await this.scrollToText(simplifiedName) || await this.scrollToText(normalisedName)) return true;
    for (let i = 0; i < 8; i++) {
      await this.scrollDown();
      if (await this.isVisible(simplifiedName, 1500) || await this.isVisible(normalisedName, 200)) return true;
    }
    return false;
  }

  async findBannerOnCurrentPage(
    ppvName = this.ppvName,
    options: { horizontalSwipes?: number; verticalScrolls?: number; ctaTexts?: string[]; swipeDirection?: 'left' | 'right' } = {},
  ): Promise<boolean> {
    const verticalScrolls = options.verticalScrolls ?? 5;
    const ctaTexts = options.ctaTexts || ['Go to dazn.com/start', 'dazn.com/start', 'dazn.com'];
    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    const activeBannerCtas = isUltimateUser && isLoginFirst
      ? [...ctaTexts, 'Fight Card', 'Set Reminder', 'Purchased']
      : ctaTexts;

    const isCurrentBannerPPV = async (): Promise<boolean> => {
      const startedAt = Date.now();
      const found = Boolean(await this.findBannerCtaForVerifiedPpv(activeBannerCtas, ppvName));
      console.log(`  PPV banner check: ${found ? 'matched' : 'not matched'} (${Date.now() - startedAt}ms).`);
      return found;
    };

    const deadline = Date.now() + Number(process.env.IOS_BANNER_SEARCH_TIMEOUT_MS || 30000);
    console.log(`  Checking if "${ppvName}" is the active banner...`);
    for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
      if (await isCurrentBannerPPV()) {
        await this.captureCurrentBannerValidationSnapshot();
        return true;
      }
      await this.driver.pause(150);
    }

    let swipes = 0;
    while (Date.now() < deadline && (options.horizontalSwipes === undefined || swipes < options.horizontalSwipes)) {
      console.log(`  Swiping ${options.swipeDirection || 'left'} to find "${ppvName}" (swipe ${swipes + 1})...`);
      if (options.swipeDirection === 'right') await this.swipeRight();
      else await this.swipeLeft();
      swipes++;
      console.log(`  Banner swipe ${swipes} completed; checking the active slide.`);
      if (await isCurrentBannerPPV()) {
        await this.captureCurrentBannerValidationSnapshot();
        return true;
      }
    }
    console.log(`  PPV banner search ended without a match after ${swipes} horizontal swipe(s).`);

    if (verticalScrolls > 0) {
      console.log('  Swiping left exhausted. Trying vertical scroll down...');
      for (let i = 0; i < verticalScrolls; i++) {
        await this.scrollDown();
        if (await isCurrentBannerPPV()) {
          await this.captureCurrentBannerValidationSnapshot();
          return true;
        }
      }
    }

    return false;
  }

  async tapBuyCtaWithFallback(
    ctas = [
      'Go to dazn.com/start',
      'dazn.com/start',
      'dazn.com',
      'Buy now',
      'Buy Now',
      'Buy this fight',
      'Buy',
      'Get PPV',
      'Purchase',
      'Continue',
    ],
    options: { primaryTimeoutMs?: number; fallbackTimeoutMs?: number; scrollBeforeFallback?: boolean; fallbackCtas?: string[] } = {},
  ): Promise<boolean> {
    const primaryTimeoutMs = options.primaryTimeoutMs ?? 6000;
    const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 3000;

    const primary = await this.tapFirstText(ctas, primaryTimeoutMs);
    if (primary) return true;

    if (options.scrollBeforeFallback !== false) {
      await this.scrollDown();
      await this.driver.pause(1000);
    }

    const fallback = await this.tapFirstText(options.fallbackCtas ?? [
      'Go to dazn.com/start',
      'dazn.com/start',
      'dazn.com',
      'Buy now',
      'Buy Now',
      'Buy',
      'Get PPV',
      'Purchase',
    ], fallbackTimeoutMs);
    return !!fallback;
  }

  protected async handleUsNativePaywallSheet(hooks?: IOSFlowHooks): Promise<boolean> {
    if ((process.env.DAZN_REGION || '').toUpperCase() !== 'US') return false;

    console.log('🇺🇸 [US] Checking for native paywall bottom sheet...');
    const sheetSelectors = [
      '-ios predicate string:type == "XCUIElementTypeStaticText" AND (name CONTAINS[c] "How to watch" OR label CONTAINS[c] "How to watch")',
      '-ios predicate string:type == "XCUIElementTypeStaticText" AND (name CONTAINS[c] "Pick a plan" OR label CONTAINS[c] "Pick a plan")',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Buy Now" OR label CONTAINS[c] "Buy Now" OR name CONTAINS[c] "Buy now" OR label CONTAINS[c] "Buy now")',
      '~Buy Now',
      '~Buy now',
    ];

    let sheetVisible = false;
    const deadline = Date.now() + Number(process.env.IOS_US_PAYWALL_SHEET_TIMEOUT_MS || 5000);
    while (Date.now() < deadline && !sheetVisible) {
      for (const selector of sheetSelectors) {
        const element = await this.driver.$(selector).catch(() => null);
        if (element && await element.isDisplayed().catch(() => false)) {
          sheetVisible = true;
          break;
        }
      }
      if (!sheetVisible) await this.driver.pause(300);
    }

    if (!sheetVisible) {
      console.log('ℹ️ [US] Native paywall bottom sheet not detected.');
      return false;
    }

    await this.driver.saveScreenshot('./test-results/ios_us_native_paywall_sheet.png').catch(() => { });
    await this.runPaywallValidation(hooks);

    for (const selector of [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Buy Now" OR label == "Buy Now" OR name == "Buy now" OR label == "Buy now")',
      '~Buy Now',
      '~Buy now',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Buy" OR label CONTAINS[c] "Buy")',
    ]) {
      const button = await this.driver.$(selector).catch(() => null);
      if (!button || !await button.isDisplayed().catch(() => false)) continue;
      if (await button.click().then(() => true).catch(() => false)) {
        console.log('✅ [US] Tapped "Buy Now" on native paywall bottom sheet.');
        await this.driver.pause(Number(process.env.IOS_US_INAPP_BROWSER_SETTLE_MS || 2000));
        return true;
      }
    }

    const { width, height } = await this.driver.getWindowRect();
    await this.driver.performActions([{
      type: 'pointer', id: 'us-native-paywall-buy-now', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x: Math.round(width * 0.5), y: Math.round(height * 0.88) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await this.driver.releaseActions();
    console.log('✅ [US] Tapped native paywall Buy Now via fallback position.');
    await this.driver.pause(Number(process.env.IOS_US_INAPP_BROWSER_SETTLE_MS || 2000));
    return true;
  }

  async runSurfaceValidation(hooks: IOSFlowHooks | undefined, surface: IOSPPVSurface): Promise<void> {
    if (!hooks?.validateSurface) return;
    try {
      if (surface === 'PPV Banner') {
        // XCUITest synthesizes each W3C touch as a completed event and cannot
        // keep a finger down across the validation commands. The verified
        // native snapshot captured during banner discovery is the stable
        // equivalent for iOS banner validation.
        if (this.driver.isIOS) {
          await hooks.validateSurface(surface);
          return;
        }
        const bannerInteraction = new BannerInteraction(this.driver);
        await bannerInteraction.withLock(async () => {
          await hooks.validateSurface!(surface);
        }, this.ppvName);
      } else if (hooks?.validateSurface) {
        await hooks.validateSurface(surface);
      }
    } catch (err: any) {
      console.warn(`Mobile ${surface.toLowerCase()} validation failed: ${err.message}`);
    }
  }

  async runPaywallValidation(hooks: IOSFlowHooks | undefined): Promise<void> {
    if (!hooks?.validatePaywall) return;
    try {
      await hooks.validatePaywall();
    } catch (err: any) {
      console.warn(`Mobile paywall validation failed: ${err.message}`);
    }
  }

  async validateUltimateFixtureOrPreviewPage(hooks?: IOSFlowHooks): Promise<void> {
    const title = this.ppvName.split(/ vs/i)[0].trim().replace(/\./g, '');
    let nativePaywallDetected = false;
    await this.driver.waitUntil(async () => {
      const source = await this.driver.getPageSource().catch(() => '');
      const corpus = source.toLowerCase();
      nativePaywallDetected =
        /\bhow to watch\b|\bpick a plan on dazn\.com\b/i.test(source) &&
        /\bbuy now\b/i.test(source);
      if (nativePaywallDetected) return true;
      return corpus.includes(title.toLowerCase()) &&
        /\brelated\b|\bcompetitors\b|\bevents\b|\bfeatures\b/i.test(source);
    }, {
      timeout: 8000,
      interval: 500,
      timeoutMsg: `PPV fixture/preview page did not load for "${this.ppvName}" after tile click.`,
    });
    if (nativePaywallDetected) {
      const screenshotPath = './test-results/ios_ultimate_native_paywall_detected.png';
      await this.driver.saveScreenshot(screenshotPath).catch(() => {});
      throw new Error(
        `Active Ultimate user reached a native Buy Now paywall after clicking "${this.ppvName}". ` +
        `Expected the fixture/preview page. See ${screenshotPath}`,
      );
    }
    console.log('✅ [Ultimate Active User with LOGIN_FIRST=true] Fixture/preview page detected after tile click.');
    await hooks?.validateFixtureOrPreview?.();
  }

  isValidCheckoutUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === 'dazn.com' || hostname.endsWith('.dazn.com') || hostname.endsWith('.amazonaws.com');
    } catch {
      return false;
    }
  }

  private isSafariHandoffLandingUrl(url: string): boolean {
    if (!this.isValidCheckoutUrl(url)) return false;
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      // Only a DAZN landing route represents the webview just created by the
      // external-website handoff. Account/search/checkout routes can belong
      // to Safari views that were already open before this native CTA.
      if (pathname === '/' || pathname === '/start' || pathname === '/welcome') return true;
      // DAZN can redirect /start directly to the localized welcome route.
      // It is the normal visible result of the App Store Continue action, not
      // a checkout or Search context from an earlier test run.
      // Locale is supplied by DAZN's redirect, so do not couple this to
      // DAZN_REGION or a specific language. Support ordinary BCP-47 paths
      // such as /en-GB, /es-419 and /zh-Hant-HK, with an optional landing
      // segment, while still excluding account/search/checkout routes.
      return /^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})*(?:\/(?:start|welcome))?\/?$/i.test(pathname);
    } catch {
      return false;
    }
  }

  private assertCheckoutUrlCountryMatch(url: string): void {
    if (process.env.BYPASS_COUNTRY_CHECK === 'true') {
      console.log(`⚠️ [Country Match Check] Bypassed country match assertion (requested region: "${process.env.DAZN_REGION || 'GB'}").`);
      return;
    }
    if (!this.isCheckoutUrlCountryMatch(url)) {
      throw new Error(`❌ [Country Match Check] Country mismatch: expected region "${process.env.DAZN_REGION || 'GB'}" but URL is "${url}". Please ensure your VPN is connected to the correct region.`);
    }
    console.log(`✅ [Country Match Check] URL matches expected region "${process.env.DAZN_REGION || 'GB'}": ${url}`);
  }

  private isCheckoutUrlCountryMatch(url: string): boolean {
    const region = String(process.env.DAZN_REGION || 'GB').toLowerCase();
    const lowerUrl = url.toLowerCase();
    if (region === 'gb') {
      return lowerUrl.includes('-gb') || lowerUrl.includes('-uk') || lowerUrl.includes('-gg') || lowerUrl.includes('-je');
    }
    return region === 'ca' ? lowerUrl.includes('-ca') : lowerUrl.includes(`-${region}`);
  }

  private isPreferredSafariHandoffUrl(url: string): boolean {
    return this.isValidCheckoutUrl(url) && /\/account\//i.test(url) &&
      (/contextualPpvId=|\/signup|[?&]page=/i.test(url));
  }

  /** Excludes checkout WebViews left open by a previous event or region run. */
  private isCurrentSafariHandoffUrl(url: string): boolean {
    if (!this.isPreferredSafariHandoffUrl(url)) return false;
    const expectedEvent = String(process.env.PPV_EVENT || '').trim();
    const expectedRegion = String(process.env.DAZN_REGION || 'GB').toLowerCase();
    const isDefaultSignup = process.env.DEFAULT_SIGNUP === 'true';
    try {
      const parsed = new URL(url);
      const actualEvent = parsed.searchParams.get('contextualPpvId') || '';
      if (!isDefaultSignup && expectedEvent && actualEvent !== expectedEvent) return false;
      const lowerUrl = url.toLowerCase();
      return expectedRegion === 'gb'
        ? /-(?:gb|uk|gg|je)\b/.test(lowerUrl)
        : lowerUrl.includes(`-${expectedRegion}`);
    } catch {
      return false;
    }
  }

  private assertContextualPpvIdMatch(url: string): void {
    const expected = String(process.env.PPV_EVENT || '').trim();
    if (!expected || !/\/account\//i.test(url)) return;
    let actual = '';
    try {
      actual = new URL(url).searchParams.get('contextualPpvId') || '';
    } catch { }
    if (actual && actual !== expected) {
      throw new Error(`❌ [Contextual PPV Check] Expected contextualPpvId="${expected}" but captured "${actual}" from URL "${url}".`);
    }
  }

  private async getAppStoreCannotConnectState(): Promise<{ visible: boolean; retryButton: WdElement | null }> {
    await this.driver.switchContext('NATIVE_APP').catch(() => { });
    const source = await this.driver.getPageSource().catch(() => '');
    let cannotConnect = /cannot connect/i.test(source);
    let retryVisible = /retry/i.test(source);
    let retryButton: WdElement | null = null;
    if (!cannotConnect || !retryVisible) {
      const [cannotConnectElement, retryElement] = await Promise.all([
        this.driver.$('-ios predicate string:name CONTAINS[c] "Cannot Connect" OR label CONTAINS[c] "Cannot Connect"')
          .catch(() => null),
        this.driver.$('-ios predicate string:name == "Retry" OR label == "Retry"')
          .catch(() => null),
      ]);
      cannotConnect = cannotConnect || Boolean(await cannotConnectElement?.isDisplayed().catch(() => false));
      retryVisible = retryVisible || Boolean(await retryElement?.isDisplayed().catch(() => false));
      if (retryElement && await retryElement.isDisplayed().catch(() => false)) retryButton = retryElement;
    }
    return { visible: cannotConnect && retryVisible, retryButton };
  }

  /** Retry a visible App Store connection error once, then fail with evidence. */
  private async retryOrFailIfAppStoreCannotConnect(): Promise<void> {
    const { visible, retryButton } = await this.getAppStoreCannotConnectState();
    if (!visible) return;

    const screenshotPath = './test-results/ios_app_store_cannot_connect.png';
    if (this.appStoreRetryAttempted) {
      await this.driver.saveScreenshot(screenshotPath).catch(() => { });
      throw new Error(`iOS App Store sheet could not connect after Retry. See ${screenshotPath}`);
    }

    this.appStoreRetryAttempted = true;
    console.warn('⚠️ [AppStore] Cannot Connect detected; tapping Retry once.');
    let retried = false;
    if (retryButton) {
      retried = await retryButton.click().then(() => true).catch(() => false);
    }
    if (!retried) {
      const { width, height } = await this.driver.getWindowSize();
      retried = await this.driver.execute('mobile: tap', {
        x: Math.round(width / 2),
        y: Math.round(height * 0.70),
      }).then(() => true).catch(() => false);
    }
    if (!retried) {
      await this.driver.saveScreenshot(screenshotPath).catch(() => { });
      throw new Error(`iOS App Store sheet could not tap Retry. See ${screenshotPath}`);
    }

    const recovered = await this.driver.waitUntil(async () => {
      const currentState = await this.getAppStoreCannotConnectState();
      return !currentState.visible;
    }, { timeout: 10000, interval: 500 }).then(() => true).catch(() => false);
    if (recovered) return;

    await this.driver.saveScreenshot(screenshotPath).catch(() => { });
    throw new Error(`iOS App Store sheet could not connect after Retry. See ${screenshotPath}`);
  }

  async captureCheckoutUrl(): Promise<string> {
    // The external-website confirmation is a native App Store sheet. A prior
    // Safari WEBVIEW can still be selected after the native paywall click, in
    // which case iOS selectors cannot see its Continue button.
    await this.driver.switchContext('NATIVE_APP').catch(() => { });
    this.appStoreRetryAttempted = false;
    try {
      const fs = require('fs');
      if (!fs.existsSync('./test-results')) {
        fs.mkdirSync('./test-results', { recursive: true });
      }
      await this.driver.saveScreenshot("./test-results/alert_screen.png");
      console.log('📸 Saved alert screen screenshot to ./test-results/alert_screen.png');
    } catch (e: any) {
      console.warn('⚠️ Failed to save alert screenshot:', e.message);
    }

    const region = (process.env.DAZN_REGION || '').toUpperCase();
    const isLoginFirst = String(process.env.LOGIN_FIRST || process.env.LOGIN || '').toLowerCase() === 'true';
    const loginFirstStartUrl = 'https://www.dazn.com/start';
    const copyButton = await this.driver.$('-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Copy" OR label == "Copy")').catch(() => null);
    if (copyButton && await copyButton.isDisplayed().catch(() => false)) {
      await copyButton.click();
      await this.driver.pause(500);
      const copiedValue = await this.driver.getClipboard('plaintext').catch(() => '');
      const decodedValue = Buffer.from(String(copiedValue), 'base64').toString('utf8');
      const copiedUrl = this.isValidCheckoutUrl(String(copiedValue)) ? String(copiedValue).trim() : decodedValue.trim();
      if (this.isValidCheckoutUrl(copiedUrl)) {
        console.log('✅ Captured checkout URL from the native copy-link sheet.');
        return copiedUrl;
      }
      throw new Error('Native copy-link sheet did not place a valid DAZN URL on the clipboard.');
    }
    if (region !== 'US') {
    // 1. Let the system sheet complete its presentation animation. On this
    // device/iOS version the App Store sheet is visible on screen but omitted
    // from both the XCUITest tree and native page source, so source-based
    // presence checks would block forever.
    await this.driver.pause(Number(process.env.IOS_EXTERNAL_SHEET_SETTLE_MS || 3000));
    await this.retryOrFailIfAppStoreCannotConnect();

    // 2. Resolve the system sheet by accessibility label. Looking up six
    // selectors five times made XCUITest wait for idle on each miss (nearly a
    // minute), then used unsafe coordinate taps.  Coordinate tapping is now
    // opt-in for unusual devices only.
    let alertHandled = false;
    console.log('🔍 Waiting briefly for the iOS redirect confirmation...');
    const redirectSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Continue" OR label == "Continue" OR name == "Open" OR label == "Open" OR name == "Allow" OR label == "Allow")',
      '//XCUIElementTypeButton[@name="Continue" or @label="Continue"]',
      '~Continue',
    ];
    // The sheet is already visible when this method is called. If XCUITest
    // has not surfaced Continue within a few seconds, it will not do so for
    // this presentation and the coordinate fallback is required.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !alertHandled) {
      // The previous URL capture may have left the session in a WKWebView.
      // Reassert the native context on every poll: system sheets are not
      // visible to WebKit selectors.
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      for (const selector of redirectSelectors) {
        try {
          const button = await this.driver.$(selector);
          if (!await button.isDisplayed().catch(() => false)) continue;
          const label = await button.getAttribute('label').catch(() => 'redirect button');
          await button.click();
          console.log(`✅ Clicked iOS redirect button "${label}" via native accessibility locator.`);
          alertHandled = true;
          await this.driver.pause(1500);
          break;
        } catch { }
      }
      if (!alertHandled) await this.driver.pause(250);
    }

    // On this App Store confirmation sheet, some iOS/WDA combinations render
    // Continue but omit it from the accessibility hierarchy. This is exactly
    // what the attached run shows. Keep the semantic locator as the primary
    // path, then use the known, centred bottom-sheet position automatically.
    if (!alertHandled) {
      console.warn('⚠️ Continue is not exposed to XCUITest; using the App Store sheet fallback position.');
      try {
        // Some XCUITest versions omit the button from the hierarchy but still
        // expose it through the native alert endpoint (the same mechanism the
        // working iOS Schedule flow uses).
        const nativeAlertOpen = typeof this.driver.isAlertOpen === 'function'
          ? await this.driver.isAlertOpen().catch(() => false)
          : false;
        const alertButtons = nativeAlertOpen
          ? await this.driver.execute('mobile: alert', { action: 'getButtons' }).catch(() => []) as string[]
          : [];
        const continueLabel = Array.isArray(alertButtons)
          ? alertButtons.find(label => /^(continue|open|allow)$/i.test(String(label).trim()))
          : undefined;
        if (continueLabel) {
          await this.driver.execute('mobile: alert', { action: 'accept', buttonLabel: continueLabel });
          console.log(`✅ Clicked iOS redirect button "${continueLabel}" via native alert API.`);
          alertHandled = true;
          await this.driver.pause(1500);
        }

        if (alertHandled) {
          // The native alert endpoint handled the sheet; do not send a second
          // coordinate tap into the newly opened browser.
        } else {
          const continuePosition = await this.findRenderedAppStoreContinue();
          if (!continuePosition) {
            await this.driver.saveScreenshot('./test-results/ios_app_store_continue_not_found.png').catch(() => { });
            throw new Error('App Store Continue text was not exposed to XCUITest or found in the rendered sheet.');
          }
          const { x, y } = continuePosition;
          await this.driver.performActions([{
            type: 'pointer', id: 'app-store-continue', parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 100 },
              { type: 'pointerUp', button: 0 },
            ],
          }]);
          await this.driver.releaseActions();
          console.log('✅ Tapped App Store sheet Continue using its rendered text location.');
          alertHandled = true;
          await this.driver.pause(2500);
        }
      } catch (e: any) {
        console.warn('⚠️ App Store Continue fallback failed:', e.message);
        throw e;
      }
    }

    // Do not treat an old DAZN WebView as a successful handoff when the
    // current App Store presentation has failed with a Retry surface.
    await this.retryOrFailIfAppStoreCannotConnect();
    if (isLoginFirst) {
      console.log(`✅ LOGIN_FIRST=true: using DAZN start URL for private Safari handoff: ${loginFirstStartUrl}`);
      return loginFirstStartUrl;
    }
    }

    // Switch automation context to the active browser app to inspect its UI tree.
    // DAZN opens the web flow in SFSafariViewController (an in-app browser), so
    // the foreground app remains com.dazn.theApp — not com.apple.mobilesafari.
    // We detect the browser by checking for a WEBVIEW context with a valid DAZN
    // URL before falling back to the external Safari poll.
    let activatedBrowser = '';

    // After the App Store sheet is dismissed, Safari needs time to open and
    // begin loading the DAZN URL. Without this pause the WEBVIEW poll starts
    // immediately and sees only about:blank for several iterations.
    if (region === 'US') {
      console.log('🇺🇸 [US] Skipping App Store sheet handling — polling for SFSafariViewController WEBVIEW directly...');
      await this.driver.pause(Number(process.env.IOS_US_INAPP_BROWSER_SETTLE_MS || 2000));
    } else {
      await this.driver.pause(Number(process.env.IOS_POST_SHEET_SETTLE_MS || 5000));
    }

    // Phase 1: poll for a WEBVIEW context (SFSafariViewController or WKWebView)
    // that resolves to a valid DAZN handoff URL. This covers the common in-app
    // browser case without requiring an external Safari process.
    console.log('🔍 Polling for WEBVIEW context (SFSafariViewController / WKWebView)...');
    const webviewTimeoutMs = Number(process.env.IOS_WEBVIEW_CONTEXT_TIMEOUT_MS || 35000);
    const webviewPollIntervalMs = Number(process.env.IOS_WEBVIEW_CONTEXT_POLL_MS || 2000);
    const webviewDeadline = Date.now() + webviewTimeoutMs;
    let lastContextSummary = '';
    let lastUnlocalizedLandingUrl = '';
    while (Date.now() < webviewDeadline) {
      await this.driver.pause(webviewPollIntervalMs);
      try {
        if (region !== 'US') await this.retryOrFailIfAppStoreCannotConnect();
        // Do not switch into every listed WebView while Safari is connecting:
        // on real devices that context-switch request can block until the
        // overall Mocha timeout. The XCUITest extension exposes each context's
        // URL directly, so an unready/blank context can be skipped and polled
        // again on the next two-second iteration.
        const contextDetails = await this.driver.execute('mobile: getContexts', {
          waitForWebviewMs: 0,
        }).catch((error: any) => {
          console.warn(`⚠️ Could not retrieve iOS web-context metadata: ${error.message}`);
          return [];
        }) as Array<{ id?: string; url?: string | null }>;
        const contextSummary = contextDetails
          .map(context => context.id || 'unknown')
          .join(', ') || 'none';
        if (contextSummary !== lastContextSummary) {
          console.log(`🌐 Available iOS contexts: ${contextSummary}`);
          lastContextSummary = contextSummary;
        }
        const webContexts = contextDetails
          .filter(context => context.id && context.id !== 'NATIVE_APP')
          .reverse();
        const landingContext = webContexts.find(context =>
          this.isSafariHandoffLandingUrl(String(context.url || ''))
        );
        if (landingContext?.url) {
          const url = String(landingContext.url);
          if (process.env.BYPASS_COUNTRY_CHECK !== 'true' && !this.isCheckoutUrlCountryMatch(url)) {
            if (url !== lastUnlocalizedLandingUrl) {
              console.log(`⏳ DAZN handoff is still settling at ${url}; waiting for the ${process.env.DAZN_REGION || 'GB'} localized URL.`);
              lastUnlocalizedLandingUrl = url;
            }
            continue;
          }
          console.log(`✅ Captured new DAZN handoff URL from WEBVIEW context ${landingContext.id}: ${url}`);
          this.assertCheckoutUrlCountryMatch(url);
          activatedBrowser = 'WEBVIEW';
          return url;
        }
        const preferredContext = webContexts.find(context =>
          this.isCurrentSafariHandoffUrl(String(context.url || ''))
        );
        if (preferredContext?.url) {
          const url = String(preferredContext.url);
          console.log(`✅ Captured DAZN account handoff URL from WEBVIEW context ${preferredContext.id}: ${url}`);
          this.assertCheckoutUrlCountryMatch(url);
          this.assertContextualPpvIdMatch(url);
          activatedBrowser = 'WEBVIEW';
          return url;
        }
      } catch (e: any) {
        if (/\[(Country Match|Contextual PPV) Check\]/.test(String(e?.message || e))) throw e;
        console.warn(`⚠️ Could not list web contexts: ${e.message}`);
      }
    }
    if (lastUnlocalizedLandingUrl) {
      this.assertCheckoutUrlCountryMatch(lastUnlocalizedLandingUrl);
    }

    // Phase 2: check if external Safari/Chrome was opened instead.
    if (!activatedBrowser) {
      const browserDeadline = Date.now() + 15000;
      while (Date.now() < browserDeadline && !activatedBrowser) {
        try {
          const activeApp = await this.driver.execute('mobile: activeAppInfo').catch(() => null);
          if (activeApp && (activeApp.bundleId === 'com.apple.mobilesafari' || activeApp.bundleId === 'com.google.chrome.ios')) {
            console.log(`📱 Browser ${activeApp.bundleId} is in the foreground.`);
            activatedBrowser = activeApp.bundleId;
            break;
          }
        } catch (e: any) {
          console.warn('⚠️ Failed to query activeAppInfo:', e.message);
        }
        await this.driver.pause(500);
      }

      if (!activatedBrowser) {
        console.log('ℹ️ No external browser foregrounded; will attempt address bar fallback.');
      }
    }

    // Phase 3: try web contexts for external Safari (legacy path).
    if (activatedBrowser && activatedBrowser !== 'WEBVIEW') {
      lastContextSummary = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        await this.driver.pause(1000);
        try {
          const contexts = await this.driver.getContexts() as string[];
          const webContexts = contexts.filter(c =>
            c.includes('WEBVIEW') || (typeof c === 'string' && c !== 'NATIVE_APP')
          ).sort((a, b) => Number(/SAFARI|MOBILESAFARI/i.test(b)) - Number(/SAFARI|MOBILESAFARI/i.test(a)));
          const contextSummary = contexts.join(', ') || 'none';
          if (contextSummary !== lastContextSummary) {
            console.log(`🌐 Available iOS contexts: ${contextSummary}`);
            lastContextSummary = contextSummary;
          }
          for (const webCtx of webContexts) {
            try {
              await this.driver.switchContext(webCtx);
              const url = await this.driver.getUrl();
              console.log(`🌐 Checking web context ${webCtx}: ${url || '(no URL yet)'}`);
              if (this.isCurrentSafariHandoffUrl(url)) {
                console.log(`✅ Captured Safari account handoff context ${webCtx}: ${url}`);
                this.assertCheckoutUrlCountryMatch(url);
                this.assertContextualPpvIdMatch(url);
                return url;
              }
              if (this.isSafariHandoffLandingUrl(url)) {
                console.log(`✅ Captured new Safari handoff context ${webCtx}: ${url}`);
                this.assertCheckoutUrlCountryMatch(url);
                return url;
              }
            } catch (e: any) {
              if (/\[(Country Match|Contextual PPV) Check\]/.test(String(e?.message || e))) throw e;
              console.warn(`⚠️ Unable to inspect web context ${webCtx}: ${e.message}`);
            } finally {
              await this.driver.switchContext('NATIVE_APP').catch(() => { });
            }
          }
        } catch (e: any) {
          if (/\[(Country Match|Contextual PPV) Check\]/.test(String(e?.message || e))) throw e;
          console.warn(`⚠️ Could not list Safari web contexts: ${e.message}`);
        }
      }
    }

    // Fallback: search all screen elements for any value containing 'dazn.com'
    try {
      if (!activatedBrowser) return '';
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      console.log('🔍 Looking for address bar or URL text in browser elements...');

      // Focus the address bar to expand the full URL in Safari/Chrome
      for (const selector of [
        '~Address and search bar',
        '~Address',
        "//XCUIElementTypeButton[contains(@name, 'Address')]",
        "//XCUIElementTypeTextField[contains(@name, 'Address')]"
      ]) {
        try {
          const el = await this.driver.$(selector);
          if (await el.isDisplayed().catch(() => false)) {
            await el.click();
            await this.driver.pause(1000);
            console.log('📱 Focused browser address bar to expand full URL');
            break;
          }
        } catch { }
      }

      // Save browser layout source for debugging
      const src = await this.driver.getPageSource().catch(() => '');
      const fs = require('fs');
      fs.writeFileSync('./test-results/safari_source.xml', src);
      console.log('📄 Saved browser layout source to ./test-results/safari_source.xml');

      const elements = await this.driver.$$('//XCUIElementTypeTextField | //XCUIElementTypeURLField | //XCUIElementTypeButton');
      for (const el of elements) {
        try {
          const val = await el.getValue().catch(() => '');
          const label = await el.getAttribute('label').catch(() => '');
          const name = await el.getAttribute('name').catch(() => '');
          for (const s of [val, label, name]) {
            if (!s) continue;
            const trimmed = s.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
            // Accept bare 'dazn.com' (collapsed address bar) or any dazn.com URL
            const isDaznDomain = trimmed === 'dazn.com' || trimmed.includes('dazn.com');
            if (!isDaznDomain) continue;
            // Ensure we return a valid absolute URL format
            let cleanUrl = trimmed.includes('/') ? trimmed : trimmed + '/';
            if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
              cleanUrl = 'https://' + cleanUrl;
            }
            if (this.isSafariHandoffLandingUrl(cleanUrl)) {
              console.log(`✅ Extracted Safari handoff URL from browser elements: "${cleanUrl}"`);
              this.assertCheckoutUrlCountryMatch(cleanUrl);
              return cleanUrl;
            }
          }
        } catch { }
      }
    } catch (e: any) {
      if (/\[(Country Match|Contextual PPV) Check\]/.test(String(e?.message || e))) throw e;
      console.warn('⚠️ Error searching browser elements:', e.message);
    }

    return '';
  }

  /**
   * Opens the captured native-app handoff URL in a distinct Safari private tab.
   *
   * The DAZN handoff can be hosted by SFSafariViewController, which is not a
   * Safari tab that XCUITest can manage.  Open the URL through Safari's native
   * tab UI so the subsequent WebKit checkout journey runs in a deliberate new
   * private tab, while leaving the original handoff and its diagnostics intact.
   *
   * @returns the WebKit context associated with the newly opened Safari private tab.
   */
  async openCapturedUrlInNewSafariTab(capturedUrl: string): Promise<string> {
    if (!this.isValidCheckoutUrl(capturedUrl)) {
      throw new Error(`Cannot open an invalid DAZN handoff URL in Safari: ${capturedUrl || '(empty)'}`);
    }

    const expectedUrl = new URL(capturedUrl);
    const expectedHostname = expectedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const expectedPathname = expectedUrl.pathname.replace(/\/+$/, '') || '/';
    const hasExpectedSafariUrl = (url: string): boolean => {
      try {
        const actualUrl = new URL(url);
        const actualHostname = actualUrl.hostname.replace(/^www\./i, '').toLowerCase();
        const actualPathname = actualUrl.pathname.replace(/\/+$/, '') || '/';
        return actualHostname === expectedHostname &&
          actualPathname === expectedPathname &&
          (!expectedUrl.search || actualUrl.search === expectedUrl.search);
      } catch {
        return false;
      }
    };

    const findVisibleNativeControl = async (selectors: string[]): Promise<WdElement | null> => {
      for (const selector of selectors) {
        try {
          const control = await this.driver.$(selector);
          if (await control.isDisplayed().catch(() => false)) return control;
        } catch { }
      }
      return null;
    };
    const waitForVisibleNativeControl = async (
      selectors: string[],
      description: string,
      timeout = 15000,
    ): Promise<WdElement> => {
      let control: WdElement | null = null;
      await this.driver.waitUntil(async () => {
        control = await findVisibleNativeControl(selectors);
        return Boolean(control);
      }, {
        timeout,
        interval: 300,
        timeoutMsg: `Safari did not expose ${description}.`,
      });
      return control!;
    };

    const region = (process.env.DAZN_REGION || '').toUpperCase();
    const plan = String(process.env.PLAN || '').toLowerCase();
    const tier = String(process.env.TIER || '').toLowerCase();
    const ppvDevMode = String(process.env.PPV_DEV_MODE || '').toLowerCase() === 'true';
    const devModeForced = String(process.env.DEV_MODE_ON || '').toLowerCase() === 'on' || ppvDevMode;
    const needsExternalSafariForDevMode = region === 'US' && (devModeForced || tier === 'ultimate' || plan.includes('ultimate'));

    if (region === 'US' && !needsExternalSafariForDevMode) {
      console.log('🇺🇸 [US] Continuing in the current SFSafariViewController context; skipping new private tab.');
      let safariContext = '';
      await this.driver.waitUntil(async () => {
        const contexts = await this.driver.getContexts().catch(() => []) as string[];
        for (const context of contexts.filter(value => value !== 'NATIVE_APP').reverse()) {
          try {
            await this.driver.switchContext(context);
            const url = await this.driver.getUrl();
            if (hasExpectedSafariUrl(url)) {
              safariContext = context;
              return true;
            }
          } catch { }
        }
        await this.driver.switchContext('NATIVE_APP').catch(() => { });
        return false;
      }, {
        timeout: 30000,
        interval: 500,
        timeoutMsg: `US in-app browser did not expose a WebKit context for ${capturedUrl}.`,
      });
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      console.log(`✅ [US] Reusing in-app browser context (${safariContext}).`);
      return safariContext;
    }

    const moreButtonSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "More" OR label == "More")',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "More Actions" OR label == "More Actions")',
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "More Options" OR label == "More Options")',
    ];
    const newPrivateTabSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "New Private Tab" OR label == "New Private Tab")',
    ];
    const addressFieldSelectors = [
      '-ios predicate string:type == "XCUIElementTypeTextField" AND (name CONTAINS[c] "address" OR label CONTAINS[c] "address" OR name CONTAINS[c] "search" OR label CONTAINS[c] "search" OR value CONTAINS[c] "search")',
      '-ios predicate string:type == "XCUIElementTypeURLField"',
    ];
    const addressButtonSelectors = [
      '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "address" OR label CONTAINS[c] "address" OR name CONTAINS[c] "search" OR label CONTAINS[c] "search")',
    ];

    if (needsExternalSafariForDevMode) {
      console.log('🇺🇸 [US Ultimate] Opening SFSafariViewController page in external Safari for dev mode...');
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      const openInSafariSelectors = [
        '-ios predicate string:type == "XCUIElementTypeButton" AND (name == "Open in Safari" OR label == "Open in Safari")',
        '-ios predicate string:type == "XCUIElementTypeButton" AND (name CONTAINS[c] "Safari" OR label CONTAINS[c] "Safari")',
        '~Open in Safari',
        '~OpenInSafari',
      ];
      const openInSafariButton = await findVisibleNativeControl(openInSafariSelectors);
      if (openInSafariButton) {
        await openInSafariButton.click();
      } else {
        const { width, height } = await this.driver.getWindowSize();
        await this.driver.performActions([{
          type: 'pointer', id: 'ios-open-in-safari', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(width * 0.88), y: Math.round(height * 0.935) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerUp', button: 0 },
          ],
        }]);
        await this.driver.releaseActions();
        console.log('🇺🇸 [US Ultimate] Tapped Open in Safari by toolbar coordinate fallback.');
      }
      await this.driver.pause(Number(process.env.IOS_US_EXTERNAL_SAFARI_SETTLE_MS || 3000));
    }

    console.log('🧭 Opening captured handoff URL in a new Safari private tab...');
    await this.driver.switchContext('NATIVE_APP').catch(() => { });
    const existingWebContexts = new Set(
      (await this.driver.getContexts().catch(() => []) as string[])
        .filter(context => context !== 'NATIVE_APP'),
    );

    // The Safari handoff already owns the foreground browser view. Keep that
    // view open and create the requested New Private Tab from its ellipsis menu.
    const moreButton = await waitForVisibleNativeControl(moreButtonSelectors, 'the Safari More (… ) button');
    await moreButton.click();

    const newPrivateTabButton = await waitForVisibleNativeControl(newPrivateTabSelectors, 'the Safari New Private Tab button');
    await newPrivateTabButton.click();

    let addressField = await findVisibleNativeControl(addressFieldSelectors);
    if (!addressField) {
      const addressButton = await waitForVisibleNativeControl(addressButtonSelectors, 'the Safari address bar');
      await addressButton.click();
      addressField = await waitForVisibleNativeControl(addressFieldSelectors, 'an editable Safari address bar');
    }
    await addressField.clearValue().catch(() => { });
    await addressField.setValue(capturedUrl);

    await this.driver.keys(['Enter']);

    let safariContext = '';
    await this.driver.waitUntil(async () => {
      const contexts = await this.driver.getContexts().catch(() => []) as string[];
      // A matching DAZN tab may have existed before this handoff. Require the
      // tab action to create a new WebKit context so the checkout cannot
      // silently continue in that older tab.
      for (const context of contexts.filter(value => value !== 'NATIVE_APP' && !existingWebContexts.has(value)).reverse()) {
        try {
          await this.driver.switchContext(context);
          const url = await this.driver.getUrl();
          if (hasExpectedSafariUrl(url)) {
            safariContext = context;
            return true;
          }
        } catch { }
      }
      await this.driver.switchContext('NATIVE_APP').catch(() => { });
      return false;
    }, {
      timeout: 30000,
      interval: 500,
      timeoutMsg: `New Safari private tab did not expose a WebKit context for ${capturedUrl}.`,
    });
    await this.driver.switchContext('NATIVE_APP').catch(() => { });
    console.log(`✅ Opened captured handoff URL in new Safari private tab (${safariContext}).`);
    return safariContext;
  }

  /**
   * Navigate to the DAZN welcome page and wait for it to settle.
   * Safe to call from any web context — always resolves to the welcome route.
   */
  async navigateToWelcomePage(baseUrl = 'https://www.dazn.com'): Promise<void> {
    console.log('🌐 Navigating to DAZN welcome page...');
    await this.driver.url(baseUrl).catch(() => { });
    await this.driver.waitUntil(async () => (await this.browserText()).trim().length > 0, {
      timeout: 20000,
      timeoutMsg: 'DAZN welcome page did not render a document body.',
    });
    console.log(`🌐 Landed on: ${await this.driver.getUrl().catch(() => '?')}`);
  }

  /**
   * Scrolls the DAZN welcome page down to the "Don't miss" rail, finds the PPV
   * tile matching eventName, and clicks its "Buy now" CTA.
   *
   * Must be called in a Safari/WebView web context (not NATIVE_APP).
   * Uses JS-based scrolling (window.scrollBy / element.scrollLeft) — NOT native
   * iOS gestures — because those only work in NATIVE_APP context.
   *
   * The "Don't miss" section is a horizontal carousel: scrolls the rail up to
   * maxCarouselScrolls times to find a tile that is off-screen to the right.
   */
  async findWelcomePagePPVTile(eventName: string, maxCarouselScrolls = 8): Promise<void> {
    const normalise = (value: string): string => value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const eventTerms = normalise(eventName)
      .split(/\s+vs\s+|\s+/)
      .filter(term => term.length >= 3 && term !== 'vs');
    console.log(`🔍 Looking for PPV tile "${eventName}" in Don't miss section...`);

    await this.driver.waitUntil(async () => this.browserPageContentReady(), {
      timeout: 30000,
      interval: 500,
      timeoutMsg: 'Safari welcome page did not reach ready state within 30 seconds.',
    });

    const searchScrolls = Math.max(maxCarouselScrolls, 40);
    const foundOnLanding = await this.searchDontMissRailOnCurrentPage(eventName, eventTerms, searchScrolls);
    if (foundOnLanding) return;

    console.log('ℹ️ PPV tile not found in Don\'t miss rail on Landing page. Falling back to Home page via Explore...');
    const explore = await this.browserFirstVisible([
      '//*[self::button or self::a or @role="button"][normalize-space(.)="Explore"]',
      'a*=Explore',
      'button*=Explore',
      '[role="button"]*=Explore',
    ]);
    if (explore) {
      await explore.click();
      console.log('✅ Clicked Explore to navigate from Landing page to Home page.');
      let homeFeedReadyReads = 0;
      await this.driver.waitUntil(async () => {
        const onHomeRoute = /\/home(?:[/?#]|$)/i.test(await this.driver.getUrl().catch(() => ''));
        const homePageReady = onHomeRoute && await this.browserPageContentReady();
        homeFeedReadyReads = homePageReady ? homeFeedReadyReads + 1 : 0;
        return homeFeedReadyReads >= 2;
      }, {
        timeout: 30000,
        interval: 500,
        timeoutMsg: 'Safari Home page did not reach a stable ready state after clicking Explore.',
      });
      // OneTrust can render only after the Home feed mounts. Recheck it before
      // scanning the rail so its overlay cannot hide the PPV tile.
      this.resetCookieConsentCache();
      await this.handleSafariCookies(5000);
    } else {
      console.log('ℹ️ \'Explore\' control not found — assuming already on Home page or a different landing variant; continuing without navigation.');
    }

    const foundOnHome = await this.searchDontMissRailOnCurrentPage(eventName, eventTerms, searchScrolls);
    if (foundOnHome) return;

    // ── Failure: screenshot + descriptive error ───────────────────────────────
    await this.driver.saveScreenshot('./test-results/ios_safari_ppv_tile_not_found.png').catch(() => { });
    const pageText = (await this.browserText()).slice(0, 600);
    throw new Error(
      `Safari welcome page: PPV tile not found for "${eventName}" after ${searchScrolls} carousel scrolls (checked both Landing and Home pages).\n` +
      `Visible text snippet: ${pageText}`
    );
  }

  async findSafariSportComingUpPPVTile(eventName: string, sport: string, maxCarouselScrolls = 8): Promise<void> {
    const normalise = (value: string): string => value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const eventTerms = normalise(eventName)
      .split(/\s+vs\s+|\s+/)
      .filter(term => term.length >= 3 && term !== 'vs');
    const targetSport = sport.trim();
    if (!targetSport) throw new Error('Safari sport-page PPV flow requires a configured SPORT value.');

    const exploreSelectors = [
      '//*[self::button or self::a or @role="button"][normalize-space(.)="Explore"]',
      'a*=Explore',
      'button*=Explore',
      '[role="button"]*=Explore',
    ];
    let explore: WdElement | null = null;
    await this.driver.waitUntil(async () => {
      if (!await this.browserPageContentReady()) return false;
      explore = await this.browserFirstVisible(exploreSelectors);
      return Boolean(explore && await explore.isClickable());
    }, {
      timeout: Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000),
      interval: Number(process.env.IOS_SAFARI_SETTLE_POLL_MS || 500),
      timeoutMsg: `Safari landing page did not expose Explore before navigating to ${targetSport}.`,
    });
    if (!explore) throw new Error(`Safari landing page did not expose Explore before navigating to ${targetSport}.`);
    await explore.click();

    console.log('Waiting for Safari Home content and navigation menu after Explore...');
    this.resetCookieConsentCache();
    await this.handleSafariCookies(5000);
    const menuSelectors = [
      'button[aria-label*="menu" i]',
      'button[aria-label*="navigation" i]',
      '[role="button"][aria-label*="menu" i]',
      'header button[class*="header-burger-toggle"]',
      '[data-testid*="menu" i]',
    ];
    let menu: WdElement | null = null;
    let homeReadyReads = 0;
    await this.driver.waitUntil(async () => {
      const homeReady = /\/home(?:[/?#]|$)/i.test(await this.driver.getUrl()) &&
        await this.browserPageContentReady();
      menu = homeReady ? await this.browserFirstVisible(menuSelectors) : null;
      homeReadyReads = menu && await menu.isClickable() ? homeReadyReads + 1 : 0;
      return homeReadyReads >= 2;
    }, {
      timeout: 20000,
      interval: 500,
      timeoutMsg: 'Safari Home did not render content and a usable navigation menu after Explore.',
    });
    if (!menu) throw new Error(`Safari Home page did not expose the navigation menu before selecting ${targetSport}.`);
    await menu.click();

    let allSports: WdElement | null = null;
    await this.driver.waitUntil(async () => {
      allSports = await this.browserFirstVisible([
        '//*[self::button or self::a or @role="button"][normalize-space(.)="All sports" or normalize-space(.)="All Sports"]',
        'a*=All sports',
        'button*=All sports',
        '[role="button"]*=All sports',
        'header [class*="mobile-menu-body"] [class*="header-nav__all-sports___"]',
      ]);
      return Boolean(allSports && await allSports.isClickable());
    }, {
      timeout: 10000,
      interval: 500,
      timeoutMsg: 'Safari navigation menu did not expose All sports after opening.',
    });
    if (!allSports) throw new Error(`Safari navigation menu did not expose All sports before selecting ${targetSport}.`);
    console.log('Safari navigation menu opened; selecting All sports.');
    const allSportsClicked = await this.driver.execute((element: HTMLElement) => {
      element.click();
      return true;
    }, allSports).catch(() => false);
    if (!allSportsClicked) throw new Error('Safari navigation menu could not activate All sports.');
    await this.driver.waitUntil(async () => Boolean(await this.browserFirstVisible([
      '#notification-layer [class*="sports-menu-modal__sport-detail-container"]',
      'nav[aria-label="Sports menu"] button',
    ])), {
      timeout: 10000,
      interval: 500,
      timeoutMsg: 'Safari All Sports did not render its sport options.',
    });

    const markSport = async (): Promise<boolean> => Boolean(await this.driver.execute((requestedSport: string) => {
      document.querySelectorAll('[data-ios-safari-sport-target="true"]')
        .forEach(element => element.removeAttribute('data-ios-safari-sport-target'));
      const normaliseText = (value: string) => value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const expected = normaliseText(requestedSport);
      const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      };
      const modal = document.querySelector<HTMLElement>('#notification-layer [class*="sports-menu-modal__modal-outer"]');
      const scope = modal && isVisible(modal) ? modal : document;
      for (const element of Array.from(scope.querySelectorAll<HTMLElement>(
        'a, button, [role="button"], li, [class*="sports-menu-modal__sport-detail-container"]',
      ))) {
        if (!isVisible(element) || normaliseText(element.innerText || element.textContent || '') !== expected) continue;
        element.setAttribute('data-ios-safari-sport-target', 'true');
        return true;
      }
      return false;
    }, targetSport).catch(() => false));

    const scrollSportsMenu = async (): Promise<boolean> => Boolean(await this.driver.execute(() => {
      const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const sportsScroller = document.querySelector<HTMLElement>(
        '#notification-layer [class*="sports-menu-modal__sports-menu-scroll"]',
      );
      if (sportsScroller && isVisible(sportsScroller)) {
        const before = sportsScroller.scrollTop;
        sportsScroller.scrollTop = Math.min(before + sportsScroller.clientHeight * 0.8,
          sportsScroller.scrollHeight - sportsScroller.clientHeight);
        return sportsScroller.scrollTop > before;
      }
      const allSportsHeading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(element =>
        isVisible(element) && /^all sports$/i.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      let scroller: HTMLElement | null = allSportsHeading || null;
      for (let depth = 0; scroller && depth < 8; depth++, scroller = scroller.parentElement) {
        if (scroller.scrollHeight > scroller.clientHeight + 5) {
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.8, scroller.scrollHeight - scroller.clientHeight);
          return scroller.scrollTop > before;
        }
      }
      return false;
    }).catch(() => false));

    let sportSelected = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await markSport()) {
        const beforeUrl = await this.driver.getUrl().catch(() => '');
        const clicked = await this.driver.execute(() => {
          const target = document.querySelector<HTMLElement>('[data-ios-safari-sport-target="true"]');
          if (!target) return false;
          target.click();
          return true;
        }).catch(() => false);
        if (!clicked) throw new Error(`Safari All Sports could not click "${targetSport}".`);
        await this.driver.waitUntil(async () => {
          const url = await this.driver.getUrl().catch(() => '');
          return Boolean(url && url !== beforeUrl);
        }, {
          timeout: 20000,
          interval: 500,
          timeoutMsg: `Safari did not navigate after selecting ${targetSport} from All Sports.`,
        });
        sportSelected = true;
        break;
      }
      if (!await scrollSportsMenu()) {
        throw new Error(`Safari All Sports does not contain "${targetSport}".`);
      }
    }
    if (!sportSelected) {
      throw new Error(`Safari All Sports did not find "${targetSport}" after searching the visible menu.`);
    }

    // Match the native "Home of Sport" readiness gate (IOSBoxingPage
    // waitForConfiguredPpvContentOnSportPage): wait for the newly navigated
    // sport page to actually expose the configured PPV title before
    // searching for its Coming Up rail, instead of scanning immediately
    // after the URL changes. Non-fatal on timeout, matching the native
    // behaviour of continuing with the carousel scroll search.
    const sportPageContentReady = await this.driver.waitUntil(async () => {
      const text = normalise(await this.browserText());
      return eventTerms.every(term => text.includes(term));
    }, {
      timeout: 30000,
      interval: 1000,
    }).then(() => true).catch(() => false);
    if (!sportPageContentReady) {
      console.log(`Safari ${targetSport} page did not expose "${eventName}" before Coming Up rail lookup; continuing with carousel scroll search.`);
    }

    const findComingUpRail = async (): Promise<boolean> => Boolean(await this.driver.execute(() => {
      document.querySelectorAll('[data-ios-safari-coming-up-rail="true"]')
        .forEach(element => element.removeAttribute('data-ios-safari-coming-up-rail'));
      const isVisible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      };
      const heading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(element =>
        isVisible(element) && /^coming up$/i.test((element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      for (let scope: HTMLElement | null = heading || null, depth = 0; scope && depth < 6; scope = scope.parentElement, depth++) {
        const rail = [scope, ...Array.from(scope.querySelectorAll<HTMLElement>('*'))]
          .find(element => element.scrollWidth > element.clientWidth + 5 && isVisible(element));
        if (rail) {
          rail.setAttribute('data-ios-safari-coming-up-rail', 'true');
          return true;
        }
      }
      return false;
    }).catch(() => false));

    // The sport page's "Coming up" rail can still be fetching/mounting after
    // navigation. Give it the same settle budget as the rest of the Safari
    // flow instead of a fixed handful of quick scroll attempts, so a slow
    // real-device load does not get scanned before the rail exists.
    const comingUpRailDeadline = Date.now() + Number(process.env.IOS_SAFARI_SETTLE_TIMEOUT_MS || 35000);
    while (Date.now() < comingUpRailDeadline && !await findComingUpRail()) {
      await this.driver.execute(() => window.scrollBy(0, 350));
      await this.driver.pause(400);
    }
    if (!await findComingUpRail()) {
      throw new Error(`Safari ${targetSport} page did not expose a visible Coming Up rail.`);
    }

    const markPpvTile = async (): Promise<boolean> => Boolean(await this.driver.execute((terms: string[]) => {
      document.querySelectorAll('[data-ios-safari-coming-up-ppv-target="true"]')
        .forEach(element => element.removeAttribute('data-ios-safari-coming-up-ppv-target'));
      const rail = document.querySelector<HTMLElement>('[data-ios-safari-coming-up-rail="true"]');
      if (!rail) return false;
      const railRect = rail.getBoundingClientRect();
      for (const candidate of Array.from(rail.querySelectorAll<HTMLElement>('[class*="tile" i], [class*="card" i], [class*="event" i], li, article, [role="listitem"], a'))) {
        const rect = candidate.getBoundingClientRect();
        const text = `${candidate.innerText || candidate.textContent || ''} ${Array.from(candidate.querySelectorAll('img')).map((image: HTMLImageElement) => image.alt || '').join(' ')}`
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        const visibleInRail = rect.width > 50 && rect.height > 50 &&
          rect.right > railRect.left && rect.left < railRect.right &&
          rect.bottom > railRect.top && rect.top < railRect.bottom;
        if (!visibleInRail || !terms.every(term => text.includes(term))) continue;
        if (/press conference|weigh.?in|prelims?|pre.?show|buy.?in|tailgate|highlights?|interview/i.test(text)) continue;
        (candidate.closest<HTMLElement>('a, button, [role="button"]') ||
          candidate.querySelector<HTMLElement>('a, button, [role="button"]') || candidate)
          .setAttribute('data-ios-safari-coming-up-ppv-target', 'true');
        return true;
      }
      return false;
    }, eventTerms).catch(() => false));

    for (let attempt = 0; attempt <= maxCarouselScrolls; attempt++) {
      if (await markPpvTile()) {
        const beforeUrl = await this.driver.getUrl().catch(() => '');
        const clicked = await this.driver.execute(() => {
          const target = document.querySelector<HTMLElement>('[data-ios-safari-coming-up-ppv-target="true"]');
          if (!target) return false;
          target.click();
          return true;
        }).catch(() => false);
        if (!clicked) throw new Error(`Safari Coming Up could not click PPV tile "${eventName}".`);
        await this.waitForSafariAfterDontMissClick(eventName, beforeUrl);
        return;
      }
      if (attempt === maxCarouselScrolls) break;
      const moved = await this.driver.execute(() => {
        const rail = document.querySelector<HTMLElement>('[data-ios-safari-coming-up-rail="true"]');
        if (!rail) return false;
        // Get all tiles in the rail to find the next off-screen one
        const tiles = Array.from(rail.querySelectorAll<HTMLElement>(
          '[class*="tile" i], [class*="card" i], [class*="event" i], li, article, [role="listitem"], a'
        )).filter(tile => tile.offsetParent !== null);
        if (tiles.length === 0) return false;
        
        const railRect = rail.getBoundingClientRect();
        // Find the first tile that's partially or fully off-screen to the right
        const nextTile = tiles.find(tile => {
          const rect = tile.getBoundingClientRect();
          return rect.left >= railRect.right - 10; // 10px threshold
        });
        
        if (nextTile) {
          nextTile.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          return true;
        }
        return false; // No more tiles to scroll to
      }).catch(() => false);
      if (!moved) break;
      await this.driver.pause(700);
    }

    throw new Error(`Safari ${targetSport} Coming Up rail did not contain PPV tile "${eventName}".`);
  }

  private async searchDontMissRailOnCurrentPage(eventName: string, eventTerms: string[], maxCarouselScrolls: number): Promise<boolean> {
    // ── Step 1: Scroll the page down until "Don't miss" is visible ───────────
    const findVisibleDontMissRail = async (): Promise<boolean> => this.driver.execute(() => {
      document.querySelectorAll('[data-ios-dontmiss-rail="true"]')
        .forEach(element => element.removeAttribute('data-ios-dontmiss-rail'));
      const headings = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(el => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        return el.offsetParent !== null && rect.bottom > 0 && rect.top < window.innerHeight &&
          /^don.?t miss(?: live on dazn)?$/i.test(text);
      });

      for (const heading of headings) {
        let scope: HTMLElement | null = heading;
        for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
          const rail = [scope, ...Array.from(scope.querySelectorAll<HTMLElement>('*'))]
            .find(el => el.scrollWidth > el.clientWidth + 5 && el.offsetParent !== null);
          if (rail) {
            rail.setAttribute('data-ios-dontmiss-rail', 'true');
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    let dontMissRail = false;
    for (let scroll = 0; scroll < 15; scroll++) {
      dontMissRail = await findVisibleDontMissRail();
      if (dontMissRail) break;
      await this.driver.execute(() => window.scrollBy(0, 350));
      await this.driver.pause(400);
    }
    if (!dontMissRail) {
      return false;
    }
    // The heading can first appear at the bottom of the viewport while all
    // cards and their Buy now CTA remain below it. Position it above the
    // rail without scrolling past the section.
    for (let adjustment = 0; adjustment < 3; adjustment++) {
      const headingPosition = await this.driver.execute(() => {
        const heading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(el =>
          /^don.?t miss(?: live on dazn)?$/i.test((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()),
        );
        return heading ? { top: heading.getBoundingClientRect().top, targetTop: window.innerHeight * 0.28 } : null;
      }).catch(() => null) as { top: number; targetTop: number } | null;
      if (!headingPosition || headingPosition.top < 0 || headingPosition.top <= headingPosition.targetTop) break;
      await this.driver.execute(
        (distance: number) => window.scrollBy(0, distance),
        Math.min(350, headingPosition.top - headingPosition.targetTop),
      );
      await this.driver.pause(400);
    }
    console.log('📜 "Don\'t miss" rail positioned; scanning only its visible PPV tiles...');

    // ── Step 2: Check and click only a visible tile in this rail ──────────────
    const markVisibleMatchingTile = async (): Promise<string> => this.driver.execute((terms: string[]) => {
      document.querySelectorAll('[data-ios-dontmiss-ppv-target="true"]')
        .forEach(element => element.removeAttribute('data-ios-dontmiss-ppv-target'));
      const rail = document.querySelector<HTMLElement>('[data-ios-dontmiss-rail="true"]') || undefined;
      if (!rail) return '';

      const railRect = rail.getBoundingClientRect();
      const candidates = Array.from(rail.querySelectorAll<HTMLElement>(
        '[class*="tile" i], [class*="card" i], [class*="event" i], li, article, [role="listitem"], a',
      ));
      for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const text = `${candidate.innerText || candidate.textContent || ''} ${Array.from(candidate.querySelectorAll('img'))
          .map((image: HTMLImageElement) => image.alt || '')
          .join(' ')}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        const isVisibleInRail = rect.width > 50 && rect.height > 50 &&
          rect.right > railRect.left && rect.left < railRect.right &&
          rect.bottom > railRect.top && rect.top < railRect.bottom;
        if (!isVisibleInRail || !terms.every(term => text.includes(term))) continue;
        if (/press conference|weigh.?in|prelims?|pre.?show|buy.?in|tailgate|highlights?|interview/i.test(text)) continue;

        const buyCta = Array.from(candidate.querySelectorAll<HTMLElement>('a, button')).find(el =>
          /buy now|get ppv|purchase/i.test(el.innerText || el.textContent || ''),
        );
        const target = buyCta || candidate.closest<HTMLElement>('a, button, [role="button"]') ||
          candidate.querySelector<HTMLElement>('a, button, [role="button"]') || candidate;
        target.setAttribute('data-ios-dontmiss-ppv-target', 'true');
        return buyCta ? 'Buy now' : 'tile card';
      }
      return '';
    }, eventTerms).catch(() => '');

    const clickMarkedMatchingTile = async (): Promise<boolean> => {
      const target = await this.driver.$('[data-ios-dontmiss-ppv-target="true"]');
      if (!(await target.isDisplayed().catch(() => false))) return false;
      await target.scrollIntoView().catch(() => { });
      return target.click().then(() => true).catch(() => false);
    };

    let urlBeforeTileClick = await this.driver.getUrl().catch(() => '');
    let clickTarget = await markVisibleMatchingTile();
    if (clickTarget && await clickMarkedMatchingTile()) {
      await this.waitForSafariAfterDontMissClick(eventName, urlBeforeTileClick);
      console.log(`✅ Clicked ${clickTarget} for PPV tile "${eventName}" in "Don't miss".`);
      return true;
    }

    // ── Carousel scroll passes: scroll the rail left to reveal hidden tiles ───
    for (let i = 0; i < maxCarouselScrolls; i++) {
      const scrollState = await this.driver.execute(() => {
        const rail = document.querySelector<HTMLElement>('[data-ios-dontmiss-rail="true"]');
        if (!rail) return 'missing';
        const scrollTargets = [rail, ...Array.from(rail.querySelectorAll<HTMLElement>('*'))]
          .filter(element => element.offsetParent !== null && element.scrollWidth > element.clientWidth + 5);

        for (const scrollTarget of scrollTargets) {
          const maximumScrollLeft = Math.max(0, scrollTarget.scrollWidth - scrollTarget.clientWidth);
          const previousScrollLeft = scrollTarget.scrollLeft;
          if (previousScrollLeft >= maximumScrollLeft - 1) continue;

          const step = Math.max(1, Math.round(scrollTarget.clientWidth * 0.8));
          scrollTarget.scrollLeft = Math.min(maximumScrollLeft, previousScrollLeft + step);
          if (scrollTarget.scrollLeft > previousScrollLeft) return 'scrolled';
        }

        // Some Safari carousels use a transformed track instead of exposing
        // the track's scrollLeft. Preserve the previous tile-based movement
        // for those rails.
        const tiles = Array.from(rail.querySelectorAll<HTMLElement>(
          '[class*="tile" i], [class*="card" i], [class*="event" i], li, article, [role="listitem"], a',
        )).filter(tile => tile.offsetParent !== null);
        const railRect = rail.getBoundingClientRect();
        const nextTile = tiles.find(tile => {
          const rect = tile.getBoundingClientRect();
          return rect.width > 50 && rect.height > 50 &&
            rect.bottom > railRect.top && rect.top < railRect.bottom &&
            rect.left >= railRect.right - 10;
        });
        if (nextTile) {
          nextTile.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          return 'scrolled';
        }

        // Give a virtualized rail one render pass to append further cards
        // before treating its current scroll width as its true end.
        const observedState = scrollTargets
          .map(target => `${target.scrollLeft}/${target.scrollWidth - target.clientWidth}`)
          .join('|');
        if (rail.getAttribute('data-ios-dontmiss-observed-state') !== observedState) {
          rail.setAttribute('data-ios-dontmiss-observed-state', observedState);
          rail.dispatchEvent(new Event('scroll'));
          return 'waiting';
        }
        return 'end';
      }).catch(() => 'missing');
      if (scrollState === 'missing' || scrollState === 'end') {
        console.log('📜 Reached the end of the "Don\'t miss" rail.');
        break;
      }
      console.log(scrollState === 'scrolled'
        ? `↔️ Scrolled "Don\'t miss" rail horizontally (${i + 1}/${maxCarouselScrolls}).`
        : `↔️ Waiting for "Don\'t miss" rail to load more tiles (${i + 1}/${maxCarouselScrolls}).`);
      await this.driver.pause(700);

      urlBeforeTileClick = await this.driver.getUrl().catch(() => '');
      clickTarget = await markVisibleMatchingTile();
      if (clickTarget && await clickMarkedMatchingTile()) {
        await this.waitForSafariAfterDontMissClick(eventName, urlBeforeTileClick);
        console.log(`✅ Clicked ${clickTarget} for PPV tile "${eventName}" in "Don't miss".`);
        return true;
      }
    }
    return false;
  }

  private async waitForSafariAfterDontMissClick(eventName: string, previousUrl: string): Promise<void> {
    const eventTerms = this.normalisePpvMatchText(eventName)
      .split(/\s+/)
      .filter(term => term.length >= 3 && term !== 'vs');
    let postClickState = '';
    const markVisibleModalBuyNow = async (): Promise<boolean> => Boolean(await this.driver.execute((terms: string[]) => {
      document.querySelectorAll('[data-ios-dontmiss-modal-buy="true"]')
        .forEach(element => element.removeAttribute('data-ios-dontmiss-modal-buy'));
      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const isForeground = (element: HTMLElement): boolean => {
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(topElement && (topElement === element || element.contains(topElement)));
      };
      for (const button of Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'))) {
        if (!isVisible(button) || !isForeground(button) || !/^buy now$/i.test((button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim())) continue;
        let modal: HTMLElement | undefined;
        for (let element = button.parentElement; element && element !== document.body; element = element.parentElement) {
          const rect = element.getBoundingClientRect();
          const text = (element.innerText || element.textContent || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
          if (isVisible(element) && rect.width < window.innerWidth * 0.98 && rect.height < window.innerHeight * 0.98 &&
            terms.every(term => text.includes(term))) {
            modal = element;
            break;
          }
        }
        const modalText = (modal?.innerText || modal?.textContent || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        if (modal && isVisible(modal) && terms.every(term => modalText.includes(term))) {
          button.setAttribute('data-ios-dontmiss-modal-buy', 'true');
          return 'modal';
        }
      }
      return '';
    }, eventTerms).catch(() => ''));
    await this.driver.pause(5000);
    await this.driver.waitUntil(async () => {
      const currentUrl = await this.driver.getUrl().catch(() => '');
      if (currentUrl && currentUrl !== previousUrl) {
        postClickState = 'navigated';
        return true;
      }
      postClickState = (await markVisibleModalBuyNow()) ? 'modal' : '';
      return Boolean(postClickState);
    }, {
      timeout: Number(process.env.IOS_SAFARI_AFTER_TILE_CLICK_TIMEOUT_MS || 20000),
      interval: 500,
      timeoutMsg: `Safari PPV tile "${eventName}" did not open its modal or navigate to checkout.`,
    });
    if (postClickState !== 'modal') return;

    const clickedModalBuyNow = await this.driver.execute(() => {
      const button = document.querySelector<HTMLElement>('[data-ios-dontmiss-modal-buy="true"]');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!topElement || (topElement !== button && !button.contains(topElement))) return false;
      button.click();
      return true;
    }).catch(() => false);
    if (!clickedModalBuyNow) {
      throw new Error(`Safari PPV modal Buy now button disappeared for "${eventName}".`);
    }
    await this.driver.waitUntil(async () => {
      const currentUrl = await this.driver.getUrl().catch(() => '');
      if (currentUrl && currentUrl !== previousUrl) return true;
      return !(await markVisibleModalBuyNow());
    }, {
      timeout: Number(process.env.IOS_SAFARI_AFTER_TILE_CLICK_TIMEOUT_MS || 20000),
      interval: 500,
      timeoutMsg: `Safari PPV modal Buy now did not advance for "${eventName}".`,
    });
    console.log(`✅ Clicked scoped Buy now for PPV modal "${eventName}".`);
  }
}

export async function findEl(driver: WdBrowser, sel: string, timeoutMs = 10000): Promise<WdElement> {
  return new IOSBasePage(driver).findEl(sel, timeoutMs);
}

export async function tapByText(driver: WdBrowser, text: string, timeoutMs = 10000): Promise<boolean> {
  return new IOSBasePage(driver).tapByText(text, timeoutMs);
}

export async function isVisible(driver: WdBrowser, text: string, timeoutMs = 3000): Promise<boolean> {
  return new IOSBasePage(driver).isVisible(text, timeoutMs);
}

export async function scrollToText(driver: WdBrowser, text: string): Promise<boolean> {
  return new IOSBasePage(driver).scrollToText(text);
}

export async function swipeLeft(driver: WdBrowser): Promise<void> {
  return new IOSBasePage(driver).swipeLeft();
}

export async function scrollDown(driver: WdBrowser): Promise<void> {
  return new IOSBasePage(driver).scrollDown();
}

export async function findPPVBanner(driver: WdBrowser, ppvName: string): Promise<boolean> {
  return new IOSBasePage(driver, ppvName).findPPVBanner(ppvName);
}

export async function captureCheckoutUrl(driver: WdBrowser): Promise<string> {
  return new IOSBasePage(driver).captureCheckoutUrl();
}

export async function openCapturedUrlInNewSafariTab(driver: WdBrowser, capturedUrl: string): Promise<string> {
  return new IOSBasePage(driver).openCapturedUrlInNewSafariTab(capturedUrl);
}
