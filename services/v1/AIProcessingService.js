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
        return `You are an expert forensic document verification AI with zero tolerance for fake, tampered, or incorrect documents. Your job is to ensure ONLY 100% genuine, authentic documents pass verification.

VERIFICATION PIPELINE (follow in strict order):

PHASE 1 - DOCUMENT TYPE IDENTIFICATION:
- Identify what type of document is ACTUALLY in the image
- Compare against the claimed/expected document type
- If mismatch, immediately reject (document_type_match = false)
- If image is not a document (random photo, blank page, screenshot of text, etc.), reject

PHASE 2 - AUTHENTICITY & FRAUD DETECTION (CRITICAL):
Examine the document for ALL of the following:
a) IMAGE QUALITY: Is it a photo of a real document or a digitally created/edited image?
b) TAMPERING SIGNS: Look for inconsistent fonts, misaligned text, different text colors/sizes within same field, pixelation around text, copy-paste artifacts, blur inconsistencies (some parts sharp, some blurry)
c) LAYOUT VERIFICATION: Does the layout match known official formats for this document type? Are logos, headers, watermarks in correct positions?
d) SECURITY FEATURES: Check for expected security features (holograms, watermarks, microprint, QR codes, official seals, embossed stamps, government emblems)
e) PRINT QUALITY: Is this a scan of an original document or a printout of a digital fake?
f) DATA CONSISTENCY: Do all fields on the document look internally consistent? (same font family, consistent formatting, no overlapping text)
g) PHOTO INTEGRITY: If the document has a photo, does it look naturally integrated or pasted/overlaid?
h) DOCUMENT CONDITION: Is this a photograph of a real physical document, or a digitally generated document?

PHASE 3 - DATA EXTRACTION & VALIDATION:
- Extract all required fields
- Cross-verify extracted data against provided metadata
- Check ID numbers, dates, and patterns against known formats
- Verify logical consistency (e.g., DOB makes person reasonable age, dates are in valid ranges, expiry after issue date)

SCORING RULES:
- Confidence 90-100: Document appears fully genuine with all security features present
- Confidence 70-89: Document appears genuine but minor quality issues (blur, angle, etc.)
- Confidence 50-69: Some concerns but no clear evidence of fraud
- Confidence 0-49: Significant fraud indicators or missing security features - MUST REJECT
- Risk score > 0.5: MUST REJECT the document
- Any fraud indicator found: reduce confidence by at least 20 points per indicator

CRITICAL RULES:
- If expected type is "aadhaar" but image shows PAN card = wrong document, reject
- If the image is not a document at all = reject
- If you detect ANY tampering evidence = reject with fraud_indicators
- If the document looks like a photocopy of a photocopy (very degraded) = flag as low quality
- If text appears digitally overlaid on a template = reject as fake
- When in doubt, REJECT. False positives (accepting fake docs) are far worse than false negatives.

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
            aadhaar: {
                name: 'Aadhaar Card',
                description: 'Indian unique identity card issued by UIDAI with 12-digit Aadhaar number, photo, QR code, and Government of India emblem',
                confusable_with: []
            },
            pan: {
                name: 'PAN Card',
                description: 'Indian Permanent Account Number card issued by Income Tax Dept with 10-character alphanumeric PAN, photo, and Income Tax Dept logo',
                confusable_with: []
            },
            passport: {
                name: 'Passport',
                description: 'International travel passport document with passport number, photo, nationality, and machine-readable zone (MRZ)',
                confusable_with: []
            },
            driving_license: {
                name: 'Driving License',
                description: 'Driving license/permit issued by transport authority with license number, vehicle classes, and photo',
                confusable_with: []
            },
            voter_id: {
                name: 'Voter ID / EPIC',
                description: 'Indian Election Photo ID Card (EPIC) issued by Election Commission with voter ID number and photo',
                confusable_with: []
            },
            bank_statement: {
                name: 'Bank Statement',
                description: 'Bank account statement showing account number, account holder name, bank logo, and transaction history',
                confusable_with: []
            },
            utility_bill: {
                name: 'Utility Bill',
                description: 'Utility bill (electricity, water, gas, phone) showing name, address, and bill amount',
                confusable_with: []
            },
            marksheet_10: {
                name: '10th Class Marksheet (SSC / Secondary School)',
                description: 'Class 10 / SSC / SSLC / Secondary School Certificate examination marksheet. This is the 10th standard / Class X exam. It will contain keywords like "Secondary School Certificate", "SSC", "SSLC", "Class X", "10th", "Matriculation", or "Secondary Education". It must NOT contain "Higher Secondary", "HSC", "Senior Secondary", "Class XII", "12th", or "Intermediate".',
                must_have_keywords: ['Secondary', 'SSC', 'SSLC', 'Class X', '10th', 'Matriculation', 'Class-X', 'Xth'],
                must_not_have_keywords: ['Higher Secondary', 'HSC', 'Senior Secondary', 'Class XII', '12th', 'Intermediate', 'Class-XII', 'XIIth', 'Plus Two'],
                confusable_with: ['marksheet_12']
            },
            marksheet_12: {
                name: '12th Class Marksheet (HSC / Higher Secondary)',
                description: 'Class 12 / HSC / Higher Secondary Certificate / Senior Secondary examination marksheet. This is the 12th standard / Class XII exam. It will contain keywords like "Higher Secondary", "HSC", "Senior Secondary", "Class XII", "12th", "Intermediate", or "Plus Two". It must NOT be a 10th / SSC / Secondary School Certificate.',
                must_have_keywords: ['Higher Secondary', 'HSC', 'Senior Secondary', 'Class XII', '12th', 'Intermediate', 'Class-XII', 'XIIth', 'Plus Two'],
                must_not_have_keywords: ['Secondary School Certificate', 'SSC Examination', 'SSLC', 'Class X Exam', 'Matriculation Exam'],
                confusable_with: ['marksheet_10']
            },
            graduation_cert: {
                name: 'Graduation Certificate',
                description: 'University degree/graduation certificate with degree name (B.A., B.Sc., B.Tech, etc.), university name, student name, and year of passing',
                confusable_with: ['marksheet_12']
            }
        };
    }

    buildExtractionPrompt(documentType, requiredFields, validationRules, metadata) {
        const docDescriptions = this.getDocumentTypeDescriptions();
        const expectedDoc = docDescriptions[documentType];
        const expectedName = expectedDoc ? expectedDoc.name : documentType;
        const expectedDescription = expectedDoc ? expectedDoc.description : `A document of type "${documentType}"`;

        let prompt = `STEP 1 - DOCUMENT TYPE VERIFICATION (MANDATORY - DO THIS FIRST):
