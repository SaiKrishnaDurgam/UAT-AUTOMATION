type Result = {
  page:     string;
  field:    string;
  expected: unknown;
  actual:   unknown;
  status:   'PASS' | 'FAIL';
  variant?: string;
};

export function displayResultsTable(
  results:  Result[],
  variant:  string = 'unknown',
  meta?: {
    event?:     string;
    region?:    string;
    excelPath?: string | null;
    videoPath?: string | null;
  }
): void {
  if (!results.length) {
    console.log('\n⚠️  No results to display');
    return;
  }

  const line  = '─'.repeat(55);
  const dline = '═'.repeat(55);

  const pages = [...new Set(results.map(r => r.page))];

  console.log(`\n${dline}`);
  console.log('  📊  TEST RESULTS SUMMARY');
  console.log(dline);

  if (meta?.event)  console.log(`  🥊  Event   : ${meta.event}`);
  if (meta?.region) console.log(`  🌍  Region  : ${meta.region}`);
  console.log(`  🎯  Variant : ${variant}`);
  console.log(line);

  // ── Per page breakdown ───────────────────────────────────────
  console.log('');

  for (const p of pages) {
    const pageResults = results.filter(r => r.page === p);
    const pass  = pageResults.filter(r => r.status === 'PASS').length;
    const fail  = pageResults.filter(r => r.status === 'FAIL').length;
    const total = pageResults.length;
    const pct   = total ? ((pass / total) * 100).toFixed(0) : '0';

    console.log(
      `  ${pageIcon(p)}  ${p.padEnd(12)} ` +
      `✅ ${String(pass).padStart(2)}  ` +
      `❌ ${String(fail).padStart(2)}  ` +
      `Total ${String(total).padStart(2)}  (${pct}%)`
    );

    // ── Failed fields under each page ──────────────────────────
    const failed = pageResults.filter(r => r.status === 'FAIL');
    if (failed.length) {
      for (const f of failed) {
        const exp = String(f.expected ?? '');
        const act = String(f.actual   ?? '');
        console.log(`       ❌ ${f.field}`);
        console.log(`          expected : ${exp}`);
        console.log(`          actual   : ${act}`);
      }
      console.log('');
    }
  }

  // ── Overall totals ───────────────────────────────────────────
  const totalPass = results.filter(r => r.status === 'PASS').length;
  const totalFail = results.filter(r => r.status === 'FAIL').length;
  const total     = results.length;
  const totalPct  = total ? ((totalPass / total) * 100).toFixed(1) : '0';

  console.log(line);
  console.log(`  ✅  Passed  : ${totalPass} / ${total}`);
  console.log(`  ❌  Failed  : ${totalFail} / ${total}`);
  console.log(`  📈  Pass %  : ${totalPct}%`);
  console.log(line);

  // ── File paths ───────────────────────────────────────────────
  if (meta?.excelPath) {
  }

  if (meta?.videoPath) {
  } else {
  }

  console.log(`${dline}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────
function pageIcon(page: string): string {
  const p = page.toLowerCase();
  if (p.includes('schedule')) return '📅';
  if (p.includes('landing'))  return '🏠';
  if (p.includes('ppv'))      return '🥊';
  if (p.includes('plan'))     return '📋';
  if (p.includes('payment'))  return '💳';
  if (p.includes('otp'))      return '🔑';
  if (p.includes('phone'))    return '📱';
  return '📄';
}