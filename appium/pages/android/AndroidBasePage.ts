import { execFileSync, execSync } from 'child_process';
import { BannerInteraction } from '../../utils/bannerInteraction';
import { normalizeAndroidTitle } from '../../utils/androidTitleNormalizer';

export type WdBrowser = any;
export type WdElement = any;

export interface AndroidScreenSize {
  width: number;
  height: number;
}

export type AndroidPPVSurface = 'PPV Banner' | 'PPV Tile' | 'PPV Popup';

export interface AndroidFlowHooks {
  validateSurface?: (surface: AndroidPPVSurface) => Promise<void>;
  validatePaywall?: () => Promise<void>;
  recordAvailability?: (available: boolean, screenshot?: string, page?: string) => void;
  saveScreenshot?: (relativePath: string) => Promise<string | undefined>;
  generateAvailabilityFailureReport?: (errorMessage: string) => Promise<void>;
}

export interface AndroidCopyResult {
  captured: boolean;
  url: string;
}

export interface AndroidChromeLaunch {
  context: any;
  browser: any | null;
  cleanup: () => Promise<void>;
}

const MOBILE_BROWSER_PACKAGE = process.env.MOBILE_BROWSER_PACKAGE || 'com.android.chrome';
const ANDROID_SDK = process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`;
const ADB = `${ANDROID_SDK}/platform-tools/adb`;
const DEVICE_SERIAL = process.env.DEVICE_SERIAL || '';

export function adb(cmd: string): string {
  try {
    const serialArg = DEVICE_SERIAL ? `-s ${DEVICE_SERIAL} ` : '';
    return execSync(`${ADB} ${serialArg}${cmd}`, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

export function getScreenSize(): AndroidScreenSize {
  const output = adb('shell wm size');
  const match = output.match(/(\d+)x(\d+)/);
  if (match) {
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
  }
  return { width: 1080, height: 2340 };
}

export function adbTap(x: number, y: number): void {
  adb(`shell input tap ${x} ${y}`);
}

export function adbSwipe(x1: number, y1: number, x2: number, y2: number): void {
  adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} 150`);
}

export function adbBack(): void {
  adb('shell input keyevent 4');
}

export function closeMobileBrowser(): void {
  console.log(`Closing mobile browser (${MOBILE_BROWSER_PACKAGE})...`);
  adb(`shell am force-stop ${MOBILE_BROWSER_PACKAGE}`);
}

