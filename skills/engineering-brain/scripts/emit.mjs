#!/usr/bin/env node
// Append an event to a session journal via the running brain server.
//
// Usage: node scripts/emit.mjs --session <id> --type <type> (--data '<json>' | --data-file <path>)
// Prints { "ok": true, "seq": n } on success; { "ok": false, "error": ... } + exit 1 on failure.

import fs from 'node:fs';
import {
  findProjectRoot,
  readServerInfo,
  httpJson,
  parseArgs,
  printJson,
  failCli,
  EVENT_TYPES,
} from './lib/state.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = typeof args.session === 'string' ? args.session : null;
  const type = typeof args.type === 'string' ? args.type : null;

  if (!session) failCli('missing --session <id>');
  if (!type) failCli('missing --type <type>');
  if (!EVENT_TYPES.includes(type)) {
    failCli(`unknown event type ${JSON.stringify(type)}; valid types: ${EVENT_TYPES.join(', ')}`);
  }

  let raw = null;
  if (typeof args['data-file'] === 'string') {
    try {
      raw = fs.readFileSync(args['data-file'], 'utf8');
    } catch (err) {
      failCli(`cannot read --data-file: ${(err && err.message) || err}`);
    }
  } else if (typeof args.data === 'string') {
    raw = args.data;
  }

  let data = {};
  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      failCli(`--data is not valid JSON: ${(err && err.message) || err}`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      failCli('--data must be a JSON object');
    }
  }

  const root = findProjectRoot(process.cwd());
  const info = readServerInfo(root);
  if (!info || !info.port || !info.token) {
    failCli('brain server is not running (no server.json); run brain.mjs first');
  }

  let res;
  try {
    res = await httpJson({
      method: 'POST',
      port: info.port,
      path: '/emit',
      token: info.token,
      body: { session, type, data },
      timeoutMs: 10000,
    });
  } catch (err) {
    failCli(`cannot reach brain server on port ${info.port}: ${(err && err.message) || err}`);
  }

  if (res.status === 200 && res.json && res.json.ok === true) {
    printJson({ ok: true, seq: res.json.seq });
    return;
  }
  failCli((res.json && res.json.error) || `server responded ${res.status}`, res.text);
}

main().catch((err) => failCli((err && err.message) || err, err && err.stack));
