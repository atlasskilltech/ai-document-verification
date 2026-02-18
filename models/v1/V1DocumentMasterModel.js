const pool = require('../../config/database');

class V1DocumentMasterModel {
    static _parseJsonFields(row) {
        if (!row) return null;
        row.allowed_formats = typeof row.allowed_formats === 'string' ? JSON.parse(row.allowed_formats) : row.allowed_formats;
        row.required_fields = typeof row.required_fields === 'string' ? JSON.parse(row.required_fields) : row.required_fields;
        row.validation_rules = typeof row.validation_rules === 'string' ? JSON.parse(row.validation_rules) : row.validation_rules;
        return row;
    }

    static async create({ name, code, allowedFormats, maxSizeMb, requiredFields, validationRules, userId, createdBy }) {
        const [result] = await pool.query(
            'INSERT INTO v1_document_master (name, code, allowed_formats, max_size_mb, required_fields, validation_rules, user_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                name,
                code,
                JSON.stringify(allowedFormats || ['jpg', 'png', 'pdf']),
                maxSizeMb || 5,
                JSON.stringify(requiredFields || []),
                JSON.stringify(validationRules || {}),
                userId || null,
                createdBy || null
            ]
        );
        return result.insertId;
    }

    static async findById(id) {
        const [rows] = await pool.query('SELECT * FROM v1_document_master WHERE id = ?', [id]);
        return this._parseJsonFields(rows[0]) || null;
    }

    static async findByCode(code) {
        // Find global document type (user_id IS NULL)
        const [rows] = await pool.query('SELECT * FROM v1_document_master WHERE code = ? AND user_id IS NULL', [code]);
        return this._parseJsonFields(rows[0]) || null;
    }

    /**
     * Find document type by code for a specific user.
     * First checks user-specific types, then falls back to global types.
     */
    static async findByCodeForUser(code, userId) {
        // Check user-specific first
        const [userRows] = await pool.query(
            'SELECT * FROM v1_document_master WHERE code = ? AND user_id = ?', [code, userId]
        );
        if (userRows[0]) return this._parseJsonFields(userRows[0]);

        // Fallback to global
        const [globalRows] = await pool.query(
            'SELECT * FROM v1_document_master WHERE code = ? AND user_id IS NULL', [code]
        );
        return this._parseJsonFields(globalRows[0]) || null;
    }

    /**
     * Get all global (admin) document types
     */
    static async getAll({ active = true } = {}) {
        let query = 'SELECT * FROM v1_document_master WHERE user_id IS NULL';
        if (active) {
            query += ' AND is_active = 1';
        }
        query += ' ORDER BY name ASC';
        const [rows] = await pool.query(query);
        return rows.map(row => this._parseJsonFields(row));
    }

    /**
     * Get all document types available to a specific user:
     * - All global (admin-created) types
     * - All user's own custom types
     */
    static async getAllForUser(userId, { active = true } = {}) {
        let query = 'SELECT * FROM v1_document_master WHERE (user_id IS NULL OR user_id = ?)';
        const params = [userId];
        if (active) {
            query += ' AND is_active = 1';
        }
        query += ' ORDER BY user_id IS NULL DESC, name ASC';
        const [rows] = await pool.query(query, params);
        return rows.map(row => this._parseJsonFields(row));
    }

    /**
     * Get only user's own custom document types
     */
    static async getByUserId(userId, { active = true } = {}) {
        let query = 'SELECT * FROM v1_document_master WHERE user_id = ?';
        const params = [userId];
        if (active) {
            query += ' AND is_active = 1';
        }
        query += ' ORDER BY name ASC';
        const [rows] = await pool.query(query, params);
        return rows.map(row => this._parseJsonFields(row));
    }

    static async update(id, { name, code, allowedFormats, maxSizeMb, requiredFields, validationRules, isActive }) {
        const fields = [];
        const values = [];
        if (name !== undefined) { fields.push('name = ?'); values.push(name); }
        if (code !== undefined) { fields.push('code = ?'); values.push(code); }
        if (allowedFormats !== undefined) { fields.push('allowed_formats = ?'); values.push(JSON.stringify(allowedFormats)); }
        if (maxSizeMb !== undefined) { fields.push('max_size_mb = ?'); values.push(maxSizeMb); }
        if (requiredFields !== undefined) { fields.push('required_fields = ?'); values.push(JSON.stringify(requiredFields)); }
        if (validationRules !== undefined) { fields.push('validation_rules = ?'); values.push(JSON.stringify(validationRules)); }
        if (isActive !== undefined) { fields.push('is_active = ?'); values.push(isActive ? 1 : 0); }
        if (fields.length === 0) return false;
        values.push(id);
        const [result] = await pool.query(`UPDATE v1_document_master SET ${fields.join(', ')} WHERE id = ?`, values);
        return result.affectedRows > 0;
    }

    /**
     * Update only if the user owns the document type
     */
    static async updateByUser(id, userId, updates) {
        const doc = await this.findById(id);
        if (!doc || doc.user_id !== userId) return false;
        return this.update(id, updates);
    }

    static async delete(id) {
        const [result] = await pool.query('DELETE FROM v1_document_master WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }

    /**
     * Delete only if the user owns the document type
     */
    static async deleteByUser(id, userId) {
        const [result] = await pool.query('DELETE FROM v1_document_master WHERE id = ? AND user_id = ?', [id, userId]);
        return result.affectedRows > 0;
    }
}

module.exports = V1DocumentMasterModel;
