import { IOSBasePage, IOSFlowHooks, WdBrowser } from './IOSBasePage';
import { IOSHomePage, locateIOSPpvTileByImage } from './IOSHomePage';
import { resolvePpvTitleForSource } from '../../../utils/ppvTitleResolver';
import { createHash } from 'crypto';

export interface IOSPPVDateParts {
  month: string;
  monthShort: string;
  day: string;
}

export function getPPVDateParts(eventConfig?: any): IOSPPVDateParts {
  try {
    const utcDate = eventConfig?.global?.PPV_UTC_DATE || eventConfig?.PPV_UTC_DATE || '';
    if (utcDate) {
      const d = new Date(utcDate);
      return {
        month: d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
        monthShort: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase(),
        day: String(d.getUTCDate()),
      };
    }
  } catch (e: any) {
    console.log(`  Could not read PPV date from config: ${e.message}`);
  }

  return { month: 'July', monthShort: 'JUL', day: '' };
}

export class IOSBoxingPage extends IOSBasePage {
  // Store only the visible target title. Do not retain an ancestor: iOS
  // replaces the Upcoming Fights accessibility hierarchy while it scrolls.
  private upcomingPpvCard: any | null = null;
  private upcomingPpvDateParts: IOSPPVDateParts | null = null;

  /**
   * XCUITest can keep virtualized schedule cells marked as displayed after
   * they have moved outside the scroll view. Only accept elements whose native
   * centre point is still inside the device viewport.
   */
  private async isInViewport(element: any): Promise<boolean> {
    if (typeof element?.getLocation !== 'function') return false;
    const [viewport, location, size] = await Promise.all([
      this.driver.getWindowRect().catch(() => null),
      element.getLocation().catch(() => null),
      typeof element.getSize === 'function'
        ? element.getSize().catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!viewport || !location) return false;
    const centreX = location.x + (size?.width || 0) / 2;
    const centreY = location.y + (size?.height || 0) / 2;
    return centreX >= 0 && centreX < viewport.width && centreY >= 0 && centreY < viewport.height;
  }

  private async isDateBesideTitle(titleLocation: any, dateParts: IOSPPVDateParts): Promise<boolean> {
    const dateSelectors = [
      `-ios predicate string:name == "${dateParts.day}" OR label == "${dateParts.day}" OR value == "${dateParts.day}"`,
      `-ios predicate string:name == "${dateParts.monthShort}" OR label == "${dateParts.monthShort}" OR value == "${dateParts.monthShort}"`,
    ];
    const dateLocations: Array<any | null> = [];
    for (const selector of dateSelectors) {
      const elements = await this.driver.$$(selector).catch(() => []);
      let nearest: any | null = null;
      for (const element of elements) {
        if (!(await element.isDisplayed().catch(() => false))) continue;
        const location = await element.getLocation().catch(() => null);
        if (
          location &&
          location.x < titleLocation.x &&
          await this.isInViewport(element) &&
          (!nearest || Math.abs(location.y - titleLocation.y) < Math.abs(nearest.y - titleLocation.y))
        ) {
          nearest = location;
        }
      }
      dateLocations.push(nearest);
    }

    // The date is rendered in a separate left-hand column from the title.
    // It is intentionally verified by geometry rather than ancestor text:
    // XCUITest refreshes the card hierarchy after the Upcoming tab is tapped.
    return dateLocations.every(location => location && Math.abs(location.y - titleLocation.y) < 260);
  }

  /** Finds the configured PPV title in the current accessibility snapshot. */
  private async sourceHasUpcomingPpvCard(pageSource: string): Promise<boolean> {
    const labels: string[] = [];
    const attrRegex = /(?:label|name|value)="([^"]*)"/g;
    for (const match of pageSource.matchAll(attrRegex)) {
      const text = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
      if (text) labels.push(text);
    }

