#!/usr/bin/env node
// Shut the brain server down gracefully.
//
// Usage: node scripts/stop.mjs
// Prints { "ok": true }. Idempotent: an already-stopped server is a success.

import {
  findProjectRoot,
  readServerInfo,
  removeServerInfo,
  httpJson,
  printJson,
  failCli,
} from './lib/state.mjs';

async function main() {
  const root = findProjectRoot(process.cwd());
  const info = readServerInfo(root);

  if (!info || !info.port) {
    process.stderr.write('no server.json; server already stopped\n');
    printJson({ ok: true });
    return;
  }

  try {
    const res = await httpJson({
      method: 'POST',
      port: info.port,
      path: '/shutdown',
      token: info.token,
      timeoutMs: 5000,
    });
    if (res.status === 200 && res.json && res.json.ok === true) {
      printJson({ ok: true });
      return;
    }
    failCli((res.json && res.json.error) || `server responded ${res.status}`, res.text);
  } catch (err) {
    // Connection refused: the recorded server is already dead. Clean up the
    // stale server.json and report success.
    process.stderr.write(`server unreachable (${(err && err.message) || err}); clearing stale server.json\n`);
    removeServerInfo(root);
    printJson({ ok: true });
  }
}

main().catch((err) => failCli((err && err.message) || err, err && err.stack));
