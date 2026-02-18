const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../../middleware/v1/apiKeyAuth');
const V1WebhookModel = require('../../models/v1/V1WebhookModel');
const V1AuditModel = require('../../models/v1/V1AuditModel');

// All routes require API key authentication
router.use(apiKeyAuth);

// ==========================================
// POST /v1/webhook/register - Register a webhook
// ==========================================
router.post('/register', async (req, res) => {
    try {
        const { url, events } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'Bad request', message: 'Webhook URL is required' });
        }

        // Basic URL validation
        try {
            new URL(url);
        } catch {
            return res.status(400).json({ error: 'Bad request', message: 'Invalid webhook URL' });
        }

        // Validate events
        const validEvents = ['document.verified', 'document.rejected', 'document.failed'];
        if (events) {
            const invalidEvents = events.filter(e => !validEvents.includes(e));
            if (invalidEvents.length > 0) {
                return res.status(400).json({
                    error: 'Bad request',
                    message: `Invalid events: ${invalidEvents.join(', ')}. Valid events: ${validEvents.join(', ')}`
                });
            }
        }

        const result = await V1WebhookModel.create({
            userId: req.apiUser.userId,
            url,
            events: events || validEvents
        });

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'webhook.registered',
            resourceType: 'webhook',
            resourceId: String(result.id),
            details: { url, events },
            ipAddress: req.ip
        });

        res.status(201).json({
            success: true,
            message: 'Webhook registered successfully',
            data: {
                id: result.id,
                url,
                events: events || validEvents,
                secret: result.secret
            }
        });
    } catch (error) {
        console.error('Webhook register error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to register webhook' });
    }
});

// ==========================================
// GET /v1/webhook - List user's webhooks
// ==========================================
router.get('/', async (req, res) => {
    try {
        const webhooks = await V1WebhookModel.getByUserId(req.apiUser.userId);
        res.json({ success: true, data: webhooks });
    } catch (error) {
        console.error('List webhooks error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to list webhooks' });
    }
});

// ==========================================
// PUT /v1/webhook/:id - Update webhook
// ==========================================
router.put('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { url, events, is_active } = req.body;

        const webhook = await V1WebhookModel.findById(id);
        if (!webhook || webhook.user_id !== req.apiUser.userId) {
            return res.status(404).json({ error: 'Not found', message: 'Webhook not found' });
        }

        await V1WebhookModel.update(id, req.apiUser.userId, { url, events, isActive: is_active });

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'webhook.updated',
            resourceType: 'webhook',
            resourceId: String(id),
            details: req.body,
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Webhook updated' });
    } catch (error) {
        console.error('Update webhook error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to update webhook' });
    }
});

// ==========================================
// DELETE /v1/webhook/:id - Delete webhook
// ==========================================
router.delete('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const deleted = await V1WebhookModel.delete(id, req.apiUser.userId);
        if (!deleted) {
            return res.status(404).json({ error: 'Not found', message: 'Webhook not found' });
        }

        await V1AuditModel.log({
            userId: req.apiUser.userId,
            action: 'webhook.deleted',
            resourceType: 'webhook',
            resourceId: String(id),
            ipAddress: req.ip
        });

        res.json({ success: true, message: 'Webhook deleted' });
    } catch (error) {
        console.error('Delete webhook error:', error);
        res.status(500).json({ error: 'Internal server error', message: 'Failed to delete webhook' });
    }
});

module.exports = router;
