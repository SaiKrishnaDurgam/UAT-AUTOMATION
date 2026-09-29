import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { createHash } from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });


type ValidationResult = {
  page?: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
  status?: string;
  screenshot?: string;
};

type JiraContext = {
  region: string;
  environment: string;
  platform: string;
  flow: string;
  event?: string;
  userState?: string;
  source?: string;
};

type JiraValidationReport = {
  results: ValidationResult[];
  context: JiraContext;
  htmlReportPath?: string | null;
  pdfReportPath?: string | null;
};

export type JiraTicket = {
  key: string;
  url: string;
};

const MAX_ATTACHMENTS = 12;
const JIRA_REQUEST_TIMEOUT_MS = Number(process.env.JIRA_REQUEST_TIMEOUT_MS) || 15_000;

function attachmentMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}

type JiraCreateField = {
  fieldId?: string;
  key?: string;
  id?: string;
  name?: string;
  schema?: { type?: string; items?: string };
  allowedValues?: Array<{ id?: string; value?: string; name?: string }>;
};

type JiraFieldOption = { id?: string; value?: string };
type JiraFieldValue = JiraFieldOption | JiraFieldOption[];

type JiraMetadataPage<T> = {
  issueTypes?: T[];
  fields?: T[];
  values?: T[];
  startAt?: number;
  total?: number;
};

function jiraConfig() {
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) return null;

  return {
    baseUrl,
    auth: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
    projectKey: process.env.JIRA_PROJECT_KEY || 'QAR',
    issueType: process.env.JIRA_ISSUE_TYPE || 'Bug',
  };
}

