const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT_DIR = __dirname;
const ENV_PATH = path.join(ROOT_DIR, '.env');

loadEnvFile(ENV_PATH);

const PORT = Number.parseInt(process.env.PORT || '8000', 10);
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_PAGE_LIMIT = 100;
const MONTHLY_SYNC_DAY = 1;
const MONTHLY_SYNC_HOUR = 10;
const MONTHLY_SYNC_MINUTE = 0;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

let releaseNotesCache = null;
let releaseNotesSyncPromise = null;
let nextScheduledSyncAt = null;
let lastSyncError = null;

const FIELD_DEFINITIONS = [
  {
    appField: 'Description for RN',
    envName: 'JIRA_FIELD_DESCRIPTION_FOR_RN',
    names: ['Description for RN', 'Custom field (Description for RN)']
  },
  {
    appField: 'University Name',
    envName: 'JIRA_FIELD_UNIVERSITY_NAME',
    names: ['University Name', 'Custom field (University Name)']
  },
  {
    appField: 'Program Name',
    envName: 'JIRA_FIELD_PROGRAM_NAME',
    names: ['Program Name', 'Custom field (Program Name)']
  },
  {
    appField: 'Business Unit',
    envName: 'JIRA_FIELD_BUSINESS_UNIT',
    names: ['Business Unit', 'Custom field (Business Unit)']
  },
  {
    appField: 'Business Docs',
    envName: 'JIRA_FIELD_BUSINESS_DOCS',
    names: ['Business Docs', 'Custom field (Business Docs)']
  },
  {
    appField: 'Tutorial Doc',
    envName: 'JIRA_FIELD_TUTORIAL_DOC',
    names: ['Tutorial Doc', 'Custom field (Tutorial Doc)']
  },
  {
    appField: 'Skill Set',
    envName: 'JIRA_FIELD_SKILL_SET',
    names: ['Skill Set', 'Custom field (Skill Set)']
  },
  {
    appField: 'Product Manager',
    envName: 'JIRA_FIELD_PRODUCT_MANAGER',
    names: ['Product Manager', 'Custom field (Product Manager)']
  },
  {
    appField: 'Business Impact',
    envName: 'JIRA_FIELD_BUSINESS_IMPACT',
    names: ['Business Impact', 'Custom field (Business Impact)']
  },
  {
    appField: 'Release Date',
    envName: 'JIRA_FIELD_RELEASE_DATE',
    names: ['Release Date', 'Custom field (Release Date)']
  }
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return;
    }

    const quoted = (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    );
    if (quoted) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function sendError(response, statusCode, message, details = undefined) {
  sendJson(response, statusCode, {
    error: message,
    details
  });
}

function readJsonBody(request, { maxBytes = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });

    request.on('error', reject);
  });
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidSyncCredentials(payload) {
  const expectedUsername = String(process.env.SYNC_USERNAME || '');
  const expectedPassword = String(process.env.SYNC_PASSWORD || '');

  if (!expectedUsername || !expectedPassword) {
    return false;
  }

  return safeEqualText(payload?.username, expectedUsername) &&
    safeEqualText(payload?.password, expectedPassword);
}

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function getJiraConfig() {
  const missing = [];
  const baseUrl = String(process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
  const email = String(process.env.JIRA_EMAIL || '').trim();
  const apiToken = String(process.env.JIRA_API_TOKEN || '').trim();
  const jql = String(process.env.JIRA_JQL || '').trim();

  if (!baseUrl) missing.push('JIRA_BASE_URL');
  if (!email) missing.push('JIRA_EMAIL');
  if (!apiToken) missing.push('JIRA_API_TOKEN');
  if (!jql) missing.push('JIRA_JQL');

  if (missing.length) {
    const error = new Error(`Missing Jira configuration: ${missing.join(', ')}`);
    error.code = 'JIRA_CONFIG_MISSING';
    error.statusCode = 500;
    error.details = { missing };
    throw error;
  }

  return {
    baseUrl,
    email,
    apiToken,
    jql,
    maxResults: parsePositiveInteger(process.env.JIRA_MAX_RESULTS, DEFAULT_PAGE_SIZE, { min: 1, max: 5000 }),
    pageLimit: parsePositiveInteger(process.env.JIRA_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, { min: 1, max: 500 })
  };
}

function getAuthHeader(config) {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
}

function buildJiraUrl(config, apiPath, query = undefined) {
  const url = new URL(apiPath, `${config.baseUrl}/`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(item => url.searchParams.append(key, item));
      } else {
        url.searchParams.set(key, String(value));
      }
    });
  }
  return url;
}

