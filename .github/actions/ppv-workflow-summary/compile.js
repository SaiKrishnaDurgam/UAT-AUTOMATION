const fs = require('fs');
const path = require('path');

// Inputs from environment variables
const reportTitle = process.env.REPORT_TITLE || 'PPV Workflow Report';
const ppvConfig = process.env.PPV_CONFIG || 'unknown';
const country = process.env.COUNTRY || 'unknown';
const runId = process.env.GITHUB_RUN_ID || 'unknown';
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

// Resolve Full PPV Event Name from JSON config file if available
let ppvDisplayName = ppvConfig;
if (ppvConfig && ppvConfig !== 'unknown') {
  const configFileCandidates = [
    path.resolve(process.cwd(), ppvConfig),
    path.resolve(process.cwd(), 'config', 'events', ppvConfig),
    path.resolve(process.cwd(), 'config', 'events', `${ppvConfig.replace(/\.json$/i, '')}.json`),
    path.resolve(process.cwd(), 'appium', 'config', 'events', ppvConfig),
    path.resolve(process.cwd(), 'appium', 'config', 'events', `${ppvConfig.replace(/\.json$/i, '')}.json`)
  ];

  for (const candidate of configFileCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      try {
        const cfg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        const foundName = cfg.PPV_DISPLAY_NAME || cfg.PPV_NAME || cfg.PPV_TITLE || cfg.eventKey;
        if (foundName) {
          ppvDisplayName = foundName;
          break;
        }
      } catch (e) {}
    }
  }
}

const baseDir = path.resolve(process.cwd(), 'ppv-workflow-summary');
const artifactsDir = path.join(baseDir, 'job-artifacts');

/**
 * Helper: Strip ANSI color / escape codes from error strings
 */
function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nxy=><]/g, '')
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Helper: Format duration in milliseconds to human readable (e.g. 53s, 1m 36s, 2m 7s)
 */
function formatDurationMs(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms <= 0) return null;
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) {
    return `${totalSecs}s`;
  }
  const mins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;
  return `${mins}m ${remSecs}s`;
}

/**
 * Helper: Parse date strings, including DD/MM/YYYY HH:MM:SS format
 */
