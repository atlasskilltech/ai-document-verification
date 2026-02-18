const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../../middleware/v1/apiKeyAuth');
const { ssrfProtectionMiddleware, validateUrl } = require('../../middleware/v1/ssrfProtection');
const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');
const V1BulkJobModel = require('../../models/v1/V1BulkJobModel');
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

        // Validate document type exists (check user-specific first, then global)
        const docMaster = await V1DocumentMasterModel.findByCodeForUser(document_type, req.apiUser.userId);
        if (!docMaster) {
            return res.status(400).json({
                error: 'Bad request',
                message: `Unknown document_type: '${document_type}'. Use GET /v1/verify/document-types for valid types.`
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

        // Extract wrong document info from AI response if available
        const aiResponse = request.ai_response || {};
        const wrongDocument = aiResponse.document_type_match === false;

        const result = {
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
        };

        // If wrong document detected, include clear info in response
        if (wrongDocument) {
            result.wrong_document = true;
            result.detected_document_type = aiResponse.detected_document_type || 'Unknown';
            result.expected_document_type = aiResponse.expected_document_type || request.document_type;
        }

        // Include authenticity verification results
        result.is_genuine = aiResponse.is_genuine !== false;
        result.authenticity_checks = aiResponse.authenticity_checks || {};
        result.fraud_indicators = aiResponse.fraud_indicators || [];
        result.data_consistency = aiResponse.data_consistency || {};

        res.json(result);
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
// GET /v1/document-types - List available document types (global + user's own)
// ==========================================
router.get('/document-types', async (req, res) => {
    try {
        const types = await V1DocumentMasterModel.getAllForUser(req.apiUser.userId, { active: true });
        res.json({
            success: true,
            data: types.map(t => ({
                id: t.id,
                code: t.code,
                name: t.name,
                allowed_formats: t.allowed_formats,
                max_size_mb: t.max_size_mb,
                required_fields: t.required_fields,
                validation_rules: t.validation_rules,
                is_global: t.user_id === null,
                is_own: t.user_id === req.apiUser.userId
            }))
        });
    } catch (error) {
        console.error('Document types error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list document types' });
    }
});

// ==========================================
// POST /v1/verify/bulk - Bulk document verification
// ==========================================
router.post('/bulk', async (req, res) => {
    try {
        const { documents, callback_url, metadata } = req.body;

        // Validate documents array
        if (!Array.isArray(documents) || documents.length === 0) {
            return res.status(400).json({
                error: 'Bad request',
                message: 'documents must be a non-empty array'
            });
        }

        if (documents.length > 50) {
            return res.status(400).json({
                error: 'Bad request',
                message: 'Maximum 50 documents per bulk request'
            });
        }

        // Validate each document before processing any
        const errors = [];
        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            if (!doc.document_type || !doc.file_url) {
                errors.push({ index: i, message: 'document_type and file_url are required' });
                continue;
            }

            const docMaster = await V1DocumentMasterModel.findByCodeForUser(doc.document_type, req.apiUser.userId);
            if (!docMaster) {
                errors.push({ index: i, message: `Unknown document_type: '${doc.document_type}'` });
                continue;
            }

            // SSRF protection check
            const urlCheck = await validateUrl(doc.file_url);
            if (!urlCheck.valid) {
                errors.push({ index: i, message: `Invalid file_url: ${urlCheck.reason}` });
                continue;
            }

            // Format check
            const ext = doc.file_url.split('.').pop().split('?')[0].toLowerCase();
            const allowed = docMaster.allowed_formats || ['jpg', 'png', 'pdf'];
            if (!allowed.includes(ext) && !allowed.includes('*')) {
                errors.push({ index: i, message: `File format '${ext}' not allowed for ${doc.document_type}` });
            }
        }

        if (errors.length > 0) {
            return res.status(400).json({
                error: 'Validation failed',
                message: `${errors.length} document(s) failed validation`,
                errors
            });
        }

        // Create bulk job
        const bulkJob = await V1BulkJobModel.create({
            userId: req.apiUser.userId,
            totalDocuments: documents.length,
            callbackUrl: callback_url || null,
            metadata: metadata || {}
        });

        // Create individual verification requests and link to bulk job
        const results = [];
        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const vr = await V1VerificationRequestModel.create({
                userId: req.apiUser.userId,
                referenceId: doc.reference_id || null,
                documentType: doc.document_type,
                fileUrl: doc.file_url,
                metadata: doc.metadata || {}
            });

            // Link to bulk job
            await V1BulkJobModel.addItem(bulkJob.id, vr.id, i);

            // Queue for processing
            await QueueService.addJob('verify_document', { requestId: vr.id });

            results.push({
                index: i,
                system_reference_id: vr.system_reference_id,
                document_type: doc.document_type,
                status: 'accepted'
            });
        }

        // Mark bulk job as processing
        await V1BulkJobModel.setProcessing(bulkJob.id);

        // Audit log
        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'bulk_verification.submitted',
            resourceType: 'bulk_job',
            resourceId: bulkJob.bulk_id,
            details: { total_documents: documents.length },
            ipAddress: req.ip
        });

        res.status(202).json({
            status: 'accepted',
            bulk_id: bulkJob.bulk_id,
            total_documents: documents.length,
            documents: results
        });
    } catch (error) {
        console.error('Bulk verify endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to submit bulk verification' });
    }
});

