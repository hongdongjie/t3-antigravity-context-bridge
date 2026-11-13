import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { parseContext, readContext } from './context.mjs';
import { configureProviderSettings } from './setup.mjs';

function v(value) {
  let n = BigInt(value);
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
const scalar = (field, value) => Buffer.concat([v(field * 8), v(value)]);
const message = (field, bytes) => Buffer.concat([v(field * 8 + 2), v(bytes.length), bytes]);
const blob = (used, size = 256000) => message(1, message(9, message(10,
  Buffer.concat([scalar(1, used), scalar(4, size)]))));

function removeTestDirectory(root) {
  const absolute = resolve(root);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith('t3-context-'));
  rmSync(absolute, { recursive: true, force: true });
}

test('parse exact metadata, large unrelated integers, and reject malformed values', () => {
  assert.deepEqual(parseContext(blob(53000)), { used: 53000, size: 256000 });
  assert.deepEqual(parseContext(Buffer.concat([scalar(20, 18446744073709551615n), blob(0)])), { used: 0, size: 256000 });
  assert.equal(parseContext(blob(100, 0)), null);
  assert.equal(parseContext(blob(100).subarray(0, 4)), null);
  assert.equal(parseContext(Buffer.from([0x80])), null);
  assert.equal(parseContext(message(1, scalar(9, 42))), null);
});

test('read latest complete snapshot, allow compaction, and avoid creating missing DBs', () => {
  const root = mkdtempSync(join(tmpdir(), 't3-context-test-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.equal(readContext(root, id), null);
    assert.equal(readContext(root, '../escape'), null);
    const database = new DatabaseSync(join(root, id + '.db'));
    database.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    const insert = database.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    insert.run(0, blob(53000));
    insert.run(1, Buffer.from([0]));
    assert.deepEqual(readContext(root, id), { used: 53000, size: 256000 });
    insert.run(2, blob(12000, 512000));
    assert.deepEqual(readContext(root, id), { used: 12000, size: 512000 });
    assert.equal(database.prepare('SELECT count(*) AS n FROM gen_metadata').get().n, 3);
    database.close();
  } finally { removeTestDirectory(root); }
});

test('setup wraps, stays idempotent, and cleanly unwraps provider settings', () => {
  const initial = {
    idleCompaction: 'onReturn',
    providerInstances: {
      'antigravity-cli': {
        driver: 'acpRegistry',
        enabled: true,
        config: {
          source: 'local',
          commandPath: '/usr/local/bin/agy',
          commandArgs: ['acp', '--process-per-session']
        }
      }
    }
  };
  const bridgePath = resolve('/opt/bridge/bridge.mjs');
  const wrapped = configureProviderSettings(initial, {
    nodePath: '/usr/local/bin/node',
    bridgePath
  });
  assert.equal(wrapped.changed, true);
  assert.equal(wrapped.commandPath, '/usr/local/bin/node');
  assert.deepEqual(wrapped.commandArgs, [
    '--no-warnings',
    bridgePath,
    '/usr/local/bin/agy',
    'acp',
    '--process-per-session'
  ]);

  const repeated = configureProviderSettings(wrapped.settings, {
    nodePath: '/usr/local/bin/node',
    bridgePath
  });
  assert.equal(repeated.changed, false);

  wrapped.settings.idleCompaction = 'never';
  const unwrapped = configureProviderSettings(wrapped.settings, {
    nodePath: '/usr/local/bin/node',
    bridgePath,
    uninstall: true
  });
  assert.equal(unwrapped.changed, true);
  assert.equal(unwrapped.settings.idleCompaction, 'never');
  assert.equal(unwrapped.commandPath, '/usr/local/bin/agy');
  assert.deepEqual(unwrapped.commandArgs, ['acp', '--process-per-session']);
});

test('ACP passthrough, restored session, fresh usage, native fallback, and clean EOF', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 't3-context-proxy-test-'));
  const id = '22222222-2222-4222-8222-222222222222';
  const directory = join(root, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, id + '.db'));
  database.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  database.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(blob(53000));
  const fixture = join(root, 'fake-acp.mjs');
  writeFileSync(fixture, `
import {createInterface} from 'node:readline';
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='test/native') send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'usage_update',used:777,size:256000}}});
  else if(Object.hasOwn(m,'id')) send({jsonrpc:'2.0',id:m.id,result:m.method==='session/load'?{}:{echo:m.params}});
});
`);
  const child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'bridge.mjs'), process.execPath, fixture], {
    env: { ...process.env, HOME: root, USERPROFILE: root },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const messages = [];
  const waiters = new Set();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const m = JSON.parse(line);
    messages.push(m);
    for (const waiter of waiters) waiter();
  });
  const send = o => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  const until = predicate => new Promise((resolve, reject) => {
    const done = () => {
      const found = messages.find(predicate);
      if (found) { clearTimeout(timeout); waiters.delete(done); resolve(found); }
    };
    const timeout = setTimeout(() => { waiters.delete(done); reject(new Error('No expected ACP message')); }, 4500);
    waiters.add(done);
    done();
  });
  try {
    const params = { clientInfo: { name: 't3-code', version: 'test' }, protocolVersion: 1 };
    send({ id: 0, method: 'initialize', params });
    assert.deepEqual((await until(m => m.id === 0)).result.echo, params);
    send({ id: 1, method: 'session/load', params: { sessionId: id, cwd: root } });
    await until(m => m.params?.update?.used === 53000);
    assert.ok(messages.findIndex(m => m.id === 1) < messages.findIndex(m => m.params?.update?.used === 53000));
    database.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(blob(54000));
    assert.equal((await until(m => m.params?.update?.used === 54000)).params.sessionId, id);
    send({ method: 'test/native', params: { sessionId: id } });
    await until(m => m.params?.update?.used === 777);
    database.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(blob(55000));
    // A protocol ping after one poll proves native usage disables supplemental reports.
    await new Promise(resolve => setTimeout(resolve, 1200));
    send({ id: 'ping', method: 'test/ping', params: { unchanged: true } });
    await until(m => m.id === 'ping');
    assert.equal(messages.some(m => m.params?.update?.used === 55000), false);
    const exited = once(child, 'exit');
    child.stdin.end();
    assert.equal((await exited)[0], 0);
  } finally {
    child.kill();
    lines.close();
    database.close();
    removeTestDirectory(root);
  }
});
