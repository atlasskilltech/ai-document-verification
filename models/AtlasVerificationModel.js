const pool = require('../config/database');

class AtlasVerificationModel {

    /**
     * Initialize tables if they don't exist
     */
    static async initTables() {
        const conn = await pool.getConnection();
        try {
            await conn.query(`
                CREATE TABLE IF NOT EXISTS atlas_verification_results (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    appln_id VARCHAR(100) NOT NULL,
                    student_name VARCHAR(255) DEFAULT NULL,
                    status ENUM('processing','completed','partial','error','skipped') DEFAULT 'processing',
                    total_docs INT DEFAULT 0,
                    uploaded INT DEFAULT 0,
                    approved INT DEFAULT 0,
                    rejected INT DEFAULT 0,
                    errors INT DEFAULT 0,
                    skipped INT DEFAULT 0,
                    all_documents JSON DEFAULT NULL,
                    verified_documents JSON DEFAULT NULL,
                    start_time DATETIME DEFAULT NULL,
                    end_time DATETIME DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY idx_appln_id (appln_id),
                    INDEX idx_status (status),
                    INDEX idx_updated (updated_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            await conn.query(`
                CREATE TABLE IF NOT EXISTS atlas_verification_runs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    run_id VARCHAR(50) NOT NULL,
                    status ENUM('running','completed','stopped','error') DEFAULT 'running',
                    total_students INT DEFAULT 0,
                    processed INT DEFAULT 0,
                    completed INT DEFAULT 0,
                    skipped_count INT DEFAULT 0,
                    errors INT DEFAULT 0,
                    total_docs_verified INT DEFAULT 0,
                    total_approved INT DEFAULT 0,
                    total_rejected INT DEFAULT 0,
                    start_time DATETIME DEFAULT NULL,
                    end_time DATETIME DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY idx_run_id (run_id),
                    INDEX idx_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);

            console.log('[AtlasVerification] Database tables initialized');
        } catch (err) {
            console.error('[AtlasVerification] Table init error:', err.message);
        } finally {
            conn.release();
        }
    }

    // ==================== STUDENT RESULTS ====================

    /**
     * Save or update a student's verification result
     */
    static async upsertStudentResult(result) {
        const conn = await pool.getConnection();
        try {
            await conn.query(`
                INSERT INTO atlas_verification_results
                    (appln_id, student_name, status, total_docs, uploaded, approved, rejected, errors, skipped, all_documents, verified_documents, start_time, end_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    student_name = VALUES(student_name),
                    status = VALUES(status),
                    total_docs = VALUES(total_docs),
                    uploaded = VALUES(uploaded),
                    approved = VALUES(approved),
                    rejected = VALUES(rejected),
                    errors = VALUES(errors),
                    skipped = VALUES(skipped),
                    all_documents = VALUES(all_documents),
                    verified_documents = VALUES(verified_documents),
                    start_time = VALUES(start_time),
                    end_time = VALUES(end_time)
            `, [
                result.applnID,
                result.studentName || null,
                result.status,
                result.totalDocs || (result.allDocuments ? result.allDocuments.length : 0),
                result.uploaded || 0,
                result.approved || 0,
                result.rejected || 0,
                result.errors || 0,
                result.skipped || 0,
                JSON.stringify(result.allDocuments || []),
                JSON.stringify(result.documents || []),
                result.startTime || null,
                result.endTime || null
            ]);
        } finally {
            conn.release();
        }
    }

    /**
     * Get all student results (summary for listing)
     */
    static async getAllResults() {
        const [rows] = await pool.query(`
            SELECT appln_id, student_name, status, total_docs, uploaded, approved, rejected, errors, skipped, end_time as verified_at, updated_at, all_documents
            FROM atlas_verification_results
            ORDER BY updated_at DESC
        `);
        return rows.map(r => {
            let allDocs = [];
            try { allDocs = JSON.parse(r.all_documents) || []; } catch (e) {}
            const requiredDocs = allDocs.filter(d => d.is_required);
            const docsWithConf = allDocs.filter(d => d.confidence && d.confidence > 0);
            const avgConfidence = docsWithConf.length > 0
                ? Math.round((docsWithConf.reduce((sum, d) => sum + d.confidence, 0) / docsWithConf.length) * 100)
                : 0;

            return {
                applnID: String(r.appln_id),
                studentName: r.student_name,
                status: r.status,
                totalDocs: r.total_docs || 0,
                uploaded: r.uploaded || 0,
                approved: r.approved || 0,
                rejected: r.rejected || 0,
                errors: r.errors || 0,
                skipped: r.skipped || 0,
                avgConfidence,
                requiredTotal: requiredDocs.length,
                requiredUploaded: requiredDocs.filter(d => d.is_uploaded).length,
                requiredVerified: requiredDocs.filter(d => d.ai_status === 'Verified').length,
                requiredRejected: requiredDocs.filter(d => d.ai_status === 'reject').length,
                verifiedAt: r.verified_at
            };
        });
    }

