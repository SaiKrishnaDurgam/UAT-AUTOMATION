export function validateField(
  results: any[],
  page: string,
  field: string,
  expected: any,
  actual: any,
  variant?: string
) {
  let exp = normalizeText(String(expected));
  let act = normalizeText(String(actual));

  let status = exp === act ? 'PASS' : 'FAIL';

  if (status === 'FAIL') {
    // Date fields
    if (/date/i.test(field)) {
      const expDate = normalizeDate(exp);
      const actDate = normalizeDate(act);
      if (expDate && actDate && (actDate.includes(expDate) || expDate.includes(actDate))) {
        status = 'PASS';
      }
    }

    // Time fields (supports excel fractional day values)
    if (status === 'FAIL' && /time/i.test(field)) {
      const expTime = normalizeTime(exp);
      const actTime = normalizeTime(act);
      if (expTime && actTime && expTime === actTime) {
        status = 'PASS';
      }
    }

    // Price fields
    if (status === 'FAIL' && /price/i.test(field)) {
      const expPrice = extractNumber(exp);
      const actPrice = extractNumber(act);
      if (expPrice && actPrice && expPrice === actPrice) {
        status = 'PASS';
      }
    }

    // Currency fields
    if (status === 'FAIL' && /currency/i.test(field)) {
      if ((exp === '$' && act.includes('$')) || (exp === '£' && act.includes('£')) || (exp.toLowerCase() === 'aud' && /aud/i.test(act))) {
        status = 'PASS';
      }
    }

    // Name / text flexibility - but only if values are reasonably close
    if (status === 'FAIL' && /name|title|header/i.test(field)) {
      // Only pass if the expected value is a substantial part of actual (more than 50% match)
      const expLower = exp.toLowerCase();
      const actLower = act.toLowerCase();

      // Check if expected is contained in actual and expected is at least 50% of actual length
      if (actLower.includes(expLower) && expLower.length >= actLower.length * 0.5) {
        status = 'PASS';
      }
      // Check if actual is contained in expected and actual is at least 50% of expected length
      else if (expLower.includes(actLower) && actLower.length >= expLower.length * 0.5) {
        status = 'PASS';
      }
    }
  }

  results.push({
    page,
    field,
    expected,
    actual,
    status,
    variant: variant || 'unknown',
  });

  if (status === 'PASS') {
    console.log(`✅ [${page}] ${field}`);
  } else {
    console.log(`❌ [${page}] ${field} (Exp: ${expected} | Act: ${actual})`);
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200E\u200F]/g, '')
    .trim();
}

function extractNumber(value: string): string {
  const match = value.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return match ? Number(match[0]).toFixed(2) : '';
}

function normalizeTime(value: string): string {
  const raw = value.trim();

  // Excel fractional day (e.g. 0.9791666667 -> 23:30)
  if (/^\d*\.\d+$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isNaN(num) && num >= 0 && num < 1) {
      const totalMinutes = Math.round(num * 24 * 60);
      const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
      const mm = String(totalMinutes % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    }
  }

  const match = raw.match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

// 🔥 Helper for date normalization
function normalizeDate(date: string): string {
  const monthMap: any = {
    january: 'jan',
    february: 'feb',
    march: 'mar',
    april: 'apr',
    may: 'may',
    june: 'jun',
    july: 'jul',
    august: 'aug',
    september: 'sep',
    october: 'oct',
    november: 'nov',
    december: 'dec',
  };

  let d = date.toLowerCase().trim();

  // Convert full month → short
  Object.keys(monthMap).forEach(full => {
    if (d.includes(full)) {
      d = d.replace(full, monthMap[full]);
    }
  });

  // Remove suffix (st, nd, rd, th)
  d = d.replace(/(st|nd|rd|th)/g, '');

  // Remove extra spaces
  d = d.replace(/\s+/g, ' ').trim();

  return d;
}
