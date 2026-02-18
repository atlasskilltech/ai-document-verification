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
1. Analyze the provided document image/PDF
2. Extract all relevant structured data
3. Verify the document's authenticity indicators
4. Check for signs of tampering or fraud
5. Provide a confidence score and risk assessment

You MUST respond in valid JSON format only. No markdown, no extra text.`;
    }

    /**
     * Build the extraction prompt based on document type config
     */
    buildExtractionPrompt(documentType, requiredFields, validationRules, metadata) {
        let prompt = `Analyze this ${documentType} document and extract the following information.\n\n`;
        prompt += `Required fields:\n`;
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
  "status": "verified" or "rejected",
  "confidence": <number between 0 and 100>,
  "risk_score": <number between 0 and 1, where 0 is lowest risk>,
  "extracted_data": {
    <field_name>: <extracted_value>,
    ...
  },
  "issues": [<list of any issues found, empty array if none>],
  "fraud_indicators": [<list of fraud indicators if any, empty array if clean>],
  "metadata_match": {
    <field>: {"matches": true/false, "extracted": "value", "expected": "value"}
  },
  "remarks": "Brief summary of the verification result"
}`;
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

        return {
            status: result.status || 'verified',
            confidence: parseFloat(result.confidence) || 0,
            risk_score: parseFloat(result.risk_score) || 0,
            extracted_data: result.extracted_data || {},
            issues: result.issues || [],
            fraud_indicators: result.fraud_indicators || [],
            metadata_match: result.metadata_match || {},
            remarks: result.remarks || ''
        };
    }
}

// Singleton
module.exports = new AIProcessingService();
