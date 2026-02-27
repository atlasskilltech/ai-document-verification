/**
 * In-memory rate limiter for general endpoints (non-API-key routes like login/register).
 * For API-key-authenticated routes, rate limiting is handled in apiKeyAuth middleware.
 */
const rateLimitStore = new Map();

// Clean up old entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore) {
        if (now - data.windowStart > 3600000) {
            rateLimitStore.delete(key);
        }
    }
}, 300000);

function createRateLimiter({ windowMs = 60000, maxRequests = 30, message = 'Too many requests' } = {}) {
    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();

        let record = rateLimitStore.get(key);
        if (!record || now - record.windowStart > windowMs) {
            record = { windowStart: now, count: 0 };
            rateLimitStore.set(key, record);
        }

        record.count++;

        if (record.count > maxRequests) {
            const retryAfter = Math.ceil((record.windowStart + windowMs - now) / 1000);
            res.set('Retry-After', retryAfter);
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message,
                retry_after_seconds: retryAfter
            });
        }

        res.set('X-RateLimit-Limit', maxRequests);
        res.set('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
        next();
    };
}

// Pre-configured limiters
const loginLimiter = createRateLimiter({ windowMs: 900000, maxRequests: 10, message: 'Too many login attempts. Try again in 15 minutes.' });
const registerLimiter = createRateLimiter({ windowMs: 3600000, maxRequests: 10, message: 'Too many registration attempts. Try again later.' });
const generalLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 60, message: 'Too many requests. Slow down.' });

module.exports = { createRateLimiter, loginLimiter, registerLimiter, generalLimiter };
