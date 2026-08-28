#!/usr/bin/env node
// engineering-brain local cockpit server: HTTP + SSE, one server per project.
// Node >= 18, ESM, zero npm dependencies. Runs detached (spawned by brain.mjs)
// or in the foreground (node scripts/brain-server.mjs [--root <path>]).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  findProjectRoot,
  ensureStateDirs,
  serverJsonPath,
  mapJsonPath,
  metaPath,
  readJsonFile,
  writeJsonFile,
  writeServerInfo,
  appendJournal,
  appendDelivered,
  pendingUserActions,
  readJournal,
  sessionExists,
  listSessions,
  parseArgs,
  EVENT_TYPES,
} from './lib/state.mjs';

const ARGS = parseArgs(process.argv.slice(2));
const ROOT =
  typeof ARGS.root === 'string' && ARGS.root.length > 0
    ? path.resolve(ARGS.root)
    : findProjectRoot(process.cwd());

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const HOST = '127.0.0.1';
const PORT_FIRST = 8641;
const PORT_LAST = 8650;
const POLL_DEFAULT_TIMEOUT = 600000;
const POLL_MAX_TIMEOUT = 3600000;
const HEARTBEAT_MS = 25000;
// Generous for any contract event (options/system_map payloads are tens of KB
// at most) while rejecting abusive multi-MB bodies that would bloat the journal
// and get replayed to every SSE client.
const BODY_LIMIT = 2 * 1024 * 1024;
const ACTION_TYPES = ['decision', 'steer', 'answer'];

const TOKEN = crypto.randomBytes(8).toString('hex'); // 16 hex chars
const STARTED_AT = Date.now();

ensureStateDirs(ROOT);

// ---------------------------------------------------------------------------
// In-memory state (journal on disk is the durable record)
// ---------------------------------------------------------------------------

const seqCounters = new Map(); // session -> last assigned seq
const actionCounters = new Map(); // session -> last assigned action number
const sseClients = new Map(); // session -> Set<res>
const pendingActions = new Map(); // session -> [action] (undelivered)
const pendingLoaded = new Set(); // sessions whose pending queue was rebuilt from disk
const pollWaiters = new Map(); // session -> [{ deliver, cancel }]

/**
 * Rebuild a session's pending queue from the durable record (journal
 * `user_action` events minus delivered.jsonl ids, in seq order). Runs once per
 * session — at startup for known sessions, lazily on first touch otherwise —
 * and MUST run before any in-memory queue mutation for that session.
 */
function ensurePendingLoaded(session) {
  if (pendingLoaded.has(session)) return;
  pendingLoaded.add(session);
  const restored = pendingUserActions(ROOT, session);
  if (restored.length > 0) pendingActions.set(session, restored);
}

/**
 * Record delivery durably BEFORE the action is handed to a poller. Throws on
 * write failure — callers must then keep the action pending, not deliver it.
 */
function markDelivered(session, action) {
  appendDelivered(ROOT, session, action.id);
}

function nextSeq(session) {
  if (!seqCounters.has(session)) {
    let max = 0;
    for (const ev of readJournal(ROOT, session)) {
      if (typeof ev.seq === 'number' && ev.seq > max) max = ev.seq;
    }
    seqCounters.set(session, max);
  }
  const next = seqCounters.get(session) + 1;
  seqCounters.set(session, next);
  return next;
}

function nextActionId(session) {
  if (!actionCounters.has(session)) {
    let max = 0;
    for (const ev of readJournal(ROOT, session)) {
      if (ev.type !== 'user_action' || !ev.data) continue;
      const m = /^a-(\d+)$/.exec(String(ev.data.id || ''));
      if (m) max = Math.max(max, Number(m[1]));
    }
    actionCounters.set(session, max);
  }
  const next = actionCounters.get(session) + 1;
  actionCounters.set(session, next);
  return `a-${next}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (c) => {
      if (overflowed) return; // draining; response already on its way
      size += c.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        const err = new Error(`body too large (limit ${limit} bytes)`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!overflowed) reject(err);
    });
  });
}

function parseJsonBody(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isAuthorized(req, url) {
  const provided = req.headers['x-brain-token'] || url.searchParams.get('token');
  return typeof provided === 'string' && provided === TOKEN;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function broadcast(session, envelope) {
  const clients = sseClients.get(session);
  if (!clients || clients.size === 0) return;
  const frame = `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      /* dead client; removed on close */
    }
  }
}

