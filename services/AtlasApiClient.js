const axios = require('axios');

class AtlasApiClient {

    constructor() {
        this.baseURL = process.env.ATLAS_API_BASE_URL || 'https://www.atlasskilltech.app/admissions/api';
        this.token = process.env.ATLAS_API_TOKEN;

        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 30000,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Fetch the list of students
     */
    async getStudentList() {
        const response = await this.client.get('/getStudentList');
        return response.data;
    }

    /**
     * Fetch the document list for a specific student
     * @param {string} applnID - The application ID
     */
    async getDocumentList(applnID) {
        const response = await this.client.post('/documentList', { applnID });
        return response.data;
    }

    /**
     * Update document verification status for a student
     * @param {string} applnID - The application ID
     * @param {Array} documentStatus - Array of { document_type_id, doc_ai_status, doc_ai_remark, doc_ai_confidence, doc_ai_extracted_data, doc_ai_issues }
     */
    async updateDocumentStatus(applnID, documentStatus) {
        const response = await this.client.post('/documentStatusUpdate', {
            applnID,
            document_status: documentStatus
        });
        console.log(`[AtlasApiClient] Push response for ${applnID}:`, JSON.stringify(response.data).substring(0, 300));
        return response.data;
    }

    /**
     * Health check - verify Atlas API connectivity and token validity
     * @returns {{ connected: boolean, studentListAccessible: boolean, baseURL: string, error?: string }}
     */
    async healthCheck() {
        const result = {
            connected: false,
            studentListAccessible: false,
            baseURL: this.baseURL,
            tokenConfigured: !!this.token
        };

        try {
            const response = await this.client.get('/getStudentList');
            result.connected = true;
            result.studentListAccessible = !!(response.data && (response.data.status === 1 || response.data.data));
            result.studentCount = Array.isArray(response.data?.data) ? response.data.data.length : 0;
        } catch (err) {
            result.connected = false;
            result.error = err.response ? `HTTP ${err.response.status}: ${err.response.statusText}` : err.message;
        }

        return result;
    }

    /**
     * Download a document file from its URL
     * @param {string} fileUrl - The S3 URL of the document
     * @returns {{ buffer: Buffer, contentType: string }}
     */
    async downloadDocument(fileUrl) {
        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 60000
        });
        return {
            buffer: Buffer.from(response.data),
            contentType: response.headers['content-type'] || 'application/octet-stream'
        };
    }
}

module.exports = AtlasApiClient;