async function jiraFetch(config, apiPath, options = {}) {
  const url = buildJiraUrl(config, apiPath, options.query);
  const headers = {
    Accept: 'application/json',
    Authorization: getAuthHeader(config),
    ...options.headers
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(parsePositiveInteger(process.env.JIRA_TIMEOUT_MS, 60000, { min: 1000 }))
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const errorMessages = Array.isArray(payload.errorMessages)
      ? payload.errorMessages.join(' ')
      : '';
    const fieldErrors = payload.errors
      ? Object.entries(payload.errors).map(([field, message]) => `${field}: ${message}`).join(' ')
      : '';
    const message = errorMessages || fieldErrors || payload.error || payload.raw || response.statusText;
    const error = new Error(`Jira API ${response.status}: ${message}`);
    error.statusCode = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

async function discoverFields(config) {
  const fields = await jiraFetch(config, '/rest/api/3/field');
  const byName = new Map();
  const byIdOrKey = new Map();

  fields.forEach(field => {
    if (field.name) {
      const key = String(field.name).trim().toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, field);
      }
    }
    [field.id, field.key].filter(Boolean).forEach(idOrKey => {
      byIdOrKey.set(String(idOrKey).trim().toLowerCase(), field);
    });
  });

  const fieldMap = {};
  const warnings = [];

  FIELD_DEFINITIONS.forEach(definition => {
    const override = String(process.env[definition.envName] || '').trim();
    if (override) {
      const overrideKey = override.toLowerCase();
      const matched = byIdOrKey.get(overrideKey) || byName.get(overrideKey);
      fieldMap[definition.appField] = matched?.id || override;
      return;
    }

    const matched = definition.names
      .map(name => byName.get(name.toLowerCase()))
      .find(Boolean);

    if (matched?.id) {
      fieldMap[definition.appField] = matched.id;
    } else {
      fieldMap[definition.appField] = '';
      warnings.push(`Could not find Jira field for "${definition.appField}". Add ${definition.envName}=customfield_xxxxx to .env if the name differs.`);
    }
  });

  return { fieldMap, warnings };
}

function normalizeProjectName(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'salesforce-emeritus-jforce') {
    return 'SFDC';
  }
  if (normalized === 'portal_em_jforce') {
    return 'Portal';
  }
  return normalized;
}

function collectAdfText(node, output = []) {
  if (!node) {
    return output;
  }
  if (Array.isArray(node)) {
    node.forEach(child => collectAdfText(child, output));
    return output;
  }
  if (typeof node !== 'object') {
    return output;
  }

  if (node.type === 'text' && node.text) {
    output.push(String(node.text));
  }
  if (node.attrs?.url) {
    output.push(String(node.attrs.url));
  }
  if (node.content) {
    collectAdfText(node.content, output);
  }

  return output;
}

function extractDisplayValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value.map(item => extractDisplayValue(item)).map(item => item.trim()).filter(Boolean);
    return Array.from(new Set(values)).join(', ');
  }
  if (typeof value === 'object') {
    if (value.type === 'doc' || value.content) {
      const adfText = collectAdfText(value).join(' ').replace(/\s+/g, ' ').trim();
      if (adfText) {
        return adfText;
      }
    }

    const preferredKeys = ['value', 'displayName', 'name', 'summary', 'title', 'key', 'emailAddress'];
    for (const key of preferredKeys) {
      if (value[key] !== undefined && value[key] !== null) {
        const displayValue = extractDisplayValue(value[key]).trim();
        if (displayValue) {
          return displayValue;
        }
      }
    }

    if (value.object?.url) {
      return String(value.object.url);
    }
    if (value.url) {
      return String(value.url);
    }
    if (value.self) {
      return String(value.self);
    }
  }

  return '';
}

function buildSearchFields(fieldMap) {
  return Array.from(new Set([
    'issuetype',
    'summary',
    'parent',
    'project',
    ...Object.values(fieldMap).filter(Boolean)
  ]));
}

