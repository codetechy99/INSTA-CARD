const config = require('../config/config');

// Tiny cache layer: Redis when reachable, in-memory fallback otherwise.
// Never throws — cache failures must not break business logic.
const memory = new Map();
let redisClient; // undefined = not tried yet, null = unavailable

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(config.redis.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    redisClient.on('error', () => {}); // fail soft
    redisClient.connect().catch(() => {});
  } catch {
    redisClient = null;
  }
  return redisClient;
}

async function cacheGet(key) {
  const client = getRedis();
  if (client && client.status === 'ready') {
    try {
      const raw = await client.get(key);
      if (raw !== null) return JSON.parse(raw);
    } catch { /* fall through to memory */ }
  }
  const hit = memory.get(key);
  if (hit) {
    if (hit.expiry > Date.now()) return hit.value;
    memory.delete(key);
  }
  return null;
}

async function cacheSet(key, value, ttlMs) {
  const client = getRedis();
  if (client && client.status === 'ready') {
    try {
      await client.set(key, JSON.stringify(value), 'PX', ttlMs);
      return;
    } catch { /* fall through to memory */ }
  }
  memory.set(key, { value, expiry: Date.now() + ttlMs });
}

function clearMemory() {
  memory.clear();
}

module.exports = { cacheGet, cacheSet, clearMemory };
