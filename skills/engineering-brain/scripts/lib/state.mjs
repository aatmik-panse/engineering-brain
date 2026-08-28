// engineering-brain shared runtime helpers.
// Node >= 18, ESM, zero npm dependencies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Project root + state paths
// ---------------------------------------------------------------------------

/**
 * Walk up from startDir to the nearest directory containing `.git`.
 * Falls back to startDir when no `.git` is found.
 */
export function findProjectRoot(startDir = process.cwd()) {
  const origin = path.resolve(startDir);
  let dir = origin;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}

export function stateDir(root) {
  return path.join(root, '.engineering-brain');
}

export function sessionsDir(root) {
  return path.join(stateDir(root), 'sessions');
}

export function sessionDir(root, sessionId) {
  return path.join(sessionsDir(root), sessionId);
}

export function metaPath(root, sessionId) {
  return path.join(sessionDir(root, sessionId), 'meta.json');
}

export function journalPath(root, sessionId) {
  return path.join(sessionDir(root, sessionId), 'journal.jsonl');
}

/** Internal append-only record of delivered user-action ids (NOT a journal event). */
export function deliveredPath(root, sessionId) {
  return path.join(sessionDir(root, sessionId), 'delivered.jsonl');
}

export function serverJsonPath(root) {
  return path.join(stateDir(root), 'server.json');
}

export function mapJsonPath(root) {
  return path.join(stateDir(root), 'map.json');
}

export function ensureStateDirs(root) {
  fs.mkdirSync(sessionsDir(root), { recursive: true });
}

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

/** `eb-<base36 timestamp>-<4 random hex chars>` */
export function newSessionId() {
  return `eb-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// JSON files
// ---------------------------------------------------------------------------

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Crash-safe JSON write: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can never leave a truncated file.
 */
export function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp never created or already renamed */
    }
    throw err;
  }
}

export function readServerInfo(root) {
  return readJsonFile(serverJsonPath(root));
}

export function writeServerInfo(root, info) {
  writeJsonFile(serverJsonPath(root), info);
}

export function removeServerInfo(root) {
  try {
    fs.unlinkSync(serverJsonPath(root));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Journal (append-only jsonl, one event envelope per line)
// ---------------------------------------------------------------------------

export function appendJournal(root, sessionId, envelope) {
  fs.mkdirSync(sessionDir(root, sessionId), { recursive: true });
  fs.appendFileSync(journalPath(root, sessionId), JSON.stringify(envelope) + '\n');
}

/** Returns [] for missing files; silently skips corrupt lines. */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const items = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') items.push(parsed);
    } catch {
      /* skip corrupt line */
    }
  }
  return items;
}

/** Returns [] for missing journals; silently skips corrupt lines. */
export function readJournal(root, sessionId) {
  return readJsonl(journalPath(root, sessionId));
}

// ---------------------------------------------------------------------------
// Delivered user actions (append-only jsonl: { id, ts } per delivered action)
// ---------------------------------------------------------------------------

export function appendDelivered(root, sessionId, actionId) {
  fs.mkdirSync(sessionDir(root, sessionId), { recursive: true });
  fs.appendFileSync(
    deliveredPath(root, sessionId),
    JSON.stringify({ id: actionId, ts: Date.now() }) + '\n'
  );
}

/** Set of user-action ids already delivered to a poller. */
export function readDeliveredIds(root, sessionId) {
  const ids = new Set();
  for (const entry of readJsonl(deliveredPath(root, sessionId))) {
    if (typeof entry.id === 'string' && entry.id) ids.add(entry.id);
  }
  return ids;
}

/**
 * Pending (undelivered) user actions for a session, rebuilt from the durable
 * record: `user_action` journal events minus delivered ids, in seq order.
 * Works with the server down — reads state files directly.
 */
export function pendingUserActions(root, sessionId) {
  const delivered = readDeliveredIds(root, sessionId);
  const entries = [];
  const seen = new Set();
  for (const ev of readJournal(root, sessionId)) {
    if (ev.type !== 'user_action') continue;
    const action = ev.data;
    if (!action || typeof action !== 'object' || typeof action.id !== 'string' || !action.id) {
      continue;
    }
    if (delivered.has(action.id) || seen.has(action.id)) continue;
    seen.add(action.id);
    entries.push({ seq: typeof ev.seq === 'number' ? ev.seq : Number.MAX_SAFE_INTEGER, action: { ...action } });
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries.map((e) => e.action);
}

export function sessionExists(root, sessionId) {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    !sessionId.includes('/') &&
    !sessionId.includes('\\') &&
    !sessionId.includes('..') &&
    fs.existsSync(metaPath(root, sessionId))
  );
}

/** All session meta.json objects, newest first (by startedAt). */
export function listSessions(root) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readJsonFile(metaPath(root, entry.name));
    if (meta && typeof meta === 'object') metas.push(meta);
  }
  metas.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return metas;
}

// ---------------------------------------------------------------------------
// Event types (exhaustive, per CONTRACT.md)
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'session_start',
  'classified',
  'reclassified',
  'step',
  'thinking',
  'inspection',
  'system_map',
  'concern',
  'options',
  'decision_needed',
  'implementation',
  'validation',
  'learning',
  'note',
  'user_action',
  'session_end',
];

// ---------------------------------------------------------------------------
// Small HTTP JSON client for the CLIs
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP request against the local brain server and parse the JSON
 * response. Resolves { status, json, text }; rejects on network error/timeout.
 */
export function httpJson({
  method = 'GET',
  host = '127.0.0.1',
  port,
  path: reqPath = '/',
  token = null,
  body = undefined,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (token) headers['x-brain-token'] = token;

    const req = http.request({ host, port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * GET /health probe; true only for a healthy brain server that is the one
 * recorded in server.json. `/health` returns the responder's pid — when the
 * recorded server died and an unrelated brain server (e.g. another project's)
 * later claimed the same port, the pid mismatch rejects it; otherwise every
 * request would bounce off the foreign server's token.
 */
export async function probeHealth(info, timeoutMs = 1000) {
  if (!info || !info.port) return false;
  try {
    const res = await httpJson({ port: info.port, path: '/health', timeoutMs });
    if (res.status !== 200 || !res.json || res.json.ok !== true) return false;
    if (info.pid != null && res.json.pid != null && res.json.pid !== info.pid) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/** Minimal `--key value` / `--flag` argv parser. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a === 'string' && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/** Print one JSON line to stdout (all CLI output goes through this). */
export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Print { ok:false, error } to stdout, diagnostics to stderr, exit non-zero. */
export function failCli(error, detail) {
  if (detail) process.stderr.write(String(detail) + '\n');
  printJson({ ok: false, error: String(error) });
  process.exit(1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
