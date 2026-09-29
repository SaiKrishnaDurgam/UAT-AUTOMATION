import {
  IOSBasePage,
  IOSPPVSurface,
  WdBrowser,
  WdElement,
} from './IOSBasePage';
import { getIOSRenderedTextInBounds } from './IOSHomePage';
import { getIOSValidationSheet } from './IOSSurfacingPoint';
import { resolvePpvTitleForSurface } from '../../../utils/ppvTitleResolver';

// Timezone-aware date utilities loaded dynamically
let getDynamicDateTimeBadge: ((template: string, referenceDate?: Date) => string) | undefined;
let getNowForRegion: ((region?: string) => Date) | undefined;
let getIOSISTDateTimeCandidates: ((utcDate: string, timeZone?: string) => string) | undefined;
let getIOSISTDateCandidates: ((utcDate: string, timeZone?: string) => string) | undefined;
let getIOSISTScheduleFieldCandidates: ((utcDate: string, fieldName: string, timeZone?: string) => string) | undefined;
try {
  // IOSValidationPage lives at appium/pages/ios, so three parents reach the
  // repository root. Four parents resolved outside the project and silently
  // disabled all region-aware date handling.
  const dateUtils = require('../../../utils/dateUtils');
  getDynamicDateTimeBadge = dateUtils.getDynamicDateTimeBadge;
  getNowForRegion = dateUtils.getNowForRegion;
  getIOSISTDateTimeCandidates = dateUtils.getIOSISTDateTimeCandidates;
  getIOSISTDateCandidates = dateUtils.getIOSISTDateCandidates;
  getIOSISTScheduleFieldCandidates = dateUtils.getIOSISTScheduleFieldCandidates;
} catch (e) {
  console.warn('⚠️ Failed to load timezone utilities, date validation will use device timezone');
}

export interface IOSValidationResult {
  page: string;
  field: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  screenshot?: string;
}

/**
 * Native-app validation only.
 *
 * The iOS handoff opens an Apple confirmation and then Safari at DAZN home.
 * Safari checkout validation must run in a WebdriverIO web context and must
 * not be added to this class, otherwise native and browser selectors/data are
 * mixed in the same validation result.
 */
export class IOSValidationPage extends IOSBasePage {

  private lastBannerValidationSource = '';

  private static readonly IOS_ONLY_UNSUPPORTED_PAYWALL_FIELDS = new Set([
    'instruction text',
    'copy button',
    'copy url present',
  ]);

