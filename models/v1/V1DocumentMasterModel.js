const pool = require('../../config/database');

class V1DocumentMasterModel {
    static async create({ name, code, allowedFormats, maxSizeMb, requiredFields, validationRules, createdBy }) {
        const [result] = await pool.query(
            'INSERT INTO v1_document_master (name, code, allowed_formats, max_size_mb, required_fields, validation_rules, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                name,
                code,
                JSON.stringify(allowedFormats || ['jpg', 'png', 'pdf']),
                maxSizeMb || 5,
                JSON.stringify(requiredFields || []),
                JSON.stringify(validationRules || {}),
                createdBy
            ]
        );
        return result.insertId;
    }

    static async findById(id) {
        const [rows] = await pool.query('SELECT * FROM v1_document_master WHERE id = ?', [id]);
        if (rows[0]) {
            rows[0].allowed_formats = typeof rows[0].allowed_formats === 'string' ? JSON.parse(rows[0].allowed_formats) : rows[0].allowed_formats;
            rows[0].required_fields = typeof rows[0].required_fields === 'string' ? JSON.parse(rows[0].required_fields) : rows[0].required_fields;
            rows[0].validation_rules = typeof rows[0].validation_rules === 'string' ? JSON.parse(rows[0].validation_rules) : rows[0].validation_rules;
        }
        return rows[0] || null;
    }

    static async findByCode(code) {
        const [rows] = await pool.query('SELECT * FROM v1_document_master WHERE code = ?', [code]);
        if (rows[0]) {
            rows[0].allowed_formats = typeof rows[0].allowed_formats === 'string' ? JSON.parse(rows[0].allowed_formats) : rows[0].allowed_formats;
            rows[0].required_fields = typeof rows[0].required_fields === 'string' ? JSON.parse(rows[0].required_fields) : rows[0].required_fields;
            rows[0].validation_rules = typeof rows[0].validation_rules === 'string' ? JSON.parse(rows[0].validation_rules) : rows[0].validation_rules;
        }
        return rows[0] || null;
    }

    static async getAll({ active = true } = {}) {
        let query = 'SELECT * FROM v1_document_master';
        const params = [];
        if (active) {
            query += ' WHERE is_active = 1';
        }
        query += ' ORDER BY name ASC';
        const [rows] = await pool.query(query, params);
        return rows.map(row => {
            row.allowed_formats = typeof row.allowed_formats === 'string' ? JSON.parse(row.allowed_formats) : row.allowed_formats;
            row.required_fields = typeof row.required_fields === 'string' ? JSON.parse(row.required_fields) : row.required_fields;
            row.validation_rules = typeof row.validation_rules === 'string' ? JSON.parse(row.validation_rules) : row.validation_rules;
            return row;
        });
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

    static async delete(id) {
        const [result] = await pool.query('DELETE FROM v1_document_master WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
}

module.exports = V1DocumentMasterModel;
