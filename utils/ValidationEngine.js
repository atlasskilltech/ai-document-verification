const DocumentModel = require('../models/DocumentModel');
const ValidationModel = require('../models/ValidationModel');
const NotificationModel = require('../models/NotificationModel');
const AuditModel = require('../models/AuditModel');
const ApplicantModel = require('../models/ApplicantModel');
const DataValidationService = require('../services/v1/DataValidationService');
const path = require('path');

class ValidationEngine {

    /**
     * Run full validation for an applicant's documents
     */
    static async validateApplication(applicantId) {
        const applicant = await ApplicantModel.getById(applicantId);
        if (!applicant) throw new Error('Applicant not found');

        // Get checklist for the program
        const checklist = await DocumentModel.getChecklist(applicant.program_id);
        // Get uploaded documents
        const uploadedDocs = await DocumentModel.getApplicantDocuments(applicantId);

        const results = [];
        let totalFlagged = 0;
        let totalVerified = 0;
        let sensitivityScores = [];

        // ----- STEP 1: Completeness Check -----
        const applicableChecklist = checklist.filter(item => {
            if (item.requirement_type === 'Optional') return false;
            if (item.requirement_type === 'Conditional' && item.condition_rule) {
                return this.evaluateCondition(item.condition_rule, applicant);
            }
            return true; // Mandatory
        });

        for (const checkItem of applicableChecklist) {
            const uploaded = uploadedDocs.find(d => d.document_type_id === checkItem.document_type_id);

            if (!uploaded) {
                // Missing document
                const score = checkItem.sensitivity_if_missing || 8;
                sensitivityScores.push(score);
                totalFlagged++;

                // Create a placeholder validation for missing doc
                results.push({
                    document_name: checkItem.document_name,
                    category: checkItem.category,
                    status: 'Missing',
                    issue: 'Not Uploaded',
                    sensitivity_score: score,
                    sensitivity_level: this.getSensitivityLevel(score),
                    action: this.getActionRequired(score)
                });

                // Send notification
                await NotificationModel.create({
                    applicant_id: applicantId,
                    target_type: 'Applicant',
                    alert_type: 'MissingDocument',
                    title: `Missing Document: ${checkItem.document_name}`,
                    message: `Please upload your ${checkItem.document_name}. This is a ${checkItem.requirement_type.toLowerCase()} document for your program.`
                });

                continue;
            }

            // ----- STEP 2: Format Validation -----
            const formatResult = await this.validateFormat(uploaded, checkItem);
            if (formatResult) {
                await ValidationModel.saveResult({
                    applicant_document_id: uploaded.id,
                    applicant_id: applicantId,
                    ...formatResult
                });
                if (formatResult.status === 'Fail') {
                    sensitivityScores.push(formatResult.sensitivity_score);
                    totalFlagged++;
                }
            }

            // ----- STEP 3: Expiry Validation -----
            if (checkItem.has_expiry) {
                const expiryResult = await this.validateExpiry(uploaded);
                if (expiryResult) {
                    await ValidationModel.saveResult({
                        applicant_document_id: uploaded.id,
                        applicant_id: applicantId,
                        ...expiryResult
                    });
                    if (expiryResult.status === 'Fail') {
                        sensitivityScores.push(expiryResult.sensitivity_score);
                        totalFlagged++;
                    }
                }
            }

            // ----- STEP 4: Data Validation (dates, ID format, logical checks) -----
            if (uploaded.extracted_data) {
                const extractedData = typeof uploaded.extracted_data === 'string'
                    ? JSON.parse(uploaded.extracted_data) : uploaded.extracted_data;
                const docTypeCode = checkItem.document_code || checkItem.category || '';
                const dataValidation = DataValidationService.validate(docTypeCode, extractedData);

                if (!dataValidation.passed) {
                    const validationIssue = `Data validation failed: ${dataValidation.issues.join('; ')}`;
                    const score = 7; // High severity for data validation failures
                    await ValidationModel.saveResult({
                        applicant_document_id: uploaded.id,
                        applicant_id: applicantId,
                        validation_type: 'DataValidation',
                        status: 'Fail',
                        issue_description: validationIssue,
                        sensitivity_score: score,
                        action_required: this.getActionRequired(score)
                    });
                    sensitivityScores.push(score);
                    totalFlagged++;
                }
            }

            // ----- STEP 5: Save Pass result if no issues -----
            const docValidations = await ValidationModel.getByDocument(uploaded.id);
            const hasFails = docValidations.some(v => v.status === 'Fail');

            if (!hasFails) {
                await ValidationModel.saveResult({
                    applicant_document_id: uploaded.id,
                    applicant_id: applicantId,
                    validation_type: 'Completeness',
                    status: 'Pass',
                    issue_description: null,
                    sensitivity_score: 0,
                    action_required: null
                });
                totalVerified++;
            }

            results.push({
                document_name: uploaded.document_name,
                category: uploaded.category,
                status: hasFails ? 'Flagged' : 'Verified',
                issue: hasFails ? docValidations.filter(v => v.status === 'Fail').map(v => v.issue_description).join('; ') : '—',
                sensitivity_score: hasFails ? Math.max(...docValidations.filter(v => v.status === 'Fail').map(v => v.sensitivity_score)) : 0,
                sensitivity_level: hasFails ? this.getSensitivityLevel(Math.max(...docValidations.filter(v => v.status === 'Fail').map(v => v.sensitivity_score))) : '—',
                action: hasFails ? docValidations.filter(v => v.status === 'Fail').map(v => v.action_required).join('; ') : '—'
            });
        }

        // ----- Calculate Overall Risk Score -----
        const overallRisk = sensitivityScores.length > 0
            ? parseFloat((sensitivityScores.reduce((a, b) => a + b, 0) / sensitivityScores.length).toFixed(2))
            : 0;

        // Determine status & recommendation
        const { status, recommendation } = this.determineOutcome(overallRisk, totalFlagged, applicableChecklist.length, totalVerified);

        // Save review summary
        await ValidationModel.saveReviewSummary({
            applicant_id: applicantId,
            total_required: applicableChecklist.length,
            total_uploaded: uploadedDocs.length,
            total_verified: totalVerified,
            total_flagged: totalFlagged,
            risk_score: overallRisk,
            status: status,
            recommendation: recommendation
        });

        // Update applicant status
        await ApplicantModel.updateStatus(applicantId, status, overallRisk, recommendation);

        // Log audit
        await AuditModel.log(applicantId, 'Application Validated', {
            risk_score: overallRisk,
            status,
            total_flagged: totalFlagged,
            total_verified: totalVerified
        });

        // Internal alerts for high risk
        if (overallRisk >= 7) {
            await NotificationModel.create({
                applicant_id: applicantId,
                target_type: 'Admin',
                alert_type: 'HighRiskEscalation',
                title: `High Risk Application: ${applicant.application_number}`,
                message: `Application from ${applicant.first_name} ${applicant.last_name} has risk score ${overallRisk}. Requires immediate review.`
            });
        }
        if (overallRisk >= 9) {
            await NotificationModel.create({
                applicant_id: applicantId,
                target_type: 'ProgramHead',
                alert_type: 'FraudAlert',
                title: `Critical Alert: ${applicant.application_number}`,
                message: `Possible fraud/major mismatch detected. Risk score: ${overallRisk}. Application blocked for compliance review.`
            });
        }

        return {
            applicant,
            results,
            summary: {
                total_required: applicableChecklist.length,
                total_uploaded: uploadedDocs.length,
                total_verified: totalVerified,
                total_flagged: totalFlagged,
                overall_risk_score: overallRisk,
                status,
                recommendation
            }
        };
    }

