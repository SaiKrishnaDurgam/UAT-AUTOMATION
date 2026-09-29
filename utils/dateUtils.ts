export function getNow(): Date {
  // Use the runtime machine/device timezone.
  return new Date();
}

export function getNowIST(): Date {
  // Returns current time expressed as a Date object in IST (UTC+5:30)
  // Works correctly on any server timezone including UTC CI environments
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30
  return new Date(utcMs + istOffsetMs);
}

function getDatePartsInTimeZone(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

export function getIOSISTDateTimeCandidates(utcDate: string, timeZone = 'Asia/Kolkata'): string {
  if (!utcDate || Number.isNaN(new Date(utcDate).getTime())) return '';
  const parts = getDatePartsInTimeZone(new Date(utcDate), timeZone);
  const day = Number(parts.day);
  const hour24 = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const minute = parts.minute.padStart(2, '0');
  const time24 = `${String(hour24).padStart(2, '0')}:${minute}`;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  const time12 = `${hour12}:${minute}${ampm}`;
  const time12Spaced = `${hour12}:${minute} ${ampm}`;
  const monthShort = parts.month.slice(0, 3);
  const weekdayShort = parts.weekday.slice(0, 3);
  const dayOrdinal = `${day}${ordinal(day)}`;
  const candidates = new Set<string>();

  for (const time of [time24, time12, time12Spaced, time12.toLowerCase(), time12Spaced.toLowerCase()]) {
    candidates.add(`${day} ${monthShort.toUpperCase()} ${time.toUpperCase()}`);
    candidates.add(`${day} ${monthShort} ${time}`);
    candidates.add(`${dayOrdinal} ${monthShort} at ${time}`);
    candidates.add(`${weekdayShort} ${dayOrdinal} ${monthShort} at ${time}`);
    candidates.add(`${parts.weekday} ${dayOrdinal} ${parts.month} at ${time}`);
    candidates.add(`${weekdayShort} ${day} ${monthShort} at ${time}`);
    candidates.add(`${parts.weekday} ${day} ${parts.month} at ${time}`);
    candidates.add(`${parts.weekday} at ${time}`);
    candidates.add(`${weekdayShort.toUpperCase()} ${day} ${monthShort.toUpperCase()} ${time.toUpperCase()}`);
  }

  return Array.from(candidates).join('|');
}

export function getIOSISTDateCandidates(utcDate: string, timeZone = 'Asia/Kolkata'): string {
  if (!utcDate || Number.isNaN(new Date(utcDate).getTime())) return '';
  const parts = getDatePartsInTimeZone(new Date(utcDate), timeZone);
  const day = Number(parts.day);
  const monthShort = parts.month.slice(0, 3);
  const weekdayShort = parts.weekday.slice(0, 3);
  const dayOrdinal = `${day}${ordinal(day)}`;
  return [
    `${day} ${monthShort}`,
    `${monthShort} ${day}`,
    `${parts.month} ${day}`,
    `${dayOrdinal} ${monthShort}`,
    `${weekdayShort} ${dayOrdinal} ${monthShort}`,
    `${parts.weekday} ${dayOrdinal} ${parts.month}`,
    `${day} ${monthShort.toUpperCase()}`,
    `${monthShort.toUpperCase()} ${day}`,
  ].join('|');
}

export function getIOSISTScheduleFieldCandidates(utcDate: string, fieldName: string, timeZone = 'Asia/Kolkata'): string {
  if (!utcDate || Number.isNaN(new Date(utcDate).getTime())) return '';
  const parts = getDatePartsInTimeZone(new Date(utcDate), timeZone);
  const key = String(fieldName || '').trim().toLowerCase();
  const day = Number(parts.day);
  const hour24 = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const minute = parts.minute.padStart(2, '0');
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  if (key === 'day') return `${parts.weekday.slice(0, 3).toUpperCase()}|${parts.weekday.slice(0, 3)}|${parts.weekday}`;
  if (key === 'month') return `${parts.month.slice(0, 3).toUpperCase()}|${parts.month.slice(0, 3)}|${parts.month}`;
  if (key === 'date') return `${day}|${getIOSISTDateCandidates(utcDate, timeZone)}`;
  if (key === 'time') return `${String(hour24).padStart(2, '0')}:${minute}|${hour12}:${minute}${ampm}|${hour12}:${minute} ${ampm}|${hour12}:${minute}${ampm.toLowerCase()}|${hour12}:${minute} ${ampm.toLowerCase()}`;
  return getIOSISTDateTimeCandidates(utcDate, timeZone);
}

/**
 * Returns the current date/time expressed in the timezone of the given DAZN region.
 * Uses Intl.DateTimeFormat so it respects DST automatically (e.g. BST vs GMT for GB).
 *
 * Supported regions: GB, US, DE, IT, ES, FR, CA, AU, JP.
 * Falls back to 'Europe/London' for unknown regions.
 */
// Single source of truth for region -> IANA timezone, shared by getNowForRegion()
// and the PPV dynamic date/time resolver below. Keep in sync with the device
// timezone map in appium/config/wdio.android.conf.ts (which sets the physical
// TV's clock before each run) so computed candidates match what's on screen.
export const PPV_REGION_TIMEZONE_MAP: Record<string, string> = {
  GB: 'Europe/London',
  UK: 'Europe/London',
  IE: 'Europe/Dublin',
  US: 'America/New_York',
  AE: 'Asia/Dubai',
  UAE: 'Asia/Dubai',
  SA: 'Asia/Riyadh',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  NO: 'Europe/Oslo',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  FR: 'Europe/Paris',
  CA: 'America/Toronto',
  JP: 'Asia/Tokyo',
};

export function getNowForRegion(region?: string): Date {
  const tz = PPV_REGION_TIMEZONE_MAP[(region || process.env.DAZN_REGION || 'GB').toUpperCase()] || 'Europe/London';
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  // Construct a Date whose local fields match the wall-clock time in the target TZ
  return new Date(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    parseInt(p.hour, 10) === 24 ? 0 : parseInt(p.hour, 10),
    parseInt(p.minute, 10),
    parseInt(p.second, 10)
  );
}

export function formatNextPaymentDate(daysOffset: number): string {
  const date = getNowForRegion();
  date.setDate(date.getDate() + daysOffset);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${dd}/${mm}/${yyyy}`;
}

// ✅ New helper — adds exactly 1 calendar month
export function formatNextPaymentDateMonthly(): string {
  const date = getNowForRegion();
  date.setMonth(date.getMonth() + 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${dd}/${mm}/${yyyy}`;
}

// ✅ New helper — adds exactly 1 calendar year
export function formatNextPaymentDateYearly(): string {
  const date = getNowForRegion();
  date.setFullYear(date.getFullYear() + 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${dd}/${mm}/${yyyy}`;
}

// ── US format MM.DD.YYYY ──────────────────────────────────────

// US monthly — 1 month from today in MM.DD.YYYY
export function formatNextPaymentDateMonthlyUS(): string {
  const date = getNowForRegion('US');
  date.setMonth(date.getMonth() + 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${mm}/${dd}/${yyyy}`;
}

// US yearly — 1 year from today in MM.DD.YYYY
export function formatNextPaymentDateYearlyUS(): string {
  const date = getNowForRegion('US');
  date.setFullYear(date.getFullYear() + 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${mm}/${dd}/${yyyy}`;
}

// US offset — N days from today in MM.DD.YYYY
export function formatNextPaymentDateUS(daysOffset: number): string {
  const date = getNowForRegion('US');
  date.setDate(date.getDate() + daysOffset);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${mm}/${dd}/${yyyy}`;
}

// ── Flex Future Date — "In N days • 4 June 2026" ────────────
export function formatFlexFutureDate(daysOffset: number): string {
  const date = getNowForRegion();
  date.setDate(date.getDate() + daysOffset);

  const day = date.getDate(); // no padding
  const month = date.toLocaleString('en-GB', { month: 'long' });
  const year = date.getFullYear();

  return `In ${daysOffset} days • ${day} ${month} ${year}`;
}

// ✅ Renewal date helper — 1 year minus 1 day from today in DD/MM/YYYY
export function formatRenewalDate(): string {
  const date = getNowForRegion();
  date.setFullYear(date.getFullYear() + 1);
  date.setDate(date.getDate() - 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${dd}/${mm}/${yyyy}`;
}

// ✅ US renewal date helper — 1 year minus 1 day from today in MM/DD/YYYY
export function formatRenewalDateUS(): string {
  const date = getNowForRegion('US');
  date.setFullYear(date.getFullYear() + 1);
  date.setDate(date.getDate() - 1);

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  return `${mm}/${dd}/${yyyy}`;
}

export function parseConfigDate(configStr: string, referenceDate: Date = getNowForRegion()): Date {
  const clean = configStr
    .toLowerCase()
    .replace(/a\.\s*m\.?/g, 'am')
    .replace(/p\.\s*m\.?/g, 'pm')
    .replace(/\bat\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const fullMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  let monthIdx = -1;
  let dayNum = -1;

  for (let i = 0; i < 12; i++) {
    if (clean.includes(months[i]) || clean.includes(fullMonths[i])) {
      monthIdx = i;
      break;
    }
  }

  if (monthIdx !== -1) {
    const dayMatch = clean.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (dayMatch) {
      dayNum = parseInt(dayMatch[1], 10);
    }
  }

  let hours = 20;
  let minutes = 0;
  const timeMatch = clean.match(/(\d{1,2}):(\d{2})\s*(pm|am)?/);
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  }

  if (monthIdx !== -1 && dayNum !== -1) {
    const targetDate = new Date(referenceDate);
    targetDate.setMonth(monthIdx);
    targetDate.setDate(dayNum);
    targetDate.setHours(hours, minutes, 0, 0);
    targetDate.setFullYear(referenceDate.getFullYear());

    if (targetDate.getTime() < referenceDate.getTime() - 30 * 24 * 3600 * 1000) {
      targetDate.setFullYear(referenceDate.getFullYear() + 1);
    }
    return targetDate;
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let weekdayIdx = -1;
  for (let i = 0; i < 7; i++) {
    if (clean.includes(weekdays[i]) || clean.includes(weekdays[i].substring(0, 3))) {
      weekdayIdx = i;
      break;
    }
  }

  if (weekdayIdx !== -1) {
    const targetDate = new Date(referenceDate);
    targetDate.setHours(hours, minutes, 0, 0);

    const refDay = referenceDate.getDay();
    let daysDiff = weekdayIdx - refDay;
    if (daysDiff < 0) {
      daysDiff += 7;
    } else if (daysDiff === 0) {
      const temp = new Date(targetDate);
      if (temp.getTime() < referenceDate.getTime()) {
        daysDiff += 7;
      }
    }
    targetDate.setDate(targetDate.getDate() + daysDiff);
    return targetDate;
  }

  const fallbackDate = new Date(referenceDate);
  fallbackDate.setDate(fallbackDate.getDate() + 1);
  return fallbackDate;
}

function getDynamicDateBadgeSingle(configStr: string, referenceDate: Date = getNowForRegion()): string {
  if (configStr.toUpperCase() === 'N/A' || !configStr.trim()) {
    return configStr;
  }
  const eventDate = parseConfigDate(configStr, referenceDate);

  const refDateStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const eventDateStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const diffTime = eventDateStart.getTime() - refDateStart.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  const hours = eventDate.getHours();
  const minutes = String(eventDate.getMinutes()).padStart(2, '0');

  const time24 = `${String(hours).padStart(2, '0')}:${minutes}`;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12 || 12;
  const time12 = `${hours12}:${minutes}${ampm}`;
  const time12Spaced = `${hours12}:${minutes} ${ampm}`;
  const time12Lower = `${hours12}:${minutes}${ampm.toLowerCase()}`;
  const time12LowerSpaced = `${hours12}:${minutes} ${ampm.toLowerCase()}`;

  const times = [time24, time12, time12Spaced, time12Lower, time12LowerSpaced];

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[eventDate.getDay()];
  const fullDayName = fullDayNames[eventDate.getDay()];

  const candidates = new Set<string>();
  // Keep the configured rendering as a valid candidate.  This is important for
  // future events, whose chips continue to show an absolute date rather than a
  // relative label (and may use deliberate uppercase styling).
  candidates.add(configStr.trim());


  // Helper to add day-of-week variations
  const addDayVariations = (day: string) => {
    for (const t of times) {
      candidates.add(`${day} at ${t}`);
      candidates.add(`${day} ${t}`);
      candidates.add(`${day.toUpperCase()} at ${t}`);
      candidates.add(`${day.toUpperCase()} ${t}`);
      candidates.add(`${day.toLowerCase()} at ${t}`);
      candidates.add(`${day.toLowerCase()} ${t}`);
    }
  };

  if (diffDays === 1) {
    for (const t of times) {
      candidates.add(`Tomorrow at ${t}`);
      candidates.add(`Tomorrow ${t}`);
      candidates.add(`tomorrow at ${t}`);
      candidates.add(`tomorrow ${t}`);
      candidates.add(`TOMORROW AT ${t}`);
      candidates.add(`TOMORROW ${t}`);
      candidates.add(`Tomorrow at ${t.toUpperCase()}`);
      candidates.add(`TOMORROW AT ${t.toUpperCase()}`);
    }
    addDayVariations(dayName);
    addDayVariations(fullDayName);
  } else if (diffDays === 0) {
    for (const t of times) {
      candidates.add(`Today at ${t}`);
      candidates.add(`Today ${t}`);
      candidates.add(`today at ${t}`);
      candidates.add(`today ${t}`);
      candidates.add(`TODAY AT ${t}`);
      candidates.add(`TODAY ${t}`);
      candidates.add(`TODAY AT ${t.toUpperCase()}`);
    }
    if (hours >= 5 && hours < 12) {
      for (const t of times) {
        candidates.add(`This morning at ${t}`);
        candidates.add(`This morning ${t}`);
        candidates.add(`this morning at ${t}`);
        candidates.add(`this morning ${t}`);
        candidates.add(`THIS MORNING AT ${t.toUpperCase()}`);
      }
    }
    if (hours >= 12 && hours < 17) {
      for (const t of times) {
        candidates.add(`This afternoon at ${t}`);
        candidates.add(`this afternoon at ${t}`);
        candidates.add(`THIS AFTERNOON AT ${t}`);
        candidates.add(`THIS AFTERNOON AT ${t.toUpperCase()}`);
      }
    }
    // DAZN shows "This evening" for same-day events at 17:00+
    if (hours >= 17) {
      for (const t of times) {
        candidates.add(`This evening at ${t}`);
        candidates.add(`This evening ${t}`);
        candidates.add(`this evening at ${t}`);
        candidates.add(`this evening ${t}`);
        candidates.add(`Tonight at ${t}`);
        candidates.add(`Tonight ${t}`);
        candidates.add(`tonight at ${t}`);
        candidates.add(`tonight ${t}`);
        candidates.add(`THIS EVENING AT ${t}`);
        candidates.add(`THIS EVENING AT ${t.toUpperCase()}`);
        candidates.add(`TONIGHT AT ${t}`);
        candidates.add(`TONIGHT AT ${t.toUpperCase()}`);
      }
    }
    if (hours >= 21 || hours < 5) {
      for (const t of times) {
        candidates.add(`This night at ${t}`);
        candidates.add(`This night ${t}`);
        candidates.add(`this night at ${t}`);
        candidates.add(`this night ${t}`);
        candidates.add(`THIS NIGHT AT ${t.toUpperCase()}`);
      }
    }
    addDayVariations(dayName);
    addDayVariations(fullDayName);
  } else if (diffDays > 1 && diffDays <= 7) {
    addDayVariations(dayName);
    addDayVariations(fullDayName);
    // Also add date-format candidates (DAZN sometimes shows "29 June" even for near events)
    const dayNum = eventDate.getDate();
    const monthNames2 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fullMonthNames2 = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const mn = monthNames2[eventDate.getMonth()];
    const fmn = fullMonthNames2[eventDate.getMonth()];
    const getOrd = (d: number): string => {
      if (d >= 11 && d <= 13) return 'th';
      switch (d % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
    };
    const ord = getOrd(dayNum);
    const dateFmts = [
      `${dayNum} ${mn}`, `${dayNum} ${fmn}`,
      `${dayNum}${ord} ${mn}`, `${dayNum}${ord} ${fmn}`,
      `${mn} ${dayNum}`, `${fmn} ${dayNum}`,
      `${dayName} ${dayNum}${ord} ${mn}`, `${dayName} ${dayNum} ${mn}`,
      `${dayName} ${dayNum}${ord} ${fmn}`, `${dayName} ${dayNum} ${fmn}`,
    ];
    for (const f of dateFmts) {
      candidates.add(f);
      for (const t of times) {
        candidates.add(`${f} at ${t}`);
        candidates.add(`${f} ${t}`);
      }
    }
  } else {
    // Far date
    const dayNum = eventDate.getDate();
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fullMonthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[eventDate.getMonth()];
    const fullMonthName = fullMonthNames[eventDate.getMonth()];

    // Ordinal suffix for day number (e.g., 1st, 2nd, 3rd, 25th)
    const getOrdinal = (d: number): string => {
      if (d >= 11 && d <= 13) return 'th';
      switch (d % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
      }
    };
    const ordinal = getOrdinal(dayNum);

    const formats = [
      `${dayNum} ${monthName}`,
      `${dayNum} ${fullMonthName}`,
      `${dayNum} ${monthName.toUpperCase()}`,
      `${dayNum} ${fullMonthName.toUpperCase()}`,
      // Ordinal variants: "25th Jul", "25th July"
      `${dayNum}${ordinal} ${monthName}`,
      `${dayNum}${ordinal} ${fullMonthName}`,
      // Month-first variants: "Jul 25", "July 25" (used on landing page tiles)
      `${monthName} ${dayNum}`,
      `${fullMonthName} ${dayNum}`,
      `${monthName} ${dayNum}${ordinal}`,
      `${fullMonthName} ${dayNum}${ordinal}`,
    ];

    // Weekday-prefixed variants: "Sat 25th Jul", "Sat 25 Jul"
    const weekdayPrefixes = [dayName, fullDayName, dayName.toUpperCase(), fullDayName.toUpperCase()];
    for (const prefix of weekdayPrefixes) {
      formats.push(`${prefix} ${dayNum}${ordinal} ${monthName}`);
      formats.push(`${prefix} ${dayNum}${ordinal} ${fullMonthName}`);
      formats.push(`${prefix} ${dayNum} ${monthName}`);
      formats.push(`${prefix} ${dayNum} ${fullMonthName}`);
    }

    for (const f of formats) {
      candidates.add(f);
      for (const t of times) {
        candidates.add(`${f} at ${t}`);
        candidates.add(`${f} ${t}`);
      }
    }
  }

  return Array.from(candidates).join('|');
}

export function getDynamicDateBadge(configStr: string, referenceDate: Date = getNowForRegion()): string {
  if (!configStr) return '';
  return configStr.split('|').map(part => getDynamicDateBadgeSingle(part, referenceDate)).join('|');
}

/**
 * Same as getDynamicDateBadge but ONLY returns candidates that include
 * a time component (HH:MM). Use for "Date and Time" fields where the
 * expected value MUST include the time, not just the date.
 */
export function getDynamicDateTimeBadge(configStr: string, referenceDate: Date = getNowForRegion()): string {
  if (!configStr) return '';
  const hasExplicitTime = (value: string) =>
    /\b\d{1,2}:\d{2}\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?\b/i.test(value);
  const parts = configStr.split('|').map(part => part.trim()).filter(Boolean);
  const dateTimeParts = parts.filter(hasExplicitTime);
  const sourceParts = dateTimeParts.length ? dateTimeParts : parts;
  const allCandidates = sourceParts.map(part => getDynamicDateBadgeSingle(part, referenceDate)).join('|');
  const timePattern = /\b\d{1,2}:\d{2}\b/;
  const withTime = allCandidates.split('|').filter(c => timePattern.test(c));
  // If no candidates have time (e.g. config has no time info), fall back to all candidates
  return withTime.length > 0 ? withTime.join('|') : allCandidates;
}

export interface PpvEventDateInfo {
  // Wall-clock event date/time in the target region's timezone.
  eventDate: Date;
  // Calendar-day difference (event minus reference), DST-safe.
  diffDays: number;
  isCurrentlyLive: boolean;
}

/**
 * Resolves an event's PPV_UTC_DATE (falling back to a static banner/PPV_DATE
 * string) into a wall-clock Date in the target region's timezone, plus the
 * calendar-day difference from referenceDate. Shared by calculateDynamicPpvBannerDate
 * and TV Schedule/Paywall dynamic-date matching so there is one source of truth
 * for "how many days away is this event" across Web, mobile and TV.
 */
export function resolvePpvEventDateInfo(
  eventData: Record<string, any>,
  referenceDate?: Date,
  staticFallbackDate?: string,
): PpvEventDateInfo | null {
  if (!eventData) return null;

  const targetRegion = eventData.REGION || process.env.DAZN_REGION || 'GB';
  const refDate = referenceDate || getNowForRegion(targetRegion);
  const utcStr = eventData.PPV_UTC_DATE || eventData.global?.PPV_UTC_DATE;

  let rawEventDate: Date | null = null;
  if (utcStr) {
    rawEventDate = new Date(utcStr);
  } else if (staticFallbackDate) {
    rawEventDate = parseConfigDate(String(staticFallbackDate), refDate);
  }

  if (!rawEventDate || isNaN(rawEventDate.getTime())) return null;

  const tz = PPV_REGION_TIMEZONE_MAP[(targetRegion || 'GB').toUpperCase()] || 'Europe/London';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(rawEventDate);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;

  const eventDate = new Date(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    parseInt(p.hour, 10) === 24 ? 0 : parseInt(p.hour, 10),
    parseInt(p.minute, 10),
    parseInt(p.second, 10)
  );

  const refDateStart = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const eventDateStart = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const diffTime = eventDateStart.getTime() - refDateStart.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  // Live status window: event start to +5 hours
  const eventStartTime = rawEventDate.getTime();
  const eventEndTime = eventStartTime + (5 * 60 * 60 * 1000);
  const isCurrentlyLive = refDate.getTime() >= eventStartTime && refDate.getTime() <= eventEndTime;

  return { eventDate, diffDays, isCurrentlyLive };
}

/**
 * Dynamic PPV Banner & Event Date Resolver.
 * Evaluates event UTC date relative to referenceDate (in target region timezone)
 * and returns pipe-separated candidate strings based on exact display rules:
 * - LIVE: "LIVE|LIVE NOW|WATCH LIVE"
 * - TODAY Morning (05:00-11:59): "This morning at 14:00|Morning at 14:00"
 * - TODAY Afternoon (12:00-16:59): "This afternoon at 14:00|Afternoon at 14:00"
 * - TODAY Evening (17:00-20:59): "This evening at 19:00|Evening at 19:00"
 * - TODAY Night (21:00-04:59): "Tonight at 22:00|Night at 22:00"
 * - TOMORROW (+1 day): "Tomorrow at 14:00|Tomorrow at 2:00pm|TOMORROW AT 14:00"
 * - THIS WEEK (<= 7 days): "Sat 25th Jul at 14:00|Saturday 25 July 14:00"
 * - BEFORE ONE WEEK (> 7 days): "25th Jul at 14:00|25 July 14:00"
 */
export function calculateDynamicPpvBannerDate(
  eventData: Record<string, any>,
  pageName?: string,
  referenceDate?: Date
): string {
  if (!eventData) return '';

  const targetRegion = eventData.REGION || process.env.DAZN_REGION || 'GB';
  const refDate = referenceDate || getNowForRegion(targetRegion);

  const staticBannerDate = 
    eventData.MOBILE_BANNER_DATE_TIME || 
    eventData.global?.MOBILE_BANNER_DATE_TIME || 
    eventData.LANDING_BANNER_DATE || 
    eventData.global?.LANDING_BANNER_DATE || 
    eventData.BOXING_BANNER_DATE || 
    eventData.global?.BOXING_BANNER_DATE || 
    eventData.PPV_DATE || 
    eventData.global?.PPV_DATE;

  const dateInfo = resolvePpvEventDateInfo(eventData, refDate, staticBannerDate);
  if (!dateInfo) {
    return staticBannerDate ? String(staticBannerDate) : '';
  }

  const { eventDate, diffDays } = dateInfo;
  const hours = eventDate.getHours();
  const minutes = String(eventDate.getMinutes()).padStart(2, '0');

  const time24 = `${String(hours).padStart(2, '0')}:${minutes}`;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12 || 12;
  const time12 = `${hours12}:${minutes}${ampm}`;
  const time12Spaced = `${hours12}:${minutes} ${ampm}`;
  const time12Lower = `${hours12}:${minutes}${ampm.toLowerCase()}`;
  const time12LowerSpaced = `${hours12}:${minutes} ${ampm.toLowerCase()}`;

  const times = [time24, time12, time12Spaced, time12Lower, time12LowerSpaced];
  const candidates = new Set<string>();

  const isCurrentlyLive = dateInfo.isCurrentlyLive;

  if (isCurrentlyLive) {
    candidates.add('LIVE');
    candidates.add('LIVE NOW');
    candidates.add('WATCH LIVE');
    candidates.add('Live');
    candidates.add('Live Now');
    candidates.add('Watch Live');
  }

  if (diffDays === 0) {
    // Event is TODAY
    candidates.add('LIVE');
    candidates.add('LIVE NOW');
    candidates.add('WATCH LIVE');
    candidates.add('Live');
    candidates.add('Live Now');
    candidates.add('Watch Live');

    if (hours >= 5 && hours <= 11) {
      for (const t of times) {
        candidates.add(`This morning at ${t}`);
        candidates.add(`THIS MORNING AT ${t.toUpperCase()}`);
        candidates.add(`Morning at ${t}`);
        candidates.add(`MORNING AT ${t.toUpperCase()}`);
        candidates.add(`this morning at ${t}`);
      }
    } else if (hours >= 12 && hours <= 16) {
      for (const t of times) {
        candidates.add(`This afternoon at ${t}`);
        candidates.add(`THIS AFTERNOON AT ${t.toUpperCase()}`);
        candidates.add(`Afternoon at ${t}`);
        candidates.add(`AFTERNOON AT ${t.toUpperCase()}`);
        candidates.add(`this afternoon at ${t}`);
      }
    } else if (hours >= 17 && hours <= 20) {
      for (const t of times) {
        candidates.add(`This evening at ${t}`);
        candidates.add(`THIS EVENING AT ${t.toUpperCase()}`);
        candidates.add(`Evening at ${t}`);
        candidates.add(`EVENING AT ${t.toUpperCase()}`);
        candidates.add(`Tonight at ${t}`);
      }
    } else {
      for (const t of times) {
        candidates.add(`Tonight at ${t}`);
        candidates.add(`TONIGHT AT ${t.toUpperCase()}`);
        candidates.add(`Night at ${t}`);
        candidates.add(`NIGHT AT ${t.toUpperCase()}`);
        candidates.add(`This night at ${t}`);
        candidates.add(`THIS NIGHT AT ${t.toUpperCase()}`);
        candidates.add(`this night at ${t}`);
      }
    }

    for (const t of times) {
      candidates.add(`Today at ${t}`);
      candidates.add(`TODAY AT ${t.toUpperCase()}`);
      candidates.add(`Today ${t}`);
      candidates.add(`TODAY ${t.toUpperCase()}`);
    }
  } else if (diffDays === 1) {
    // Event is TOMORROW
    for (const t of times) {
      candidates.add(`Tomorrow at ${t}`);
      candidates.add(`TOMORROW AT ${t.toUpperCase()}`);
      candidates.add(`Tomorrow ${t}`);
      candidates.add(`TOMORROW ${t.toUpperCase()}`);
      candidates.add(`tomorrow at ${t}`);
      candidates.add(`tomorrow ${t}`);
    }
  }

  // Always include standard full date & time candidates for eventDate
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fullMonthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const dayNum = eventDate.getDate();
  const getOrd = (d: number): string => {
    if (d >= 11 && d <= 13) return 'th';
    switch (d % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
  };
  const ord = getOrd(dayNum);
  const dayName = dayNames[eventDate.getDay()];
  const fullDayName = fullDayNames[eventDate.getDay()];
  const mn = monthNames[eventDate.getMonth()];
  const fmn = fullMonthNames[eventDate.getMonth()];

  for (const t of times) {
    candidates.add(`${dayName} ${dayNum}${ord} ${mn} at ${t}`);
    candidates.add(`${dayName.toUpperCase()} ${dayNum}${ord} ${mn.toUpperCase()} AT ${t.toUpperCase()}`);
    candidates.add(`${dayName} ${dayNum} ${mn} at ${t}`);
    candidates.add(`${dayName.toUpperCase()} ${dayNum} ${mn.toUpperCase()} AT ${t.toUpperCase()}`);
    candidates.add(`${fullDayName} ${dayNum}${ord} ${fmn} at ${t}`);
    candidates.add(`${dayNum}${ord} ${mn} at ${t}`);
    candidates.add(`${dayNum}${ord} ${mn.toUpperCase()} AT ${t.toUpperCase()}`);
    candidates.add(`${dayNum} ${mn} at ${t}`);
    candidates.add(`${dayNum} ${mn.toUpperCase()} AT ${t.toUpperCase()}`);
  }

  if (staticBannerDate) {
    const standardCandidates = getDynamicDateBadgeSingle(String(staticBannerDate), refDate);
    if (standardCandidates) {
      standardCandidates.split('|').forEach(c => candidates.add(c));
    }
  }

  return Array.from(candidates).join('|');
}