function journalEvent(session, type, data) {
  const envelope = { seq: nextSeq(session), ts: Date.now(), session, type, data };
  appendJournal(ROOT, session, envelope);
  broadcast(session, envelope);
  return envelope;
}

function readMap() {
  const fallback = { nodes: [], edges: [], learnings: [] };
  const map = readJsonFile(mapJsonPath(ROOT), fallback);
  if (!isPlainObject(map)) return fallback;
  if (!Array.isArray(map.nodes)) map.nodes = [];
  if (!Array.isArray(map.edges)) map.edges = [];
  if (!Array.isArray(map.learnings)) map.learnings = [];
  return map;
}

/** Merge a system_map event payload into map.json: upsert nodes by id, edges by (from, to, kind). */
function mergeSystemMap(data) {
  const map = readMap();
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id) continue;
    const idx = map.nodes.findIndex((n) => isPlainObject(n) && n.id === node.id);
    if (idx >= 0) map.nodes[idx] = { ...map.nodes[idx], ...node };
    else map.nodes.push(node);
  }
  for (const edge of edges) {
    if (!isPlainObject(edge) || !edge.from || !edge.to) continue;
    const idx = map.edges.findIndex(
      (e) => isPlainObject(e) && e.from === edge.from && e.to === edge.to && e.kind === edge.kind
    );
    if (idx >= 0) map.edges[idx] = { ...map.edges[idx], ...edge };
    else map.edges.push(edge);
  }
  map.updatedAt = Date.now();
  writeJsonFile(mapJsonPath(ROOT), map);
}

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

