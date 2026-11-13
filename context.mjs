import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

function varint(bytes, cursor) {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (cursor.pos >= bytes.length) throw new Error('Truncated protobuf');
    const byte = bytes[cursor.pos++];
    value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) {
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
  }
  throw new Error('Invalid protobuf varint');
}

function fields(bytes) {
  const result = new Map();
  const cursor = { pos: 0 };
  while (cursor.pos < bytes.length) {
    const tag = varint(bytes, cursor);
    if (!Number.isSafeInteger(tag) || tag > 0xffffffff) throw new Error('Invalid protobuf tag');
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 0) value = varint(bytes, cursor);
    else if (wire === 2) {
      const length = varint(bytes, cursor);
      if (!Number.isSafeInteger(length)) throw new Error('Invalid protobuf length');
      const end = cursor.pos + length;
      if (end > bytes.length) throw new Error('Truncated protobuf field');
      value = bytes.subarray(cursor.pos, end);
      cursor.pos = end;
    } else if (wire === 1 || wire === 5) {
      cursor.pos += wire === 1 ? 8 : 4;
      if (cursor.pos > bytes.length) throw new Error('Truncated protobuf fixed field');
    } else throw new Error('Unsupported protobuf wire type');
    result.set(field, value);
  }
  return result;
}

export function parseContext(data) {
  try {
    // Verified against agy 1.5.6 internal gen_metadata protobuf layout (1 -> 9 -> 10).
    let metadata = data;
    for (const field of [1, 9, 10]) {
      metadata = fields(metadata).get(field);
      if (!(metadata instanceof Uint8Array)) return null;
    }
    const context = fields(metadata);
    const used = context.get(1);
    const size = context.get(4);
    if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(size) || size <= 0) return null;
    return { used, size };
  } catch {
    return null;
  }
}

export function readContext(directory, sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  let database;
  try {
    database = new DatabaseSync(join(directory, sessionId + '.db'), { readOnly: true });
    database.exec('PRAGMA busy_timeout = 50');
    const rows = database.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 8').all();
    for (const row of rows) {
      const context = parseContext(row.data);
      if (context) return context;
    }
    return null;
  } catch {
    // A missing database, pending transaction, or changed schema must never interrupt ACP traffic.
    return null;
  } finally {
    database?.close();
  }
}
