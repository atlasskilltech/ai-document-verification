const OpenAI = require('openai');
const axios = require('axios');
const { validateUrl } = require('../../middleware/v1/ssrfProtection');

/**
 * AI Processing Service using OpenAI Vision API.
 * Handles document fetching, analysis, structured extraction, and scoring.
 */
class AIProcessingService {
    constructor() {
        this.openai = null;
        this.model = process.env.OPENAI_MODEL || 'gpt-4o';
        this._initClient();
    }

    _initClient() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new OpenAI({ apiKey });
        }
    }

    /**
     * Build the system prompt for document verification
     */
    getSystemPrompt() {
        return `You are an expert document verification AI. Your job is to:
1. FIRST identify what type of document is actually shown in the image
2. Compare the actual document type with the expected/claimed document type
3. If the document does NOT match the expected type, immediately flag it as a wrong document
4. If it matches, extract all relevant structured data
5. Verify the document's authenticity indicators
6. Check for signs of tampering or fraud
7. Provide a confidence score and risk assessment

CRITICAL: You must ALWAYS verify that the submitted document actually matches the expected document type. For example:
- If expected type is "aadhaar" but the image shows a PAN card, flag as wrong document
- If expected type is "passport" but the image shows a driving license, flag as wrong document
- If the image is not a document at all (random photo, blank page, etc.), flag as wrong document

You MUST respond in valid JSON format only. No markdown, no extra text.`;
    }

    /**
     * Build the extraction prompt based on document type config
     */
    /**
     * Map of document type codes to human-readable names and identifying features
     */
    getDocumentTypeDescriptions() {
        return {
            aadhaar: { name: 'Aadhaar Card', description: 'Indian unique identity card issued by UIDAI with 12-digit Aadhaar number, photo, QR code, and Government of India emblem' },
            pan: { name: 'PAN Card', description: 'Indian Permanent Account Number card issued by Income Tax Dept with 10-character alphanumeric PAN, photo, and Income Tax Dept logo' },
            passport: { name: 'Passport', description: 'International travel passport document with passport number, photo, nationality, and machine-readable zone (MRZ)' },
            driving_license: { name: 'Driving License', description: 'Driving license/permit issued by transport authority with license number, vehicle classes, and photo' },
            voter_id: { name: 'Voter ID / EPIC', description: 'Indian Election Photo ID Card (EPIC) issued by Election Commission with voter ID number and photo' },
            bank_statement: { name: 'Bank Statement', description: 'Bank account statement showing account number, account holder name, bank logo, and transaction history' },
            utility_bill: { name: 'Utility Bill', description: 'Utility bill (electricity, water, gas, phone) showing name, address, and bill amount' },
            marksheet_10: { name: '10th Class Marksheet', description: 'Class 10 / SSC / Secondary School examination marksheet with roll number, subjects, marks, and board name' },
            marksheet_12: { name: '12th Class Marksheet', description: 'Class 12 / HSC / Higher Secondary examination marksheet with roll number, subjects, marks, and board name' },
            graduation_cert: { name: 'Graduation Certificate', description: 'University degree/graduation certificate with degree name, university name, student name, and year of passing' }
        };
    }

    buildExtractionPrompt(documentType, requiredFields, validationRules, metadata) {
        const docDescriptions = this.getDocumentTypeDescriptions();
        const expectedDoc = docDescriptions[documentType];
        const expectedName = expectedDoc ? expectedDoc.name : documentType;
        const expectedDescription = expectedDoc ? expectedDoc.description : `A document of type "${documentType}"`;

        let prompt = `STEP 1 - DOCUMENT TYPE VERIFICATION (MANDATORY):
The user claims this is a "${expectedName}" (code: ${documentType}).
Expected document: ${expectedDescription}

You MUST first determine what type of document is ACTUALLY shown in this image.
- Look at the document layout, logos, headers, format, and content
- Determine the actual document type
- Compare it against the expected type "${expectedName}"
- If the actual document does NOT match the expected type, set document_type_match to false
- If the image is blurry, blank, a random photo, or not a valid document, set document_type_match to false

STEP 2 - DATA EXTRACTION (only if document type matches):
`;
        prompt += `Extract the following fields from the ${expectedName}:\n`;
        if (requiredFields && requiredFields.length > 0) {
            requiredFields.forEach(field => {
                prompt += `- ${field}\n`;
            });
        } else {
            prompt += `- Any visible text fields, names, dates, ID numbers\n`;
        }

        if (metadata && Object.keys(metadata).length > 0) {
            prompt += `\nMetadata provided by client for cross-verification:\n`;
            Object.entries(metadata).forEach(([key, value]) => {
                prompt += `- ${key}: ${value}\n`;
            });
            prompt += `\nCompare the extracted data against the metadata above and note any mismatches.\n`;
        }

        if (validationRules && Object.keys(validationRules).length > 0) {
            prompt += `\nValidation rules to check:\n`;
            Object.entries(validationRules).forEach(([field, rule]) => {
                prompt += `- ${field}: must match pattern ${rule}\n`;
            });
        }

        prompt += `
Return ONLY a JSON object with this exact structure:
{
  "document_type_match": true/false,
  "detected_document_type": "<what document is actually shown, e.g. 'PAN Card', 'Aadhaar Card', 'Random Photo', 'Blank Page', etc.>",
  "expected_document_type": "${expectedName}",
  "document_type_mismatch_reason": "<if document_type_match is false, explain why. e.g. 'Expected Aadhaar Card but received PAN Card'. Empty string if match is true>",
  "status": "verified" or "rejected",
  "confidence": <number between 0 and 100. Set to 0 if wrong document>,
  "risk_score": <number between 0 and 1. Set to 1.0 if wrong document>,
  "extracted_data": {
    <field_name>: <extracted_value or null if wrong document>,
    ...
  },
  "issues": [<list of any issues found. MUST include "Wrong document type: Expected X but received Y" if mismatch>],
  "fraud_indicators": [<list of fraud indicators if any, empty array if clean>],
  "metadata_match": {
    <field>: {"matches": true/false, "extracted": "value", "expected": "value"}
  },
  "remarks": "Brief summary of the verification result"
}

IMPORTANT: If document_type_match is false, you MUST set status to "rejected", confidence to 0, risk_score to 1.0, and include the mismatch in issues.`;
        return prompt;
    }

    /**
     * Detect media type from response headers or URL
     */
    getMediaType(contentType, url) {
        if (contentType) {
            if (contentType.includes('pdf')) return 'application/pdf';
            if (contentType.includes('png')) return 'image/png';
            if (contentType.includes('gif')) return 'image/gif';
            if (contentType.includes('webp')) return 'image/webp';
            if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'image/jpeg';
        }
        // Fallback to URL extension
        const ext = url.split('.').pop().split('?')[0].toLowerCase();
        const extMap = {
            pdf: 'application/pdf',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp'
        };
        return extMap[ext] || 'image/jpeg';
    }

    /**
     * Download a document from URL with SSRF protection
     */
    async downloadDocument(fileUrl) {
        // Validate URL for SSRF
        const urlCheck = await validateUrl(fileUrl);
        if (!urlCheck.valid) {
            throw new Error(`SSRF Protection: ${urlCheck.reason}`);
        }

        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 20 * 1024 * 1024, // 20MB max
            headers: {
                'User-Agent': 'DocumentVerificationService/1.0'
            }
        });

        return {
            buffer: Buffer.from(response.data),
            contentType: response.headers['content-type'],
            size: response.data.byteLength
        };
    }

    /**
     * Process document through OpenAI Vision API
     */
    async processWithOpenAI(base64Data, mediaType, systemPrompt, userPrompt) {
        if (!this.openai) {
            throw new Error('OpenAI client not initialized. Set OPENAI_API_KEY environment variable.');
        }

        const content = [];

        if (mediaType === 'application/pdf') {
            // For PDFs, use file input
            content.push({
                type: 'file',
                file: {
                    filename: 'document.pdf',
                    file_data: `data:application/pdf;base64,${base64Data}`
                }
            });
        } else {
            // For images, use image_url
            content.push({
                type: 'image_url',
                image_url: {
                    url: `data:${mediaType};base64,${base64Data}`,
                    detail: 'high'
                }
            });
        }

        content.push({ type: 'text', text: userPrompt });

        const response = await this.openai.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content }
            ],
            max_tokens: 4096,
            temperature: 0.1
        });

        const text = response.choices[0]?.message?.content;
        return this.parseAIResponse(text);
    }

    /**
     * Parse JSON from AI response, handling markdown code fences
     */
    parseAIResponse(text) {
        if (!text) throw new Error('Empty AI response');

        // Try direct parse
        try {
            return JSON.parse(text);
        } catch (e) {
            // Try extracting from code fences
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1].trim());
            }
            // Try finding JSON object
            const objMatch = text.match(/\{[\s\S]*\}/);
            if (objMatch) {
                return JSON.parse(objMatch[0]);
            }
            throw new Error('Failed to parse AI response as JSON');
        }
    }

    /**
     * Main verification entry point
     */
    async verify({ fileUrl, documentType, requiredFields, validationRules, metadata }) {
        // Download document
        const doc = await this.downloadDocument(fileUrl);

        // Detect media type
        const mediaType = this.getMediaType(doc.contentType, fileUrl);

        // Convert to base64
        const base64Data = doc.buffer.toString('base64');

        // Build prompts
        const systemPrompt = this.getSystemPrompt();
        const userPrompt = this.buildExtractionPrompt(documentType, requiredFields, validationRules, metadata);

        // Process with OpenAI
        const result = await this.processWithOpenAI(base64Data, mediaType, systemPrompt, userPrompt);

        // If AI detected wrong document type, force rejection
        const isWrongDoc = result.document_type_match === false;
        const issues = result.issues || [];
        if (isWrongDoc && !issues.some(i => i.toLowerCase().includes('wrong document'))) {
            const detected = result.detected_document_type || 'Unknown';
            const expected = result.expected_document_type || documentType;
            issues.unshift(`Wrong document type: Expected "${expected}" but received "${detected}"`);
        }

        return {
            status: isWrongDoc ? 'rejected' : (result.status || 'verified'),
            confidence: isWrongDoc ? 0 : (parseFloat(result.confidence) || 0),
            risk_score: isWrongDoc ? 1.0 : (parseFloat(result.risk_score) || 0),
            extracted_data: result.extracted_data || {},
            issues,
            fraud_indicators: result.fraud_indicators || [],
            metadata_match: result.metadata_match || {},
            remarks: result.remarks || '',
            document_type_match: result.document_type_match !== false,
            detected_document_type: result.detected_document_type || null,
            expected_document_type: result.expected_document_type || documentType,
            document_type_mismatch_reason: result.document_type_mismatch_reason || ''
        };
    }
}

// Singleton
module.exports = new AIProcessingService();
