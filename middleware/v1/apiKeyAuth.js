const V1ApiKeyModel = require('../../models/v1/V1ApiKeyModel');

/**
 * Authenticate requests using API key from Bearer token.
 * Attaches user info + API key info to req.apiUser
 */
const apiKeyAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Missing or invalid Authorization header. Use: Bearer {api_key}'
            });
        }

        const apiKey = authHeader.split(' ')[1];
        if (!apiKey) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'API key is required'
            });
        }

        const keyData = await V1ApiKeyModel.findByKey(apiKey);
        if (!keyData) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid or revoked API key'
            });
        }

        // Check if key is expired
        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'API key has expired'
            });
        }

        // Check if user is active
        if (!keyData.user_active) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'User account is deactivated'
            });
        }

        // Check rate limits
        const rateLimitResult = await V1ApiKeyModel.checkRateLimit(
            keyData.id,
            keyData.rate_limit,
            keyData.burst_limit
        );

        if (!rateLimitResult.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: rateLimitResult.reason,
                limit: rateLimitResult.limit,
                remaining: rateLimitResult.remaining,
                reset: rateLimitResult.reset
            });
        }

        // Update last used
        V1ApiKeyModel.updateLastUsed(keyData.id).catch(() => {});

        // Attach user info to request
        req.apiUser = {
            userId: keyData.user_id,
            apiKeyId: keyData.id,
            name: keyData.user_name,
            email: keyData.user_email,
            role: keyData.user_role,
            rateLimit: {
                hourly_remaining: rateLimitResult.hourly_remaining,
                burst_remaining: rateLimitResult.burst_remaining
            }
        };

        // Add rate limit headers
        res.set('X-RateLimit-Remaining', rateLimitResult.hourly_remaining);
        res.set('X-RateLimit-Burst-Remaining', rateLimitResult.burst_remaining);

        next();
    } catch (error) {
        console.error('API Key Auth Error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: 'Authentication service error'
        });
    }
};

/**
 * Require admin role for API key authenticated requests
 */
const requireApiAdmin = (req, res, next) => {
    if (!req.apiUser || req.apiUser.role !== 'admin') {
        return res.status(403).json({
            error: 'Forbidden',
            message: 'Admin access required'
        });
    }
    next();
};

module.exports = { apiKeyAuth, requireApiAdmin };
