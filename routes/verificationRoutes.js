const express = require('express');
const router = express.Router();
const scheduler = require('../services/VerificationScheduler');

// ===================== SCHEDULER CONTROLS =====================

/**
 * GET /api/verification/status
 * Get full scheduler + engine status
 */
router.get('/status', (req, res) => {
    res.json({ success: true, data: scheduler.getStatus() });
});

/**
 * GET /api/verification/logs
 * Get recent verification logs
 * Query: ?limit=100
 */
router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json({ success: true, data: scheduler.getLogs(limit) });
});

/**
 * GET /api/verification/config
 * Get current scheduler configuration
 */
router.get('/config', (req, res) => {
    res.json({ success: true, data: scheduler.getConfig() });
});

/**
 * PUT /api/verification/config
 * Update scheduler configuration
 * Body: { cronSchedule?, concurrency?, retryAttempts?, skipAlreadyVerified?, ... }
 */
router.put('/config', (req, res) => {
    const updated = scheduler.updateConfig(req.body);
    res.json({ success: true, data: updated });
});

/**
 * POST /api/verification/scheduler/start
 * Start the cron scheduler
 */
router.post('/scheduler/start', (req, res) => {
    scheduler.startScheduler();
    scheduler.startAutoWatch();
    res.json({ success: true, message: 'Scheduler and auto-watch started', data: scheduler.getStatus() });
});

/**
 * POST /api/verification/scheduler/stop
 * Stop the cron scheduler and any running batch
 */
router.post('/scheduler/stop', (req, res) => {
    scheduler.stopScheduler();
    res.json({ success: true, message: 'Scheduler stopped', data: scheduler.getStatus() });
});

// ===================== MANUAL TRIGGERS =====================

/**
 * POST /api/verification/run
 * Trigger a full batch verification run immediately
 */
router.post('/run', async (req, res) => {
    if (scheduler.isRunning) {
        return res.status(409).json({
            success: false,
            message: 'A verification batch is already running',
            data: scheduler.getStatus()
        });
    }

    // Run in background - respond immediately
    res.json({
        success: true,
        message: 'Batch verification started',
        data: scheduler.getStatus()
    });

    // Kick off asynchronously
    scheduler.runBatch().catch(err => {
        console.error('Batch run error:', err);
    });
});

/**
 * POST /api/verification/run-student
 * Verify all documents for a single student
 * Body: { applnID: "2500623" }
 */
