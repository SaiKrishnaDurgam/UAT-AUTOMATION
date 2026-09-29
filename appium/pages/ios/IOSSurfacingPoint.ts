import fs from 'fs';
import path from 'path';

export type IOSSurface = 'PPV Banner' | 'PPV Tile' | 'PPV Popup';

/**
 * Describes how Safari must re-enter the DAZN web experience after iOS opens
 * the external-website confirmation.  This is deliberately separate from the
 * native source: iOS opens Safari at dazn.com home, not at the native paywall
 * or a reusable checkout URL.
 */
export interface IOSBrowserReentry {
  /** The source to exercise once Safari has loaded DAZN web. */
  webSource: string;
  /** The known entry page after the iOS external-website confirmation. */
  entry: 'safari-home' | 'contextual-checkout';
  /** False prevents an unverified source from silently taking a wrong route. */
  supported: boolean;
}

export interface IOSSurfacingPointConfig {
  source: string;
  page: string;
  endPage: string;
  surface?: IOSSurface;
  validationSheet?: string;
  supportedUserTypes?: string[];
  defaultSignup?: boolean;
  copyUrlFromPaywall?: boolean;
  tileEntitlement?: string;
  noPpvClick?: boolean;
}

export type IOSSurfacingPointMap = Record<string, IOSSurfacingPointConfig>;

let cachedConfig: IOSSurfacingPointMap | null = null;

export function loadIOSSurfacingPoints(): IOSSurfacingPointMap {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(__dirname, '../../config/surfacingpoint.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  cachedConfig = JSON.parse(raw);
  return cachedConfig as IOSSurfacingPointMap;
}

export function getIOSSurfacingPoint(source: string): IOSSurfacingPointConfig {
  const normalizedSource = (source || '').trim().toLowerCase();
  const config = loadIOSSurfacingPoints()[normalizedSource];
  if (config) return config;

  return {
    source: normalizedSource,
    page: 'fallback',
    endPage: 'payment',
  };
}

/**
 * Most native sources land Safari at dazn.com/welcome after the iOS App Store
 * confirmation sheet. Home popup is different: its Buy Now CTA must preserve
 * the captured contextual checkout URL rather than re-entering through Welcome.
 *
 * Add a source name here once its native-app → Safari handoff has been confirmed
 * on device.  Any source NOT listed returns supported: false so an unverified
 * source cannot silently follow the wrong path.
 */
export function getIOSBrowserReentry(source: string): IOSBrowserReentry {
  const normalizedSource = (source || '').trim().toLowerCase();

  const supportedSources = new Set([
    'search',
    'landing-page-banner',
    'home-page-banner',
    'home-boxing-banner',
    'home-boxing-upcoming',
    'home-boxing-tile',
    'home-page-tile',
    'home-page-dont-miss',
    'home-page-popup',
    'schedule',
    'home-page-dazntile',
    'home-page-subscribe',
    'subscribe-without-pay-per-view',
  ]);



  if (supportedSources.has(normalizedSource)) {
    return { webSource: 'welcome-page-tile', entry: 'safari-home', supported: true };
  }

  return { webSource: normalizedSource, entry: 'safari-home', supported: false };
}

/**
 * Returns the existing Android-named Excel sheet used to validate the native
 * iOS banner/tile.  The workbook is shared intentionally; the name is kept as
 * "Andriod_*" because that is how the existing Excel file is authored.
 */
export function getIOSValidationSheet(source: string, surface: IOSSurface): string {
  const normalizedSource = (source || '').trim().toLowerCase();
  const config = getIOSSurfacingPoint(source);

  // The excel sheets are named 'Andriod_...' (with spelling deviation).
  // We use the same sheets for validation on iOS to reuse the existing test data.
  if (surface === 'PPV Banner') {
    if (normalizedSource === 'landing-page-banner') return 'Andriod_Landing_Page';
    if (normalizedSource === 'home-page-banner') return 'Andriod_Home_Page';
    if (normalizedSource === 'home-boxing-banner') return 'Andriod_Home_Boxing_Page';
  }
  if (surface === 'PPV Tile') {
    if (normalizedSource === 'home-boxing-upcoming' || normalizedSource === 'home-boxing-tile') return 'Andriod_Home_Boxing_Page';
    if (normalizedSource === 'schedule') return 'Andriod_Schedule_Page';
    if (normalizedSource === 'search') return 'Andriod_Search_Page';
    if (normalizedSource === 'home-page-tile' || normalizedSource === 'home-page-dont-miss' || normalizedSource === 'home-page-popup') return 'Andriod_Home_Page';
  }
  if (surface === 'PPV Popup') {
    if (normalizedSource === 'home-page-popup') return 'Andriod_Home_Page';
  }

  if (config.surface === surface && config.validationSheet) {
    return config.validationSheet;
  }

  return '';
}