The user claims this is a "${expectedName}" (code: ${documentType}).
Expected document: ${expectedDescription}

You MUST first determine what type of document is ACTUALLY shown in this image.
- Carefully read ALL text on the document including headers, titles, board names, and exam names
- Determine the actual document type based on the content, NOT just the layout
- Compare it against the expected type "${expectedName}"
- If the actual document does NOT match the expected type, set document_type_match to false
- If the image is blurry, blank, a random photo, or not a valid document, set document_type_match to false
`;

        // Add keyword-based identification rules
        if (expectedDoc?.must_have_keywords?.length) {
            prompt += `\nKEYWORD CHECK - The document SHOULD contain at least one of these keywords/phrases to be a valid "${expectedName}":
${expectedDoc.must_have_keywords.map(k => `  - "${k}"`).join('\n')}
If NONE of these keywords are found on the document, it is likely NOT a ${expectedName}.\n`;
        }

        if (expectedDoc?.must_not_have_keywords?.length) {
            prompt += `\nREJECTION KEYWORDS - If the document contains ANY of these keywords, it is NOT a "${expectedName}" and must be REJECTED:
${expectedDoc.must_not_have_keywords.map(k => `  - "${k}"`).join('\n')}
These keywords indicate a DIFFERENT document type.\n`;
        }

        // Warn about confusable types
        if (expectedDoc?.confusable_with?.length) {
            const confusableNames = expectedDoc.confusable_with.map(code => {
                const desc = docDescriptions[code];
                return desc ? `"${desc.name}" (${code})` : code;
            }).join(', ');
            prompt += `\nWARNING - COMMONLY CONFUSED DOCUMENTS:
This document type is frequently confused with: ${confusableNames}.
You MUST carefully distinguish between them. Pay close attention to:
- The exact exam/certificate name printed on the document
- Whether it says "Secondary" vs "Higher Secondary"
- Whether it says "Class X" vs "Class XII"
- Whether it says "10th" vs "12th"
- The board/examination authority name and what exam level they indicate
Do NOT assume the document matches just because it looks like a marksheet or certificate.\n`;
        }

        prompt += `\nSTEP 2 - DATA EXTRACTION (only if document type matches):
