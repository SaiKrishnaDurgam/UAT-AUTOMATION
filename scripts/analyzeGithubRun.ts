import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execFileSync } from 'child_process';

const owner = 'Hari1188';
const repo = 'PPV-End-to-End-Automation';
const runId = '28669350081';
const outputDir = path.resolve(process.cwd(), 'reports', `github-run-analysis-${runId}`);
const logsDir = path.join(outputDir, 'logs');

type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  status: string;
  html_url: string;
  started_at?: string;
  completed_at?: string;
  runner_name?: string;
};

type FailureRow = {
  RunId: string;
  JobId: number;
  JobName: string;
  Source: string;
  UserStatus: string;
  Plan: string;
  Conclusion: string;
  Runner: string;
  Category: string;
  Page: string;
  Field: string;
  Expected: string;
  Actual: string;
  ErrorMessage: string;
  LogLine: number | string;
  JobUrl: string;
};

function getToken(): string {
  const output = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const token = output.split('\n').find(line => line.startsWith('password='))?.replace(/^password=/, '').trim();
  if (!token) throw new Error('No GitHub token found from git credential helper.');
  return token;
}

function request(url: string, token: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ppv-run-analysis',
    };
    if (parsedUrl.hostname === 'api.github.com') {
      headers.Authorization = `Bearer ${token}`;
    }

    const req = https.get(url, {
      headers,
    }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectCount < 5) {
        res.resume();
        request(String(res.headers.location), token, redirectCount + 1).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 400) {
          reject(new Error(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error(`Timeout requesting ${url}`));
    });
  });
}

function cleanLogLine(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T[^\s]+Z\s*/, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[📄🥊📋💳📈🌍🎯💎📊⚠️🔍ℹ️🧠]/g, '')
    .trimEnd();
}

function splitName(name: string): { source: string; userStatus: string; plan: string } {
  const [sourcePart, profilePart = ''] = name.split('|').map(part => part.trim());
  const [userStatus = '', plan = ''] = profilePart.split('/').map(part => part.trim());
  return { source: sourcePart, userStatus, plan };
}

function categorize(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('banner')) return 'Banner';
  if (lower.includes('tile') || lower.includes('container not found')) return 'Tile/Container';
  if (lower.includes('validation failure') || lower.includes('expected')) return 'Validation';
  if (lower.includes('country mismatch')) return 'Country';
  if (lower.includes('timeout')) return 'Timeout';
  if (lower.includes('payment')) return 'Payment';
  if (lower.includes('auth') || lower.includes('signin') || lower.includes('password')) return 'Authentication';
  return 'Runtime Error';
}

function makeFailure(job: Job, category: string, page: string, field: string, expected: string, actual: string, message: string, line: number | string): FailureRow {
  const { source, userStatus, plan } = splitName(job.name);
  return {
    RunId: runId,
    JobId: job.id,
    JobName: job.name,
    Source: source,
    UserStatus: userStatus,
    Plan: plan,
    Conclusion: job.conclusion || '',
    Runner: job.runner_name || '',
    Category: category,
    Page: page,
    Field: field,
    Expected: expected,
    Actual: actual,
    ErrorMessage: message,
    LogLine: line,
    JobUrl: job.html_url,
  };
}

function normalizeErrorMessage(message: string): string {
  return message
    .replace(/^❌\s*/, '')
    .replace(/^Test error:\s*Error:\s*/i, '')
    .replace(/^❌\s*/, '')
    .trim();
}

function compactFailures(rows: FailureRow[]): FailureRow[] {
  const compacted = new Map<string, FailureRow>();

  for (const row of rows) {
    const normalizedMessage = normalizeErrorMessage(row.ErrorMessage);
    const key = row.Category === 'Validation'
      ? [row.JobId, row.Category, row.Field, row.Expected, row.Actual].join('|')
      : [row.JobId, row.Category, row.Field, row.Expected, row.Actual, normalizedMessage].join('|');
    const existing = compacted.get(key);

    if (!existing) {
      compacted.set(key, { ...row, ErrorMessage: normalizedMessage || row.ErrorMessage });
      continue;
    }

    if (!existing.Page && row.Page) existing.Page = row.Page;
    if (!existing.Expected && row.Expected) existing.Expected = row.Expected;
    if (!existing.Actual && row.Actual) existing.Actual = row.Actual;
    if (!existing.LogLine && row.LogLine) existing.LogLine = row.LogLine;
  }

  return [...compacted.values()];
}

