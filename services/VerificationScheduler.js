const cron = require('node-cron');
const AtlasApiClient = require('./AtlasApiClient');
const DocumentVerificationService = require('./DocumentVerificationService');
const AtlasVerificationModel = require('../models/AtlasVerificationModel');

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
            autoStart: process.env.VERIFICATION_AUTO_START !== 'false', // auto-start by default
            autoWatchIntervalMs: parseInt(process.env.VERIFICATION_AUTO_WATCH_INTERVAL_MS) || 5 * 60 * 1000 // poll every 5 minutes
        };

        // Auto-watch state
        this.autoWatchTimer = null;
        this.autoWatchRunning = false;

        // State tracking
        this.currentRun = null;
        this.runs = [];      // history of completed runs (keep last 50)
        this.logs = [];       // rolling log buffer (keep last 500)
        this.maxLogs = 500;
        this.maxRuns = 50;

        // Persistent student results store: { applnID -> { student data + documents + verification } }
        this.studentResults = new Map();

        // Parallel recheck tracking
        // activeRechecks tracks individual recheck operations that can run in parallel
        // Only batch jobs use the isRunning flag to block everything
        this.activeRechecks = new Map(); // recheckId -> { type, applnID, documentTypeId?, startTime }
        this.maxParallelRechecks = parseInt(process.env.RECHECK_MAX_PARALLEL) || 5;
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
                // Don't retry on quota/billing errors (429) or auth errors (401/403)
                const errMsg = err.message || '';
                if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('401') || errMsg.includes('403')) {
                    this.log('error', `${label} failed with non-retryable error: ${errMsg}`);
                    throw err;
                }
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

    /**
     * Normalize document fields from Atlas API response.
     * The API may return file URL under different field names (file_url, doc_file_url,
     * doc_upload_file_url, document_url). This ensures consistent field names throughout.
     * Also normalizes verify_status and document_type_id to consistent types.
     */
    normalizeDocFields(doc) {
        const normalized = { ...doc };

        // Normalize file_url - check multiple possible field names from Atlas API
        if (!normalized.file_url || !String(normalized.file_url).trim()) {
            normalized.file_url = doc.doc_file_url || doc.doc_upload_file_url || doc.document_url || doc.upload_url || null;
        }
        // Ensure file_url is a trimmed string or null
        if (normalized.file_url) {
            normalized.file_url = String(normalized.file_url).trim() || null;
        }

        // Normalize filename - check alternative field names
        if (!normalized.filename) {
            normalized.filename = doc.doc_upload_file_name || doc.file_name || doc.document_filename || null;
        }

        // Normalize verify_status to string for consistent comparison
        if (normalized.verify_status !== null && normalized.verify_status !== undefined) {
            normalized.verify_status = String(normalized.verify_status);
        }

        // Normalize document_type_id to string for consistent comparison
        if (normalized.document_type_id !== null && normalized.document_type_id !== undefined) {
            normalized.document_type_id = String(normalized.document_type_id);
        }

        return normalized;
    }

    // ===================== SINGLE DOCUMENT VERIFICATION =====================

    async verifyDocument(doc) {
        // Skip documents that have no file uploaded (file_url already normalized by normalizeDocFields)
        if (!doc.file_url) {
            this.log('info', `Skipping ${doc.document_label}: No file uploaded`);
            return {
                status: 'skip',
                confidence: 0,
                remark: 'Document not uploaded',
                issues: ['No file uploaded'],
                extracted_data: {}
            };
        }

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

    async processStudent(applnID, studentName, { forceRecheck = false } = {}) {
        const studentResult = {
            applnID,
            studentName: studentName || applnID,
            status: 'processing',
            startTime: new Date().toISOString(),
            endTime: null,
            totalDocs: 0,
            uploaded: 0,
            approved: 0,
            rejected: 0,
            errors: 0,
            allDocuments: [],     // ALL documents (uploaded + not uploaded)
            documents: []         // only verified documents with AI results
        };

        try {
            // Fetch document list
            const docListResponse = await this.withRetry(
                () => this.atlasClient.getDocumentList(applnID),
                `Fetch docs for ${applnID}`
            );

            if (docListResponse.status !== 1 || !docListResponse.data?.document_status) {
                studentResult.status = 'pending';
                studentResult.endTime = new Date().toISOString();
                this.log('warn', `Student ${applnID}: No document list returned`);

                // Preserve existing AI results from DB
                try {
                    const existing = await AtlasVerificationModel.getStudentResult(String(applnID));
                    if (existing && existing.documents && existing.documents.length > 0) {
                        studentResult.allDocuments = existing.allDocuments || [];
                        studentResult.documents = existing.documents;
                        studentResult.approved = existing.approved || 0;
                        studentResult.rejected = existing.rejected || 0;
                        studentResult.totalDocs = existing.totalDocs || 0;
                        studentResult.uploaded = existing.uploaded || 0;
                        studentResult.status = existing.status;
                        this.log('info', `Student ${applnID}: Preserved existing AI results`);
                    }
                } catch (e) {
                    this.log('warn', `Student ${applnID}: Could not load existing results: ${e.message}`);
                }

                this.studentResults.set(String(applnID), studentResult);
                try { await AtlasVerificationModel.upsertStudentResult(studentResult); } catch (e) {}
                return studentResult;
            }

            const rawDocs = docListResponse.data.document_status;

            // Debug: log raw API fields for first doc to identify response structure
            if (rawDocs.length > 0) {
                this.log('info', `Student ${applnID}: API doc fields: ${Object.keys(rawDocs[0]).join(', ')}`);
                this.log('info', `Student ${applnID}: First doc RAW: ${JSON.stringify(rawDocs[0])}`);
            }

            // Normalize all document fields for consistent access
            const allDocs = rawDocs.map(doc => this.normalizeDocFields(doc));

            // Store ALL documents (uploaded and not uploaded) for display
            studentResult.allDocuments = allDocs.map(doc => ({
                document_type_id: doc.document_type_id,
                document_type_name: doc.document_type_name,
                document_label: doc.document_label,
                document_description: doc.document_description,
                is_required: doc.document_is_required === '1' || doc.document_is_required === 1,
                is_uploaded: !!doc.file_url,
                filename: doc.filename || null,
                file_url: doc.file_url || null,
                verify_status: doc.verify_status,
                doc_upload_id: doc.doc_upload_id,
                ai_status: null,
                confidence: null,
                remark: null,
                issues: null,
                extracted_data: null
            }));

            let uploadedDocs = allDocs.filter(doc => !!doc.file_url);
            studentResult.uploaded = uploadedDocs.length;

            // Load existing AI results to determine which docs need re-verification
            let existingDocsMap = {};
            try {
                const existing = await AtlasVerificationModel.getStudentResult(String(applnID));
                if (existing && existing.documents) {
                    existing.documents.forEach(d => { existingDocsMap[String(d.document_type_id)] = d; });
                }
            } catch (e) {
                this.log('warn', `Student ${applnID}: Could not load existing results for recheck: ${e.message}`);
            }

            // Verify documents that are either pending (verify_status 0/null) OR have no ai_status yet
            // When forceRecheck is true, re-verify only rejected/error/empty docs - skip already Verified
            if (!forceRecheck) {
                uploadedDocs = uploadedDocs.filter(doc => {
                    const vs = doc.verify_status;
                    const isPending = !vs || vs === '0' || vs === 'null' || vs === 'undefined';
                    // Also include docs that have no AI verification yet
                    const prev = existingDocsMap[String(doc.document_type_id)];
                    const hasNoAiStatus = !prev || !prev.ai_status;
                    return isPending || hasNoAiStatus;
                });
            } else {
                // Only recheck docs with empty/null ai_status - preserve all others (Verified, reject, error)
                const beforeCount = uploadedDocs.length;
                uploadedDocs = uploadedDocs.filter(doc => {
                    const prev = existingDocsMap[String(doc.document_type_id)];
                    if (prev && prev.ai_status) {
                        return false; // Skip docs that already have an ai_status (Verified, reject, error)
                    }
                    return true; // Only recheck docs with empty/null ai_status
                });

                // Preserve docs that already have ai_status in the student result (with dedup)
                Object.values(existingDocsMap).forEach(prev => {
                    if (prev.ai_status) {
                        // Dedup: replace if exists, push if new
                        const existIdx = studentResult.documents.findIndex(
                            d => String(d.document_type_id) === String(prev.document_type_id)
                        );
                        if (existIdx >= 0) {
                            studentResult.documents[existIdx] = prev;
                        } else {
                            studentResult.documents.push(prev);
                        }

                        // Update allDocuments with preserved data
                        const allDocEntry = studentResult.allDocuments.find(
                            d => String(d.document_type_id) === String(prev.document_type_id)
                        );
                        if (allDocEntry) {
                            allDocEntry.ai_status = prev.ai_status;
                            allDocEntry.confidence = prev.confidence;
                            allDocEntry.remark = prev.remark;
                            allDocEntry.issues = prev.issues;
                            allDocEntry.extracted_data = prev.extracted_data;
                        }
                    }
                });

                this.log('info', `Student ${applnID}: Recheck - ${uploadedDocs.length} docs to verify (${beforeCount - uploadedDocs.length} already have ai_status, preserved)`);
            }

            studentResult.totalDocs = allDocs.length;

            if (uploadedDocs.length === 0) {
                // If we already preserved verified docs during smart recheck, mark as completed
                if (forceRecheck && studentResult.documents.length > 0) {
                    studentResult.status = studentResult.errors > 0 ? 'partial' : 'completed';
                    studentResult.endTime = new Date().toISOString();
                    this.log('info', `Student ${applnID}: All docs already verified, nothing to recheck`);
                    this.studentResults.set(String(applnID), studentResult);
                    try { await AtlasVerificationModel.upsertStudentResult(studentResult); } catch (e) {}
                    return studentResult;
                }

                studentResult.status = 'pending';
                studentResult.endTime = new Date().toISOString();
                this.log('info', `Student ${applnID}: No documents to verify`);

                // Preserve existing AI results from DB instead of overwriting with empty data
                try {
                    const existing = await AtlasVerificationModel.getStudentResult(String(applnID));
                    if (existing && existing.documents && existing.documents.length > 0) {
                        // Merge previous AI results into allDocuments
                        const prevDocsMap = {};
                        existing.documents.forEach(d => { prevDocsMap[d.document_type_id] = d; });
                        studentResult.allDocuments = studentResult.allDocuments.map(d => {
                            const prev = prevDocsMap[d.document_type_id];
                            if (prev && prev.ai_status) {
                                return { ...d, ai_status: prev.ai_status, confidence: prev.confidence, remark: prev.remark, issues: prev.issues, extracted_data: prev.extracted_data };
                            }
                            return d;
                        });
                        studentResult.documents = existing.documents;
                        studentResult.approved = existing.approved || 0;
                        studentResult.rejected = existing.rejected || 0;
                        studentResult.status = existing.status;
                        this.log('info', `Student ${applnID}: Preserved existing AI results`);
                    }
                } catch (e) {
                    this.log('warn', `Student ${applnID}: Could not load existing results: ${e.message}`);
                }

                this.studentResults.set(String(applnID), studentResult);
                try { await AtlasVerificationModel.upsertStudentResult(studentResult); } catch (e) {}
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

                        // Handle documents not uploaded
                        if (verification.status === 'skip') {
                            this.log('info', `${applnID} - ${doc.document_label}: Not uploaded`);
                            continue;
                        }

                        const aiStatus = verification.status === 'approve' ? 'Verified' : 'reject';

                        statusUpdates.push({
                            document_type_id: doc.document_type_id,
                            doc_ai_status: aiStatus,
                            doc_ai_remark: verification.remark
                        });

                        const docResult = {
                            document_type_id: doc.document_type_id,
                            document_label: doc.document_label,
                            document_type_name: doc.document_type_name,
                            filename: doc.filename,
                            file_url: doc.file_url,
                            ai_status: aiStatus,
                            confidence: verification.confidence,
                            remark: verification.remark,
                            issues: verification.issues,
                            extracted_data: verification.extracted_data
                        };

                        // Dedup: replace if doc already exists, otherwise push
                        const existIdx = studentResult.documents.findIndex(
                            d => String(d.document_type_id) === String(doc.document_type_id)
                        );
                        if (existIdx >= 0) {
                            studentResult.documents[existIdx] = docResult;
                        } else {
                            studentResult.documents.push(docResult);
                        }

                        // Also update in allDocuments
                        const allDocEntry = studentResult.allDocuments.find(
                            d => String(d.document_type_id) === String(doc.document_type_id)
                        );
                        if (allDocEntry) {
                            allDocEntry.ai_status = aiStatus;
                            allDocEntry.confidence = verification.confidence;
                            allDocEntry.remark = verification.remark;
                            allDocEntry.issues = verification.issues;
                            allDocEntry.extracted_data = verification.extracted_data;
                        }

                        this.log('info', `${applnID} - ${doc.document_label}: ${aiStatus} (${(verification.confidence * 100).toFixed(0)}%)`, {
                            remark: verification.remark
                        });
                    } else {
                        const errMsg = result.reason?.message || 'Unknown error';

                        statusUpdates.push({
                            document_type_id: doc.document_type_id,
                            doc_ai_status: 'error',
                            doc_ai_remark: `Verification failed: ${errMsg}`
                        });

                        const docResult = {
                            document_type_id: doc.document_type_id,
                            document_label: doc.document_label,
                            document_type_name: doc.document_type_name,
                            filename: doc.filename,
                            file_url: doc.file_url,
                            ai_status: 'error',
                            confidence: 0,
                            remark: errMsg,
                            issues: ['Verification process error'],
                            extracted_data: {}
                        };

                        // Dedup: replace if doc already exists, otherwise push
                        const errExistIdx = studentResult.documents.findIndex(
                            d => String(d.document_type_id) === String(doc.document_type_id)
                        );
                        if (errExistIdx >= 0) {
                            studentResult.documents[errExistIdx] = docResult;
                        } else {
                            studentResult.documents.push(docResult);
                        }

                        const allDocEntry = studentResult.allDocuments.find(
                            d => String(d.document_type_id) === String(doc.document_type_id)
                        );
                        if (allDocEntry) {
                            allDocEntry.ai_status = 'error';
                            allDocEntry.confidence = 0;
                            allDocEntry.remark = errMsg;
                        }

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

            // Recalculate counts from the authoritative documents array to prevent duplicates
            let approved = 0, rejected = 0, errors = 0;
            studentResult.documents.forEach(d => {
                if (d.ai_status === 'Verified') approved++;
                else if (d.ai_status === 'reject') rejected++;
                else if (d.ai_status === 'error') errors++;
            });
            studentResult.approved = approved;
            studentResult.rejected = rejected;
            studentResult.errors = errors;

            studentResult.status = errors > 0 ? 'partial' : 'completed';

        } catch (err) {
            studentResult.status = 'error';
            this.log('error', `Student ${applnID}: Processing failed`, { error: err.message });
        }

        studentResult.endTime = new Date().toISOString();

        // Persist to student results store (in-memory)
        this.studentResults.set(String(applnID), studentResult);

        // Persist to database
        try {
            await AtlasVerificationModel.upsertStudentResult(studentResult);
        } catch (dbErr) {
            this.log('error', `Failed to persist result for ${applnID} to DB: ${dbErr.message}`);
        }

        return studentResult;
    }

    // ===================== FULL BATCH RUN =====================

    async runBatch() {
        if (this.isRunning) {
            this.log('warn', 'Batch already running, skipping');
            return null;
        }

        if (this.activeRechecks.size > 0) {
            this.log('warn', `Cannot start batch: ${this.activeRechecks.size} parallel recheck(s) still active`);
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

                const applnID = student.applnID || student.student_app_id || student.id || student.application_id;
                if (!applnID) continue;

                const studentName = [student.student_first_name, student.student_last_name].filter(Boolean).join(' ')
                    || [student.first_name, student.last_name].filter(Boolean).join(' ')
                    || student.name || applnID;

                // Check existing verification status in DB
                let existingStatus = null;
                try {
                    const existing = await AtlasVerificationModel.getStudentResult(String(applnID));
                    if (existing) {
                        existingStatus = existing.status;
                        // Skip fully completed students
                        if (this.config.skipAlreadyVerified && existing.status === 'completed') {
                            this.log('info', `Student ${applnID} (${studentName}): already verified`);
                            this.currentRun.processed++;
                            this.currentRun.completed++;
                            continue;
                        }
                    }
                } catch (e) {
                    this.log('warn', `Could not check existing status for ${applnID}: ${e.message}`);
                }

                // For partial/error students, use smart recheck (preserve docs that already have ai_status)
                // For all students in batch, use forceRecheck to bypass verify_status filter and check all uploaded docs
                const useForceRecheck = true;

                this.log('info', `Processing student ${this.currentRun.processed + 1}/${students.length}: ${applnID} (${studentName})${existingStatus ? ' [existing: ' + existingStatus + ']' : ''}`);

                const result = await this.processStudent(applnID, studentName, { forceRecheck: useForceRecheck });
                this.currentRun.students.push(result);
                this.currentRun.processed++;

                if (result.status === 'completed' || result.status === 'partial') {
                    this.currentRun.completed++;
                    this.currentRun.totalDocsVerified += (result.documents ? result.documents.length : 0);
                    this.currentRun.totalApproved += result.approved;
                    this.currentRun.totalRejected += result.rejected;
                } else if (result.status === 'pending') {
                    // Student had no documents to verify
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
            const runSummary = { ...this.currentRun, students: undefined };
            this.runs.push(runSummary);
            if (this.runs.length > this.maxRuns) {
                this.runs = this.runs.slice(-this.maxRuns);
            }
            // Persist run to DB
            AtlasVerificationModel.saveRun(this.currentRun).catch(err => {
                this.log('error', `Failed to persist run to DB: ${err.message}`);
            });
        }
    }

    // ===================== VERIFY SINGLE DOCUMENT (on-demand) =====================

    async verifySingleDoc(applnID, documentTypeId) {
        // Only block if a full batch job is running; allow parallel single rechecks
        if (this.isRunning) {
            throw new Error('A batch job is currently running. Wait for it to finish or stop it first.');
        }

        if (this.activeRechecks.size >= this.maxParallelRechecks) {
            throw new Error(`Maximum parallel rechecks (${this.maxParallelRechecks}) reached. Wait for some to finish.`);
        }

        const recheckId = `doc_${applnID}_${documentTypeId}_${Date.now()}`;

        this.log('info', `========== SINGLE DOCUMENT RECHECK: ${applnID} / doc ${documentTypeId} ==========`);

        // Load existing student result from DB
        const existing = await AtlasVerificationModel.getStudentResult(String(applnID));
        if (!existing) {
            throw new Error(`No verification result found for student ${applnID}. Run full verification first.`);
        }

        // Find the document in allDocuments
        const docEntry = existing.allDocuments.find(d => String(d.document_type_id) === String(documentTypeId));
        if (!docEntry) {
            throw new Error(`Document type ${documentTypeId} not found for student ${applnID}`);
        }

        if (!docEntry.file_url) {
            throw new Error(`Document "${docEntry.document_label}" has no uploaded file`);
        }

        // Track this recheck operation
        this.activeRechecks.set(recheckId, {
            type: 'document',
            applnID,
            documentTypeId,
            startTime: new Date().toISOString()
        });

        try {
            const verification = await this.verifyDocument(docEntry);

            if (verification.status === 'skip') {
                this.activeRechecks.delete(recheckId);
                return { status: 'pending', document: docEntry.document_label, message: 'Document not uploaded' };
            }

            const aiStatus = verification.status === 'approve' ? 'Verified' : 'reject';

            // Update in allDocuments
            const allDocIdx = existing.allDocuments.findIndex(d => String(d.document_type_id) === String(documentTypeId));
            if (allDocIdx >= 0) {
                existing.allDocuments[allDocIdx].ai_status = aiStatus;
                existing.allDocuments[allDocIdx].confidence = verification.confidence;
                existing.allDocuments[allDocIdx].remark = verification.remark;
                existing.allDocuments[allDocIdx].issues = verification.issues;
                existing.allDocuments[allDocIdx].extracted_data = verification.extracted_data;
            }

            // Update or add in documents (verified docs list)
            const verDocIdx = existing.documents.findIndex(d => String(d.document_type_id) === String(documentTypeId));
            const docResult = {
                document_type_id: docEntry.document_type_id,
                document_label: docEntry.document_label,
                document_type_name: docEntry.document_type_name,
                filename: docEntry.filename,
                file_url: docEntry.file_url,
                ai_status: aiStatus,
                confidence: verification.confidence,
                remark: verification.remark,
                issues: verification.issues,
                extracted_data: verification.extracted_data
            };
            if (verDocIdx >= 0) {
                existing.documents[verDocIdx] = docResult;
            } else {
                existing.documents.push(docResult);
            }

            // Recalculate approved/rejected/errors counts from documents
            let approved = 0, rejected = 0, errors = 0;
            existing.documents.forEach(d => {
                if (d.ai_status === 'Verified') approved++;
                else if (d.ai_status === 'reject') rejected++;
                else if (d.ai_status === 'error') errors++;
            });
            existing.approved = approved;
            existing.rejected = rejected;
            existing.errors = errors;
            existing.status = errors > 0 ? 'partial' : 'completed';

            // Persist updated result to DB
            await AtlasVerificationModel.upsertStudentResult(existing);

            // Post single doc status update to Atlas API
            try {
                await this.withRetry(
                    () => this.atlasClient.updateDocumentStatus(applnID, [{
                        document_type_id: docEntry.document_type_id,
                        doc_ai_status: aiStatus,
                        doc_ai_remark: verification.remark
                    }]),
                    `Update status for ${applnID} doc ${documentTypeId}`
                );
            } catch (updateErr) {
                this.log('warn', `Failed to update Atlas status for doc ${documentTypeId}: ${updateErr.message}`);
            }

            this.log('info', `${applnID} - ${docEntry.document_label}: ${aiStatus} (${(verification.confidence * 100).toFixed(0)}%)`);
            this.activeRechecks.delete(recheckId);

            return {
                status: aiStatus,
                document: docEntry.document_label,
                confidence: verification.confidence,
                remark: verification.remark,
                studentStatus: existing.status,
                approved,
                rejected,
                errors
            };
        } catch (err) {
            this.activeRechecks.delete(recheckId);
            throw err;
        }
    }

    // ===================== VERIFY SINGLE STUDENT (on-demand) =====================

    async verifySingleStudent(applnID, { forceRecheck = false } = {}) {
        // Only block if a full batch job is running; allow parallel single rechecks
        if (this.isRunning) {
            throw new Error('A batch job is currently running. Wait for it to finish or stop it first.');
        }

        if (this.activeRechecks.size >= this.maxParallelRechecks) {
            throw new Error(`Maximum parallel rechecks (${this.maxParallelRechecks}) reached. Wait for some to finish.`);
        }

        const recheckId = `student_${applnID}_${Date.now()}`;

        // Track this recheck operation
        this.activeRechecks.set(recheckId, {
            type: 'student',
            applnID,
            forceRecheck,
            startTime: new Date().toISOString()
        });

        const runRecord = {
            id: Date.now().toString(36),
            startTime: new Date().toISOString(),
            endTime: null,
            status: 'running',
            totalStudents: 1,
            processed: 0,
            completed: 0,
            errors: 0,
            totalDocsVerified: 0,
            totalApproved: 0,
            totalRejected: 0,
            students: []
        };

        this.log('info', `========== SINGLE STUDENT VERIFICATION${forceRecheck ? ' (RECHECK)' : ''}: ${applnID} ==========`);

        try {
            const result = await this.processStudent(applnID, applnID, { forceRecheck });
            runRecord.students.push(result);
            runRecord.processed = 1;

            if (result.status === 'completed' || result.status === 'partial') {
                runRecord.completed = 1;
                runRecord.totalDocsVerified = result.documents ? result.documents.length : 0;
                runRecord.totalApproved = result.approved;
                runRecord.totalRejected = result.rejected;
            } else if (result.status === 'pending') {
                // Student had no documents to verify
            } else {
                runRecord.errors = 1;
            }

            runRecord.status = 'completed';
            runRecord.endTime = new Date().toISOString();

            // Save run to history
            this.runs.push({ ...runRecord, students: undefined });
            if (this.runs.length > this.maxRuns) {
                this.runs = this.runs.slice(-this.maxRuns);
            }
            AtlasVerificationModel.saveRun(runRecord).catch(err => {
                this.log('error', `Failed to persist run to DB: ${err.message}`);
            });

            this.activeRechecks.delete(recheckId);
            return runRecord;
        } catch (err) {
            this.activeRechecks.delete(recheckId);
            runRecord.status = 'error';
            runRecord.endTime = new Date().toISOString();
            throw err;
        }
    }

    // ===================== PARALLEL RECHECK (multiple docs at once) =====================

    /**
     * Recheck multiple documents in parallel.
     * @param {Array} items - Array of { applnID, documentTypeId }
     * @returns {Object} Summary with per-item results
     */
    async parallelRecheckDocs(items) {
        if (this.isRunning) {
            throw new Error('A batch job is currently running. Wait for it to finish or stop it first.');
        }

        if (!Array.isArray(items) || items.length === 0) {
            throw new Error('items must be a non-empty array of { applnID, documentTypeId }');
        }

        const availableSlots = this.maxParallelRechecks - this.activeRechecks.size;
        if (items.length > availableSlots) {
            throw new Error(`Cannot run ${items.length} rechecks. Only ${availableSlots} parallel slots available (max: ${this.maxParallelRechecks}, active: ${this.activeRechecks.size}).`);
        }

        this.log('info', `========== PARALLEL DOCUMENT RECHECK: ${items.length} documents ==========`);

        const results = await Promise.allSettled(
            items.map(item => this.verifySingleDoc(item.applnID, item.documentTypeId))
        );

        const summary = {
            total: items.length,
            succeeded: 0,
            failed: 0,
            results: []
        };

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const result = results[i];

            if (result.status === 'fulfilled') {
                summary.succeeded++;
                summary.results.push({
                    applnID: item.applnID,
                    documentTypeId: item.documentTypeId,
                    status: 'success',
                    data: result.value
                });
            } else {
                summary.failed++;
                summary.results.push({
                    applnID: item.applnID,
                    documentTypeId: item.documentTypeId,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error'
                });
            }
        }

        this.log('info', `Parallel doc recheck done: ${summary.succeeded} succeeded, ${summary.failed} failed`);
        return summary;
    }

    /**
     * Recheck multiple students in parallel.
     * @param {Array} applnIDs - Array of application IDs
     * @param {Object} options - { forceRecheck: true }
     * @returns {Object} Summary with per-student results
     */
    async parallelRecheckStudents(applnIDs, { forceRecheck = true } = {}) {
        if (this.isRunning) {
            throw new Error('A batch job is currently running. Wait for it to finish or stop it first.');
        }

        if (!Array.isArray(applnIDs) || applnIDs.length === 0) {
            throw new Error('applnIDs must be a non-empty array');
        }

        const availableSlots = this.maxParallelRechecks - this.activeRechecks.size;
        if (applnIDs.length > availableSlots) {
            throw new Error(`Cannot run ${applnIDs.length} rechecks. Only ${availableSlots} parallel slots available (max: ${this.maxParallelRechecks}, active: ${this.activeRechecks.size}).`);
        }

        this.log('info', `========== PARALLEL STUDENT RECHECK: ${applnIDs.length} students ==========`);

        const results = await Promise.allSettled(
            applnIDs.map(applnID => this.verifySingleStudent(applnID, { forceRecheck }))
        );

        const summary = {
            total: applnIDs.length,
            succeeded: 0,
            failed: 0,
            results: []
        };

        for (let i = 0; i < applnIDs.length; i++) {
            const applnID = applnIDs[i];
            const result = results[i];

            if (result.status === 'fulfilled') {
                summary.succeeded++;
                summary.results.push({
                    applnID,
                    status: 'success',
                    data: result.value
                });
            } else {
                summary.failed++;
                summary.results.push({
                    applnID,
                    status: 'error',
                    error: result.reason?.message || 'Unknown error'
                });
            }
        }

        this.log('info', `Parallel student recheck done: ${summary.succeeded} succeeded, ${summary.failed} failed`);
        return summary;
    }

    // ===================== AUTO-WATCH (poll for new data) =====================

    startAutoWatch() {
        if (this.autoWatchTimer) {
            this.log('warn', 'Auto-watch already running');
            return;
        }

        const intervalMs = this.config.autoWatchIntervalMs;
        this.log('info', `Auto-watch started: polling every ${Math.round(intervalMs / 1000)}s for new/unverified documents`);

        this.autoWatchTimer = setInterval(() => this._autoWatchCycle(), intervalMs);
        // Run first cycle after a short delay (let server fully start)
        setTimeout(() => this._autoWatchCycle(), 5000);
    }

    stopAutoWatch() {
        if (this.autoWatchTimer) {
            clearInterval(this.autoWatchTimer);
            this.autoWatchTimer = null;
            this.log('info', 'Auto-watch stopped');
        }
    }

    async _autoWatchCycle() {
        // Skip if a batch or another auto-watch cycle is already running
        if (this.isRunning || this.autoWatchRunning) {
            this.log('info', `Auto-watch: skipping cycle (isRunning=${this.isRunning}, autoWatchRunning=${this.autoWatchRunning})`);
            return;
        }

        this.autoWatchRunning = true;
        this.log('info', 'Auto-watch: starting cycle...');
        try {
            // Fetch current student list from Atlas
            const studentListResponse = await this.atlasClient.getStudentList();
            if (!studentListResponse || !studentListResponse.data) {
                this.log('warn', 'Auto-watch: could not fetch student list');
                this.autoWatchRunning = false;
                return;
            }

            const students = Array.isArray(studentListResponse.data)
                ? studentListResponse.data
                : [studentListResponse.data];

            this.log('info', `Auto-watch: fetched ${students.length} student(s) from API`);

            // Find students that need verification (check ALL conditions)
            const needsVerification = [];
            for (const student of students) {
                const applnID = student.applnID || student.student_app_id || student.id || student.application_id;
                if (!applnID) continue;

                const existing = this.studentResults.get(String(applnID));

                // New student (never verified)
                if (!existing) {
                    needsVerification.push(student);
                    continue;
                }

                // Students with pending status (had no docs before, may have now)
                if (existing.status === 'pending') {
                    needsVerification.push(student);
                    continue;
                }

                // Students with error status (should retry)
                if (existing.status === 'error') {
                    needsVerification.push(student);
                    continue;
                }

                // Completed/partial — check for new/re-uploaded docs or unverified docs
                if (existing.status === 'completed' || existing.status === 'partial') {
                    try {
                        const docListResponse = await this.atlasClient.getDocumentList(applnID);
                        if (!docListResponse || !docListResponse.data) continue;

                        const rawDocStatus = docListResponse.data.document_status;
                        if (!rawDocStatus || !Array.isArray(rawDocStatus)) continue;

                        const docStatus = rawDocStatus.map(d => this.normalizeDocFields(d));
                        const needsWork = docStatus.some(doc => {
                            if (!doc.file_url) return false;

                            // Find matching cached doc
                            const cached = (existing.allDocuments || []).find(
                                d => String(d.document_type_id) === String(doc.document_type_id)
                            );
                            // New document not in our cache
                            if (!cached) return true;
                            // Was not uploaded before but now has a file
                            if (!cached.is_uploaded && doc.file_url) return true;
                            // File URL changed (re-uploaded)
                            if (cached.file_url !== doc.file_url) return true;
                            // Has file but no AI status yet in local cache (unverified)
                            if (!cached.ai_status) return true;
                            // Has file but no AI status on API side (needs verification)
                            if (!doc.doc_ai_status) return true;
                            return false;
                        });

                        if (needsWork) {
                            needsVerification.push(student);
                        }
                    } catch (e) {
                        // Silently skip — will retry next cycle
                    }
                }
            }

            if (needsVerification.length === 0) {
                this.log('info', `Auto-watch: all ${students.length} student(s) up to date, nothing to verify`);
                this.autoWatchRunning = false;
                return;
            }

            this.log('info', `Auto-watch: found ${needsVerification.length} student(s) needing verification`);

            // Create a currentRun record so dashboard can track progress
            this.currentRun = {
                id: Date.now().toString(36),
                startTime: new Date().toISOString(),
                endTime: null,
                status: 'running',
                totalStudents: needsVerification.length,
                processed: 0,
                completed: 0,
                errors: 0,
                totalDocsVerified: 0,
                totalApproved: 0,
                totalRejected: 0,
                students: []
            };

            // Process each student that needs verification
            for (const student of needsVerification) {
                if (this.isRunning || this.shouldStop) break; // batch started, stop auto-watch cycle

                const applnID = student.applnID || student.student_app_id || student.id || student.application_id;
                const studentName = [student.student_first_name, student.student_last_name].filter(Boolean).join(' ')
                    || [student.first_name, student.last_name].filter(Boolean).join(' ')
                    || student.name || applnID;

                this.log('info', `Auto-watch: verifying student ${applnID} (${studentName})`);

                try {
                    const result = await this.processStudent(applnID, studentName);
                    this.currentRun.students.push(result);
                    this.currentRun.processed++;

                    if (result.status === 'completed' || result.status === 'partial') {
                        this.currentRun.completed++;
                        this.currentRun.totalDocsVerified += (result.documents ? result.documents.length : 0);
                        this.currentRun.totalApproved += result.approved;
                        this.currentRun.totalRejected += result.rejected;
                    } else if (result.status === 'error') {
                        this.currentRun.errors++;
                    }
                } catch (err) {
                    this.log('error', `Auto-watch: failed to verify ${applnID}: ${err.message}`);
                    this.currentRun.errors++;
                    this.currentRun.processed++;
                }

                // Small delay between students
                await this.sleep(this.config.delayBetweenStudentsMs);
            }

            // Finalize run record
            this.currentRun.status = this.currentRun.errors > 0 ? 'completed_with_errors' : 'completed';
            this.currentRun.endTime = new Date().toISOString();

            // Save run to history
            this.runs.push(this.currentRun);
            if (this.runs.length > 50) this.runs.shift();

            try {
                await AtlasVerificationModel.saveRun(this.currentRun);
            } catch (e) {
                this.log('warn', `Auto-watch: failed to save run record: ${e.message}`);
            }

            this.log('info', `Auto-watch: cycle complete, verified ${needsVerification.length} student(s) — approved: ${this.currentRun.totalApproved}, rejected: ${this.currentRun.totalRejected}`);

            // Call cronUpdate endpoint to sync mandatory document status
            try {
                const axios = require('axios');
                await axios.get('https://www.atlasskilltech.app/erp/cronUpdate/mandatoryDocumentDocStatus');
                this.log('info', 'Auto-watch: mandatoryDocumentDocStatus cron update called successfully');
            } catch (cronErr) {
                this.log('warn', `Auto-watch: mandatoryDocumentDocStatus cron update failed: ${cronErr.message}`);
            }
        } catch (err) {
            this.log('error', `Auto-watch cycle error: ${err.message}`);
        } finally {
            this.autoWatchRunning = false;
        }
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

        // Stop auto-watch as well
        this.stopAutoWatch();

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
            autoWatch: {
                active: this.autoWatchTimer !== null,
                intervalMs: this.config.autoWatchIntervalMs,
                isPolling: this.autoWatchRunning
            },
            engine: {
                isRunning: this.isRunning,
                provider: this.verificationService.provider,
                concurrency: this.config.concurrency,
                retryAttempts: this.config.retryAttempts,
                skipAlreadyVerified: this.config.skipAlreadyVerified
            },
            parallelRechecks: {
                active: this.activeRechecks.size,
                maxParallel: this.maxParallelRechecks,
                availableSlots: this.maxParallelRechecks - this.activeRechecks.size,
                operations: Array.from(this.activeRechecks.values())
            },
            currentRun: this.currentRun ? {
                id: this.currentRun.id,
                status: this.currentRun.status,
                startTime: this.currentRun.startTime,
                endTime: this.currentRun.endTime,
                totalStudents: this.currentRun.totalStudents,
                processed: this.currentRun.processed,
                completed: this.currentRun.completed,
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
        if (updates.maxParallelRechecks !== undefined) {
            this.maxParallelRechecks = parseInt(updates.maxParallelRechecks) || 5;
        }
        const allowed = [
            'cronSchedule', 'concurrency', 'retryAttempts', 'retryDelayMs',
            'delayBetweenStudentsMs', 'delayBetweenDocsMs', 'skipAlreadyVerified',
            'autoWatchIntervalMs'
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

    // ===================== STUDENT RESULTS =====================

    getStudentResult(applnID) {
        return this.studentResults.get(String(applnID)) || null;
    }

    getAllStudentResults() {
        const results = [];
        for (const [applnID, result] of this.studentResults) {
            const allDocs = result.allDocuments || [];
            const requiredDocs = allDocs.filter(d => d.is_required);

            // Confidence: average of docs that have a confidence value > 0
            const docsWithConfidence = allDocs.filter(d => d.confidence && d.confidence > 0);
            const avgConfidence = docsWithConfidence.length > 0
                ? docsWithConfidence.reduce((sum, d) => sum + d.confidence, 0) / docsWithConfidence.length
                : 0;

            results.push({
                applnID: result.applnID,
                studentName: result.studentName,
                status: result.status,
                totalDocs: allDocs.length,
                uploaded: result.uploaded || 0,
                approved: result.approved,
                rejected: result.rejected,
                errors: result.errors,
                avgConfidence: Math.round(avgConfidence * 100),
                requiredTotal: requiredDocs.length,
                requiredUploaded: requiredDocs.filter(d => d.is_uploaded).length,
                requiredVerified: requiredDocs.filter(d => d.ai_status === 'Verified').length,
                requiredRejected: requiredDocs.filter(d => d.ai_status === 'reject').length,
                verifiedAt: result.endTime
            });
        }
        return results;
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

    async init() {
        this.log('info', 'Verification Scheduler initialized', {
            provider: this.verificationService.provider,
            cron: this.config.cronSchedule,
            autoStart: this.config.autoStart
        });

        // Initialize DB tables and load cached results
        try {
            await AtlasVerificationModel.initTables();
            this.studentResults = await AtlasVerificationModel.loadAllIntoMap();
            const runs = await AtlasVerificationModel.getRecentRuns(this.maxRuns);
            this.runs = runs;
            this.log('info', `Loaded ${this.studentResults.size} student results and ${runs.length} runs from database`);
        } catch (err) {
            this.log('error', `Failed to load from DB: ${err.message}`);
        }

        // Always start auto-watch to poll for new/unverified documents every 5 minutes
        this.startAutoWatch();
        this.log('info', 'Auto-watch polling active — checking every 5 minutes');
    }
}

// Singleton instance
const scheduler = new VerificationScheduler();
module.exports = scheduler;