    /**
     * Format validation
     */
    static async validateFormat(document, checklistItem) {
        const allowedFormats = (checklistItem.allowed_formats || 'pdf,jpg,jpeg,png').split(',');
        const ext = (document.file_format || '').toLowerCase().replace('.', '');
        const maxSize = (checklistItem.max_file_size_mb || 5) * 1024 * 1024;

        const issues = [];
        let score = 0;

        if (!allowedFormats.includes(ext)) {
            issues.push(`Invalid format: ${ext}. Allowed: ${allowedFormats.join(', ')}`);
            score = 3;
        }

        if (document.file_size > maxSize) {
            issues.push(`File too large: ${(document.file_size / (1024 * 1024)).toFixed(2)}MB. Max: ${checklistItem.max_file_size_mb}MB`);
            score = Math.max(score, 2);
        }

        if (issues.length > 0) {
            return {
                validation_type: 'Format',
                status: 'Fail',
                issue_description: issues.join('; '),
                sensitivity_score: score,
                action_required: this.getActionRequired(score)
            };
        }

        return {
            validation_type: 'Format',
            status: 'Pass',
            issue_description: null,
            sensitivity_score: 0,
            action_required: null
        };
    }

    /**
     * Expiry validation - checks expiry date from extracted data
     */
    static async validateExpiry(document) {
        // Check if document has extracted expiry date data
        let extractedData = document.extracted_data;
        if (typeof extractedData === 'string') {
            try { extractedData = JSON.parse(extractedData); } catch (e) { extractedData = null; }
        }

        if (extractedData) {
            const expiryFields = ['expiry_date', 'date_of_expiry', 'valid_until', 'valid_till', 'expiry'];
            for (const field of expiryFields) {
                const value = extractedData[field];
                if (!value) continue;

                const parsed = DataValidationService._parseDate(value);
                if (!parsed) {
                    return {
                        validation_type: 'Expiry',
                        status: 'Fail',
                        issue_description: `Cannot parse expiry date: "${value}"`,
                        sensitivity_score: 5,
                        action_required: this.getActionRequired(5)
                    };
                }

                if (parsed < new Date()) {
                    return {
                        validation_type: 'Expiry',
                        status: 'Fail',
                        issue_description: `Document expired on ${value}`,
                        sensitivity_score: 6,
                        action_required: this.getActionRequired(6)
                    };
                }

                return {
                    validation_type: 'Expiry',
                    status: 'Pass',
                    issue_description: null,
                    sensitivity_score: 0,
                    action_required: null
                };
            }
        }

        // No expiry date found in extracted data — pass (not all documents have digital expiry data)
        return {
            validation_type: 'Expiry',
            status: 'Pass',
            issue_description: null,
            sensitivity_score: 0,
            action_required: null
        };
    }

