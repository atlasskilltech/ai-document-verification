const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');
const V1BulkJobModel = require('../../models/v1/V1BulkJobModel');
const AIProcessingService = require('./AIProcessingService');
const DataValidationService = require('./DataValidationService');
const RuleEngineService = require('./RuleEngineService');
const WebhookService = require('./WebhookService');
const V1AuditModel = require('../../models/v1/V1AuditModel');

/**
 * Verification Processor
 * Orchestrates the full document verification pipeline:
 * 1. Fetch request from DB
 * 2. Download & analyze via AI
 * 3. Apply rule engine
 * 4. Update status
 * 5. Trigger webhooks
 */
class VerificationProcessor {
    /**
     * Process a single verification request
     */
    static async process(requestId) {
        let request;
        try {
            // 1. Fetch request
            request = await V1VerificationRequestModel.findById(requestId);
            if (!request) {
                console.error(`[VerificationProcessor] Request ${requestId} not found`);
                return;
            }

            if (request.status !== 'accepted') {
                console.log(`[VerificationProcessor] Request ${requestId} is already ${request.status}, skipping`);
                return;
            }

            // 2. Mark as processing
            await V1VerificationRequestModel.updateStatus(requestId, { status: 'processing' });

            // 3. Get document master config (user-specific first, then global)
            const docMaster = await V1DocumentMasterModel.findByCodeForUser(request.document_type, request.user_id);
            const requiredFields = docMaster?.required_fields || [];
            const validationRules = docMaster?.validation_rules || {};

            // 4. Process with AI
            const metadata = typeof request.metadata === 'string'
                ? JSON.parse(request.metadata)
                : (request.metadata || {});

            const aiResult = await AIProcessingService.verify({
                fileUrl: request.file_url,
                documentType: request.document_type,
                requiredFields,
                validationRules,
                metadata
            });

            // 5. Server-side data validation (dates, ID formats, logical checks)
            const dataValidation = DataValidationService.validate(
                request.document_type,
                aiResult.extracted_data,
                metadata
            );

            // Merge data validation results into AI result for the rule engine
            if (!dataValidation.passed) {
                aiResult.issues = [...(aiResult.issues || []), ...dataValidation.issues];
                aiResult.data_consistency = {
                    ...aiResult.data_consistency,
                    dates_valid: dataValidation.summary.dates_valid,
                    id_format_valid: dataValidation.summary.id_format_valid,
                    logical_checks_passed: dataValidation.summary.logical_checks_passed,
                    details: dataValidation.summary.details
                };
            }

            // 6. Apply rule engine (pass userId for user-scoped doc type lookup)
            const ruleResult = await RuleEngineService.validate(
                request.document_type,
                aiResult.extracted_data,
                aiResult,
                request.user_id
            );

            // Attach server-side validation details to rule result
            ruleResult.data_validation = dataValidation;

            // 7. Update request with results
            const finalStatus = ruleResult.status === 'verified' ? 'verified' : 'rejected';

            // Include document type match info in AI response for debugging
            const enrichedAiResponse = {
                ...aiResult,
                document_type_match: aiResult.document_type_match,
                detected_document_type: aiResult.detected_document_type,
                expected_document_type: aiResult.expected_document_type
            };

            await V1VerificationRequestModel.updateStatus(requestId, {
                status: finalStatus,
                confidence: ruleResult.confidence,
                riskScore: ruleResult.risk_score,
                extractedData: ruleResult.wrong_document ? {} : aiResult.extracted_data,
                aiResponse: enrichedAiResponse,
                issues: ruleResult.issues
            });

            // 8. Audit log
            const auditDetails = {
                status: finalStatus,
                confidence: ruleResult.confidence,
                risk_score: ruleResult.risk_score,
                issues_count: ruleResult.issues.length,
                is_genuine: ruleResult.is_genuine !== false
            };
            if (ruleResult.wrong_document) {
                auditDetails.wrong_document = true;
                auditDetails.detected_type = ruleResult.detected_document_type;
                auditDetails.expected_type = ruleResult.expected_document_type;
            }
            if (ruleResult.is_genuine === false) {
                auditDetails.fake_document = true;
                auditDetails.fraud_indicators = ruleResult.fraud_indicators;
            }
            if (ruleResult.authenticity_checks?.tampering_detected) {
                auditDetails.tampering_detected = true;
            }
            if (!dataValidation.passed) {
                auditDetails.data_validation_failed = true;
                auditDetails.failed_checks = dataValidation.failedChecks;
                auditDetails.validation_issues = dataValidation.issues;
            }

            let auditAction = 'document.processed';
            if (ruleResult.wrong_document) auditAction = 'document.wrong_type';
            else if (ruleResult.is_genuine === false) auditAction = 'document.fake_detected';
            else if (ruleResult.authenticity_checks?.tampering_detected) auditAction = 'document.tampering_detected';
            else if (!dataValidation.passed) auditAction = 'document.data_validation_failed';

            await V1AuditModel.log({
                userId: request.user_id,
                action: auditAction,
                resourceType: 'verification_request',
                resourceId: request.system_reference_id,
                details: auditDetails
            });

            // 9. Trigger webhooks
            const updatedRequest = await V1VerificationRequestModel.findBySystemRefId(request.system_reference_id);
            const webhookEvent = finalStatus === 'verified' ? 'document.verified' : 'document.rejected';
            WebhookService.trigger(request.user_id, webhookEvent, {
                ...updatedRequest,
                wrong_document: ruleResult.wrong_document || false,
                detected_document_type: ruleResult.detected_document_type || null,
                is_genuine: ruleResult.is_genuine !== false,
                authenticity_checks: ruleResult.authenticity_checks || {},
                fraud_indicators: ruleResult.fraud_indicators || []
            }).catch(err => {
                console.error('[VerificationProcessor] Webhook trigger error:', err.message);
            });

            console.log(`[VerificationProcessor] Request ${request.system_reference_id} completed: ${finalStatus} (confidence: ${ruleResult.confidence}%)`);

            // 10. If part of a bulk job, update progress
            await this._updateBulkProgress(requestId);

        } catch (error) {
            console.error(`[VerificationProcessor] Error processing request ${requestId}:`, error.message);

            // Update status to failed
            try {
                await V1VerificationRequestModel.updateStatus(requestId, {
                    status: 'failed',
                    issues: [error.message]
                });

                if (request) {
                    // Trigger failure webhook
                    const failedRequest = await V1VerificationRequestModel.findBySystemRefId(request.system_reference_id);
                    WebhookService.trigger(request.user_id, 'document.failed', failedRequest).catch(() => {});

                    await V1AuditModel.log({
                        userId: request.user_id,
                        action: 'document.failed',
                        resourceType: 'verification_request',
                        resourceId: request.system_reference_id,
                        details: { error: error.message }
                    });

                    // Update bulk progress on failure too
                    await this._updateBulkProgress(requestId);
                }
            } catch (updateErr) {
                console.error('[VerificationProcessor] Failed to update error status:', updateErr.message);
            }
        }
    }

