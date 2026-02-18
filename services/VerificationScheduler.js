const cron = require('node-cron');
const AtlasApiClient = require('./AtlasApiClient');
const DocumentVerificationService = require('./DocumentVerificationService');

class VerificationScheduler {

    constructor() {
        this.atlasClient = new AtlasApiClient();
        this.verificationService = new DocumentVerificationService();
        this.cronJob = null;
        this.isRunning = false;
        this.shouldStop = false;

        // Configuration
        this.config = {
            cronSchedule: process.env.VERIFICATION_CRON || '0 */2 * * *', // every 2 hours
            concurrency: parseInt(process.env.VERIFICATION_CONCURRENCY) || 2,
            retryAttempts: parseInt(process.env.VERIFICATION_RETRY_ATTEMPTS) || 3,
            retryDelayMs: parseInt(process.env.VERIFICATION_RETRY_DELAY_MS) || 2000,
            delayBetweenStudentsMs: parseInt(process.env.VERIFICATION_STUDENT_DELAY_MS) || 1000,
            delayBetweenDocsMs: parseInt(process.env.VERIFICATION_DOC_DELAY_MS) || 500,
            skipAlreadyVerified: process.env.VERIFICATION_SKIP_VERIFIED !== 'false',
            autoStart: process.env.VERIFICATION_AUTO_START === 'true'
        };

        // State tracking
        this.currentRun = null;
        this.runs = [];      // history of completed runs (keep last 50)
        this.logs = [];       // rolling log buffer (keep last 500)
        this.maxLogs = 500;
        this.maxRuns = 50;
    }

    // ===================== LOGGING =====================

