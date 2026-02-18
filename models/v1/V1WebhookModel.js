const pool = require('../../config/database');
const crypto = require('crypto');

class V1WebhookModel {
    static generateSecret() {
        return 'whsec_' + crypto.randomBytes(24).toString('hex');
    }

    static async create({ userId, url, events }) {
        const secret = this.generateSecret();
        const [result] = await pool.query(
            'INSERT INTO v1_webhooks (user_id, url, secret, events) VALUES (?, ?, ?, ?)',
            [userId, url, secret, JSON.stringify(events || ['document.verified', 'document.rejected', 'document.failed'])]
        );
        return { id: result.insertId, secret };
    }

    static async findById(id) {
        const [rows] = await pool.query('SELECT * FROM v1_webhooks WHERE id = ?', [id]);
        if (rows[0]) {
            rows[0].events = typeof rows[0].events === 'string' ? JSON.parse(rows[0].events) : rows[0].events;
        }
        return rows[0] || null;
    }

    static async getByUserId(userId) {
        const [rows] = await pool.query(
            'SELECT id, url, events, is_active, failure_count, last_triggered_at, created_at FROM v1_webhooks WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return rows.map(row => {
            row.events = typeof row.events === 'string' ? JSON.parse(row.events) : row.events;
            return row;
        });
    }

    static async getActiveForEvent(userId, event) {
        const [rows] = await pool.query(
            "SELECT * FROM v1_webhooks WHERE user_id = ? AND is_active = 1 AND failure_count < 10",
            [userId]
        );
        return rows.filter(row => {
            const events = typeof row.events === 'string' ? JSON.parse(row.events) : row.events;
            return events.includes(event);
        });
    }

    static async update(id, userId, { url, events, isActive }) {
        const fields = [];
        const values = [];
        if (url !== undefined) { fields.push('url = ?'); values.push(url); }
        if (events !== undefined) { fields.push('events = ?'); values.push(JSON.stringify(events)); }
        if (isActive !== undefined) { fields.push('is_active = ?'); values.push(isActive ? 1 : 0); }
        if (fields.length === 0) return false;
        values.push(id, userId);
        const [result] = await pool.query(`UPDATE v1_webhooks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, values);
        return result.affectedRows > 0;
    }

    static async delete(id, userId) {
        const [result] = await pool.query('DELETE FROM v1_webhooks WHERE id = ? AND user_id = ?', [id, userId]);
        return result.affectedRows > 0;
    }

    static async recordDelivery(webhookId, verificationRequestId, event, payload, responseStatus, responseBody, status) {
        await pool.query(
            'INSERT INTO v1_webhook_deliveries (webhook_id, verification_request_id, event, payload, response_status, response_body, status, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
            [webhookId, verificationRequestId, event, JSON.stringify(payload), responseStatus, responseBody, status]
        );
    }

    static async incrementFailureCount(id) {
        await pool.query('UPDATE v1_webhooks SET failure_count = failure_count + 1 WHERE id = ?', [id]);
    }

    static async resetFailureCount(id) {
        await pool.query('UPDATE v1_webhooks SET failure_count = 0, last_triggered_at = NOW() WHERE id = ?', [id]);
    }
}

module.exports = V1WebhookModel;
