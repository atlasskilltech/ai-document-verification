const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const V1UserModel = require('../../models/v1/V1UserModel');
const V1ApiKeyModel = require('../../models/v1/V1ApiKeyModel');
const V1AuditModel = require('../../models/v1/V1AuditModel');
const { loginLimiter, registerLimiter } = require('../../middleware/v1/rateLimiter');

const JWT_SECRET = process.env.JWT_SECRET || 'v1-jwt-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

/**
 * Middleware: JWT authentication for v1 auth routes
 */
const jwtAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized', message: 'JWT token required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }
};

// ==========================================
// POST /auth/register - Register new user
// ==========================================
router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Bad request', message: 'Name, email, and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Bad request', message: 'Password must be at least 8 characters' });
        }

        // Check if email already exists
        const existing = await V1UserModel.findByEmail(email);
        if (existing) {
            return res.status(409).json({ error: 'Conflict', message: 'Email already registered' });
        }

        const userId = await V1UserModel.create({
            name,
            email,
            password,
            role: role === 'admin' ? 'admin' : 'user'
        });

        // Auto-generate first API key
        const apiKeyResult = await V1ApiKeyModel.create({ userId, name: 'Default Key' });

        await V1AuditModel.log({
            userId,
            action: 'user.registered',
            resourceType: 'user',
            resourceId: String(userId),
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                user_id: userId,
                email,
                role: role === 'admin' ? 'admin' : 'user',
                api_key: apiKeyResult.api_key
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Registration failed' });
    }
});

// ==========================================
// POST /auth/login - Login and get JWT
// ==========================================
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Bad request', message: 'Email and password are required' });
        }

        const user = await V1UserModel.findByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Forbidden', message: 'Account is deactivated' });
        }

        const isValid = await V1UserModel.validatePassword(password, user.password);
        if (!isValid) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, name: user.name },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        await V1AuditModel.log({
            userId: user.id,
            action: 'user.login',
            resourceType: 'user',
            resourceId: String(user.id),
            ipAddress: req.ip
        });

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Login failed' });
    }
});

// ==========================================
// GET /auth/profile - Get current user profile
// ==========================================
router.get('/profile', jwtAuth, async (req, res) => {
    try {
        const user = await V1UserModel.findById(req.user.userId);
        if (!user) {
            return res.status(404).json({ error: 'Not found', message: 'User not found' });
        }

        const apiKeys = await V1ApiKeyModel.getByUserId(user.id);

        res.json({
            success: true,
            data: {
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    created_at: user.created_at
                },
                api_keys: apiKeys.map(k => ({
                    id: k.id,
                    name: k.name,
                    api_key: k.api_key.substring(0, 10) + '...',
                    rate_limit: k.rate_limit,
                    burst_limit: k.burst_limit,
                    status: k.status,
                    last_used_at: k.last_used_at,
                    created_at: k.created_at
                }))
            }
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch profile' });
    }
});

// ==========================================
// POST /auth/api/generate - Generate new API key
// ==========================================
router.post('/api/generate', jwtAuth, async (req, res) => {
    try {
        const { name, rate_limit, burst_limit, expires_in_days } = req.body;

        const days = parseInt(expires_in_days) || 365; // Default: 1 year
        let expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + days);

        const result = await V1ApiKeyModel.create({
            userId: req.user.userId,
            name: name || 'API Key',
            rateLimit: rate_limit || 1000,
            burstLimit: burst_limit || 50,
            expiresAt
        });

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'api_key.generated',
            resourceType: 'api_key',
            resourceId: String(result.id),
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            message: 'API key generated successfully',
            data: {
                id: result.id,
                api_key: result.api_key,
                name: name || 'API Key',
                rate_limit: rate_limit || 1000,
                burst_limit: burst_limit || 50,
                expires_at: expiresAt
            }
        });
    } catch (error) {
        console.error('API key generation error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to generate API key' });
    }
});

// ==========================================
// POST /auth/api/revoke/:id - Revoke an API key
// ==========================================
router.post('/api/revoke/:id', jwtAuth, async (req, res) => {
    try {
        const revoked = await V1ApiKeyModel.revoke(parseInt(req.params.id), req.user.userId);
        if (!revoked) {
            return res.status(404).json({ error: 'Not found', message: 'API key not found or already revoked' });
        }

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'api_key.revoked',
            resourceType: 'api_key',
            resourceId: req.params.id,
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'API key revoked successfully' });
    } catch (error) {
        console.error('API key revoke error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to revoke API key' });
    }
});

module.exports = router;
