#!/usr/bin/env node
// Report server + session status. Works with the server down: reads the
// .engineering-brain state dir directly and only probes /health to determine
// whether the recorded server is actually alive.
//
// Usage: node scripts/status.mjs
// Prints { "server": { running, port, pid }, "sessions": [...] }.

import {
  findProjectRoot,
  readServerInfo,
  probeHealth,
  listSessions,
  pendingUserActions,
  printJson,
} from './lib/state.mjs';

async function main() {
  const root = findProjectRoot(process.cwd());
  const info = readServerInfo(root);
  const running = await probeHealth(info);

  // Pending (undelivered) action counts come from the durable record (journal
  // user_action events minus delivered.jsonl), so they are correct even when
  // the server is down.
  const sessions = listSessions(root).map((meta) => {
    if (!meta || meta.status !== 'active' || typeof meta.sessionId !== 'string') return meta;
    try {
      return { ...meta, pendingActions: pendingUserActions(root, meta.sessionId).length };
    } catch {
      return meta;
    }
  });

  printJson({
    server: {
      running,
      port: info && info.port !== undefined ? info.port : null,
      pid: info && info.pid !== undefined ? info.pid : null,
    },
    sessions,
  });
}

main().catch((err) => {
  process.stderr.write(`${(err && err.stack) || err}\n`);
  printJson({ server: { running: false, port: null, pid: null }, sessions: [] });
  process.exit(1);
});
