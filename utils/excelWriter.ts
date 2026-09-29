import * as XLSX from 'xlsx';
import * as fs   from 'fs';
import * as path from 'path';
import { compare } from './compare';

// ── Column name maps ─────────────────────────────────────────────
const SCHEDULE_HEADERS       = ['Field', 'Expected', 'Actual', 'Status'];
const PPV_HEADERS            = ['Variant', 'Field', 'Expected', 'Actual', 'Status'];
const PLAN_HEADERS           = ['Tier', 'Field', 'Expected', 'Actual', 'Status'];
const PAYMENT_HEADERS        = ['Tier', 'Rate Plan', 'Field', 'Expected', 'Actual', 'Status'];
const LANDING_HEADERS        = ['Field', 'Expected', 'Actual', 'Status'];
const MY_ACCOUNT_HEADERS     = ['Field', 'Expected', 'Actual', 'Status'];
const CHOOSE_BUY_HEADERS     = ['Field', 'Expected', 'Actual', 'Status'];
const PPV_PAYMENT_HEADERS    = ['Tier', 'Rate Plan', 'Field', 'Expected', 'Actual', 'Status'];
const CONFIRMATION_HEADERS   = ['Tier', 'Field', 'Expected', 'Actual', 'Status'];
const SUMMARY_HEADERS        = ['Metric', 'Value'];
const PAGE_SUM_HEADERS       = ['Page', 'Total', 'Passed', 'Failed', 'Pass %'];

// ── Style helpers ────────────────────────────────────────────────
const applyStyles = (ws: XLSX.WorkSheet, data: any[]) => {
  if (!data.length) return;
  const colWidths = Object.keys(data[0]).map(k => ({
    wch: Math.max(
      k.length,
      ...data.map(r => String(r[k] ?? '').length)
    ) + 4,
  }));
  ws['!cols'] = colWidths;
};