    const titleTerms = this.ppvTitleTerms(this.ppvDiscoveryTitleQuery(this.ppvName));
    return labels.some(label => {
      const cleanLabel = this.normalisePpvMatchText(label);
      const cleanListLabel = cleanLabel.replace(/\s+list\s+.+$/i, '').trim();
      if (/^slide\s+\d+\s+of\s+\d+/.test(cleanLabel)) return false;
      return titleTerms.every(term => cleanListLabel.includes(term));
    });
  }

  private async findUpcomingPpvCard(
    dateParts: IOSPPVDateParts,
    logMatch = true,
    allowSourceFallback = true,
  ): Promise<any | null> {
    const escapedName = this.iosPredicateValue(this.ppvName);
    const discoveryTitle = this.ppvDiscoveryTitleQuery(this.ppvName);
    const escapedDiscoveryTitle = this.iosPredicateValue(discoveryTitle);
    const titleTermVariants = this.ppvTitleTermVariants(discoveryTitle).slice(0, 2);
    const titleSelectors = [
      `-ios predicate string:label == '${escapedName}' OR name == '${escapedName}' OR label BEGINSWITH[c] '${escapedName}-List:' OR name BEGINSWITH[c] '${escapedName}-List:'`,
      `-ios predicate string:(label CONTAINS[c] '${escapedDiscoveryTitle}' OR name CONTAINS[c] '${escapedDiscoveryTitle}') AND NOT (label BEGINSWITH[c] 'Slide' OR name BEGINSWITH[c] 'Slide')`,
      titleTermVariants.length
        ? `-ios predicate string:NOT (label BEGINSWITH[c] 'Slide' OR name BEGINSWITH[c] 'Slide') AND ${titleTermVariants
          .map(variants => `(${variants
            .map(term => `label CONTAINS[c] '${this.iosPredicateValue(term)}' OR name CONTAINS[c] '${this.iosPredicateValue(term)}'`)
            .join(' OR ')})`)
          .join(' AND ')}`
        : '',
    ];

    const findVerifiedTitle = async (selectors: string[]): Promise<any | null> => {
      for (const titleSelector of selectors.filter(Boolean)) {
        const titleElements = await this.driver.$$(titleSelector).catch(() => []);
        for (const titleElement of titleElements) {
          if (!(await titleElement.isDisplayed().catch(() => false))) continue;
          const titleText = (await titleElement.getAttribute('label').catch(() => '')) ||
            (await titleElement.getAttribute('name').catch(() => ''));
          if (!this.isPpvDiscoveryTitle(titleText, this.ppvName)) continue;
          const titleLocation = await titleElement.getLocation().catch(() => null);
          if (
            titleLocation &&
            await this.isInViewport(titleElement) &&
            await this.isDateBesideTitle(titleLocation, dateParts)
          ) {
            if (logMatch) console.log(`  Matched PPV card by title and date: "${this.ppvName}" (${dateParts.day} ${dateParts.monthShort})`);
            return titleElement;
          }
        }
      }
      return null;
    };

    // The exact title/List selector is sufficient for the configured card in
    // the normal case. Unlike /source, it does not serialize the full
    // virtualized Upcoming Fights hierarchy after every swipe.
    const directMatch = await findVerifiedTitle([titleSelectors[0]]);
    if (directMatch || !allowSourceFallback) return directMatch;

    // Keep the existing broad source-based matching as a single fallback for
    // title variants that are not exposed through the exact List selector.
    const pageSource = await this.driver.getPageSource().catch(() => '');
    if (!await this.sourceHasUpcomingPpvCard(pageSource)) {
      return null;
    }

    await this.driver.pause(100);
    return findVerifiedTitle(titleSelectors);
  }

  /** Fresh exact title query used after a controlled scroll of an already verified card. */
  private async findVisibleUpcomingPpvTitle(): Promise<any | null> {
    const escapedName = this.iosPredicateValue(this.ppvName);
    const discoveryTitle = this.ppvDiscoveryTitleQuery(this.ppvName);
    const titleTermVariants = this.ppvTitleTermVariants(discoveryTitle).slice(0, 2);
    const selectors = [
      `-ios predicate string:label == '${escapedName}' OR name == '${escapedName}' OR label BEGINSWITH[c] '${escapedName}-List:' OR name BEGINSWITH[c] '${escapedName}-List:'`,
      titleTermVariants.length
        ? `-ios predicate string:NOT (label BEGINSWITH[c] 'Slide' OR name BEGINSWITH[c] 'Slide') AND ${titleTermVariants
          .map(variants => `(${variants
            .map(term => `label CONTAINS[c] '${this.iosPredicateValue(term)}' OR name CONTAINS[c] '${this.iosPredicateValue(term)}'`)
            .join(' OR ')})`)
          .join(' AND ')}`
        : '',
    ];
    for (const selector of selectors.filter(Boolean)) {
      const titles = await this.driver.$$(selector).catch(() => []);
      for (const title of titles) {
        if (!(await title.isDisplayed().catch(() => false)) || !(await this.isInViewport(title))) continue;
        const titleText = (await title.getAttribute('label').catch(() => '')) ||
          (await title.getAttribute('name').catch(() => ''));
        if (this.isPpvDiscoveryTitle(titleText, this.ppvName)) return title;
      }
    }
    return null;
  }

  /**
   * Finds the Buy now control that belongs to the already verified PPV title.
   * A card can be partially visible: in that case iOS reports the title but
   * not its off-screen CTA, so callers may first bring this exact card up.
   */
  private async findBuyNowBelowTitle(titleLocation: any, title?: any): Promise<any | null> {
    const buyNowSelector = '-ios predicate string:name == "Buy now" OR label == "Buy now" OR name == "Buy Now" OR label == "Buy Now"';

    // The verified title and its CTA normally share one native list cell. Use
    // that cell first so a long Upcoming Fights list does not require checking
    // every Buy now button on screen. Keep the existing geometry-based search
    // below as the fallback for layouts that do not expose a cell ancestor.
    if (title) {
      const card = await title.$('xpath:./ancestor::XCUIElementTypeCell[1]').catch(() => null);
      if (card && await card.isExisting().catch(() => false)) {
        const cardBuyNow = await card.$(buyNowSelector).catch(() => null);
        if (cardBuyNow && await cardBuyNow.isDisplayed().catch(() => false) && await this.isInViewport(cardBuyNow)) {
          return cardBuyNow;
        }
      }
    }

    const buyButtons = await this.driver.$$(
      buyNowSelector,
    );
    let targetButton: any | null = null;
    let closestBelow = Number.POSITIVE_INFINITY;
    for (const buyButton of buyButtons) {
      if (!(await buyButton.isDisplayed().catch(() => false))) continue;
      if (!(await this.isInViewport(buyButton))) continue;
      const location = await buyButton.getLocation().catch(() => null);
      const verticalDistance = location ? location.y - titleLocation.y : -1;
      if (verticalDistance >= 0 && verticalDistance <= 800 && verticalDistance < closestBelow) {
        targetButton = buyButton;
        closestBelow = verticalDistance;
      }
    }
    return targetButton;
  }

  /** Moves a partially visible verified PPV card just far enough to expose its CTA. */
  private async bringUpcomingPpvCtaIntoView(): Promise<void> {
    const { width, height } = await this.driver.getWindowRect();
    const x = Math.round(width / 2);
    await this.driver.performActions([{
      type: 'pointer', id: 'upcoming-ppv-cta-scroll', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y: Math.round(height * 0.64) },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 180, x, y: Math.round(height * 0.54) },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await this.driver.releaseActions();

    // The card/date was verified before the swipe. Re-querying its exact title
    // is sufficient here and avoids repeatedly walking all date labels while
    // the native list settles.
    await this.driver.waitUntil(async () => {
      const title = await this.findVisibleUpcomingPpvTitle();
      return Boolean(title && await title.isDisplayed().catch(() => false));
    }, {
      timeout: 2000,
      interval: 250,
      timeoutMsg: `Verified PPV title "${this.ppvName}" was not available after bringing its CTA into view`,
    });
  }

  private async ensureUpcomingPpvCtaInView(): Promise<boolean> {
    const dateParts = this.upcomingPpvDateParts;
    if (!dateParts) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const title = await this.findUpcomingPpvCard(dateParts, false);
      const titleLocation = title ? await title.getLocation().catch(() => null) : null;
      if (title && titleLocation && await this.findBuyNowBelowTitle(titleLocation, title)) {
        this.upcomingPpvCard = title;
        return true;
      }
      await this.bringUpcomingPpvCtaIntoView().catch(() => { });
    }
    return false;
  }

  /**
   * Opens the configured sport competition page through Home > All Sports.
   * `home-boxing-*` describes the surfacing point, not necessarily the sport:
   * SPORT in the event JSON is authoritative (Boxing, Kickboxing, Wrestling,
   * and so on), matching the web BoxingHomePage behaviour.
   */
  async navigateToConfiguredSport(eventConfig?: any): Promise<void> {
    const configuredSport = String(
      eventConfig?.SPORT || eventConfig?.global?.SPORT || process.env.SPORT || 'Boxing',
    ).trim() || 'Boxing';
    const escapedSport = configuredSport.replace(/"/g, '\\"');

    console.log(`  Opening All Sports and selecting configured sport "${configuredSport}"...`);
    const homeTab = await this.driver.$('-ios predicate string:(name == "Home" OR label == "Home") AND type == "XCUIElementTypeButton"');
    if (!(await homeTab.isDisplayed().catch(() => false))) {
      await this.tapByText('Home', 3000).catch(() => { });
      await this.driver.pause(2500);
    }

    const allSportsSelectors = [
      '~All Sports',
      '-ios predicate string:name == "All Sports" OR label == "All Sports" OR value == "All Sports"',
      '-ios predicate string:name CONTAINS[c] "All Sports" OR label CONTAINS[c] "All Sports"',
    ];
    let allSports: any = null;
    for (const selector of allSportsSelectors) {
      const candidate = await this.driver.$(selector).catch(() => null);
      if (candidate && await candidate.isDisplayed().catch(() => false)) {
        allSports = candidate;
        break;
      }
    }
    if (!allSports) {
      await this.driver.saveScreenshot('./test-results/ios_all_sports_not_found.png');
      throw new Error('All Sports control not found on Home. See test-results/ios_all_sports_not_found.png');
    }

    const sportSelectors = [
      `~${configuredSport}`,
      `-ios predicate string:name == "${escapedSport}" OR label == "${escapedSport}" OR value == "${escapedSport}"`,
    ];
    const getElementId = (element: any): string => String(
      element?.elementId || element?.ELEMENT || element?.['element-6066-11e4-a52e-4f735466cecf'] || '',
    );
    // Capture the Home rail's Boxing element before opening the modal. The
    // same element remains queryable beneath the picker, so coordinates are
    // not a safe way to distinguish it on devices with different screen sizes.
    const homeBoxingElementIds = new Set<string>();
    for (const selector of sportSelectors) {
      const candidates = await this.driver.$$(selector).catch(() => []);
      for (const candidate of candidates) {
        if (await candidate.isDisplayed().catch(() => false)) {
          const id = getElementId(candidate);
          if (id) homeBoxingElementIds.add(id);
        }
      }
    }

    const findSportInPicker = async (): Promise<any | null> => {
      for (const selector of sportSelectors) {
        const candidates = await this.driver.$$(selector).catch(() => []);
        for (const candidate of candidates) {
          if (!(await candidate.isDisplayed().catch(() => false))) continue;
          const id = getElementId(candidate);
          // A candidate already present before All Sports was opened is the
          // underlying Home chip, never the modal selection.
          if (id && !homeBoxingElementIds.has(id)) return candidate;
        }
      }
      return null;
    };

    // The iOS picker has changed its heading between app versions (for
    // example, it is not always named "Sports"). Confirm it by locating the
    // configured sport in the modal's screen area instead of its title.
    await allSports.click();
    let sport: any | null = null;
    const pickerFingerprint = async (): Promise<string> => this.driver.takeScreenshot()
      .then((screenshot: string) => createHash('sha256').update(screenshot).digest('hex'))
      .catch(() => '');
    const seenPickerStates = new Set<string>();
    const pickerDeadline = Date.now() + Number(process.env.IOS_SPORT_PICKER_SEARCH_TIMEOUT_MS || 30000);
    while (Date.now() < pickerDeadline && !sport) {
      sport = await findSportInPicker();
      if (sport) break;

      const previousState = await pickerFingerprint();
      if (previousState) seenPickerStates.add(previousState);
      const { width, height } = await this.driver.getWindowRect();
      await this.driver.performActions([{
        type: 'pointer', id: 'all-sports-picker-scroll', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(width / 2), y: Math.round(height * 0.75) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerMove', duration: 300, x: Math.round(width / 2), y: Math.round(height * 0.32) },
          { type: 'pointerUp', button: 0 },
        ],
      }]);
      await this.driver.releaseActions();

      let currentState = '';
      const pickerMoved = await this.driver.waitUntil(async () => {
        currentState = await pickerFingerprint();
        return Boolean(currentState) && currentState !== previousState;
      }, {
        timeout: 5000,
        interval: 250,
        timeoutMsg: 'All Sports picker did not move after scrolling.',
      }).then(() => true).catch(() => false);
      if (!pickerMoved || (currentState && seenPickerStates.has(currentState))) {
        console.log(`  All Sports picker reached a previously checked state while looking for "${configuredSport}".`);
        break;
      }
      if (currentState) seenPickerStates.add(currentState);
    }

    if (!sport) {
      await this.driver.saveScreenshot('./test-results/ios_configured_sport_not_found.png');
      throw new Error(`Configured sport "${configuredSport}" was not found in the All Sports picker. See test-results/ios_configured_sport_not_found.png`);
    }

    const isConfiguredSportPageReady = async (): Promise<boolean> => {
      const headers = await this.driver.$$(
        `-ios predicate string:name == "${escapedSport}" OR label == "${escapedSport}" OR value == "${escapedSport}"`,
      ).catch(() => []);
      const viewport = await this.driver.getWindowRect().catch(() => null);
      for (const header of headers) {
        if (!(await header.isDisplayed().catch(() => false))) continue;
        const location = await header.getLocation().catch(() => null);
        if (location && (!viewport || location.y < viewport.height * 0.25)) return true;
      }
      return false;
    };

    await sport.click();
    console.log(`  Waiting for the ${configuredSport} destination page to replace the All Sports picker...`);
    try {
      await this.driver.waitUntil(isConfiguredSportPageReady, {
        timeout: 50000,
        interval: 500,
        timeoutMsg: `${configuredSport} destination page did not replace the All Sports picker.`,
      });
    } catch (error) {
      await this.driver.saveScreenshot('./test-results/ios_sport_destination_not_ready.png');
      throw error;
    }
    // The destination header is exposed before the hero carousel replaces the
    // All Sports accessibility hierarchy. Wait for that hierarchy to settle
    // before banner lookup so XCUITest does not retry stale elements per swipe.
    let previousSource = '';
    let stableReads = 0;
    const destinationSettled = await this.driver.waitUntil(async () => {
      const currentSource = await this.driver.getPageSource().catch(() => '');
      if (!currentSource) return false;
      stableReads = currentSource === previousSource ? stableReads + 1 : 0;
      previousSource = currentSource;
      return stableReads >= 2;
    }, {
      timeout: 10000,
      interval: 300,
      timeoutMsg: `${configuredSport} destination page did not settle after loading.`,
    }).then(() => true).catch(() => false);
    if (!destinationSettled) {
      console.warn(`⚠️ ${configuredSport} destination carousel is still updating; continuing with surface-specific readiness checks.`);
    }
    await this.driver.saveScreenshot('./test-results/ios_sport_competition_page.png');
    console.log(`  Opened ${configuredSport} competition page via All Sports.`);
  }

  // Backwards-compatible API retained for callers that have no event config.
  async clickHomeBoxingFilter(): Promise<void> {
    await this.navigateToConfiguredSport();
  }

  async clickUpcomingFightsFilter(): Promise<void> {
    console.log('  Waiting for the Boxing page to load its "Upcoming Fights" filter...');
    const selectors = [
      '~Upcoming Fights',
      '-ios predicate string:name CONTAINS "Upcoming Fights" OR label CONTAINS "Upcoming Fights"',
      '-ios predicate string:name CONTAINS "Upcoming" OR label CONTAINS "Upcoming"',
    ];

    const findUpcomingFilter = async (): Promise<any | null> => {
      for (const selector of selectors) {
        try {
          const el = await this.driver.$(selector);
          if (await el.isDisplayed()) return el;
        } catch { }
      }
      return null;
    };

    let upcomingFilter: any | null = null;
    const waitForUpcoming = async (timeout: number): Promise<boolean> => this.driver.waitUntil(async () => {
      upcomingFilter = await findUpcomingFilter();
      return Boolean(upcomingFilter);
    }, { timeout, interval: 300 }).then(() => true).catch(() => false);

    // The destination header appears before its content and tab strip. Wait
    // for the required tab instead of swiping an unloaded Boxing page.
    const found = await waitForUpcoming(60000);

    if (!found || !upcomingFilter) {
      await this.driver.saveScreenshot('./test-results/ios_upcoming_filter_not_found.png');
      throw new Error('Upcoming Fights filter did not appear on the configured sport page.');
    }

    const sourceBeforeTabClick = await this.driver.getPageSource().catch(() => '');
    await upcomingFilter.click();
    // The tab tap replaces the virtualized accessibility hierarchy. Wait for
    // the new tree to settle before the scoped title/date lookup creates
    // element references, otherwise every lookup incurs a WDA stale retry.
    let previousSource = '';
    let stableReads = 0;
    await this.driver.waitUntil(async () => {
      const currentSource = await this.driver.getPageSource().catch(() => '');
      if (!currentSource || currentSource === sourceBeforeTabClick) return false;
      stableReads = currentSource === previousSource ? stableReads + 1 : 0;
      previousSource = currentSource;
      return stableReads >= 2;
    }, {
      timeout: 10000,
      interval: 300,
      timeoutMsg: 'Upcoming Fights list did not settle after selecting its filter.',
    });
    console.log('  "Upcoming Fights" filter clicked; continuing with its scoped PPV list.');
  }

  async scrollToUpcomingPPV(dateParts: IOSPPVDateParts, eventConfig?: any): Promise<boolean> {
    console.log(`  Scrolling until the PPV card for "${this.ppvName}" on ${dateParts.day} ${dateParts.monthShort} is visible...`);
    const { width, height } = await this.driver.getWindowRect();
    const cx = Math.round(width / 2);
    this.upcomingPpvDateParts = dateParts;
    this.upcomingPpvCard = null;

    // The scoped list can rebuild immediately after its tab is selected.
    // Check the initial viewport once, then start scrolling; repeated checks
    // only re-query stale virtualized cells and delay the first swipe.
    this.upcomingPpvCard = await this.findUpcomingPpvCard(dateParts, true, false);

    for (let i = 0; i < 24 && !this.upcomingPpvCard; i++) {
      const scrollStartedAt = Date.now();
      // Short, overlapping swipes preserve every schedule card between
      // attempts and avoid jumping over multiple PPVs on the same date.
      await this.driver.performActions([{
        type: 'pointer', id: 'upcoming-ppv-scroll', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: cx, y: Math.round(height * 0.66) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 80 },
          { type: 'pointerMove', duration: 250, x: cx, y: Math.round(height * 0.42) },
          { type: 'pointerUp', button: 0 },
        ]
      }]);
      await this.driver.releaseActions();
      await this.driver.pause(350);
      this.upcomingPpvCard = await this.findUpcomingPpvCard(dateParts, true, false);
      console.log(`  Upcoming Fights scroll ${i + 1}/24 checked in ${Date.now() - scrollStartedAt}ms.`);
    }

    // Run the broad source fallback once only after the efficient exact-title
    // search has traversed the list. This retains support for title variants
    // without imposing a full hierarchy snapshot after every swipe.
    if (!this.upcomingPpvCard) {
      this.upcomingPpvCard = await this.findUpcomingPpvCard(dateParts);
    }

    if (this.upcomingPpvCard) {
      await this.driver.saveScreenshot('./test-results/ios_ppv_tile_area.png');
    } else {
      await this.driver.saveScreenshot('./test-results/ios_ppv_not_found.png');
      console.log(`  PPV card "${this.ppvName}" on ${dateParts.day} ${dateParts.monthShort} was not found after scrolling.`);
    }

    return Boolean(this.upcomingPpvCard);
  }

  async tapBuyNowNearPPV(): Promise<boolean> {
    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log(`✨ [Ultimate Active User with LOGIN_FIRST=true] Clicking the PPV tile itself for "${this.ppvName}"...`);
      const title = this.upcomingPpvDateParts
        ? await this.findUpcomingPpvCard(this.upcomingPpvDateParts, false)
        : null;
      if (!title || !(await title.isDisplayed().catch(() => false))) {
        console.log('  No verified Upcoming Fights PPV card is available; refusing unscoped PPV-tile click.');
        return false;
      }
      if (await title.click().then(() => true).catch(() => false)) {
        console.log(`  Tapped verified PPV tile for "${this.ppvName}".`);
        return true;
      }
      return false;
    }

    // Locate the Buy CTA against a fresh copy of the verified title. The list
    // virtualises cards while validations run, so retaining an ancestor would
    // become stale. The nearest CTA below this exact title is its card CTA.
    try {
      console.log(`  Looking for Buy Now button belonging to "${this.ppvName}"...`);
      const dateParts = this.upcomingPpvDateParts;
      // The Upcoming list virtualizes/rebuilds its cells while validation is
      // running, so the previously stored title reference may be stale. Query
      // a fresh title against the current target-card snapshot.
      let title = dateParts ? await this.findUpcomingPpvCard(dateParts, false) : null;
      let titleLocation = title ? await title.getLocation().catch(() => null) : null;
      if (!dateParts || !title || !titleLocation || !(await title.isDisplayed().catch(() => false))) {
        console.log('  No verified Upcoming Fights PPV card is available; refusing generic Buy CTA fallback.');
        return false;
      }
      let targetButton = await this.findBuyNowBelowTitle(titleLocation, title);
      if (!targetButton) {
        console.log('  Verified PPV title is visible but its Buy now CTA is below the viewport; scrolling that card into view...');
        await this.bringUpcomingPpvCtaIntoView();
        title = await this.findVisibleUpcomingPpvTitle();
        titleLocation = title ? await title.getLocation().catch(() => null) : null;
        targetButton = titleLocation ? await this.findBuyNowBelowTitle(titleLocation, title) : null;
      }
      if (targetButton) {
        const targetLocation = await targetButton.getLocation();
        const targetSize = await targetButton.getSize();
        const clicked = await targetButton.click().then(() => true).catch(() => false);
        if (!clicked) {
          // Keep the fallback inside the exact Buy now button's bounds; it is
          // not a generic screen-coordinate tap.
          await this.driver.execute('mobile: tap', {
            x: Math.round(targetLocation.x + targetSize.width / 2),
            y: Math.round(targetLocation.y + targetSize.height / 2),
          });
        }
        console.log('  Tapped exact "Buy now" button for the verified PPV card on iOS');
        return true;
      }
    } catch (e: any) {
      console.log(`  PPV-specific Buy now check error: ${e.message}`);
    }

    console.log('  Verified PPV card has no visible Buy CTA. Refusing generic Buy CTA fallback.');
    return false;
  }

  async openHomeBoxingBannerPaywall(eventConfig?: any, hooks: IOSFlowHooks = {}): Promise<boolean> {
    console.log('Home -> All Sports -> configured sport page -> PPV banner -> Buy now');
    await this.navigateToConfiguredSport(eventConfig);
    await this.waitForConfiguredPpvContentOnSportPage('Home of Boxing');
    await this.driver.saveScreenshot('./test-results/ios_boxing_page.png');

    const bannerCtas = ['Buy now', 'Buy Now'];
    const found = await this.findBannerOnCurrentPage(this.ppvName, {
      ctaTexts: bannerCtas,
      verticalScrolls: 0,
    });

    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_ppv_banner_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`No PPV banner configured for "${this.ppvName}" on Home of Boxing`);
      throw new Error(`No PPV banner configured for "${this.ppvName}" on Home of Boxing. See test-results/ios_ppv_banner_not_found.png`);
    }

    hooks.recordAvailability?.(true, undefined, 'Home of Boxing');
    await this.driver.saveScreenshot('./test-results/ios_ppv_banner_found.png');
    await this.runSurfaceValidation(hooks, 'PPV Banner');

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('✨ [Ultimate Active User with LOGIN_FIRST=true] PPV banner verified (boxing). Skipping Buy click and returning true.');
      return true;
    }

    const stillOnPPVBanner = await this.findBannerOnCurrentPage(this.ppvName, {
      verticalScrolls: 0,
      ctaTexts: bannerCtas,
      swipeDirection: 'right',
    });
    if (!stillOnPPVBanner) {
      await this.driver.saveScreenshot('./test-results/ios_home_boxing_buy_cta_not_found.png');
      throw new Error(`PPV banner "${this.ppvName}" moved before Buy CTA tap. See test-results/ios_home_boxing_buy_cta_not_found.png`);
    }

    const bannerCtaTapped = await this.tapVerifiedBannerCta(bannerCtas);
    if (!bannerCtaTapped) return false;

    if ((process.env.DAZN_REGION || '').toUpperCase() === 'US') {
      await this.driver.pause(1500);
      if (await this.handleUsNativePaywallSheet(hooks)) return true;
      return true;
    }

    const externalCtas = ['Go to dazn.com/start', 'Go to DAZN.com/start', 'dazn.com/start'];
    console.log('Validating native Home Boxing banner paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_home_boxing_banner_native_paywall.png');
    await this.runPaywallValidation(hooks);

    const externalCtaTapped = await this.tapBuyCtaWithFallback(externalCtas, {
      scrollBeforeFallback: false,
      fallbackCtas: externalCtas,
    });
    if (!externalCtaTapped) {
      await this.driver.saveScreenshot('./test-results/ios_home_boxing_banner_external_cta_not_found.png');
      throw new Error(`Native paywall external-site CTA did not appear for "${this.ppvName}".`);
    }
    console.log('Tapped verified Home Boxing paywall external-site CTA.');
    return true;
  }

  /** Re-query the verified banner CTA when its carousel node is replaced. */
  private async tapVerifiedBannerCta(ctas: string[]): Promise<boolean> {
    return Boolean(await super.tapBannerCtaForVerifiedPpv(ctas, 6000, { swipeDirection: 'right' }));
  }

  private async waitForConfiguredPpvContentOnSportPage(surface: string): Promise<void> {
    const titleTerms = this.ppvTitleTerms(this.ppvName);
    if (!titleTerms.length) return;

    const contentReady = await this.driver.waitUntil(async () => {
      const source = await this.driver.getPageSource().catch(() => '');
      const normalisedSource = this.normalisePpvMatchText(source);
      return titleTerms.every(term => normalisedSource.includes(term));
    }, {
      timeout: 30000,
      interval: 1000,
    }).then(() => true).catch(() => false);

    if (!contentReady) {
      console.log(`  ${surface} content did not expose "${this.ppvName}" before banner lookup; continuing with carousel swipe search.`);
    }
  }

  async openHomeBoxingUpcomingPaywall(eventConfig?: any, hooks: IOSFlowHooks = {}): Promise<boolean> {
    console.log('Home -> All Sports -> configured sport page -> Upcoming Fights -> smart scroll -> Buy now');

    const homeTab = await this.driver.$('-ios predicate string:(name == "Home" OR label == "Home") AND type == "XCUIElementTypeButton"');
    if (!(await homeTab.isDisplayed().catch(() => false))) {
      await this.tapByText('Home', 3000).catch(() => { });
      await this.driver.pause(3000);
    }

    const dateParts = getPPVDateParts(eventConfig);
    console.log(`  PPV date from config/fallback: ${dateParts.month} ${dateParts.day} (${dateParts.monthShort})`);

    await this.navigateToConfiguredSport(eventConfig);
    await this.driver.saveScreenshot('./test-results/ios_boxing_page.png');
    await this.clickUpcomingFightsFilter();
    await this.driver.saveScreenshot('./test-results/ios_upcoming_fights.png');

    const found = await this.scrollToUpcomingPPV(dateParts, eventConfig);
    if (!found) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_home_boxing_upcoming_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(
        `PPV card "${this.ppvName}" on ${dateParts.day} ${dateParts.monthShort} was not found in Home Boxing Upcoming`,
      );
      return false;
    }
    hooks.recordAvailability?.(true, undefined, 'Home of Boxing');

    if (!await this.ensureUpcomingPpvCtaInView()) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_home_boxing_upcoming_buy_not_in_view.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`Buy CTA for PPV "${this.ppvName}" was not visible on the verified Home Boxing Upcoming card`);
      return false;
    }
    const tileValidationStartedAt = Date.now();
    await this.runSurfaceValidation(hooks, 'PPV Tile');
    console.log(`  PPV Tile validation completed in ${Date.now() - tileValidationStartedAt}ms.`);
    // The schedule-card Buy now opens DAZN's native paywall. Validate that
    // screen before pressing its external-site CTA; otherwise the handoff
    // spec reaches Safari with no native-paywall validation recorded.
    const buyNowStartedAt = Date.now();
    const cardBuyTapped = await this.tapBuyNowNearPPV();
    console.log(`  Verified PPV Buy now interaction completed in ${Date.now() - buyNowStartedAt}ms.`);
    if (!cardBuyTapped) {
      await hooks.saveScreenshot?.('./test-results/ios_home_boxing_upcoming_buy_not_found.png');
      await hooks.generateAvailabilityFailureReport?.(`Buy CTA for PPV "${this.ppvName}" not found in Home Boxing Upcoming`);
      return false;
    }

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimateUser && isLoginFirst) {
      await this.validateUltimateFixtureOrPreviewPage(hooks);
      return true;
    }

    await this.driver.pause(1500);
    console.log('Validating native Upcoming Fights paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_home_boxing_upcoming_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    const externalCtaTapped = await this.tapBuyCtaWithFallback([
      'Go to dazn.com/start',
      'Go to DAZN.com/start',
      'dazn.com/start',
      'Continue',
    ], { scrollBeforeFallback: true });
    if (!externalCtaTapped) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_home_boxing_upcoming_external_cta_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Boxing');
      await hooks.generateAvailabilityFailureReport?.(`Go to dazn.com/start CTA for PPV "${this.ppvName}" not found in Home Boxing Upcoming`);
    }
    return externalCtaTapped;
  }

  async openHomeBoxingDontMissTilePaywall(eventConfig?: any, hooks: IOSFlowHooks = {}): Promise<boolean> {
    const configuredSport = String(
      eventConfig?.SPORT || eventConfig?.global?.SPORT || process.env.SPORT || 'Boxing',
    ).trim().toLowerCase();
    // Match the web Home Sport flow: Boxing (and Misfits boxing) exposes the
    // Don't Miss rail, whereas other sport destinations expose the PPV in
    // their Coming up rail.
    if (configuredSport && configuredSport !== 'boxing' && !configuredSport.includes('misfits')) {
      return this.openConfiguredSportComingUpTilePaywall(eventConfig, hooks);
    }

    console.log('Home -> All Sports -> configured sport page -> Don\'t Miss rail -> PPV tile -> Buy now');
    await this.navigateToConfiguredSport(eventConfig);
    await this.waitForConfiguredPpvContentOnSportPage('Home of Boxing');
    return new IOSHomePage(this.driver, this.ppvName).openHomePageDontMissPaywall(hooks, {
      skipEnsureHome: true,
      recordPage: 'Home of Boxing',
    });
  }

  private async openConfiguredSportComingUpTilePaywall(eventConfig?: any, hooks: IOSFlowHooks = {}): Promise<boolean> {
    const configuredSport = String(
      eventConfig?.SPORT || eventConfig?.global?.SPORT || process.env.SPORT || 'Sport',
    ).trim() || 'Sport';
    delete process.env.IOS_HOME_SPORT_TILE_FOUND;
    delete process.env.IOS_HOME_SPORT_OCR_TEXTS;
    console.log(`Home -> All Sports -> ${configuredSport} -> Coming up -> PPV tile -> Buy now`);
    await this.navigateToConfiguredSport(eventConfig);
    await this.waitForConfiguredPpvContentOnSportPage('Home of Sport');

    let comingUpHeading: any | null = null;
    const comingUp = await this.driver.waitUntil(async () => {
      const headings = await this.driver.$$(
        '-ios predicate string:name CONTAINS[c] "Coming up" OR label CONTAINS[c] "Coming up"',
      ).catch(() => []);
      for (const heading of headings) {
        if (await heading.isDisplayed().catch(() => false) && await this.isInViewport(heading)) {
          comingUpHeading = heading;
          return true;
        }
      }
      return false;
    }, {
      timeout: 10000,
      interval: 500,
      timeoutMsg: `Coming up rail did not appear on ${configuredSport}.`,
    }).then(() => true).catch(() => false);

    if (!comingUp) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_sport_coming_up_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Sport');
      await hooks.generateAvailabilityFailureReport?.(`"Coming up" rail not found on ${configuredSport}`);
      throw new Error(`"Coming up" rail not found on ${configuredSport}. See test-results/ios_sport_coming_up_not_found.png`);
    }

    let ppvTile = await this.findVisibleUpcomingPpvTitle();
    if (!ppvTile && comingUpHeading) {
      const [headingLocation, viewport] = await Promise.all([
        comingUpHeading.getLocation().catch(() => null),
        this.driver.getWindowRect().catch(() => null),
      ]);
      if (headingLocation && viewport) {
        const swipeY = Math.max(
          Math.round(viewport.height * 0.25),
          Math.min(Math.round(viewport.height * 0.75), headingLocation.y + Math.round(viewport.height * 0.12)),
        );
        for (let attempt = 0; attempt < 8 && !ppvTile; attempt++) {
          console.log(`  PPV tile is not visible in Coming up; swiping that rail left (${attempt + 1}/8).`);
          await this.driver.performActions([{
            type: 'pointer', id: 'sport-coming-up-ppv-search', parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: Math.round(viewport.width * 0.72), y: swipeY },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 40 },
              { type: 'pointerMove', duration: 180, x: Math.round(viewport.width * 0.34), y: swipeY },
              { type: 'pointerUp', button: 0 },
            ],
          }]);
          await this.driver.releaseActions();
          ppvTile = await this.driver.waitUntil(async () => this.findVisibleUpcomingPpvTitle(), {
            timeout: 1500,
            interval: 250,
            timeoutMsg: `PPV tile "${this.ppvName}" did not appear after a Coming up rail swipe.`,
          }).catch(() => null);
        }
      }
    }
    if (!ppvTile) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_sport_coming_up_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Sport');
      await hooks.generateAvailabilityFailureReport?.(`PPV tile "${this.ppvName}" not found in ${configuredSport} Coming up`);
      return false;
    }

    hooks.recordAvailability?.(true, undefined, 'Home of Sport');
    const [tileLocation, viewport] = await Promise.all([
      ppvTile.getLocation().catch(() => null),
      this.driver.getWindowRect().catch(() => null),
    ]);
    const visualEvidence = tileLocation && viewport
      ? await locateIOSPpvTileByImage(this.driver, this.ppvName, {
        minYPercent: Math.max(0, (tileLocation.y - 260) / viewport.height),
        maxYPercent: Math.min(1, (tileLocation.y + 100) / viewport.height),
      }, true)
      : undefined;
    process.env.IOS_HOME_SPORT_TILE_FOUND = 'true';
    process.env.IOS_HOME_SPORT_OCR_TEXTS = JSON.stringify([
      ...(visualEvidence?.ocrTexts || []),
      this.ppvName,
    ]);
    await this.driver.saveScreenshot('./test-results/ios_sport_coming_up_ppv_found.png');
    await this.runSurfaceValidation(hooks, 'PPV Tile');

    try {
      await ppvTile.click();
    } catch {
      const location = await ppvTile.getLocation();
      const size = await ppvTile.getSize();
      await this.driver.execute('mobile: tap', {
        x: Math.round(location.x + size.width / 2),
        y: Math.round(location.y + size.height / 2),
      });
    }
    console.log(`  Opened PPV tile "${this.ppvName}" from ${configuredSport} Coming up.`);

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';
    if (isUltimateUser && isLoginFirst) {
      await this.validateUltimateFixtureOrPreviewPage(hooks);
      return true;
    }

    await this.driver.pause(2000);
    console.log('Validating native Coming up paywall before external handoff...');
    await this.driver.saveScreenshot('./test-results/ios_sport_coming_up_native_paywall.png');
    await this.runPaywallValidation(hooks);
    if (await this.handleUsNativePaywallSheet(hooks)) return true;

    const externalCtas = ['Go to dazn.com/start', 'Go to DAZN.com/start', 'dazn.com/start'];
    const externalCtaTapped = await this.tapBuyCtaWithFallback(externalCtas, {
      scrollBeforeFallback: true,
      fallbackCtas: externalCtas,
    });
    if (!externalCtaTapped) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/ios_sport_coming_up_external_cta_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Home of Sport');
      await hooks.generateAvailabilityFailureReport?.(`Go to dazn.com/start CTA for PPV "${this.ppvName}" not found in ${configuredSport} Coming up`);
    }
    return externalCtaTapped;
  }
}

export async function clickHomeBoxingFilter(driver: WdBrowser): Promise<void> {
  return new IOSBoxingPage(driver).clickHomeBoxingFilter();
}

export async function openHomeBoxingBannerPaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: IOSFlowHooks = {},
): Promise<boolean> {
  return new IOSBoxingPage(driver, ppvName).openHomeBoxingBannerPaywall(eventConfig, hooks);
}

export async function openHomeBoxingUpcomingPaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: IOSFlowHooks = {},
): Promise<boolean> {
  return new IOSBoxingPage(driver, ppvName).openHomeBoxingUpcomingPaywall(eventConfig, hooks);
}

export async function openHomeBoxingDontMissTilePaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: IOSFlowHooks = {},
): Promise<boolean> {
  return new IOSBoxingPage(driver, resolvePpvTitleForSource(eventConfig || { PPV_NAME: ppvName }, 'home-boxing-tile')).openHomeBoxingDontMissTilePaywall(eventConfig, hooks);
}
