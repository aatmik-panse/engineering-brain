#!/usr/bin/env node
// engineering-brain boot: ensure the cockpit server is running, create a
// session, print ONE JSON line describing how to reach it.
//
// Usage: node scripts/brain.mjs [--request "<text>"]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findProjectRoot,
  ensureStateDirs,
  newSessionId,
  metaPath,
  mapJsonPath,
  readServerInfo,
  removeServerInfo,
  writeJsonFile,
  httpJson,
  probeHealth,
  parseArgs,
  printJson,
  failCli,
  sleep,
} from './lib/state.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_WAIT_MS = 5000;
const HEALTH_POLL_MS = 120;

async function ensureServer(root) {
  const existing = readServerInfo(root);
  if (await probeHealth(existing)) return existing;

  // Stale server.json (dead pid, or a foreign process squatting the recorded
  // port): the health probe just failed, so clear the record and only trust
  // the replacement server's own write.
  if (existing) {
    process.stderr.write(
      `stale server.json (pid ${existing.pid ?? '?'} not healthy on port ${existing.port ?? '?'}); replacing\n`
    );
  }
  removeServerInfo(root);

  const serverScript = path.join(SCRIPTS_DIR, 'brain-server.mjs');
  const child = spawn(process.execPath, [serverScript, '--root', root], {
    detached: true,
    stdio: 'ignore',
    cwd: root,
  });
  child.unref();

  // If the server exits before becoming healthy (e.g. EADDRINUSE on every
  // fallback port), report it immediately instead of waiting out the deadline.
  let childExit = null;
  child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });
  child.on('error', (err) => {
    childExit = { code: null, signal: null, error: (err && err.message) || String(err) };
  });

  const deadline = Date.now() + HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    const info = readServerInfo(root);
    if (await probeHealth(info)) return info;
    if (childExit) {
      const reason = childExit.error
        ? childExit.error
        : `exit code ${childExit.code}${childExit.signal ? `, signal ${childExit.signal}` : ''}`;
      failCli(
        `brain server exited before becoming healthy (${reason}); ` +
          'ports 8641-8650 may all be in use — free one or stop the other servers'
      );
    }
    await sleep(HEALTH_POLL_MS);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const request = typeof args.request === 'string' ? args.request : null;

  const root = findProjectRoot(process.cwd());
  ensureStateDirs(root);

  const info = await ensureServer(root);
  if (!info) {
    failCli(
      `brain server did not become healthy within ${HEALTH_WAIT_MS}ms`,
      'Try running it in the foreground for diagnostics: node scripts/brain-server.mjs'
    );
  }

  const sessionId = newSessionId();
  const startedAt = Date.now();
  writeJsonFile(metaPath(root, sessionId), {
    sessionId,
    request,
    cwd: process.cwd(),
    startedAt,
    status: 'active',
  });

  if (request !== null) {
    try {
      const res = await httpJson({
        method: 'POST',
        port: info.port,
        path: '/emit',
        token: info.token,
        body: { session: sessionId, type: 'session_start', data: { request, cwd: process.cwd() } },
      });
      if (res.status !== 200) {
        process.stderr.write(`session_start emit failed: ${res.text}\n`);
      }
    } catch (err) {
      process.stderr.write(`session_start emit failed: ${(err && err.message) || err}\n`);
    }
  }

  printJson({
    ok: true,
    url: `http://127.0.0.1:${info.port}/?session=${sessionId}`,
    port: info.port,
    sessionId,
    token: info.token,
    mapExists: fs.existsSync(mapJsonPath(root)),
    projectRoot: root,
  });
}

main().catch((err) => failCli((err && err.message) || err, err && err.stack));