export const writeResults = async (
  results: any[],
  preferredVideoPath?: string | null
): Promise<{ excelPath: string | null; videoPath: string | null }> => {

  // Centralized cleanup of date/format combinations in expected values
  results.forEach((r: any) => {
    if (r.expected && typeof r.expected === 'string' && r.expected.includes('|')) {
      const options = r.expected.split('|').map((opt: string) => opt.trim());
      if (r.status === 'PASS' && r.actual) {
        const matched = options.find((opt: string) => compare(r.actual, opt));
        if (matched) {
          r.expected = matched;
          return;
        }
      }
      r.expected = options[0];
    }
  });

  // ── Find video ───────────────────────────────────────────────
  let videoPath: string | null = null;
  try {
    if (preferredVideoPath && fs.existsSync(preferredVideoPath)) {
      videoPath = preferredVideoPath;
    } else {
      const videoDirs = [
        path.resolve(process.cwd(), 'test-results', 'videos'),
        path.resolve(process.cwd(), 'test-results', 'artifacts'),
        path.resolve(process.cwd(), 'test-results'),
      ];
      const findVideo = (dir: string): string | null => {
        if (!fs.existsSync(dir)) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.name.endsWith('.webm') || e.name.endsWith('.mp4') || e.isDirectory())
          .sort((a, b) => {
            const aPath = path.join(dir, a.name);
            const bPath = path.join(dir, b.name);
            return fs.statSync(bPath).mtimeMs - fs.statSync(aPath).mtimeMs;
          });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            const found = findVideo(full);
            if (found) return found;
          } else if (e.name.endsWith('.webm') || e.name.endsWith('.mp4')) {
            return full;
          }
        }
        return null;
      };
      for (const dir of videoDirs) {
        videoPath = findVideo(dir);
        if (videoPath) break;
      }
    }
  } catch {}

  try {
    // ── Output dir ───────────────────────────────────────────
    const dir = path.resolve(process.cwd(), 'test-results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const validRows = results.filter((r: any) => r?.field && String(r.status || '').toUpperCase() !== 'SKIP');

    // ── Row mapper ───────────────────────────────────────────
    const toRow = (
      r:              any,
      includeVariant  = false,
      includeTier     = false,
      includeRatePlan = false
    ) => {
      const base: any = {
        Field:    r.field    ?? '',
        Expected: r.expected ?? '',
        Actual:   r.actual   ?? '',
        Status:   r.status   ?? '',
      };

      if (includeRatePlan) {
        return {
          Tier:        r.tier     ?? '',
          'Rate Plan': r.ratePlan ?? '',
          ...base,
        };
      }

      if (includeTier) {
        return { Tier: r.tier ?? '', ...base };
      }

      if (includeVariant) {
        return { Variant: r.variant ?? '', ...base };
      }

      return base;
    };

    // ── Filter by page name ──────────────────────────────────
    // Matches ALL page names used across both specs
    const byPage = (
      pattern:        RegExp,
      includeVariant  = false,
      includeTier     = false,
      includeRatePlan = false
    ) =>
      validRows
        .filter((r: any) => pattern.test(String(r.page ?? '')))
        .map((r: any) => toRow(r, includeVariant, includeTier, includeRatePlan));

    // ── Android-specific page mappings ──────────────────────
    const androidLandingPageRows = byPage(/^(Andriod_Landing_Page|Landing)$/i);
    const androidHomePageRows = byPage(/^(Andriod_Home_Page|Home Page)$/i);
    const androidHomeBoxingPageRows = byPage(/^(Andriod_Home_Boxing_Page|Home of Boxing)$/i);
    const androidSearchPageRows = byPage(/^(Andriod_Search_Page|Search)$/i);
    const androidSchedulePageRows = byPage(/^(Andriod_Schedule_Page|Schedule)$/i);
    const androidPaywallRows = byPage(/^(Andriod_Paywall|Mobile Paywall|PPV Banner)$/i);

    // ── New user spec pages ───────────────────────────────────
    const scheduleRows     = byPage(/^schedule$/i);
    const landingRows      = byPage(/^landing$/i);
    const homeOfBoxingRows = byPage(/^home of boxing$/i);
    const homePageRows     = byPage(/^home page$/i);
    const searchRows       = byPage(/^search$/i);
    const standalonePPVRows= byPage(/^standalone ppv$/i);
    const phoneRows        = byPage(/^phone number$/i);

    // ── Mobile-only pages ─────────────────────────────────────
    const ppvBannerRows    = byPage(/^ppv banner$/i);
    const ppvTileRows      = byPage(/^ppv tile$/i);
    const mobilePaywallRows = byPage(/^mobile paywall$/i);

    // ── Both specs — PPV page ─────────────────────────────────
    const ppvRows          = byPage(/^ppv$/i,                  true,  false, false);
    const defaultSignupRows= byPage(/^default signup$/i,       true,  false, false);
    const bundlePpvRows    = byPage(/^bundle ppv$/i,           true,  false, false);

    // ── Both specs — Plan page ────────────────────────────────
    const planRows         = byPage(/^dazn plan$/i,            false, true,  false);

    // ── New user spec — Payment page ──────────────────────────
    const paymentRows      = byPage(/^payment$/i,              false, false, true);

    // ── Existing user spec pages ──────────────────────────────
    const myAccountRows    = byPage(/^my account$/i);
    const chooseBuyRows    = byPage(/^choose how to buy$/i);
    const ppvPaymentRows   = byPage(/^ppv payment/i,           false, false, true);
    const confirmationRows = byPage(/^upgrade confirmation$/i, false, true,  false);

    // ── Upsell flow pages ─────────────────────────────────────
    const upsellFirstSuccessRows  = byPage(/^upsell first success$/i);
    const upsellSecondSuccessRows = byPage(/^upsell second success$/i);
    const upsellPaymentRows       = byPage(/^upsell payment$/i);

    // ── All rows for summary ──────────────────────────────────
    const allRows = [
      ...scheduleRows,
      ...landingRows,
      ...homeOfBoxingRows,
      ...homePageRows,
      ...searchRows,
      ...standalonePPVRows,
      ...phoneRows,
      ...ppvBannerRows,
      ...ppvTileRows,
      ...mobilePaywallRows,
      ...ppvRows,
      ...defaultSignupRows,
      ...bundlePpvRows,
      ...planRows,
      ...paymentRows,
      ...myAccountRows,
      ...chooseBuyRows,
      ...ppvPaymentRows,
      ...confirmationRows,
      ...upsellFirstSuccessRows,
      ...upsellSecondSuccessRows,
      ...upsellPaymentRows,
    ];

    const total     = allRows.length;
    const passCount = allRows.filter(r => r.Status === 'PASS').length;
    const failCount = allRows.filter(r => r.Status === 'FAIL').length;

    const overallSummary = [
      { Metric: 'Total Tests', Value: total     },
      { Metric: 'Passed',      Value: passCount },
      { Metric: 'Failed',      Value: failCount },
      { Metric: 'Pass Rate',   Value: total
          ? `${((passCount / total) * 100).toFixed(1)}%`
          : '0%'
      },
      { Metric: 'Run Date',    Value: new Date().toLocaleString() },
    ];

    // ── Per-page summary ─────────────────────────────────────
    const pageGroups = [
      { name: 'Schedule',            rows: scheduleRows     },
      { name: 'Landing',             rows: landingRows      },
      { name: 'Home of Boxing',      rows: homeOfBoxingRows },
      { name: 'Home Page',           rows: homePageRows     },
      { name: 'Search',              rows: searchRows       },
      { name: 'Standalone PPV',      rows: standalonePPVRows},
      { name: 'Phone Number',        rows: phoneRows        },
      { name: 'PPV Banner',          rows: ppvBannerRows    },
      { name: 'PPV Tile',            rows: ppvTileRows      },
      { name: 'Mobile Paywall',      rows: mobilePaywallRows},
      { name: 'My Account',          rows: myAccountRows    },
      { name: 'Choose How To Buy',   rows: chooseBuyRows    },
      { name: 'PPV',                 rows: ppvRows          },
      { name: 'Default Signup',      rows: defaultSignupRows},
      { name: 'Bundle PPV',          rows: bundlePpvRows    },
      { name: 'DAZN Plan',           rows: planRows         },
      { name: 'Payment',             rows: paymentRows      },
      { name: 'PPV Payment',         rows: ppvPaymentRows   },
      { name: 'Upgrade Confirmation',rows: confirmationRows },
      { name: 'Upsell First Success',rows: upsellFirstSuccessRows  },
      { name: 'Upsell Second Success',rows: upsellSecondSuccessRows },
      { name: 'Upsell Payment',      rows: upsellPaymentRows       },
    ].filter(g => g.rows.length > 0);

    const pageSummary = pageGroups.map(p => ({
      Page:     p.name,
      Total:    p.rows.length,
      Passed:   p.rows.filter(r => r.Status === 'PASS').length,
      Failed:   p.rows.filter(r => r.Status === 'FAIL').length,
      'Pass %': p.rows.length
        ? `${((p.rows.filter(r => r.Status === 'PASS').length / p.rows.length) * 100).toFixed(1)}%`
        : '0%',
    }));

    // ── Build workbook ───────────────────────────────────────
    const wb = XLSX.utils.book_new();

    const addSheet = (
      name:    string,
      data:    any[],
      headers: string[]
    ) => {
      const rows = data.length
        ? data
        : [Object.fromEntries(headers.map(h => [h, '']))];
      const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
      applyStyles(ws, rows);

      // Colour PASS/FAIL cells
      const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const statusCol = headers.indexOf('Status');
        if (statusCol === -1) continue;
        const cellAddr = XLSX.utils.encode_cell({ r: R, c: statusCol });
        const cell     = ws[cellAddr];
        if (!cell) continue;
        cell.s = {
          fill: {
            patternType: 'solid',
            fgColor: {
              rgb: cell.v === 'PASS' ? 'C6EFCE' : 'FFC7CE',
            },
          },
          font: {
            color: { rgb: cell.v === 'PASS' ? '276221' : '9C0006' },
            bold: true,
          },
        };
      }

      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    // ── Summary sheets — always first ────────────────────────
    addSheet('Summary',      overallSummary, SUMMARY_HEADERS);
    addSheet('Page Summary', pageSummary,    PAGE_SUM_HEADERS);

    // ── New user spec sheets ─────────────────────────────────
    if (scheduleRows.length)
      addSheet('Schedule page',  scheduleRows,  SCHEDULE_HEADERS);
    if (landingRows.length)
      addSheet('Landing page',   landingRows,   LANDING_HEADERS);
    if (homeOfBoxingRows.length)
      addSheet('Home of Boxing', homeOfBoxingRows, LANDING_HEADERS);
    if (homePageRows.length)
      addSheet('Home Page',      homePageRows,  LANDING_HEADERS);
    if (searchRows.length)
      addSheet('Search page',    searchRows,    LANDING_HEADERS);
    if (standalonePPVRows.length)
      addSheet('Standalone PPV', standalonePPVRows, LANDING_HEADERS);
    if (phoneRows.length)
      addSheet('Phone Number',   phoneRows,     LANDING_HEADERS);

    // ── Existing user spec sheets ────────────────────────────
    if (myAccountRows.length)
      addSheet('My Account',         myAccountRows,    MY_ACCOUNT_HEADERS);
    if (chooseBuyRows.length)
      addSheet('Choose How To Buy',  chooseBuyRows,    CHOOSE_BUY_HEADERS);

    // ── Mobile Spec sheets ───────────────────────────────────
    if (ppvBannerRows.length)
      addSheet('PPV Banner',         ppvBannerRows,    LANDING_HEADERS);
    if (ppvTileRows.length)
      addSheet('PPV Tile',           ppvTileRows,      LANDING_HEADERS);
    if (mobilePaywallRows.length)
      addSheet('Mobile Paywall',     mobilePaywallRows, LANDING_HEADERS);

    // ── Android-specific sheets ──────────────────────────────
    if (androidLandingPageRows.length)
      addSheet('Andriod_Landing_Page', androidLandingPageRows, LANDING_HEADERS);
    if (androidHomePageRows.length)
      addSheet('Andriod_Home_Page',    androidHomePageRows,    LANDING_HEADERS);
    if (androidHomeBoxingPageRows.length)
      addSheet('Andriod_Home_Boxing_Page', androidHomeBoxingPageRows, LANDING_HEADERS);
    if (androidSearchPageRows.length)
      addSheet('Andriod_Search_Page',  androidSearchPageRows,  LANDING_HEADERS);
    if (androidSchedulePageRows.length)
      addSheet('Andriod_Schedule_Page', androidSchedulePageRows, LANDING_HEADERS);
    if (androidPaywallRows.length)
      addSheet('Andriod_Paywall',       androidPaywallRows,      LANDING_HEADERS);

    // ── Shared sheets ────────────────────────────────────────
    if (ppvRows.length)
      addSheet('PPV page',       ppvRows,       PPV_HEADERS);
    if (defaultSignupRows.length)
      addSheet('Default Signup', defaultSignupRows, PPV_HEADERS);
    if (bundlePpvRows.length)
      addSheet('Bundle PPV',     bundlePpvRows, PPV_HEADERS);
    if (planRows.length)
      addSheet('Dazn Plan page', planRows,      PLAN_HEADERS);
    if (paymentRows.length)
      addSheet('Payment page',   paymentRows,   PAYMENT_HEADERS);
    if (ppvPaymentRows.length)
      addSheet('PPV Payment',    ppvPaymentRows, PPV_PAYMENT_HEADERS);
    if (confirmationRows.length)
      addSheet('Confirmation',   confirmationRows, CONFIRMATION_HEADERS);

    // ── Upsell flow sheets ───────────────────────────────────
    if (upsellFirstSuccessRows.length)
      addSheet('Upsell 1st Success', upsellFirstSuccessRows, LANDING_HEADERS);
    if (upsellSecondSuccessRows.length)
      addSheet('Upsell 2nd Success', upsellSecondSuccessRows, LANDING_HEADERS);
    if (upsellPaymentRows.length)
      addSheet('Upsell Payment',     upsellPaymentRows, LANDING_HEADERS);

    // ── Write file ───────────────────────────────────────────
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);

    const excelPath = path.join(dir, `ppv-report-${timestamp}.xlsx`);
    XLSX.writeFile(wb, excelPath, { bookType: 'xlsx', type: 'binary' });

    console.log(`\n📊 Excel saved: ${excelPath}`);
    return { excelPath, videoPath };

  } catch (err) {
    console.error('❌ Excel Write Failed:', err);
    return { excelPath: null, videoPath };
  }
};
