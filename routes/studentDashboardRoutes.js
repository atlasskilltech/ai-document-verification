const express = require('express');
const router = express.Router();
const AtlasVerificationModel = require('../models/AtlasVerificationModel');
const scheduler = require('../services/VerificationScheduler');

/**
 * GET /api/student-dashboard/stats
 * Dashboard overview statistics from DB
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await AtlasVerificationModel.getDashboardStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/student-dashboard/students
 * Get student list from Atlas API + merge with verification results from DB.
 * Falls back to DB-only results if Atlas API is unreachable.
 */
router.get('/students', async (req, res) => {
    try {
        // Get all verification results from DB (always available)
        const results = await AtlasVerificationModel.getAllResults();
        const resultsMap = {};
        results.forEach(r => { resultsMap[String(r.applnID)] = r; });

        // Try fetching live student list from Atlas API
        let atlasStudents = [];
        try {
            const atlasRes = await scheduler.atlasClient.getStudentList();
            if (atlasRes && atlasRes.data) {
                const raw = atlasRes.data;
                if (Array.isArray(raw)) {
                    atlasStudents = raw;
                } else if (raw.data && Array.isArray(raw.data)) {
                    atlasStudents = raw.data;
                } else if (raw.data) {
                    atlasStudents = [raw.data];
                } else {
                    atlasStudents = [raw];
                }
            }
        } catch (atlasErr) {
            console.error('[StudentDashboard] Atlas API failed, using DB-only:', atlasErr.message);
        }

        let merged = [];
        const seenIds = new Set();

        if (atlasStudents.length > 0) {
            // Merge Atlas students with DB verification results
            merged = atlasStudents.map(s => {
                const id = String(s.applnID || s.student_app_id || s.id || s.application_id || '');
                seenIds.add(id);
                const name = [s.student_first_name, s.student_last_name].filter(Boolean).join(' ') || [s.first_name, s.last_name].filter(Boolean).join(' ') || s.name || s.studentName || '-';
                const result = resultsMap[id] || null;

                return {
                    applnID: id,
                    studentId: s.student_id || null,
                    studentName: name,
                    verification: result
                };
            });
        }

        // Add any DB-only results that weren't in the Atlas student list
        results.forEach(r => {
            if (!seenIds.has(String(r.applnID))) {
                merged.push({
                    applnID: r.applnID,
                    studentId: null,
                    studentName: r.studentName || r.applnID,
                    verification: r
                });
            }
        });

        // Return all students (including completed/verified)
        res.json({ success: true, data: { students: merged, totalResults: results.length } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/student-dashboard/results
 * Get all verification results from DB (summary)
 */
router.get('/results', async (req, res) => {
    try {
        const results = await AtlasVerificationModel.getAllResults();
        res.json({ success: true, data: results });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/student-dashboard/results/:applnID
 * Get full verification result for a student from DB (includes documents + extracted data)
 */
router.get('/results/:applnID', async (req, res) => {
    try {
        const result = await AtlasVerificationModel.getStudentResult(req.params.applnID);
        if (!result) {
            return res.status(404).json({ success: false, message: 'No verification result for this student' });
        }
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/student-dashboard/fetch-docs
 * Fetch documents from Atlas API for a student and merge with DB verification data
 */
router.post('/fetch-docs', async (req, res) => {
    try {
        const { applnID } = req.body;
        if (!applnID) {
            return res.status(400).json({ success: false, message: 'applnID is required' });
        }

        const docListResponse = await scheduler.atlasClient.getDocumentList(applnID);
        if (docListResponse.status !== 1 || !docListResponse.data?.document_status) {
            return res.status(400).json({ success: false, message: 'Failed to fetch document list from Atlas' });
        }

        const allDocs = docListResponse.data.document_status;

        // Check for existing verification results in DB
        const existing = await AtlasVerificationModel.getStudentResult(applnID);

        const documents = allDocs.map(doc => {
            const isUploaded = !!(doc.file_url && doc.file_url.trim());

            // Merge existing AI results from DB
            let aiData = {};
            if (existing && existing.documents) {
                const verifiedDoc = existing.documents.find(
                    d => d.document_type_id === doc.document_type_id
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
                is_required: doc.document_is_required === '1',
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

/**
 * GET /api/student-dashboard/runs
 * Get recent verification runs from DB
 */
router.get('/runs', async (req, res) => {
    try {
        const runs = await AtlasVerificationModel.getRecentRuns(20);
        res.json({ success: true, data: runs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/student-dashboard/engine-status
 * Get AI engine status (from in-memory scheduler)
 */
router.get('/engine-status', (req, res) => {
    res.json({ success: true, data: scheduler.getStatus() });
});

/**
 * POST /api/student-dashboard/recheck
 * Force re-verify all documents for a student (bypasses verify_status filter)
 * Used for skipped students that need rechecking
 * Body: { applnID: "2500623" }
 */
router.post('/recheck', async (req, res) => {
    const { applnID } = req.body;
    if (!applnID) {
        return res.status(400).json({ success: false, message: 'applnID is required' });
    }

    if (scheduler.isRunning) {
        return res.status(409).json({
            success: false,
            message: 'A verification job is already running. Please wait for it to finish.',
            data: scheduler.getStatus()
        });
    }

    try {
        const result = await scheduler.verifySingleStudent(applnID, { forceRecheck: true });
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