async function requestJira(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(JIRA_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Jira request timed out after ${JIRA_REQUEST_TIMEOUT_MS}ms`));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function asText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function configuredJiraFields(context: JiraContext) {
  const fields = [
    {
      label: 'region',
      fieldName: process.env.JIRA_REGION_FIELD_NAME || 'Region',
      value: process.env.JIRA_REGION || context.region,
    },
    {
      label: 'environment',
      fieldName: process.env.JIRA_DAZN_ENVIRONMENT_FIELD_NAME || 'DAZN Environment',
      value: process.env.JIRA_DAZN_ENVIRONMENT || 'Live Prod',
    },
    {
      label: 'platform',
      fieldName: process.env.JIRA_PLATFORM_FIELD_NAME || 'Platform - required',
      value: process.env.JIRA_PLATFORM || context.platform || 'Desktop Web',
    },
  ];

  const missing = fields.filter(field => !field.fieldName || !field.value).map(field => field.label);
  if (missing.length) {
    throw new Error(`workflow Jira configuration is missing: ${missing.join(', ')}`);
  }
  return fields as Array<{ label: string; fieldName: string; value: string }>;
}

async function loadJiraMetadataPages<T>(
  url: string,
  responseField: keyof Pick<JiraMetadataPage<T>, 'issueTypes' | 'fields' | 'values'>,
  label: string,
  config: NonNullable<ReturnType<typeof jiraConfig>>
): Promise<T[]> {
  const results: T[] = [];
  const pageSize = 50;

  for (let startAt = 0; startAt < 10000; startAt += pageSize) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await requestJira(
      `${url}${separator}startAt=${startAt}&maxResults=${pageSize}`,
      'GET',
      { Authorization: config.auth, Accept: 'application/json' }
    );
    if (response.statusCode !== 200) {
      const details = response.body.replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`could not load Jira ${label} metadata (HTTP ${response.statusCode}): ${details || 'no response body'}`);
    }

    const page = JSON.parse(response.body) as JiraMetadataPage<T>;
    const entries = page[responseField] || [];
    results.push(...entries);

    if (!entries.length || (typeof page.total === 'number' && results.length >= page.total) || entries.length < pageSize) {
      return results;
    }
  }

  throw new Error(`could not load all Jira ${label} metadata: pagination limit reached`);
}

async function resolveJiraCreateFields(
  config: NonNullable<ReturnType<typeof jiraConfig>>,
  context: JiraContext
): Promise<Record<string, JiraFieldValue>> {
  const issueTypes = await loadJiraMetadataPages<{ id?: string; name?: string }>(
    `${config.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(config.projectKey)}/issuetypes`,
    'issueTypes',
    'issue type',
    config
  );
  const issueType = issueTypes.find(type => normalise(type.name || '') === normalise(config.issueType));
  if (!issueType?.id) throw new Error(`Jira issue type "${config.issueType}" was not found for ${config.projectKey}`);

  const availableFields = await loadJiraMetadataPages<JiraCreateField>(
    `${config.baseUrl}/rest/api/3/issue/createmeta/${encodeURIComponent(config.projectKey)}/issuetypes/${encodeURIComponent(issueType.id)}`,
    'fields',
    'field',
    config
  );
  const resolved: Record<string, JiraFieldValue> = {};

  for (const configured of configuredJiraFields(context)) {
    const field = availableFields.find(candidate => normalise(candidate.name || '') === normalise(configured.fieldName));
    const fieldKey = field?.fieldId || field?.key || field?.id;
    if (!fieldKey) throw new Error(`Jira create field "${configured.fieldName}" was not found`);

    const option = field.allowedValues?.find(candidate =>
      normalise(candidate.value || candidate.name || '') === normalise(configured.value)
    );
    if (field.allowedValues?.length && !option) {
      throw new Error(`"${configured.value}" is not a valid option for Jira field "${configured.fieldName}"`);
    }
    const selection = option?.id ? { id: option.id } : { value: configured.value };
    // Jira's metadata explicitly tells us whether a custom dropdown accepts
    // one option or an array of options; do not hardcode per-field behavior.
    resolved[fieldKey] = field.schema?.type === 'array' ? [selection] : selection;
  }
  return resolved;
}

function paragraph(text: string) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text: text.slice(0, 3000) }],
  };
}

function heading(text: string) {
  return {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text }],
  };
}

function bulletList(items: string[]) {
  return {
    type: 'bulletList',
    content: items.map(item => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  };
}

function orderedList(items: string[]) {
  return {
    type: 'orderedList',
    content: items.map(item => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  };
}

function describeFailure(failure: ValidationResult): string {
  const page = asText(failure.page) || 'PPV page';
  const field = asText(failure.field) || 'PPV content';
  return `${page} — ${field}`;
}

function buildIssueSummary(context: JiraContext, failures: ValidationResult[]): string {
  const summaryPrefix = '[Automation] ';
  const ppvName = asText(context.event) || 'PPV';
  const first = failures[0];
  if (!first) return `${summaryPrefix}${ppvName} | ${context.flow} — validation failure`.slice(0, 250);

  const expected = asText(first.expected);
  const actual = asText(first.actual);
  const mismatch = expected && actual
    ? `${describeFailure(first)} incorrect: expected "${expected}", shown "${actual}"`
    : `${describeFailure(first)} validation failed`;
  const suffix = failures.length > 1 ? ` (+${failures.length - 1} more)` : '';
  return `${summaryPrefix}${ppvName} | ${mismatch}${suffix}`.slice(0, 250);
}

function validationFingerprint(context: JiraContext, failures: ValidationResult[]): string {
  // A defect is identified by its displayed mismatch, independent of which
  // PPV surface, plan, or user flow discovered it.
  const signature = failures
    .map(failure => [
      canonicalFailureField(asText(failure.field)),
      normalise(asText(failure.expected)),
      normalise(asText(failure.actual)),
    ].join('|'))
    .sort()
    .join('||');
  const identity = [
    normalise(asText(context.event)),
    normalise(context.region),
    normalise(context.environment),
    normalise(context.platform),
    signature,
  ].join('||');
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function canonicalFailureField(field: string): string {
  const normalised = normalise(field);
  return /(?:ppv\s*(?:name|card\s*title)|event\s*name)/.test(normalised)
    ? 'ppv-name'
    : normalised;
}

async function findOpenIssueByFingerprint(
  fingerprint: string,
  config: NonNullable<ReturnType<typeof jiraConfig>>
): Promise<string | null> {
  const label = `ppv-fingerprint-${fingerprint}`;
  const jql = `project = ${config.projectKey} AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`;
  const payload = Buffer.from(JSON.stringify({ jql, maxResults: 1, fields: ['key'] }));
  const endpoints = [
    `${config.baseUrl}/rest/api/3/search/jql`,
    `${config.baseUrl}/rest/api/3/search`,
  ];
  let lastError = '';

  for (const endpoint of endpoints) {
    const response = await requestJira(endpoint, 'POST', {
      Authorization: config.auth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
    }, payload);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const body = JSON.parse(response.body) as { issues?: Array<{ key?: string }>; values?: Array<{ key?: string }> };
      return body.issues?.[0]?.key || body.values?.[0]?.key || null;
    }
    // Jira Cloud search API availability differs by tenant. Try both versions;
    // if neither is available, preserve the original ticket-creation path.
    lastError = `HTTP ${response.statusCode}: ${response.body.slice(0, 300)}`;
  }
  console.warn(`⚠️ [Jira] Duplicate search unavailable (${lastError}); creating a new ticket so the validation failure is not lost.`);
  return null;
}

async function addDuplicateOccurrenceComment(
  issueKey: string,
  context: JiraContext,
  failures: ValidationResult[],
  runMetadata: string,
  config: NonNullable<ReturnType<typeof jiraConfig>>
): Promise<void> {
  const payload = Buffer.from(JSON.stringify({
    body: {
      type: 'doc',
      version: 1,
      content: [
        heading('Additional automated occurrence'),
        paragraph(`The same PPV validation mismatch was found again via ${context.source || 'an unknown source'}.`),
        bulletList([
          `Flow: ${context.flow}`,
          `Source: ${context.source || 'Unknown'}`,
          `User state: ${context.userState || 'New user'}`,
          runMetadata,
        ]),
        heading(`Validation details (${failures.length})`),
        ...failures.map(failure => paragraph(
          `[${asText(failure.page)}] ${asText(failure.field)} — expected: "${asText(failure.expected)}"; actual: "${asText(failure.actual)}"`
        )),
        paragraph('Current run evidence is attached to this existing issue.'),
      ],
    },
  }));
  const response = await requestJira(
    `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    'POST',
    {
      Authorization: config.auth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
    },
    payload
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`could not add duplicate occurrence comment (HTTP ${response.statusCode}): ${response.body.slice(0, 300)}`);
  }
}

