const fs = require('fs');
const path = require('path');

// Inputs from environment variables
const reportTitle = process.env.REPORT_TITLE || 'PAC Partner Automation Report';
const pacPartner = process.env.PAC_PARTNER || 'unknown';
const pacVersion = process.env.PAC_VERSION || '1.0';
const daznEnv = (process.env.DAZN_ENV || 'staging').toUpperCase();
const runId = process.env.GITHUB_RUN_ID || 'unknown';
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

const baseDir = path.resolve(process.cwd(), 'pac-downloaded-artifacts');
const outputDir = path.resolve(process.cwd(), 'pac-workflow-summary');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function findFiles(dir, filter, files = []) {
  if (!fs.existsSync(dir)) return files;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        findFiles(res, filter, files);
      } else if (filter(entry.name, res)) {
        files.push(res);
      }
    }
  } catch (e) {
    console.error(`Error scanning directory ${dir}:`, e.message);
  }
  return files;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms <= 0) return '-';
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatScenarioName(raw) {
  if (!raw) return 'Unknown Scenario';
  return raw
    .replace(/^pac[12]-(stag|prod)-report-[^-]+-/i, '')
    .replace(/-\d+$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const scenarioResults = [];

if (fs.existsSync(baseDir)) {
  const jobDirs = fs.readdirSync(baseDir).filter(name => {
    return fs.statSync(path.join(baseDir, name)).isDirectory();
  });

  for (const dirName of jobDirs) {
    const jobPath = path.join(baseDir, dirName);

    // Identify HTML, PDF, Videos, and Traces
    const htmlFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.html') && !name.includes('index.html'));
    const pdfFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.pdf'));
    const videoFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.webm') || name.toLowerCase().endsWith('.mp4'));
    const jsonFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.json') && (name.includes('result') || name.includes('report')));

    let status = 'PASS';
    let passedChecks = 0;
    let failedChecks = 0;
    let totalChecks = 0;
    let durationStr = '-';
    let errorMessage = '';

    // Inspect HTML report if available
    if (htmlFiles.length > 0) {
      try {
        const htmlContent = fs.readFileSync(htmlFiles[0], 'utf-8');

        // Check for pass/fail cards
        const passMatch = htmlContent.match(/<div class=["']card pass["']>\s*<div class=["']v["']>(\d+)<\/div>/i);
        const failMatch = htmlContent.match(/<div class=["']card fail["']>\s*<div class=["']v["']>(\d+)<\/div>/i);
        if (passMatch) passedChecks = parseInt(passMatch[1], 10);
        if (failMatch) failedChecks = parseInt(failMatch[1], 10);

        totalChecks = passedChecks + failedChecks;

        if (failedChecks > 0 || /<span class=["'][^"']*\bpill-fail\b[^"']*["']/i.test(htmlContent)) {
          status = 'FAIL';
        }

        // Extract duration from metadata grid if present
        const durMatch = htmlContent.match(/<div class=["']k["']>Duration<\/div>\s*<div class=["']v["']>([^<]+)<\/div>/i);
        if (durMatch) {
          durationStr = durMatch[1].trim();
        }
      } catch (err) {
        console.warn(`Warning parsing HTML report in ${dirName}:`, err.message);
      }
    }

    // Inspect JSON test stats if available
    for (const jsonFile of jsonFiles) {
      try {
        const jsonContent = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
        if (jsonContent.stats) {
          if (jsonContent.stats.unexpected && jsonContent.stats.unexpected > 0) {
            status = 'FAIL';
          }
          if (durationStr === '-' && jsonContent.stats.duration) {
            durationStr = formatDurationMs(jsonContent.stats.duration);
          }
        }
        if (jsonContent.errors && jsonContent.errors.length > 0) {
          status = 'FAIL';
          errorMessage = jsonContent.errors.map(e => e.message || '').filter(Boolean).join('\n');
        }
      } catch (err) {}
    }

    // If no reports found at all, the job likely failed before test completion
    if (htmlFiles.length === 0 && jsonFiles.length === 0) {
      status = 'FAIL';
      errorMessage = 'No test reports or results generated. Job may have timed out or failed setup.';
    }

    // Copy artifacts to consolidated folder
    const targetSubDir = path.join(outputDir, dirName);
    fs.mkdirSync(targetSubDir, { recursive: true });

    if (htmlFiles.length > 0) {
      fs.copyFileSync(htmlFiles[0], path.join(targetSubDir, path.basename(htmlFiles[0])));
    }
    if (pdfFiles.length > 0) {
      fs.copyFileSync(pdfFiles[0], path.join(targetSubDir, path.basename(pdfFiles[0])));
    }
    if (videoFiles.length > 0) {
      fs.copyFileSync(videoFiles[0], path.join(targetSubDir, path.basename(videoFiles[0])));
    }

    scenarioResults.push({
      dirName,
      scenarioName: formatScenarioName(dirName),
      status,
      passedChecks,
      failedChecks,
      totalChecks,
      durationStr,
      hasHtml: htmlFiles.length > 0,
      hasPdf: pdfFiles.length > 0,
      hasVideo: videoFiles.length > 0,
      errorMessage,
    });
  }
}

// Calculate totals
const totalRuns = scenarioResults.length;
const passedRuns = scenarioResults.filter(r => r.status === 'PASS').length;
const failedRuns = scenarioResults.filter(r => r.status === 'FAIL').length;
const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
const overallStatusEmoji = failedRuns === 0 && totalRuns > 0 ? '🟢' : '🔴';

// 1. Build Consolidated Markdown Summary for GITHUB_STEP_SUMMARY
let md = '';
md += `# ${overallStatusEmoji} ${reportTitle}\n\n`;
md += `> **Execution Summary:** \`${passedRuns}/${totalRuns}\` Scenarios Passed (**${passRate}%**)\n\n`;

md += `### 📌 Environment & Execution Details\n\n`;
md += `| Attribute | Value |\n`;
md += `|---|---|\n`;
md += `| **Partner** | \`${pacPartner}\` |\n`;
md += `| **PAC Architecture** | \`PAC ${pacVersion}\` |\n`;
md += `| **Environment** | \`${daznEnv}\` |\n`;
md += `| **Total Parallel Scenarios** | \`${totalRuns}\` |\n`;
md += `| **Passed Scenarios** | \`${passedRuns}\` |\n`;
md += `| **Failed Scenarios** | \`${failedRuns}\` |\n`;
md += `| **Pass Rate** | **${passRate}%** |\n\n`;

md += `### 📊 Scenario Execution Breakdown\n\n`;
md += `| Status | Scenario / Lane | Duration | Validations (Pass / Fail) | Artifacts |\n`;
md += `|:---:|---|:---:|:---:|---|\n`;

if (scenarioResults.length === 0) {
  md += `| ⚠️ | No scenario artifacts discovered | - | - | - |\n`;
} else {
  for (const r of scenarioResults) {
    const statusIcon = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    const validationText = r.totalChecks > 0 ? `${r.passedChecks} pass / ${r.failedChecks} fail` : 'Executed';
    const artifacts = [];
    if (r.hasHtml) artifacts.push('📄 HTML');
    if (r.hasPdf) artifacts.push('📑 PDF');
    if (r.hasVideo) artifacts.push('🎬 Video');
    const artifactStr = artifacts.length > 0 ? artifacts.join(', ') : 'Traces';

    md += `| **${statusIcon}** | **${r.scenarioName}** | \`${r.durationStr}\` | ${validationText} | ${artifactStr} |\n`;
  }
}
md += `\n`;

// Failure details section if any
if (failedRuns > 0) {
  md += `### ⚠️ Failure Diagnostics\n\n`;
  for (const r of scenarioResults.filter(s => s.status === 'FAIL')) {
    md += `<details><summary><b>❌ ${r.scenarioName}</b></summary>\n\n`;
    md += `\`\`\`text\n${r.errorMessage || 'Validation check assertion failed. Check HTML report or Playwright trace for exact diff.'}\n\`\`\`\n\n`;
    md += `</details>\n\n`;
  }
}

// Write to GITHUB_STEP_SUMMARY if provided
if (summaryFile) {
  try {
    fs.writeFileSync(summaryFile, md, 'utf-8');
    console.log(`📝 Successfully wrote consolidated summary to ${summaryFile}`);
  } catch (err) {
    console.error('Error writing to GITHUB_STEP_SUMMARY:', err.message);
  }
}

// 2. Generate Consolidated HTML Dashboard Report
const htmlReportPath = path.join(outputDir, 'Consolidated_PAC_Report.html');
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${reportTitle}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; background: #0f172a; color: #f8fafc; font-size: 13px; }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; margin: 0 0 6px; color: #fff; display: flex; align-items: center; gap: 10px; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
  .kpi-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px 20px; }
  .kpi-card .lbl { font-size: 11px; text-transform: uppercase; color: #94a3b8; letter-spacing: .5px; }
  .kpi-card .val { font-size: 26px; font-weight: 700; margin-top: 4px; color: #fff; }
  .kpi-card.pass .val { color: #4ade80; }
  .kpi-card.fail .val { color: #f87171; }
  .kpi-card.pct .val { color: #60a5fa; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid #334155; }
  th { background: #0f172a; color: #94a3b8; text-align: left; padding: 12px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  td { padding: 12px 16px; border-top: 1px solid #334155; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 700; font-size: 11px; }
  .badge-pass { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
  .badge-fail { background: rgba(239, 68, 68, 0.2); color: #f87171; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${overallStatusEmoji} ${reportTitle}</h1>
  <div class="sub">Partner: <b>${pacPartner}</b> · Architecture: <b>PAC ${pacVersion}</b> · Environment: <b>${daznEnv}</b></div>
  
  <div class="kpi-grid">
    <div class="kpi-card"><div class="lbl">Total Scenarios</div><div class="val">${totalRuns}</div></div>
    <div class="kpi-card pass"><div class="lbl">Passed</div><div class="val">${passedRuns}</div></div>
    <div class="kpi-card fail"><div class="lbl">Failed</div><div class="val">${failedRuns}</div></div>
    <div class="kpi-card pct"><div class="lbl">Pass Rate</div><div class="val">${passRate}%</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Scenario / Lane</th>
        <th>Duration</th>
        <th>Validations</th>
        <th>Artifacts</th>
      </tr>
    </thead>
    <tbody>
      ${scenarioResults.map(r => `
        <tr>
          <td><span class="badge ${r.status === 'PASS' ? 'badge-pass' : 'badge-fail'}">${r.status}</span></td>
          <td><b>${r.scenarioName}</b></td>
          <td>${r.durationStr}</td>
          <td>${r.totalChecks > 0 ? `${r.passedChecks} pass / ${r.failedChecks} fail` : 'Completed'}</td>
          <td>${[r.hasHtml ? 'HTML' : null, r.hasPdf ? 'PDF' : null, r.hasVideo ? 'Video' : null].filter(Boolean).join(', ') || 'Traces'}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>
</body>
</html>`;

fs.writeFileSync(htmlReportPath, htmlContent, 'utf-8');
console.log(`📊 Generated consolidated HTML dashboard report: ${htmlReportPath}`);
