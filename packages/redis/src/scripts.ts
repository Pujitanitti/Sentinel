/**
 * All rate-limit decisions must be atomic w.r.t. concurrent requests hitting
 * the same key, otherwise two parallel requests can both read "9/10 used"
 * and both get allowed, blowing past the limit. Each strategy below is a
 * single Lua script so Redis executes it as one atomic operation.
 */

/**
 * Fixed window counter.
 * KEYS[1] = counter key
 * ARGV[1] = window seconds
 * Returns: { count, ttlSeconds }
 */
export const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local windowSeconds = tonumber(ARGV[1])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, windowSeconds)
end
local ttl = redis.call('TTL', key)
if ttl < 0 then
  redis.call('EXPIRE', key, windowSeconds)
  ttl = windowSeconds
end
return { count, ttl }
`;

/**
 * Sliding window log using a sorted set of request timestamps (ms).
 * KEYS[1] = zset key
 * ARGV[1] = windowMs
 * ARGV[2] = limit
 * ARGV[3] = member (unique per request, e.g. a random string — uniqueness is
 *           all that's needed since Redis's own clock supplies the score)
 * Returns: { allowed(0/1), count, oldestTimestampMs, nowMs }
 *
 * Using Redis's TIME command (not a timestamp passed in from the calling
 * Node process) means this is correct even if multiple gateway instances'
 * system clocks have drifted relative to each other — Redis is the single
 * source of truth for "now", which is what "distributed" correctness
 * actually requires.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)

local oldest = 0
local range = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if range[2] ~= nil then
  oldest = tonumber(range[2])
end

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return { 1, count + 1, oldest, now }
else
  return { 0, count, oldest, now }
end
`;

/**
 * Token bucket. State stored as a hash: { tokens, timestamp }.
 * KEYS[1] = bucket key
 * ARGV[1] = capacity
 * ARGV[2] = refillRatePerSecond
 * ARGV[3] = requestedTokens (usually 1)
 * ARGV[4] = ttlSeconds (key expiry so idle buckets don't leak memory)
 * Returns: { allowed(0/1), tokensRemaining (x1000 as integer for precision), nowMs }
 *
 * Also uses Redis TIME rather than a client-supplied timestamp — see the
 * sliding-window script's comment above for why this matters.
 */
export const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local time = redis.call('TIME')
local now = tonumber(time[1]) + tonumber(time[2]) / 1000000

local data = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens = tonumber(data[1])
local timestamp = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  timestamp = now
end

local elapsed = now - timestamp
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * refillRate)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'timestamp', now)
redis.call('EXPIRE', key, ttl)

return { allowed, math.floor(tokens * 1000), math.floor(now * 1000) }
`;