function evidenceAttachmentPaths(report: JiraValidationReport, evidencePath: string | null, failures: ValidationResult[]): string[] {
  return [
    report.htmlReportPath,
    report.pdfReportPath,
    evidencePath,
    ...failures.map(result => result.screenshot),
  ].filter((filePath): filePath is string => Boolean(filePath && fs.existsSync(filePath)));
}

async function attachEvidence(
  issueKey: string,
  report: JiraValidationReport,
  evidencePath: string | null,
  failures: ValidationResult[],
  config: NonNullable<ReturnType<typeof jiraConfig>>
): Promise<void> {
  for (const filePath of [...new Set(evidenceAttachmentPaths(report, evidencePath, failures))].slice(0, MAX_ATTACHMENTS)) {
    try {
      await attachFile(issueKey, filePath, config);
      console.log(`📎 [Jira] Attached ${path.basename(filePath)} to ${issueKey}.`);
    } catch (error: any) {
      console.warn(`⚠️ [Jira] Could not attach ${path.basename(filePath)}: ${error?.message || error}`);
    }
  }
}

function createEvidenceFile(
  failures: ValidationResult[],
  context: JiraContext,
  runId: string
): string | null {
  try {
    const evidenceDir = path.resolve(process.cwd(), 'test-results', 'jira-evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(
      evidenceDir,
      `validation-failures-${runId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}.json`
    );
    const evidence = {
      generatedAt: new Date().toISOString(),
      trigger: 'GitHub Actions validation failure',
      github: {
        repository: process.env.GITHUB_REPOSITORY || null,
        workflow: process.env.GITHUB_WORKFLOW || null,
        job: process.env.GITHUB_JOB || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
        sha: process.env.GITHUB_SHA || null,
        ref: process.env.GITHUB_REF_NAME || null,
        actor: process.env.GITHUB_ACTOR || null,
      },
      runner: {
        name: process.env.RUNNER_NAME || null,
        os: process.env.RUNNER_OS || null,
        architecture: process.arch,
        nodeVersion: process.version,
      },
      context,
      failures: failures.map(({ screenshot, ...failure }) => ({
        ...failure,
        screenshotFilename: screenshot ? path.basename(screenshot) : null,
      })),
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidencePath;
  } catch (error: any) {
    console.warn(`⚠️ [Jira] Could not write diagnostics evidence: ${error?.message || error}`);
    return null;
  }
}

function publishJiraIssueLink(issueKey: string, baseUrl: string): void {
  const issueUrl = `${baseUrl}/browse/${encodeURIComponent(issueKey)}`;
  // GitHub renders URLs in job logs as clickable links.
  console.log(`🔗 [Jira] Ticket: ${issueUrl}`);

  // Also make the ticket prominent in the workflow run's Summary tab.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(
      summaryPath,
      `\n## Jira validation failure\n\n[${issueKey}](${issueUrl}) — ${issueKey} was created automatically for validation failures.\n`
    );
  } catch (error: any) {
    console.warn(`⚠️ [Jira] Could not add ticket link to GitHub job summary: ${error?.message || error}`);
  }
}