function parseFailures(job: Job, logText: string): FailureRow[] {
  const rawLines = logText.split(/\r?\n/);
  const lines = rawLines.map(cleanLogLine);
  const rows: FailureRow[] = [];
  const seen = new Set<string>();

  const push = (row: FailureRow) => {
    const key = row.Category === 'Validation'
      ? [row.JobId, row.Category, row.Page, row.Field, row.Expected, row.Actual].join('|')
      : [row.JobId, row.Category, row.Page, row.Field, row.Expected, row.Actual, row.ErrorMessage].join('|');
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^(?:>|\d+\s+\|)\s/.test(line)) continue;

    let m = line.match(/^-\s+\[([^\]]+)\]\s+([^:]+):\s+expected\s+"([^"]*)",\s+actual\s+"([^"]*)"/i);
    if (m) {
      push(makeFailure(job, 'Validation', m[1].trim(), m[2].trim(), m[3], m[4], line, i + 1));
      continue;
    }

    m = line.match(/^(?:❌\s*)?Test error:\s*Error:\s*(?:❌\s*)?(.+)$/i);
    if (m) {
      const msg = m[1].trim();
      if (!/completed navigation but had \d+ validation failure/i.test(msg)) {
        push(makeFailure(job, categorize(msg), inferPage(lines, i), '', '', '', msg, i + 1));
      }
      continue;
    }

    m = line.match(/^\s*(?:✘|❌)\s+\[([^\]]+)\]\s*(?:expected="([^"]*)")?\s*(?:actual="([^"]*)")?/);
    if (m) {
      const field = m[1].trim();
      const expected = (m[2] || '').trim();
      const actual = (m[3] || '').trim();
      const category = field.toLowerCase().includes('banner') ? 'Banner' : 'Validation';
      push(makeFailure(job, category, inferPage(lines, i), field, expected, actual, line, i + 1));
      continue;
    }

    m = line.match(/^\s*(?:✘|❌)\s*(.+)$/);
    if (m) {
      const field = m[1].trim();
      if (/^(?:Passed|Failed|Pass %)\s*:|^Test error:|^\d+\s+\[chromium\]|^Flow ".+" completed navigation/i.test(field)) {
        continue;
      }
      let expected = '';
      let actual = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const next = lines[j].trim();
        if (j > i + 1 && /^\s*(?:✘|❌)\s+\S/.test(next)) break;
        const exp = next.match(/^expected\s*:\s*(.+)$/i);
        const act = next.match(/^actual\s*:\s*(.+)$/i);
        if (exp) expected = exp[1].trim();
        if (act) actual = act[1].trim();
      }
      if (expected || actual) {
        push(makeFailure(job, 'Validation', inferPage(lines, i), field, expected, actual, line, i + 1));
      }
      continue;
    }

    m = line.match(/^(?:Test error:\s*)?Error:\s*(.+)$/);
    if (m) {
      const msg = m[1].trim();
      if (!/Process completed with exit code|completed navigation but had \d+ validation failure/i.test(msg)) {
        push(makeFailure(job, categorize(msg), inferPage(lines, i), '', '', '', msg, i + 1));
      }
      continue;
    }

    if (/Unable to find|not found|elementHandle failed|cannot click Buy Now|PPV container not found|Country mismatch/i.test(line)) {
      push(makeFailure(job, categorize(line), inferPage(lines, i), '', '', '', line, i + 1));
    }
  }

  return rows;
}

function inferPage(lines: string[], index: number): string {
  for (let i = index; i >= Math.max(0, index - 80); i--) {
    const line = lines[i].trim();
    let m = line.match(/^([A-Za-z ]+)\s+\d+\s+\d+\s+Total/i);
    if (m) return m[1].trim();
    m = line.match(/^([A-Za-z ]+?)\s+(?:✅\s*)?\d+\s+(?:❌\s*)?\d+\s+Total/i);
    if (m) return m[1].trim();
    m = line.match(/Validating\s+(.+?)\s+page/i);
    if (m) return m[1].trim();
    m = line.match(/👉\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return '';
}

async function getAllJobs(token: string): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
    const body = await request(url, token);
    const parsed = JSON.parse(body);
    jobs.push(...parsed.jobs);
    if (!parsed.jobs || parsed.jobs.length < 100) break;
  }
  return jobs;
}

