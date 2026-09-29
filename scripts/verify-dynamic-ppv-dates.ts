// Lightweight, dependency-free sanity checks for the dynamic PPV date/time
// logic in utils/dateUtils.ts (shared by Web, mobile and TV). Run with:
//   npx ts-node scripts/verify-dynamic-ppv-dates.ts
import assert from 'assert';
import { calculateDynamicPpvBannerDate, resolvePpvEventDateInfo } from '../utils/dateUtils';

let passCount = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passCount++;
    console.log(`✅ ${name}`);
  } catch (error: any) {
    console.error(`❌ ${name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

// Reference "now": Wed 2026-09-23 10:00 UK local time.
const REF = new Date(2026, 8, 23, 10, 0, 0);

check('>7 days away yields an absolute date candidate, no Today/Tomorrow', () => {
  const event = { REGION: 'GB', PPV_UTC_DATE: '2026-10-15T19:00:00Z' }; // +22 days, 20:00 BST
  const candidates = calculateDynamicPpvBannerDate(event, undefined, REF);
  assert.ok(/15th Oct|15 Oct/i.test(candidates), 'expected absolute date candidate');
  assert.ok(!/\btoday\b/i.test(candidates), 'should not contain Today');
});

check('2-7 days away yields a weekday candidate', () => {
  const event = { REGION: 'GB', PPV_UTC_DATE: '2026-09-26T19:00:00Z' }; // Sat, +3 days
  const info = resolvePpvEventDateInfo(event, REF);
  assert.strictEqual(info?.diffDays, 3);
  const candidates = calculateDynamicPpvBannerDate(event, undefined, REF);
  assert.ok(/\bSat(urday)?\b/i.test(candidates), 'expected weekday candidate');
});

check('Tomorrow (+1 day) yields a Tomorrow candidate', () => {
  const event = { REGION: 'GB', PPV_UTC_DATE: '2026-09-24T19:00:00Z' };
  const info = resolvePpvEventDateInfo(event, REF);
  assert.strictEqual(info?.diffDays, 1);
  const candidates = calculateDynamicPpvBannerDate(event, undefined, REF);
  assert.ok(/tomorrow at 8:00\s*pm/i.test(candidates), 'expected "Tomorrow at 8:00 PM"');
});

check('Today morning/afternoon/evening/night labels match hour-of-day', () => {
  const morning = calculateDynamicPpvBannerDate({ REGION: 'GB', PPV_UTC_DATE: '2026-09-23T08:00:00Z' }, undefined, REF);
  assert.ok(/this morning at/i.test(morning));
  const afternoon = calculateDynamicPpvBannerDate({ REGION: 'GB', PPV_UTC_DATE: '2026-09-23T13:00:00Z' }, undefined, REF);
  assert.ok(/this afternoon at/i.test(afternoon));
  const evening = calculateDynamicPpvBannerDate({ REGION: 'GB', PPV_UTC_DATE: '2026-09-23T18:00:00Z' }, undefined, REF);
  assert.ok(/this evening at|tonight at/i.test(evening));
});

check('LIVE window (event start to +5h) includes LIVE candidates', () => {
  const liveNow = new Date(2026, 8, 23, 20, 30, 0); // 30 min into an 8pm event
  const candidates = calculateDynamicPpvBannerDate({ REGION: 'GB', PPV_UTC_DATE: '2026-09-23T19:00:00Z' }, undefined, liveNow);
  assert.ok(/\bLIVE\b/.test(candidates));
});

check('Missing PPV_UTC_DATE falls back to static banner date string', () => {
  const result = calculateDynamicPpvBannerDate({ REGION: 'GB', PPV_DATE: 'Saturday 26th September' }, undefined, REF);
  assert.ok(result.length > 0, 'expected non-empty fallback candidates');
});

check('resolvePpvEventDateInfo returns null when no date data at all', () => {
  assert.strictEqual(resolvePpvEventDateInfo({ REGION: 'GB' }, REF), null);
});

check('AU region resolves via timezone map (regression: was missing before this change)', () => {
  const info = resolvePpvEventDateInfo({ REGION: 'AU', PPV_UTC_DATE: '2026-09-26T09:00:00Z' }, REF);
  assert.ok(info, 'expected AU region to resolve a date');
});

console.log(`\n${passCount} check(s) passed.`);