// ==========================================
// GET /v1/verify/bulk/:bulk_id - Get bulk job status
// ==========================================
router.get('/bulk/:bulk_id', async (req, res) => {
    try {
        const job = await V1BulkJobModel.findByBulkId(req.params.bulk_id);
        if (!job) {
            return res.status(404).json({ error: 'Not found', message: 'Bulk job not found' });
        }
        if (job.user_id !== req.apiUser.userId && req.apiUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
        }

        // Refresh progress
        await V1BulkJobModel.updateProgress(job.id);
        const updated = await V1BulkJobModel.findByBulkId(req.params.bulk_id);

        // Get individual items
        const items = await V1BulkJobModel.getItems(job.id);

        res.json({
            success: true,
            data: {
                bulk_id: updated.bulk_id,
                status: updated.status,
                total_documents: updated.total_documents,
                completed: updated.completed,
                verified: updated.verified,
                rejected: updated.rejected,
                failed: updated.failed,
                progress_percent: updated.total_documents > 0
                    ? Math.round((updated.completed / updated.total_documents) * 100) : 0,
                created_at: updated.created_at,
                completed_at: updated.completed_at,
                documents: items
            }
        });
    } catch (error) {
        console.error('Bulk status error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to fetch bulk status' });
    }
});

// ==========================================
// GET /v1/verify/bulk - List user's bulk jobs
// ==========================================
router.get('/bulk', async (req, res) => {
    try {
        const { page, limit } = req.query;
        const result = await V1BulkJobModel.getByUserId(req.apiUser.userId, {
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20
        });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('List bulk jobs error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list bulk jobs' });
    }
});

// ==========================================
// User Document Type Management (My Document Setup)
// ==========================================

// GET /v1/verify/my-document-types - List user's own custom document types
router.get('/my-document-types', async (req, res) => {
    try {
        const active = req.query.active !== 'false';
        const types = await V1DocumentMasterModel.getByUserId(req.apiUser.userId, { active });
        res.json({ success: true, data: types });
    } catch (error) {
        console.error('List user doc types error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list document types' });
    }
});

// POST /v1/verify/my-document-types - Create custom document type
router.post('/my-document-types', async (req, res) => {
    try {
        const { name, code, allowed_formats, max_size_mb, required_fields, validation_rules } = req.body;

        if (!name || !code) {
            return res.status(400).json({ error: 'Bad request', message: 'Name and code are required' });
        }

        // Validate code format (lowercase, no spaces)
        if (!/^[a-z0-9_-]+$/.test(code)) {
            return res.status(400).json({ error: 'Bad request', message: 'Code must be lowercase alphanumeric with underscores/hyphens only' });
        }

        // Check if code already exists for this user
        const existing = await V1DocumentMasterModel.findByCodeForUser(code, req.apiUser.userId);
        if (existing && existing.user_id === req.apiUser.userId) {
            return res.status(409).json({ error: 'Conflict', message: `You already have a document type with code '${code}'` });
        }

        const id = await V1DocumentMasterModel.create({
            name,
            code,
            allowedFormats: allowed_formats || ['jpg', 'png', 'pdf'],
            maxSizeMb: max_size_mb || 5,
            requiredFields: required_fields || [],
            validationRules: validation_rules || {},
            userId: req.apiUser.userId,
            createdBy: req.apiUser.userId
        });

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'user_document_type.created',
            resourceType: 'document_master',
            resourceId: String(id),
            details: { name, code },
            ipAddress: req.ip
        });

        const doc = await V1DocumentMasterModel.findById(id);
        res.status(201).json({ success: true, message: 'Document type created', data: doc });
    } catch (error) {
        console.error('Create user doc type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to create document type' });
    }
});

// PUT /v1/verify/my-document-types/:id - Update user's own document type
router.put('/my-document-types/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name, code, allowed_formats, max_size_mb, required_fields, validation_rules, is_active } = req.body;

        const existing = await V1DocumentMasterModel.findById(id);
        if (!existing || existing.user_id !== req.apiUser.userId) {
            return res.status(404).json({ error: 'Not found', message: 'Document type not found or you do not own it' });
        }

        await V1DocumentMasterModel.updateByUser(id, req.apiUser.userId, {
            name,
            code,
            allowedFormats: allowed_formats,
            maxSizeMb: max_size_mb,
            requiredFields: required_fields,
            validationRules: validation_rules,
            isActive: is_active
        });

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'user_document_type.updated',
            resourceType: 'document_master',
            resourceId: String(id),
            details: req.body,
            ipAddress: req.ip
        });

        const updated = await V1DocumentMasterModel.findById(id);
        res.json({ success: true, message: 'Document type updated', data: updated });
    } catch (error) {
        console.error('Update user doc type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to update document type' });
    }
});

// DELETE /v1/verify/my-document-types/:id - Delete user's own document type
router.delete('/my-document-types/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const deleted = await V1DocumentMasterModel.deleteByUser(id, req.apiUser.userId);
        if (!deleted) {
            return res.status(404).json({ error: 'Not found', message: 'Document type not found or you do not own it' });
        }

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'user_document_type.deleted',
            resourceType: 'document_master',
            resourceId: String(id),
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Document type deleted' });
    } catch (error) {
        console.error('Delete user doc type error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to delete document type' });
    }
});

module.exports = router;