  /** The native sheet uses the event instant, not the web workbook's copy URL fields. */
  private getExpectedNativeEventDate(eventData: Record<string, any>): string {
    const utcDate = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;
    if (!utcDate || Number.isNaN(new Date(utcDate).getTime())) {
      const mobileDate = String(eventData.MOBILE_PPV_DATE || '').trim();
      return /\b\d{1,2}\s+[a-z]{3}\b/i.test(mobileDate) && /\d{1,2}:\d{2}/.test(mobileDate)
        ? mobileDate.toUpperCase()
        : '';
    }

    const iosTimeZone = String(process.env.IOS_EXPECTED_TIMEZONE || 'Asia/Kolkata');
    const istExpected = getIOSISTDateTimeCandidates?.(String(utcDate), iosTimeZone);
    if (istExpected) return istExpected;

    const region = String(eventData.REGION || eventData.region || process.env.DAZN_REGION || 'GB').toUpperCase();
    const timeZones: Record<string, string> = {
      GB: 'Europe/London', UK: 'Europe/London', US: 'America/New_York',
      AE: 'Asia/Dubai', SA: 'Asia/Riyadh', AU: 'Australia/Sydney',
      BR: 'America/Sao_Paulo', DE: 'Europe/Berlin', IT: 'Europe/Rome',
      ES: 'Europe/Madrid', FR: 'Europe/Paris', CA: 'America/Toronto', JP: 'Asia/Tokyo',
    };
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZones[region] || 'Europe/London', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).formatToParts(new Date(utcDate));
    const values: Record<string, string> = {};
    for (const part of parts) values[part.type] = part.value;
    return `${values.day} ${values.month} ${values.hour}:${values.minute} ${values.dayPeriod}`.toUpperCase();
  }

  private getIOSISTExpectedForField(eventData: Record<string, any>, fieldName: string, currentExpected = ''): string {
    if (!currentExpected || currentExpected.trim().toUpperCase() === 'N/A') return '';
    const utcDate = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;
    if (!utcDate || Number.isNaN(new Date(utcDate).getTime())) return '';
    const fieldLower = String(fieldName || '').toLowerCase();
    const iosTimeZone = String(process.env.IOS_EXPECTED_TIMEZONE || 'Asia/Kolkata');
    const expectedHasCalendarDate = /\b(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(currentExpected);
    const expectedHasTime = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i.test(currentExpected);
    const hasDate = fieldLower.includes('date') || (expectedHasCalendarDate && expectedHasTime);
    const hasTime = fieldLower.includes('time') || (expectedHasCalendarDate && expectedHasTime);
    if (hasDate && hasTime) {
      return getIOSISTDateTimeCandidates?.(String(utcDate), iosTimeZone) || '';
    }
    if (hasTime) {
      return getIOSISTScheduleFieldCandidates?.(String(utcDate), 'time', iosTimeZone) || '';
    }
    if (hasDate) {
      return getIOSISTDateCandidates?.(String(utcDate), iosTimeZone) || '';
    }
    return '';
  }

  private async ensureNativeAppContext(): Promise<void> {
    try {
      const contexts = await this.driver.getContexts() as string[];
      if (contexts.includes('NATIVE_APP')) {
        await this.driver.switchContext('NATIVE_APP');
      }
    } catch {
      // Some XCUITest sessions expose only the native context.  In that case
      // there is nothing to switch and native element lookup remains valid.
    }
  }

  async captureAndMarkFailureScreenshot(
    surface: string,
    fieldName: string,
    expectedValue: string,
    actualValue: string
  ): Promise<string> {
    let screenshotPath = '';
    try {
      const fs = require('fs');
      const path = require('path');
      const SHOTS_DIR = path.resolve(process.cwd(), 'test-results/failure-shots');
      if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

      screenshotPath = path.resolve(
        SHOTS_DIR,
        `ios_${String(surface || 'page').replace(/[^a-zA-Z0-9]/g, '_')}_${String(fieldName || 'field').replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.png`
      );
      const verifiedBannerScreenshot = surface === 'PPV Banner'
        ? this.getCurrentBannerValidationScreenshot()
        : '';
      if (verifiedBannerScreenshot) {
        fs.writeFileSync(screenshotPath, Buffer.from(verifiedBannerScreenshot, 'base64'));
      } else {
        await this.driver.saveScreenshot(screenshotPath);
      }

      // Highlight the visible failing native field when XCUITest exposes it.
      // Artwork text in the Don't Miss rail is commonly absent from the tree;
      // retain the rail fallback so that case still has focused evidence.
      let bounds: { x: number; y: number; width: number; height: number } | null = null;
      const getElementBounds = async (element: any): Promise<{ x: number; y: number; width: number; height: number } | null> => {
        // WDIO's iOS element wrapper does not consistently implement getRect;
        // location and size are available for both native element variants.
        if (typeof element?.getLocation !== 'function' || typeof element?.getSize !== 'function') return null;
        const [location, size] = await Promise.all([
          element.getLocation().catch(() => null),
          element.getSize().catch(() => null),
        ]);
        return location && size && size.width > 0 && size.height > 0
          ? { x: location.x, y: location.y, width: size.width, height: size.height }
          : null;
      };
      const rawCandidates = [actualValue, expectedValue]
        .filter(value => value && value !== 'Not found' && value.length > 2)
        .map(value => value.trim().toLowerCase());
      const candidates = rawCandidates
        .map(value => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))
        .map(value => value.slice(0, 120));
      const snapshotNodes = surface === 'PPV Banner'
        ? [
          ...(this.lastBannerValidationSource.match(/<XCUIElementType(?:StaticText|Button|Link)\b[^>]*>/g) || []),
          ...(this.lastBannerValidationSource.match(/<XCUIElementTypeOther\b[^>]*>/g) || []),
        ]
        : [];
      for (const candidate of rawCandidates) {
        const node = snapshotNodes.find(value => value
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
          .toLowerCase().includes(candidate));
        if (!node) continue;
        const readNumber = (attribute: string) => Number(node.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1]);
        const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(readNumber);
        if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
          bounds = { x, y, width, height };
          break;
        }
      }
      for (const candidate of candidates) {
        if (bounds) break;
        const selector = `-ios predicate string:label CONTAINS[c] '${candidate}' OR name CONTAINS[c] '${candidate}' OR value CONTAINS[c] '${candidate}'`;
        const element = await this.driver.$(selector).catch(() => null);
        if (!element || !await element.isDisplayed().catch(() => false)) continue;
        const rect = await getElementBounds(element);
        if (rect) {
          bounds = rect;
          break;
        }
      }
      if (!bounds && surface === 'PPV Tile') {
        for (const label of ["Don't Miss", 'Don’t Miss', 'Dont Miss']) {
          const header = await this.driver.$(`~${label}`).catch(() => null);
          if (header && await header.isDisplayed().catch(() => false)) {
            const rect = await getElementBounds(header);
            const screen = await this.driver.getWindowRect().catch(() => null);
            if (rect && screen) {
              bounds = {
                x: 0,
                y: rect.y + rect.height,
                width: screen.width,
                height: Math.min(Math.round(screen.height * 0.34), screen.height - rect.y - rect.height),
              };
              break;
            }
          }
        }
      }

      if (bounds) {
        // Jimp v1 exports its constructor as `{ Jimp }`; v0 exported the
        // constructor directly. Support both so diagnostics never fail solely
        // because the installed Jimp API changed.
        const jimpModule = require('jimp');
        const Jimp = jimpModule.Jimp || jimpModule;
        const image = await Jimp.read(screenshotPath);
        const screen = await this.driver.getWindowRect().catch(() => null);
        const scaleX = image.bitmap.width / (screen?.width || image.bitmap.width);
        const scaleY = image.bitmap.height / (screen?.height || image.bitmap.height);
        const left = Math.max(0, Math.round(bounds.x * scaleX));
        const top = Math.max(0, Math.round(bounds.y * scaleY));
        const right = Math.min(image.bitmap.width - 1, Math.round((bounds.x + bounds.width) * scaleX));
        const bottom = Math.min(image.bitmap.height - 1, Math.round((bounds.y + bounds.height) * scaleY));
        for (let thickness = 0; thickness < 4; thickness++) {
          for (let x = left; x <= right; x++) {
            image.setPixelColor(0xff1744ff, x, Math.min(bottom, top + thickness));
            image.setPixelColor(0xff1744ff, x, Math.max(top, bottom - thickness));
          }
          for (let y = top; y <= bottom; y++) {
            image.setPixelColor(0xff1744ff, Math.min(right, left + thickness), y);
            image.setPixelColor(0xff1744ff, Math.max(left, right - thickness), y);
          }
        }
        if (typeof image.writeAsync === 'function') {
          await image.writeAsync(screenshotPath);
        } else {
          await image.write(screenshotPath);
        }
        console.log(`📸 [Fail Shot] Highlighted iOS field "${fieldName}": ${screenshotPath}`);
      }
      return screenshotPath;
    } catch (e: any) {
      console.warn(`⚠️ Failed to capture failure screenshot:`, e.message);
      // The base screenshot was saved before optional annotation. Keep it as
      // report evidence even if the image-marking library is unavailable.
      return screenshotPath;
    }
  }

  // ── Paywall: gather all visible text elements on iOS ──────────────────────
  async gatherTextsFromPaywall(): Promise<{
    texts: string[];
    pageSource: string;
    mobileDateText: string;
  }> {
    await this.ensureNativeAppContext();
    const textsSet = new Set<string>();
    let pageSource = '';

    // Do not retain XCUI element references here. The paywall is a native
    // bottom sheet and XCUITest invalidates those references while it settles,
    // resulting in repeated "stale element" errors. A page-source snapshot is
    // stable and contains every visible label/name/value needed for validation.
    const paywallMarkers = [
      'Go to dazn.com/start',
      'Pick a plan on dazn.com',
      'How to watch this and more',
      'Buy Now',
      'Buy now',
    ];
    let isLoaded = false;
    for (let i = 0; i < 30; i++) {
      pageSource = await this.driver.getPageSource().catch(() => '');
      const sourceLower = pageSource.toLowerCase();
      if (paywallMarkers.some(marker => sourceLower.includes(marker.toLowerCase()))) {
        isLoaded = true;
        break;
      }
      await this.driver.pause(500);
    }
    if (!isLoaded) {
      console.warn('⚠️ Native paywall markers did not appear within timeout; validating the latest native screen snapshot.');
    }

    // XCUITest emits text in label/name/value attributes. Decode XML entities
    // and collect unique values without touching or scrolling the modal.
    const attrRegex = /(?:label|name|value)="([^"]*)"/g;
    for (const match of pageSource.matchAll(attrRegex)) {
      const text = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
      if (text) textsSet.add(text);
    }

    const texts = Array.from(textsSet);
    console.log(`📋 Native paywall snapshot captured (${texts.length} unique labels).`);

    // Find the paywall event badge, not any date behind the bottom sheet.  The
    // old "first month on screen" approach selected labels such as a home-page
    // carousel's "Jul 30 - Aug 2", producing false date failures.
    let mobileDateText = 'Not found';
    const monthRegex = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
    const foundDate = texts.find(t =>
      monthRegex.test(t) && /\d/.test(t) &&
      !/\b\d{1,2}\s*(?:-|–|to)\s*[a-z]{3,9}\s*\d{1,2}\b/i.test(t),
    );
    if (foundDate) {
      mobileDateText = foundDate;
      console.log(`💡 Detected mobile paywall date element: "${mobileDateText}"`);
    }

    return { texts, pageSource, mobileDateText };
  }

  // ── Surface: gather texts from banner or tile on iOS ─────────────────────
  async gatherTextsFromSurface(
    surface: IOSPPVSurface,
    titleExpected: string,
    usePageSourceSnapshotOnly = false,
    preferScopedTile = false,
  ): Promise<{ texts: string[]; pageSource: string; targetXml: string }> {
    await this.ensureNativeAppContext();
    const textsSet = new Set<string>();
    const preserveTileSnapshotOrder = usePageSourceSnapshotOnly && surface === 'PPV Tile';
    const orderedTileSnapshotTexts: string[] = [];
    const addText = (text: string): void => {
      if (!text) return;
      if (preserveTileSnapshotOrder) orderedTileSnapshotTexts.push(text);
      else textsSet.add(text);
    };
    const collectPageSourceTexts = (source: string): void => {
      const decodeText = (value: string) => value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();

      if (preserveTileSnapshotOrder) {
        for (const match of source.matchAll(/<XCUIElementType[^>]*>/g)) {
          const node = match[0];
          const attribute = (name: string) => node.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || '';
          addText(decodeText(attribute('label') || attribute('name') || attribute('value')));
        }
        return;
      }

      for (const match of source.matchAll(/(?:label|name|value)="([^"]*)"/g)) {
        addText(decodeText(match[1]));
      }
    };
    const bannerSnapshot = surface === 'PPV Banner' ? this.takeCurrentBannerValidationSnapshot() : '';
    let pageSource = bannerSnapshot;
    let targetXml = '';
    let scopedTileComplete = false;

    try {
      if (!pageSource && preferScopedTile && surface === 'PPV Tile') {
        const escapedTitle = titleExpected.replace(/'/g, "\\'");
        const title = await this.driver.$(
          `-ios predicate string:label CONTAINS[c] '${escapedTitle}' OR name CONTAINS[c] '${escapedTitle}'`,
        ).catch(() => null);
        if (title && await title.isDisplayed().catch(() => false)) {
          let card: WdElement | null = await title.$('xpath:./ancestor::XCUIElementTypeCell[1]').catch(() => null);
          if (!card || !await card.isExisting().catch(() => false)) {
            card = await title.$('xpath:./ancestor::XCUIElementTypeOther[1]').catch(() => null);
          }
          if (card && await card.isExisting().catch(() => false)) {
            const nodes = await card.$$('.//*').catch(() => []);
            for (const node of nodes) {
              const label = await node.getAttribute('label').catch(() => '');
              const name = label ? '' : await node.getAttribute('name').catch(() => '');
              const value = label || name ? '' : await node.getAttribute('value').catch(() => '');
              addText((label || name || value || '').trim());
            }
            const tileTexts = orderedTileSnapshotTexts;
            const titlePresent = tileTexts.some(text => text.toLowerCase().includes(titleExpected.toLowerCase()));
            const buyNowPresent = tileTexts.some(text => /^buy now$/i.test(text.trim()));
            const fightCardPresent = tileTexts.some(text => /^fight card$/i.test(text.trim()));
            const imagePresent = (await card.$$('.//XCUIElementTypeImage').catch(() => [])).length > 0;
            scopedTileComplete = titlePresent && buyNowPresent && fightCardPresent && imagePresent;
            if (scopedTileComplete) {
              // Preserve the existing image-presence validation without
              // requesting the complete virtualized list source.
              pageSource = '<XCUIElementTypeImage/>';
              targetXml = pageSource;
              console.log('📋 Used verified native PPV Tile cell for validation.');
            } else if (preserveTileSnapshotOrder) {
              orderedTileSnapshotTexts.length = 0;
            }
          }
        }
      }

      if (!pageSource) pageSource = await this.driver.getPageSource();
      targetXml = pageSource;

      if ((usePageSourceSnapshotOnly || bannerSnapshot) && !scopedTileComplete) {
        collectPageSourceTexts(pageSource);
        console.log(`📋 Used ${bannerSnapshot ? 'verified banner' : 'native page-source'} snapshot for ${surface} validation.`);
      } else if (!scopedTileComplete) {

        // Locate the main title element
        const escTitle = titleExpected.replace(/'/g, "\\'");
        const titleSel = `-ios predicate string:label CONTAINS[c] '${escTitle}' OR name CONTAINS[c] '${escTitle}'`;
        const titleEl = await this.driver.$(titleSel);

        if (surface === 'PPV Tile' && await titleEl.isDisplayed().catch(() => false)) {
          console.log(`🎯 Found title element for "${titleExpected}"`);
          // Find container ancestor cell or group to isolate texts
          let container: WdElement | null = null;
          try {
            // XCUIElementTypeCell is typical for list items / tiles
            container = await titleEl.$('xpath:./ancestor::XCUIElementTypeCell[1]');
            if (!await container.isExisting()) {
              container = await titleEl.$('xpath:./ancestor::XCUIElementTypeOther[1]');
            }
          } catch { }

          if (container && await container.isExisting()) {
            console.log(`🎯 Isolated container cell/group for PPV Tile`);
            const children = await container.$$('.//XCUIElementTypeStaticText | .//XCUIElementTypeButton');
            for (const el of children) {
              const txt = await el.getAttribute('label').catch(() => '');
              addText(txt.trim());
            }
          } else {
            // Fallback: collect all static texts on screen
            const allTexts = await this.driver.$$('//XCUIElementTypeStaticText');
            for (const el of allTexts) {
              const txt = await el.getAttribute('label').catch(() => '');
              addText(txt.trim());
            }
          }
        } else {
          // Banner or full page: collect all texts
          const allTexts = await this.driver.$$('//XCUIElementTypeStaticText | //XCUIElementTypeButton');
          for (const el of allTexts) {
            const txt = await el.getAttribute('label').catch(() => '');
            addText(txt.trim());
          }
        }
      }
    } catch (e: any) {
      console.log(`⚠️ Failed to gather texts from surface: ${e.message}`);
    }

    // Upcoming Fights refreshes its native list while validation begins. The
    // element children above can therefore become stale even though the page
    // source captured at the start is complete. Use that immutable snapshot
    // as a fallback, rather than reporting every field as "Not found".
    const collectedTexts = preserveTileSnapshotOrder ? orderedTileSnapshotTexts : Array.from(textsSet);
    const titleWasCollected = collectedTexts.some(text =>
      text.toLowerCase().includes(titleExpected.toLowerCase()),
    );
    if (surface === 'PPV Tile' && !titleWasCollected && pageSource) {
      collectPageSourceTexts(pageSource);
      console.log('📋 Used page-source snapshot after Upcoming Fights element refresh.');
    }

    const texts = preserveTileSnapshotOrder ? orderedTileSnapshotTexts : Array.from(textsSet);
    console.log(`📱 Gathered local texts for ${surface}:`, texts);
    return { texts, pageSource, targetXml };
  }

  // ── Full paywall validation (sheet-driven) ────────────────────────────────
  async validateMobilePaywall(
    eventData: Record<string, any>,
    source: string,
    results: IOSValidationResult[],
    paywallValidated: { value: boolean },
  ): Promise<void> {
    await this.ensureNativeAppContext();
    if (paywallValidated.value) {
      console.log('⏭️ Mobile Paywall already validated. Skipping duplicate validation.');
      return;
    }

    const mode = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase();
    if (mode === 'real' && source === 'landing-page-banner') {
      console.log('⏭️ Skipping native paywall validation on real iOS device for landing page banner (redirects to Safari directly)');
      paywallValidated.value = true;
      return;
    }

    console.log('\n🔍 [Mobile Paywall] Running validations on native paywall screen...');
    eventData.CURRENT_PAGE = 'Mobile Paywall';
    paywallValidated.value = true;

    const expectedNativeDate = this.getExpectedNativeEventDate(eventData);
    const paywallSnapshot = await this.gatherTextsFromPaywall();
    const { texts, pageSource } = paywallSnapshot;
    // Restrict date selection to the configured event's day and month. Native
    // page source also contains the dimmed screen behind the modal (for
    // example, "22 JUN"), which must never become the PPV date actual.
    const expectedDateTokens = expectedNativeDate.match(/^(\d{1,2})\s+([A-Z]{3})/);
    const excludeOtherEventTime = (text: string) => !/press conference|weigh.?in|prelims?|inside the ring/i.test(text);
    const compactEventBadge = texts.find(t =>
      /^\s*(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+(?:at\s*)?\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\s*$/i.test(t) &&
      excludeOtherEventTime(t),
    );
    let mobileDateText = compactEventBadge || paywallSnapshot.mobileDateText;
    if (compactEventBadge) {
      console.log(`💡 Detected compact mobile paywall date badge: "${compactEventBadge}"`);
    }
    if (expectedDateTokens) {
      const datePattern = new RegExp(`\\b${expectedDateTokens[1]}\\b\\s+${expectedDateTokens[2]}`, 'i');
      const candidates = texts.filter(t => datePattern.test(t));
      // Prefer the candidate whose time matches the expected — background
      // elements behind the modal can show a different timezone rendering.
      const expTimeMatch = expectedNativeDate.match(/(\d{1,2}):(\d{2})/);
      if (candidates.length === 0) {
        const expectedDayMatch = String(
          eventData.MOBILE_BANNER_DATE_TIME ||
          eventData.PPV_DATE ||
          eventData.PPV_PAGE_DATE ||
          eventData.global?.MOBILE_BANNER_DATE_TIME ||
          eventData.global?.PPV_DATE ||
          eventData.global?.PPV_PAGE_DATE ||
          '',
        ).match(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day)?\b/i);
        const expectedHour = expTimeMatch ? parseInt(expTimeMatch[1], 10) : null;
        const expectedTimePattern = expTimeMatch
          ? new RegExp(`\\b0?${expectedHour}:${expTimeMatch[2]}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?\\b`, 'i')
          : null;
        if (expectedTimePattern) {
          const expectedDay = expectedDayMatch?.[1]?.toUpperCase();
          const dayPattern = expectedDay || '(?:sun|mon|tue|wed|thu|fri|sat)';
          const dayTimePattern = new RegExp(`\\b${dayPattern}(?:day)?\\b\\s*(?:at\\s*)?${expectedTimePattern.source}`, 'i');
          const dayTimeText = texts.find(t => dayTimePattern.test(t) && excludeOtherEventTime(t));
          const timeText = texts.find(t => expectedTimePattern.test(t) && excludeOtherEventTime(t));
          mobileDateText = dayTimeText || (timeText && expectedDay ? `${expectedDay} ${timeText}` : timeText) || mobileDateText;
        }
      } else if (expTimeMatch && candidates.length > 1) {
        const expH = parseInt(expTimeMatch[1], 10);
        const expM = expTimeMatch[2];
        const best = candidates.find(t => {
          const m = t.match(/(\d{1,2}):(\d{2})/);
          return m && parseInt(m[1], 10) === expH && m[2] === expM;
        });
        if (best) mobileDateText = best;
        else mobileDateText = candidates[0];
      } else {
        mobileDateText = candidates[0] || paywallSnapshot.mobileDateText;
      }
    }

    const { getMobilePaywallData } = require('../../../utils/excelReader');
    const { resolveExpected: resolveExp } = require('../../../utils/resolveExpected');
    const { compare, getStrictPpvDateMatch } = require('../../../utils/compare');

    try {
      let paywallRows: any[] = [];
      try {
        const { readSheet } = require('../../../utils/excelReader');
        if (source === 'landing-page-banner') {
          paywallRows = readSheet('Landing page').filter((r: any) =>
            r.Flow === 'landing-page-banner' &&
            (r.Field?.includes('Copy') || (r.Field?.includes('Description') && !r.Field?.includes('Banner')))
          );
        } else {
          paywallRows = getMobilePaywallData();
        }
      } catch {
        paywallRows = getMobilePaywallData();
      }
      console.log(`📊 Mobile Paywall sheet rows: ${paywallRows.length}`);

      for (const row of paywallRows) {
        const fieldName = (row['Field'] || '').trim();
        if (!fieldName) continue;

        if (IOSValidationPage.IOS_ONLY_UNSUPPORTED_PAYWALL_FIELDS.has(fieldName.toLowerCase())) {
          console.log(`⏭️ Skipping web-only paywall field on iOS: ${fieldName}`);
          continue;
        }

        if (fieldName === 'Copy Description' && source !== 'landing-page-banner') {
          continue;
        }

        let expectedValue = '';
        try { expectedValue = resolveExp(row, eventData); }
        catch { expectedValue = String(row['Expected'] || ''); }

        if (fieldName.toLowerCase() === 'instruction header') {
          expectedValue = 'How to watch this and more?';
        }

        // The shared spreadsheet carried a historic hard-coded promoter for
        // this source. The event configuration is authoritative per PPV and
        // already supplies the correct promoter for every region.
        if (source.trim().toLowerCase() === 'home-boxing-upcoming' &&
          fieldName.trim().toLowerCase() === 'sponsor' && eventData.PPV_PROMOTER) {
          expectedValue = String(eventData.PPV_PROMOTER);
        }

        const iosExpected = this.getIOSISTExpectedForField(eventData, fieldName, expectedValue);
        if (iosExpected) expectedValue = iosExpected;

        if (!expectedValue || expectedValue.toUpperCase() === 'N/A') {
          continue;
        }

        let actualValue = 'Not found';
        let isMatch = false;
        const isDateField = fieldName.toLowerCase().includes('date') || fieldName.toLowerCase().includes('time');

        if (
          fieldName.toLowerCase().includes('link present') ||
          fieldName.toLowerCase().includes('link displaying') ||
          fieldName.toLowerCase().includes('handoff link') ||
          fieldName.toLowerCase() === 'link' ||
          fieldName.toLowerCase().includes('copy url')
        ) {
          // iOS uses Safari redirects or standard links
          const urlEl = texts.find(t =>
            t.toLowerCase().includes('https://') ||
            t.toLowerCase().includes('http://') ||
            t.toLowerCase().includes('dazn-direct-subscription') ||
            t.toLowerCase().includes('.amazonaws.com')
          );
          if (fieldName.toLowerCase().includes('present')) {
            actualValue = urlEl ? 'Yes' : 'No';
            isMatch = actualValue.toLowerCase() === expectedValue.toLowerCase();
          } else if (urlEl) {
            actualValue = urlEl;
            const cleanActual = urlEl.replace(/\.\.\.+$/, '').toLowerCase().trim();
            const cleanExpected = expectedValue.toLowerCase().trim();
            isMatch = cleanExpected.includes(cleanActual) || cleanActual.includes(cleanExpected);
          }
        } else if (isDateField && mobileDateText !== 'Not found') {
          actualValue = mobileDateText;
          const nativeExpected = expectedNativeDate;
          // Native iOS renders an absolute, region-local event timestamp. Do
          // not validate it against stale per-region spreadsheet strings.
          if (nativeExpected) expectedValue = nativeExpected;
          isMatch = Boolean(getStrictPpvDateMatch(actualValue, expectedValue));
        } else if (fieldName.toLowerCase() === 'event name') {
          const matched = texts.find(text => {
            const cleaned = text.replace(/(?:-List:[^\s]+|,\s*article)$/i, '').trim();
            const normalizedExpected = expectedValue.toLowerCase();
            return compare(cleaned, expectedValue) ||
              cleaned.toLowerCase() === normalizedExpected ||
              cleaned.toLowerCase().includes(normalizedExpected);
          });
          if (matched) {
            actualValue = matched.replace(/(?:-List:[^\s]+|,\s*article)$/i, '').trim();
            isMatch = compare(actualValue, expectedValue);
          }
        } else {
          let matched = texts.find(t => {
            const cleanT = t.toLowerCase().trim();
            const cleanExp = expectedValue.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim().toLowerCase();
            return compare(t, expectedValue) ||
              cleanT.includes(cleanExp) && cleanT.length <= cleanExp.length * 2 + 30 ||
              (cleanT.length > 10 && cleanExp.includes(cleanT));
          });
          if (matched) {
            actualValue = matched;
            isMatch = true;
          } else if (compare(pageSource, expectedValue)) {
            actualValue = expectedValue;
            isMatch = true;
          }
        }

        const status = isMatch ? 'PASS' : 'FAIL';
        console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${fieldName}] expected="${expectedValue}" actual="${actualValue}"`);
        const screenshot = status === 'FAIL'
          ? await this.captureAndMarkFailureScreenshot('Mobile Paywall', fieldName, expectedValue, actualValue)
          : undefined;
        results.push({ page: 'Mobile Paywall', field: fieldName, expected: expectedValue, actual: actualValue, status, screenshot });
      }

      const isUSRegion = String(eventData.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase() === 'US';
      const startLinkPresent = texts.some(t => /go\s+to\s+dazn\.com\/start/i.test(t));
      const buyNowPresent = texts.some(t => /^buy\s+now$/i.test(t));
      results.push({
        page: 'Mobile Paywall',
        field: isUSRegion ? 'Buy Now Button' : 'Go to dazn.com/start Link',
        expected: 'Yes',
        actual: isUSRegion ? (buyNowPresent ? 'Yes' : 'No') : (startLinkPresent ? 'Yes' : 'No'),
        status: (isUSRegion ? buyNowPresent : startLinkPresent) ? 'PASS' : 'FAIL',
        screenshot: (isUSRegion ? buyNowPresent : startLinkPresent) ? undefined : await this.captureAndMarkFailureScreenshot(
          'Mobile Paywall', isUSRegion ? 'Buy_Now_Button' : 'Go_to_dazn_com_start_Link', 'Yes', 'No',
        ),
      });
    } catch (err: any) {
      console.warn('⚠️ Mobile paywall validation sheet error:', err.message);
    }
  }

  // ── Full surface (banner/tile) validation (sheet-driven) ─────────────────
  async validateMobileBannerOrTile(
    surface: IOSPPVSurface,
    eventData: Record<string, any>,
    source: string,
    results: IOSValidationResult[],
  ): Promise<void> {
    await this.ensureNativeAppContext();
    console.log(`\n🔍 [${surface}] Running validations...`);
    eventData.CURRENT_PAGE = 'mobile';

    const titleExpected = surface === 'PPV Tile' && eventData.PPV_SURFACING_NAME
      ? resolvePpvTitleForSurface(eventData, source, surface)
      : eventData.MOBILE_BANNER_TITLE || eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME;
    const normalizedSource = source.trim().toLowerCase();
    const isHomeSportTile = normalizedSource === 'home-boxing-tile' &&
      !['', 'boxing'].includes(String(eventData.SPORT || eventData.global?.SPORT || '').trim().toLowerCase()) &&
      !String(eventData.SPORT || eventData.global?.SPORT || '').toLowerCase().includes('misfits');
    const useScheduleSnapshot = ['schedule', 'home-boxing-upcoming'].includes(normalizedSource) && surface === 'PPV Tile';
    const { texts, pageSource, targetXml } = await this.gatherTextsFromSurface(
      surface,
      titleExpected,
      useScheduleSnapshot,
      normalizedSource === 'home-boxing-upcoming' && surface === 'PPV Tile',
    );
    if (surface === 'PPV Banner') this.lastBannerValidationSource = pageSource;

    const cleanStr = (s: string) =>
      (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ')
        .replace(/\s+/g, ' ').trim().toLowerCase();
    const userState = String(process.env.USER_STATE || eventData.USER_STATE || '').toLowerCase().trim().replace('-', '_');
    const isUltimateUser = userState.startsWith('active_ultimate');
    const isLoginFirst = String(process.env.LOGIN_FIRST || process.env.LOGIN || '').toLowerCase() === 'true';
    const isNativeUltimateEntitlement = isUltimateUser && isLoginFirst;
    const scopedSource = targetXml || pageSource;
    const corpus = `${texts.join(' ')} ${scopedSource}`.toLowerCase();
    const findVisibleText = (expected: string): string => {
      const expectedAlternatives = String(expected || '').split('|').map(cleanStr).filter(Boolean);
      if (!expectedAlternatives.length) return '';
      return texts.find(text => {
        const cleanText = cleanStr(text);
        return expectedAlternatives.some(expectedText =>
          cleanText === expectedText ||
          cleanText.includes(expectedText) ||
          expectedText.includes(cleanText),
        );
      }) || '';
    };
    const findDateText = (expected: string): string => {
      const expectedDateTerms: string[] = String(expected || '').toLowerCase().match(/jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\b\d{1,2}\b/g) || [];
      const calendarDateText = expectedDateTerms.length ? texts.find(text => {
        const cleanText = text.toLowerCase();
        return expectedDateTerms.every(term => cleanText.includes(term.slice(0, 3)) || cleanText.includes(term));
      }) : '';
      if (calendarDateText) return calendarDateText;

      const region = String(eventData.REGION || eventData.region || process.env.DAZN_REGION || 'GB');
      const dynamicExpected = getDynamicDateTimeBadge
        ? getDynamicDateTimeBadge(expected, getNowForRegion ? getNowForRegion(region) : undefined)
        : '';
      const candidates = dynamicExpected.split('|').map(cleanStr).filter(Boolean);
      return texts.find(text => {
        const cleanText = cleanStr(text);
        return candidates.some(candidate => cleanText === candidate || cleanText.includes(candidate) || candidate.includes(cleanText));
      }) || '';
    };
    const getTargetTileTexts = (): string[] => {
      if (surface !== 'PPV Tile' || !['schedule', 'home-boxing-upcoming'].includes(normalizedSource)) {
        return texts;
      }

      const titleCandidates = [
        titleExpected,
        eventData.PPV_CARD_TITLE,
        eventData.PPV_DISPLAY_NAME,
        eventData.PPV_NAME,
        eventData.MOBILE_BANNER_TITLE,
      ].map(cleanStr).filter(Boolean);
      const titleIndex = texts.findIndex(text => {
        const cleanText = cleanStr(text);
        const cleanListText = cleanText.replace(/-list:.+$/i, '').replace(/\s+list\s+.+$/i, '').trim();
        return titleCandidates.some(title => cleanText === title || cleanListText === title);
      });
      if (titleIndex < 0) return texts;

      const isArticleMarker = (text: string) => /,\s*article$/i.test(text.trim()) || /^\d{1,2},\s*article$/i.test(text.trim());
      let start = Math.max(0, titleIndex - 6);
      let end = Math.min(texts.length, titleIndex + (normalizedSource === 'home-boxing-upcoming' ? 20 : 8));
      // Schedule cards expose a stable `Title-List:<id>` label immediately
      // before the card metadata. Prefer that boundary over the preceding
      // article marker, which can belong to the previous card and its time
      // badge (for example, 5:30AM for the sibling card).
      const targetListIndex = texts.findIndex((text, index) => {
        if (index > titleIndex) return false;
        const cleanText = cleanStr(text);
        return titleCandidates.some(title => cleanText.startsWith(`${title}-list:`) || cleanText.startsWith(`${title} list `));
      });
      if (targetListIndex >= 0) {
        start = targetListIndex;
        if (normalizedSource === 'home-boxing-upcoming') {
          // Upcoming Fights puts the target card's date stack before its
          // title-list label, unlike Schedule's title-first card layout.
          for (let i = targetListIndex - 1; i >= 0; i--) {
            if (isArticleMarker(texts[i])) {
              start = i;
              break;
            }
          }
        }
        for (let i = targetListIndex - 1; i >= Math.max(0, targetListIndex - 4); i--) {
          if (isArticleMarker(texts[i])) break;
          if (/^\s*\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\s*$/i.test(texts[i])) {
            start = i;
            break;
          }
        }
      }
      for (let i = titleIndex; i >= 0; i--) {
        if (targetListIndex >= 0 && i <= targetListIndex) break;
        if (isArticleMarker(texts[i])) {
          start = i;
          break;
        }
      }
      if (normalizedSource === 'home-boxing-upcoming') {
        // In Upcoming Fights, a card's date label can itself be exposed as
        // "17, article". Ending at that label drops the target date stack and
        // CTAs. The next title-list marker is the reliable boundary between
        // cards in this source.
        for (let i = titleIndex + 1; i < texts.length; i++) {
          if (/-list:\S+$/i.test(texts[i].trim()) || /\slist\s+\S+$/i.test(texts[i].trim())) {
            end = i;
            break;
          }
        }
      } else {
        for (let i = titleIndex + 1; i < texts.length; i++) {
          if (isArticleMarker(texts[i])) {
            end = i;
            break;
          }
        }
      }
      return texts.slice(start, end);
    };
    const pushSurfaceResult = async (fieldName: string, expected: string, actual: string, isMatch: boolean) => {
      if (results.some(r => r.page === surface && r.field === fieldName)) return;
      const status: 'PASS' | 'FAIL' = isMatch ? 'PASS' : 'FAIL';
      console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${fieldName}] expected="${expected}" actual="${actual}"`);
      const screenshot = status === 'FAIL'
        ? await this.captureAndMarkFailureScreenshot(surface, fieldName, expected, actual)
        : undefined;
      results.push({ page: surface, field: fieldName, expected, actual, status, screenshot });
    };
    const isPresent = texts.some(
      t => cleanStr(t).includes(cleanStr(titleExpected)) || cleanStr(titleExpected).includes(cleanStr(t))
    );

    const sheetName = isHomeSportTile && surface === 'PPV Tile'
      ? 'Home of Sport'
      : getIOSValidationSheet(source, surface);
    const { resolveExpected: resolveExp } = require('../../../utils/resolveExpected');
    const { readSheet } = require('../../../utils/excelReader');
    const { compare, getStrictPpvDateMatch } = require('../../../utils/compare');

    let rows: any[] = [];
    if (sheetName) {
      try {
        rows = readSheet(sheetName);
        // Shared Android sheets contain multiple source flows. Prefer the
        // rows authored for the active source so a Home banner check (for
        // example, Copy Button) cannot run against the Don't Miss tile.
        const expectedFlow = isHomeSportTile ? 'home-sport-tile' : source.trim().toLowerCase();
        const sourceRows = rows.filter((r: any) =>
          String(r.Flow || '').trim().toLowerCase() === expectedFlow,
        );
        if (sourceRows.length) rows = sourceRows;
        if (isHomeSportTile) rows = rows.filter((r: any) => !String(r.Field || '').trim().toLowerCase().startsWith('popup'));
        if (sheetName === 'Schedule page') {
          rows = rows.filter((r: any) => !r.Field?.toString().trim().startsWith('Popup'));
        }
        console.log(`📊 Loaded ${rows.length} rows from sheet: "${sheetName}"`);
      } catch (e: any) {
        // Fallbacks matching Android
        if (sheetName === 'Landing-page-banner') {
          try {
            rows = readSheet('Landing page').filter((r: any) =>
              r.Flow === 'landing-page-banner' &&
              !r.Field?.includes('Copy') &&
              !(r.Field?.includes('Description') && !r.Field?.includes('Banner'))
            );
          } catch { }
        } else if (sheetName === 'Home-page-banner') {
          try {
            rows = readSheet('Home page').filter((r: any) => r.Flow === 'home-page-banner');
          } catch { }
        } else if (sheetName.startsWith('Home-boxing-')) {
          try {
            rows = readSheet('Home of Boxing').filter((r: any) => r.Flow === source);
          } catch { }
        }
      }
    }

    if (isNativeUltimateEntitlement && surface === 'PPV Banner') {
      const hasSetReminder = /\bset reminder\b|\breminder\b/i.test(corpus);
      const hasFightCard = /\bfight card\b/i.test(corpus);
      const hasPurchased = /\bpurchased\b|\bincluded\b/i.test(corpus);
      const hasBuyNow = /\bbuy now\b|\bbuy\b/i.test(corpus);
      const descriptionExpected = String(eventData.PPV_DESCRIPTION || eventData.global?.PPV_DESCRIPTION || '').trim();
      const dateExpected = String(eventData.MOBILE_BANNER_DATE_TIME || eventData.PPV_DATE || eventData.PPV_PAGE_DATE || '').trim();
      const titleActual = findVisibleText(titleExpected);
      const descriptionActual = descriptionExpected ? findVisibleText(descriptionExpected) : '';
      const dateActual = dateExpected ? findDateText(dateExpected) : '';
      await pushSurfaceResult('Ultimate PPV Name', titleExpected, titleActual || 'Not found', Boolean(titleActual));
      if (descriptionExpected) {
        await pushSurfaceResult('Ultimate PPV Description', descriptionExpected, descriptionActual || 'Not found', Boolean(descriptionActual));
      }
      if (dateExpected) {
        await pushSurfaceResult('Ultimate PPV Date', dateExpected, dateActual || 'Not found', Boolean(dateActual));
      }
      await pushSurfaceResult('Fight Card Button', 'Fight Card', hasFightCard ? 'Fight Card' : 'Not found', hasFightCard);
      await pushSurfaceResult('Set Reminder Button', 'Set Reminder', hasSetReminder ? 'Set Reminder' : 'Not found', hasSetReminder);
      await pushSurfaceResult('Purchased Text', 'Purchased', hasPurchased ? 'Purchased' : 'Not found', hasPurchased);
      await pushSurfaceResult('Buy Now Button (Absent)', 'Absent', hasBuyNow ? 'Present' : 'Absent', !hasBuyNow);
    }

    if (isNativeUltimateEntitlement && surface === 'PPV Tile') {
      const hasLock = /lock|content_lock/i.test(scopedSource);
      await pushSurfaceResult('Lock Icon', 'No', hasLock ? 'Yes' : 'No', !hasLock);
    }

    if (rows.length > 0) {
      let dontMissOcrTexts: string[] = [];
      try {
        dontMissOcrTexts = JSON.parse(process.env.IOS_DONT_MISS_OCR_TEXTS || '[]');
      } catch { }
      const dontMissTileFound = process.env.IOS_DONT_MISS_PPV_TILE_FOUND === 'true';
      const isDontMissTile = (source === 'home-page-dont-miss' || source === 'home-boxing-tile') && !isHomeSportTile;
      let homeSportOcrTexts: string[] = [];
      try {
        homeSportOcrTexts = JSON.parse(process.env.IOS_HOME_SPORT_OCR_TEXTS || '[]');
      } catch { }
      const homeSportTileFound = process.env.IOS_HOME_SPORT_TILE_FOUND === 'true';

      for (const row of rows) {
        const fieldName = (row['Field'] || '').trim();
        if (!fieldName) continue;
        const fieldLower = fieldName.toLowerCase();

        if (isNativeUltimateEntitlement && surface === 'PPV Banner' &&
          (fieldLower.includes('buy now') || fieldLower === 'buy now cta')) {
          continue;
        }

        if (isNativeUltimateEntitlement && surface === 'PPV Tile' && fieldLower.includes('lock icon')) {
          continue;
        }

        // Schedule-card artwork exposes neither icon through XCUITest, even
        // when the lock/bell is visibly rendered. Do not assert those two
        // image-only fields for this iOS Schedule flow.
        if (
          normalizedSource === 'schedule' &&
          surface === 'PPV Tile' &&
          ['lock icon present', 'bell icon present', 'three dots icon present'].includes(fieldLower)
        ) {
          continue;
        }

        // Native banner flows hand off through the App Store sheet and do not
        // expose the web Copy control.
        if (surface === 'PPV Banner' &&
          ['landing-page-banner', 'home-page-banner', 'home-boxing-banner'].includes(source.trim().toLowerCase()) &&
          fieldName === 'Copy Button') {
          continue;
        }

        let expectedValue = '';
        try { expectedValue = resolveExp(row, eventData); }
        catch { expectedValue = String(row['Expected'] || ''); }

        const isHomeBoxingUpcomingPpvTile = normalizedSource === 'home-boxing-upcoming' && surface === 'PPV Tile';
        const isHomeSportTileDate = isHomeSportTile && fieldLower === 'ppv date';
        const isDateOnlyHomeTile = surface === 'PPV Tile' &&
          ['home-page-dont-miss', 'home-boxing-tile'].includes(normalizedSource) &&
          fieldLower === 'ppv date';
        if (isHomeSportTileDate) {
          const utcDate = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;
          const iosTimeZone = String(process.env.IOS_EXPECTED_TIMEZONE || 'Asia/Kolkata');
          if (utcDate && !Number.isNaN(new Date(utcDate).getTime())) {
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: iosTimeZone,
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            }).formatToParts(new Date(utcDate));
            const values: Record<string, string> = {};
            for (const part of parts) values[part.type] = part.value;
            expectedValue = `${values.weekday} ${values.hour}:${values.minute} ${values.dayPeriod}`.toUpperCase();
          }
        } else if (isDateOnlyHomeTile && eventData.LANDING_PAGE_PPV_DATE) {
          expectedValue = String(eventData.LANDING_PAGE_PPV_DATE);
        } else if (isHomeBoxingUpcomingPpvTile && fieldLower === 'description') {
          const utcDate = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;
          const iosTimeZone = String(process.env.IOS_EXPECTED_TIMEZONE || 'Asia/Kolkata');
          if (utcDate && !Number.isNaN(new Date(utcDate).getTime())) {
            const parts = new Intl.DateTimeFormat('en-GB', {
              timeZone: iosTimeZone,
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            }).formatToParts(new Date(utcDate));
            const values: Record<string, string> = {};
            for (const part of parts) values[part.type] = part.value;
            const day = Number(values.day);
            const suffix = day >= 11 && day <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] || 'th';
            const month = values.month === 'Sept' || values.month === 'Sep' ? 'Sept' : values.month;
            const meridiem = String(values.dayPeriod || '').toUpperCase();
            expectedValue = `WATCH LIVE ${values.weekday} ${day}${suffix} ${month} at ${Number(values.hour)}:${values.minute}${meridiem}`;
          }
        } else {
          const iosExpected = this.getIOSISTExpectedForField(eventData, fieldName, expectedValue);
          if (iosExpected) expectedValue = iosExpected;
        }
        if (!isHomeBoxingUpcomingPpvTile && normalizedSource === 'schedule' && surface === 'PPV Tile' &&
          ['day', 'month'].includes(fieldLower)) {
          const utcDate = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;
          const iosTimeZone = String(process.env.IOS_EXPECTED_TIMEZONE || 'Asia/Kolkata');
          const iosExpected = getIOSISTScheduleFieldCandidates?.(String(utcDate || ''), fieldLower, iosTimeZone);
          if (iosExpected) expectedValue = iosExpected;
        }
        if (normalizedSource === 'schedule' && surface === 'PPV Tile' && fieldLower === 'date') {
          const scheduleDay = String(eventData.MOBILE_SCHEDULE_DATE || '').match(/\d{1,2}/)?.[0];
          if (scheduleDay) expectedValue = scheduleDay;
        }

        if (surface === 'PPV Banner' && source.trim().toLowerCase() === 'landing-page-banner' && fieldName === 'Buy Now CTA') {
          expectedValue = String(eventData.DAZN_REGION || process.env.DAZN_REGION || '').toUpperCase() === 'US'
            ? 'Buy now'
            : 'Go to dazn.com/start';
        }

        if (!expectedValue || expectedValue.toUpperCase() === 'N/A') {
          continue;
        }

        let actualValue = 'Not found';
        let isMatch = false;

        if (isHomeSportTile && fieldLower === 'coming up section') {
          actualValue = homeSportTileFound ? 'Present' : 'Not found';
          isMatch = homeSportTileFound && expectedValue.toLowerCase() === 'present';
        } else if (isHomeSportTile && fieldLower === 'ppv tile present') {
          actualValue = homeSportTileFound ? 'Yes' : 'No';
          isMatch = homeSportTileFound && expectedValue.toLowerCase() === 'yes';
        } else if (isHomeSportTile && fieldLower === 'ppv name') {
          const nameTerms = cleanStr(expectedValue).split(/\s+vs\.?\s+|[^a-z0-9]+/).filter((term: string) => term.length >= 3);
          const ocrCorpus = cleanStr(homeSportOcrTexts.join(' '));
          const nameMatches = nameTerms.length > 0 && nameTerms.every(term => ocrCorpus.includes(term));
          actualValue = nameMatches ? expectedValue : 'Not found';
          isMatch = nameMatches;
        } else if (isHomeSportTile && fieldLower === 'ppv date') {
          // The workbook contains many time-format alternatives separated by
          // pipes. Use only the first variant's day/month; collecting every
          // numeric token would incorrectly require all alternative times in
          // the OCR text at once.
          const dateTerms = expectedValue.split('|')[0].toLowerCase().match(/jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\b\d{1,2}\b/g) || [];
          const ocrText = homeSportOcrTexts.join(' ');
          const ocrCorpus = ocrText.toLowerCase();
          const visibleDate = ocrText.match(/\b(?:sun|mon|tue|wed|thu|fri|sat)\s+\d{1,2}:\d{2}\s*(?:am|pm)\b/i)?.[0]
            || ocrText.match(/\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}:\d{2}\s*(?:am|pm)?\b/i)?.[0]
            || ocrText.match(/\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i)?.[0];
          isMatch = dateTerms.length > 0 && dateTerms.every((term: string) => ocrCorpus.includes(term.slice(0, 3)) || ocrCorpus.includes(term));
          actualValue = visibleDate || (homeSportOcrTexts.length ? ocrText : 'Not found');
        } else if (isHomeSportTile && fieldLower === 'ppv image present') {
          actualValue = homeSportTileFound ? 'Yes' : 'No';
          isMatch = homeSportTileFound && expectedValue.toLowerCase() === 'yes';
        } else if (source === 'home-page-dont-miss' && fieldName === "Don't Miss Section") {
          const sectionPresent = texts.some(t => cleanStr(t).includes("don't miss") || cleanStr(t).includes('dont miss'));
          actualValue = sectionPresent ? 'Present' : 'Not found';
          isMatch = sectionPresent && expectedValue.toLowerCase() === 'present';
        } else if (source.trim().toLowerCase() === 'home-boxing-banner' && fieldName === 'Best of Boxing Section') {
          const sectionPresent = texts.some(t => cleanStr(t).includes('best of boxing'));
          actualValue = sectionPresent ? 'Present' : 'Not found';
          isMatch = sectionPresent && expectedValue.toLowerCase() === 'present';
        } else if (isDontMissTile && fieldName === 'PPV Tile Present') {
          actualValue = dontMissTileFound ? 'Yes' : 'No';
          isMatch = dontMissTileFound && expectedValue.toLowerCase() === 'yes';
        } else if (isDontMissTile && fieldName === 'PPV Name') {
          const nameTerms = cleanStr(expectedValue)
            .split(/\s+vs\.?\s+|[^a-z0-9]+/)
            .filter((term: string) => term.length >= 3);
          const ocrCorpus = cleanStr(dontMissOcrTexts.join(' '));
          const nameMatches = nameTerms.length > 0 && nameTerms.every(term => ocrCorpus.includes(term));
          const matchingText = dontMissOcrTexts.find(text =>
            nameTerms.every((term: string) => cleanStr(text).includes(term)),
          );
          actualValue = matchingText || (nameMatches
            ? dontMissOcrTexts.join(' ')
            : dontMissOcrTexts.find(text => nameTerms.some(term => cleanStr(text).includes(term))) || 'Not found');
          isMatch = nameMatches;
        } else if (isDontMissTile && fieldName === 'PPV Date') {
          const expectedDateTerms = expectedValue.toLowerCase().match(/jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\b\d{1,2}\b/g) || [];
          // Vision can expose `AUG` and `29` as separate observations. Search
          // the complete visible-card OCR corpus, not just one observation.
          const ocrCorpus = dontMissOcrTexts.join(' ').toLowerCase();
          const matchesDate = expectedDateTerms.length > 0 && expectedDateTerms.every((term: string) =>
            ocrCorpus.includes(term.slice(0, 3)) || ocrCorpus.includes(term),
          );
          const matchingDateText = dontMissOcrTexts.find(text => {
            const cleanText = text.toLowerCase();
            return expectedDateTerms.every((term: string) =>
              cleanText.includes(term.slice(0, 3)) || cleanText.includes(term),
            );
          });
          actualValue = matchingDateText || (matchesDate
            ? dontMissOcrTexts.join(' ')
            : dontMissOcrTexts.find(text => /\b\d{1,2}\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(text)) || 'Not found');
          isMatch = matchesDate;
        } else if (isDontMissTile && fieldName === 'PPV Image Present') {
          actualValue = dontMissTileFound ? 'Yes' : 'No';
          isMatch = dontMissTileFound && expectedValue.toLowerCase() === 'yes';
        } else if (surface === 'PPV Banner' && fieldName.trim().toLowerCase() === 'banner title') {
          const bannerTitle = texts.find(text =>
            cleanStr(text).includes(cleanStr(expectedValue)) ||
            cleanStr(expectedValue).includes(cleanStr(text)) ||
            this.isPpvDiscoveryTitle(text, expectedValue),
          );
          actualValue = bannerTitle || 'Not found';
          isMatch = Boolean(bannerTitle);
        } else if (surface === 'PPV Banner' && fieldName.trim().toLowerCase() === 'banner description') {
          const bannerTitleIndex = texts.findIndex(text =>
            cleanStr(text).includes(cleanStr(titleExpected)) || this.isPpvDiscoveryTitle(text, titleExpected),
          );
            // Look further ahead (up to 8 elements) to account for date/time being separate elements
            const bannerDescription = bannerTitleIndex >= 0 && texts.slice(bannerTitleIndex + 1, bannerTitleIndex + 8).find(text =>
            cleanStr(text).length > 20 &&
              // Filter out CTAs and navigation elements, but allow the description even if it's multiline
              !/\b(?:buy now|fight card|go to dazn|^sunday at\s+\d{1,2}:\d{2}$)\b/i.test(text) &&
              // Description should contain meaningful content, not just time/date
              !/^(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+at\s+\d{1,2}:\d{2}$/i.test(cleanStr(text)) &&
              !/_RX_namespace_|DAZN\.PlayerExperienceView/i.test(text),
          );
          actualValue = bannerDescription || 'Not found';
          isMatch = Boolean(bannerDescription && compare(actualValue, expectedValue));
        } else if (
          normalizedSource === 'home-boxing-upcoming' &&
          surface === 'PPV Tile' &&
          fieldLower === 'description'
        ) {
          const targetCardTexts = getTargetTileTexts();
          const description = targetCardTexts.find(text =>
            /\bwatch live\b/i.test(text) && /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i.test(text),
          );
          actualValue = description || 'Not found';
          const weekdayAndTimeOnly = description && !/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(description)
            ? (() => {
              const weekday = (value: string) => value.match(/\b(?:sun|mon|tue|wed|thu|fri|sat)(?:day)?\b/i)?.[0]?.slice(0, 3).toLowerCase();
              const time = (value: string) => value.match(/\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i)?.[0]
                ?.replace(/\./g, '').replace(/\s+/g, '').toLowerCase();
              return weekday(description) === weekday(expectedValue) && time(description) === time(expectedValue);
            })()
            : false;
          isMatch = Boolean(description && (getStrictPpvDateMatch(description, expectedValue) || weekdayAndTimeOnly));
        } else if (
          normalizedSource === 'home-boxing-upcoming' &&
          surface === 'PPV Tile' &&
          fieldLower === 'tile date'
        ) {
          const targetCardTexts = getTargetTileTexts();
          const expectedDay = String(expectedValue).split('|')[0].match(/\b\d{1,2}\b/)?.[0] || '';
          const monthPattern = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
          const formatDate = (day: string, month: string) =>
            `${Number(day)} ${month.trim().slice(0, 3).replace(/^./, char => char.toUpperCase())}`;
          const nativeLabel = (text: string) => text.replace(/,\s*(?:article|button)$/i, '').trim();
          const dayText = targetCardTexts.find(text => nativeLabel(text) === expectedDay);
          const monthText = targetCardTexts.find(text => monthPattern.test(nativeLabel(text)));
          const watchLiveDate = targetCardTexts.find(text =>
            /\bwatch live\b/i.test(text) &&
            /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep)/i.test(text),
          )?.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
          const dateText = dayText && monthText
            ? formatDate(nativeLabel(dayText), nativeLabel(monthText))
            : watchLiveDate
              ? formatDate(watchLiveDate[1], watchLiveDate[2])
              : '';
          actualValue = dateText || 'Not found';
          isMatch = Boolean(dateText && getStrictPpvDateMatch(dateText, expectedValue));
        } else if (
          normalizedSource === 'schedule' &&
          surface === 'PPV Tile' &&
          fieldLower === 'date'
        ) {
          const expectedDay = String(expectedValue).match(/\d{1,2}/)?.[0] || '';
          const titleCandidates = [
            titleExpected,
            eventData.PPV_CARD_TITLE,
            eventData.PPV_DISPLAY_NAME,
            eventData.PPV_NAME,
          ].map(cleanStr).filter(Boolean);
          const nativeLabel = (text: string) => text.replace(/,\s*(?:article|button)$/i, '').trim();
          const titleIndex = texts.findIndex(text => {
            const title = cleanStr(nativeLabel(text)).replace(/-list:.+$/i, '').trim();
            return titleCandidates.some(candidate => title === candidate);
          });
          const dateText = titleIndex >= 0
            ? texts.slice(Math.max(0, titleIndex - 8), titleIndex).map(nativeLabel).find(text => text === expectedDay) || ''
            : '';
          actualValue = dateText || 'Not found';
          isMatch = dateText === expectedDay;
        } else if (
          normalizedSource === 'schedule' &&
          surface === 'PPV Tile' &&
          ['promoter', 'ppv promoter', 'ppv promoter on tile'].includes(fieldName.trim().toLowerCase())
        ) {
          const nearbyTexts = getTargetTileTexts();
          const titleCandidates = [
            titleExpected,
            eventData.PPV_CARD_TITLE,
            eventData.PPV_DISPLAY_NAME,
            eventData.PPV_NAME,
            eventData.MOBILE_BANNER_TITLE,
          ].map(cleanStr).filter(Boolean);
          const titleIndex = nearbyTexts.findIndex(text => {
            const cleanText = cleanStr(text).replace(/-list:.+$/i, '').trim();
            return titleCandidates.some(title => cleanText === title);
          });
          const candidateTexts = titleIndex >= 0 ? nearbyTexts.slice(titleIndex + 1) : nearbyTexts;
          const promoterText = candidateTexts.find(text => {
            const cleanText = cleanStr(text);
            if (!cleanText || titleCandidates.some(title => cleanText === title || cleanText.includes(title))) return false;
            if (/^(schedule|today|all sports|coming up|watch live|buy now)$/.test(cleanText)) return false;
            if (/article|button|options|cellbutton|lock|bell|remind|notification/.test(cleanText)) return false;
            if (/^\d+$/.test(cleanText) || /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i.test(cleanText)) return false;
            if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(cleanText)) return false;
            return cleanText.length >= 3;
          });
          actualValue = promoterText || 'Not found';
          isMatch = Boolean(promoterText && compare(actualValue, expectedValue));
        } else if (
          fieldName.toLowerCase().includes('present') ||
          fieldName.toLowerCase().includes('section') ||
          fieldName.toLowerCase().includes('icon')
        ) {
          if (fieldName.toLowerCase().includes('image')) {
            let hasImg = 'No';
            if (pageSource.includes('XCUIElementTypeImage') || /type="XCUIElementTypeImage"/i.test(pageSource)) {
              hasImg = 'Yes';
            }
            actualValue = hasImg;
            isMatch = hasImg.toLowerCase() === expectedValue.toLowerCase();
          } else if (fieldName.toLowerCase().includes('icon') || fieldName.toLowerCase().includes('dots')) {
            let hasIcon = 'No';
            if (fieldName.toLowerCase().includes('lock')) {
              if (pageSource.includes('lock') || pageSource.includes('content_lock')) {
                hasIcon = 'Yes';
              }
            } else if (fieldName.toLowerCase().includes('bell') || fieldName.toLowerCase().includes('reminder')) {
              if (pageSource.toLowerCase().includes('remind') || pageSource.toLowerCase().includes('bell')) {
                hasIcon = 'Yes';
              }
            } else if (fieldName.toLowerCase().includes('dots') || fieldName.toLowerCase().includes('more')) {
              if (
                pageSource.toLowerCase().includes('more') ||
                pageSource.toLowerCase().includes('dots') ||
                pageSource.toLowerCase().includes('options') ||
                pageSource.toLowerCase().includes('three_dots') ||
                pageSource.toLowerCase().includes('optionscellbutton') ||
                pageSource.includes('…') ||
                texts.some(t => /more|options|dots|three_dots|…|\.{3}/i.test(t))
              ) {
                hasIcon = 'Yes';
              } else if (normalizedSource === 'schedule' && surface === 'PPV Tile') {
                const titleGuess = texts.find(text =>
                  cleanStr(text).includes(cleanStr(titleExpected)) || cleanStr(titleExpected).includes(cleanStr(text)),
                ) || titleExpected;
                const titleSelector = `-ios predicate string:(type == "XCUIElementTypeStaticText" OR type == "XCUIElementTypeButton" OR type == "XCUIElementTypeOther") AND (name == "${this.iosPredicateValue(titleGuess)}" OR label == "${this.iosPredicateValue(titleGuess)}" OR value == "${this.iosPredicateValue(titleGuess)}")`;
                const titleEl = await this.driver.$(titleSelector).catch(() => null);
                if (titleEl && await titleEl.isDisplayed().catch(() => false)) {
                  const titleLoc = await titleEl.getLocation().catch(() => null);
                  const titleSize = await titleEl.getSize().catch(() => null);
                  if (titleLoc && titleSize) {
                    const titleMidY = titleLoc.y + (titleSize.height / 2);
                    const tileButtons = await this.driver.$$('-ios predicate string:type == "XCUIElementTypeButton"').catch(() => []);
                    const tileOthers = await this.driver.$$('-ios predicate string:type == "XCUIElementTypeOther"').catch(() => []);
                    const nearbyControls = [...tileButtons, ...tileOthers];
                    for (const control of nearbyControls) {
                      if (!(await control.isDisplayed().catch(() => false))) continue;
                      const loc = await control.getLocation().catch(() => null);
                      const size = await control.getSize().catch(() => null);
                      if (!loc || !size || size.width <= 0 || size.height <= 0) continue;
                      const controlMidY = loc.y + (size.height / 2);
                      const sameRow = Math.abs(controlMidY - titleMidY) <= Math.max(24, titleSize.height);
                      const toRight = loc.x > titleLoc.x + (titleSize.width * 0.45);
                      const compact = size.width <= 90 && size.height <= 90;
                      if (sameRow && toRight && compact) {
                        hasIcon = 'Yes';
                        break;
                      }
                    }
                  }
                }
              }
            }
            actualValue = hasIcon;
            isMatch = hasIcon.toLowerCase() === expectedValue.toLowerCase();
          } else {
            actualValue = isPresent ? 'Yes' : 'No';
            if (expectedValue === 'Present' || expectedValue === 'Yes' || expectedValue === 'Visible') {
              isMatch = isPresent;
            } else {
              isMatch = !isPresent;
            }
          }
        } else if (
          fieldName.toLowerCase().includes('buy now') ||
          fieldName.toLowerCase().includes('fight card') ||
          fieldName.toLowerCase().includes('cta')
        ) {
          // Upcoming Fights shows both CTAs on the same card. Validate each
          // one by its own copy; accepting the first CTA caused "Fight card"
          // to be reported as a successful Buy now check.
          const expectedCtas = expectedValue.split('|').map(cleanStr).filter(Boolean);
          let exactCta = getTargetTileTexts().find(text =>
            expectedCtas.some(expectedCta => cleanStr(text).includes(expectedCta)),
          );
          // CTA nodes can be virtualized away from target-card text. Retain
          // the fallback for Buy now, but never let a sibling Fight card CTA
          // satisfy this target-card validation.
          if (
            !exactCta &&
            normalizedSource === 'home-boxing-upcoming' &&
            isPresent &&
            !expectedCtas.includes('fight card')
          ) {
            exactCta = texts.find(text =>
              expectedCtas.some(expectedCta => cleanStr(text).includes(expectedCta)),
            );
          }
          actualValue = exactCta || 'Not found';
          isMatch = Boolean(exactCta);
        } else if (
          source.trim().toLowerCase() === 'home-boxing-upcoming' &&
          fieldName.trim().toLowerCase() === 'ppv time'
        ) {
          // The compact artwork badge is not always exposed by iOS
          // accessibility. Prefer the target card's own WATCH LIVE text, then
          // fall back to a standalone badge inside the same card snapshot.
          const targetCardTexts = getTargetTileTexts();
          const time = targetCardTexts.find(text =>
            /\bwatch live\b/i.test(text) && /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i.test(text),
          )?.match(/\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i)?.[0]?.trim() || targetCardTexts.find(text =>
            /^\s*\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\s*$/i.test(text),
          )?.trim();
          // The target entry's badge can be emitted separately from its title
          // in the virtualized snapshot. Fall back only to a standalone badge
          // with the configured target time.
          const [expectedHour, expectedMinute] = expectedValue.split('|')[0].split(':');
          const expectedTimePattern = new RegExp(`\\b0?${parseInt(expectedHour, 10)}:${expectedMinute}\\b`);
          const fallbackTime = !time && isPresent
            ? texts.find(text => /^\s*\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\s*$/i.test(text) && expectedTimePattern.test(text))
            : '';
          actualValue = time || fallbackTime || 'Not found';
          isMatch = Boolean(actualValue !== 'Not found' && compare(actualValue, expectedValue));
        } else if (
          normalizedSource === 'schedule' &&
          surface === 'PPV Tile' &&
          fieldName.trim().toLowerCase() === 'time'
        ) {
          const timePattern = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/i;
          const nearbyTexts = getTargetTileTexts();
          const normalizeTime = (value: string) => value.toLowerCase()
            .replace(/a\.\s*m\.?/g, 'am')
            .replace(/p\.\s*m\.?/g, 'pm')
            .replace(/\s+/g, '')
            .replace(/\b0(\d:)/, '$1');
          const time = nearbyTexts.find(text => timePattern.test(text))?.match(timePattern)?.[0] || '';
          let artworkTime = '';
          if (!time) {
            const titleSelector = `-ios predicate string:(type == "XCUIElementTypeStaticText" OR type == "XCUIElementTypeButton" OR type == "XCUIElementTypeOther") AND (name == "${this.iosPredicateValue(titleExpected)}" OR label == "${this.iosPredicateValue(titleExpected)}")`;
            const titleElement = await this.driver.$(titleSelector).catch(() => null);
            if (titleElement && await titleElement.isDisplayed().catch(() => false)) {
              const [titleLocation, titleSize] = await Promise.all([
                titleElement.getLocation().catch(() => null),
                titleElement.getSize().catch(() => null),
              ]);
              if (titleLocation && titleSize) {
                const images = await this.driver.$$('//XCUIElementTypeImage').catch(() => []);
                const targetImage = (await Promise.all(images.map(async image => {
                  if (!await image.isDisplayed().catch(() => false)) return null;
                  const [location, size] = await Promise.all([
                    image.getLocation().catch(() => null),
                    image.getSize().catch(() => null),
                  ]);
                  if (!location || !size || size.width <= 0 || size.height <= 0) return null;
                  const alignedWithTitle = Math.abs(
                    location.x + size.width / 2 - (titleLocation.x + titleSize.width / 2),
                  ) <= Math.max(40, size.width * 0.25);
                  const aboveTitle = location.y + size.height <= titleLocation.y + 12;
                  return alignedWithTitle && aboveTitle ? { location, size } : null;
                })))
                  .filter((image): image is { location: { x: number; y: number }; size: { width: number; height: number } } => Boolean(image))
                  .sort((left, right) =>
                    titleLocation.y - (left.location.y + left.size.height) -
                    (titleLocation.y - (right.location.y + right.size.height)),
                  )[0];
                if (targetImage) {
                  const artworkTexts = await getIOSRenderedTextInBounds(this.driver, {
                    x: targetImage.location.x,
                    y: targetImage.location.y,
                    width: targetImage.size.width,
                    height: targetImage.size.height,
                  });
                  artworkTime = artworkTexts.find(text => timePattern.test(text))?.match(timePattern)?.[0] || '';
                }
              }
            }
          }
          actualValue = time || artworkTime || 'Not found';
          isMatch = Boolean(actualValue !== 'Not found' && (
            compare(actualValue, expectedValue) ||
            normalizeTime(actualValue) === normalizeTime(expectedValue) ||
            normalizeTime(actualValue).replace(/am|pm/g, '') === normalizeTime(expectedValue).replace(/am|pm/g, '')
          ));
        } else if (fieldName === 'Banner - Event Date' || fieldName === 'Banner Date' || fieldName === 'Date and Time') {
          const normalizeDateString = (s: string) => {
            let clean = String(s || '').toLowerCase()
              .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
              .replace(/a\.\s*m\./gi, 'am')
              .replace(/p\.\s*m\./gi, 'pm')
              .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
              .replace(/january/g, 'jan')
              .replace(/february/g, 'feb')
              .replace(/march/g, 'mar')
              .replace(/april/g, 'apr')
              .replace(/june/g, 'jun')
              .replace(/july/g, 'jul')
              .replace(/august/g, 'aug')
              .replace(/september/g, 'sep')
              .replace(/october/g, 'oct')
              .replace(/november/g, 'nov')
              .replace(/december/g, 'dec');
            return clean.replace(/\s+/g, ' ').trim();
          };
          const expClean = normalizeDateString(expectedValue);
          console.log(`  🔎 [Banner - Event Date] Looking for: "${expClean}"`);

          const directMatch = texts.find(t => {
            const tc = normalizeDateString(t);
            return tc.length >= 6 && (tc === expClean || tc.includes(expClean) || expClean.includes(tc));
          });
          if (directMatch) {
            actualValue = directMatch;
            isMatch = true;
          } else {
            const expectedDay = expectedValue.match(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day)?\b/i)?.[1]?.toUpperCase();
            const expectedTime = expectedValue.match(/\b(\d{1,2}):(\d{2})\s*(?:a\.?m\.?|p\.?m\.?)?\b/i);
            const expectedHour = expectedTime ? parseInt(expectedTime[1], 10) : null;
            const badgePattern = expectedDay && expectedTime
              ? new RegExp(`\\b${expectedDay}(?:day)?\\b\\s*(?:at\\s*)?0?${expectedHour}:${expectedTime[2]}\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?\\b`, 'i')
              : null;
            const badgeMatch = badgePattern ? texts.find(t => badgePattern.test(t)) : '';
            const visibleDate = texts.find(t =>
              /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b.*\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.)?\b/i.test(t),
            );
            const parseDateTime = (value: string) => {
              const normalized = normalizeDateString(value);
              const date = normalized.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/);
              const time = normalized.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
              if (!date || !time) return null;
              let hour = Number(time[1]);
              if (time[3] === 'pm' && hour < 12) hour += 12;
              if (time[3] === 'am' && hour === 12) hour = 0;
              return { day: Number(date[1]), month: date[2], minutes: hour * 60 + Number(time[2]) };
            };
            const expectedDate = parseDateTime(expectedValue);
            const actualDate = visibleDate ? parseDateTime(visibleDate) : null;
            if (badgeMatch) {
              actualValue = badgeMatch;
              isMatch = true;
            } else if (visibleDate && expectedDate && actualDate &&
              expectedDate.day === actualDate.day && expectedDate.month === actualDate.month &&
              expectedDate.minutes === actualDate.minutes) {
              actualValue = visibleDate;
              isMatch = true;
            } else {
              const region = String(eventData.REGION || eventData.region || process.env.DAZN_REGION || 'GB');
              const parsedExpected = getDynamicDateTimeBadge
                ? getDynamicDateTimeBadge(expectedValue, getNowForRegion ? getNowForRegion(region) : undefined)
                : '';
              const dynamicMatch = parsedExpected && texts.find(t =>
                parsedExpected.split('|').some(candidate =>
                  normalizeDateString(t).includes(normalizeDateString(candidate)),
                ),
              );
              if (dynamicMatch) {
                actualValue = dynamicMatch;
                isMatch = true;
              } else if (visibleDate) {
                actualValue = visibleDate;
              }
            }
          }
        } else {
          const expectedAlternatives = expectedValue.split('|').map(cleanStr);
          // Prefer a full expected value over a partial match. Upcoming Fights
          // exposes many cards at once, so a promotion or adjacent event can
          // contain the same PPV name/date fragment as the target card.
          const exactMatch = texts.find(t => expectedAlternatives.includes(cleanStr(t)));
          const matched = exactMatch || texts.find(t => {
            const cleanT = t.toLowerCase().trim();
            const cleanExp = expectedValue.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim().toLowerCase();
            return compare(t, expectedValue) || cleanT.includes(cleanExp);
          });
          if (matched) {
            actualValue = matched;
            isMatch = true;
          }
        }

        const status = isMatch ? 'PASS' : 'FAIL';
        console.log(`  ${status === 'PASS' ? '✅' : '❌'} [${fieldName}] expected="${expectedValue}" actual="${actualValue}"`);
        const screenshot = status === 'FAIL'
          ? await this.captureAndMarkFailureScreenshot(surface, fieldName, expectedValue, actualValue)
          : undefined;
        results.push({ page: surface, field: fieldName, expected: expectedValue, actual: actualValue, status, screenshot });
      }
    }
  }

  async validateUltimateFixtureOrPreviewNavigation(
    eventData: Record<string, any>,
    results: IOSValidationResult[],
  ): Promise<void> {
    await this.ensureNativeAppContext();
    const titleExpected = eventData.MOBILE_BANNER_TITLE || eventData.PPV_DISPLAY_NAME || eventData.PPV_NAME || this.ppvName;
    const title = String(titleExpected).split(/ vs/i)[0].trim().replace(/\./g, '');
    const source = await this.driver.getPageSource().catch(() => '');
    const titlePresent = source.toLowerCase().includes(title.toLowerCase());
    const destinationPresent = /\brelated\b|\bcompetitors\b|\bevents\b|\bfeatures\b/i.test(source);
    const isMatch = titlePresent && destinationPresent;
    const actualValue = isMatch ? 'Preview or fixture page detected' : 'Preview or fixture page not detected';
    const screenshot = isMatch
      ? undefined
      : await this.captureAndMarkFailureScreenshot('PPV Tile', 'Fixture/Preview Navigation', 'Preview or fixture page', actualValue);
    results.push({
      page: 'PPV Tile',
      field: 'Fixture/Preview Navigation',
      expected: 'Preview or fixture page',
      actual: actualValue,
      status: isMatch ? 'PASS' : 'FAIL',
      screenshot,
    });
    if (!isMatch) {
      throw new Error(`PPV fixture/preview page was not detected for "${titleExpected}".`);
    }
  }
}

export async function validateMobilePaywallPage(
  driver: WdBrowser,
  eventData: Record<string, any>,
  source: string,
  results: IOSValidationResult[],
  paywallValidated: { value: boolean },
): Promise<void> {
  return new IOSValidationPage(driver).validateMobilePaywall(eventData, source, results, paywallValidated);
}

export async function validateMobileBannerOrTilePage(
  driver: WdBrowser,
  surface: IOSPPVSurface,
  eventData: Record<string, any>,
  source: string,
  results: IOSValidationResult[],
): Promise<void> {
  return new IOSValidationPage(driver).validateMobileBannerOrTile(surface, eventData, source, results);
}

export async function validateUltimateFixtureOrPreviewNavigationPage(
  driver: WdBrowser,
  eventData: Record<string, any>,
  results: IOSValidationResult[],
): Promise<void> {
  return new IOSValidationPage(driver).validateUltimateFixtureOrPreviewNavigation(eventData, results);
}
