#!/usr/bin/env node
// Long-poll the brain server for the next user action from the cockpit UI.
//
// Usage: node scripts/poll.mjs --session <id> [--timeout <ms>]
// Prints exactly one JSON user action, or { "type": "timeout" }, and exits 0.

import {
  findProjectRoot,
  readServerInfo,
  httpJson,
  parseArgs,
  printJson,
  failCli,
} from './lib/state.mjs';

const DEFAULT_TIMEOUT = 600000;
// The client waits longer than the server's poll window so the SERVER times
// out first and returns { "type": "timeout" } — the client never gives up early.
const CLIENT_GRACE_MS = 30000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = typeof args.session === 'string' ? args.session : null;
  if (!session) failCli('missing --session <id>');

  let timeout = DEFAULT_TIMEOUT;
  if (args.timeout !== undefined) {
    timeout = Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout < 0) failCli('--timeout must be a non-negative number of ms');
  }

  const root = findProjectRoot(process.cwd());
  const info = readServerInfo(root);
  if (!info || !info.port || !info.token) {
    failCli('brain server is not running (no server.json); run brain.mjs first');
  }

  let res;
  try {
    res = await httpJson({
      method: 'GET',
      port: info.port,
      path: `/poll?session=${encodeURIComponent(session)}&timeout=${timeout}`,
      token: info.token,
      timeoutMs: timeout + CLIENT_GRACE_MS,
    });
  } catch (err) {
    failCli(`poll failed: ${(err && err.message) || err}`);
  }

  if (res.status === 200 && res.json) {
    printJson(res.json);
    return;
  }
  failCli((res.json && res.json.error) || `server responded ${res.status}`, res.text);
}

main().catch((err) => failCli((err && err.message) || err, err && err.stack));