    /**
     * Evaluate conditional document rule
     */
    static evaluateCondition(ruleJson, applicant) {
        try {
            const rule = typeof ruleJson === 'string' ? JSON.parse(ruleJson) : ruleJson;
            const fieldValue = applicant[rule.field];
            switch (rule.operator) {
                case '==': return fieldValue == rule.value;
                case '!=': return fieldValue != rule.value;
                case '>': return fieldValue > rule.value;
                case '<': return fieldValue < rule.value;
                case 'in': return Array.isArray(rule.value) && rule.value.includes(fieldValue);
                default: return true;
            }
        } catch (e) {
            return true; // Default to required if rule parsing fails
        }
    }

    /**
     * Get sensitivity level label
     */
    static getSensitivityLevel(score) {
        if (score <= 2) return 'Minor';
        if (score <= 4) return 'Low';
        if (score <= 6) return 'Medium';
        if (score <= 8) return 'High';
        return 'Critical';
    }

    /**
     * Get action required based on score
     */
    static getActionRequired(score) {
        if (score <= 2) return 'Auto-notify applicant';
        if (score <= 4) return 'Review by Admission Officer';
        if (score <= 6) return 'Hold application verification';
        if (score <= 8) return 'Escalate to Program Head';
        return 'Block & Compliance Review';
    }

    /**
     * Determine application outcome
     */
    static determineOutcome(riskScore, flagged, totalRequired, verified) {
        if (riskScore >= 9) {
            return { status: 'Escalated', recommendation: 'Block Application — Compliance Review Required' };
        }
        if (riskScore >= 7) {
            return { status: 'Escalated', recommendation: 'Escalate to Program Head — Eligibility Concern' };
        }
        if (flagged === 0 && verified === totalRequired) {
            return { status: 'Verified', recommendation: 'All documents verified — Eligible for admission' };
        }
        if (riskScore >= 5) {
            return { status: 'Pending Documents', recommendation: 'Hold Application — Await Document Re-upload' };
        }
        if (riskScore >= 3) {
            return { status: 'Conditional Approval', recommendation: 'Conditional Approval — Minor issues need resolution' };
        }
        if (flagged > 0) {
            return { status: 'Under Review', recommendation: 'Under Review — Minor formatting issues detected' };
        }
        return { status: 'Verified', recommendation: 'All documents verified — Eligible' };
    }
}

module.exports = ValidationEngine;