    log(level, message, data = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data
        };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }
        const prefix = `[Verification ${level.toUpperCase()}]`;
        if (level === 'error') {
            console.error(prefix, message, data || '');
        } else {
            console.log(prefix, message, data ? JSON.stringify(data).substring(0, 200) : '');
        }
    }

    // ===================== RETRY LOGIC =====================

    async withRetry(fn, label) {
        let lastError;
        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                if (attempt < this.config.retryAttempts) {
                    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
                    this.log('warn', `${label} failed (attempt ${attempt}/${this.config.retryAttempts}), retrying in ${delay}ms: ${err.message}`);
                    await this.sleep(delay);
                }
            }
        }
        throw lastError;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ===================== SINGLE DOCUMENT VERIFICATION =====================

    async verifyDocument(doc) {
        return this.withRetry(async () => {
            const { buffer, contentType } = await this.atlasClient.downloadDocument(doc.file_url);
            const result = await this.verificationService.verify(buffer, {
                filename: doc.filename,
                contentType,
                document_label: doc.document_label,
                document_type_name: doc.document_type_name,
                document_description: doc.document_description
            });
            return result;
        }, `Verify ${doc.document_label}`);
    }

    // ===================== SINGLE STUDENT PROCESSING =====================

    async processStudent(applnID, studentName) {
        const studentResult = {
            applnID,
            studentName: studentName || applnID,
            status: 'processing',
            startTime: new Date().toISOString(),
            endTime: null,
            totalDocs: 0,
            approved: 0,
            rejected: 0,
            errors: 0,
            skipped: 0,
            documents: []
        };

        try {
            // Fetch document list
            const docListResponse = await this.withRetry(
                () => this.atlasClient.getDocumentList(applnID),
                `Fetch docs for ${applnID}`
            );

            if (docListResponse.status !== 1 || !docListResponse.data?.document_status) {
                studentResult.status = 'skipped';
                studentResult.endTime = new Date().toISOString();
                this.log('warn', `Student ${applnID}: No document list returned`);
                return studentResult;
            }

            const allDocs = docListResponse.data.document_status;
            let uploadedDocs = allDocs.filter(doc => doc.file_url && doc.file_url.trim() !== '');

            // Skip already verified if configured
            if (this.config.skipAlreadyVerified) {
                uploadedDocs = uploadedDocs.filter(doc => doc.verify_status !== '2');
            }

            studentResult.totalDocs = uploadedDocs.length;

            if (uploadedDocs.length === 0) {
                studentResult.status = 'skipped';
                studentResult.endTime = new Date().toISOString();
                this.log('info', `Student ${applnID}: No documents to verify`);
                return studentResult;
            }

            const statusUpdates = [];

            // Process documents with concurrency control
            const chunks = this.chunkArray(uploadedDocs, this.config.concurrency);

            for (const chunk of chunks) {
                if (this.shouldStop) {
                    this.log('info', `Stopping mid-student ${applnID}`);
                    break;
                }

                const results = await Promise.allSettled(
                    chunk.map(doc => this.verifyDocument(doc))
                );

                for (let i = 0; i < chunk.length; i++) {
                    const doc = chunk[i];
                    const result = results[i];

                    if (result.status === 'fulfilled') {
                        const verification = result.value;
                        const aiStatus = verification.status === 'approve' ? 'Verified' : 'reject';

                        statusUpdates.push({
                            document_type_id: doc.document_type_id,
                            doc_ai_status: aiStatus,
                            doc_ai_remark: verification.remark
                        });

                        studentResult.documents.push({
                            document_type_id: doc.document_type_id,
                            document_label: doc.document_label,
                            filename: doc.filename,
                            ai_status: aiStatus,
                            confidence: verification.confidence,
                            remark: verification.remark
                        });

                        if (aiStatus === 'Verified') {
                            studentResult.approved++;
                        } else {
                            studentResult.rejected++;
                        }

                        this.log('info', `${applnID} - ${doc.document_label}: ${aiStatus} (${(verification.confidence * 100).toFixed(0)}%)`, {
                            remark: verification.remark
                        });
                    } else {
                        studentResult.errors++;
                        const errMsg = result.reason?.message || 'Unknown error';

                        statusUpdates.push({
                            document_type_id: doc.document_type_id,
                            doc_ai_status: 'error',
                            doc_ai_remark: `Verification failed: ${errMsg}`
                        });

                        studentResult.documents.push({
                            document_type_id: doc.document_type_id,
                            document_label: doc.document_label,
                            filename: doc.filename,
                            ai_status: 'error',
                            confidence: 0,
                            remark: errMsg
                        });

                        this.log('error', `${applnID} - ${doc.document_label}: Error`, { error: errMsg });
                    }
                }

                // Delay between document batches
                if (chunks.indexOf(chunk) < chunks.length - 1) {
                    await this.sleep(this.config.delayBetweenDocsMs);
                }
            }

            // Post status update back to Atlas API
            if (statusUpdates.length > 0 && !this.shouldStop) {
                try {
                    await this.withRetry(
                        () => this.atlasClient.updateDocumentStatus(applnID, statusUpdates),
                        `Update status for ${applnID}`
                    );
                    this.log('info', `${applnID}: Status updated (${statusUpdates.length} documents)`);
                } catch (updateErr) {
                    this.log('error', `${applnID}: Failed to update status`, { error: updateErr.message });
                }
            }

            studentResult.status = studentResult.errors > 0 ? 'partial' : 'completed';

        } catch (err) {
            studentResult.status = 'error';
            this.log('error', `Student ${applnID}: Processing failed`, { error: err.message });
        }

        studentResult.endTime = new Date().toISOString();
        return studentResult;
    }

    // ===================== FULL BATCH RUN =====================

    async runBatch() {
        if (this.isRunning) {
            this.log('warn', 'Batch already running, skipping');
            return null;
        }

        this.isRunning = true;
        this.shouldStop = false;

        this.currentRun = {
            id: Date.now().toString(36),
            startTime: new Date().toISOString(),
            endTime: null,
            status: 'running',
            totalStudents: 0,
            processed: 0,
            completed: 0,
            skipped: 0,
            errors: 0,
            totalDocsVerified: 0,
            totalApproved: 0,
            totalRejected: 0,
            students: []
        };

        this.log('info', '========== BATCH VERIFICATION STARTED ==========');

        try {
            // Fetch student list
            const studentListResponse = await this.withRetry(
                () => this.atlasClient.getStudentList(),
                'Fetch student list'
            );

            if (!studentListResponse || !studentListResponse.data) {
                this.log('error', 'Failed to fetch student list');
                this.currentRun.status = 'error';
                this.currentRun.endTime = new Date().toISOString();
                this.finishRun();
                return this.currentRun;
            }

            const students = Array.isArray(studentListResponse.data)
                ? studentListResponse.data
                : [studentListResponse.data];

            this.currentRun.totalStudents = students.length;
            this.log('info', `Found ${students.length} students to process`);

            // Process each student
            for (const student of students) {
                if (this.shouldStop) {
                    this.log('info', 'Batch stopped by user');
                    this.currentRun.status = 'stopped';
                    break;
                }

                const applnID = student.applnID || student.id || student.application_id;
                if (!applnID) continue;

                const studentName = [student.first_name, student.last_name].filter(Boolean).join(' ')
                    || student.name || applnID;

                this.log('info', `Processing student ${this.currentRun.processed + 1}/${students.length}: ${applnID} (${studentName})`);

                const result = await this.processStudent(applnID, studentName);
                this.currentRun.students.push(result);
                this.currentRun.processed++;

                if (result.status === 'completed' || result.status === 'partial') {
                    this.currentRun.completed++;
                    this.currentRun.totalDocsVerified += result.totalDocs;
                    this.currentRun.totalApproved += result.approved;
                    this.currentRun.totalRejected += result.rejected;
                } else if (result.status === 'skipped') {
                    this.currentRun.skipped++;
                } else {
                    this.currentRun.errors++;
                }

                // Delay between students
                if (!this.shouldStop) {
                    await this.sleep(this.config.delayBetweenStudentsMs);
                }
            }

            if (this.currentRun.status === 'running') {
                this.currentRun.status = 'completed';
            }

        } catch (err) {
            this.log('error', 'Batch run failed', { error: err.message });
            this.currentRun.status = 'error';
        }

        this.currentRun.endTime = new Date().toISOString();
        this.log('info', `========== BATCH FINISHED: ${this.currentRun.status} ==========`, {
            processed: this.currentRun.processed,
            completed: this.currentRun.completed,
            approved: this.currentRun.totalApproved,
            rejected: this.currentRun.totalRejected
        });

        this.finishRun();
        return this.currentRun;
    }

    finishRun() {
        this.isRunning = false;
        if (this.currentRun) {
            this.runs.push({ ...this.currentRun, students: undefined }); // store summary only
            if (this.runs.length > this.maxRuns) {
                this.runs = this.runs.slice(-this.maxRuns);
            }
        }
    }

    // ===================== VERIFY SINGLE STUDENT (on-demand) =====================

    async verifySingleStudent(applnID) {
        if (this.isRunning) {
            throw new Error('A batch job is currently running. Wait for it to finish or stop it first.');
        }

        this.isRunning = true;
        this.shouldStop = false;

        this.currentRun = {
            id: Date.now().toString(36),
            startTime: new Date().toISOString(),
            endTime: null,
            status: 'running',
            totalStudents: 1,
            processed: 0,
            completed: 0,
            skipped: 0,
            errors: 0,
            totalDocsVerified: 0,
            totalApproved: 0,
            totalRejected: 0,
            students: []
        };

        this.log('info', `========== SINGLE STUDENT VERIFICATION: ${applnID} ==========`);

        const result = await this.processStudent(applnID, applnID);
        this.currentRun.students.push(result);
        this.currentRun.processed = 1;

        if (result.status === 'completed' || result.status === 'partial') {
            this.currentRun.completed = 1;
            this.currentRun.totalDocsVerified = result.totalDocs;
            this.currentRun.totalApproved = result.approved;
            this.currentRun.totalRejected = result.rejected;
        } else if (result.status === 'skipped') {
            this.currentRun.skipped = 1;
        } else {
            this.currentRun.errors = 1;
        }

        this.currentRun.status = 'completed';
        this.currentRun.endTime = new Date().toISOString();
        this.finishRun();

        return this.currentRun;
    }

    // ===================== CRON SCHEDULER =====================

    startScheduler() {
        if (this.cronJob) {
            this.log('warn', 'Scheduler already running');
            return;
        }

        const schedule = this.config.cronSchedule;
        if (!cron.validate(schedule)) {
            this.log('error', `Invalid cron schedule: ${schedule}`);
            return;
        }

        this.cronJob = cron.schedule(schedule, async () => {
            this.log('info', 'Cron triggered - starting batch verification');
            await this.runBatch();
        });

        this.log('info', `Scheduler started with cron: ${schedule}`);
    }

    stopScheduler() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
            this.log('info', 'Scheduler stopped');
        }

        // Also signal running batch to stop
        if (this.isRunning) {
            this.shouldStop = true;
            this.log('info', 'Stop signal sent to running batch');
        }
    }

    // ===================== STATUS / GETTERS =====================

    getStatus() {
        return {
            scheduler: {
                active: this.cronJob !== null,
                cronSchedule: this.config.cronSchedule,
                autoStart: this.config.autoStart
            },
            engine: {
                isRunning: this.isRunning,
                provider: this.verificationService.provider,
                concurrency: this.config.concurrency,
                retryAttempts: this.config.retryAttempts,
                skipAlreadyVerified: this.config.skipAlreadyVerified
            },
            currentRun: this.currentRun ? {
                id: this.currentRun.id,
                status: this.currentRun.status,
                startTime: this.currentRun.startTime,
                endTime: this.currentRun.endTime,
                totalStudents: this.currentRun.totalStudents,
                processed: this.currentRun.processed,
                completed: this.currentRun.completed,
                skipped: this.currentRun.skipped,
                errors: this.currentRun.errors,
                totalDocsVerified: this.currentRun.totalDocsVerified,
                totalApproved: this.currentRun.totalApproved,
                totalRejected: this.currentRun.totalRejected
            } : null,
            recentRuns: this.runs.slice(-10).reverse()
        };
    }

    getRunDetail(runId) {
        if (this.currentRun && this.currentRun.id === runId) {
            return this.currentRun;
        }
        return this.runs.find(r => r.id === runId) || null;
    }

    getLogs(limit = 100) {
        return this.logs.slice(-limit);
    }

    getConfig() {
        return { ...this.config };
    }

    updateConfig(updates) {
        const allowed = [
            'cronSchedule', 'concurrency', 'retryAttempts', 'retryDelayMs',
            'delayBetweenStudentsMs', 'delayBetweenDocsMs', 'skipAlreadyVerified'
        ];
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                this.config[key] = updates[key];
            }
        }
        // Restart scheduler if cron schedule changed and scheduler is active
        if (updates.cronSchedule && this.cronJob) {
            this.stopScheduler();
            this.startScheduler();
        }
        this.log('info', 'Configuration updated', updates);
        return this.config;
    }

    // ===================== HELPERS =====================

    chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }

    // ===================== INIT (called from server.js) =====================

    init() {
        this.log('info', 'Verification Scheduler initialized', {
            provider: this.verificationService.provider,
            cron: this.config.cronSchedule,
            autoStart: this.config.autoStart
        });

        if (this.config.autoStart) {
            this.startScheduler();
            // Run first batch immediately on startup
            this.log('info', 'Auto-start enabled - running initial batch in 10 seconds');
            setTimeout(() => this.runBatch(), 10000);
        }
    }
}

// Singleton instance
const scheduler = new VerificationScheduler();
module.exports = scheduler;
