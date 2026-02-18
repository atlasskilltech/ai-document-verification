const pool = require('../../config/database');
const crypto = require('crypto');

class V1VerificationRequestModel {
    static generateSystemRefId() {
        return 'DOC' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
    }

    static async create({ userId, referenceId, documentType, fileUrl, metadata }) {
        const systemReferenceId = this.generateSystemRefId();
        const [result] = await pool.query(
            `INSERT INTO v1_verification_requests
             (system_reference_id, client_reference_id, user_id, document_type, file_url, metadata, status)
             VALUES (?, ?, ?, ?, ?, ?, 'accepted')`,
            [systemReferenceId, referenceId, userId, documentType, fileUrl, JSON.stringify(metadata || {})]
        );
        return { id: result.insertId, system_reference_id: systemReferenceId };
    }

    static async findBySystemRefId(systemRefId) {
        const [rows] = await pool.query(
            'SELECT * FROM v1_verification_requests WHERE system_reference_id = ?',
            [systemRefId]
        );
        if (rows[0]) {
            rows[0].metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
            rows[0].extracted_data = typeof rows[0].extracted_data === 'string' ? JSON.parse(rows[0].extracted_data) : rows[0].extracted_data;
            rows[0].ai_response = typeof rows[0].ai_response === 'string' ? JSON.parse(rows[0].ai_response) : rows[0].ai_response;
            rows[0].issues = typeof rows[0].issues === 'string' ? JSON.parse(rows[0].issues) : rows[0].issues;
        }
        return rows[0] || null;
    }

    static async findById(id) {
        const [rows] = await pool.query('SELECT * FROM v1_verification_requests WHERE id = ?', [id]);
        if (rows[0]) {
            rows[0].metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
            rows[0].extracted_data = typeof rows[0].extracted_data === 'string' ? JSON.parse(rows[0].extracted_data) : rows[0].extracted_data;
            rows[0].ai_response = typeof rows[0].ai_response === 'string' ? JSON.parse(rows[0].ai_response) : rows[0].ai_response;
            rows[0].issues = typeof rows[0].issues === 'string' ? JSON.parse(rows[0].issues) : rows[0].issues;
        }
        return rows[0] || null;
    }

