const db = require('../config/database');

class DocumentModel {

    // Get document checklist for a program
    static async getChecklist(programId) {
        const sql = `SELECT pdc.*, dt.name as document_name, dt.category, 
                     dt.allowed_formats, dt.max_file_size_mb, dt.has_expiry
                     FROM program_document_checklist pdc
                     JOIN document_types dt ON pdc.document_type_id = dt.id
                     WHERE pdc.program_id = ?
                     ORDER BY dt.category, pdc.requirement_type`;
        const [rows] = await db.execute(sql, [programId]);
        return rows;
    }

    // Get all document types
    static async getAllTypes() {
        const sql = `SELECT * FROM document_types ORDER BY category, name`;
        const [rows] = await db.execute(sql);
        return rows;
    }

    // Upload document record
    static async uploadDocument(data) {
        // Mark old versions as not latest
        await db.execute(
            `UPDATE applicant_documents SET is_latest = 0 
             WHERE applicant_id = ? AND document_type_id = ?`,
            [data.applicant_id, data.document_type_id]
        );

        // Get next version
        const [verRows] = await db.execute(
            `SELECT COALESCE(MAX(upload_version), 0) + 1 as next_ver 
             FROM applicant_documents WHERE applicant_id = ? AND document_type_id = ?`,
            [data.applicant_id, data.document_type_id]
        );
        const nextVersion = verRows[0].next_ver;

        const sql = `INSERT INTO applicant_documents 
            (applicant_id, document_type_id, file_name, file_path, file_size, file_format, upload_version, is_latest)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`;
        const [result] = await db.execute(sql, [
            data.applicant_id, data.document_type_id, data.file_name,
            data.file_path, data.file_size, data.file_format, nextVersion
        ]);
        return { id: result.insertId, version: nextVersion };
    }

    // Get applicant's documents
    static async getApplicantDocuments(applicantId) {
        const sql = `SELECT ad.*, dt.name as document_name, dt.category,
                     dt.allowed_formats, dt.max_file_size_mb, dt.has_expiry
                     FROM applicant_documents ad
                     JOIN document_types dt ON ad.document_type_id = dt.id
                     WHERE ad.applicant_id = ? AND ad.is_latest = 1
                     ORDER BY dt.category, dt.name`;
        const [rows] = await db.execute(sql, [applicantId]);
        return rows;
    }

    // Get upload history for a document
    static async getUploadHistory(applicantId, documentTypeId) {
        const sql = `SELECT ad.*, dt.name as document_name
                     FROM applicant_documents ad
                     JOIN document_types dt ON ad.document_type_id = dt.id
                     WHERE ad.applicant_id = ? AND ad.document_type_id = ?
                     ORDER BY ad.upload_version DESC`;
        const [rows] = await db.execute(sql, [applicantId, documentTypeId]);
        return rows;
    }

    // Get document by ID
    static async getDocumentById(docId) {
        const sql = `SELECT ad.*, dt.name as document_name, dt.category,
                     dt.allowed_formats, dt.max_file_size_mb, dt.has_expiry
                     FROM applicant_documents ad
                     JOIN document_types dt ON ad.document_type_id = dt.id
                     WHERE ad.id = ?`;
        const [rows] = await db.execute(sql, [docId]);
        return rows[0] || null;
    }

    // Get a single document type by ID
    static async getTypeById(id) {
        const [rows] = await db.execute('SELECT * FROM document_types WHERE id = ?', [id]);
        return rows[0] || null;
    }

    // Create a document type
    static async createType(data) {
        const sql = `INSERT INTO document_types (name, category, allowed_formats, max_file_size_mb, has_expiry, description)
                     VALUES (?, ?, ?, ?, ?, ?)`;
        const [result] = await db.execute(sql, [
            data.name,
            data.category || 'Other',
            data.allowed_formats || 'pdf,jpg,jpeg,png',
            data.max_file_size_mb || 5,
            data.has_expiry || 0,
            data.description || null
        ]);
        return { id: result.insertId };
    }

    // Update a document type
    static async updateType(id, data) {
        const fields = [];
        const values = [];
        const allowed = ['name', 'category', 'allowed_formats', 'max_file_size_mb', 'has_expiry', 'description'];

        for (const key of allowed) {
            if (data[key] !== undefined) {
                fields.push(`${key} = ?`);
                values.push(data[key]);
            }
        }

        if (fields.length === 0) return false;

        values.push(id);
        const sql = `UPDATE document_types SET ${fields.join(', ')} WHERE id = ?`;
        const [result] = await db.execute(sql, values);
        return result.affectedRows > 0;
    }

    // Delete a document type
    static async deleteType(id) {
        const [result] = await db.execute('DELETE FROM document_types WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }

    // Get checklist items for a program (with document type details)
    static async getChecklistWithDetails(programId) {
        const sql = `SELECT pdc.*, dt.name as document_name, dt.category, dt.description,
                     dt.allowed_formats, dt.max_file_size_mb, dt.has_expiry
                     FROM program_document_checklist pdc
                     JOIN document_types dt ON pdc.document_type_id = dt.id
                     WHERE pdc.program_id = ?
                     ORDER BY dt.category, pdc.requirement_type`;
        const [rows] = await db.execute(sql, [programId]);
        return rows;
    }

    // Add a document type to a program checklist
    static async addToChecklist(data) {
        const sql = `INSERT INTO program_document_checklist (program_id, document_type_id, requirement_type, condition_rule, sensitivity_if_missing)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE requirement_type = VALUES(requirement_type),
                     condition_rule = VALUES(condition_rule), sensitivity_if_missing = VALUES(sensitivity_if_missing)`;
        const [result] = await db.execute(sql, [
            data.program_id,
            data.document_type_id,
            data.requirement_type || 'Mandatory',
            data.condition_rule ? JSON.stringify(data.condition_rule) : null,
            data.sensitivity_if_missing || 5
        ]);
        return { id: result.insertId };
    }

    // Remove a document type from a program checklist
    static async removeFromChecklist(programId, documentTypeId) {
        const [result] = await db.execute(
            'DELETE FROM program_document_checklist WHERE program_id = ? AND document_type_id = ?',
            [programId, documentTypeId]
        );
        return result.affectedRows > 0;
    }
}

module.exports = DocumentModel;
