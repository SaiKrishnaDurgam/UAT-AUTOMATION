export function compare(
  actual: string,
  expected: string,
  type?: string
): boolean {
  if (!expected) {
    // Empty expected: pass only if actual is also empty or N/A
    const aTrimmed = actual.trim();
    return aTrimmed === '' || aTrimmed.toUpperCase() === 'N/A';
  }

  // ── N/A expected ───────────────────────────────────────────────
  if (expected.trim().toUpperCase() === 'N/A') {
    return actual.trim().toUpperCase() === 'N/A';
  }

  const norm = (s: string) =>
    s.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0]/g, '')
      .replace(/R\$|[£$€₹]|\b(?:AED|kr)\s?/g, '')
      .replace(/a\.\s*m\./gi, 'am')
      .replace(/p\.\s*m\./gi, 'pm')
      .replace(/'/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/"/gi, '"')
      .replace(/&/gi, '&')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4"'\u201C\u201D\u201E\u201F\u2033]/g, "'")
      .replace(/\bppv\b/gi, '')
      .replace(/[\-–—\u2014\u2013:]/g, ' ')
      .replace(/\s*\/\s*/g, ' / ')
      .replace(/[•·]/g, ' ').replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');

  const a = norm(actual);
  const e = norm(expected);
  const isCloseLength = (extra = 40, multiplier = 3) =>
    actual.length <= Math.max(expected.length + extra, expected.length * multiplier);

  if (a === e) return true;
  if (a.replace(/\.$/, '') === e.replace(/\.$/, '')) return true;

  // ── Line-clamped / truncated description tolerance (e.g. mobile CSS truncation) ──
  if ((e.startsWith(a) || a.startsWith(e)) && (a.length >= 35 || e.length >= 35)) {
    return true;
  }

  // ── Price duplication check ─────────────────────────────────────
  const priceRegex = /\d+(?:\.\d{2})?/;
  const expectedPrices = e.match(new RegExp(priceRegex.source, 'g')) || [];
  const actualPrices = a.match(new RegExp(priceRegex.source, 'g')) || [];
  if (expectedPrices.length === 1 && actualPrices.length > 1) {
    const singleExpected = expectedPrices[0];
    // Only flag duplication for values that look like actual prices (contain a decimal)
    // to avoid false positives from event numbers like "UFC 330"
    if (singleExpected.includes('.')) {
      const occurrences = actualPrices.filter(p => p === singleExpected).length;
      if (occurrences > 1) {
        console.log(`❌ [Compare] Price duplication detected: "${singleExpected}" appears ${occurrences} times in actual "${actual}"`);
        return false;
      }
    }
  }

  // ── Yes/No ─────────────────────────────────────────────────────
  if (e === 'yes') return ['yes', 'visible', 'present', 'checked', 'selected'].includes(a) || actual === 'Yes';
  if (e === 'no') return a === 'no' || actual === 'No';

  // ── Gold ───────────────────────────────────────────────────────
  if (e === 'gold') return a === 'gold' || actual === 'Gold';

  // ── Pipe-separated multiple valid values ───────────────────────
  if (expected.includes('|')) {
    const options = expected.split('|');
    const actualIsTimedWatchLive = /\bwatch\s+live\b/i.test(actual) &&
      /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\b/i.test(actual);
    // A time-bearing WATCH LIVE label must not match a date-only candidate
    // such as "WATCH LIVE Sunday". Retain those candidates for labels that
    // genuinely omit a time (for example, a live-status surface).
    const candidates = actualIsTimedWatchLive
      ? options.filter(opt => /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\b/i.test(opt))
      : options;
    return (candidates.length ? candidates : options).some(opt => compare(actual, opt.trim(), type));
  }

  // ── Type overrides ─────────────────────────────────────────────
  if (type === 'contains') return a === e;
  if (type === 'startsWith') return a.startsWith(e);

  // ── Price comparison ───────────────────────────────────────────
  const normPrice = (s: string) =>
    s.replace(/R\$|[£$€₹\s]|\b(?:AED|kr)\s?/g, '')
      .replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1')
      .trim();
  const aPrice = normPrice(actual);
  const ePrice = normPrice(expected);
  if (aPrice && ePrice && aPrice === ePrice) return true;
  const parseNumericPrice = (value: string) => {
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) return Number(value.replace(/,/g, ''));
    return /^\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(',', '.')) : null;
  };
  const actualNumericPrice = parseNumericPrice(aPrice);
  const expectedNumericPrice = parseNumericPrice(ePrice);
  if (actualNumericPrice !== null && expectedNumericPrice !== null && actualNumericPrice === expectedNumericPrice) {
    return true;
  }

  // ── Price length/unit comparison (e.g., "/ month" vs "/month") ──
  if (e.replace(/\s+/g, '') === a.replace(/\s+/g, '') && (e.startsWith('/') || e.startsWith('per'))) {
    return true;
  }

  // ── Time format tolerance (12h vs 24h: e.g. "8:00PM" vs "20:00") ──────────
  const parseTime = (val: string): { h: number; m: number } | null => {
    const clean = String(val || '').trim().toLowerCase().replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    const m = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2] || '0', 10);
    const meridiem = m[3]?.toLowerCase();
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    return { h, m: min };
  };
  const at = parseTime(actual);
  const et = parseTime(expected);
  if (at && et && at.h === et.h && at.m === et.m) {
    return true;
  }

  // ── Contains with length guard ─────────────────────────────
  // Only allow substring match for very close-length strings to avoid false positives
  // where a short expected matches inside a large page-text dump.
  if (
    a.includes(e) &&
    e.length >= 10 &&
    actual.length < expected.length * 1.5 &&
    actual.length <= expected.length + 30
  ) {
    if (a.includes('not ' + e) || a.includes('not' + e)) return false;
    return true;
  }

  // ── PPV Name: Abbreviated promotion prefix matching ─────────────
  // Config may use abbreviated names like "AEW: Forbidden Door" or "PFL: Champions"
  // but the live site displays "All Elite Wrestling Forbidden Door" or "Professional Fighters League Champions".
  // Match if the part after the colon appears in the actual text and the actual text is
  // genuinely longer (full name expansion), NOT just the colon removed.
  const expectedContainsClockTime = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\b/i.test(expected);
  const actualContainsClockTime = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?\b/i.test(actual);
  if (expected.includes(':') && !expectedContainsClockTime) {
    const beforeColon = norm(expected.split(':')[0].trim());
    const afterColon = norm(expected.split(':').slice(1).join(':').trim());
    // Only match if: (a) the part after colon appears in actual,
    // (b) the actual text is genuinely longer than expected (suggesting full name expansion),
    // (c) the prefix before the colon is NOT present as-is in actual (it was expanded).
    if (
      afterColon.length >= 5 &&
      a.includes(afterColon) &&
      actual.length > expected.length * 1.1 &&
      !a.includes(beforeColon + ' ' + afterColon)
    ) {
      return true;
    }
  }
  // Reverse: actual has colon, expected doesn't — only if expected is genuinely longer
  if (actual.includes(':') && !actualContainsClockTime && !expected.includes(':')) {
    const beforeColonActual = norm(actual.split(':')[0].trim());
    const afterColonActual = norm(actual.split(':').slice(1).join(':').trim());
    if (
      afterColonActual.length >= 5 &&
      e.includes(afterColonActual) &&
      expected.length > actual.length * 1.1 &&
      !e.includes(beforeColonActual + ' ' + afterColonActual)
    ) {
      return true;
    }
  }

  // ── Date flexibility ───────────────────────────────────────────
  const extractDateParts = (s: string) => {
    const months = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
    ];
    const month = months.find(m => s.toLowerCase().includes(m));
    const day = s.match(/\b(\d{1,2})(st|nd|rd|th)?\b/)?.[1];
    return { month, day };
  };

  const aParts = extractDateParts(a);
  const eParts = extractDateParts(e);

  // Date-only match: ONLY passes when NEITHER actual NOR expected contains a time.
  // If the actual has time info (e.g. "25 JUL 6:00PM") but expected doesn't
  // (e.g. "25 July"), this must FAIL — the expected value in the Excel sheet
  // is incomplete and needs to be updated to include the time.
  const expectedHasTime = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\.?\b/i.test(expected);
  const actualHasTime   = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\.?\b/i.test(actual);
  if (
    aParts.month && eParts.month &&
    aParts.day   && eParts.day   &&
    aParts.month === eParts.month &&
    aParts.day   === eParts.day &&
    !expectedHasTime && !actualHasTime
  ) return true;

  // ── Time match flexibility ─────────────────────────────────────
  // Helper to convert time string (12-hour or 24-hour) to minutes since midnight
  const parseToMinutes = (str: string): number | null => {
    const normalizedStr = str.replace(/a\.\s*m\./gi, 'am').replace(/p\.\s*m\./gi, 'pm');
    const m12 = normalizedStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (m12) {
      let h = parseInt(m12[1], 10);
      const m = parseInt(m12[2], 10);
      const period = m12[3].toLowerCase();
      if (period === 'pm' && h < 12) h += 12;
      if (period === 'am' && h === 12) h = 0;
      return h * 60 + m;
    }
    const m24 = normalizedStr.match(/(\d{1,2}):(\d{2})/);
    if (m24) {
      const h = parseInt(m24[1], 10);
      const m = parseInt(m24[2], 10);
      if (h >= 0 && h < 24 && m >= 0 && m < 60) {
        return h * 60 + m;
      }
    }
    return null;
  };

  const aTimeMinutes = parseToMinutes(actual);
  const eTimeMinutes = parseToMinutes(expected);
  const relativeLabel = (value: string) => value
    .match(/\b(today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|night))\b/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .toLowerCase() || '';
  const actualRelativeLabel = relativeLabel(actual);
  const expectedRelativeLabel = relativeLabel(expected);
  const actualHasMeridiem = /\b(?:am|pm)\b/i.test(actual);
  if (
    actualRelativeLabel &&
    actualRelativeLabel === expectedRelativeLabel &&
    !actualHasMeridiem &&
    aTimeMinutes !== null &&
    eTimeMinutes !== null &&
    eTimeMinutes >= 12 * 60 &&
    aTimeMinutes === eTimeMinutes % (12 * 60)
  ) {
    return true;
  }
  if (aTimeMinutes !== null && eTimeMinutes !== null && aTimeMinutes === eTimeMinutes) {
    const cleanTime = (s: string) => s.replace(/\d{1,2}:\d{2}\s*(?:am|pm)?/gi, '').replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim();

    // Normalize weekday names & strip date/month parts (e.g. "13th Jun", "27th Jun")
    const normalizeDayAndStripDate = (str: string) => {
      let s = norm(cleanTime(str));
      s = s.replace(/\bsaturday\b/g, 'sat')
        .replace(/\bsunday\b/g, 'sun')
        .replace(/\bmonday\b/g, 'mon')
        .replace(/\btuesday\b/g, 'tue')
        .replace(/\bwednesday\b/g, 'wed')
        .replace(/\bthursday\b/g, 'thu')
        .replace(/\bfriday\b/g, 'fri');
      // Strip month names
      s = s.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/g, '');
      // Strip day numbers like 13th, 27th, 3, etc.
      s = s.replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, '');
      // Clean up whitespace
      return s.replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim();
    };

    const aClean = normalizeDayAndStripDate(actual);
    const eClean = normalizeDayAndStripDate(expected);
    if ((aClean === eClean || aClean.includes(eClean) || eClean.includes(aClean)) && isCloseLength(25, 2)) {
      return true;
    }
  }

  // ── Time timezone / format flexibility ──────────────────────────────────
  // Both strings have time: only apply stripped-date comparison when the times
  // represent the same minute. Formatting differences are fine (e.g. "20:00"
  // vs "8:00PM", "00:30" vs "12:30AM"); any actual time difference must fail.
  if (actualHasTime && expectedHasTime) {
    const timeDiff = (aTimeMinutes !== null && eTimeMinutes !== null)
      ? Math.abs(aTimeMinutes - eTimeMinutes)
      : null;

    if (timeDiff !== null && timeDiff === 0) {
      // Strip time AND the word "at" (connector word) to get clean date portion
      const stripTime = (s: string) => s
        .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\.?\b/gi, '')
        .replace(/\bat\b/gi, '')
        .replace(/[•·]/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const aNoTime = stripTime(actual);
      const eNoTime = stripTime(expected);

      // Both strings become empty only if they contained nothing but time — fall through.
      if (aNoTime || eNoTime) {
        if (
          (norm(aNoTime) === norm(eNoTime) || norm(aNoTime).includes(norm(eNoTime)) || norm(eNoTime).includes(norm(aNoTime))) &&
          isCloseLength(25, 2)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

type StrictDateParts = {
  day: string;
  month: string;
  weekday: string;
  minutes: number | null;
  hasDate: boolean;
  hasWeekday: boolean;
  hasTime: boolean;
};

function cleanStrictDateText(value: string): string {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0]/g, ' ')
    .replace(/a\.\s*m\.?/gi, 'am')
    .replace(/p\.\s*m\.?/gi, 'pm')
    .replace(/[,\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseStrictTime(value: string): number | null {
  const match = cleanStrictDateText(value).match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const marker = (match[3] || '').toLowerCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes > 59) return null;
  if (marker === 'pm' && hours < 12) hours += 12;
  if (marker === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23) return null;

  return hours * 60 + minutes;
}

function parseStrictDateParts(value: string): StrictDateParts {
  const clean = cleanStrictDateText(value);
  const weekdays: Array<[string, string]> = [
    ['sun', 'sun(?:day)?'],
    ['mon', 'mon(?:day)?'],
    ['tue', 'tue(?:s(?:day)?)?'],
    ['wed', 'wed(?:nesday)?'],
    ['thu', 'thu(?:r(?:sday)?)?'],
    ['fri', 'fri(?:day)?'],
    ['sat', 'sat(?:urday)?'],
  ];
  const months: Array<[string, string]> = [
    ['jan', 'jan(?:uary)?'],
    ['feb', 'feb(?:ruary)?'],
    ['mar', 'mar(?:ch)?'],
    ['apr', 'apr(?:il)?'],
    ['may', 'may'],
    ['jun', 'jun(?:e)?'],
    ['jul', 'jul(?:y)?'],
    ['aug', 'aug(?:ust)?'],
    ['sep', 'sep(?:t(?:ember)?)?'],
    ['oct', 'oct(?:ober)?'],
    ['nov', 'nov(?:ember)?'],
    ['dec', 'dec(?:ember)?'],
  ];

  const weekday = weekdays.find(([, pattern]) => new RegExp(`\\b${pattern}\\b`, 'i').test(clean))?.[0] || '';
  const monthMatch = months.find(([, pattern]) => new RegExp(`\\b${pattern}\\b`, 'i').test(clean));
  const month = monthMatch?.[0] || '';
  let day = '';

  if (monthMatch) {
    const monthPattern = monthMatch[1];
    const dayBeforeMonth = clean.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}\\b`, 'i'));
    const dayAfterMonth = clean.match(new RegExp(`\\b${monthPattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
    day = (dayBeforeMonth?.[1] || dayAfterMonth?.[1] || '').replace(/^0+/, '') || '';
  }

  const minutes = parseStrictTime(clean);

  return {
    day,
    month,
    weekday,
    minutes,
    hasDate: Boolean(day && month),
    hasWeekday: Boolean(weekday),
    hasTime: minutes !== null,
  };
}

function compareSingleStrictDateText(actual: string, expected: string): boolean {
  const actualClean = cleanStrictDateText(actual);
  const expectedClean = cleanStrictDateText(expected);
  if (!expectedClean) return !actualClean;
  if (!actualClean) return false;
  if (actualClean === expectedClean) return true;

  const actualParts = parseStrictDateParts(actualClean);
  const expectedParts = parseStrictDateParts(expectedClean);

  if (actualParts.hasDate || expectedParts.hasDate) {
    if (!actualParts.hasDate || !expectedParts.hasDate) return false;
    if (actualParts.day !== expectedParts.day || actualParts.month !== expectedParts.month) return false;
  }

  if (actualParts.hasWeekday || expectedParts.hasWeekday) {
    if (!actualParts.hasWeekday || !expectedParts.hasWeekday) return false;
    if (actualParts.weekday !== expectedParts.weekday) return false;
  }

  if (actualParts.hasTime || expectedParts.hasTime) {
    if (!actualParts.hasTime || !expectedParts.hasTime) return false;
    if (actualParts.minutes !== expectedParts.minutes) return false;
  }

  return (actualParts.hasDate || actualParts.hasWeekday || actualParts.hasTime) &&
    (expectedParts.hasDate || expectedParts.hasWeekday || expectedParts.hasTime);
}

export function getStrictPpvDateMatch(actual: string, expected: string): string {
  const actualClean = cleanStrictDateText(actual);
  const actualHasMeridiem = /\b(?:am|pm)\b/i.test(actualClean);
  const options = String(expected || '')
    .split('|')
    .map(option => option.trim())
    .filter(Boolean);
  const matches = options.filter(option => compareSingleStrictDateText(actual, option));

  if (!matches.length) return '';

  return matches
    .map(option => {
      const optionClean = cleanStrictDateText(option);
      const optionHasMeridiem = /\b(?:am|pm)\b/i.test(optionClean);
      const exactScore = actualClean === optionClean ? 100 : 0;
      const meridiemScore = actualHasMeridiem === optionHasMeridiem ? 25 : 0;
      const lengthScore = -Math.abs(actualClean.length - optionClean.length);
      return { option, score: exactScore + meridiemScore + lengthScore };
    })
    .sort((a, b) => b.score - a.score)[0].option;
}

export function compareStrictPpvDate(actual: string, expected: string): boolean {
  return Boolean(getStrictPpvDateMatch(actual, expected));
}
