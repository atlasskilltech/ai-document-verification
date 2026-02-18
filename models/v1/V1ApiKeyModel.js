const pool = require('../../config/database');
const crypto = require('crypto');

class V1ApiKeyModel {
    static generateApiKey() {
        return 'vk_' + crypto.randomBytes(32).toString('hex');
    }

    static async create({ userId, name = 'Default', rateLimit = 1000, burstLimit = 50, expiresAt = null }) {
        const apiKey = this.generateApiKey();
        const [result] = await pool.query(
            'INSERT INTO v1_api_keys (user_id, api_key, name, rate_limit, burst_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, apiKey, name, rateLimit, burstLimit, expiresAt]
        );
        return { id: result.insertId, api_key: apiKey };
    }

    static async findByKey(apiKey) {
        const [rows] = await pool.query(
            `SELECT k.*, u.name as user_name, u.email as user_email, u.role as user_role, u.is_active as user_active
             FROM v1_api_keys k
             JOIN v1_users u ON k.user_id = u.id
             WHERE k.api_key = ? AND k.status = 'active'`,
            [apiKey]
        );
        return rows[0] || null;
    }

    static async getByUserId(userId) {
        const [rows] = await pool.query(
            'SELECT id, api_key, name, rate_limit, burst_limit, status, last_used_at, expires_at, created_at FROM v1_api_keys WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        return rows;
    }

    static async revoke(id, userId) {
        const [result] = await pool.query(
            'UPDATE v1_api_keys SET status = ? WHERE id = ? AND user_id = ?',
            ['revoked', id, userId]
        );
        return result.affectedRows > 0;
    }

    static async updateLastUsed(id) {
        await pool.query('UPDATE v1_api_keys SET last_used_at = NOW() WHERE id = ?', [id]);
    }

    static async checkRateLimit(apiKeyId, rateLimit, burstLimit) {
        const conn = await pool.getConnection();
        try {
            // Check hourly rate limit
            const hourStart = new Date();
            hourStart.setMinutes(0, 0, 0);
            const [hourRows] = await conn.query(
                'SELECT COALESCE(SUM(request_count), 0) as count FROM v1_rate_limit_log WHERE api_key_id = ? AND window_start >= ?',
                [apiKeyId, hourStart]
            );
            const hourlyCount = hourRows[0].count;

            // Check per-minute burst limit
            const minuteStart = new Date();
            minuteStart.setSeconds(0, 0);
            const [minRows] = await conn.query(
                'SELECT COALESCE(SUM(request_count), 0) as count FROM v1_rate_limit_log WHERE api_key_id = ? AND window_start >= ?',
                [apiKeyId, minuteStart]
            );
            const minuteCount = minRows[0].count;

            if (hourlyCount >= rateLimit) {
                return { allowed: false, reason: 'Hourly rate limit exceeded', limit: rateLimit, remaining: 0, reset: 'top of next hour' };
            }
            if (minuteCount >= burstLimit) {
                return { allowed: false, reason: 'Burst rate limit exceeded', limit: burstLimit, remaining: 0, reset: 'next minute' };
            }

            // Log this request
            const windowStart = new Date();
            windowStart.setSeconds(0, 0);
            await conn.query(
                'INSERT INTO v1_rate_limit_log (api_key_id, window_start, request_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE request_count = request_count + 1',
                [apiKeyId, windowStart]
            );

            return { allowed: true, hourly_remaining: rateLimit - hourlyCount - 1, burst_remaining: burstLimit - minuteCount - 1 };
        } finally {
            conn.release();
        }
    }
}

module.exports = V1ApiKeyModel;
