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
 * ARGV[1] = nowMs
 * ARGV[2] = windowMs
 * ARGV[3] = limit
 * ARGV[4] = member (unique per request, e.g. "<nowMs>-<random>")
 * Returns: { allowed(0/1), count, oldestTimestampMs }
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

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
  return { 1, count + 1, oldest }
else
  return { 0, count, oldest }
end
`;

/**
 * Token bucket. State stored as a hash: { tokens, timestamp }.
 * KEYS[1] = bucket key
 * ARGV[1] = nowSeconds (float, ms precision as decimal)
 * ARGV[2] = capacity
 * ARGV[3] = refillRatePerSecond
 * ARGV[4] = requestedTokens (usually 1)
 * ARGV[5] = ttlSeconds (key expiry so idle buckets don't leak memory)
 * Returns: { allowed(0/1), tokensRemaining (x1000 as integer for precision) }
 */
export const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

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

return { allowed, math.floor(tokens * 1000) }
`;