function appendSheet(wb: XLSX.WorkBook, name: string, rows: any[]) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
  const keys = Object.keys(rows[0] || {});
  if (keys.length) {
    ws['!cols'] = keys.map(key => ({
      wch: Math.min(80, Math.max(key.length, ...rows.map(row => String(row[key] ?? '').length)) + 2),
    }));
  }
  XLSX.utils.book_append_sheet(wb, ws, name);
}

async function main() {
  fs.mkdirSync(logsDir, { recursive: true });
  const token = getToken();
  const jobs = await getAllJobs(token);
  console.log(`Fetched ${jobs.length} jobs`);

  const jobRows = jobs.map(job => {
    const parsed = splitName(job.name);
    return {
      RunId: runId,
      JobId: job.id,
      JobName: job.name,
      Source: parsed.source,
      UserStatus: parsed.userStatus,
      Plan: parsed.plan,
      Status: job.status,
      Conclusion: job.conclusion || '',
      Runner: job.runner_name || '',
      StartedAt: job.started_at || '',
      CompletedAt: job.completed_at || '',
      JobUrl: job.html_url,
    };
  });

  const failureRows: FailureRow[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const logPath = path.join(logsDir, `${job.id}.log`);
    let logText = '';
    try {
      if (fs.existsSync(logPath)) {
        logText = fs.readFileSync(logPath, 'utf8');
      } else {
        logText = await request(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, token);
        fs.writeFileSync(logPath, logText);
      }
      failureRows.push(...parseFailures(job, logText));
    } catch (error: any) {
      failureRows.push(makeFailure(job, 'Log Download', '', '', '', '', error.message, ''));
    }
    if ((i + 1) % 25 === 0 || i === jobs.length - 1) {
      console.log(`Processed ${i + 1}/${jobs.length}`);
    }
  }

  const failureCountByJob = new Map<number, number>();
  const primaryFailureRows = compactFailures(failureRows);
  for (const row of primaryFailureRows) failureCountByJob.set(row.JobId, (failureCountByJob.get(row.JobId) || 0) + 1);
  const enrichedJobRows = jobRows.map(row => ({
    ...row,
    ParsedFailureRows: failureCountByJob.get(row.JobId) || 0,
  }));

  const summaryByCategory = Object.values(primaryFailureRows.reduce<Record<string, any>>((acc, row) => {
    const key = [row.Source, row.UserStatus, row.Plan, row.Category].join('|');
    acc[key] ||= {
      Source: row.Source,
      UserStatus: row.UserStatus,
      Plan: row.Plan,
      Category: row.Category,
      Count: 0,
    };
    acc[key].Count++;
    return acc;
  }, {}));

  const wb = XLSX.utils.book_new();
  appendSheet(wb, 'Job Summary', enrichedJobRows);
  appendSheet(wb, 'Failure Details', primaryFailureRows);
  appendSheet(wb, 'Failure Summary', summaryByCategory);
  appendSheet(wb, 'Raw Parsed Details', failureRows);

  const outputPath = path.join(outputDir, `GB_PROD_existing_already_signed_in_run_${runId}_analysis.xlsx`);
  XLSX.writeFile(wb, outputPath);
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify({
    runId,
    jobCount: jobs.length,
    failedJobs: jobs.filter(job => job.conclusion === 'failure').length,
    successJobs: jobs.filter(job => job.conclusion === 'success').length,
    parsedFailureRows: primaryFailureRows.length,
    rawParsedFailureRows: failureRows.length,
    outputPath,
  }, null, 2));

  console.log(`Excel: ${outputPath}`);
  console.log(`Jobs: ${jobs.length}`);
  console.log(`Failed jobs: ${jobs.filter(job => job.conclusion === 'failure').length}`);
  console.log(`Failure rows: ${primaryFailureRows.length}`);
  console.log(`Raw parsed rows: ${failureRows.length}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
