const V1VerificationRequestModel = require('../../models/v1/V1VerificationRequestModel');

/**
 * In-memory queue service for processing verification requests.
 * Uses a simple FIFO queue with configurable concurrency.
 * Can be replaced with Redis/Bull for production scalability.
 */
class QueueService {
    constructor() {
        this.queue = [];
        this.processing = new Set();
        this.concurrency = parseInt(process.env.V1_QUEUE_CONCURRENCY) || 3;
        this.isRunning = false;
        this.pollInterval = null;
        this.pollIntervalMs = parseInt(process.env.V1_QUEUE_POLL_MS) || 2000;
        this.handlers = new Map();
    }

    /**
     * Register a handler for a specific job type
     */
    onJob(type, handler) {
        this.handlers.set(type, handler);
    }

    /**
     * Add a job to the queue
     */
    async addJob(type, data) {
        const job = {
            id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type,
            data,
            createdAt: new Date(),
            attempts: 0,
            maxAttempts: 3,
        };
        this.queue.push(job);
        this.processNext();
        return job.id;
    }

    /**
     * Process the next available job(s) up to concurrency limit
     */
    async processNext() {
        while (this.processing.size < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            if (!job) break;

            this.processing.add(job.id);
            this._executeJob(job).finally(() => {
                this.processing.delete(job.id);
                // Check if there are more jobs to process
                if (this.queue.length > 0) {
                    this.processNext();
                }
            });
        }
    }

    async _executeJob(job) {
        const handler = this.handlers.get(job.type);
        if (!handler) {
            console.error(`[QueueService] No handler for job type: ${job.type}`);
            return;
        }

        job.attempts++;
        try {
            await handler(job.data);
        } catch (error) {
            console.error(`[QueueService] Job ${job.id} failed (attempt ${job.attempts}):`, error.message);
            if (job.attempts < job.maxAttempts) {
                // Re-queue with exponential backoff
                const delay = Math.pow(2, job.attempts) * 1000;
                setTimeout(() => {
                    this.queue.push(job);
                    this.processNext();
                }, delay);
            } else {
                console.error(`[QueueService] Job ${job.id} permanently failed after ${job.maxAttempts} attempts`);
                // Update request status to failed if it's a verification job
                if (job.data && job.data.requestId) {
                    try {
                        await V1VerificationRequestModel.updateStatus(job.data.requestId, {
                            status: 'failed',
                            issues: ['Processing failed after maximum retry attempts: ' + error.message]
                        });
                    } catch (updateErr) {
                        console.error('[QueueService] Failed to update request status:', updateErr.message);
                    }
                }
            }
        }
    }

    /**
     * Start polling for pending requests in the database
     */
    startPolling() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[QueueService] Started polling every ${this.pollIntervalMs}ms`);

        this.pollInterval = setInterval(async () => {
            try {
                const pending = await V1VerificationRequestModel.getPending(this.concurrency);
                for (const request of pending) {
                    // Only queue if not already processing
                    const isQueued = this.queue.some(j => j.data?.requestId === request.id);
                    const isProcessing = [...this.processing].some(id => id.includes(request.id));
                    if (!isQueued && !isProcessing) {
                        await this.addJob('verify_document', { requestId: request.id });
                    }
                }
            } catch (error) {
                console.error('[QueueService] Polling error:', error.message);
            }
        }, this.pollIntervalMs);
    }

    /**
     * Stop polling
     */
    stopPolling() {
        this.isRunning = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        console.log('[QueueService] Stopped polling');
    }

    /**
     * Get queue status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            queueLength: this.queue.length,
            activeJobs: this.processing.size,
            concurrency: this.concurrency
        };
    }
}

// Singleton
module.exports = new QueueService();
