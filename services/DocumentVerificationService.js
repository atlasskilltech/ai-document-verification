const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

class DocumentVerificationService {

    constructor() {
        this.provider = process.env.AI_PROVIDER || 'claude'; // 'claude' or 'openai'

        if (this.provider === 'claude') {
            this.claude = new Anthropic.default({
                apiKey: process.env.ANTHROPIC_API_KEY
            });
        } else {
            this.openai = new OpenAI.default({
                apiKey: process.env.OPENAI_API_KEY
            });
        }
    }

    getSystemPrompt() {
        return `You are a document verification AI assistant for an educational admissions system.

Your job is to verify uploaded documents against their expected type and description, AND extract all readable data from the document.

For each document, you must:

1. VERIFY the document:
   - DOCUMENT TYPE MATCH: Does the uploaded document match the expected document type?
   - DESCRIPTION COMPLIANCE: Does it satisfy the document_description requirements?
   - LEGIBILITY: Is it clear, readable, not blurry or cut off?
   - AUTHENTICITY INDICATORS: Proper formatting, stamps, signatures where expected?
   - COMPLETENESS: Is the full document visible?

2. EXTRACT all readable data from the document. Depending on the document type, extract fields like:
   - For Photographs: description of the photo (formal/informal, background color, attire)
   - For Marksheets: student name, roll number, board/university, year, subjects with marks/grades, total/percentage, result
   - For Certificates (passing, leaving, migration, birth): student name, date of birth, certificate number, issuing authority, date of issue, institution name
   - For ID Proofs (Aadhar): name, Aadhar number (last 4 digits only), date of birth, address
   - For PAN Card: name, PAN number, date of birth
   - For Affidavits/Undertakings: signatory names, stamp paper value, notary details, date
   - For ABC ID: ABC ID number, student name, institution
   - For any document: extract ALL readable text fields you can identify

You must respond ONLY with a valid JSON object (no markdown, no code fences):
{
  "status": "approve" or "reject",
  "confidence": 0.0 to 1.0,
  "remark": "Brief explanation of the verification result",
  "issues": ["list of specific issues found, if any"],
  "extracted_data": {
    "document_title": "Title or heading visible on the document",
    "student_name": "Name found on document if applicable",
    "additional_field_1": "value",
    "additional_field_2": "value"
  }
}

The extracted_data object should contain ALL key-value pairs you can read from the document. Use descriptive field names. If a field is not readable, do not include it.

Status guidelines:
- "approve": Document matches expected type, satisfies description, is legible, appears authentic.
- "reject": Does not match expected type, fails description requirements, illegible, tampered, or significant issues.

Be strict but fair. Only approve if reasonably confident the document is correct.`;
    }

    buildDocumentPrompt(document) {
        let prompt = `Please verify and extract data from the following uploaded document:\n\n`;
        prompt += `Expected Document Type: ${document.document_label}\n`;
        prompt += `Document Category: ${document.document_type_name}\n`;

        if (document.document_description && document.document_description.trim()) {
            prompt += `Requirements/Description: ${document.document_description}\n`;
        }

        prompt += `\nAnalyze the attached document. Verify it matches the expected type and requirements, then extract ALL readable data fields. Respond with a JSON object including both verification result and extracted_data.`;

        return prompt;
    }

    getMediaType(filename, contentType) {
        const ext = filename.split('.').pop().toLowerCase();

        if (contentType && contentType !== 'application/octet-stream') {
            if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'image/jpeg';
            if (contentType.includes('png')) return 'image/png';
            if (contentType.includes('gif')) return 'image/gif';
            if (contentType.includes('webp')) return 'image/webp';
            if (contentType.includes('pdf')) return 'application/pdf';
        }

        const extMap = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'pdf': 'application/pdf'
        };

        return extMap[ext] || 'image/jpeg';
    }

    async verifyWithClaude(fileBuffer, document) {
        const mediaType = this.getMediaType(document.filename, document.contentType);
        const base64Data = fileBuffer.toString('base64');
        const userPrompt = this.buildDocumentPrompt(document);

        const contentBlocks = [];

        if (mediaType === 'application/pdf') {
            contentBlocks.push({
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64Data
                }
            });
        } else {
            contentBlocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Data
                }
            });
        }

        contentBlocks.push({ type: 'text', text: userPrompt });

        const response = await this.claude.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: this.getSystemPrompt(),
            messages: [{ role: 'user', content: contentBlocks }]
        });

        const text = response.content[0].text;
        return this.parseAIResponse(text);
    }

    async verifyWithOpenAI(fileBuffer, document) {
        const mediaType = this.getMediaType(document.filename, document.contentType);
        const base64Data = fileBuffer.toString('base64');
        const userPrompt = this.buildDocumentPrompt(document);

        const contentParts = [
            {
                type: 'image_url',
                image_url: {
                    url: `data:${mediaType};base64,${base64Data}`,
                    detail: 'high'
                }
            },
            { type: 'text', text: userPrompt }
        ];

        const response = await this.openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            max_tokens: 2048,
            messages: [
                { role: 'system', content: this.getSystemPrompt() },
                { role: 'user', content: contentParts }
            ]
        });

        const text = response.choices[0].message.content;
        return this.parseAIResponse(text);
    }

    parseAIResponse(text) {
        try {
            let cleaned = text.trim();
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            }
            const result = JSON.parse(cleaned);
            return {
                status: result.status || 'reject',
                confidence: result.confidence || 0,
                remark: result.remark || 'Unable to determine',
                issues: result.issues || [],
                extracted_data: result.extracted_data || {}
            };
        } catch (e) {
            return {
                status: 'reject',
                confidence: 0,
                remark: `AI response parsing failed: ${text.substring(0, 200)}`,
                issues: ['Could not parse AI verification response'],
                extracted_data: {}
            };
        }
    }

    async verify(fileBuffer, document) {
        if (this.provider === 'claude') {
            return this.verifyWithClaude(fileBuffer, document);
        } else {
            return this.verifyWithOpenAI(fileBuffer, document);
        }
    }
}

module.exports = DocumentVerificationService;
