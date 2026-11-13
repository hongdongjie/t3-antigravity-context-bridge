import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readContext } from './context.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('Usage: node --no-warnings bridge.mjs <path-to-agy> acp --process-per-session\n');
  process.exit(2);
}

const directory = process.env.ANTIGRAVITY_CONVERSATIONS_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const requests = new Map();
const sessions = new Map();
const nativeUsageSessions = new Set();
let closing = false;
let shutdownTimer;
const requestKey = id => `${typeof id}:${id}`;
const stdout = line => { if (!process.stdout.write(line + '\n')) child.stdout.pause(); };
process.stdout.on('drain', () => child.stdout.resume());
const parse = line => { try { return JSON.parse(line); } catch { return null; } };

function publish(sessionId, session) {
  if (session.nativeUsage || Date.now() < session.readyAt) return;
  const usage = readContext(directory, sessionId);
  if (!usage) return;
  const signature = `${usage.used}/${usage.size}`;
  if (signature === session.signature) return;
  session.signature = signature;
  process.stderr.write(`[t3-context] Context ${signature}\n`);
  stdout(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'usage_update', ...usage } }
  }));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = parse(line);
  if (message && Object.hasOwn(message, 'id') &&
      ['session/new', 'session/load', 'session/resume'].includes(message.method)) {
    requests.set(requestKey(message.id), { method: message.method, sessionId: message.params?.sessionId });
  }
  if (!closing && child.stdin.writable) {
    if (!child.stdin.write(line + '\n')) input.pause();
  }
});
child.stdin.on('drain', () => input.resume());
child.stdin.on('error', () => {});

const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
output.on('line', line => {
  // Always forward the original upstream message before emitting any supplemental notification.
  stdout(line);
  const message = parse(line);
  if (!message) return;
  if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'usage_update') {
    process.stderr.write(`[t3-context] Native context ${message.params.update.used}/${message.params.update.size}\n`);
    nativeUsageSessions.add(message.params.sessionId);
    const session = sessions.get(message.params.sessionId);
    if (session) session.nativeUsage = true;
  }
  if (message.method || !Object.hasOwn(message, 'id')) return;
  const request = requests.get(requestKey(message.id));
  requests.delete(requestKey(message.id));
  if (!request || message.error) return;
  if (['session/new', 'session/load', 'session/resume'].includes(request.method)) {
    const sessionId = message.result?.sessionId ?? request.sessionId;
    if (typeof sessionId === 'string') {
      // T3 discards usage_update while a newly opened session is still in Starting state.
      sessions.set(sessionId, { readyAt: Date.now() + 500, signature: '', nativeUsage: nativeUsageSessions.has(sessionId) });
    }
  }
});

const timer = setInterval(() => {
  for (const [sessionId, session] of sessions) publish(sessionId, session);
}, 1000);

function terminateTree() {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else child.kill('SIGTERM');
}

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  child.stdin.end();
  shutdownTimer = setTimeout(terminateTree, 1500);
}

input.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdout.on('error', shutdown);
child.on('error', error => {
  process.stderr.write(`[t3-context] Could not start official CLI: ${error.code ?? 'unknown error'}\n`);
  clearInterval(timer);
  input.close();
  process.exitCode = 1;
});
child.on('close', code => {
  closing = true;
  clearInterval(timer);
  clearTimeout(shutdownTimer);
  input.close();
  process.stdin.destroy();
  process.exitCode = code ?? 1;
});
