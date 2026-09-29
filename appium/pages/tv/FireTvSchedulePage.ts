import { AndroidBasePage, AndroidFlowHooks, WdBrowser, adbTap, getScreenSize } from '../android/AndroidBasePage';
import { sendTvKeyevent, TV_KEYCODES } from '../../utils/androidTvControls';
import { parsePPVDate } from '../../utils/eventLoader';

type FireTvBounds = { x1: number; y1: number; x2: number; y2: number };
type FireTvTile = FireTvBounds & { label: string };

export class FireTvSchedulePage extends AndroidBasePage {
  private fireTvExitDialogDismissed = false;

  private normalizeScheduleText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private decodeXmlAttribute(value: string): string {
    return value
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  private getXmlAttribute(node: string, attribute: string): string {
    const match = node.match(new RegExp(`${attribute}="([^"]*)"`));
    return match ? this.decodeXmlAttribute(match[1]) : '';
  }

  private getXmlBounds(node: string): FireTvBounds | null {
    const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!match) return null;

    return {
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    };
  }

  private async dismissFireTvExitDialogIfPresent(): Promise<boolean> {
    if (this.fireTvExitDialogDismissed) return false;

    const source = await this.driver.getPageSource().catch(() => '');
    if (!/Would you like to close DAZN\?|Close DAZN|Keep watching/.test(source)) {
      return false;
    }

    console.log('Dismissing Fire TV close-app popup with one Back before selecting Schedule...');
    sendTvKeyevent(TV_KEYCODES.BACK);
    this.fireTvExitDialogDismissed = true;
    await this.driver.pause(1500);
    return true;
  }

  private async isSchedulePageVisible(): Promise<boolean> {
    try {
      const source = await this.driver.getPageSource();
      const hasBlockingOverlay = /Would you like to close DAZN\?|Close DAZN|Keep watching/.test(source);
      const hasScheduleHeading = /text="[^"]*\bSchedule\b[^"]*"/i.test(source);
      const hasDateRail = /text="[^"]*\b(Previous|Today|Tomorrow|Fri|Sat|Sun)\b[^"]*"/i.test(source);
      const hasScheduleTile =
        /text="[^"]*\bLIVE\b[^"]*"/i.test(source) ||
        /Joshua|Spence|EWC|Teamfight|Matchroom|PBC/i.test(source) ||
        this.getVisibleFireTvScheduleTiles(source).length > 0;
      const isBoxingHome = /text="Introducing Ultimate"|text="Upcoming Fights"|text="The Locker Room"/.test(source);

      if (!hasBlockingOverlay && hasScheduleHeading && hasDateRail && hasScheduleTile && !isBoxingHome) {
        console.log('Schedule page assertion passed: Schedule heading + date rail + event tiles visible');
        return true;
      }
    } catch {}

    return false;
  }

  private async isFireTvHomeShellVisible(): Promise<boolean> {
    try {
      const source = await this.driver.getPageSource();
      const hasBlockingOverlay = /Would you like to close DAZN\?|Close DAZN|Keep watching/.test(source);
      const hasHomeNav = /text="[^"]*\b(Home|Schedule|Search|All sports)\b[^"]*"/i.test(source);
      // Nav icons can render before the content pane has actually loaded (blank/black screen).
      // Require real Home content too, so we never act on a still-loading page.
      const hasHomeContent = /Discover more|Keep watching|Live and Coming Up|Best Of|BannerLogo|Live TV/i.test(source);
      return !hasBlockingOverlay && hasHomeNav && hasHomeContent;
    } catch {
      return false;
    }
  }

