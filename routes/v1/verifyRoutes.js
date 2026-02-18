const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../../middleware/v1/apiKeyAuth');
const { ssrfProtectionMiddleware } = require('../../middleware/v1/ssrfProtection');
const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');
const V1AuditModel = require('../../models/v1/V1AuditModel');
const QueueService = require('../../services/v1/QueueService');

// All routes require API key authentication
router.use(apiKeyAuth);

// ==========================================
// POST /v1/verify - Push document for verification
// ==========================================
router.post('/', ssrfProtectionMiddleware, async (req, res) => {
    try {
        const { reference_id, document_type, file_url, metadata } = req.body;

        // Validate required fields
        if (!document_type || !file_url) {
            return res.status(400).json({
                error: 'Bad request',
                message: 'document_type and file_url are required'
            });
        }

        // Validate document type exists
        const docMaster = await V1DocumentMasterModel.findByCode(document_type);
        if (!docMaster) {
            return res.status(400).json({
                error: 'Bad request',
                message: `Unknown document_type: '${document_type}'. Use GET /v1/document-types for valid types.`
            });
        }

        // Validate file URL format (basic check)
        const urlExtension = file_url.split('.').pop().split('?')[0].toLowerCase();
        const allowedFormats = docMaster.allowed_formats || ['jpg', 'png', 'pdf'];
        if (!allowedFormats.includes(urlExtension) && !allowedFormats.includes('*')) {
            return res.status(400).json({
                error: 'Bad request',
                message: `File format '${urlExtension}' not allowed for ${document_type}. Allowed: ${allowedFormats.join(', ')}`
            });
        }

        // Create verification request
        const result = await V1VerificationRequestModel.create({
            userId: req.apiUser.userId,
            referenceId: reference_id || null,
            documentType: document_type,
            fileUrl: file_url,
            metadata
        });

        // Add to processing queue
        await QueueService.addJob('verify_document', { requestId: result.id });

        // Audit log
        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'verification.submitted',
            resourceType: 'verification_request',
            resourceId: result.system_reference_id,
            details: { document_type, reference_id },
            ipAddress: req.ip
        });

        res.status(202).json({
            status: 'accepted',
            system_reference_id: result.system_reference_id,
            processing_status: 'processing'
        });
    } catch (error) {
        console.error('Verify endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to submit verification request' });
    }
});

// ==========================================
// GET /v1/status/:system_reference_id - Check status
// ==========================================
router.get('/status/:system_reference_id', async (req, res) => {
    try {
        const request = await V1VerificationRequestModel.findBySystemRefId(req.params.system_reference_id);
        if (!request) {
            return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        }

        // Ensure user can only see their own requests
        if (request.user_id !== req.apiUser.userId && req.apiUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
        }

        res.json({
            system_reference_id: request.system_reference_id,
            client_reference_id: request.client_reference_id,
            status: request.status,
            confidence: request.confidence,
            created_at: request.created_at,
            processed_at: request.processed_at
        });
    } catch (error) {
        console.error('Status endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch status' });
    }
});

// ==========================================
// GET /v1/result/:system_reference_id - Fetch full result
// ==========================================
router.get('/result/:system_reference_id', async (req, res) => {
    try {
        const request = await V1VerificationRequestModel.findBySystemRefId(req.params.system_reference_id);
        if (!request) {
            return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        }

        // Ensure user can only see their own requests
        if (request.user_id !== req.apiUser.userId && req.apiUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
        }

        // Only return full results if processing is complete
        if (['accepted', 'processing'].includes(request.status)) {
            return res.json({
                system_reference_id: request.system_reference_id,
                status: request.status,
                message: 'Document is still being processed. Check back later.'
            });
        }

        res.json({
            system_reference_id: request.system_reference_id,
            client_reference_id: request.client_reference_id,
            document_type: request.document_type,
            status: request.status,
            confidence: request.confidence,
            risk_score: request.risk_score,
            extracted_data: request.extracted_data,
            issues: request.issues,
            created_at: request.created_at,
            processed_at: request.processed_at
        });
    } catch (error) {
        console.error('Result endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch result' });
    }
});

// ==========================================
// GET /v1/requests - List user's verification requests
// ==========================================
router.get('/requests', async (req, res) => {
    try {
        const { status, page, limit } = req.query;
        const result = await V1VerificationRequestModel.getByUserId(req.apiUser.userId, {
            status,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20
        });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('List requests error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list requests' });
    }
});

// ==========================================
// GET /v1/document-types - List available document types
// ==========================================
router.get('/document-types', async (req, res) => {
    try {
        const types = await V1DocumentMasterModel.getAll({ active: true });
        res.json({
            success: true,
            data: types.map(t => ({
                code: t.code,
                name: t.name,
                allowed_formats: t.allowed_formats,
                max_size_mb: t.max_size_mb,
                required_fields: t.required_fields
            }))
        });
    } catch (error) {
        console.error('Document types error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list document types' });
    }
});

module.exports = router;