    /**
     * Check if this request is part of a bulk job and update its progress
     */
    static async _updateBulkProgress(requestId) {
        try {
            const pool = require('../../config/database');
            const [links] = await pool.query(
                'SELECT bulk_job_id FROM v1_bulk_job_items WHERE verification_request_id = ?',
                [requestId]
            );
            if (links.length > 0) {
                const updatedJob = await V1BulkJobModel.updateProgress(links[0].bulk_job_id);
                if (updatedJob && ['completed', 'partial', 'failed'].includes(updatedJob.status)) {
                    console.log(`[VerificationProcessor] Bulk job ${updatedJob.bulk_id || links[0].bulk_job_id} finished: ${updatedJob.status}`);
                    // Trigger bulk completion webhook
                    const job = await V1BulkJobModel.findById(links[0].bulk_job_id);
                    if (job) {
                        WebhookService.trigger(job.user_id, 'bulk.completed', {
                            bulk_id: job.bulk_id,
                            status: updatedJob.status,
                            total: job.total_documents,
                            verified: updatedJob.verified,
                            rejected: updatedJob.rejected,
                            failed: updatedJob.failed
                        }).catch(() => {});
                    }
                }
            }
        } catch (err) {
            // Non-critical, log and continue
            console.error('[VerificationProcessor] Bulk progress update error:', err.message);
        }
    }
}

module.exports = VerificationProcessor;
