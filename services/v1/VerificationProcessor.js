const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');
const V1DocumentMasterModel = require('../../models/v1/V1DocumentMasterModel');
const AIProcessingService = require('./AIProcessingService');
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

            // 3. Get document master config
            const docMaster = await V1DocumentMasterModel.findByCode(request.document_type);
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

            // 5. Apply rule engine
            const ruleResult = await RuleEngineService.validate(
                request.document_type,
                aiResult.extracted_data,
                aiResult
            );

            // 6. Update request with results
            const finalStatus = ruleResult.status === 'verified' ? 'verified' : 'rejected';
            await V1VerificationRequestModel.updateStatus(requestId, {
                status: finalStatus,
                confidence: ruleResult.confidence,
                riskScore: ruleResult.risk_score,
                extractedData: aiResult.extracted_data,
                aiResponse: aiResult,
                issues: ruleResult.issues
            });

            // 7. Audit log
            await V1AuditModel.log({
                userId: request.user_id,
                action: 'document.processed',
                resourceType: 'verification_request',
                resourceId: request.system_reference_id,
                details: {
                    status: finalStatus,
                    confidence: ruleResult.confidence,
                    risk_score: ruleResult.risk_score,
                    issues_count: ruleResult.issues.length
                }
            });

            // 8. Trigger webhooks
            const updatedRequest = await V1VerificationRequestModel.findBySystemRefId(request.system_reference_id);
            const webhookEvent = finalStatus === 'verified' ? 'document.verified' : 'document.rejected';
            WebhookService.trigger(request.user_id, webhookEvent, updatedRequest).catch(err => {
                console.error('[VerificationProcessor] Webhook trigger error:', err.message);
            });

            console.log(`[VerificationProcessor] Request ${request.system_reference_id} completed: ${finalStatus} (confidence: ${ruleResult.confidence}%)`);

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
                }
            } catch (updateErr) {
                console.error('[VerificationProcessor] Failed to update error status:', updateErr.message);
            }
        }
    }
}

module.exports = VerificationProcessor;