const STATIC_TYPES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function serveIndex(res, port) {
  let html;
  try {
    html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  } catch {
    sendJson(res, 404, { ok: false, error: 'ui/index.html not found' });
    return;
  }
  const inject = `<script>window.__BRAIN__ = ${JSON.stringify({ token: TOKEN, port })};</script>`;
  html = html.includes('</head>')
    ? html.replace('</head>', `${inject}\n</head>`)
    : inject + '\n' + html;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function serveAsset(res, urlPath) {
  const [file, type] = STATIC_TYPES[urlPath];
  let content;
  try {
    content = fs.readFileSync(path.join(UI_DIR, file));
  } catch {
    sendJson(res, 404, { ok: false, error: `ui/${file} not found` });
    return;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(content);
}

// ---------------------------------------------------------------------------
// SSE: /events?session=<id>&since=<seq>
// ---------------------------------------------------------------------------

function handleEvents(req, res, url) {
  const session = url.searchParams.get('session');
  if (!sessionExists(ROOT, session)) {
    sendJson(res, 404, { ok: false, error: 'unknown session' });
    return;
  }
  const sinceRaw = Number(url.searchParams.get('since'));
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  // Replay strictly before registering live is safe: this whole block runs in
  // one tick, so no emit can interleave between replay and live subscription.
  for (const ev of readJournal(ROOT, session)) {
    if (typeof ev.seq === 'number' && ev.seq > since) {
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }

  if (!sseClients.has(session)) sseClients.set(session, new Set());
  sseClients.get(session).add(res);

  req.on('close', () => {
    const clients = sseClients.get(session);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(session);
    }
  });
}

setInterval(() => {
  for (const clients of sseClients.values()) {
    for (const res of clients) {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* removed on close */
      }
    }
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------------------
// /decide + /poll (long-poll queue; at-most-once delivery, journal is durable)
// ---------------------------------------------------------------------------

function handleDecide(res, body) {
  if (!body || !sessionExists(ROOT, body.session)) {
    sendJson(res, body && body.session ? 404 : 400, {
      ok: false,
      error: body && body.session ? 'unknown session' : 'missing session',
    });
    return;
  }
  const raw = body.action;
  if (!isPlainObject(raw) || !ACTION_TYPES.includes(raw.type)) {
    sendJson(res, 400, {
      ok: false,
      error: `action.type must be one of: ${ACTION_TYPES.join(', ')}`,
    });
    return;
  }
  const session = body.session;
  ensurePendingLoaded(session); // before journaling, or the rebuild would double-queue this action
  const action = { id: nextActionId(session), ts: Date.now(), type: raw.type };
  if (typeof raw.decisionId === 'string') action.decisionId = raw.decisionId;
  if (typeof raw.choiceId === 'string') action.choiceId = raw.choiceId;
  if (typeof raw.message === 'string') action.message = raw.message;

  // Durable + visible in the UI trail. The journal is the canonical record the
  // pending queue is rebuilt from after a crash.
  journalEvent(session, 'user_action', { ...action });

  const waiters = pollWaiters.get(session);
  let delivered = false;
  if (waiters && waiters.length > 0) {
    const waiter = waiters.shift();
    try {
      markDelivered(session, action); // durable BEFORE handing to the poller
      waiter.deliver(action);
      delivered = true;
    } catch (err) {
      // Could not record delivery: keep the action pending and the waiter waiting.
      waiters.unshift(waiter);
      process.stderr.write(`delivered.jsonl append failed: ${(err && err.message) || err}\n`);
    }
  }
  if (!delivered) {
    if (!pendingActions.has(session)) pendingActions.set(session, []);
    pendingActions.get(session).push(action);
  }
  sendJson(res, 200, { ok: true, id: action.id });
}

function handlePoll(req, res, url) {
  const session = url.searchParams.get('session');
  if (!sessionExists(ROOT, session)) {
    sendJson(res, 404, { ok: false, error: 'unknown session' });
    return;
  }
  const timeoutRaw = Number(url.searchParams.get('timeout'));
  const timeout = Number.isFinite(timeoutRaw)
    ? Math.min(Math.max(timeoutRaw, 0), POLL_MAX_TIMEOUT)
    : POLL_DEFAULT_TIMEOUT;

  // Delivery is serialized: this whole section is synchronous (no await), so
  // two concurrent /poll requests can never both shift the same action.
  ensurePendingLoaded(session);
  const queue = pendingActions.get(session);
  if (queue && queue.length > 0) {
    const action = queue[0];
    try {
      markDelivered(session, action); // durable BEFORE returning it (at-most-once)
    } catch (err) {
      process.stderr.write(`delivered.jsonl append failed: ${(err && err.message) || err}\n`);
      sendJson(res, 500, { ok: false, error: 'failed to record delivery; action stays pending' });
      return;
    }
    queue.shift();
    sendJson(res, 200, action);
    return;
  }

  let settled = false;
  const waiter = {
    deliver(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sendJson(res, 200, action);
    },
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeWaiter();
    },
    // Shutdown path: answer the open poll explicitly instead of letting the
    // socket die with ECONNRESET. The action queue is untouched (nothing was
    // delivered), so a later poll against a restarted server still gets it.
    abort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sendJson(res, 503, { ok: false, error: 'server shutting down' });
    },
  };
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    removeWaiter();
    sendJson(res, 200, { type: 'timeout' });
  }, timeout);

  function removeWaiter() {
    const list = pollWaiters.get(session);
    if (!list) return;
    const idx = list.indexOf(waiter);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) pollWaiters.delete(session);
  }

  if (!pollWaiters.has(session)) pollWaiters.set(session, []);
  pollWaiters.get(session).push(waiter);

  // Client went away: do NOT mark anything delivered.
  req.on('close', () => {
    if (!res.writableEnded) waiter.cancel();
  });
}

// ---------------------------------------------------------------------------
// /emit
// ---------------------------------------------------------------------------