async function searchIssuesEnhanced(config, fields) {
  const issues = [];
  let nextPageToken = '';
  let pageCount = 0;

  do {
    pageCount += 1;
    const body = {
      jql: config.jql,
      fields,
      maxResults: config.maxResults
    };
    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const payload = await jiraFetch(config, '/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    issues.push(...(payload.issues || []));
    nextPageToken = payload.nextPageToken || '';
  } while (nextPageToken && pageCount < config.pageLimit);

  return {
    issues,
    exhausted: Boolean(nextPageToken)
  };
}

async function searchIssuesClassic(config, fields) {
  const issues = [];
  let startAt = 0;
  let pageCount = 0;
  let total = Number.POSITIVE_INFINITY;

  while (startAt < total && pageCount < config.pageLimit) {
    pageCount += 1;
    const payload = await jiraFetch(config, '/rest/api/3/search', {
      method: 'POST',
      body: JSON.stringify({
        jql: config.jql,
        fields,
        startAt,
        maxResults: config.maxResults
      })
    });

    const pageIssues = payload.issues || [];
    issues.push(...pageIssues);
    total = Number.isFinite(payload.total) ? payload.total : issues.length;
    startAt += pageIssues.length || config.maxResults;
    if (!pageIssues.length) {
      break;
    }
  }

  return {
    issues,
    exhausted: startAt < total
  };
}

async function searchIssues(config, fields) {
  try {
    return await searchIssuesEnhanced(config, fields);
  } catch (error) {
    if (error.statusCode !== 404 && error.statusCode !== 410) {
      throw error;
    }
    return searchIssuesClassic(config, fields);
  }
}

async function getIssue(config, issueKey, fields) {
  return jiraFetch(config, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    query: {
      fields: fields.join(','),
      fieldsByKeys: 'false',
      updateHistory: 'false'
    }
  });
}

function mapIssueToRecord(issue, fieldMap) {
  const fields = issue.fields || {};
  const parent = fields.parent || {};
  const parentFields = parent.fields || {};

  return {
    'Issue Type': extractDisplayValue(fields.issuetype?.name || fields.issuetype),
    Key: issue.key || '',
    Parent: extractDisplayValue(parentFields.summary || parent.summary || parent.key || ''),
    Summary: extractDisplayValue(fields.summary),
    'Description for RN': extractDisplayValue(fields[fieldMap['Description for RN']]),
    'University Name': extractDisplayValue(fields[fieldMap['University Name']]),
    'Program Name': extractDisplayValue(fields[fieldMap['Program Name']]),
    'Business Unit': extractDisplayValue(fields[fieldMap['Business Unit']]),
    'Business Docs': extractDisplayValue(fields[fieldMap['Business Docs']]),
    'Tutorial Doc': extractDisplayValue(fields[fieldMap['Tutorial Doc']]),
    'Skill Set': extractDisplayValue(fields[fieldMap['Skill Set']]),
    'Product Manager': extractDisplayValue(fields[fieldMap['Product Manager']]),
    'Business Impact': extractDisplayValue(fields[fieldMap['Business Impact']]),
    Project: normalizeProjectName(extractDisplayValue(fields.project?.name || fields.project?.key || fields.project)),
    'Release Date': extractDisplayValue(fields[fieldMap['Release Date']]),
    __parentKey: parent.key || ''
  };
}

function isSubtaskIssueType(value) {
  return String(value || '').trim().toLowerCase() === 'sub-task';
}

async function applySubtaskParentInheritance(config, records, fields, fieldMap) {
  const byKey = new Map(records.map(record => [record.Key, record]).filter(([key]) => Boolean(key)));
  const parentIssueCache = new Map();

  for (const record of records) {
    if (!isSubtaskIssueType(record['Issue Type']) || !record.__parentKey) {
      continue;
    }

    const parentRecord = byKey.get(record.__parentKey);
    if (parentRecord?.Parent) {
      record.Parent = parentRecord.Parent;
      continue;
    }

    if (!parentIssueCache.has(record.__parentKey)) {
      try {
        const parentIssue = await getIssue(config, record.__parentKey, fields);
        parentIssueCache.set(record.__parentKey, mapIssueToRecord(parentIssue, fieldMap));
      } catch (error) {
        parentIssueCache.set(record.__parentKey, null);
      }
    }

    const parentIssueRecord = parentIssueCache.get(record.__parentKey);
    if (parentIssueRecord?.Parent) {
      record.Parent = parentIssueRecord.Parent;
    } else if (parentIssueRecord?.Summary && !record.Parent) {
      record.Parent = parentIssueRecord.Summary;
    }
  }
}

async function buildReleaseNotesPayload() {
  const config = getJiraConfig();
  const { fieldMap, warnings } = await discoverFields(config);
  const searchFields = buildSearchFields(fieldMap);
  const searchResult = await searchIssues(config, searchFields);
  const records = searchResult.issues.map(issue => mapIssueToRecord(issue, fieldMap));

  await applySubtaskParentInheritance(config, records, searchFields, fieldMap);

  if (searchResult.exhausted) {
    warnings.push(`Stopped after ${config.pageLimit} Jira pages. Increase JIRA_PAGE_LIMIT if you expect more issues.`);
  }

  return {
    source: 'jira',
    generatedAt: new Date().toISOString(),
    total: records.length,
    jql: config.jql,
    records,
    warnings
  };
}

