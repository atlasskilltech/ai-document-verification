const pool = require('../../config/database');

class V1AuditModel {
    static async log({ userId, action, resourceType, resourceId, details, ipAddress }) {
        await pool.query(
            'INSERT INTO v1_audit_log (user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, action, resourceType, resourceId, JSON.stringify(details || {}), ipAddress]
        );
    }

    static async getByUserId(userId, { page = 1, limit = 50 } = {}) {
        const offset = (page - 1) * limit;
        const [rows] = await pool.query(
            'SELECT * FROM v1_audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [userId, limit, offset]
        );
        return rows;
    }

    static async getAll({ page = 1, limit = 50, userId, action } = {}) {
        let query = 'SELECT a.*, u.name as user_name, u.email as user_email FROM v1_audit_log a LEFT JOIN v1_users u ON a.user_id = u.id WHERE 1=1';
        const params = [];
        if (userId) { query += ' AND a.user_id = ?'; params.push(userId); }
        if (action) { query += ' AND a.action = ?'; params.push(action); }
        query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, (page - 1) * limit);
        const [rows] = await pool.query(query, params);
        return rows;
    }
}

module.exports = V1AuditModel;