function parseDateString(str) {
  if (!str) return null;
  const s = str.trim();
  const euMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[\s,]+([\d:]+)/);
  if (euMatch) {
    const [, d, m, y, time] = euMatch;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${time}`;
    const date = new Date(iso);
    if (!isNaN(date.getTime())) return date;
  }
  const date = new Date(s);
  return !isNaN(date.getTime()) ? date : null;
}

/**
 * Helper to find files recursively
 */
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

/**
 * Helper: Resolve job duration from JSON stats, XML reports, HTML text, or file mtimes
 */
function resolveDuration(jobPath, jsonFiles, customHtmlFiles) {
  // 1. Try JSON report stats & spec durations
  if (jsonFiles.length > 0) {
    try {
      const jsonContent = JSON.parse(fs.readFileSync(jsonFiles[0], 'utf-8'));
      if (jsonContent.stats && typeof jsonContent.stats.duration === 'number' && jsonContent.stats.duration > 0) {
        const formatted = formatDurationMs(jsonContent.stats.duration);
        if (formatted) return formatted;
      }
      let sumDuration = 0;
      function sumSuites(suite) {
        if (suite.specs) {
          for (const spec of suite.specs) {
            for (const test of spec.tests || []) {
              for (const r of test.results || []) {
                if (typeof r.duration === 'number' && r.duration > 0) {
                  sumDuration += r.duration;
                }
              }
            }
          }
        }
        if (suite.suites) suite.suites.forEach(sumSuites);
      }
      if (jsonContent.suites) jsonContent.suites.forEach(sumSuites);
      if (sumDuration > 0) {
        const formatted = formatDurationMs(sumDuration);
        if (formatted) return formatted;
      }
    } catch (e) {}
  }

  // 2. Check XML reports (e.g. WDIO xunit/junit results)
  const xmlFiles = findFiles(jobPath, name => name.endsWith('.xml'));
  for (const xmlFile of xmlFiles) {
    try {
      const xmlContent = fs.readFileSync(xmlFile, 'utf-8');
      const timeMatch = xmlContent.match(/time=["']([\d.]+)/i);
      if (timeMatch) {
        const secs = parseFloat(timeMatch[1]);
        if (!isNaN(secs) && secs > 0) {
          const formatted = formatDurationMs(secs * 1000);
          if (formatted) return formatted;
        }
      }
    } catch (e) {}
  }

  // 3. Try custom HTML reports
  if (customHtmlFiles.length > 0) {
    try {
      for (const htmlFile of customHtmlFiles) {
        const htmlContent = fs.readFileSync(htmlFile, 'utf-8');
        
        // Match explicit "Duration: 1m 36s" or "Duration: 53s"
        const durMatch = htmlContent.match(/Duration:\s*([\d]+m\s*[\d]+s|[\d]+s|[\d]+\.[\d]+s|[\d]+\s*min)/i);
        if (durMatch && durMatch[1] && !durMatch[1].includes('—')) {
          return durMatch[1].trim();
        }

        // Calculate from Start: and Generated: timestamps in HTML
        const startMatch = htmlContent.match(/Start:\s*([\d\/\:\s,]+?)(?:&nbsp;|\||<|\n)/i);
        const endMatch = htmlContent.match(/Generated:\s*([\d\/\:\s,]+?)(?:&nbsp;|\||<|\n)/i);
        if (startMatch && endMatch) {
          const startDate = parseDateString(startMatch[1]);
          const endDate = parseDateString(endMatch[1]);
          if (startDate && endDate && endDate > startDate) {
            const diffMs = endDate.getTime() - startDate.getTime();
            if (diffMs > 0) {
              const formatted = formatDurationMs(diffMs);
              if (formatted) return formatted;
            }
          }
        }
      }

      // Check timestamps in multiple report directory names if available
      const folderTimeMatches = customHtmlFiles
        .map(f => f.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/))
        .filter(Boolean)
        .map(m => new Date(m[1].replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4')))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a.getTime() - b.getTime());

      if (folderTimeMatches.length >= 2) {
        const diffMs = folderTimeMatches[folderTimeMatches.length - 1].getTime() - folderTimeMatches[0].getTime();
        if (diffMs > 0) {
          const formatted = formatDurationMs(diffMs);
          if (formatted) return formatted;
        }
      }
    } catch (e) {}
  }

  // 4. File mtime heuristic across job files (newest mtime - oldest mtime / birthtime)
  try {
    const allFiles = findFiles(jobPath, name => !name.startsWith('.'));
    if (allFiles.length > 0) {
      let minTime = Infinity;
      let maxTime = -Infinity;
      for (const f of allFiles) {
        const stat = fs.statSync(f);
        const btime = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
        if (btime > 0 && btime < minTime) minTime = btime;
        if (stat.mtimeMs < minTime) minTime = stat.mtimeMs;
        if (stat.mtimeMs > maxTime) maxTime = stat.mtimeMs;
      }
      if (minTime < Infinity && maxTime > -Infinity) {
        const diffMs = maxTime - minTime;
        if (diffMs >= 1000 && diffMs <= 3 * 3600 * 1000) {
          const formatted = formatDurationMs(diffMs);
          if (formatted) return formatted;
        }
      }
    }
  } catch (e) {}

  return 'N/A';
}

function customHtmlReportHasFailure(htmlContent) {
  const bodyContent = htmlContent
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  const failedCountMatch = bodyContent.match(/<div class=["'][^"']*\bcard\b[^"']*\bfail\b[^"']*["'][^>]*>\s*<div class=["']v["']>\s*(\d+)\s*<\/div>\s*<div class=["']k["']>\s*Failed\s*<\/div>/i);
  if (failedCountMatch) {
    return Number(failedCountMatch[1]) > 0;
  }

  return /<tr class=["'][^"']*\brow-fail\b[^"']*["']/i.test(bodyContent) ||
    /<span class=["'][^"']*\bst-fail\b[^"']*["'][^>]*>\s*FAIL\s*<\/span>/i.test(bodyContent);
}

/**
 * Report directories are written by the runners as:
 *   ppv-<platform>-<journey>-<source>-<profile-or-plan>-attempt-<number>
 */
function getStage(dirName) {
  const name = dirName.toLowerCase();
  if (/^ppv-(web|android|ios)-new-user-/.test(name) || name.includes('new-user') || name.includes('new_user')) {
    return 'new-user';
  }
  if (
    /^ppv-(web|android|ios)-(already-signed-in|dev-mode-my-account)-/.test(name) ||
    name.includes('already-signed') ||
    name.includes('already_signed')
  ) {
    return 'already-signed';
  }
  if (/^ppv-(web|android|ios)-sign-in-during-flow-/.test(name) || name.includes('signin') || name.includes('sign-in')) {
    return 'signin-during';
  }

  console.warn(`Unable to identify journey for report directory "${dirName}"; assigning it to Existing User - Sign In During Flow.`);
  return 'signin-during';
}

function getMatrixIdentity(dirName) {
  const reportId = dirName.replace(
    /^ppv-(web|android|ios)-(new-user|sign-in-during-flow|already-signed-in|dev-mode-my-account)-/i,
    ''
  ).replace(/-attempt-\d+$/i, '');
  const profileMatch = reportId.match(
    /-(freemium|frozen|active_standard_monthly|active_standard_apm|active_ultimate_apm|active_ultimate_upfront)_(standard_monthly|standard_apm|ultimate_apm|ultimate_upfront)$/i
  );
  if (profileMatch) {
    return {
      source: reportId.slice(0, -profileMatch[0].length),
      label: `${profileMatch[1]} / ${profileMatch[2]}`
    };
  }

  const planMatch = reportId.match(/-(standard_monthly|standard_apm|ultimate_apm|ultimate_upfront)$/i);
  if (planMatch) {
    return {
      source: reportId.slice(0, -planMatch[0].length),
      label: planMatch[1]
    };
  }

  return { source: reportId, label: reportId };
}

// Group stats for each of the 3 main workflows
const workflowStats = {
  'new-user': { title: 'New User', total: 0, passed: 0, failed: 0, skipped: 0, runs: [] },
  'signin-during': { title: 'Existing User - Sign In During Flow', total: 0, passed: 0, failed: 0, skipped: 0, runs: [] },
  'already-signed': { title: 'Existing User - Already Signed In', total: 0, passed: 0, failed: 0, skipped: 0, runs: [] }
};

if (fs.existsSync(artifactsDir)) {
  const jobDirs = fs.readdirSync(artifactsDir).filter(name => {
    return fs.statSync(path.join(artifactsDir, name)).isDirectory();
  });

  for (const dirName of jobDirs) {
    const jobPath = path.join(artifactsDir, dirName);
    
    const stage = getStage(dirName);
    const matrixIdentity = getMatrixIdentity(dirName);

    // Find custom PDF, HTML, Video, and Playwright files recursively
    const pdfFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.pdf'));
    const customHtmlFiles = findFiles(jobPath, (name, filepath) => {
      const lname = name.toLowerCase();
      return (
        lname.endsWith('.html') &&
        !filepath.includes('playwright-report') &&
        !filepath.includes('Gemini_Banner_Validation') &&
        lname !== 'index.html'
      ) || lname === 'ppv_report.html';
    });
    const videoFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.webm') || name.toLowerCase().endsWith('.mp4'));
    const playwrightFiles = findFiles(jobPath, (name, filepath) => {
      return filepath.includes('playwright-report') && name.toLowerCase() === 'index.html';
    });
    const jiraTicketFiles = findFiles(jobPath, name => name.toLowerCase() === 'qar_tickets.json');

    const pdfRelative = pdfFiles.length > 0 ? path.relative(baseDir, pdfFiles[0]) : null;
    const customHtmlRelative = customHtmlFiles.length > 0 ? path.relative(baseDir, customHtmlFiles[0]) : null;
    const videoRelative = videoFiles.length > 0 ? path.relative(baseDir, videoFiles[0]) : null;
    const playwrightHtmlRelative = playwrightFiles.length > 0 ? path.relative(baseDir, playwrightFiles[0]) : null;

    // Check Playwright / JSON reports
    const jsonFiles = findFiles(jobPath, name => name === 'results.json');
    
    let specTitle = dirName;
    let errorMsg = '';
    let jiraUrl = null;
    let jiraKey = null;
    let isFail = false;

    for (const ticketFile of jiraTicketFiles) {
      try {
        const tickets = JSON.parse(fs.readFileSync(ticketFile, 'utf-8'));
        const ticket = Array.isArray(tickets)
          ? tickets.find(item => item && typeof item.key === 'string' && typeof item.url === 'string')
          : null;
        if (ticket) {
          jiraKey = ticket.key;
          jiraUrl = ticket.url;
          break;
        }
      } catch (err) {
        console.error(`Error parsing QAR ticket file ${ticketFile}:`, err.message);
      }
    }

    if (jsonFiles.length > 0) {
      try {
        const jsonContent = JSON.parse(fs.readFileSync(jsonFiles[0], 'utf-8'));
        const stats = jsonContent.stats || {};
        
        // 1. Determine failure accurately
        if ((stats.unexpected && stats.unexpected > 0) || (stats.flaky && stats.flaky > 0)) {
          isFail = true;
        }
        if (jsonContent.errors && jsonContent.errors.length > 0) {
          isFail = true;
          errorMsg = jsonContent.errors.map(e => e.message || e.stack || '').filter(Boolean).join('\n');
        }

        // Traverse suites to find spec results and details
        const specsList = [];
        function collectSpecs(suite) {
          if (suite.specs) {
            for (const spec of suite.specs) specsList.push(spec);
          }
          if (suite.suites) {
            for (const subSuite of suite.suites) collectSpecs(subSuite);
          }
        }
        if (jsonContent.suites) {
          jsonContent.suites.forEach(collectSpecs);
        }

        for (const spec of specsList) {
          if (spec.title && specTitle === dirName) {
            specTitle = spec.title;
          }
          for (const test of spec.tests || []) {
            for (const res of test.results || []) {
              if (res.status && res.status !== 'passed') {
                isFail = true;
              }
              if (isFail && !errorMsg) {
                if (res.error) {
                  errorMsg = res.error.message || res.error.stack || '';
                }
                if (!errorMsg && res.errors && res.errors.length > 0) {
                  errorMsg = res.errors.map(e => e.message || e.stack || '').filter(Boolean).join('\n');
                }
              }
              // Extract Jira ticket from stdout logs
              if (!jiraUrl && res.stdout) {
                for (const log of res.stdout) {
                  if (log.text) {
                    const match = log.text.match(/🔗 \[Jira\] Ticket:\s*(https:\/\/\S+)/);
                    if (match) {
                      jiraUrl = match[1].trim();
                      jiraKey = jiraUrl.substring(jiraUrl.lastIndexOf('/') + 1);
                      break;
                    }
                  }
                }
              }
            }
          }
        }

      } catch (err) {
        console.error(`Error parsing results.json for ${dirName}:`, err.message);
        isFail = true;
      }
    }

    // Check custom HTML report if present for failure indication
    if (customHtmlFiles.length > 0) {
      try {
        for (const htmlFile of customHtmlFiles) {
          const htmlContent = fs.readFileSync(htmlFile, 'utf-8');
          if (customHtmlReportHasFailure(htmlContent)) {
            isFail = true;
            break;
          }
        }
      } catch (e) {}
    }

    // Check for failure screenshots
    const pngFiles = findFiles(jobPath, name => name.toLowerCase().endsWith('.png'));
    if (pngFiles.some(f => f.toLowerCase().includes('fail') || f.toLowerCase().includes('error'))) {
      isFail = true;
    }

    // Resolve duration using multi-source resolver
    const duration = resolveDuration(jobPath, jsonFiles, customHtmlFiles);

    // Finalize status
    let status = 'SKIP';
    if (isFail) {
      status = 'FAIL';
    } else if (jsonFiles.length > 0 || customHtmlFiles.length > 0) {
      status = 'PASS';
    } else {
      // Neither results.json nor custom html report exists -> job crashed/failed before report generation
      status = 'FAIL';
    }

    // Finalize error message
    errorMsg = stripAnsi(errorMsg).trim();
    if (isFail && !errorMsg) {
      errorMsg = 'Test execution failed. Inspect full job log in Playwright report or CI console.';
    }

    const record = {
      dirName,
      source: matrixIdentity.source,
      matrixLabel: matrixIdentity.label,
      specTitle,
      status,
      duration,
      errorMsg,
      jiraUrl,
      jiraKey,
      pdfPath: pdfRelative,
      customHtmlPath: customHtmlRelative,
      videoPath: videoRelative,
      playwrightHtmlPath: playwrightHtmlRelative,
      rawDirLink: path.relative(baseDir, jobPath)
    };

    // Increment stats
    const target = workflowStats[stage];
    target.total += 1;
    if (status === 'PASS') target.passed += 1;
    else if (status === 'FAIL') target.failed += 1;
    else target.skipped += 1;
    target.runs.push(record);
  }
}

// Group runs by Surfacing Point (Source) inside each workflow
for (const stage of Object.keys(workflowStats)) {
  const runs = workflowStats[stage].runs;
  const groups = {};

  runs.forEach(run => {
    const source = run.source;

    if (!groups[source]) {
      groups[source] = { source, status: 'PASS', runs: [] };
    }
    
    groups[source].runs.push(run);
    if (run.status === 'FAIL') {
      groups[source].status = 'FAIL';
    }
  });

  // Sort groups: failed groups first, then alphabetically
  const sortedGroups = Object.values(groups).sort((a, b) => {
    if (a.status === 'FAIL' && b.status !== 'FAIL') return -1;
    if (a.status !== 'FAIL' && b.status === 'FAIL') return 1;
    return a.source.localeCompare(b.source);
  });

  // For each group, sort its runs: failures first
  sortedGroups.forEach(g => {
    g.runs.sort((a, b) => {
      if (a.status === 'FAIL' && b.status !== 'FAIL') return -1;
      if (a.status !== 'FAIL' && b.status === 'FAIL') return 1;
      return a.matrixLabel.localeCompare(b.matrixLabel);
    });
  });

  workflowStats[stage].groupedRuns = sortedGroups;
}

// --- HTML Generation Helper Functions ---

function renderStageCard(key, stat) {
  const pct = stat.total > 0 ? ((stat.passed / stat.total) * 100).toFixed(1) : '0.0';
  const hasFails = stat.failed > 0;
  
  // Do NOT render badge if total is 0 (remove ALL PASS when 0/0)
  let badgeHtml = '';
  if (stat.total > 0) {
    badgeHtml = `<span class="badge ${hasFails ? 'fail' : 'pass'}">${hasFails ? `${stat.failed} FAILS` : 'ALL PASS'}</span>`;
  }

  let percentClass = 'pass';
  if (stat.total === 0) {
    percentClass = 'skip';
  } else if (hasFails) {
    percentClass = 'fail';
  }

  return `
    <div class="stage-card ${hasFails ? 'has-fails' : ''}">
      <div class="stage-title">
        ${stat.title}
        ${badgeHtml}
      </div>
      <div class="stage-metrics">
        <div class="metric-value">${stat.passed}<span>/${stat.total}</span></div>
        <div class="metric-percent ${percentClass}">${pct}%</div>
      </div>
    </div>
  `;
}

function renderTabButton(key, stat, idx) {
  const isSignInTab = key === 'signin-during';
  const hasSignInFails = workflowStats['signin-during'].failed > 0;
  const active = (hasSignInFails && isSignInTab) || (!hasSignInFails && idx === 0) ? 'active' : '';
  
  let badgeClass = 'pass';
  if (stat.total === 0) {
    badgeClass = 'skip';
  } else if (stat.failed > 0) {
    badgeClass = 'fail';
  }

  return `
    <button class="tab-link ${active}" onclick="switchTab('${key}', this)">
      ${stat.title} <span class="tab-badge ${badgeClass}">${stat.total}</span>
    </button>
  `;
}

function renderRunRow(run, stageKey, source) {
  const isFail = run.status === 'FAIL';
  
  // Construct local rerun command
  let rerunCmd = '';
  if (isFail) {
    const isNew = stageKey === 'new-user';
    const file = isNew ? 'tests/new_user/newuser.ppv.spec.ts' : 'tests/existing_user/existinguser.ppv.spec.ts';
    
    let userState = 'freemium';
    let planVal = 'standard_monthly';
    
    if (run.dirName.includes('freemium')) userState = 'freemium';
    else if (run.dirName.includes('frozen')) userState = 'frozen';
    else if (run.dirName.includes('active_')) userState = 'active_standard_monthly';
    
    if (run.dirName.includes('standard_monthly')) planVal = 'standard_monthly';
    else if (run.dirName.includes('standard_apm')) planVal = 'standard_apm';
    else if (run.dirName.includes('ultimate_apm')) planVal = 'ultimate_apm';
    else if (run.dirName.includes('ultimate_upfront')) planVal = 'ultimate_upfront';
    
    rerunCmd = `DAZN_REGION=${country} PPV_CONFIG=${ppvConfig} SOURCE=${source} PLAN=${planVal} USER_STATE=${userState} npx playwright test ${file}`;
  }

  // Determine evidence links matching exact UI labels: PDF | HTML | Video | Playwright
  const links = [];
  if (run.pdfPath) links.push(`<a href="${run.pdfPath}" target="_blank">PDF</a>`);
  if (run.customHtmlPath) links.push(`<a href="${run.customHtmlPath}" target="_blank">HTML</a>`);
  if (run.videoPath) links.push(`<a href="${run.videoPath}" target="_blank">Video</a>`);
  if (run.playwrightHtmlPath) links.push(`<a href="${run.playwrightHtmlPath}" target="_blank">Playwright</a>`);
  
  if (links.length === 0 && run.rawDirLink) {
    links.push(`<a href="${run.rawDirLink}" target="_blank">Files Folder</a>`);
  }

  const escapedCmd = rerunCmd.replace(/'/g, "\\'");
  
  // Format USER PROFILE / PLAN column:
  // For New User: 'new user / <plan>'
  // For Existing Users: '<user status> / <plan>'
  let rowTitle = run.matrixLabel;
  if (stageKey === 'new-user') {
    rowTitle = `new user / ${run.matrixLabel}`;
  }

  return `
    <tr class="${isFail ? 'failed-row' : ''}">
      <td>
        <div><strong>${rowTitle}</strong></div>
      </td>
      <td>
        <span class="badge ${run.status.toLowerCase()}">${run.status}</span>
        ${run.jiraUrl ? `<a href="${run.jiraUrl}" target="_blank" class="badge jira-badge">${run.jiraKey}</a>` : ''}
      </td>
      <td>${run.duration}</td>
      <td>
        <div class="links-cell">
          ${links.join(' | ')}
          ${isFail ? `<button class="btn-copy" onclick="copyCommand('${escapedCmd}', this)">Copy Rerun Cmd</button>` : ''}
        </div>
        ${isFail && run.errorMsg ? `
          <details style="margin-top: 8px;">
            <summary style="cursor: pointer; color: var(--text-muted); font-size: 12px;">View Failure Details</summary>
            <div class="err-details">${run.errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          </details>
        ` : ''}
      </td>
    </tr>
  `;
}

function renderGroup(g, stageKey) {
  const passedCount = g.runs.filter(r => r.status === 'PASS').length;
  const totalCount = g.runs.length;
  return `
    <div class="group-container" data-source="${g.source.toLowerCase()}">
      <div class="group-header ${g.status === 'FAIL' ? 'fail' : 'pass'}" onclick="toggleGroup(this)">
        <strong>${g.source}</strong>
        <span class="badge ${g.status === 'FAIL' ? 'fail' : 'pass'}">${passedCount} / ${totalCount} PASSED</span>
      </div>
      <div class="group-content">
        <table>
          <thead>
            <tr>
              <th style="width: 40%;">USER PROFILE / PLAN</th>
              <th style="width: 15%;">STATUS</th>
              <th style="width: 15%;">DURATION</th>
              <th style="width: 30%;">EVIDENCE / LINKS</th>
            </tr>
          </thead>
          <tbody>
            ${g.runs.map(run => renderRunRow(run, stageKey, g.source)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderTabContent(key, stat, idx) {
  const isSignInTab = key === 'signin-during';
  const hasSignInFails = workflowStats['signin-during'].failed > 0;
  const active = (hasSignInFails && isSignInTab) || (!hasSignInFails && idx === 0) ? 'active' : '';

  return `
    <div id="tab-${key}" class="tab-content ${active}">
      ${stat.groupedRuns.map(g => renderGroup(g, key)).join('')}
    </div>
  `;
}

// Generate the final HTML report using helper functions
const htmlReport = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reportTitle}</title>
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: #151d30;
      --border-color: #24324f;
      --text-main: #f1f5f9;
      --text-muted: #64748b;
      --primary: #3b82f6;
      --success: #10b981;
      --failure: #f43f5e;
      --warning: #f59e0b;
      --skip: #475569;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-main);
      margin: 0;
      padding: 24px;
    }
    header {
      margin-bottom: 24px;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 26px;
      font-weight: 700;
    }
    .meta {
      font-size: 14px;
      color: var(--text-muted);
      display: flex;
      gap: 20px;
    }
    .meta strong {
      color: var(--text-main);
    }
    
    .stages-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .stage-card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
    }
    .stage-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 8px;
      color: var(--text-main);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .stage-card.has-fails {
      border-color: rgba(244, 63, 94, 0.4);
    }
    .stage-metrics {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .metric-value {
      font-size: 32px;
      font-weight: 700;
      line-height: 1;
    }
    .metric-value span {
      font-size: 16px;
      color: var(--text-muted);
      font-weight: 400;
    }
    .metric-percent {
      font-size: 14px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 6px;
    }
    .metric-percent.pass {
      background-color: rgba(16, 185, 129, 0.1);
      color: var(--success);
    }
    .metric-percent.fail {
      background-color: rgba(244, 63, 94, 0.1);
      color: var(--failure);
    }
    .metric-percent.skip {
      background-color: rgba(100, 116, 139, 0.1);
      color: var(--text-muted);
    }

    .tabs-nav {
      display: flex;
      border-bottom: 1px solid var(--border-color);
      gap: 8px;
      margin-bottom: 20px;
      overflow-x: auto;
      overflow-y: hidden;
    }
    .tab-link {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 12px 20px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      position: relative;
      white-space: nowrap;
      transition: color 0.2s;
    }
    .tab-link:hover {
      color: var(--text-main);
    }
    .tab-link.active {
      color: var(--primary);
    }
    .tab-link.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background-color: var(--primary);
    }
    .tab-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 9999px;
      margin-left: 6px;
    }
    .tab-badge.pass {
      background-color: rgba(16, 185, 129, 0.15);
      color: var(--success);
    }
    .tab-badge.fail {
      background-color: rgba(244, 63, 94, 0.15);
      color: var(--failure);
    }
    .tab-badge.skip {
      background-color: rgba(100, 116, 139, 0.15);
      color: var(--text-muted);
    }

    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }

    .controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .search-box {
      flex-grow: 1;
      max-width: 400px;
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
    }

    .group-header {
      background-color: rgba(255,255,255,0.02);
      padding: 12px 16px;
      font-weight: 600;
      border: 1px solid var(--border-color);
      border-radius: 8px 8px 0 0;
      margin-top: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    .group-header:hover {
      background-color: rgba(255,255,255,0.04);
    }
    .group-header.fail {
      border-left: 4px solid var(--failure);
    }
    .group-header.pass {
      border-left: 4px solid var(--success);
    }
    .group-content {
      margin-bottom: 16px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-top: none;
      border-radius: 0 0 8px 8px;
      overflow: hidden;
    }
    th, td {
      padding: 10px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
      font-size: 14px;
    }
    th {
      background-color: rgba(255,255,255,0.01);
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }
    tr.failed-row {
      background-color: rgba(244, 63, 94, 0.02);
    }
    tr.failed-row td {
      border-bottom-color: rgba(244, 63, 94, 0.1);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.pass {
      background-color: rgba(16, 185, 129, 0.15);
      color: var(--success);
    }
    .badge.fail {
      background-color: rgba(244, 63, 94, 0.15);
      color: var(--failure);
    }
    .badge.skip {
      background-color: rgba(100, 116, 139, 0.15);
      color: var(--skip);
    }
    
    .jira-badge {
      background-color: rgba(59, 130, 246, 0.15);
      color: var(--primary);
      text-decoration: none;
      margin-left: 8px;
    }
    .jira-badge:hover {
      background-color: rgba(59, 130, 246, 0.25);
    }

    .btn-copy {
      background-color: rgba(255,255,255,0.05);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      margin-left: 8px;
    }
    .btn-copy:hover {
      background-color: rgba(255,255,255,0.1);
      border-color: var(--primary);
    }

    .links-cell {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .links-cell a {
      color: var(--primary);
      text-decoration: none;
      font-size: 13px;
    }
    .links-cell a:hover {
      text-decoration: underline;
    }
    
    .err-details {
      margin-top: 8px;
      background-color: #1a080c;
      border: 1px solid rgba(244, 63, 94, 0.3);
      border-left: 4px solid var(--failure);
      border-radius: 6px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #fecdd3;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
    details summary {
      cursor: pointer;
      color: var(--text-muted);
      font-size: 12px;
      user-select: none;
      outline: none;
    }
    details summary:hover {
      color: var(--text-main);
    }
  </style>
</head>
<body>
  <header>
    <h1>${reportTitle}</h1>
    <div class="meta">
      <div>PPV: <strong>${ppvDisplayName}</strong></div>
      <div>Country: <strong>${country}</strong></div>
      <div>Run ID: <strong>${runId}</strong></div>
    </div>
  </header>

  <!-- 3 Workflow-level progress columns -->
  <div class="stages-summary">
    ${Object.entries(workflowStats).map(([key, stat]) => renderStageCard(key, stat)).join('')}
  </div>

  <!-- Tab Buttons -->
  <div class="tabs-nav">
    ${Object.entries(workflowStats).map(([key, stat], idx) => renderTabButton(key, stat, idx)).join('')}
  </div>

  <div class="controls">
    <input type="text" class="search-box" placeholder="Search surfacing points, plans, errors..." id="search" oninput="filterTable()">
  </div>

  <!-- Tab Contents -->
  ${Object.entries(workflowStats).map(([key, stat], idx) => renderTabContent(key, stat, idx)).join('')}

  <script>
    function switchTab(tabId, btn) {
      document.querySelectorAll('.tab-link').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
      filterTable();
    }

    function toggleGroup(header) {
      const content = header.nextElementSibling;
      if (content.style.display === 'none') {
        content.style.display = 'block';
      } else {
        content.style.display = 'none';
      }
    }

    function filterTable() {
      const searchVal = document.getElementById('search').value.toLowerCase();
      const activeTabContent = document.querySelector('.tab-content.active');
      if (!activeTabContent) return;

      const containers = activeTabContent.querySelectorAll('.group-container');

      containers.forEach(container => {
        const sourceName = container.getAttribute('data-source');
        const rows = container.querySelectorAll('tbody tr');
        let groupHasMatch = false;

        rows.forEach(row => {
          const rowText = row.innerText.toLowerCase();
          const matches = rowText.includes(searchVal) || sourceName.includes(searchVal);
          
          if (matches) {
            row.style.display = '';
            groupHasMatch = true;
          } else {
            row.style.display = 'none';
          }
        });

        if (groupHasMatch) {
          container.style.display = 'block';
        } else {
          container.style.display = 'none';
        }
      });
    }

    function copyCommand(cmd, btn) {
      navigator.clipboard.writeText(cmd).then(() => {
        const originalText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.style.borderColor = '#10b981';
        btn.style.color = '#10b981';
        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 1500);
      }).catch(err => {
        console.error('Failed to copy command:', err);
      });
    }
  </script>
</body>
</html>
`;

// Save HTML report to index.html
const indexPath = path.join(baseDir, 'index.html');
fs.writeFileSync(indexPath, htmlReport, 'utf-8');
console.log(`📄 Consolidated HTML report written to: ${indexPath}`);

// Generate GitHub Actions Step Summary (Markdown)
if (summaryFile) {
  let md = `## 📊 ${reportTitle}\n\n`;
  md += `**PPV**: \`${ppvDisplayName}\` · **Country**: \`${country}\`\n\n`;
  
  md += `### 📈 Workflow Level Pass Rates\n`;
  md += `| Workflow / Journey | Pass / Total | Pass Rate | Status |\n`;
  md += `| :--- | :---: | :---: | :---: |\n`;
  
  Object.entries(workflowStats).forEach(([key, stat]) => {
    const pct = stat.total > 0 ? ((stat.passed / stat.total) * 100).toFixed(1) : '0.0';
    const status = stat.total === 0 ? '⚪ NOT RUN' : (stat.failed > 0 ? `🔴 FAIL (${stat.failed} Fails)` : `🟢 PASS`);
    md += `| **${stat.title}** | \`${stat.passed} / ${stat.total}\` | **${pct}%** | ${status} |\n`;
  });
  
  md += `\n---\n\n`;

  // Failures section
  let hasAnyFailures = false;
  let failuresMd = `### 🚨 Failed Jobs (Grouped by Workflow)\n\n`;

  Object.entries(workflowStats).forEach(([key, stat]) => {
    const failedRuns = stat.runs.filter(r => r.status === 'FAIL');
    if (failedRuns.length > 0) {
      hasAnyFailures = true;
      failuresMd += `#### 🔴 ${stat.title} Failures (${failedRuns.length})\n\n`;
      
      failedRuns.forEach((run, index) => {
        const jiraLabel = run.jiraUrl ? ` &nbsp;**Jira**: [${run.jiraKey}](${run.jiraUrl})` : '';
        const pdfLinkText = run.pdfPath ? ` &nbsp;**PDF**: [pdf](${run.pdfPath})` : '';
        const customHtmlText = run.customHtmlPath ? ` &nbsp;**HTML**: [html](${run.customHtmlPath})` : '';
        const videoLinkText = run.videoPath ? ` &nbsp;**Video**: [video](${run.videoPath})` : '';
        const playwrightLinkText = run.playwrightHtmlPath ? ` &nbsp;**Playwright**: [playwright](${run.playwrightHtmlPath})` : '';
        
        failuresMd += `${index + 1}. **Source**: \`${run.dirName}\` &nbsp;**Duration**: \`${run.duration}\`${jiraLabel}${pdfLinkText}${customHtmlText}${videoLinkText}${playwrightLinkText}\n`;
        if (run.errorMsg) {
          const cleanErr = run.errorMsg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          failuresMd += `<details>\n<summary><b>View Error Log</b></summary>\n\n\`\`\`\n${cleanErr}\n\`\`\`\n\n</details>\n\n`;
        }
      });
    }
  });

  if (hasAnyFailures) {
    md += failuresMd;
  } else {
    const grandTotal = Object.values(workflowStats).reduce((acc, stat) => acc + stat.total, 0);
    md += `### 🟢 All ${grandTotal} tests passed successfully!\n\n`;
  }
  
  md += `*Consolidated HTML Dashboard, Playwright, PDF, and screenshots are archived in the workflow artifacts.*`;
  
  fs.writeFileSync(summaryFile, md, 'utf-8');
  console.log(`📝 Consolidated markdown summary written to GITHUB_STEP_SUMMARY: ${summaryFile}`);
}