    static async updateStatus(id, { status, confidence, riskScore, extractedData, aiResponse, issues }) {
        const fields = ['status = ?'];
        const values = [status];

        if (confidence !== undefined) { fields.push('confidence = ?'); values.push(confidence); }
        if (riskScore !== undefined) { fields.push('risk_score = ?'); values.push(riskScore); }
        if (extractedData !== undefined) { fields.push('extracted_data = ?'); values.push(JSON.stringify(extractedData)); }
        if (aiResponse !== undefined) { fields.push('ai_response = ?'); values.push(JSON.stringify(aiResponse)); }
        if (issues !== undefined) { fields.push('issues = ?'); values.push(JSON.stringify(issues)); }
        if (['verified', 'rejected', 'failed'].includes(status)) {
            fields.push('processed_at = NOW()');
        }

        values.push(id);
        await pool.query(`UPDATE v1_verification_requests SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    static async getByUserId(userId, { status, page = 1, limit = 20 } = {}) {
        let query = 'SELECT id, system_reference_id, client_reference_id, document_type, status, confidence, risk_score, created_at, processed_at FROM v1_verification_requests WHERE user_id = ?';
        const params = [userId];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, (page - 1) * limit);

        const [rows] = await pool.query(query, params);

        let countQuery = 'SELECT COUNT(*) as total FROM v1_verification_requests WHERE user_id = ?';
        const countParams = [userId];
        if (status) {
            countQuery += ' AND status = ?';
            countParams.push(status);
        }
        const [[{ total }]] = await pool.query(countQuery, countParams);

        return { requests: rows, total, page, limit };
    }

    static async getPending(limit = 10) {
        const [rows] = await pool.query(
            "SELECT * FROM v1_verification_requests WHERE status = 'accepted' ORDER BY created_at ASC LIMIT ?",
            [limit]
        );
        return rows;
    }

    static async getAdminStats() {
        const [statusStats] = await pool.query(
            `SELECT status, COUNT(*) as count FROM v1_verification_requests GROUP BY status`
        );
        const [[totals]] = await pool.query(
            `SELECT COUNT(*) as total,
                    AVG(CASE WHEN confidence IS NOT NULL THEN confidence END) as avg_confidence,
                    AVG(CASE WHEN risk_score IS NOT NULL THEN risk_score END) as avg_risk_score,
                    AVG(TIMESTAMPDIFF(SECOND, created_at, processed_at)) as avg_processing_seconds
             FROM v1_verification_requests`
        );
        const [recentRequests] = await pool.query(
            `SELECT vr.*, u.name as user_name, u.email as user_email
             FROM v1_verification_requests vr
             JOIN v1_users u ON vr.user_id = u.id
             ORDER BY vr.created_at DESC LIMIT 20`
        );

        return {
            status_breakdown: statusStats,
            totals: {
                total_requests: totals.total,
                avg_confidence: totals.avg_confidence ? parseFloat(totals.avg_confidence).toFixed(2) : null,
                avg_risk_score: totals.avg_risk_score ? parseFloat(totals.avg_risk_score).toFixed(4) : null,
                avg_processing_seconds: totals.avg_processing_seconds ? parseFloat(totals.avg_processing_seconds).toFixed(1) : null
            },
            recent_requests: recentRequests
        };
    }

    static async getUserStats(userId) {
        const [statusStats] = await pool.query(
            'SELECT status, COUNT(*) as count FROM v1_verification_requests WHERE user_id = ? GROUP BY status',
            [userId]
        );
        const [[totals]] = await pool.query(
            `SELECT COUNT(*) as total,
                    SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) as verified_count,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
                    SUM(CASE WHEN status IN ('accepted','processing') THEN 1 ELSE 0 END) as processing_count,
                    AVG(CASE WHEN confidence IS NOT NULL THEN confidence END) as avg_confidence
             FROM v1_verification_requests WHERE user_id = ?`,
            [userId]
        );

        return {
            status_breakdown: statusStats,
            total_requests: totals.total,
            verified_count: totals.verified_count || 0,
            rejected_count: totals.rejected_count || 0,
            processing_count: totals.processing_count || 0,
            avg_confidence: totals.avg_confidence ? parseFloat(totals.avg_confidence).toFixed(2) : null
        };
    }

    static async getAllForAdmin({ status, userId, page = 1, limit = 20 } = {}) {
        let query = `SELECT vr.*, u.name as user_name, u.email as user_email
                     FROM v1_verification_requests vr
                     JOIN v1_users u ON vr.user_id = u.id WHERE 1=1`;
        const params = [];
        if (status) { query += ' AND vr.status = ?'; params.push(status); }
        if (userId) { query += ' AND vr.user_id = ?'; params.push(userId); }
        query += ' ORDER BY vr.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, (page - 1) * limit);
        const [rows] = await pool.query(query, params);
        return rows;
    }

    static async reprocess(id) {
        await pool.query(
            "UPDATE v1_verification_requests SET status = 'accepted', confidence = NULL, risk_score = NULL, extracted_data = NULL, ai_response = NULL, issues = NULL, processed_at = NULL WHERE id = ?",
            [id]
        );
    }

    static async overrideStatus(id, { status, confidence }) {
        const fields = ['status = ?'];
        const values = [status];
        if (confidence !== undefined) { fields.push('confidence = ?'); values.push(confidence); }
        fields.push('processed_at = NOW()');
        values.push(id);
        await pool.query(`UPDATE v1_verification_requests SET ${fields.join(', ')} WHERE id = ?`, values);
    }
}

module.exports = V1VerificationRequestModel;
