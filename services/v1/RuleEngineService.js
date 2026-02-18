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

        // Calculate final scores
        const finalConfidence = Math.max(0, Math.min(100, aiResult.confidence + confidenceAdjustment));
        const finalRiskScore = Math.max(0, Math.min(1, aiResult.risk_score + riskAdjustment));

        // Determine final status
        let finalStatus = aiResult.status;
        if (finalConfidence < 50 || finalRiskScore > 0.7) {
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
            fraud_indicators: aiResult.fraud_indicators || []
        };
    }
}

module.exports = new RuleEngineService();