/** Launch a regular Chrome tab and attach through its standard CDP socket. */
export async function launchAndroidChrome(
  device: any,
  chromium: any,
  _options: Record<string, any>,
  packageName = MOBILE_BROWSER_PACKAGE,
): Promise<AndroidChromeLaunch> {
  if (packageName !== 'com.android.chrome') {
    throw new Error(`Android Chrome CDP handoff requires com.android.chrome; received "${packageName}".`);
  }

  let forwardPort = '';
  const serial = device.serial();
  try {
    console.log('Launching Chrome through its standard CDP socket in a regular tab...');
    await device.shell(`am force-stop ${packageName}`);
    await device.shell(
      `am start -n ${packageName}/com.google.android.apps.chrome.Main ` +
      '-a android.intent.action.VIEW -d about:blank',
    );
    await new Promise(resolve => setTimeout(resolve, 1000));

    forwardPort = execFileSync(
      ADB,
      ['-s', serial, 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'],
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();
    if (!/^\d+$/.test(forwardPort)) {
      throw new Error(`ADB did not provide a Chrome CDP port: "${forwardPort}"`);
    }

    let browser: any;
    let lastError: any;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${forwardPort}`);
        break;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!browser) {
      throw new Error(`Could not connect to Chrome CDP: ${lastError?.message || 'unknown error'}`);
    }

    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome CDP connected without a browser context.');
    await context.clearCookies();
    const pages = context.pages();
    if (pages.length > 0) {
      const session = await context.newCDPSession(pages[0]);
      try {
        await session.send('Network.clearBrowserCache');
      } finally {
        await session.detach();
      }
    }
    return {
      context,
      browser,
      cleanup: async () => {
        execFileSync(ADB, ['-s', serial, 'forward', '--remove', `tcp:${forwardPort}`], {
          encoding: 'utf-8',
          timeout: 15000,
        });
      },
    };
  } catch (error) {
    if (forwardPort) {
      try {
        execFileSync(ADB, ['-s', serial, 'forward', '--remove', `tcp:${forwardPort}`], {
          encoding: 'utf-8',
          timeout: 15000,
        });
      } catch {}
    }
    throw error;
  }
}

export function getChromeUrl(): string {
  adb('shell uiautomator dump /sdcard/window_dump.xml');
  const dump = adb('shell cat /sdcard/window_dump.xml');
  const m1 = dump.match(/https:\/\/[^\s"']*dazn\.com[^\s"']*/);
  if (m1) return m1[0];
  const tabs = adb('shell content query --uri content://com.android.chrome.FileProvider 2>/dev/null');
  const m2 = tabs.match(/https:\/\/[^\s'"]*dazn\.com[^\s'"]*/);
  if (m2) return m2[0];
  return '';
}

export class AndroidBasePage {
  constructor(protected driver: WdBrowser, protected ppvName = process.env.PPV_NAME || 'Joshua') {}

  /** Discovery-only allowance for a promotion title with its event number omitted. */
  protected isPpvDiscoveryTitle(actual: string, expected = this.ppvName): boolean {
    const clean = (value: string) => normalizeAndroidTitle(
      String(value || '').replace(/-List:[^\s]+$/i, '').replace(/,\s*(?:article|button)$/i, ''),
      ' ',
    );
    if (clean(actual) === clean(expected)) return true;

    const expectedParts = String(expected || '').match(/^\s*(.+?)\s+(\d+)\s*:\s*(.+?)\s*$/);
    const actualParts = String(actual || '').match(/^\s*(.+?)\s*:\s*(.+?)\s*$/);
    return Boolean(
      expectedParts && actualParts &&
      normalizeAndroidTitle(expectedParts[1], ' ') === normalizeAndroidTitle(actualParts[1], ' ') &&
      normalizeAndroidTitle(expectedParts[3], ' ') === normalizeAndroidTitle(actualParts[2], ' '),
    );
  }

  protected ppvDiscoveryTitleQuery(value = this.ppvName): string {
    const parts = String(value || '').match(/^\s*(.+?)\s+\d+\s*:\s*(.+?)\s*$/);
    return parts ? `${parts[1]}: ${parts[2]}`.trim() : String(value || '').trim();
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

  async tapByText(text: string, timeoutMs = 10000): Promise<boolean> {
    const el = await this.findEl(`android=new UiSelector().textContains("${text}")`, timeoutMs);
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

  async isVisible(text: string, timeoutMs = 3000): Promise<boolean> {
    try {
      const el = await this.driver.$(`android=new UiSelector().textContains("${text}")`);
      await el.waitForDisplayed({ timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async ensureOnHome(): Promise<void> {
    console.log('  Ensuring navigation to Home tab...');
    const homeSelectors = [
      'android=new UiSelector().text("Home")',
      'android=new UiSelector().descriptionContains("Home")',
      '//android.widget.ImageView[contains(@content-desc, "Home")]',
      '//android.widget.TextView[contains(@text, "Home")]',
    ];

    const startTime = Date.now();
    const maxWaitMs = 12000;

    while (Date.now() - startTime < maxWaitMs) {
      for (const selector of homeSelectors) {
        try {
          const homeEl = await this.driver.$(selector);
          if (await homeEl.isDisplayed().catch(() => false)) {
            console.log('  ✓ Home tab verified as visible on screen. Tapping Home tab...');
            await homeEl.click();
            await this.driver.pause(2500);
            return;
          }
        } catch { }
      }
      console.log('  Waiting for page transition and Home tab to become visible...');
      await this.driver.pause(1500);
    }

    const homeClicked = await this.tapByText('Home', 3000);
    if (homeClicked) {
      await this.driver.pause(2500);
      return;
    }
  }

  /**
   * For Ultimate users logged in app: after tapping a PPV tile, a PIN Protection modal may appear.
   * Clicks the "WATCH NOW" button to proceed to the fixture page.
   */
  async handlePinProtectionIfPresent(timeoutMs = 6000): Promise<boolean> {
    console.log('🔒 Checking for PIN Protection screen / "WATCH NOW" button...');
    await this.driver.pause(2500);

    const watchNowSelectors = [
      'android=new UiSelector().text("WATCH NOW")',
      'android=new UiSelector().textContains("WATCH NOW")',
      'android=new UiSelector().text("Watch Now")',
      'android=new UiSelector().textContains("Watch Now")',
      'android=new UiSelector().textMatches("(?i)WATCH NOW")',
      '//*[contains(@text, "WATCH NOW") or contains(@text, "Watch Now") or contains(@text, "Watch now")]',
      '//*[@content-desc="WATCH NOW" or @content-desc="Watch Now"]',
      '//*[contains(translate(@text, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "watch now")]',
    ];

    let watchNowBtn: WdElement = null;

    for (const selector of watchNowSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed().catch(() => false)) {
          watchNowBtn = el;
          console.log(`  Found "WATCH NOW" button with selector: ${selector}`);
          break;
        }
      } catch {
        // continue trying other selectors
      }
    }

    if (!watchNowBtn) {
      try {
        const pinHeader = await this.driver.$('android=new UiSelector().textContains("PIN PROTECTION")');
        if (await pinHeader.isDisplayed().catch(() => false)) {
          console.log('  Found PIN PROTECTION header, searching for WATCH NOW button...');
          watchNowBtn = await this.findEl('android=new UiSelector().textContains("WATCH")', 3000);
        }
      } catch {
        // no pin header found
      }
    }

    if (watchNowBtn) {
      console.log('✨ [PIN Protection] Modal detected! Tapping "WATCH NOW" button...');
      try {
        await watchNowBtn.click();
      } catch {
        console.log('  Direct click on WATCH NOW failed, trying tapByText fallback...');
        await this.tapByText('WATCH NOW', 3000);
      }
      await this.driver.pause(4000);
      await this.driver.saveScreenshot('./test-results/android_pin_protection_watch_now_clicked.png').catch(() => {});
      console.log('  ✓ Tapped "WATCH NOW" button and navigated to fixture page.');
      return true;
    } else {
      console.log('  ℹ️ PIN Protection screen not displayed or already bypassed.');
      return false;
    }
  }

  async scrollToText(text: string): Promise<boolean> {
    try {
      const el = await this.driver.$(
        `android=new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(` +
        `new UiSelector().textContains("${text}"))`,
      );
      return await el.isDisplayed();
    } catch {
      return false;
    }
  }

  async swipeLeft(): Promise<void> {
    const { width, height } = await this.driver.getWindowSize();
    await this.driver.action('pointer')
      .move({ x: Math.round(width * 0.8), y: Math.round(height * 0.35) })
      .down()
      .move({ x: Math.round(width * 0.2), y: Math.round(height * 0.35) })
      .up()
      .perform();
    await this.driver.pause(800);
  }

  async scrollDown(): Promise<void> {
    const { width, height } = await this.driver.getWindowSize();
    await this.driver.action('pointer')
      .move({ x: Math.round(width / 2), y: Math.round(height * 0.75) })
      .down()
      .move({ x: Math.round(width / 2), y: Math.round(height * 0.25) })
      .up()
      .perform();
    await this.driver.pause(600);
  }

  async findPPVBanner(ppvName = this.ppvName): Promise<boolean> {
    const discoveryTitle = this.ppvDiscoveryTitleQuery(ppvName);
    if (await this.isVisible(discoveryTitle, 4000)) return true;
    for (let i = 0; i < 5; i++) {
      await this.swipeLeft();
      if (await this.isVisible(discoveryTitle, 1500)) return true;
    }
    if (await this.scrollToText(discoveryTitle)) return true;
    for (let i = 0; i < 8; i++) {
      await this.scrollDown();
      if (await this.isVisible(discoveryTitle, 1500)) return true;
    }
    return false;
  }

  async findBannerOnCurrentPage(
    ppvName = this.ppvName,
    options: { horizontalSwipes?: number; verticalScrolls?: number; isLandingPage?: boolean } = {},
  ): Promise<boolean> {
    const horizontalSwipes = options.horizontalSwipes ?? 10;
    const isLandingPage = options.isLandingPage ?? false;
    const normalizedPpvName = ppvName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const titleNorm = normalizeAndroidTitle(ppvName, ' ');
    const withoutDots = ppvName.replace(/\./g, '');
    const withoutDotsNorm = normalizeAndroidTitle(withoutDots, ' ');
    const discoveryTitle = this.ppvDiscoveryTitleQuery(ppvName);
    const usesNumberOmissionAlias = discoveryTitle !== ppvName;
    const ppvNameCandidates = Array.from(new Set([
      ppvName,
      normalizedPpvName,
      titleNorm,
      withoutDots,
      withoutDotsNorm,
      ppvName.replace(/vs\.?/i, 'vs').trim(),
      normalizedPpvName.replace(/vs\.?/i, 'vs').trim(),
      discoveryTitle,
    ])).filter(Boolean);

    const isCurrentBannerVisibleOnScreen = async (): Promise<boolean> => {
      const windowSize = await this.driver.getWindowSize().catch(() => ({ width: 1080, height: 2400 }));
      const bannerMaxY = Math.round(windowSize.height * (isLandingPage ? 0.90 : 0.55));

      // 1. Exclude generic schedule/promo slides (e.g. "Your Boxing Schedule" / "See schedule")
      if (!isLandingPage) {
        try {
          const scheduleEls = await this.driver.$$('android=new UiSelector().textMatches("(?i).*(see schedule|your boxing schedule).*")');
          for (const el of scheduleEls) {
            if (await el.isDisplayed().catch(() => false)) {
              const loc = await el.getLocation().catch(() => null);
              if (loc && loc.y < bannerMaxY) {
                console.log('  ℹ️ Active slide is "Your Boxing Schedule" (not the dedicated PPV banner). Swiping...');
                return false;
              }
            }
          }
        } catch { }
      }

      // 1b. Exclude ancillary / preview slides (e.g. "LOCKED IN: Rolly vs. Teofimo | Official Preview")
      const ancillaryBlocklist = [
        'official preview', 'preview', 'locked in', 'press conference', 'press conf',
        'weigh-in', 'weigh in', 'highlights', 'prelims', 'pre-show', 'pre show',
        'buy-in', 'buy in', 'tailgate', 'the making of', 're-live',
        'relive', 'countdown', 'all access', 'rewind', 'behind the scenes', 'workout',
        'open workout', 'grand arrivals', 'documentary', 'episode',
      ];

      const isAncillaryText = (txt: string) => {
        const lower = (txt || '').toLowerCase();
        return ancillaryBlocklist.some(term => lower.includes(term));
      };

      // Extract individual fighter words for multi-line banner cards (e.g. "Rolly vs. Teófimo" -> ["Rolly", "Teófimo"])
      const fighterParts = ppvName.split(/\s+vs\.?\s+/i)
        .map(p => p.trim())
        .filter(p => p.length > 2);

      // 2. Check for exact/clean title candidates in the top banner region
      for (const candidate of ppvNameCandidates) {
        try {
          const els = await this.driver.$$(`android=new UiSelector().textContains("${candidate}")`);
          for (const el of els) {
            if (await el.isDisplayed().catch(() => false)) {
              const elText = await el.getText().catch(() => '');
              if (isAncillaryText(elText)) {
                console.log(`  ℹ️ Ignored ancillary preview slide title: "${elText}"`);
                continue;
              }
              if (usesNumberOmissionAlias && !this.isPpvDiscoveryTitle(elText, ppvName)) continue;
              const loc = await el.getLocation().catch(() => null);
              if (loc && loc.y < bannerMaxY) {
                console.log(`  🎯 Found PPV banner title "${elText || candidate}" in hero banner region (y=${loc.y} < ${bannerMaxY})`);
                return true;
              } else if (loc) {
                console.log(`  ℹ️ Ignored "${candidate}" in content rail below banner (y=${loc.y} >= ${bannerMaxY})`);
              }
            }
          }
        } catch { }
        try {
          const descEls = await this.driver.$$(`android=new UiSelector().descriptionContains("${candidate}")`);
          for (const el of descEls) {
            if (await el.isDisplayed().catch(() => false)) {
              const elDesc = await el.getAttribute('content-desc').catch(() => '');
              if (isAncillaryText(elDesc)) {
                console.log(`  ℹ️ Ignored ancillary preview slide description: "${elDesc}"`);
                continue;
              }
              if (usesNumberOmissionAlias && !this.isPpvDiscoveryTitle(elDesc, ppvName)) continue;
              const loc = await el.getLocation().catch(() => null);
              if (loc && loc.y < bannerMaxY) {
                console.log(`  🎯 Found PPV banner description "${elDesc || candidate}" in hero banner region (y=${loc.y} < ${bannerMaxY})`);
                return true;
              } else if (loc) {
                console.log(`  ℹ️ Ignored description "${candidate}" in content rail below banner (y=${loc.y} >= ${bannerMaxY})`);
              }
            }
          }
        } catch { }
      }

      // 3. Check if all fighter names + banner CTA/PPV indicators are visible in hero banner region
      if (fighterParts.length >= 2) {
        try {
          let foundCount = 0;
          for (const part of fighterParts) {
            const normPart = part.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const partNormTitle = normalizeAndroidTitle(part, ' ');
            const partCandidates = Array.from(new Set([part, normPart, partNormTitle]));
            let partFoundInBanner = false;
            for (const pc of partCandidates) {
              const els = await this.driver.$$(`android=new UiSelector().textContains("${pc}")`);
              for (const el of els) {
                if (await el.isDisplayed().catch(() => false)) {
                  const elText = await el.getText().catch(() => '');
                  if (isAncillaryText(elText)) continue;
                  const loc = await el.getLocation().catch(() => null);
                  if (loc && loc.y < bannerMaxY) {
                    partFoundInBanner = true;
                    break;
                  }
                }
              }
              if (partFoundInBanner) break;
            }
            if (partFoundInBanner) foundCount++;
          }

          if (foundCount >= fighterParts.length) {
            // Verify there is also a PPV/CTA button or badge in the banner region
            const ctaEls = await this.driver.$$('android=new UiSelector().textMatches("(?i).*(buy|fight card|get ppv|set reminder|pay-per-view|copy).*")');
            let hasBannerCta = false;
            for (const el of ctaEls) {
              if (await el.isDisplayed().catch(() => false)) {
                const loc = await el.getLocation().catch(() => null);
                if (loc && loc.y < bannerMaxY) {
                  hasBannerCta = true;
                  break;
                }
              }
            }
            if (hasBannerCta || isLandingPage) {
              console.log(`  🎯 Found all fighters (${fighterParts.join(', ')}) in hero banner region with valid CTA`);
              return true;
            }
          }
        } catch { }
      }

      return false;
    };

    console.log(`  Checking if "${ppvName}" is the active banner on screen...`);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await isCurrentBannerVisibleOnScreen()) {
        console.log(`  ✓ Banner "${ppvName}" is currently active on screen!`);
        return true;
      }
      await this.driver.pause(500);
    }

    console.log(`  PPV banner "${ppvName}" not active on screen. Swiping banner carousel horizontally to find "${ppvName}"...`);
    for (let i = 0; i < horizontalSwipes; i++) {
      await this.swipeLeft();
      await this.driver.pause(1200);
      if (await isCurrentBannerVisibleOnScreen()) {
        console.log(`  ✓ Found and centered banner "${ppvName}" on horizontal swipe ${i + 1}!`);
        return true;
      }
    }

    return false;
  }

  async tapBuyCtaWithFallback(
    ctas = ['Buy now', 'Buy Now', 'Buy this fight', 'Buy', 'Get PPV'],
    options: { primaryTimeoutMs?: number; fallbackTimeoutMs?: number; scrollBeforeFallback?: boolean } = {},
  ): Promise<boolean> {
    const primaryTimeoutMs = options.primaryTimeoutMs ?? 6000;
    const fallbackTimeoutMs = options.fallbackTimeoutMs ?? 3000;

    const tapAndVerify = async (text: string, timeoutMs: number): Promise<boolean> => {
      const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const selector = `android=new UiSelector().textContains("${escapedText}")`;
      const firstElement = await this.findEl(selector, timeoutMs);
      if (!firstElement) return false;
      const elements = await this.driver.$$(selector).catch(() => [firstElement]);

      for (const element of elements) {
        if (!await element.isDisplayed().catch(() => false)) continue;

        const beforeSource = await this.driver.getPageSource().catch(() => '');
        const beforeActivity = await this.driver.getCurrentActivity().catch(() => '');
        const copyAlreadyVisible = await this.isVisible('Copy', 250) || await this.isVisible('copy', 250);
        const rect = typeof element.getRect === 'function'
          ? await element.getRect().catch(() => null)
          : await Promise.all([element.getLocation(), element.getSize()])
            .then(([location, size]: any[]) => ({
              x: location.x,
              y: location.y,
              width: size.width,
              height: size.height,
            }))
            .catch(() => null);

        try {
          await element.click();
        } catch {
          // Coordinate fallback below handles Compose/TextView nodes whose
          // element click resolves without delivering the touch to the CTA.
        }

        const waitForTransition = async (): Promise<boolean> => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < Math.min(timeoutMs, 3500)) {
            if (!copyAlreadyVisible && (await this.isVisible('Copy', 250) || await this.isVisible('copy', 250))) {
              return true;
            }

            const currentActivity = await this.driver.getCurrentActivity().catch(() => '');
            if (beforeActivity && currentActivity && currentActivity !== beforeActivity) return true;

            const ctaVisible = await this.isVisible(text, 250);
            const currentSource = await this.driver.getPageSource().catch(() => '');
            if (!copyAlreadyVisible && currentSource !== beforeSource && /copy|checkout|paste|https?:/i.test(currentSource)) {
              return true;
            }
            if (!ctaVisible && (!currentSource || currentSource !== beforeSource || !currentSource.toLowerCase().includes(text.toLowerCase()))) {
              return true;
            }

            await this.driver.pause(250);
          }
          return false;
        };

        if (await waitForTransition()) {
          console.log(`Tapped "${text}" (verified)`);
          return true;
        }

        if (rect && rect.width > 0 && rect.height > 0) {
          console.log(`  Element click did not trigger the Buy CTA. Retrying at (${Math.round(rect.x + rect.width / 2)}, ${Math.round(rect.y + rect.height / 2)})...`);
          adbTap(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
          if (await waitForTransition()) {
            console.log(`Tapped "${text}" via coordinate fallback (verified)`);
            return true;
          }
        }
      }

      return false;
    };

    for (const text of ctas) {
      if (await tapAndVerify(text, primaryTimeoutMs)) return true;
    }

    if (options.scrollBeforeFallback !== false) {
      await this.scrollDown();
      await this.driver.pause(1000);
    }

    for (const text of ['Buy now', 'Buy Now', 'Buy', 'Get PPV']) {
      if (await tapAndVerify(text, fallbackTimeoutMs)) return true;
    }

    return false;
  }

  async runSurfaceValidation(hooks: AndroidFlowHooks | undefined, surface: AndroidPPVSurface): Promise<void> {
    if (!hooks?.validateSurface) return;
    try {
      // Banner carousels advance automatically.  Hold the currently displayed
      // banner before collecting its copy so the PPV banner we found is the
      // banner that is validated (and later used for the Buy CTA).
      if (surface === 'PPV Banner') {
        const bannerInteraction = new BannerInteraction(this.driver);
        await bannerInteraction.withLock(async () => {
          await hooks.validateSurface!(surface);
        }, this.ppvName);
      } else {
        await hooks.validateSurface(surface);
      }
    } catch (err: any) {
      console.warn(`Mobile ${surface.toLowerCase()} validation failed: ${err.message}`);
    }
  }

  async runPaywallValidation(hooks: AndroidFlowHooks | undefined): Promise<void> {
    if (!hooks?.validatePaywall) return;
    try {
      await hooks.validatePaywall();
    } catch (err: any) {
      console.warn(`Mobile paywall validation failed: ${err.message}`);
    }
  }

  async readClipboardText(): Promise<string> {
    try {
      const base64Content = await this.driver.getClipboard();
      return Buffer.from(base64Content, 'base64').toString('utf8');
    } catch (e: any) {
      console.log(`Failed to get clipboard via Appium: ${e.message}. Trying ADB...`);
      return adb('shell am clipht get');
    }
  }

  isValidCheckoutUrl(url: string): boolean {
    return !!url && (url.includes('dazn.com') || url.includes('amazonaws.com'));
  }

  async captureCheckoutUrl(): Promise<string> {
    for (let attempt = 0; attempt < 15; attempt++) {
      await this.driver.pause(1000);
      try {
        const contexts = await this.driver.getContexts() as string[];
        const webCtx = contexts.find(
          (c) => c !== 'NATIVE_APP' && (c.includes('WEBVIEW') || c.includes('CHROMIUM') || c.includes('CDP')),
        );
        if (webCtx) {
          await this.driver.switchContext(webCtx);
          const url = await this.driver.getUrl();
          if (url && url.includes('dazn.com')) return url;
          await this.driver.switchContext('NATIVE_APP').catch(() => {});
        }
      } catch {}
      if (attempt % 3 === 2) {
        const adbUrl = getChromeUrl();
        if (adbUrl.includes('dazn.com')) return adbUrl;
      }
    }
    return getChromeUrl();
  }

  async dismissPromoPopup(): Promise<boolean> {
    const closeSelectors = [
      '//android.widget.ImageView[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
      '//android.widget.ImageButton[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
      '//android.widget.Button[contains(@content-desc, "close") or contains(@content-desc, "Close") or contains(@content-desc, "dismiss") or contains(@content-desc, "Dismiss")]',
      '//android.widget.ImageView[contains(@resource-id, "close") or contains(@resource-id, "dismiss") or contains(@resource-id, "btn_close") or contains(@resource-id, "close_button") or contains(@resource-id, "iv_close")]',
      '//android.widget.ImageButton[contains(@resource-id, "close") or contains(@resource-id, "dismiss") or contains(@resource-id, "btn_close") or contains(@resource-id, "close_button")]',
      '//android.widget.Button[contains(@resource-id, "close") or contains(@resource-id, "dismiss") or contains(@resource-id, "btn_close") or contains(@resource-id, "close_button")]',
      'android=new UiSelector().resourceIdMatches("(?i).*(btn_close|close_button|iv_close|dismiss_button|close_dialog|modal_close).*")',
      'android=new UiSelector().descriptionMatches("(?i)^(close|dismiss|close dialog|dismiss dialog|x)$")',
      'android=new UiSelector().textMatches("(?i)^(✕|×|x|close|dismiss|not now|no thanks|maybe later)$")',
      '//*[@content-desc="Close" or @content-desc="close" or @content-desc="Dismiss" or @content-desc="dismiss"]',
    ];

    for (const selector of closeSelectors) {
      try {
        const el = await this.driver.$(selector);
        if (await el.isDisplayed().catch(() => false)) {
          console.log(`  ✓ Found boxing / PPV promo popup close button ("${selector}"). Clicking close...`);
          try {
            await el.click();
          } catch (clickErr: any) {
            console.warn(`  Native click failed: ${clickErr.message}. Trying ADB tap fallback...`);
            const rect = await el.getRect();
            adbTap(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
          }
          await this.driver.pause(1500);
          return true;
        }
      } catch {}
    }
    return false;
  }
}

export async function findEl(driver: WdBrowser, sel: string, timeoutMs = 10000): Promise<WdElement> {
  return new AndroidBasePage(driver).findEl(sel, timeoutMs);
}

export async function tapByText(driver: WdBrowser, text: string, timeoutMs = 10000): Promise<boolean> {
  return new AndroidBasePage(driver).tapByText(text, timeoutMs);
}

export async function isVisible(driver: WdBrowser, text: string, timeoutMs = 3000): Promise<boolean> {
  return new AndroidBasePage(driver).isVisible(text, timeoutMs);
}

export async function scrollToText(driver: WdBrowser, text: string): Promise<boolean> {
  return new AndroidBasePage(driver).scrollToText(text);
}

export async function swipeLeft(driver: WdBrowser): Promise<void> {
  return new AndroidBasePage(driver).swipeLeft();
}

export async function scrollDown(driver: WdBrowser): Promise<void> {
  return new AndroidBasePage(driver).scrollDown();
}

export async function findPPVBanner(driver: WdBrowser, ppvName: string): Promise<boolean> {
  return new AndroidBasePage(driver, ppvName).findPPVBanner(ppvName);
}

export async function captureCheckoutUrl(driver: WdBrowser): Promise<string> {
  return new AndroidBasePage(driver).captureCheckoutUrl();
}

export async function dismissBoxingPromoPopup(driver: WdBrowser): Promise<boolean> {
  return new AndroidBasePage(driver).dismissPromoPopup();
}