`;
        prompt += `Extract the following fields from the ${expectedName}:\n`;
        // Always ask for exam_class on marksheet-type docs
        const fieldsToExtract = [...(requiredFields || [])];
        if (documentType.startsWith('marksheet_') && !fieldsToExtract.includes('exam_class')) {
            fieldsToExtract.push('exam_class');
        }
        if (documentType.startsWith('marksheet_') && !fieldsToExtract.includes('exam_name')) {
            fieldsToExtract.push('exam_name');
        }
        if (fieldsToExtract && fieldsToExtract.length > 0) {
            fieldsToExtract.forEach(field => {
                if (field === 'exam_class') {
                    prompt += `- exam_class (IMPORTANT: Extract the exact class/standard, e.g. "10th", "12th", "Class X", "Class XII")\n`;
                } else if (field === 'exam_name') {
                    prompt += `- exam_name (IMPORTANT: Extract the full exam name, e.g. "Secondary School Certificate", "Higher Secondary Certificate")\n`;
                } else {
                    prompt += `- ${field}\n`;
                }
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
  "document_type_mismatch_reason": "<if document_type_match is false, explain why. Empty string if match is true>",
  "is_genuine": true/false,
  "authenticity_checks": {
    "is_original_document": true/false,
    "has_security_features": true/false,
    "tampering_detected": true/false,
    "image_quality": "good" | "acceptable" | "poor" | "suspicious",
    "font_consistency": true/false,
    "layout_matches_official": true/false,
    "photo_integrity": true/false | null,
    "details": "<explain authenticity assessment in 1-2 sentences>"
  },
  "status": "verified" or "rejected",
  "confidence": <number 0-100. 0 if wrong doc. Below 50 if fraud suspected. Only 80+ if fully genuine>,
  "risk_score": <number 0-1. 1.0 if wrong doc. Above 0.5 if fraud suspected. Below 0.2 only if fully clean>,
  "extracted_data": {
    <field_name>: <extracted_value or null if wrong/fake document>,
    ...
  },
  "issues": [<list of ALL issues found. Include wrong doc type, missing fields, tampering, quality problems>],
  "fraud_indicators": [<MUST list ALL detected fraud signs. Examples: "Text appears digitally overlaid", "Inconsistent fonts detected", "Missing official watermark", "Photo appears pasted", "Document layout does not match known official format", "Pixelation around text fields suggests editing", "QR code missing or unreadable". Empty array ONLY if document is 100% clean>],
  "metadata_match": {
    <field>: {"matches": true/false, "extracted": "value", "expected": "value"}
  },
  "data_consistency": {
    "dates_valid": true/false,
    "id_format_valid": true/false,
    "logical_checks_passed": true/false,
    "details": "<explain any inconsistencies found>"
  },
  "remarks": "Brief summary of the verification result"
}

IMPORTANT RULES:
- If document_type_match is false: status="rejected", confidence=0, risk_score=1.0
- If is_genuine is false: status="rejected", confidence must be below 30, risk_score above 0.7
- If ANY fraud_indicator is found: status="rejected", reduce confidence significantly
- If tampering_detected is true: status="rejected", risk_score must be above 0.8
- ONLY set status="verified" and confidence above 80 if the document is GENUINELY authentic with no concerns
- When unsure about authenticity, REJECT rather than accept`;
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

        // If AI says document is not genuine, force rejection
        const isNotGenuine = result.is_genuine === false;
        const isTampered = result.authenticity_checks?.tampering_detected === true;

        let finalStatus = result.status || 'verified';
        let finalConfidence = parseFloat(result.confidence) || 0;
        let finalRiskScore = parseFloat(result.risk_score) || 0;

        if (isWrongDoc) {
            finalStatus = 'rejected';
            finalConfidence = 0;
            finalRiskScore = 1.0;
        } else if (isNotGenuine || isTampered) {
            finalStatus = 'rejected';
            finalConfidence = Math.min(finalConfidence, 25);
            finalRiskScore = Math.max(finalRiskScore, 0.8);
        }

        return {
            status: finalStatus,
            confidence: finalConfidence,
            risk_score: finalRiskScore,
            extracted_data: result.extracted_data || {},
            issues,
            fraud_indicators: result.fraud_indicators || [],
            metadata_match: result.metadata_match || {},
            remarks: result.remarks || '',
            document_type_match: result.document_type_match !== false,
            detected_document_type: result.detected_document_type || null,
            expected_document_type: result.expected_document_type || documentType,
            document_type_mismatch_reason: result.document_type_mismatch_reason || '',
            is_genuine: isWrongDoc ? false : (result.is_genuine !== false),
            authenticity_checks: result.authenticity_checks || {},
            data_consistency: result.data_consistency || {}
        };
    }
}

// Singleton
module.exports = new AIProcessingService();
