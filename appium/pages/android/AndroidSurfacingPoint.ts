import fs from 'fs';
import path from 'path';

export type AndroidSurface = 'PPV Banner' | 'PPV Tile' | 'PPV Popup';

export interface AndroidSurfacingPointConfig {
  source: string;
  page: string;
  endPage: string;
  surface?: AndroidSurface;
  validationSheet?: string;
  supportedUserTypes?: string[];
  defaultSignup?: boolean;
  copyUrlFromPaywall?: boolean;
  noPpvClick?: boolean;
  tileEntitlement?: string;
}

export type AndroidSurfacingPointMap = Record<string, AndroidSurfacingPointConfig>;

let cachedConfig: AndroidSurfacingPointMap | null = null;

export function loadAndroidSurfacingPoints(): AndroidSurfacingPointMap {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(__dirname, '../../config/surfacingpoint.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  cachedConfig = JSON.parse(raw);
  return cachedConfig as AndroidSurfacingPointMap;
}

export function getAndroidSurfacingPoint(source: string): AndroidSurfacingPointConfig {
  const normalizedSource = (source || '').trim().toLowerCase();
  const config = loadAndroidSurfacingPoints()[normalizedSource];
  if (config) return config;

  return {
    source: normalizedSource,
    page: 'fallback',
    endPage: 'payment',
  };
}

export function getAndroidValidationSheet(source: string, surface: AndroidSurface): string {
  const normalizedSource = (source || '').trim().toLowerCase();
  const config = getAndroidSurfacingPoint(source);

  // Map to Android-specific sheets based on source and surface
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
