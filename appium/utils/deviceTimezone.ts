/**
 * Recomputes mobile date/time fields from PPV_UTC_DATE using the system's
 * actual timezone — not the region's timezone.
 *
 * Why: On web, Playwright fakes the browser timezone via timezoneId. On iOS
 * real devices, Safari uses the device's system timezone (e.g. IST if the
 * phone is in India). The hardcoded region values (e.g. "17:00" for GB)
 * would mismatch. This function recomputes every mobile date/time token
 * to match whatever timezone the device is actually running in.
 *
 * The UTC date is stored in the event JSON as `PPV_UTC_DATE` (ISO 8601).
 * All date/time fields are regenerated from it using Intl.DateTimeFormat
 * in the system's local timezone.
 */

/**
 * Given eventData with PPV_UTC_DATE, overwrite all date/time tokens to match
 * the local timezone of the machine running the test.
 */
export function recomputeMobileDatesForDeviceTimezone(
  eventData: Record<string, any>,
): void {
  const utcStr = eventData.PPV_UTC_DATE || eventData.ppvUtcDate;
  if (!utcStr) {
    console.warn('⚠️ [tz] No PPV_UTC_DATE found — cannot recompute dates for device timezone.');
    return;
  }

  const utc = new Date(utcStr);
  if (isNaN(utc.getTime())) {
    console.warn(`⚠️ [tz] Invalid PPV_UTC_DATE: "${utcStr}"`);
    return;
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  const pad = (n: number): string => String(n).padStart(2, '0');

  // Short day names: "Mon", "Tue", ...
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const monthShort = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const ordinal = (d: number): string => {
    if (d >= 11 && d <= 13) return `${d}th`;
    switch (d % 10) {
      case 1: return `${d}st`;
      case 2: return `${d}nd`;
      case 3: return `${d}rd`;
      default: return `${d}th`;
    }
  };

  // Convert UTC → device-local date/time
  const day = utc.getDay();           // 0-6
  const date = utc.getDate();         // 1-31
  const month = utc.getMonth();       // 0-11
  const hours24 = utc.getHours();     // 0-23
  const minutes = utc.getMinutes();
  const hours12 = hours24 % 12 || 12;
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const ampmLower = ampm.toLowerCase();

  // ── Format strings matching the event JSON conventions ──────────────
  // "29 AUG 5:00 PM" → MOBILE_PPV_DATE
  const mobilePpvDate = `${date} ${monthShort[month]} ${hours12}:${pad(minutes)} ${ampm}`;

  // "Sat 29th Aug at 17:00" → MOBILE_BANNER_DATE_TIME
  const bannerDateTime = `${dayNames[day]} ${ordinal(date)} ${monthShort[month].charAt(0)}${monthShort[month].slice(1).toLowerCase()} at ${pad(hours24)}:${pad(minutes)}`;

  // "Sat" → MOBILE_BANNER_DAY
  const bannerDay = dayNames[day];

  // "29th" → MOBILE_BANNER_DATE
  const bannerDate = ordinal(date);

  // "August" → MOBILE_BANNER_MONTH
  const bannerMonth = monthNames[month];

  // "5:00pm" → MOBILE_BANNER_TIME
  const bannerTime = `${hours12}:${pad(minutes)}${ampmLower}`;

  // "Sat 29th August at 5:00 PM" → MOBILE_SEARCH_PPV_DATE
  const searchPpvDate = `${dayNames[day]} ${ordinal(date)} ${monthNames[month]} at ${hours12}:${pad(minutes)} ${ampm}`;

  // "SAT" → MOBILE_SCHEDULE_DAY
  const scheduleDay = dayNames[day].toUpperCase();

  // "AUG" → MOBILE_SCHEDULE_MONTH
  const scheduleMonth = monthShort[month];

  // "29" → MOBILE_SCHEDULE_DATE
  const scheduleDate = String(date);

  // "5:00PM" → MOBILE_SCHEDULE_TIME
  const scheduleTime = `${hours12}:${pad(minutes)}${ampm}`;

  // "17:00" → PPV_TIME. The Home of Boxing workbook validates this token
  // directly, so it must follow the same device-local instant as the other
  // iOS mobile date/time fields.
  const ppvTime = `${pad(hours24)}:${pad(minutes)}`;

  // ── Apply overrides ──────────────────────────────────────────────────
  eventData.MOBILE_PPV_DATE = mobilePpvDate;
  eventData.MOBILE_BANNER_DATE_TIME = bannerDateTime;
  eventData.MOBILE_BANNER_DAY = bannerDay;
  eventData.MOBILE_BANNER_DATE = bannerDate;
  eventData.MOBILE_BANNER_MONTH = bannerMonth;
  eventData.MOBILE_BANNER_TIME = bannerTime;
  eventData.MOBILE_SEARCH_PPV_DATE = searchPpvDate;
  eventData.MOBILE_SCHEDULE_DAY = scheduleDay;
  eventData.MOBILE_SCHEDULE_MONTH = scheduleMonth;
  eventData.MOBILE_SCHEDULE_DATE = scheduleDate;
  eventData.MOBILE_SCHEDULE_TIME = scheduleTime;
  eventData.PPV_TIME = ppvTime;
  eventData.PPV_DATE = bannerDateTime;
  eventData.PPV_PAGE_DATE = bannerDateTime;
  eventData.HOME_BOXING_UPCOMING_TIME = scheduleTime;
  eventData.HOME_BOXING_UPCOMING_DATE_TIME_TEXT =
    `WATCH LIVE ${eventData.HOME_BOXING_UPCOMING_DATE || mobilePpvDate} at ${scheduleTime}`;

  // Also update the web-side PPV_DATE_AND_TIME if it exists (used by Safari validations)
  eventData.PPV_DATE_AND_TIME = bannerDateTime;
  eventData.EVENT_DATE_TIME = bannerDateTime;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`🕐 [tz] Recomputed mobile dates for device timezone: ${tz}`);
  console.log(`   UTC          : ${utcStr}`);
  console.log(`   MOBILE_PPV_DATE       : ${mobilePpvDate}`);
  console.log(`   MOBILE_BANNER_DATE_TIME: ${bannerDateTime}`);
  console.log(`   PPV_TIME               : ${ppvTime}`);
}
