import { Page } from '@playwright/test';

export interface RailTileMatch {
  railIndex: number;
  railTitle: string;
  railId: string;
  tileIndex: number;
  tileTitle: string;
  tileId: string;
  entitlementIds: string[];
  imageUrl?: string;
}

export interface RailsInterceptResult {
  allRails: unknown[];
  matchingTiles: RailTileMatch[];
  rawResponse?: unknown[];
}

type AnyRecord = Record<string, unknown>;

export class RailsInterceptor {
  private allRails: AnyRecord[] = [];
  private intercepting = false;
  private responseHandler?: (response: any) => Promise<void>;
  private readonly seenRailKeys = new Set<string>();

  constructor(private readonly page: Page) {}

  /**
   * Capture every JSON response during `action`, extract rail-like objects,
   * and optionally return entitlement matches.
   *
   * Start capture before navigation or the action that loads the home rails.
   */
  async captureAllRailsResponses(
    action: () => Promise<void>,
    timeout = 30_000,
    targetEntitlements?: string[]
  ): Promise<RailsInterceptResult> {
    this.allRails = [];
    const responses: unknown[] = [];
    const seenResponses = new Set<string>();

    const handler = async (response: any) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (
        response.status() !== 200 ||
        !contentType.toLowerCase().includes('application/json') ||
        !this.looksLikeRailsEndpoint(url)
      ) {
        return;
      }

      try {
        const body = await response.json();
        responses.push(body);
        this.collectRails(body, seenResponses);
      } catch {
        // Ignore malformed/non-JSON bodies even when the response header is misleading.
      }
    };

    this.page.on('response', handler);