router.post('/run-student', async (req, res) => {
    const { applnID } = req.body;
    if (!applnID) {
        return res.status(400).json({ success: false, message: 'applnID is required' });
    }

    if (scheduler.isRunning) {
        return res.status(409).json({
            success: false,
            message: 'A verification job is already running. Stop it first.',
            data: scheduler.getStatus()
        });
    }

    try {
        const result = await scheduler.verifySingleStudent(applnID);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/verification/stop
 * Stop the currently running batch
 */
router.post('/stop', (req, res) => {
    if (!scheduler.isRunning) {
        return res.json({ success: true, message: 'No batch is running' });
    }
    scheduler.shouldStop = true;
    res.json({ success: true, message: 'Stop signal sent to running batch' });
});

// ===================== PROXY: STUDENT & DOCUMENT APIs =====================

/**
 * GET /api/verification/students
 * Fetch student list from Atlas API
 * Query: ?filter=unverified (default) | all
 *   - unverified: exclude students already verified (completed)
 *   - all: return every student
 */
router.get('/students', async (req, res) => {
    try {
        const result = await scheduler.atlasClient.getStudentList();
        const filter = req.query.filter || 'unverified';

        if (filter === 'unverified' && result && result.data) {
            const dataArr = Array.isArray(result.data) ? result.data : [result.data];
            const allResults = scheduler.getAllStudentResults();
            const verifiedIDs = new Set(
                allResults
                    .filter(r => r.status === 'completed')
                    .map(r => String(r.applnID))
            );

            const filtered = dataArr.filter(s => {
                const id = String(s.applnID || s.id || s.application_id);
                return !verifiedIDs.has(id);
            });

            res.json({ success: true, data: { ...result, data: filtered } });
        } else {
            res.json({ success: true, data: result });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/verification/documents
 * Fetch documents for a student
 * Body: { applnID: "2500623" }
 */
router.post('/documents', async (req, res) => {
    try {
        const { applnID } = req.body;
        if (!applnID) {
            return res.status(400).json({ success: false, message: 'applnID is required' });
        }
        const result = await scheduler.atlasClient.getDocumentList(applnID);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/verification/runs
 * Get history of verification runs
 */
router.get('/runs', (req, res) => {
    res.json({ success: true, data: scheduler.runs.slice().reverse() });
});

/**
 * GET /api/verification/runs/:runId
 * Get detail of a specific run (includes per-student results if it's the current run)
 */
router.get('/runs/:runId', (req, res) => {
    const detail = scheduler.getRunDetail(req.params.runId);
    if (!detail) {
        return res.status(404).json({ success: false, message: 'Run not found' });
    }
    res.json({ success: true, data: detail });
});

// ===================== STUDENT RESULTS =====================

/**
 * GET /api/verification/results
 * Get all student verification results (summary list)
 */
router.get('/results', (req, res) => {
    res.json({ success: true, data: scheduler.getAllStudentResults() });
});

/**
 * GET /api/verification/results/:applnID
 * Get full verification result for a specific student (all docs + extracted data)
 */
router.get('/results/:applnID', (req, res) => {
    const result = scheduler.getStudentResult(req.params.applnID);
    if (!result) {
        return res.status(404).json({ success: false, message: 'No verification result for this student' });
    }
    res.json({ success: true, data: result });
});

/**
 * POST /api/verification/fetch-student-docs
 * Fetch documents from Atlas API (without verifying) and store for display
 * Body: { applnID: "2500623" }
 */
router.post('/fetch-student-docs', async (req, res) => {
    try {
        const { applnID } = req.body;
        if (!applnID) {
            return res.status(400).json({ success: false, message: 'applnID is required' });
        }

        const docListResponse = await scheduler.atlasClient.getDocumentList(applnID);
        if (docListResponse.status !== 1 || !docListResponse.data?.document_status) {
            return res.status(400).json({ success: false, message: 'Failed to fetch document list' });
        }

        const rawDocs = docListResponse.data.document_status;

        // Normalize doc fields (handles alternative API field names)
        const allDocs = rawDocs.map(doc => scheduler.normalizeDocFields(doc));

        // Check if we already have verification results for this student
        const existing = scheduler.getStudentResult(applnID);

        const documents = allDocs.map(doc => {
            const isUploaded = !!(doc.file_url);

            // Merge existing AI results if available
            let aiData = {};
            if (existing) {
                const verifiedDoc = existing.documents.find(
                    d => String(d.document_type_id) === String(doc.document_type_id)
                );
                if (verifiedDoc) {
                    aiData = {
                        ai_status: verifiedDoc.ai_status,
                        confidence: verifiedDoc.confidence,
                        remark: verifiedDoc.remark,
                        issues: verifiedDoc.issues,
                        extracted_data: verifiedDoc.extracted_data
                    };
                }
            }

            return {
                document_type_id: doc.document_type_id,
                document_type_name: doc.document_type_name,
                document_label: doc.document_label,
                document_description: doc.document_description,
                is_required: doc.document_is_required === '1' || doc.document_is_required === 1,
                is_uploaded: isUploaded,
                filename: doc.filename || null,
                file_url: doc.file_url || null,
                verify_status: doc.verify_status,
                doc_upload_id: doc.doc_upload_id,
                ...aiData
            };
        });

        res.json({ success: true, data: { applnID, documents } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ===================== RESET / CLEAR =====================

/**
 * POST /api/verification/reset-student
 * Clear verification data for a single student and force re-verification
 * Body: { applnID: "2500623" }
 */
router.post('/reset-student', async (req, res) => {
    const { applnID } = req.body;
    if (!applnID) {
        return res.status(400).json({ success: false, message: 'applnID is required' });
    }
    try {
        const AtlasVerificationModel = require('../models/AtlasVerificationModel');
        await AtlasVerificationModel.deleteStudentResult(String(applnID));
        scheduler.studentResults.delete(String(applnID));
        res.json({ success: true, message: `Reset student ${applnID}. Will be re-verified in next auto-watch cycle.` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/verification/reset-all
 * Clear ALL verification data and force re-verification of all students
 */
router.post('/reset-all', async (req, res) => {
    try {
        const AtlasVerificationModel = require('../models/AtlasVerificationModel');
        await AtlasVerificationModel.deleteAllResults();
        scheduler.studentResults.clear();
        res.json({ success: true, message: 'All student data cleared. Auto-watch will re-verify all students in next cycle.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
