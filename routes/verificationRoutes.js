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
    res.json({ success: true, message: 'Scheduler started', data: scheduler.getStatus() });
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
 */
router.get('/students', async (req, res) => {
    try {
        const result = await scheduler.atlasClient.getStudentList();
        res.json({ success: true, data: result });
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

module.exports = router;
