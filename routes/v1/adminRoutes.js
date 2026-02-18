const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');
const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1UserModel = require('../../models/v1/V1UserModel');
const V1AuditModel = require('../../models/v1/V1AuditModel');
const QueueService = require('../../services/v1/QueueService');

const JWT_SECRET = process.env.JWT_SECRET || 'v1-jwt-secret';

/**
 * Admin JWT auth middleware
 */
const adminAuth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized', message: 'JWT token required' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }
};

// Apply admin auth to all routes
router.use(adminAuth);

// ==========================================
// Document Configuration Routes
// ==========================================

// POST /admin/document - Create document type
router.post('/document', async (req, res) => {
    try {
        const { name, code, allowed_formats, max_size_mb, required_fields, validation_rules } = req.body;

        if (!name || !code) {
            return res.status(400).json({ error: 'Bad request', message: 'Name and code are required' });
        }

        // Check for duplicate code
        const existing = await V1DocumentMasterModel.findByCode(code);
        if (existing) {
            return res.status(409).json({ error: 'Conflict', message: `Document type with code '${code}' already exists` });
        }

        const id = await V1DocumentMasterModel.create({
            name,
            code,
            allowedFormats: allowed_formats,
            maxSizeMb: max_size_mb,
            requiredFields: required_fields,
            validationRules: validation_rules,
            createdBy: req.user.userId
        });

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'document_type.created',
            resourceType: 'document_master',
            resourceId: String(id),
            details: { name, code },
            ipAddress: req.ip
        });

        const doc = await V1DocumentMasterModel.findById(id);
        res.status(201).json({ success: true, message: 'Document type created', data: doc });
    } catch (error) {
        console.error('Create document type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to create document type' });
    }
});

// GET /admin/document - List all document types
router.get('/document', async (req, res) => {
    try {
        const active = req.query.active !== 'false';
        const documents = await V1DocumentMasterModel.getAll({ active });
        res.json({ success: true, data: documents });
    } catch (error) {
        console.error('List document types error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list document types' });
    }
});

// PUT /admin/document/:id - Update document type
router.put('/document/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, code, allowed_formats, max_size_mb, required_fields, validation_rules, is_active } = req.body;

        const existing = await V1DocumentMasterModel.findById(id);
        if (!existing) {
            return res.status(404).json({ error: 'Not found', message: 'Document type not found' });
        }

        await V1DocumentMasterModel.update(id, {
            name,
            code,
            allowedFormats: allowed_formats,
            maxSizeMb: max_size_mb,
            requiredFields: required_fields,
            validationRules: validation_rules,
            isActive: is_active
        });

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'document_type.updated',
            resourceType: 'document_master',
            resourceId: String(id),
            details: req.body,
            ipAddress: req.ip
        });

        const updated = await V1DocumentMasterModel.findById(id);
        res.json({ success: true, message: 'Document type updated', data: updated });
    } catch (error) {
        console.error('Update document type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to update document type' });
    }
});

// DELETE /admin/document/:id - Delete document type
router.delete('/document/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const existing = await V1DocumentMasterModel.findById(id);
        if (!existing) {
            return res.status(404).json({ error: 'Not found', message: 'Document type not found' });
        }

        await V1DocumentMasterModel.delete(id);

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'document_type.deleted',
            resourceType: 'document_master',
            resourceId: String(id),
            details: { name: existing.name, code: existing.code },
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Document type deleted' });
    } catch (error) {
        console.error('Delete document type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to delete document type' });
    }
});

// ==========================================
// Admin Monitoring Routes
// ==========================================

// GET /admin/requests - View all verification requests
router.get('/requests', async (req, res) => {
    try {
        const { status, user_id, page, limit } = req.query;
        const requests = await V1VerificationRequestModel.getAllForAdmin({
            status,
            userId: user_id ? parseInt(user_id) : null,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20
        });
        res.json({ success: true, data: requests });
    } catch (error) {
        console.error('List requests error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list requests' });
    }
});

// POST /admin/requests/:id/override - Override AI decision
router.post('/requests/:id/override', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status, confidence } = req.body;

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ error: 'Bad request', message: 'Status must be verified or rejected' });
        }

        const request = await V1VerificationRequestModel.findById(id);
        if (!request) {
            return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        }

        await V1VerificationRequestModel.overrideStatus(id, { status, confidence });

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'request.override',
            resourceType: 'verification_request',
            resourceId: request.system_reference_id,
            details: { previous_status: request.status, new_status: status, confidence },
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Decision overridden', data: { status, confidence } });
    } catch (error) {
        console.error('Override error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to override decision' });
    }
});

// POST /admin/requests/:id/reprocess - Reprocess document
router.post('/requests/:id/reprocess', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const request = await V1VerificationRequestModel.findById(id);
        if (!request) {
            return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        }

        await V1VerificationRequestModel.reprocess(id);

        // Add to queue for reprocessing
        await QueueService.addJob('verify_document', { requestId: id });

        await V1AuditModel.log({
            userId: req.user.userId,
            action: 'request.reprocess',
            resourceType: 'verification_request',
            resourceId: request.system_reference_id,
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Document queued for reprocessing' });
    } catch (error) {
        console.error('Reprocess error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to reprocess' });
    }
});

// GET /admin/analytics - Dashboard analytics
router.get('/analytics', async (req, res) => {
    try {
        const stats = await V1VerificationRequestModel.getAdminStats();
        const users = await V1UserModel.getAll({ limit: 100 });
        const queueStatus = QueueService.getStatus();

        res.json({
            success: true,
            data: {
                verification_stats: stats,
                total_users: users.total,
                queue: queueStatus
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch analytics' });
    }
});

// GET /admin/users - List all users
router.get('/users', async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await V1UserModel.getAll({
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20
        });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('List users error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list users' });
    }
});

// GET /admin/audit - View audit logs
router.get('/audit', async (req, res) => {
    try {
        const { page, limit, user_id, action } = req.query;
        const logs = await V1AuditModel.getAll({
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 50,
            userId: user_id ? parseInt(user_id) : null,
            action
        });
        res.json({ success: true, data: logs });
    } catch (error) {
        console.error('Audit log error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch audit logs' });
    }
});

module.exports = router;
