const pool = require('../../config/database');
const crypto = require('crypto');

class V1BulkJobModel {
    static generateBulkId() {
        return 'BULK' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
    }

    static _parseJson(row) {
        if (!row) return null;
        if (typeof row.metadata === 'string') row.metadata = JSON.parse(row.metadata);
        return row;
    }

    static async create({ userId, totalDocuments, callbackUrl, metadata }) {
        const bulkId = this.generateBulkId();
        const [result] = await pool.query(
            `INSERT INTO v1_bulk_jobs (bulk_id, user_id, total_documents, callback_url, metadata, status)
             VALUES (?, ?, ?, ?, ?, 'queued')`,
            [bulkId, userId, totalDocuments, callbackUrl || null, JSON.stringify(metadata || {})]
        );
        return { id: result.insertId, bulk_id: bulkId };
    }

    static async addItem(bulkJobId, verificationRequestId, itemIndex) {
        await pool.query(
            'INSERT INTO v1_bulk_job_items (bulk_job_id, verification_request_id, item_index) VALUES (?, ?, ?)',
            [bulkJobId, verificationRequestId, itemIndex]
        );
    }

    static async findByBulkId(bulkId) {
        const [rows] = await pool.query('SELECT * FROM v1_bulk_jobs WHERE bulk_id = ?', [bulkId]);
        return this._parseJson(rows[0]) || null;
    }

    static async findById(id) {
        const [rows] = await pool.query('SELECT * FROM v1_bulk_jobs WHERE id = ?', [id]);
        return this._parseJson(rows[0]) || null;
    }

    static async getByUserId(userId, { page = 1, limit = 20 } = {}) {
        const [rows] = await pool.query(
            'SELECT * FROM v1_bulk_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [userId, limit, (page - 1) * limit]
        );
        const [[{ total }]] = await pool.query(
            'SELECT COUNT(*) as total FROM v1_bulk_jobs WHERE user_id = ?', [userId]
        );
        return { jobs: rows.map(r => this._parseJson(r)), total, page, limit };
    }

    static async getItems(bulkJobId) {
        const [rows] = await pool.query(
            `SELECT bji.item_index, vr.system_reference_id, vr.document_type, vr.status,
                    vr.confidence, vr.risk_score, vr.created_at, vr.processed_at
             FROM v1_bulk_job_items bji
             JOIN v1_verification_requests vr ON bji.verification_request_id = vr.id
             WHERE bji.bulk_job_id = ?
             ORDER BY bji.item_index ASC`,
            [bulkJobId]
        );
        return rows;
    }

    static async updateProgress(bulkJobId) {
        // Count statuses from linked verification requests
        const [rows] = await pool.query(
            `SELECT vr.status, COUNT(*) as cnt
             FROM v1_bulk_job_items bji
             JOIN v1_verification_requests vr ON bji.verification_request_id = vr.id
             WHERE bji.bulk_job_id = ?
             GROUP BY vr.status`,
            [bulkJobId]
        );

        const counts = { verified: 0, rejected: 0, failed: 0 };
        let completed = 0;
        for (const r of rows) {
            if (r.status === 'verified') { counts.verified = r.cnt; completed += r.cnt; }
            else if (r.status === 'rejected') { counts.rejected = r.cnt; completed += r.cnt; }
            else if (r.status === 'failed') { counts.failed = r.cnt; completed += r.cnt; }
        }

        const job = await this.findById(bulkJobId);
        if (!job) return null;

        let status = 'processing';
        let completedAt = null;
        if (completed >= job.total_documents) {
            status = counts.failed > 0 && counts.failed < job.total_documents ? 'partial' :
                     counts.failed >= job.total_documents ? 'failed' : 'completed';
            completedAt = new Date();
        }

        await pool.query(
            `UPDATE v1_bulk_jobs SET completed = ?, verified = ?, rejected = ?, failed = ?,
             status = ?, completed_at = ? WHERE id = ?`,
            [completed, counts.verified, counts.rejected, counts.failed, status, completedAt, bulkJobId]
        );

        return { ...job, completed, ...counts, status, completed_at: completedAt };
    }

    static async setProcessing(bulkJobId) {
        await pool.query("UPDATE v1_bulk_jobs SET status = 'processing' WHERE id = ?", [bulkJobId]);
    }
}

module.exports = V1BulkJobModel;