function handleEmit(res, body) {
  if (!body || typeof body.session !== 'string' || !body.session) {
    sendJson(res, 400, { ok: false, error: 'missing session' });
    return;
  }
  if (!sessionExists(ROOT, body.session)) {
    sendJson(res, 404, { ok: false, error: 'unknown session' });
    return;
  }
  if (!EVENT_TYPES.includes(body.type)) {
    sendJson(res, 400, {
      ok: false,
      error: `unknown event type ${JSON.stringify(body.type)}; valid types: ${EVENT_TYPES.join(', ')}`,
    });
    return;
  }
  const data = body.data === undefined ? {} : body.data;
  if (!isPlainObject(data)) {
    sendJson(res, 400, { ok: false, error: 'data must be a JSON object' });
    return;
  }
  const envelope = journalEvent(body.session, body.type, data);
  if (body.type === 'system_map') {
    try {
      mergeSystemMap(data);
    } catch (err) {
      process.stderr.write(`map merge failed: ${err && err.message}\n`);
    }
  }
  sendJson(res, 200, { ok: true, seq: envelope.seq });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let server = null;

function cleanupServerJson() {
  const info = readJsonFile(serverJsonPath(ROOT));
  if (info && info.pid === process.pid) {
    try {
      fs.unlinkSync(serverJsonPath(ROOT));
    } catch {
      /* ignore */
    }
  }
}

function shutdown() {
  cleanupServerJson();
  for (const waiters of pollWaiters.values()) {
    for (const waiter of [...waiters]) {
      try {
        waiter.abort();
      } catch {
        /* ignore */
      }
    }
  }
  pollWaiters.clear();
  for (const clients of sseClients.values()) {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  process.stderr.write(`uncaught: ${err && err.stack ? err.stack : err}\n`);
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req, res, port) {
  const url = new URL(req.url || '/', `http://${HOST}:${port}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  // Auth: all POSTs and /poll.
  if ((method === 'POST' || pathname === '/poll') && !isAuthorized(req, url)) {
    sendJson(res, 401, { ok: false, error: 'missing or invalid token' });
    return;
  }

  if (method === 'GET') {
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, startedAt: STARTED_AT });
      return;
    }
    if (pathname === '/') {
      serveIndex(res, port);
      return;
    }
    if (pathname in STATIC_TYPES) {
      serveAsset(res, pathname);
      return;
    }
    if (pathname === '/sessions') {
      sendJson(res, 200, { sessions: listSessions(ROOT) });
      return;
    }
    if (pathname === '/state') {
      const session = url.searchParams.get('session');
      if (!sessionExists(ROOT, session)) {
        sendJson(res, 404, { ok: false, error: 'unknown session' });
        return;
      }
      sendJson(res, 200, {
        meta: readJsonFile(metaPath(ROOT, session)),
        events: readJournal(ROOT, session),
      });
      return;
    }
    if (pathname === '/events') {
      handleEvents(req, res, url);
      return;
    }
    if (pathname === '/poll') {
      handlePoll(req, res, url);
      return;
    }
    if (pathname === '/map') {
      sendJson(res, 200, readMap());
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (method === 'POST') {
    let body;
    try {
      body = parseJsonBody(await readBody(req));
    } catch (err) {
      const status = err && err.statusCode === 413 ? 413 : 400;
      sendJson(res, status, { ok: false, error: String((err && err.message) || err) });
      // Oversized upload: close the connection once the error has flushed so
      // the client cannot keep streaming into a dead request.
      if (status === 413) res.on('finish', () => req.destroy());
      return;
    }
    if (pathname === '/emit') {
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'body must be a JSON object' });
        return;
      }
      handleEmit(res, body);
      return;
    }
    if (pathname === '/decide') {
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'body must be a JSON object' });
        return;
      }
      handleDecide(res, body);
      return;
    }
    if (pathname === '/map') {
      if (!isPlainObject(body)) {
        sendJson(res, 400, { ok: false, error: 'body must be a full map object' });
        return;
      }
      writeJsonFile(mapJsonPath(ROOT), body);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/shutdown') {
      sendJson(res, 200, { ok: true });
      shutdown();
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  sendJson(res, 405, { ok: false, error: 'method not allowed' });
}

// ---------------------------------------------------------------------------
// Boot: bind 127.0.0.1:8641, fall back through 8650
// ---------------------------------------------------------------------------

function listen(port) {
  server = http.createServer((req, res) => {
    handleRequest(req, res, port).catch((err) => {
      process.stderr.write(`handler error: ${err && err.stack ? err.stack : err}\n`);
      try {
        sendJson(res, 500, { ok: false, error: 'internal error' });
      } catch {
        /* ignore */
      }
    });
  });
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && port < PORT_LAST) {
      listen(port + 1);
    } else {
      process.stderr.write(`failed to bind ${HOST}:${port}: ${err && err.message}\n`);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    writeServerInfo(ROOT, { port, token: TOKEN, pid: process.pid, startedAt: STARTED_AT });
    process.stderr.write(`engineering-brain server on http://${HOST}:${port} (root: ${ROOT})\n`);
  });
}

// Rebuild pending queues for all known sessions up front (new sessions created
// while running are handled lazily by ensurePendingLoaded on first touch).
for (const meta of listSessions(ROOT)) {
  if (meta && typeof meta.sessionId === 'string' && meta.sessionId) {
    try {
      ensurePendingLoaded(meta.sessionId);
    } catch (err) {
      process.stderr.write(
        `pending rebuild failed for ${meta.sessionId}: ${(err && err.message) || err}\n`
      );
    }
  }
}

listen(PORT_FIRST);
