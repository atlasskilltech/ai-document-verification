const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { apiKeyAuth } = require('../../middleware/v1/apiKeyAuth');
const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1ApiKeyModel = require('../../models/v1/V1ApiKeyModel');
const V1AuditModel = require('../../models/v1/V1AuditModel');
const QueueService = require('../../services/v1/QueueService');

const JWT_SECRET = process.env.JWT_SECRET || 'v1-jwt-secret';

// ==========================================
// Admin Dashboard Routes (JWT auth)
// ==========================================
const adminAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Token required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
    }
};

// GET /v1/dashboard/admin - Admin dashboard stats
router.get('/admin', adminAuth, async (req, res) => {
    try {
        const stats = await V1VerificationRequestModel.getAdminStats();
        const queueStatus = QueueService.getStatus();

        // Calculate rejection rate
        const totalCompleted = stats.status_breakdown.reduce((sum, s) => {
            if (['verified', 'rejected'].includes(s.status)) return sum + s.count;
            return sum;
        }, 0);
        const rejectedCount = stats.status_breakdown.find(s => s.status === 'rejected')?.count || 0;
        const rejectionRate = totalCompleted > 0 ? ((rejectedCount / totalCompleted) * 100).toFixed(1) : 0;

        res.json({
            success: true,
            data: {
                total_requests: stats.totals.total_requests,
                status_breakdown: stats.status_breakdown,
                avg_confidence: stats.totals.avg_confidence,
                avg_risk_score: stats.totals.avg_risk_score,
                avg_processing_time_seconds: stats.totals.avg_processing_seconds,
                rejection_rate: `${rejectionRate}%`,
                recent_requests: stats.recent_requests,
                queue: queueStatus,
                risk_alerts: stats.recent_requests.filter(r => r.risk_score > 0.5)
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch admin dashboard' });
    }
});

// ==========================================
// User Dashboard Routes (API key auth)
// ==========================================

// GET /v1/dashboard/user - User dashboard stats
router.get('/user', apiKeyAuth, async (req, res) => {
    try {
        const stats = await V1VerificationRequestModel.getUserStats(req.apiUser.userId);
        const apiKeys = await V1ApiKeyModel.getByUserId(req.apiUser.userId);
        const recentRequests = await V1VerificationRequestModel.getByUserId(req.apiUser.userId, { limit: 10 });

        // API usage stats
        const activeKeys = apiKeys.filter(k => k.status === 'active');

        res.json({
            success: true,
            data: {
                total_requests: stats.total_requests,
                verified_count: stats.verified_count,
                rejected_count: stats.rejected_count,
                processing_count: stats.processing_count,
                avg_confidence: stats.avg_confidence,
                status_breakdown: stats.status_breakdown,
                recent_requests: recentRequests.requests,
                api_usage: {
                    active_keys: activeKeys.length,
                    total_keys: apiKeys.length
                }
            }
        });
    } catch (error) {
        console.error('User dashboard error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch user dashboard' });
    }
});

module.exports = router;
