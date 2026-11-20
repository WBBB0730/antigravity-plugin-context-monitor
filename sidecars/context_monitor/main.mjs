/**
 * Context Monitor sidecar backend (read-only on transcripts).
 *
 * - Reads <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 * - Syncs model context limits from https://models.dev/api.json once per 24h
 *   and stores a compact cache in ANTIGRAVITY_EXECUTABLE_DATA_DIR/model_limits.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_CACHE_ENTRIES = 120;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 25 * 1000;

// Official first-party providers take precedence over reseller/proxy entries.
const PREFERRED_PROVIDERS = [
  'google',
  'anthropic',
  'openai',
  'xai',
  'deepseek',
  'mistral',
  'qwen',
  'moonshotai',
];

const VARIANT_SUFFIX_RE = /-(?:high|medium|low|minimal|max|thinking|reasoning|preview|latest|exp|beta)$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function findBrainDir() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const candidate = join(dirname(d), 'brain');
      if (existsSync(candidate)) return candidate;
    }
  }
  const fallback = join(homedir(), '.gemini', 'antigravity', 'brain');
  return existsSync(fallback) ? fallback : null;
}

function cacheFilePath() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'context-monitor', 'context_monitor', 'data');
  return join(dataDir, 'model_limits.json');
}

function transcriptPath(brainDir, convId) {
  return join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// models.dev catalog cache & lookup
// ---------------------------------------------------------------------------

const catalog = {
  limits: {},       // lowercased modelId -> context tokens
  sortedKeys: [],   // longest first for prefix matching
  updatedAt: 0,
  lastAttempt: 0,
  version: 0,
  syncing: false,
};

function setCatalogLimits(limits, updatedAt) {
  catalog.limits = limits;
  catalog.sortedKeys = Object.keys(limits).sort((a, b) => b.length - a.length);
  catalog.updatedAt = updatedAt;
  catalog.version += 1;
}

function loadCatalogFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(), 'utf-8'));
    if (raw && typeof raw.limits === 'object' && raw.limits) {
      setCatalogLimits(raw.limits, Number(raw.updatedAt) || 0);
    }
  } catch {
    // No cache yet.
  }
}

function saveCatalogToDisk(limits, updatedAt) {
  try {
    const file = cacheFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ source: 'models.dev', updatedAt, limits }), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    console.warn('[context-monitor] failed to save model_limits.json:', err.message);
  }
}

function extractLimits(apiJson) {
  const limits = {};
  const providers = Object.keys(apiJson || {});
  const ordered = [
    ...PREFERRED_PROVIDERS.filter((p) => p in apiJson),
    ...providers.filter((p) => !PREFERRED_PROVIDERS.includes(p)),
  ];

  for (const prov of ordered) {
    const models = apiJson[prov]?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, info] of Object.entries(models)) {
      const ctx = Number(info?.limit?.context);
      if (!Number.isFinite(ctx) || ctx < 4096) continue;
      // Strip optional provider prefix like "google/gemini-..."
      const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
      const key = bare.toLowerCase();
      if (!(key in limits)) limits[key] = Math.round(ctx);
    }
  }
  return limits;
}

async function syncCatalogIfNeeded() {
  if (catalog.syncing) return;
  const now = Date.now();
  const stale = !catalog.updatedAt || (now - catalog.updatedAt >= SYNC_INTERVAL_MS);
  if (!stale) return;
  if (catalog.lastAttempt && (now - catalog.lastAttempt < RETRY_INTERVAL_MS)) return;

  catalog.syncing = true;
  catalog.lastAttempt = now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const limits = extractLimits(data);
    if (Object.keys(limits).length > 0) {
      setCatalogLimits(limits, Date.now());
      saveCatalogToDisk(limits, catalog.updatedAt);
      console.log(`[context-monitor] synced ${Object.keys(limits).length} models from models.dev`);
    }
  } catch (err) {
    console.warn('[context-monitor] models.dev sync skipped:', err.message);
  } finally {
    clearTimeout(timer);
    catalog.syncing = false;
  }
}

function stripVariantSuffixes(id) {
  let s = id;
  while (VARIANT_SUFFIX_RE.test(s)) {
    s = s.replace(VARIANT_SUFFIX_RE, '');
  }
  return s;
}

function familyFallbackLimit(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('gpt-4o')) return 128_000;
  return 200_000;
}

function resolveModelLimit(model) {
  if (!model) return { limit: 1_000_000, source: 'default' };
  const raw = String(model).trim().toLowerCase();
  const norm = stripVariantSuffixes(raw);

  const candidates = [
    raw,
    norm,
    norm.replace(/(\d)-(\d)/g, '$1.$2'),
    norm.replace(/(\d)\.(\d)/g, '$1-$2'),
  ];

  for (const c of candidates) {
    if (c && c in catalog.limits) {
      return { limit: catalog.limits[c], source: 'models.dev' };
    }
  }

  for (const key of catalog.sortedKeys) {
    if (norm.startsWith(`${key}-`) || norm.startsWith(`${key}.`)) {
      return { limit: catalog.limits[key], source: 'models.dev' };
    }
  }

  return { limit: familyFallbackLimit(model), source: 'default' };
}

loadCatalogFromDisk();
syncCatalogIfNeeded();
setInterval(syncCatalogIfNeeded, RETRY_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

const parseCache = new Map();

function parseTranscript(filePath, convId) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return null;
  }
  const cacheKey = `${Math.floor(st.mtimeMs)}:${st.size}`;
  const hit = parseCache.get(filePath);
  if (hit && hit.key === cacheKey) return hit.data;

  let text = '';
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let model = '';
  let compactions = 0;
  let lastPlanner = null;
  let lastCheckpoint = null;

  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const step = Number.isFinite(row.step_index) ? row.step_index : 0;

    if (row.type === 'PLANNER_RESPONSE') {
      if (typeof row.model === 'string' && row.model) model = row.model;
      const inputTokens = num(row.input_tokens);
      const cacheReadTokens = num(row.cache_read_tokens);
      const outputTokens = num(row.output_tokens);
      const promptTokens = inputTokens + cacheReadTokens;
      lastPlanner = {
        step,
        promptTokens,
        cacheReadTokens,
        contextAfter: promptTokens + outputTokens,
      };
    } else if (row.type === 'CHECKPOINT') {
      compactions += 1;
      lastCheckpoint = {
        step,
        summaryTokens: num(row.output_tokens),
      };
    }
  }

  const justCompacted = Boolean(
    lastCheckpoint && (!lastPlanner || lastCheckpoint.step > lastPlanner.step),
  );
  const usedTokens = justCompacted
    ? lastCheckpoint.summaryTokens
    : (lastPlanner ? lastPlanner.contextAfter : 0);
  const cacheHitRate = lastPlanner && lastPlanner.promptTokens > 0
    ? lastPlanner.cacheReadTokens / lastPlanner.promptTokens
    : null;

  const data = {
    conversationId: convId,
    model: model || null,
    usedTokens,
    justCompacted,
    compactions,
    cacheHitRate,
    etag: cacheKey,
  };

  if (parseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = parseCache.keys().next().value;
    if (oldest) parseCache.delete(oldest);
  }
  parseCache.set(filePath, { key: cacheKey, data });
  return data;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), {
    contentType,
    headers: { 'Cache-Control': 'no-store' },
  }), 'GET');
}

app.api('/api/context', (data) => {
  const conv = data.conversationId || app.config.conversationId || '';
  const brainDir = findBrainDir();
  if (!brainDir || !conv || !ID_RE.test(conv)) {
    return { conversationId: conv || null, found: false };
  }
  const parsed = parseTranscript(transcriptPath(brainDir, conv), conv);
  if (!parsed) return { conversationId: conv, found: false };

  const etag = `${conv}:${parsed.etag}:v${catalog.version}`;
  if (data.etag && data.etag === etag) {
    return { conversationId: conv, found: true, unchanged: true, etag };
  }

  const { limit, source } = resolveModelLimit(parsed.model);
  return {
    ...parsed,
    contextLimit: limit,
    limitSource: source,
    found: true,
    etag,
  };
}, 'GET');

app.run();
