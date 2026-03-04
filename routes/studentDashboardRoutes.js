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
 * Get student list from Atlas API + merge with verification results from DB
 */
router.get('/students', async (req, res) => {
    try {
        // Fetch live student list from Atlas API
        const atlasRes = await scheduler.atlasClient.getStudentList();
        let students = [];
        if (atlasRes && atlasRes.data) {
            students = Array.isArray(atlasRes.data)
                ? atlasRes.data
                : (atlasRes.data.data ? (Array.isArray(atlasRes.data.data) ? atlasRes.data.data : [atlasRes.data.data]) : [atlasRes.data]);
        }

        // Get all verification results from DB
        const results = await AtlasVerificationModel.getAllResults();
        const resultsMap = {};
        results.forEach(r => { resultsMap[r.applnID] = r; });

        // Merge
        const merged = students.map(s => {
            const id = s.applnID || s.id || s.application_id;
            const name = [s.first_name, s.last_name].filter(Boolean).join(' ') || s.name || s.studentName || '-';
            const result = resultsMap[id] || null;

            return {
                applnID: id,
                studentName: name,
                email: s.email || null,
                phone: s.phone || null,
                program: s.program_name || s.program || null,
                // Verification data from DB
                verification: result
            };
        });

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

module.exports = router;