async function refreshReleaseNotesCache(reason = 'manual') {
  if (releaseNotesSyncPromise) {
    return releaseNotesSyncPromise;
  }

  releaseNotesSyncPromise = buildReleaseNotesPayload()
    .then(payload => {
      releaseNotesCache = {
        ...payload,
        syncReason: reason,
        nextScheduledSyncAt: nextScheduledSyncAt ? nextScheduledSyncAt.toISOString() : null
      };
      lastSyncError = null;
      console.log(`Jira release notes cache refreshed (${reason}): ${payload.total} records.`);
      return releaseNotesCache;
    })
    .catch(error => {
      lastSyncError = {
        message: error.message,
        details: error.details,
        statusCode: error.statusCode,
        happenedAt: new Date().toISOString()
      };
      throw error;
    })
    .finally(() => {
      releaseNotesSyncPromise = null;
    });

  return releaseNotesSyncPromise;
}

function getNextMonthlySyncDate(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setDate(MONTHLY_SYNC_DAY);
  next.setHours(MONTHLY_SYNC_HOUR, MONTHLY_SYNC_MINUTE, 0, 0);

  if (next <= fromDate) {
    next.setMonth(next.getMonth() + 1);
    next.setDate(MONTHLY_SYNC_DAY);
    next.setHours(MONTHLY_SYNC_HOUR, MONTHLY_SYNC_MINUTE, 0, 0);
  }

  return next;
}

function scheduleNextReleaseNotesSync() {
  nextScheduledSyncAt = getNextMonthlySyncDate();
  const delayMs = nextScheduledSyncAt.getTime() - Date.now();
  const timerDelay = Math.min(delayMs, MAX_TIMEOUT_MS);

  setTimeout(async () => {
    if (Date.now() < nextScheduledSyncAt.getTime()) {
      scheduleNextReleaseNotesSync();
      return;
    }

    try {
      await refreshReleaseNotesCache('scheduled');
    } catch (error) {
      console.error(`Scheduled Jira sync failed: ${error.message}`);
    } finally {
      scheduleNextReleaseNotesSync();
    }
  }, timerDelay);
}

async function handleReleaseNotes(response) {
  try {
    if (!releaseNotesCache) {
      await refreshReleaseNotesCache('startup');
    }

    sendJson(response, 200, {
      ...releaseNotesCache,
      nextScheduledSyncAt: nextScheduledSyncAt ? nextScheduledSyncAt.toISOString() : null,
      lastSyncError
    });
  } catch (error) {
    if (error.code === 'JIRA_CONFIG_MISSING') {
      sendJson(response, 200, {
        source: 'jira',
        configured: false,
        error: error.message,
        details: error.details,
        records: null
      });
      return;
    }

    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    sendError(response, statusCode, error.message, error.details);
  }
}

async function handleReleaseNotesSync(request, response) {
  try {
    const payload = await readJsonBody(request);

    if (!hasValidSyncCredentials(payload)) {
      sendError(response, 401, 'Invalid sync credentials');
      return;
    }

    const refreshedPayload = await refreshReleaseNotesCache('manual');
    sendJson(response, 200, {
      ...refreshedPayload,
      nextScheduledSyncAt: nextScheduledSyncAt ? nextScheduledSyncAt.toISOString() : null,
      lastSyncError
    });
  } catch (error) {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    sendError(response, statusCode, error.message, error.details);
  }
}

function serveStaticFile(requestUrl, response) {
  const rawPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT_DIR, relativePath);

  if (!filePath.startsWith(ROOT_DIR + path.sep) && filePath !== ROOT_DIR) {
    sendError(response, 403, 'Forbidden');
    return;
  }

  if (path.basename(filePath) === '.env') {
    sendError(response, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendError(response, 404, 'Not found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/release-notes') {
    if (request.method !== 'GET') {
      sendError(response, 405, 'Method not allowed');
      return;
    }
    handleReleaseNotes(response);
    return;
  }

  if (requestUrl.pathname === '/api/release-notes/sync') {
    if (request.method !== 'POST') {
      sendError(response, 405, 'Method not allowed');
      return;
    }
    handleReleaseNotesSync(request, response);
    return;
  }

  if (requestUrl.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  serveStaticFile(requestUrl, response);
});

server.listen(PORT, () => {
  console.log(`Release Notes Data Explorer running at http://localhost:${PORT}/`);
  console.log('Jira sync runs on startup and on the 1st of each month at 10:00 local server time.');
  scheduleNextReleaseNotesSync();
  refreshReleaseNotesCache('startup').catch(error => {
    console.error(`Startup Jira sync failed: ${error.message}`);
  });
});
