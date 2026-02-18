const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');

/**
 * Rule Engine Service
 * Validates AI-extracted data against configured rules and generates confidence/risk scores.
 */
class RuleEngineService {
    /**
     * Validate extracted data against document master rules
     */
    async validate(documentTypeCode, extractedData, aiResult, userId) {
        const issues = [...(aiResult.issues || [])];
        let confidenceAdjustment = 0;
        let riskAdjustment = 0;

        // Get document master config (user-specific first, then global)
        const docMaster = userId
            ? await V1DocumentMasterModel.findByCodeForUser(documentTypeCode, userId)
            : await V1DocumentMasterModel.findByCode(documentTypeCode);
        if (!docMaster) {
            return {
                status: aiResult.status,
                confidence: aiResult.confidence,
                risk_score: aiResult.risk_score,
                issues: [...issues, `Unknown document type: ${documentTypeCode}`],
                validation_results: {}
            };
        }

        const validationResults = {};

        // 0. Check document type match (wrong document detection)
        if (aiResult.document_type_match === false) {
            const detected = aiResult.detected_document_type || 'Unknown';
            const expected = aiResult.expected_document_type || documentTypeCode;
            const mismatchReason = aiResult.document_type_mismatch_reason || `Expected "${expected}" but received "${detected}"`;

            issues.push(`Wrong document submitted: ${mismatchReason}`);

            return {
                status: 'rejected',
                confidence: 0,
                risk_score: 1.0,
                issues,
                validation_results: {
                    document_type_check: {
                        status: 'failed',
                        expected: expected,
                        detected: detected,
                        message: mismatchReason
                    }
                },
                fraud_indicators: aiResult.fraud_indicators || [],
                wrong_document: true,
                detected_document_type: detected,
                expected_document_type: expected
            };
        }

        // 0.5 Post-AI keyword cross-check for similar document types
        // Even if AI says document_type_match=true, we double-check using extracted data
        const keywordMismatch = this._checkKeywordMismatch(documentTypeCode, extractedData, aiResult);
        if (keywordMismatch) {
            issues.push(keywordMismatch.reason);

            return {
                status: 'rejected',
                confidence: 0,
                risk_score: 1.0,
                issues,
                validation_results: {
                    document_type_check: {
                        status: 'failed',
                        expected: keywordMismatch.expected,
                        detected: keywordMismatch.detected,
                        message: keywordMismatch.reason
                    }
                },
                fraud_indicators: aiResult.fraud_indicators || [],
                wrong_document: true,
                detected_document_type: keywordMismatch.detected,
                expected_document_type: keywordMismatch.expected
            };
        }

        // 1. Check required fields are present
        const requiredFields = docMaster.required_fields || [];
        for (const field of requiredFields) {
            const value = extractedData[field];
            if (!value || (typeof value === 'string' && value.trim() === '')) {
                issues.push(`Required field missing: ${field}`);
                confidenceAdjustment -= 5;
                riskAdjustment += 0.05;
                validationResults[field] = { status: 'missing', message: 'Required field not found' };
            } else {
                validationResults[field] = { status: 'present', value };
            }
        }

        // 2. Apply regex validation rules
        const rules = docMaster.validation_rules || {};
        for (const [field, pattern] of Object.entries(rules)) {
            const value = extractedData[field];
            if (value && typeof pattern === 'string') {
                try {
                    const regex = new RegExp(pattern);
                    if (!regex.test(String(value))) {
                        issues.push(`Field '${field}' does not match expected pattern`);
                        confidenceAdjustment -= 10;
                        riskAdjustment += 0.1;
                        validationResults[field] = {
                            ...validationResults[field],
                            pattern_valid: false,
                            message: `Does not match pattern: ${pattern}`
                        };
                    } else {
                        validationResults[field] = {
                            ...validationResults[field],
                            pattern_valid: true
                        };
                    }
                } catch (err) {
                    // Invalid regex, skip
                }
            }
        }

        // 3. Check metadata cross-verification
        if (aiResult.metadata_match) {
            for (const [field, match] of Object.entries(aiResult.metadata_match)) {
                if (match && match.matches === false) {
                    issues.push(`Metadata mismatch on '${field}': expected '${match.expected}', got '${match.extracted}'`);
                    confidenceAdjustment -= 15;
                    riskAdjustment += 0.15;
                }
            }
        }

        // 4. Check fraud indicators
        if (aiResult.fraud_indicators && aiResult.fraud_indicators.length > 0) {
            riskAdjustment += 0.2 * aiResult.fraud_indicators.length;
            confidenceAdjustment -= 10 * aiResult.fraud_indicators.length;
        }

        // 5. Authenticity checks - is_genuine flag
        let forceReject = false;
        if (aiResult.is_genuine === false) {
            issues.push('Document failed authenticity check: AI determined document is not genuine');
            confidenceAdjustment -= 40;
            riskAdjustment += 0.5;
            forceReject = true;
            validationResults.authenticity = { status: 'failed', message: 'Document is not genuine' };
        }

        // 6. Detailed authenticity checks
        const authChecks = aiResult.authenticity_checks || {};
        if (authChecks.tampering_detected === true) {
            issues.push('Tampering detected: Document appears to have been digitally altered');
            confidenceAdjustment -= 30;
            riskAdjustment += 0.4;
            forceReject = true;
            validationResults.tampering = { status: 'failed', message: 'Tampering evidence found' };
        }
        if (authChecks.is_original_document === false) {
            issues.push('Document does not appear to be an original - possible photocopy or digitally recreated');
            confidenceAdjustment -= 15;
            riskAdjustment += 0.15;
            validationResults.originality = { status: 'failed', message: 'Not an original document' };
        }
        if (authChecks.font_consistency === false) {
            issues.push('Inconsistent fonts detected across the document');
            confidenceAdjustment -= 15;
            riskAdjustment += 0.15;
            validationResults.font_check = { status: 'failed', message: 'Font inconsistency detected' };
        }
        if (authChecks.layout_matches_official === false) {
            issues.push('Document layout does not match known official format');
            confidenceAdjustment -= 20;
            riskAdjustment += 0.2;
            validationResults.layout_check = { status: 'failed', message: 'Layout mismatch with official format' };
        }
        if (authChecks.photo_integrity === false) {
            issues.push('Photo on document appears altered or digitally pasted');
            confidenceAdjustment -= 20;
            riskAdjustment += 0.2;
            validationResults.photo_check = { status: 'failed', message: 'Photo integrity compromised' };
        }
        if (authChecks.image_quality === 'suspicious') {
            issues.push('Image quality is suspicious - may indicate digital manipulation');
            confidenceAdjustment -= 20;
            riskAdjustment += 0.2;
            validationResults.image_quality = { status: 'failed', message: 'Suspicious image quality' };
        } else if (authChecks.image_quality === 'poor') {
            issues.push('Image quality is too poor for reliable verification');
            confidenceAdjustment -= 10;
            riskAdjustment += 0.1;
            validationResults.image_quality = { status: 'warning', message: 'Poor image quality' };
        }
        if (authChecks.has_security_features === false) {
            issues.push('Expected security features (watermarks, holograms, official seals) not found');
            confidenceAdjustment -= 15;
            riskAdjustment += 0.15;
            validationResults.security_features = { status: 'failed', message: 'Security features missing' };
        }

        // 7. Data consistency checks
        const dataConsistency = aiResult.data_consistency || {};
        if (dataConsistency.dates_valid === false) {
            issues.push('Date inconsistency detected in document fields');
            confidenceAdjustment -= 10;
            riskAdjustment += 0.1;
            validationResults.date_consistency = { status: 'failed', message: 'Invalid or inconsistent dates' };
        }
        if (dataConsistency.id_format_valid === false) {
            issues.push('ID number format does not match expected pattern for this document type');
            confidenceAdjustment -= 10;
            riskAdjustment += 0.1;
            validationResults.id_format = { status: 'failed', message: 'ID format mismatch' };
        }
        if (dataConsistency.logical_checks_passed === false) {
            issues.push(`Data consistency issue: ${dataConsistency.details || 'Logical inconsistencies found in document data'}`);
            confidenceAdjustment -= 10;
            riskAdjustment += 0.1;
            validationResults.logical_consistency = { status: 'failed', message: dataConsistency.details || 'Logical check failed' };
        }

        // Calculate final scores
        const finalConfidence = Math.max(0, Math.min(100, aiResult.confidence + confidenceAdjustment));
        const finalRiskScore = Math.max(0, Math.min(1, aiResult.risk_score + riskAdjustment));

        // Determine final status
        let finalStatus = aiResult.status;
        if (forceReject || finalConfidence < 50 || finalRiskScore > 0.7) {
            finalStatus = 'rejected';
        } else if (finalConfidence >= 80 && finalRiskScore < 0.2) {
            finalStatus = 'verified';
        }

        return {
            status: finalStatus,
            confidence: parseFloat(finalConfidence.toFixed(2)),
            risk_score: parseFloat(finalRiskScore.toFixed(4)),
            issues,
            validation_results: validationResults,
            fraud_indicators: aiResult.fraud_indicators || [],
            wrong_document: false,
            is_genuine: aiResult.is_genuine !== false,
            authenticity_checks: authChecks,
            data_consistency: dataConsistency,
            detected_document_type: aiResult.detected_document_type || null,
            expected_document_type: aiResult.expected_document_type || documentTypeCode
        };
    }
    /**
     * Keyword-based cross-check for similar document types.
     * Even if the AI says "match=true", this catches cases like 12th marksheet
     * submitted as 10th by scanning extracted text for disqualifying keywords.
     */
    _checkKeywordMismatch(documentTypeCode, extractedData, aiResult) {
        // Build a searchable text blob from all extracted data
        const allText = this._buildSearchText(extractedData, aiResult);
        if (!allText) return null;

        // Define confusion rules for each document type
        const confusionRules = {
            marksheet_10: {
                expected: '10th Class Marksheet (SSC / Secondary School)',
                // If any of these are found, it's likely a 12th marksheet
                reject_keywords: [
                    'higher secondary', 'hsc', 'senior secondary',
                    'class xii', 'class-xii', '12th', 'xiith',
                    'intermediate', 'plus two', 'higher sec'
                ],
                detected_if_rejected: '12th Class Marksheet (HSC / Higher Secondary)'
            },
            marksheet_12: {
                expected: '12th Class Marksheet (HSC / Higher Secondary)',
                // If it says SSC/SSLC without "Higher", it's a 10th marksheet
                reject_keywords: [
                    'sslc', 'matriculation exam'
                ],
                // More nuanced: "secondary school certificate" WITHOUT "higher" prefix
                reject_patterns: [
                    /\bsecondary\s+school\s+certificate\b/i,
                    /\bssc\s+exam/i,
                    /\bclass\s+x\b(?!\s*i)/i,
                    /\b10th\s+(class|standard|std)/i
                ],
                // Except if "higher" is also present
                override_if_present: ['higher secondary', 'hsc', 'senior secondary'],
                detected_if_rejected: '10th Class Marksheet (SSC / Secondary School)'
            }
        };

        const rule = confusionRules[documentTypeCode];
        if (!rule) return null;

        const textLower = allText.toLowerCase();

        // Check simple reject keywords
        if (rule.reject_keywords) {
            for (const kw of rule.reject_keywords) {
                if (textLower.includes(kw)) {
                    return {
                        expected: rule.expected,
                        detected: rule.detected_if_rejected,
                        reason: `Wrong document submitted: Found "${kw}" in document text which indicates this is a ${rule.detected_if_rejected}, not a ${rule.expected}`
                    };
                }
            }
        }

        // Check regex patterns with override
        if (rule.reject_patterns) {
            for (const pattern of rule.reject_patterns) {
                if (pattern.test(allText)) {
                    // Check if override keywords are present (e.g., "Higher Secondary" overrides "Secondary")
                    if (rule.override_if_present) {
                        const hasOverride = rule.override_if_present.some(ow => textLower.includes(ow));
                        if (hasOverride) continue; // Skip this rejection, override applies
                    }
                    return {
                        expected: rule.expected,
                        detected: rule.detected_if_rejected,
                        reason: `Wrong document submitted: Document content indicates this is a ${rule.detected_if_rejected}, not a ${rule.expected}`
                    };
                }
            }
        }

        // Additional: check exam_class field if extracted
        if (extractedData.exam_class) {
            const examClass = String(extractedData.exam_class).toLowerCase().trim();
            if (documentTypeCode === 'marksheet_10') {
                if (examClass.includes('12') || examClass.includes('xii') || examClass.includes('higher')) {
                    return {
                        expected: rule.expected,
                        detected: rule.detected_if_rejected,
                        reason: `Wrong document submitted: Extracted exam_class "${extractedData.exam_class}" indicates 12th class, not 10th`
                    };
                }
            } else if (documentTypeCode === 'marksheet_12') {
                if ((examClass.includes('10') || examClass.includes(' x') || examClass === 'x') &&
                    !examClass.includes('12') && !examClass.includes('xii')) {
                    return {
                        expected: rule.expected,
                        detected: rule.detected_if_rejected,
                        reason: `Wrong document submitted: Extracted exam_class "${extractedData.exam_class}" indicates 10th class, not 12th`
                    };
                }
            }
        }

        return null;
    }

    /**
     * Build a combined text blob from extracted data and AI response for keyword searching
     */
    _buildSearchText(extractedData, aiResult) {
        const parts = [];

        // Add all extracted data values
        if (extractedData) {
            for (const [key, value] of Object.entries(extractedData)) {
                if (value != null) parts.push(String(value));
            }
        }

        // Add AI remarks
        if (aiResult.remarks) parts.push(aiResult.remarks);

        // Add exam_name if present
        if (extractedData?.exam_name) parts.push(extractedData.exam_name);
        if (extractedData?.board) parts.push(extractedData.board);
        if (extractedData?.board_name) parts.push(extractedData.board_name);
        if (extractedData?.examination) parts.push(extractedData.examination);

        return parts.join(' ');
    }
}

module.exports = new RuleEngineService();
