const pool = require('../../config/database');
const bcrypt = require('bcryptjs');

class V1UserModel {
    static async create({ name, email, password, role = 'user' }) {
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            'INSERT INTO v1_users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, role]
        );
        return result.insertId;
    }

    static async findByEmail(email) {
        const [rows] = await pool.query('SELECT * FROM v1_users WHERE email = ?', [email]);
        return rows[0] || null;
    }

    static async findById(id) {
        const [rows] = await pool.query(
            'SELECT id, name, email, role, is_active, created_at, updated_at FROM v1_users WHERE id = ?',
            [id]
        );
        return rows[0] || null;
    }

    static async validatePassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }

    static async updateProfile(id, { name, email }) {
        const fields = [];
        const values = [];
        if (name) { fields.push('name = ?'); values.push(name); }
        if (email) { fields.push('email = ?'); values.push(email); }
        if (fields.length === 0) return false;
        values.push(id);
        await pool.query(`UPDATE v1_users SET ${fields.join(', ')} WHERE id = ?`, values);
        return true;
    }

    static async changePassword(id, newPassword) {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE v1_users SET password = ? WHERE id = ?', [hashedPassword, id]);
        return true;
    }

    static async getAll({ page = 1, limit = 20 } = {}) {
        const offset = (page - 1) * limit;
        const [rows] = await pool.query(
            'SELECT id, name, email, role, is_active, created_at FROM v1_users ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
        const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM v1_users');
        return { users: rows, total, page, limit };
    }
}

module.exports = V1UserModel;