  private async waitForFireTvHomeReady(timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.dismissFireTvExitDialogIfPresent()) continue;
      if (await this.isFireTvHomeShellVisible()) return true;
      await this.driver.pause(800);
    }

    return false;
  }

  private async waitForSchedulePage(timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let scrolledToTop = false;

    while (Date.now() < deadline) {
      if (await this.dismissFireTvExitDialogIfPresent()) continue;
      if (await this.isSchedulePageVisible()) return true;

      if (!scrolledToTop) {
        scrolledToTop = true;
        console.log('  Schedule page not confirmed yet. Moving Up once to scroll to top before rechecking...');
        sendTvKeyevent(TV_KEYCODES.DPAD_UP);
        await this.driver.pause(1000);
        continue;
      }

      await this.driver.pause(800);
    }

    return false;
  }


  private async getFocusedLabel(): Promise<string> {
    try {
      const focused = await this.driver.$('//*[@focused="true"]');
      if (await focused.isDisplayed({ timeout: 400 }).catch(() => false)) {
        const text = String(await focused.getText().catch(() => '')).trim();
        const desc = String(await focused.getAttribute('contentDescription').catch(() => '')).trim();
        return (text || desc || '').trim();
      }
    } catch {}

    return '';
  }

  private async pressScheduleKeyForFireTv(keyCode: number): Promise<void> {
    sendTvKeyevent(keyCode);
  }

  private async isFireTvStillOnScheduleSurface(ppvName = this.ppvName): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const hasScheduleChrome = /text="Schedule"|content-desc="Schedule"|text="Previous"|text="Boxing"|text="Chess"/.test(source);
    const hasScheduleContent =
      this.normalizeScheduleText(source).includes(this.normalizeScheduleText(ppvName)) ||
      /text="Sat"|text="Sun"|text="Mon"|text="Tue"|text="Wed"|text="Thu"|text="Fri"|text="Aug"|text="Sep"|text="Oct"/.test(source);

    return hasScheduleChrome && hasScheduleContent;
  }

  // A page-wide substring check (e.g. "includes(ppvName)") also matches a
  // decoy event whose name is a superset of the target (e.g. the configured
  // "BKFC 94: Till vs. Romero" is a prefix of the real "BKFC 94: Till vs.
  // Romero - Weigh-In" tile) — require an exact node-text/content-desc match
  // instead so landing on that decoy's paywall isn't mistaken for success.
  private hasExactPpvNameNode(source: string, ppvName: string): boolean {
    const target = this.normalizeScheduleText(ppvName);
    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (label && this.normalizeScheduleText(label) === target) return true;
    }
    return false;
  }

  private async isFireTvPpvPaywallVisible(ppvName = this.ppvName): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const lowerSource = source.toLowerCase();
    const hasPpvName = this.hasExactPpvNameNode(source, ppvName);
    const hasTvPurchaseMessage = lowerSource.includes('my account') && lowerSource.includes('purchase this event');
    const hasPaywallCloseButton = /text="Close"/.test(source);

    return hasPpvName && hasTvPurchaseMessage && hasPaywallCloseButton;
  }

  // Detects a PPV purchase paywall for a DIFFERENT event than requested (e.g.
  // the "- Weigh-In" decoy tile's paywall) so a mis-tap fails loudly instead
  // of being reported as a successful navigation with mismatched fields.
  private async isFireTvWrongPpvPaywallVisible(ppvName = this.ppvName): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const lowerSource = source.toLowerCase();
    const hasTvPurchaseMessage = lowerSource.includes('my account') && lowerSource.includes('purchase this event');
    if (!hasTvPurchaseMessage) return false;

    return !this.hasExactPpvNameNode(source, ppvName);
  }

  private isFireTvLocationUnavailableDialogVisible(source: string): boolean {
    const lowerSource = source.toLowerCase();
    return lowerSource.includes('current location') || lowerSource.includes('not available to you');
  }

  private async dismissFireTvLocationUnavailableDialogIfPresent(): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    if (!this.isFireTvLocationUnavailableDialogVisible(source)) return false;

    console.warn('⚠️ "Content not available in your location" dialog appeared. Dismissing via Ok and retrying...');
    await this.driver.saveScreenshot('./test-results/firetv_schedule_location_unavailable.png').catch(() => {});

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (this.normalizeScheduleText(label) !== 'ok') continue;
      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;
      adbTap(Math.round((bounds.x1 + bounds.x2) / 2), Math.round((bounds.y1 + bounds.y2) / 2));
      await this.driver.pause(1200);
      return true;
    }

    sendTvKeyevent(TV_KEYCODES.BACK);
    await this.driver.pause(1200);
    return true;
  }

  private getVisibleFireTvScheduleTiles(source: string): FireTvTile[] {
    const screen = getScreenSize();
    const tiles: FireTvTile[] = [];

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (!label || !label.includes(' vs. ')) continue;

      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;

      const isVisibleTile =
        bounds.x1 >= Math.round(screen.width * 0.08) &&
        bounds.y1 >= Math.round(screen.height * 0.22) &&
        bounds.x2 > bounds.x1 &&
        bounds.y2 > bounds.y1 &&
        (bounds.x2 - bounds.x1) >= Math.round(screen.width * 0.12) &&
        (bounds.y2 - bounds.y1) >= Math.round(screen.height * 0.12);

      if (isVisibleTile) {
        tiles.push({ label, ...bounds });
      }
    }

    return tiles.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  }

  private getFocusedFireTvScheduleTile(source: string, tiles: FireTvTile[]): FireTvTile | undefined {
    const screen = getScreenSize();

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      if (!/focused="true"/.test(node)) continue;

      const focusedBounds = this.getXmlBounds(node);
      if (!focusedBounds) continue;
      if ((focusedBounds.x2 - focusedBounds.x1) > Math.round(screen.width * 0.75)) continue;
      if ((focusedBounds.y2 - focusedBounds.y1) > Math.round(screen.height * 0.75)) continue;

      const focusedCenterX = Math.round((focusedBounds.x1 + focusedBounds.x2) / 2);
      const focusedCenterY = Math.round((focusedBounds.y1 + focusedBounds.y2) / 2);
      const focusedTile = tiles.find(tile =>
        focusedCenterX >= tile.x1 &&
        focusedCenterX <= tile.x2 &&
        focusedCenterY >= tile.y1 &&
        focusedCenterY <= tile.y2
      );

      if (focusedTile) return focusedTile;
    }

    return undefined;
  }

  private getGridIndex(value: number, centers: number[]): number {
    return centers.findIndex(center => Math.abs(center - value) <= 120);
  }

  private async moveFireTvFocusToScheduleTile(fromTile: FireTvTile, targetTile: FireTvTile, tiles: FireTvTile[]): Promise<void> {
    const uniqueCenters = (values: number[]) => values
      .sort((a, b) => a - b)
      .reduce<number[]>((centers, value) => {
        if (!centers.some(center => Math.abs(center - value) <= 120)) centers.push(value);
        return centers;
      }, []);
    const centerX = (tile: FireTvBounds) => Math.round((tile.x1 + tile.x2) / 2);
    const centerY = (tile: FireTvBounds) => Math.round((tile.y1 + tile.y2) / 2);
    const columns = uniqueCenters(tiles.map(centerX));
    const rows = uniqueCenters(tiles.map(centerY));
    const fromColumn = this.getGridIndex(centerX(fromTile), columns);
    const targetColumn = this.getGridIndex(centerX(targetTile), columns);
    const fromRow = this.getGridIndex(centerY(fromTile), rows);
    const targetRow = this.getGridIndex(centerY(targetTile), rows);

    if (fromColumn < 0 || targetColumn < 0 || fromRow < 0 || targetRow < 0) {
      throw new Error(`Fire TV Schedule debug: could not map visible tile grid from "${fromTile.label}" to "${targetTile.label}".`);
    }

    console.log(`  Fire TV moving focus from "${fromTile.label}" to "${targetTile.label}" by remote keys.`);

    for (let step = 0; step < Math.abs(targetRow - fromRow); step++) {
      await this.pressScheduleKeyForFireTv(targetRow > fromRow ? TV_KEYCODES.DPAD_DOWN : TV_KEYCODES.DPAD_UP);
      await this.driver.pause(700);
    }

    for (let step = 0; step < Math.abs(targetColumn - fromColumn); step++) {
      await this.pressScheduleKeyForFireTv(targetColumn > fromColumn ? TV_KEYCODES.DPAD_RIGHT : TV_KEYCODES.DPAD_LEFT);
      await this.driver.pause(700);
    }
  }

  private async tapExactVisiblePpvTileForFireTv(ppvName = this.ppvName): Promise<void> {
    console.log(`Fire TV Schedule debug: clicking exact visible PPV tile: ${ppvName}`);
    await this.driver.saveScreenshot('./test-results/firetv_schedule_before_exact_tile_click.png').catch(() => {});

    const source = await this.driver.getPageSource().catch(() => '');
    const target = this.normalizeScheduleText(ppvName);
    const tiles = this.getVisibleFireTvScheduleTiles(source);

    const tile = tiles
      .filter(candidate => this.normalizeScheduleText(candidate.label) === target)
      .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)[0];

    if (!tile) {
      await this.driver.saveScreenshot('./test-results/firetv_schedule_exact_tile_not_visible.png').catch(() => {});
      throw new Error(`Fire TV Schedule debug: exact PPV tile not visible on the checked date: ${ppvName}`);
    }

    console.log(`Fire TV Schedule debug: exact tile found: "${tile.label}" at [${tile.x1},${tile.y1}][${tile.x2},${tile.y2}]`);
    const tapX = Math.round((tile.x1 + tile.x2) / 2);
    const tapY = Math.round((tile.y1 + tile.y2) / 2);

    // Tap the exact tile center directly to avoid the off-by-one focus drift that occurs when the
    // schedule is already one row below the target PPV and a center press lands on the adjacent tile
    // (mirrors the same proven approach used on Android TV in AndroidSchedulePage.ts).
    adbTap(tapX, tapY);
    await this.driver.pause(1200);

    const sourceAfterTap = await this.driver.getPageSource().catch(() => '');
    if (this.isFireTvLocationUnavailableDialogVisible(sourceAfterTap)) {
      await this.driver.saveScreenshot('./test-results/firetv_schedule_location_unavailable_before_center.png').catch(() => {});
      throw new Error(`Fire TV Schedule debug: location unavailable dialog appeared before opening target PPV tile: ${ppvName}`);
    }

    const deadline = Date.now() + 8000;
    let leftScheduleAt = 0;
    while (Date.now() < deadline) {
      await this.driver.pause(500);

      const currentSource = await this.driver.getPageSource().catch(() => '');
      if (this.isFireTvLocationUnavailableDialogVisible(currentSource)) {
        await this.driver.saveScreenshot('./test-results/firetv_schedule_location_unavailable_after_center.png').catch(() => {});
        throw new Error(`Fire TV Schedule debug: opening "${ppvName}" showed the location unavailable dialog.`);
      }

      if (await this.isFireTvPpvPaywallVisible(ppvName)) {
        console.log(`Fire TV Schedule debug: exact PPV tile opened paywall: ${ppvName}`);
        return;
      }

      if (await this.isFireTvWrongPpvPaywallVisible(ppvName)) {
        await this.driver.saveScreenshot('./test-results/firetv_schedule_wrong_ppv_paywall.png').catch(() => {});
        throw new Error(`Fire TV Schedule debug: tapped tile opened a different event's paywall instead of: ${ppvName}`);
      }

      if (!await this.isFireTvStillOnScheduleSurface(ppvName)) {
        // Schedule chrome disappears before the destination paywall's own
        // identifying text renders, so don't trust this alone yet — give the
        // exact/wrong paywall checks above a couple more polls a chance to see
        // the settled screen before falling back to this looser signal.
        leftScheduleAt = leftScheduleAt || Date.now();
        if (Date.now() - leftScheduleAt >= 1500) {
          console.log(`Fire TV Schedule debug: exact PPV tile opened: ${ppvName}`);
          return;
        }
      } else {
        leftScheduleAt = 0;
      }
    }

    // Retry with a second direct tap on the SAME coordinates rather than
    // D-pad-relative focus movement: relative grid math (row/column stepping)
    // has repeatedly overshot onto an adjacent decoy tile (e.g. "- Weigh-In"),
    // whereas re-tapping the already-located exact tile bounds cannot drift.
    await this.driver.saveScreenshot('./test-results/firetv_schedule_before_target_retap.png').catch(() => {});
    console.log('  Exact PPV tile tap missed; retrying with a second direct tap on the same tile coordinates.');
    adbTap(tapX, tapY);

    const retryDeadline = Date.now() + 5000;
    let leftScheduleAtRetry = 0;
    while (Date.now() < retryDeadline) {
      await this.driver.pause(500);
      const retrySource = await this.driver.getPageSource().catch(() => '');
      if (this.isFireTvLocationUnavailableDialogVisible(retrySource)) {
        await this.driver.saveScreenshot('./test-results/firetv_schedule_location_unavailable_after_retry.png').catch(() => {});
        throw new Error(`Fire TV Schedule debug: retrying center press for "${ppvName}" showed the location unavailable dialog.`);
      }

      if (await this.isFireTvWrongPpvPaywallVisible(ppvName)) {
        await this.driver.saveScreenshot('./test-results/firetv_schedule_wrong_ppv_paywall_retry.png').catch(() => {});
        throw new Error(`Fire TV Schedule debug: retry center press opened a different event's paywall instead of: ${ppvName}`);
      }

      if (await this.isFireTvPpvPaywallVisible(ppvName)) {
        console.log(`Fire TV Schedule debug: exact PPV tile opened paywall on retry: ${ppvName}`);
        return;
      }

      if (!await this.isFireTvStillOnScheduleSurface(ppvName)) {
        // Same race as the initial tap: wait for the destination screen to
        // settle so a decoy's mismatched paywall content has a chance to be
        // detected above instead of being masked by this looser signal.
        leftScheduleAtRetry = leftScheduleAtRetry || Date.now();
        if (Date.now() - leftScheduleAtRetry >= 1500) {
          console.log(`Fire TV Schedule debug: exact PPV tile opened on retry: ${ppvName}`);
          return;
        }
      } else {
        leftScheduleAtRetry = 0;
      }
    }

    await this.driver.saveScreenshot('./test-results/firetv_schedule_exact_tile_click_no_navigation.png').catch(() => {});
    throw new Error(`Fire TV Schedule debug: tapped exact PPV tile but Schedule page is still visible: ${ppvName}`);
  }

  private async isBoxingHighlightedForFireTv(sport: string = 'Boxing'): Promise<boolean> {
    const escapedSport = sport.replace(/"/g, '\\"');
    const selectors = [
      `android=new UiSelector().text("${escapedSport}").selected(true)`,
      `android=new UiSelector().textContains("${escapedSport}").selected(true)`,
      `android=new UiSelector().text("${escapedSport}").focused(true)`,
      `android=new UiSelector().textContains("${escapedSport}").focused(true)`,
    ];

    for (const selector of selectors) {
      const visible = await this.driver
        .$(selector)
        .isDisplayed({ timeout: 500 })
        .catch(() => false);
      if (visible) return true;
    }

    try {
      const sportEl = await this.driver.$(`android=new UiSelector().textContains("${escapedSport}")`);
      if (!await sportEl.isDisplayed({ timeout: 500 }).catch(() => false)) return false;
      const selected = String(await sportEl.getAttribute('selected').catch(() => '')).toLowerCase();
      const focused = String(await sportEl.getAttribute('focused').catch(() => '')).toLowerCase();
      return selected === 'true' || focused === 'true';
    } catch {
      return false;
    }
  }

  private async getVisibleBoxingFilterBoundsForFireTv(sport: string = 'Boxing'): Promise<FireTvBounds | null> {
    const source = await this.driver.getPageSource().catch(() => '');
    const screen = getScreenSize();
    const targetSport = this.normalizeScheduleText(sport);

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (!this.normalizeScheduleText(label).includes(targetSport)) continue;

      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;

      const isFilterRow =
        bounds.y1 >= Math.round(screen.height * 0.10) &&
        bounds.y2 <= Math.round(screen.height * 0.36);

      if (isFilterRow) return bounds;
    }

    return null;
  }

  private async isFocusedFilterOnBoxingForFireTv(sport: string = 'Boxing'): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const screen = getScreenSize();
    const boxingBounds = await this.getVisibleBoxingFilterBoundsForFireTv(sport);
    if (!boxingBounds) return false;

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      if (!/focused="true"/.test(node)) continue;

      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;

      const isFilterRow =
        bounds.y1 >= Math.round(screen.height * 0.10) &&
        bounds.y2 <= Math.round(screen.height * 0.36);

      if (!isFilterRow) continue;

      const focusX = Math.round((bounds.x1 + bounds.x2) / 2);
      const focusY = Math.round((bounds.y1 + bounds.y2) / 2);
      if (
        focusX >= boxingBounds.x1 &&
        focusX <= boxingBounds.x2 &&
        focusY >= boxingBounds.y1 &&
        focusY <= boxingBounds.y2
      ) {
        return true;
      }
    }

    return false;
  }

  private async isBoxingVisibleInFirstThirdOfFilterRow(sport: string = 'Boxing'): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const screen = getScreenSize();
    const filterRowTop = Math.round(screen.height * 0.06);
    const filterRowBottom = Math.round(screen.height * 0.36);
    const firstThirdX = Math.round(screen.width * 0.33);
    const targetSport = this.normalizeScheduleText(sport);

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (!label || !this.normalizeScheduleText(label).includes(targetSport)) continue;
      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;
      if (bounds.y2 <= filterRowTop || bounds.y1 >= filterRowBottom) continue;
      if (bounds.x2 <= firstThirdX) {
        return true;
      }
    }

    return false;
  }

  private async tryTapBoxingFilterOnFireTv(sport: string = 'Boxing'): Promise<boolean> {
    const source = await this.driver.getPageSource().catch(() => '');
    const screen = getScreenSize();
    const filterRowTop = Math.round(screen.height * 0.06);
    const filterRowBottom = Math.round(screen.height * 0.36);
    const targetSport = this.normalizeScheduleText(sport);
    const boxingCandidates: FireTvTile[] = [];

    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (!label || !this.normalizeScheduleText(label).includes(targetSport)) continue;

      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;
      if (bounds.y2 <= filterRowTop || bounds.y1 >= filterRowBottom) continue;
      // Skip degenerate/off-screen candidates (e.g. a chip not yet scrolled
      // into view can report a zero-width bounds pinned to the screen edge).
      if (bounds.x2 - bounds.x1 < 4) continue;

      boxingCandidates.push({ label, ...bounds });
    }

    for (const candidate of boxingCandidates.sort((a, b) => a.x1 - b.x1)) {
      const centerX = Math.round((candidate.x1 + candidate.x2) / 2);
      const centerY = Math.round((candidate.y1 + candidate.y2) / 2);
      console.log(`  ${sport} filter fallback tap: "${candidate.label}" at [${candidate.x1},${candidate.y1}][${candidate.x2},${candidate.y2}]`);
      adbTap(centerX, centerY);
      await this.driver.pause(1200);
      if (await this.isBoxingHighlightedForFireTv(sport) || await this.isFocusedFilterOnBoxingForFireTv(sport)) {
        return true;
      }
    }

    return false;
  }

  private getConfiguredPpvDate(eventConfig?: any): string | undefined {
    const region = String(process.env.DAZN_REGION || '').toUpperCase().trim();
    return eventConfig?.regions?.[region]?.PPV_DATE || eventConfig?.global?.PPV_DATE;
  }

  // Shared by the static (config PPV_DATE) and dynamic (PPV_UTC_DATE-derived)
  // date checks below: is a day-number + month-name pair visible together,
  // either as one combined label or as two nearby nodes in the same column.
  private isDateVisibleInSource(source: string, targetDay: string, targetMonth: string): boolean {
    const targetMonthShort = targetMonth.slice(0, 3);
    const stripOrdinals = (value: string) => value.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
    const monthDayPattern = new RegExp(`\\b${targetMonthShort}[a-z]*\\s+${targetDay}\\b`, 'i');
    const dayMonthPattern = new RegExp(`\\b${targetDay}\\s+${targetMonthShort}[a-z]*\\b`, 'i');
    const screen = getScreenSize();

    const dateNodes: Array<FireTvBounds & { text: string }> = [];
    for (const match of source.matchAll(/<[^>]+>/g)) {
      const node = match[0];
      if (!/displayed="true"/.test(node)) continue;

      const text = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
      if (!text) continue;

      const bounds = this.getXmlBounds(node);
      if (!bounds) continue;
      if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue;
      if (bounds.y2 < Math.round(screen.height * 0.16) || bounds.y1 > Math.round(screen.height * 0.95)) continue;

      dateNodes.push({ text: stripOrdinals(this.normalizeScheduleText(text)), ...bounds });
    }

    if (dateNodes.some(node => monthDayPattern.test(node.text) || dayMonthPattern.test(node.text))) {
      return true;
    }

    const dayNodes = dateNodes.filter(node => node.text === targetDay);
    const monthNodes = dateNodes.filter(node => node.text === targetMonthShort || node.text === targetMonth);

    return dayNodes.some(dayNode => monthNodes.some(monthNode => {
      const sameDateColumn = Math.abs(((dayNode.x1 + dayNode.x2) / 2) - ((monthNode.x1 + monthNode.x2) / 2)) <= 80;
      const closeDateStack = Math.abs(((dayNode.y1 + dayNode.y2) / 2) - ((monthNode.y1 + monthNode.y2) / 2)) <= 120;
      return sameDateColumn && closeDateStack;
    }));
  }

  private isConfiguredPpvDateVisibleInSource(source: string, ppvDate: string): boolean {
    const parsedDate = parsePPVDate(ppvDate);
    return this.isDateVisibleInSource(source, String(parsedDate.day), parsedDate.month.toLowerCase());
  }

  // Checks whether a schedule-strip label matching the target day/diffDays is
  // visible (e.g. a "TODAY"/"TOMORROW" tab, a weekday abbreviation for the next
  // 2-7 days, or the plain day-number + month for anything further out) — the
  // same relative-date convention already used by DAZN Web/mobile banners.
  private isDynamicPpvDateVisibleInSource(source: string, diffDays: number, eventDate: Date): boolean {
    const screen = getScreenSize();
    const isLabelVisible = (label: RegExp): boolean => {
      for (const match of source.matchAll(/<[^>]+>/g)) {
        const node = match[0];
        if (!/displayed="true"/.test(node)) continue;
        const text = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
        if (!text) continue;
        const bounds = this.getXmlBounds(node);
        if (!bounds) continue;
        if (bounds.y2 < Math.round(screen.height * 0.16) || bounds.y1 > Math.round(screen.height * 0.95)) continue;
        if (label.test(text)) return true;
      }
      return false;
    };

    if (diffDays === 0 && isLabelVisible(/\btoday\b/i)) return true;
    if (diffDays === 1 && isLabelVisible(/\btomorrow\b/i)) return true;

    if (diffDays >= 2 && diffDays <= 7) {
      const fullDayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const weekdayFull = fullDayNames[eventDate.getDay()];
      const weekdayShort = weekdayFull.slice(0, 3);
      if (isLabelVisible(new RegExp(`\\b(?:${weekdayShort}|${weekdayFull})\\b`, 'i'))) return true;
    }

    // Absolute day-number + month fallback (used for >7 days, and as a safety
    // net when the surface renders the numeric date instead of a relative label).
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    return this.isDateVisibleInSource(source, String(eventDate.getDate()), monthNames[eventDate.getMonth()]);
  }

  // Prefers PPV_UTC_DATE-derived dynamic matching (Today/Tomorrow/weekday/date,
  // same convention as Web/mobile); falls back to the static config PPV_DATE
  // string when PPV_UTC_DATE is missing/invalid so existing configs keep working.
  private buildPpvDateVisibilityCheck(eventConfig?: any): { label: string; isVisible: (source: string) => boolean } | null {
    const { resolvePpvEventDateInfo } = require('../../../utils/dateUtils');
    const dateInfo = resolvePpvEventDateInfo(eventConfig || {});
    if (dateInfo) {
      const label = dateInfo.diffDays === 0 ? 'Today' : dateInfo.diffDays === 1 ? 'Tomorrow' : dateInfo.eventDate.toDateString();
      return { label, isVisible: (source: string) => this.isDynamicPpvDateVisibleInSource(source, dateInfo.diffDays, dateInfo.eventDate) };
    }

    const ppvDate = this.getConfiguredPpvDate(eventConfig);
    if (!ppvDate) return null;
    return { label: ppvDate, isVisible: (source: string) => this.isConfiguredPpvDateVisibleInSource(source, ppvDate) };
  }

  private async moveDownAndAssertPpvDateForFireTv(eventConfig?: any): Promise<void> {
    console.log('Fire TV Schedule debug: moving Down from Boxing to check PPV date first...');
    await this.driver.saveScreenshot('./test-results/firetv_schedule_after_boxing_down.png').catch(() => {});

    const dateCheck = this.buildPpvDateVisibilityCheck(eventConfig);
    if (!dateCheck) {
      console.warn('Fire TV Schedule debug: PPV_DATE/PPV_UTC_DATE not configured, skipping date assertion.');
      return;
    }
    const { label: ppvDate, isVisible } = dateCheck;

    // Bounded to avoid an infinite loop, but generous enough to survive the
    // schedule gaining extra Boxing cards ahead of the target PPV event.
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sourceBeforeDown = await this.driver.getPageSource();
      if (isVisible(sourceBeforeDown)) {
        console.log(`Fire TV Schedule debug: PPV date "${ppvDate}" found before DOWN press ${attempt + 1}.`);
        await this.driver.saveScreenshot('./test-results/firetv_schedule_ppv_date_found.png').catch(() => {});
        return;
      }

      sendTvKeyevent(TV_KEYCODES.DPAD_DOWN);
      await this.driver.pause(1200);

      const pageSource = await this.driver.getPageSource();
      if (isVisible(pageSource)) {
        console.log(`Fire TV Schedule debug: PPV date "${ppvDate}" found after ${attempt + 1} DOWN press(es).`);
        await this.driver.saveScreenshot('./test-results/firetv_schedule_ppv_date_found.png').catch(() => {});
        return;
      }
      console.log(`Fire TV Schedule debug: DOWN press ${attempt + 1}: PPV date not visible yet.`);
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const source = await this.driver.getPageSource().catch(() => '');
      if (isVisible(source)) {
        console.log(`Fire TV Schedule debug: PPV date visible before tile search: ${ppvDate}`);
        return;
      }

      await this.driver.pause(500);
    }

    await this.driver.saveScreenshot('./test-results/firetv_schedule_ppv_date_not_visible.png').catch(() => {});
    throw new Error(`Fire TV Schedule debug: PPV date not visible after pressing Down from Boxing: ${ppvDate}`);
  }

  private async tapScheduleFromFireTvLeftNav(): Promise<boolean> {
    const screen = getScreenSize();
    const minExpandedWidth = Math.round(screen.width * 0.08);

    const findExpandedScheduleCandidates = async (): Promise<FireTvTile[]> => {
      const source = await this.driver.getPageSource().catch(() => '');
      const candidates: FireTvTile[] = [];

      for (const match of source.matchAll(/<[^>]+>/g)) {
        const node = match[0];
        const label = this.getXmlAttribute(node, 'text') || this.getXmlAttribute(node, 'content-desc');
        if (!this.normalizeScheduleText(label).includes('schedule')) continue;

        const bounds = this.getXmlBounds(node);
        if (!bounds) continue;

        const isLeftNavLabel =
          bounds.x1 <= Math.round(screen.width * 0.18) &&
          bounds.x2 <= Math.round(screen.width * 0.24) &&
          bounds.y1 >= Math.round(screen.height * 0.40) &&
          bounds.y2 <= Math.round(screen.height * 0.78);

        // Skip narrow icon-only bounds; the nav row must be fully expanded with its text label
        // visible, otherwise a tap lands on the still-collapsed rail and silently does nothing.
        if (isLeftNavLabel && (bounds.x2 - bounds.x1) >= minExpandedWidth) {
          candidates.push({ label, ...bounds });
        }
      }

      return candidates;
    };

    let candidates = await findExpandedScheduleCandidates();
    for (let expandAttempt = 0; candidates.length === 0 && expandAttempt < 3; expandAttempt++) {
      console.log(`  Fire TV left nav still collapsed (icon-only); nudging Left again to expand (attempt ${expandAttempt + 1}/3)...`);
      sendTvKeyevent(TV_KEYCODES.DPAD_LEFT);
      await this.driver.pause(3000);
      candidates = await findExpandedScheduleCandidates();
    }

    for (const candidate of candidates.sort((a, b) => a.y1 - b.y1)) {
      const tapX = Math.min(Math.round(screen.width * 0.13), Math.max(candidate.x2 + 40, candidate.x1));
      const tapY = Math.round((candidate.y1 + candidate.y2) / 2);
      console.log(`  Fire TV left nav Schedule candidate: "${candidate.label}" at [${candidate.x1},${candidate.y1}][${candidate.x2},${candidate.y2}], tapping row (${tapX}, ${tapY})`);
      adbTap(tapX, tapY);
      await this.driver.pause(10000);
      if (await this.waitForSchedulePage(90000)) {
        console.log('Schedule selected from Fire TV left navigation via Schedule row bounds');
        await this.driver.saveScreenshot('./test-results/after_schedule_click.png').catch(() => {});
        return true;
      }
    }

    return false;
  }

  private async focusAndClickBoxingForFireTv(sport: string = 'Boxing'): Promise<void> {
    console.log(`Fire TV Schedule flow: highlighting ${sport} filter...`);
    await this.driver.pause(1200);
    const targetSport = this.normalizeScheduleText(sport);

    const boxingAlreadyFirstVisibleFilter = await this.isBoxingVisibleInFirstThirdOfFilterRow(sport);
    if (boxingAlreadyFirstVisibleFilter) {
      console.log(`  ${sport} is already the first visible Schedule filter in this region; tapping it directly instead of trusting D-pad focus.`);
      const tapped = await this.tryTapBoxingFilterOnFireTv(sport);
      await this.dismissFireTvLocationUnavailableDialogIfPresent();
      if (tapped) {
        await this.driver.saveScreenshot('./test-results/firetv_schedule_boxing_selected.png').catch(() => {});
        console.log(`${sport} clicked on Schedule page`);
        return;
      }
      console.warn(`⚠️ ${sport} direct tap did not confirm selection. Falling back to D-pad focus scan.`);
    }

    if (!boxingAlreadyFirstVisibleFilter) {
      console.log('  Moving Up once to place focus on the Schedule filter row...');
      await this.pressScheduleKeyForFireTv(TV_KEYCODES.DPAD_UP);
      await this.driver.pause(900);
    }

    let focusedLabel = '';
    let boxingFocused = false;
    // The sport filter row can have 30+ chips (e.g. Wrestling sits near the
    // end), so a small retry count stops short with the target still
    // off-screen and silently leaves the previous sport (e.g. Boxing) selected.
    const rightPresses = Math.max(1, Number(process.env.FIRETV_SPORT_RIGHT_PRESSES || '40'));
    for (let attempt = 0; attempt < rightPresses && !boxingFocused; attempt++) {
      focusedLabel = (await this.getFocusedLabel()).toLowerCase();
      boxingFocused =
        focusedLabel.includes(targetSport) ||
        await this.isBoxingHighlightedForFireTv(sport) ||
        await this.isFocusedFilterOnBoxingForFireTv(sport);

      if (boxingFocused) break;

      // Fire TV's filter row highlight isn't always reflected in the
      // accessibility focused/selected attributes (confirmed: "Current focus"
      // can stay stuck on an unrelated element for 20+ presses), so once the
      // chip itself renders on screen with real bounds, stop scrolling right
      // past it and let the tap fallback below click it directly.
      const visibleBounds = await this.getVisibleBoxingFilterBoundsForFireTv(sport);
      if (visibleBounds && visibleBounds.x2 - visibleBounds.x1 >= 4) {
        console.log(`  ${sport} chip now visible at [${visibleBounds.x1},${visibleBounds.y1}][${visibleBounds.x2},${visibleBounds.y2}] (focus metadata not reflecting it); stopping Right presses to tap it directly.`);
        break;
      }

      console.log(`  ${sport} not focused yet. Current focus: ${focusedLabel || 'unknown'}. Moving Right (${attempt + 1}/${rightPresses})...`);
      await this.pressScheduleKeyForFireTv(TV_KEYCODES.DPAD_RIGHT);
      await this.driver.pause(700);
    }

    focusedLabel = (await this.getFocusedLabel()).toLowerCase();
    boxingFocused =
      boxingFocused ||
      focusedLabel.includes(targetSport) ||
      await this.isBoxingHighlightedForFireTv(sport) ||
      await this.isFocusedFilterOnBoxingForFireTv(sport);

    if (!boxingFocused) {
      console.warn(`⚠️ ${sport} focus metadata did not update via DPAD. Falling back to a direct tap on the visible ${sport} filter chip.`);
      boxingFocused = await this.tryTapBoxingFilterOnFireTv(sport);
    }

    if (!boxingFocused) {
      await this.driver.saveScreenshot('./test-results/firetv_schedule_boxing_not_highlighted.png').catch(() => {});
      console.warn(`${sport} could not be focused or tapped. Continuing to PPV date check. Focused label was "${focusedLabel || 'unknown'}".`);
      return;
    }

    console.log(`${sport} focused in Schedule filter row. Clicking ${sport}...`);
    await this.pressScheduleKeyForFireTv(TV_KEYCODES.DPAD_CENTER);
    await this.driver.pause(1500);
    await this.dismissFireTvLocationUnavailableDialogIfPresent();

    const boxingSelected = await this.isBoxingHighlightedForFireTv(sport);
    if (!boxingSelected) {
      const focusedAfterClick = (await this.getFocusedLabel()).toLowerCase();
      if (!focusedAfterClick.includes(targetSport)) {
        console.warn(`${sport} click did not update Fire TV focus metadata. Continuing to PPV date check. Focused label: "${focusedAfterClick || 'unknown'}".`);
      }
    }

    await this.driver.saveScreenshot('./test-results/firetv_schedule_boxing_selected.png').catch(() => {});
    console.log(`${sport} clicked on Schedule page`);
  }

  private async navigateFireTvLeftNavToSchedule(): Promise<boolean> {
    console.log('Fire TV Schedule flow: opening left navigation and selecting Schedule...');
    this.fireTvExitDialogDismissed = false;

    console.log('  Waiting for Fire TV Home to be fully loaded before sending any input...');
    const homeReady = await this.waitForFireTvHomeReady(30000);
    if (!homeReady) {
      await this.driver.saveScreenshot('./test-results/firetv_home_not_loaded.png').catch(() => {});
      throw new Error('Fire TV Home did not finish loading (nav + content) before navigation input was required.');
    }
    await this.driver.pause(1500);

    sendTvKeyevent(TV_KEYCODES.DPAD_LEFT);
    await this.driver.pause(5000);

    if (await this.tapScheduleFromFireTvLeftNav()) {
      return true;
    }

    await this.driver.saveScreenshot('./test-results/firetv_left_nav_schedule_not_ready.png').catch(() => {});
    console.log('  Fire TV left navigation Schedule selection did not complete.');
    return false;
  }

  async navigate(): Promise<void> {
    console.log('Navigating to Fire TV Schedule tab...');
    if (await this.navigateFireTvLeftNavToSchedule()) {
      return;
    }
    console.log('Could not navigate to Schedule tab from Fire TV left navigation');
  }

  async openPPVPaywall(eventConfig?: any, hooks: AndroidFlowHooks = {}): Promise<boolean> {
    console.log('Navigating to Fire TV Schedule page...');
    await this.driver.pause(3000);
    await this.navigate();
    await this.driver.pause(8000);

    const onSchedule = await this.waitForSchedulePage(60000);
    if (!onSchedule) {
      await this.driver.saveScreenshot('./test-results/schedule_navigation_failed.png');
      throw new Error('Schedule page assertion failed after clicking Schedule. Expected Schedule title plus schedule date/tile content.');
    }

    console.log('On Fire TV Schedule page');
    await this.driver.pause(3000);
    const configuredSport = String(eventConfig?.SPORT || eventConfig?.global?.SPORT || process.env.SPORT || 'Boxing').trim() || 'Boxing';
    await this.focusAndClickBoxingForFireTv(configuredSport);
    await this.driver.pause(3000);

    console.log(`Navigating to ${this.ppvName} using Fire TV schedule controls...`);
    try {
      await this.moveDownAndAssertPpvDateForFireTv(eventConfig);
      await this.runSurfaceValidation(hooks, 'PPV Tile');
      await this.tapExactVisiblePpvTileForFireTv(this.ppvName);
      hooks.recordAvailability?.(true, undefined, 'Schedule');
    } catch (error) {
      const shot = hooks.saveScreenshot
        ? await hooks.saveScreenshot('./test-results/android_schedule_ppv_not_found.png')
        : undefined;
      hooks.recordAvailability?.(false, shot, 'Schedule');
      await hooks.generateAvailabilityFailureReport?.(`PPV "${this.ppvName}" not found on Schedule`);
      throw error;
    }

    await this.driver.pause(2000);

    const isUltimateUser = ['active_ultimate_apm', 'active_ultimate_upfront'].includes(String(process.env.USER_STATE || '').toLowerCase().trim());
    const isLoginFirst = String(process.env.LOGIN_FIRST || '').toLowerCase() === 'true';

    if (isUltimateUser && isLoginFirst) {
      console.log('[Ultimate Active User with LOGIN_FIRST=true] Tile clicked, navigated to fixture page. Ending flow.');
      return true;
    }

    console.log('  On paywall screen — Fire TV paywall is email-only (Yopmail handoff); skipping Copy button/date-and-time paywall validation.');
    await this.runPaywallValidation(hooks);
    return true;
  }
}

export async function openFireTvSchedulePPVPaywall(
  driver: WdBrowser,
  ppvName: string,
  eventConfig?: any,
  hooks: AndroidFlowHooks = {},
): Promise<boolean> {
  return new FireTvSchedulePage(driver, ppvName).openPPVPaywall(eventConfig, hooks);
}