async function attachFile(
  issueKey: string,
  filePath: string,
  config: NonNullable<ReturnType<typeof jiraConfig>>
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  const content = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath).replace(/[\r\n"]/g, '_');
  const mimeType = attachmentMimeType(filePath);
  const boundary = `----dazn-jira-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await requestJira(
    `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
    'POST',
    {
      Authorization: config.auth,
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body
  );

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`attachment upload returned HTTP ${response.statusCode}: ${response.body.slice(0, 300)}`);
  }
}

/**
 * Creates a Jira issue only from GitHub Actions and only when the caller has
 * already established that a flow completed successfully but validations failed.
 * All Jira errors are logged and deliberately do not hide the original test failure.
 */
export async function reportValidationFailuresToJira(report: JiraValidationReport): Promise<JiraTicket[]> {
  const tickets: JiraTicket[] = [];
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.DEMO_MODE !== 'true') return tickets;

  const failures = report.results.filter(result => String(result.status).toUpperCase() === 'FAIL');
  if (!failures.length) return tickets;

  const config = jiraConfig();
  if (!config || process.env.JIRA_EMAIL === 'your_jira_email_here' || process.env.JIRA_API_TOKEN === 'your_jira_api_token_here') {
    console.warn('⚠️ [Jira] Validation failures found, but Jira secrets are not configured; skipping ticket creation.');
    return tickets;
  }

  const context = report.context;
  if (context && context.platform) {
    const norm = context.platform.trim().toLowerCase();
    if (norm === 'android') {
      context.platform = 'Android Native App - Mobile';
    } else if (norm === 'ios') {
      context.platform = 'iOS Native App - Mobile';
    } else if (norm === 'web') {
      context.platform = 'Desktop Web';
    }
  }

  const runId = process.env.GITHUB_RUN_ID || 'unknown-run';
  const runMetadata = [
    `Repository: ${process.env.GITHUB_REPOSITORY || 'unknown'}`,
    `Workflow: ${process.env.GITHUB_WORKFLOW || 'unknown'}`,
    `Job: ${process.env.GITHUB_JOB || 'unknown'}`,
    `Run: ${runId} (attempt ${process.env.GITHUB_RUN_ATTEMPT || '1'})`,
    `Commit: ${process.env.GITHUB_SHA || 'unknown'}`,
    `Runner: ${process.env.RUNNER_NAME || 'unknown'} (${process.env.RUNNER_OS || 'unknown'})`,
  ].join(' | ');

  console.log(`🐞 [Jira] Validation-only failure detected; preparing QAR ticket for ${context.flow}.`);
  console.log(`🔎 [Jira] ${runMetadata}`);
  for (const failure of failures) {
    console.log(
      `❌ [Jira] [${asText(failure.page)}] ${asText(failure.field)} | ` +
      `expected="${asText(failure.expected)}" | actual="${asText(failure.actual)}"`
    );
  }
  const failureGroups = new Map<string, ValidationResult[]>();
  for (const failure of failures) {
    const fingerprint = validationFingerprint(context, [failure]);
    const group = failureGroups.get(fingerprint) || [];
    group.push(failure);
    failureGroups.set(fingerprint, group);
  }

  for (const [fingerprint, groupFailures] of failureGroups) {
    // Each Jira ticket represents one underlying mismatch. Multiple occurrences
    // of that exact mismatch share the same ticket and evidence trail.
    const failures = groupFailures;
    const evidencePath = createEvidenceFile(failures, context, runId);
    const summary = buildIssueSummary(context, failures);
  const firstFailure = failures[0];
  const description = {
    type: 'doc',
    version: 1,
    content: [
      heading('Issue'),
      paragraph(
        firstFailure
          ? `${describeFailure(firstFailure)} is incorrect for ${asText(context.event) || 'this PPV'}.`
          : 'A PPV validation failed.'
      ),
      heading('Environment'),
      bulletList([
        `PPV: ${asText(context.event) || 'Unknown'}`,
        `Region: ${context.region}`,
        `DAZN environment: ${context.environment}`,
        `Platform: ${context.platform}`,
        `Flow: ${context.flow}`,
        `Source: ${context.source || 'Unknown'}`,
        `User state: ${context.userState || 'New user'}`,
      ]),
      heading('Steps to reproduce'),
      orderedList([
        `Open DAZN ${context.environment} on ${context.platform} for region ${context.region}.`,
        `Navigate to the ${context.source || 'PPV'} surface for ${asText(context.event) || 'the PPV'}.`,
        `Inspect ${firstFailure ? describeFailure(firstFailure) : 'the validated PPV content'}.`,
      ]),
      heading('Expected result'),
      paragraph(firstFailure ? `Display "${asText(firstFailure.expected)}".` : 'All PPV validations pass.'),
      heading('Actual result'),
      paragraph(firstFailure ? `Displayed "${asText(firstFailure.actual)}".` : 'A PPV validation failed.'),
      heading(`Validation details (${failures.length})`),
      ...failures.map(result => paragraph(
        `[${asText(result.page)}] ${asText(result.field)} — expected: "${asText(result.expected)}"; actual: "${asText(result.actual)}"`
      )),
      heading('Evidence'),
      paragraph('The validation evidence JSON, available failure screenshot(s), and generated report files are attached to this issue.'),
      paragraph(runMetadata),
    ],
  };

  try {
    const existingIssueKey = await findOpenIssueByFingerprint(fingerprint, config);
    if (existingIssueKey) {
      console.log(`♻️ [Jira] Matching open issue ${existingIssueKey} found (fingerprint ${fingerprint}); adding this occurrence instead of creating a duplicate.`);
      await addDuplicateOccurrenceComment(existingIssueKey, context, failures, runMetadata, config);
      await attachEvidence(existingIssueKey, report, evidencePath, failures, config);
      publishJiraIssueLink(existingIssueKey, config.baseUrl);
      tickets.push({
        key: existingIssueKey,
        url: `${config.baseUrl}/browse/${encodeURIComponent(existingIssueKey)}`,
      });
      continue;
    }

    const jiraFields = await resolveJiraCreateFields(config, context);
    console.log(`🧭 [Jira] Workflow Jira fields: ${Object.entries(jiraFields).map(([key, value]) => {
      const selections = Array.isArray(value) ? value : [value];
      return `${key}="${selections.map(selection => selection.id || selection.value).join(',')}"`;
    }).join(' | ')}`);
    const payload = Buffer.from(JSON.stringify({
      fields: {
        project: { key: config.projectKey },
        issuetype: { name: config.issueType },
        summary,
        description,
        ...jiraFields,
        labels: [
          'AI_AUTOMATION',
          'automation',
          'validation-failure',
          'github-actions',
          `ppv-fingerprint-${fingerprint}`,
          `github-run-${runId}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
        ],
      },
    }));
    const response = await requestJira(
      `${config.baseUrl}/rest/api/3/issue`,
      'POST',
      {
        Authorization: config.auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
      },
      payload
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`issue creation returned HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`);
    }

    const issue = JSON.parse(response.body) as { key?: string };
    if (!issue.key) throw new Error('issue creation response did not include an issue key');
    console.log(`🐞 [Jira] Created ${issue.key} for ${failures.length} validation failure(s).`);
    publishJiraIssueLink(issue.key, config.baseUrl);
    tickets.push({
      key: issue.key,
      url: `${config.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    });
    await attachEvidence(issue.key, report, evidencePath, failures, config);
  } catch (error: any) {
    console.warn(`⚠️ [Jira] Could not create validation issue: ${error?.message || error}`);
  }
  }
  return tickets;
}