    /**
     * Get full result for a specific student (includes all documents + extracted data)
     */
    static async getStudentResult(applnID) {
        const [rows] = await pool.query(
            'SELECT * FROM atlas_verification_results WHERE appln_id = ?',
            [applnID]
        );
        if (rows.length === 0) return null;

        const r = rows[0];
        let allDocuments = [];
        let documents = [];

        try { allDocuments = JSON.parse(r.all_documents) || []; } catch (e) {}
        try { documents = JSON.parse(r.verified_documents) || []; } catch (e) {}

        return {
            applnID: r.appln_id,
            studentName: r.student_name,
            status: r.status,
            startTime: r.start_time,
            endTime: r.end_time,
            totalDocs: r.total_docs,
            uploaded: r.uploaded,
            approved: r.approved,
            rejected: r.rejected,
            errors: r.errors,
            skipped: r.skipped,
            allDocuments,
            documents
        };
    }

    /**
     * Get dashboard stats summary
     */
    static async getDashboardStats() {
        const [rows] = await pool.query(`
            SELECT
                COUNT(*) as total_students,
                SUM(CASE WHEN status = 'completed' AND rejected = 0 THEN 1 ELSE 0 END) as fully_verified,
                SUM(CASE WHEN status IN ('completed') AND rejected > 0 THEN 1 ELSE 0 END) as has_issues,
                SUM(CASE WHEN status IN ('error','partial') THEN 1 ELSE 0 END) as has_errors,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
                SUM(total_docs) as total_docs,
                SUM(uploaded) as total_uploaded,
                SUM(approved) as total_approved,
                SUM(rejected) as total_rejected,
                SUM(errors) as total_errors
            FROM atlas_verification_results
        `);
        return rows[0];
    }

    /**
     * Load all results into a Map (for in-memory cache in scheduler)
     */
    static async loadAllIntoMap() {
        const [rows] = await pool.query(
            'SELECT * FROM atlas_verification_results'
        );
        const map = new Map();
        for (const r of rows) {
            let allDocuments = [];
            let documents = [];
            try { allDocuments = JSON.parse(r.all_documents) || []; } catch (e) {}
            try { documents = JSON.parse(r.verified_documents) || []; } catch (e) {}

            map.set(r.appln_id, {
                applnID: r.appln_id,
                studentName: r.student_name,
                status: r.status,
                startTime: r.start_time,
                endTime: r.end_time,
                totalDocs: r.total_docs,
                uploaded: r.uploaded,
                approved: r.approved,
                rejected: r.rejected,
                errors: r.errors,
                skipped: r.skipped,
                allDocuments,
                documents
            });
        }
        return map;
    }

    // ==================== RUN HISTORY ====================

    /**
     * Save a verification run
     */
    static async saveRun(run) {
        const conn = await pool.getConnection();
        try {
            await conn.query(`
                INSERT INTO atlas_verification_runs
                    (run_id, status, total_students, processed, completed, skipped_count, errors, total_docs_verified, total_approved, total_rejected, start_time, end_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    status = VALUES(status),
                    total_students = VALUES(total_students),
                    processed = VALUES(processed),
                    completed = VALUES(completed),
                    skipped_count = VALUES(skipped_count),
                    errors = VALUES(errors),
                    total_docs_verified = VALUES(total_docs_verified),
                    total_approved = VALUES(total_approved),
                    total_rejected = VALUES(total_rejected),
                    end_time = VALUES(end_time)
            `, [
                run.id,
                run.status,
                run.totalStudents || 0,
                run.processed || 0,
                run.completed || 0,
                run.skipped || 0,
                run.errors || 0,
                run.totalDocsVerified || 0,
                run.totalApproved || 0,
                run.totalRejected || 0,
                run.startTime || null,
                run.endTime || null
            ]);
        } finally {
            conn.release();
        }
    }

    /**
     * Get recent runs
     */
    static async getRecentRuns(limit = 50) {
        const [rows] = await pool.query(
            'SELECT * FROM atlas_verification_runs ORDER BY created_at DESC LIMIT ?',
            [limit]
        );
        return rows.map(r => ({
            id: r.run_id,
            status: r.status,
            totalStudents: r.total_students,
            processed: r.processed,
            completed: r.completed,
            skipped: r.skipped_count,
            errors: r.errors,
            totalDocsVerified: r.total_docs_verified,
            totalApproved: r.total_approved,
            totalRejected: r.total_rejected,
            startTime: r.start_time,
            endTime: r.end_time
        }));
    }
}

module.exports = AtlasVerificationModel;