    try {
      await action();
      await this.page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10_000) }).catch(() => {});
      await this.page.waitForTimeout(1_000);
    } finally {
      this.page.off('response', handler);
    }

    const matchingTiles = targetEntitlements
      ? this.findTilesByEntitlement(targetEntitlements)
      : [];

    console.log(
      `📡 [RailsInterceptor] Captured ${this.allRails.length} rails from ${responses.length} JSON response(s)`
    );

    return {
      allRails: this.allRails,
      matchingTiles,
      rawResponse: responses,
    };
  }

  /**
   * Compatibility API used by the existing PPV specs.
   * Starts passive response capture before navigation.
   */
  async startIntercepting(): Promise<void> {
    if (this.intercepting) return;

    this.intercepting = true;
    this.allRails = [];
    this.seenRailKeys.clear();

    this.responseHandler = async (response: any) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      if (
        response.status() !== 200 ||
        !contentType.toLowerCase().includes('application/json') ||
        !this.looksLikeRailsEndpoint(url)
      ) {
        return;
      }

      try {
        const body = await response.json();
        this.collectRails(body, this.seenRailKeys);
      } catch {
        // Ignore a response that cannot be decoded as JSON.
      }
    };

    this.page.on('response', this.responseHandler);
    console.log('🔌 [RailsInterceptor] Started intercepting rails responses');
  }

  /**
   * Compatibility API used by the existing PPV specs.
   * Always remove the listener so later tests do not leak listeners.
   */
  async stopIntercepting(): Promise<void> {
    if (this.responseHandler) {
      this.page.off('response', this.responseHandler);
    }

    this.responseHandler = undefined;
    this.intercepting = false;
    console.log('🔌 [RailsInterceptor] Stopped intercepting rails responses');
  }

  findTilesByEntitlement(
    targetEntitlements: string[],
    matchAll = false
  ): RailTileMatch[] {
    const targets = new Set(
      targetEntitlements
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
    );

    if (targets.size === 0) {
      throw new Error('[RailsInterceptor] At least one entitlement ID is required');
    }

    const matches: RailTileMatch[] = [];

    this.allRails.forEach((rail, railIndex) => {
      const railTitle = this.readString(rail, ['Title', 'title', 'Name', 'name', 'Heading', 'heading'])
        || `Rail ${railIndex}`;
      const railId = this.readString(rail, ['Id', 'id', 'RailId', 'railId']);

      if (this.isFreeRail(railTitle)) {
        console.log(`⏭️ [RailsInterceptor] Skipping free rail: "${railTitle}"`);
        return;
      }

      const tiles = this.readArray(rail, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']);

      tiles.forEach((rawTile, tileIndex) => {
        if (!this.isRecord(rawTile)) return;

        const entitlementIds = this.extractEntitlementIds(rawTile);
        const normalized = new Set(entitlementIds.map(value => value.toLowerCase()));

        const matched = matchAll
          ? [...targets].every(target => normalized.has(target))
          : [...targets].some(target => normalized.has(target));

        if (!matched) return;

        matches.push({
          railIndex,
          railTitle,
          railId,
          tileIndex,
          tileTitle: this.readString(rawTile, ['Title', 'title', 'Name', 'name', 'Heading', 'heading']) || `Tile ${tileIndex}`,
          tileId: this.readTileId(rawTile),
          entitlementIds,
          imageUrl: this.findImageUrl(rawTile),
        });
      });
    });

    console.log(`🎯 [RailsInterceptor] Found ${matches.length} entitlement match(es)`);
    return matches;
  }

  async clickFirstVisibleEntitlementTile(
    matches: RailTileMatch[],
    excludeSchedulingRails = true
  ): Promise<RailTileMatch | undefined> {
    if (matches.length === 0) return undefined;

    // Exclude tiles from scheduling/live rails — these open event-detail cards,
    // not subscription modals, when clicked on the home page.
    const schedulingRailPattern = /upcoming\s*fights?|live\s*(and|&|\+)?\s*coming|coming\s*up|live\s*now|dazn\s*48|live\s*event/i;
    const filtered = excludeSchedulingRails
      ? matches.filter(m => !schedulingRailPattern.test(m.railTitle))
      : matches;
    const effective = filtered.length > 0 ? filtered : matches; // fall back if all filtered
    if (excludeSchedulingRails && filtered.length < matches.length) {
      console.log(
        `🔎 [RailsInterceptor] Excluded ${matches.length - filtered.length} scheduling-rail tile(s) ` +
        `(Upcoming Fights / Live & Coming Up). Using ${effective.length} candidate(s).`
      );
    }

    const byTitle = new Map<string, RailTileMatch[]>();
    for (const match of effective) {
      const key = match.tileTitle.trim().toLowerCase();
      byTitle.set(key, [...(byTitle.get(key) || []), match]);
    }

    type Candidate = {
      match: RailTileMatch;
      top: number;
      left: number;
    };

    const discovered = new Map<string, Candidate>();
    const maxSteps = 14;
    const stepPx = Math.max(
      650,
      await this.page.evaluate(() => Math.floor(window.innerHeight * 0.85))
    );

    console.log(
      `🔎 [RailsInterceptor] Discovering first visual entitlement tile from ` +
      `${matches.length} Rails candidates`
    );

    for (let step = 0; step < maxSteps; step++) {
      const scrollY = await this.page.evaluate(() => window.scrollY);

      for (const [normalizedTitle, titleMatches] of byTitle) {
        const match = titleMatches[0];

        // Strategy A: title text present in DOM
        const textEl = this.page.getByText(match.tileTitle, { exact: true }).first();
        let clickable = (await textEl.isVisible().catch(() => false))
          ? textEl.locator(
              'xpath=ancestor-or-self::a | ancestor-or-self::button | ' +
              'ancestor-or-self::*[@role="link"] | ancestor-or-self::*[@role="button"]'
            ).first()
          : null;

        // If text match not found, fall back to image URL fragment matching (Strategy B).
        // Many home-page tiles render their title only as an image overlay; the
        // URL fragment (e.g. "/some-content-id/") uniquely identifies the tile
        // even when no text node is visible.
        if ((!clickable || !(await clickable.count().catch(() => 0))) && match.imageUrl) {
          const urlFragment = match.imageUrl
            .split('/')
            .filter(Boolean)
            .slice(-2, -1)[0]; // second-to-last path segment

          if (urlFragment && urlFragment.length > 4) {
            const imgEl = this.page
              .locator(`img[src*="${urlFragment}"]`)
              .first();

            if (await imgEl.isVisible().catch(() => false)) {
              clickable = imgEl.locator(
                'xpath=ancestor-or-self::a | ancestor-or-self::button | ' +
                'ancestor-or-self::*[@role="link"] | ancestor-or-self::*[@role="button"]'
              ).first();

              if (!(await clickable.count().catch(() => 0))) {
                clickable = imgEl;
              }
            }
          }
        }

        if ((!clickable || !(await clickable.count().catch(() => 0))) && match.tileId) {
          const safeId = match.tileId.replace(/"/g, '\\"');
          const link = this.page
            .locator(`a[href*="ContentId:${safeId}"], a[href*="/${safeId}"]`)
            .filter({ visible: true })
            .first();
          if (await link.isVisible().catch(() => false)) {
            clickable = link;
          }
        }

        if (!clickable || !(await clickable.count().catch(() => 0))) continue;
        const box = await clickable.boundingBox().catch(() => null);
        if (!box) continue;

        const key = `${match.railIndex}:${match.tileIndex}:${normalizedTitle}`;
        discovered.set(key, {
          match,
          top: box.y + scrollY,
          left: box.x,
        });
      }

      const ordered = [...discovered.values()].sort(
        (a, b) => a.top - b.top || a.left - b.left
      );

      const first = ordered[0];
      const viewportBottom = scrollY + await this.page.evaluate(() => window.innerHeight);

      // We have moved beyond the earliest discovered candidate. Rails above it
      // have had a chance to lazy-render, so its position is now stable enough
      // to select without scanning the whole page.
      if (first && viewportBottom >= first.top + stepPx) {
        console.log(
          `🎯 [RailsInterceptor] Selected earliest discovered entitlement tile ` +
          `"${first.match.tileTitle}" from rail "${first.match.railTitle}" ` +
          `(top=${Math.round(first.top)}, left=${Math.round(first.left)})`
        );

        const clickable = await this.resolveClickable(first.match);
        if (clickable) {
          await clickable.scrollIntoViewIfNeeded().catch(() => {});
          await this.page.waitForTimeout(250);
          if (await clickable.isVisible().catch(() => false)) {
            await clickable.click({ force: true, timeout: 8_000 });
            console.log(`✅ [RailsInterceptor] Clicked entitled tile "${first.match.tileTitle}"`);
            return first.match;
          }
        }
      }

      const atBottom = await this.page.evaluate(
        () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4
      );

      if (atBottom) break;

      console.log(
        `🔎 [RailsInterceptor] Discovery step ${step + 1}/${maxSteps}; ` +
        `pageY=${Math.round(scrollY)}; candidates=${discovered.size}`
      );

      await this.page.evaluate((distance) => {
        window.scrollBy({ top: distance, behavior: 'instant' });
      }, stepPx);

      await this.page.waitForTimeout(700);
    }

    const ordered = [...discovered.values()].sort(
      (a, b) => a.top - b.top || a.left - b.left
    );

    const first = ordered[0];
    if (!first) {
      console.log(
        '⚠️ [RailsInterceptor] No Rails-entitled tile rendered during discovery scan'
      );
      return undefined;
    }

    const clickable = await this.resolveClickable(first.match);
    if (!clickable) return undefined;

    await clickable.scrollIntoViewIfNeeded().catch(() => {});
    await this.page.waitForTimeout(250);

    if (!await clickable.isVisible().catch(() => false)) return undefined;

    console.log(
      `🎯 [RailsInterceptor] Clicking earliest discovered entitlement tile ` +
      `"${first.match.tileTitle}" from rail "${first.match.railTitle}"`
    );

    await clickable.click({ force: true, timeout: 8_000 });
    console.log(`✅ [RailsInterceptor] Clicked entitled tile "${first.match.tileTitle}"`);
    return first.match;
  }

  /**
   * Click one exact entitlement match.
   * Keeps the caller's selected match as the only candidate: no rail/title
   * hardcoding and no fallback to a different entitled tile.
   */
  async clickTileByRailPosition(
    match: RailTileMatch
  ): Promise<RailTileMatch | undefined> {
    return this.clickFirstVisibleEntitlementTile([match]);
  }

  /**
   * Some base-entitlement tiles open a content-selection panel before the
   * subscription modal. Select its locked option to continue to the paywall.
   *
   * The panel is not always rendered inside #notification-layer — it can
   * also open as an inline side panel next to the clicked tile (e.g. a
   * "Select what you want to watch" list with Highlights/Full Replay
   * options). Locate it by its heading text anywhere on the page instead of
   * assuming a fixed container/class name, so both layouts are supported.
   */
  async clickLockedContentSelection(): Promise<boolean> {
    // The panel can render its rows before the entitlement/lock state has
    // finished loading, so a single immediate check can miss the lock icon
    // that appears a moment later. Retry the detection for a few seconds
    // before giving up.
    const deadline = Date.now() + 5_000;
    let attempt = 0;
    while (true) {
      attempt++;
      const result = await this.attemptClickLockedContentSelection();
      if (result) return true;
      if (Date.now() >= deadline) {
        if (attempt > 1) {
          console.log('ℹ️ [RailsInterceptor] Content-selection panel has no visible locked option after retrying');
        }
        return false;
      }
      await this.page.waitForTimeout(300).catch(() => {});
    }
  }

  private async attemptClickLockedContentSelection(): Promise<boolean> {
    const panelFound = await this.page.evaluate(() => {
      const HEADING_RE = /select what you want to watch/i;
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
      };

      // Find the smallest visible element whose own text (not just nested
      // descendants) matches the panel heading.
      const heading = Array.from(document.querySelectorAll<HTMLElement>('*')).find(el => {
        if (!isVisible(el)) return false;
        const ownText = Array.from(el.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent || '')
          .join(' ')
          .trim();
        return HEADING_RE.test(ownText);
      });
      if (!heading) return false;

      // Rows are not always semantic button/link/role markup — some are
      // plain elements (e.g. <li>/<div>) driven by JS click handlers. Detect
      // those by their pointer cursor too, keeping only the outermost such
      // element per row so nested icon/text wrappers aren't double-counted.
      const findRowCandidates = (scope: HTMLElement): HTMLElement[] => {
        const tagged = Array.from(
          scope.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="option"]')
        );
        const pointerEls = Array.from(scope.querySelectorAll<HTMLElement>('*')).filter(candidate => {
          if (!isVisible(candidate)) return false;
          if (!(candidate.innerText || '').trim()) return false;
          return window.getComputedStyle(candidate).cursor === 'pointer';
        });
        const outerPointerEls = pointerEls.filter(candidate =>
          !pointerEls.some(other => other !== candidate && other.contains(candidate))
        );
        return Array.from(new Set([...tagged, ...outerPointerEls]));
      };

      // Climb from the heading to the nearest ancestor that also contains
      // the selectable content options (at least 2 clickable rows).
      let container: HTMLElement | null = heading;
      for (let i = 0; i < 6 && container; i++) {
        if (findRowCandidates(container).length >= 2) break;
        container = container.parentElement;
      }
      if (!container) return false;

      container.setAttribute('data-ppv-content-selection-panel', 'true');
      return true;
    }).catch(() => false);

    if (!panelFound) {
      return false;
    }

    const panel = this.page.locator('[data-ppv-content-selection-panel="true"]').first();

    if (!await panel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await panel.evaluate((element: HTMLElement) => {
        element.removeAttribute('data-ppv-content-selection-panel');
      }).catch(() => {});
      return false;
    }

    const lockedOptionFound = await panel.evaluate((element: HTMLElement) => {
      const isVisible = (candidate: HTMLElement) => {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
      };
      const isLocked = (candidate: HTMLElement) => {
        const metadata = [
          candidate.innerText,
          candidate.getAttribute('aria-label'),
          candidate.getAttribute('data-testid'),
          candidate.className,
          candidate.innerHTML,
        ].join(' ');
        return /\b(?:lock|locked)\b/i.test(metadata) ||
          !!candidate.querySelector(
            '[aria-label*="lock" i], [data-testid*="lock" i], [class*="lock" i], svg[data-icon="lock"]'
          ) ||
          candidate.querySelectorAll('svg').length > 1;
      };
      const options = Array.from(
        new Set([
          ...element.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="option"]'),
          ...Array.from(element.querySelectorAll<HTMLElement>('*')).filter(candidate => {
            if (!isVisible(candidate)) return false;
            if (!(candidate.innerText || '').trim()) return false;
            return window.getComputedStyle(candidate).cursor === 'pointer';
          }).filter((candidate, _i, all) =>
            !all.some(other => other !== candidate && other.contains(candidate))
          ),
        ])
      );
      const lockedOption = options.find(option =>
        isVisible(option) &&
        option.getAttribute('aria-disabled') !== 'true' &&
        isLocked(option)
      );

      if (!lockedOption) return false;
      lockedOption.setAttribute('data-ppv-locked-content-selection', 'true');
      return true;
    }).catch(() => false);

    if (!lockedOptionFound) {
      await panel.evaluate((element: HTMLElement) => {
        element.removeAttribute('data-ppv-content-selection-panel');
      }).catch(() => {});
      return false;
    }

    const lockedOption = panel.locator('[data-ppv-locked-content-selection="true"]').first();
    try {
      await lockedOption.click({ timeout: 5_000 });
      console.log('✅ [RailsInterceptor] Clicked locked content-selection option');
      return true;
    } finally {
      await lockedOption.evaluate((element: HTMLElement) => {
        element.removeAttribute('data-ppv-locked-content-selection');
      }).catch(() => {});
      await panel.evaluate((element: HTMLElement) => {
        element.removeAttribute('data-ppv-content-selection-panel');
      }).catch(() => {});
    }
  }

  /**
   * Find tiles within rails whose title matches a pattern, with an optional
   * per-tile title check. Useful when tile text lives on an image overlay
   * (not in DOM text) but is available in the API response's tile title field.
   */
  findTilesByRailTitle(
    railTitlePattern: RegExp,
    tileTitleCheck?: (title: string) => boolean
  ): RailTileMatch[] {
    const matches: RailTileMatch[] = [];

    this.allRails.forEach((rail, railIndex) => {
      const railTitle =
        this.readString(rail, ['Title', 'title', 'Name', 'name', 'Heading', 'heading']) ||
        `Rail ${railIndex}`;

      if (!railTitlePattern.test(railTitle)) return;

      const tiles = this.readArray(rail, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']);
      console.log(
        `🔍 [RailsInterceptor] Rail "${railTitle}" matched pattern — scanning ${tiles.length} tile(s)`
      );

      tiles.forEach((rawTile, tileIndex) => {
        if (!this.isRecord(rawTile)) return;

        const tileTitle =
          this.readString(rawTile, ['Title', 'title', 'Name', 'name', 'Heading', 'heading']) ||
          `Tile ${tileIndex}`;

        if (tileTitleCheck && !tileTitleCheck(tileTitle)) return;

        matches.push({
          railIndex,
          railTitle,
          railId: this.readString(rail, ['Id', 'id', 'RailId', 'railId']),
          tileIndex,
          tileTitle,
          tileId: this.readTileId(rawTile),
          entitlementIds: this.extractEntitlementIds(rawTile),
          imageUrl: this.findImageUrl(rawTile),
        });
      });
    });

    console.log(`🎯 [RailsInterceptor] findTilesByRailTitle: ${matches.length} match(es)`);
    return matches;
  }

  /**
   * Resolve rendered Home-card match IDs for an event title from DAZN's public
   * Home Rails payload. The Home DOM labels these cards with a promotion, not
   * the fight name; the event record links its title to the competition and
   * poster images. No entitlement is used for matching.
   */
  async findHomePortraitImageIdsByTitle(titleWordLists: string[][]): Promise<string[]> {
    if (titleWordLists.length === 0) return [];

    const imageIds = await this.page.evaluate(async ({ wordLists }) => {
      const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const titleMatches = (value: string) => {
        const text = normalise(value);
        return wordLists.some(words => words.every(word => text.includes(word)));
      };
      const readString = (record: Record<string, unknown>, keys: string[]) => {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
      };
      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);
      const imageId = (value: unknown): string =>
        isRecord(value) && typeof value.Id === 'string' ? value.Id : '';
      const competitionIds = new Set<string>();
      const portraitIds = new Set<string>();
      const fallbackIds = new Set<string>();
      const visited = new Set<object>();

      const collectImages = (competition: Record<string, unknown>) => {
        const competitionId = readString(competition, ['Id', 'id', 'CompetitionId', 'competitionId']);
        if (competitionId) competitionIds.add(competitionId);

        const images = Array.isArray(competition.Images) ? competition.Images : [];
        for (const image of images) {
          if (!isRecord(image)) continue;
          const id = imageId(image);
          if (!id) continue;
          const type = String(image.ImageType || image.imageType || '').toLowerCase();
          if (type.includes('portrait')) portraitIds.add(id);
          else if (type.includes('tile')) fallbackIds.add(id);
        }
        for (const key of ['PortraitImage', 'portraitImage', 'Image', 'image']) {
          const id = imageId(competition[key]);
          if (id) fallbackIds.add(id);
        }
      };

      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!isRecord(value) || visited.has(value)) return;
        visited.add(value);

        const title = readString(value, ['Title', 'title', 'Name', 'name']);
        if (title && titleMatches(title)) {
          const competition = value.Competition ?? value.competition;
          if (isRecord(competition)) collectImages(competition);
        }
        Object.values(value).forEach(visit);
      };

      try {
        const locale = location.pathname.split('/').find(part => /^en-/i.test(part)) || 'en-GB';
        const country = locale.slice(3).toLowerCase();
        const params = 'PageType:Home;ContentType:None;OpenBrowse:True';
        const homeRailsUrl = new URL('https://rails.discovery.indazn.com/eu/v9/rails');
        homeRailsUrl.search = new URLSearchParams({
          groupId: 'home', country, openBrowse: 'true', brand: 'dazn',
        }).toString();
        const homeRails = await fetch(homeRailsUrl.toString(), { credentials: 'omit' }).then(response => response.json());
        const rails = Array.isArray(homeRails.Rails) ? homeRails.Rails : [];

        for (const rail of rails) {
          if (!isRecord(rail) || typeof rail.Id !== 'string') continue;
          const railUrl = new URL('https://rail-router.discovery.indazn.com/eu/v10/Rail');
          railUrl.search = new URLSearchParams({
            platform: 'web', id: rail.Id, country, brand: 'dazn', languageCode: 'en',
            params: typeof rail.Params === 'string' ? rail.Params : params,
          }).toString();
          const payload = await fetch(railUrl.toString(), { credentials: 'omit' })
            .then(response => response.ok ? response.json() : null)
            .catch(() => null);
          if (payload) visit(payload);
          if (portraitIds.size > 0) break;
        }
      } catch {
        return [];
      }
      return [...competitionIds, ...portraitIds, ...fallbackIds];
    }, { wordLists: titleWordLists });

    console.log(`🎯 [RailsInterceptor] Resolved ${imageIds.length} Home match ID(s) from PPV title`);
    return imageIds;
  }

  printRailsSummary(): void {
    console.log(`📊 [RailsInterceptor] Rails captured: ${this.allRails.length}`);
    this.allRails.forEach((rail, index) => {
      const title = this.readString(rail, ['Title', 'title', 'Name', 'name']) || `Rail ${index}`;
      const tiles = this.readArray(rail, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']);
      console.log(`  • "${title}" → ${tiles.length} tiles`);
    });
  }

  get capturedRails(): readonly AnyRecord[] {
    return this.allRails;
  }

  private looksLikeRailsEndpoint(url: string): boolean {
    const value = url.toLowerCase();

    // Keep this deliberately broad. The old working interceptor captured
    // responses whose URL contained any of these tokens, and DAZN endpoint
    // names can vary by environment.
    return (
      value.includes('rail') ||
      value.includes('catalogue') ||
      value.includes('content') ||
      value.includes('page')
    );
  }

  private collectRails(value: unknown, seen: Set<string>): void {
    if (Array.isArray(value)) {
      value.forEach(item => this.collectRails(item, seen));
      return;
    }

    if (!this.isRecord(value)) return;

    if (this.looksLikeRail(value)) {
      const key = [
        this.readString(value, ['Id', 'id', 'RailId', 'railId']),
        this.readString(value, ['Title', 'title', 'Name', 'name']),
      ].join('|');

      if (!seen.has(key)) {
        seen.add(key);
        this.allRails.push(value);
      }
    }

    Object.values(value).forEach(child => this.collectRails(child, seen));
  }

  private looksLikeRail(value: AnyRecord): boolean {
    return this.readArray(value, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']).length > 0;
  }

  private extractEntitlementIds(tile: AnyRecord): string[] {
    const found = new Set<string>();

    const visit = (value: unknown, depth: number): void => {
      if (depth > 5 || value == null) return;

      if (typeof value === 'string') return;

      if (Array.isArray(value)) {
        value.forEach(item => visit(item, depth + 1));
        return;
      }

      if (!this.isRecord(value)) return;

      for (const [key, child] of Object.entries(value)) {
        if (/^entitlementids?$/i.test(key) || /^entitlements?$/i.test(key)) {
          if (typeof child === 'string' && child.trim()) found.add(child.trim());
          if (Array.isArray(child)) {
            child.forEach(item => {
              if (typeof item === 'string' && item.trim()) found.add(item.trim());
              if (this.isRecord(item)) {
                const id = this.readString(item, ['Id', 'id', 'EntitlementId', 'entitlementId']);
                if (id) found.add(id);
              }
            });
          }
        }
        visit(child, depth + 1);
      }
    };

    visit(tile, 0);
    return [...found];
  }

  private findImageUrl(tile: AnyRecord): string | undefined {
    const visit = (value: unknown, depth: number): string | undefined => {
      if (depth > 4 || value == null) return undefined;
      if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : undefined;
      if (Array.isArray(value)) {
        for (const item of value) {
          const result = visit(item, depth + 1);
          if (result) return result;
        }
        return undefined;
      }
      if (!this.isRecord(value)) return undefined;

      for (const [key, child] of Object.entries(value)) {
        if (/image|poster|thumbnail|artwork/i.test(key)) {
          const result = visit(child, depth + 1);
          if (result) return result;
        }
      }
      return undefined;
    };

    return visit(tile, 0);
  }

  private readTileId(tile: AnyRecord): string {
    const navParams = this.readString(tile, ['ArticleNavParams', 'articleNavParams', 'NavParams', 'navParams']);
    const contentId = navParams.match(/ContentId:([^;]+)/i)?.[1];
    return contentId || this.readString(tile, ['Id', 'id', 'TileId', 'tileId', 'ContentId', 'contentId', 'AssetId', 'assetId']);
  }

  private readArray(record: AnyRecord, keys: string[]): unknown[] {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  private readString(record: AnyRecord, keys: string[]): string {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return '';
  }

  private isFreeRail(title: string): boolean {
    const value = title.toLowerCase();
    return [
      'free to watch',
      'free to air',
      'watch for free',
      'freeview',
    ].some(label => value.includes(label));
  }

  /**
   * Resolve a clickable element for a tile using Strategy A (title text) then
   * Strategy B (image URL fragment). Used by both early-exit and post-loop click sites.
   */
  private async resolveClickable(match: RailTileMatch) {
    // Strategy A: title text node visible in DOM
    const textEl = this.page.getByText(match.tileTitle, { exact: true }).first();
    if (await textEl.isVisible().catch(() => false)) {
      const target = textEl.locator(
        'xpath=ancestor-or-self::a | ancestor-or-self::button | ' +
        'ancestor-or-self::*[@role="link"] | ancestor-or-self::*[@role="button"]'
      ).first();
      return (await target.count().catch(() => 0)) > 0 ? target : textEl;
    }

    // Strategy B: image URL fragment match
    if (match.imageUrl) {
      const urlFragment = match.imageUrl.split('/').filter(Boolean).slice(-2, -1)[0];
      if (urlFragment && urlFragment.length > 4) {
        const imgEl = this.page.locator(`img[src*="${urlFragment}"]`).first();
        if (await imgEl.isVisible().catch(() => false)) {
          const target = imgEl.locator(
            'xpath=ancestor-or-self::a | ancestor-or-self::button | ' +
            'ancestor-or-self::*[@role="link"] | ancestor-or-self::*[@role="button"]'
          ).first();
          return (await target.count().catch(() => 0)) > 0 ? target : imgEl;
        }
      }
    }

    // Strategy C: rendered card URL contains the Rails content ID.
    if (match.tileId) {
      const safeId = match.tileId.replace(/"/g, '\\"');
      const link = this.page
        .locator(`a[href*="ContentId:${safeId}"], a[href*="/${safeId}"]`)
        .filter({ visible: true })
        .first();
      if (await link.isVisible().catch(() => false)) return link;
    }

    return null;
  }

  private isRecord(value: unknown): value is AnyRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
