const axios = require('axios');
const crypto = require('crypto');
const V1WebhookModel = require('../../models/v1/V1WebhookModel');

/**
 * Webhook Service
 * Delivers webhook notifications for verification events with signed payloads.
 */
class WebhookService {
    /**
     * Sign a webhook payload using HMAC-SHA256
     */
    static signPayload(payload, secret) {
        const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return crypto
            .createHmac('sha256', secret)
            .update(payloadString)
            .digest('hex');
    }

    /**
     * Trigger webhooks for a verification event
     */
    static async trigger(userId, event, verificationRequest) {
        const webhooks = await V1WebhookModel.getActiveForEvent(userId, event);
        if (webhooks.length === 0) return;

        const payload = {
            event,
            reference_id: verificationRequest.system_reference_id,
            client_reference_id: verificationRequest.client_reference_id,
            document_type: verificationRequest.document_type,
            status: verificationRequest.status,
            confidence: verificationRequest.confidence,
            risk_score: verificationRequest.risk_score,
            timestamp: new Date().toISOString()
        };

        const deliveryPromises = webhooks.map(webhook => this._deliver(webhook, verificationRequest.id, event, payload));
        await Promise.allSettled(deliveryPromises);
    }

    /**
     * Deliver a single webhook
     */
    static async _deliver(webhook, verificationRequestId, event, payload) {
        const payloadStr = JSON.stringify(payload);
        const signature = this.signPayload(payloadStr, webhook.secret);

        try {
            const response = await axios.post(webhook.url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Event': event,
                    'X-Webhook-Timestamp': new Date().toISOString(),
                    'User-Agent': 'DocumentVerificationPlatform/1.0'
                },
                timeout: 10000,
                validateStatus: () => true // Accept any status code
            });

            const success = response.status >= 200 && response.status < 300;
            const responseBody = typeof response.data === 'string'
                ? response.data.substring(0, 1000)
                : JSON.stringify(response.data).substring(0, 1000);

            await V1WebhookModel.recordDelivery(
                webhook.id,
                verificationRequestId,
                event,
                payload,
                response.status,
                responseBody,
                success ? 'delivered' : 'failed'
            );

            if (success) {
                await V1WebhookModel.resetFailureCount(webhook.id);
            } else {
                await V1WebhookModel.incrementFailureCount(webhook.id);
            }
        } catch (error) {
            await V1WebhookModel.recordDelivery(
                webhook.id,
                verificationRequestId,
                event,
                payload,
                null,
                error.message,
                'failed'
            );
            await V1WebhookModel.incrementFailureCount(webhook.id);
        }
    }
}

module.exports = WebhookService;
