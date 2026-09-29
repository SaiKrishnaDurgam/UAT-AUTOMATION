export type RecordDict = Record<string, unknown>;

export function isRecord(val: unknown): val is RecordDict {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function readString(obj: RecordDict, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

export function readArray(obj: RecordDict, keys: string[]): unknown[] {
  for (const k of keys) {
    const val = obj[k];
    if (Array.isArray(val)) return val;
  }
  return [];
}

export interface AndroidRailTileMatch {
  railIndex: number;
  railTitle: string;
  railId: string;
  tileIndex: number;
  globalTileIndex: number;
  sportTileIndex: number;
  tileTitle: string;
  eventTitle: string;
  tileId: string;
  contentId: string;
  assetId?: string;
  eventId?: string;
  entitlementId: string;
  entitlementIds: string[];
  imageUrl?: string;
  totalTilesInRail: number;
}

export interface AndroidRailsFetchResult {
  matchingTiles: AndroidRailTileMatch[];
  totalRailsCaptured: number;
  rawRailsCount?: number;
}

function extractEntitlementIds(tile: RecordDict): string[] {
  const found = new Set<string>();

  const visit = (val: unknown, depth: number): void => {
    if (depth > 5 || val == null) return;
    if (typeof val === 'string') return;
    if (Array.isArray(val)) {
      val.forEach(item => visit(item, depth + 1));
      return;
    }
    if (!isRecord(val)) return;

    for (const [key, child] of Object.entries(val)) {
      if (/^entitlementids?$/i.test(key) || /^entitlements?$/i.test(key) || /^assetid$/i.test(key) || /^eventid$/i.test(key)) {
        if (typeof child === 'string' && child.trim()) found.add(child.trim());
        if (Array.isArray(child)) {
          child.forEach(item => {
            if (typeof item === 'string' && item.trim()) found.add(item.trim());
            if (isRecord(item)) {
              const id = readString(item, ['Id', 'id', 'EntitlementId', 'entitlementId', 'AssetId', 'assetId', 'EventId', 'eventId']);
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

function extractImageUrl(tile: RecordDict): string | undefined {
  const imgObj = tile.Image || tile.image || tile.Artwork || tile.artwork;
  if (isRecord(imgObj)) {
    return readString(imgObj, ['Url', 'url', 'Uri', 'uri', 'Src', 'src']);
  }
  if (typeof imgObj === 'string' && imgObj.trim()) return imgObj.trim();
  return undefined;
}

export class AndroidRailsFetcher {
  /**
   * Query backend DAZN Rail Router REST API (same API as Web) to locate target tile dynamically
   * by fetching single rail payloads and parsing the `Tiles` array for EntitlementIds, AssetId, or EventId.
   * Endpoints:
   * 1. GET https://rails.discovery.indazn.com/eu/v9/rails?groupId=<page>&country=gb&brand=dazn&openBrowse=true
   * 2. GET https://rail-router.discovery.indazn.com/eu/v10/Rail?platform=android&id=<railId>&country=gb&brand=dazn&languageCode=en
   */
  static async fetchAndMatchRails(options: {
    page?: string;
    groupId?: string;
    assetId?: string;
    eventId?: string;
    entitlementId?: string;
    ppvTitle?: string;
    promoter?: string;
    country?: string;
    brand?: string;
    languageCode?: string;
    platform?: 'android' | 'ios';
  }): Promise<AndroidRailsFetchResult> {
    const platform = options.platform || 'android';
    const rawPage = options.page || options.groupId || 'home';
    const pageNameClean = rawPage.toLowerCase().trim();
    const isHome = pageNameClean === 'home';
    const country = (options.country || 'GB').toLowerCase();
    const brand = (options.brand || 'dazn').toLowerCase();

    let pageGroup = 'home';

    const targetAssetId = (options.assetId || '').trim().toLowerCase();
    const targetEventId = (options.eventId || '').trim().toLowerCase();
    const targetEntitlement = (options.entitlementId || '').trim().toLowerCase();
    const targetTitle = (options.ppvTitle || '').trim().toLowerCase();
    const targetPromoter = (options.promoter || '').trim().toLowerCase();

    const cleanEntitlement = targetEntitlement.replace(/^ppv_[te]_/i, '').replace(/[^a-z0-9]/g, '');

    try {
      const railsUrl = `https://rails.discovery.indazn.com/eu/v9/rails?groupId=${encodeURIComponent(pageGroup)}&country=${country}&brand=${brand}&openBrowse=true`;
      console.log(`📡 [AndroidRailsFetcher] Fetching rails API index for page "${rawPage}"...`);

      const res = await fetch(railsUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': platform === 'ios'
            ? 'DAZN/3.0.0 (iPhone; iOS 17; Mobile)'
            : 'DAZN/3.0.0 (Linux; Android 13; Mobile)',
        },
      });

      if (!res.ok) {
        console.log(`⚠️ [AndroidRailsFetcher] Rails API index returned HTTP status ${res.status}`);
        return { matchingTiles: [], totalRailsCaptured: 0 };
      }

      const body = await res.json();
      const rawRailDescriptors = isRecord(body) ? readArray(body, ['Rails', 'rails']) : [];
      console.log(`📡 Captured ${rawRailDescriptors.length} rail descriptors from rails index.`);

      const matchingTiles: AndroidRailTileMatch[] = [];

      for (let railIndex = 0; railIndex < rawRailDescriptors.length; railIndex++) {
        const rawRail = rawRailDescriptors[railIndex];
        if (!isRecord(rawRail)) continue;

        const railId = readString(rawRail, ['Id', 'id', 'RailId', 'railId']);
        const railTitleHeader = readString(rawRail, ['Title', 'title', 'Name', 'name', 'Heading', 'heading']);
        const params = readString(rawRail, ['Params', 'params']) || 'PageType:Home;ContentType:None;OpenBrowse:True';

        let tiles: unknown[] = readArray(rawRail, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']);
        let railTitle = railTitleHeader || `Rail ${railIndex}`;

        // Skip free-to-watch rails (mirrors web RailsInterceptor.isFreeRail)
        const railTitleLower = railTitle.toLowerCase();
        if (['free to watch', 'free to air', 'watch for free', 'freeview'].some(label => railTitleLower.includes(label))) {
          console.log(`⏭️ [AndroidRailsFetcher] Skipping free rail: "${railTitle}"`);
          continue;
        }

        // If rail descriptor has no embedded tiles, query DAZN Rail Router API (same API as Web)
        if (tiles.length === 0 && railId) {
          try {
            const railRouterUrl = `https://rail-router.discovery.indazn.com/eu/v10/Rail?platform=${platform}&id=${encodeURIComponent(railId)}&country=${country}&brand=${brand}&languageCode=en&params=${encodeURIComponent(params)}`;
            const railRes = await fetch(railRouterUrl, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': platform === 'ios'
                  ? 'DAZN/3.0.0 (iPhone; iOS 17; Mobile)'
                  : 'DAZN/3.0.0 (Linux; Android 13; Mobile)',
                'X-DAZN-Country': country.toUpperCase(),
                'X-DAZN-Region': country.toUpperCase(),
              },
            });
            if (railRes.ok) {
              const railPayload = await railRes.json();
              if (isRecord(railPayload)) {
                railTitle = readString(railPayload, ['Title', 'title', 'Header', 'header', 'Name', 'name']) || railTitle;
                tiles = readArray(railPayload, ['Tiles', 'tiles', 'Items', 'items', 'Contents', 'contents']);
              }
            }
          } catch {}
        }

        // Re-check after Rail Router API may have resolved the real title
        const resolvedTitleLower = railTitle.toLowerCase();
        if (['free to watch', 'free to air', 'watch for free', 'freeview'].some(label => resolvedTitleLower.includes(label))) {
          console.log(`⏭️ [AndroidRailsFetcher] Skipping free rail (resolved): "${railTitle}"`);
          continue;
        }

        let sportTileCounter = 0;

        tiles.forEach((rawTile, globalTileIndex) => {
          if (!isRecord(rawTile)) return;

          const tileDetails = isRecord(rawTile.TileDetails)
            ? rawTile.TileDetails
            : isRecord(rawTile.tileDetails)
            ? rawTile.tileDetails
            : rawTile;

          const tileTitle = readString(tileDetails, ['Title', 'title', 'Name', 'name', 'Heading', 'heading', 'EventTitle', 'eventTitle']) || readString(rawTile, ['Title', 'title', 'Name', 'name']) || `Tile ${globalTileIndex}`;
          const tileDesc = readString(tileDetails, ['Description', 'description']) || readString(rawTile, ['Description', 'description']) || '';
          const tileId = readString(tileDetails, ['Id', 'id', 'TileId', 'tileId', 'ContentId', 'contentId']) || readString(rawTile, ['Id', 'id']) || `tile_${globalTileIndex}`;
          const contentId = readString(tileDetails, ['ContentId', 'contentId', 'Id', 'id']) || tileId;
          const assetId = readString(tileDetails, ['AssetId', 'assetId', 'AssetID', 'asset_id']) || readString(rawTile, ['AssetId', 'assetId']);
          const eventId = readString(tileDetails, ['EventId', 'eventId', 'EventID', 'event_id']) || readString(rawTile, ['EventId', 'eventId']);

          const entitlementIds = extractEntitlementIds(rawTile);
          const imageUrl = extractImageUrl(rawTile);

          const tileTitleClean = tileTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

          // Check if this tile belongs to the target sport (e.g. Boxing vs Football)
          const isSportMatch = pageNameClean === 'home' || (
            tileTitleClean.includes(pageNameClean) ||
            tileDesc.toLowerCase().includes(pageNameClean) ||
            tileTitleClean.includes('vs') ||
            tileTitleClean.includes('boxing') ||
            tileTitleClean.includes('fight')
          );

          const currentSportIndex = sportTileCounter;
          if (isSportMatch) {
            sportTileCounter++;
          }

          const matchesAssetId = targetAssetId && assetId && assetId.toLowerCase() === targetAssetId;
          const matchesEventId = targetEventId && eventId && eventId.toLowerCase() === targetEventId;
          const matchesEntitlement = targetEntitlement && (
            entitlementIds.some(id => {
              const cleanId = id.toLowerCase().replace(/^ppv_[te]_/i, '').replace(/[^a-z0-9]/g, '');
              return cleanId === cleanEntitlement || id.toLowerCase().includes(targetEntitlement) || targetEntitlement.includes(id.toLowerCase());
            }) ||
            tileId.toLowerCase().includes(targetEntitlement)
          );
          const matchesTitle = targetTitle && (
            tileTitleClean.includes(targetTitle.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
            (targetTitle.split('vs')[0] && tileTitleClean.includes(targetTitle.split('vs')[0].toLowerCase().replace(/[^a-z0-9]/g, '').trim()))
          );
          const matchesPromoter = targetPromoter && targetPromoter.length > 2 && tileTitleClean.includes(targetPromoter);

          if (matchesAssetId || matchesEventId || matchesEntitlement || matchesTitle || matchesPromoter) {
            const primaryEntitlement = entitlementIds.find(id => id.toLowerCase().includes(targetEntitlement)) || entitlementIds[0] || targetEntitlement;

            // Page-aware tile index: use sportTileIndex on sport pages (e.g. Boxing) and globalTileIndex on Home page
            const effectiveTileIndex = isHome ? globalTileIndex : currentSportIndex;

            matchingTiles.push({
              railIndex,
              railTitle,
              railId: railId || `rail_${railIndex}`,
              tileIndex: effectiveTileIndex,
              globalTileIndex,
              sportTileIndex: currentSportIndex,
              tileTitle,
              eventTitle: tileTitle,
              tileId,
              contentId,
              assetId,
              eventId,
              entitlementId: primaryEntitlement,
              entitlementIds,
              imageUrl,
              totalTilesInRail: tiles.length,
            });
          }
        });
      }

      if (matchingTiles.length > 0) {
        const topMatch = matchingTiles[0];
        console.log(`🎯 [AndroidRailsFetcher] Found matching rail "${topMatch.railTitle}" at index ${topMatch.railIndex}`);
        console.log(`🎯 [AndroidRailsFetcher] Calculated tile index for "${rawPage}" page: ${topMatch.tileIndex} (Global Index: ${topMatch.globalTileIndex}, Sport Index: ${topMatch.sportTileIndex})`);
      } else {
        console.log(`ℹ️ [AndroidRailsFetcher] No direct match found in backend Rail Router API for target entitlement/title "${targetEntitlement || targetTitle}"`);
      }

      return {
        matchingTiles,
        totalRailsCaptured: rawRailDescriptors.length,
        rawRailsCount: rawRailDescriptors.length,
      };
    } catch (err: any) {
      console.log(`⚠️ [AndroidRailsFetcher] Failed to fetch backend Rail Router API: ${err?.message || err}`);
      return { matchingTiles: [], totalRailsCaptured: 0 };
    }
  }
}
