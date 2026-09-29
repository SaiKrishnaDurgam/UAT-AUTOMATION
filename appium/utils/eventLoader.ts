import fs from "fs";
import path from "path";

// ── Full event config interface matching config/events/*.json ────────────
export interface EventConfig {
  eventKey: string;
  PPV_NAME: string;
  PPV_DISPLAY_NAME?: string;
  PPV_SURFACING_NAME?: string;
  SPORT?: string;
  PPV_TYPE?: string;
  global: {
    [key: string]: any;
    PPV_DATE?: string;      // "Sun 26th Jul at 00:30"
    PPV_TIME?: string;      // "00:30"
    PPV_UTC_DATE?: string;
    PPV_DESCRIPTION?: string;
    PPV_PROMOTER?: string;
    PPV_ENTITLEMENT_ID?: string;
    PPV_LOCATION?: string;
    BOXING_BANNER_DATE?: string;
    LANDING_BANNER_DATE?: string;
    BOXING_BANNER_SUBTITLE?: string;
    BOXING_UPCOMING_DATE?: string;
    LANDING_DONT_MISS_DATE?: string;
    PPV_PAGE_DATE?: string;
    PPV_CARD_TITLE?: string;
    PPV_CARD_DESCRIPTION?: string;
    BANNER_DESCRIPTION?: string;
    BUNDLE_NAME?: string;
    BUNDLE_DESCRIPTION?: string;
    BUNDLE_SAVE_BADGE?: string;
    BUNDLE_DISCOUNT?: string;
    BUNDLE_FIGHT_COUNT?: string;
    BUNDLE_SECTION_TITLE?: string;
    BUNDLE_SECTION_SUBTITLE?: string;
    BUNDLE_PPV_CARD_DESCRIPTION?: string;
    BUNDLE_PPV1_NAME?: string;
    BUNDLE_PPV1_FULL_NAME?: string;
    BUNDLE_PPV1_DATE?: string;
    BUNDLE_PPV1_LANDING_DATE?: string;
    BUNDLE_PPV2_NAME?: string;
    BUNDLE_PPV2_FULL_NAME?: string;
    BUNDLE_PPV2_DATE?: string;
    BUNDLE_PPV2_LANDING_DATE?: string;
  };
  regions?: {
    [region: string]: {
      [key: string]: any;
    };
  };
  variants?: {
    [variant: string]: {
      detection: string;
      ppvSelector?: string;
      ctaText?: string;
    };
  };
  pages?: {
    [page: string]: {
      detection: string;
    };
  };
}

// ── Parsed date info extracted from PPV_DATE string ─────────────────────
export interface ParsedPPVDate {
  day: number;
  month: string;   // short month name, e.g. "Jul"
  monthIndex: number; // 0-based month index (0=Jan, 6=Jul, etc.)
  time: string;    // e.g. "00:30"
}

// Month name → index mapping (case-insensitive)
const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse a PPV_DATE string like "Sun 26th Jul at 00:30" into structured parts.
 */
export function parsePPVDate(ppvDate: string): ParsedPPVDate {
  // Normalise ordinal suffixes: 26th → 26, 1st → 1, 2nd → 2, 3rd → 3
  const normalised = ppvDate.replace(/(\d+)(st|nd|rd|th)/gi, "$1");

  // Match patterns:
  //   "Sun 26 Jul at 00:30"    (weekday day month ... time)
  //   "26 Jul"                 (day month)
  const fullMatch = normalised.match(
    /(?:[a-z]+\s+)?(\d{1,2})\s+([a-z]+)\s+.*?(\d{1,2}:\d{2})/i
  );
  const dayMonthMatch = normalised.match(
    /(?:[a-z]+\s+)?(\d{1,2})\s+([a-z]+)/i
  );

  let day: number;
  let monthStr: string;
  let time: string;

  if (fullMatch) {
    day = parseInt(fullMatch[1], 10);
    monthStr = fullMatch[2];
    time = fullMatch[3];
  } else if (dayMonthMatch) {
    day = parseInt(dayMonthMatch[1], 10);
    monthStr = dayMonthMatch[2];
    time = "";
  } else {
    throw new Error(
      `Cannot parse PPV_DATE string: "${ppvDate}". Expected format like "Sun 26th Jul at 00:30".`
    );
  }

  const monthLower = monthStr.toLowerCase();
  const monthIndex = MONTH_MAP[monthLower];

  if (monthIndex === undefined) {
    throw new Error(
      `Unknown month "${monthStr}" in PPV_DATE: "${ppvDate}".`
    );
  }

  // Capitalise first letter for nice display
  const month = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();

  return { day, month, monthIndex, time };
}

/**
 * Load and parse an event config JSON from config/events/.
 * Reads PPV_CONFIG to determine which file. PPV_EVENT is accepted as a
 * backwards-compatible alias because it is used by existing mobile commands.
 */
export function loadEventConfig(): EventConfig {
  const fileName = process.env.PPV_CONFIG || process.env.PPV_EVENT;

  // Keep one canonical variable for downstream specs that read PPV_CONFIG
  // directly after this loader has run.
  if (!process.env.PPV_CONFIG && process.env.PPV_EVENT) {
    process.env.PPV_CONFIG = process.env.PPV_EVENT.endsWith('.json')
      ? process.env.PPV_EVENT
      : `${process.env.PPV_EVENT}.json`;
  }

  if (!fileName) {
    // Backward compatibility: default to ppv_t_joshua_prenga.json
    // so existing invocations without PPV_CONFIG (e.g. with just PPV_NAME="Joshua")
    // continue to work without changes.
    const defaultConfig = 'ppv_t_joshua_prenga.json';
    console.log(`ℹ️  PPV_CONFIG not set — defaulting to ${defaultConfig}`);
    process.env.PPV_CONFIG = defaultConfig;
    return loadEventConfig();
  }

  const normalizedFileName = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
  const filePath = path.resolve(__dirname, "../../config/events", normalizedFileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Event config not found: ${normalizedFileName} (looked at ${filePath})`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const config: EventConfig = JSON.parse(raw);

  if (!config.PPV_NAME) {
    throw new Error(`Event config "${normalizedFileName}" is missing required field "PPV_NAME".`);
  }
  if (!config.global) {
    throw new Error(`Event config "${normalizedFileName}" is missing required "global" block.`);
  }
  const regions = Object.values(config.regions || {});
  const hasDate = Boolean(config.global.PPV_UTC_DATE || config.global.PPV_DATE || regions.some((region: any) => region.PPV_DATE));
  if (!hasDate) {
    throw new Error(`Event config "${normalizedFileName}" is missing "PPV_UTC_DATE" or "PPV_DATE" in global/regions.`);
  }
  const hasTime = Boolean(config.global.PPV_UTC_DATE || config.global.PPV_TIME || regions.some((region: any) => region.PPV_TIME));
  if (!hasTime) {
    throw new Error(`Event config "${normalizedFileName}" is missing "PPV_UTC_DATE" or "PPV_TIME" in global/regions.`);
  }

  return config;
}
