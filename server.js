const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const app = express();

// ===================== MIDDLEWARE =====================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'admissions-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===================== API ROUTES =====================
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/applicants', require('./routes/applicantRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/verification', require('./routes/verificationRoutes'));

// ===================== V1 API ROUTES (Document Verification Platform) =====================
app.use('/v1/auth', require('./routes/v1/authRoutes'));
app.use('/v1/admin', require('./routes/v1/adminRoutes'));
app.use('/v1/verify', require('./routes/v1/verifyRoutes'));
app.use('/v1/webhook', require('./routes/v1/webhookRoutes'));
app.use('/v1/dashboard', require('./routes/v1/dashboardRoutes'));

// V1 convenience aliases (status & result at top level)
const { apiKeyAuth } = require('./middleware/v1/apiKeyAuth');
const V1VerificationRequestModel = require('./models/v1/V1VerificationRequestModel');

app.get('/v1/status/:system_reference_id', apiKeyAuth, async (req, res) => {
    try {
        const request = await V1VerificationRequestModel.findBySystemRefId(req.params.system_reference_id);
        if (!request) return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        if (request.user_id !== req.apiUser.userId && req.apiUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
        }
        res.json({
            system_reference_id: request.system_reference_id,
            client_reference_id: request.client_reference_id,
            status: request.status,
            confidence: request.confidence,
            created_at: request.created_at,
            processed_at: request.processed_at
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/v1/result/:system_reference_id', apiKeyAuth, async (req, res) => {
    try {
        const request = await V1VerificationRequestModel.findBySystemRefId(req.params.system_reference_id);
        if (!request) return res.status(404).json({ error: 'Not found', message: 'Verification request not found' });
        if (request.user_id !== req.apiUser.userId && req.apiUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
        }
        if (['accepted', 'processing'].includes(request.status)) {
            return res.json({ system_reference_id: request.system_reference_id, status: request.status, message: 'Document is still being processed.' });
        }
        res.json({
            system_reference_id: request.system_reference_id,
            client_reference_id: request.client_reference_id,
            document_type: request.document_type,
            status: request.status,
            confidence: request.confidence,
            risk_score: request.risk_score,
            extracted_data: request.extracted_data,
            issues: request.issues,
            created_at: request.created_at,
            processed_at: request.processed_at
        });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===================== WEB VIEWS =====================
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/verification', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verification.html'));
});

// ===================== ERROR HANDLING =====================
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large. Maximum size is 5MB.' });
    }
    res.status(500).json({ success: false, message: 'Internal server error' });
});

// ===================== START SERVER =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   Admissions Document Review Agent               ║
║   Server running on http://localhost:${PORT}        ║
║   API Base: http://localhost:${PORT}/api            ║
║   Verification: http://localhost:${PORT}/verification║
╚══════════════════════════════════════════════════╝
    `);

    // Initialize AI Document Verification Scheduler
    const scheduler = require('./services/VerificationScheduler');
    scheduler.init();

    // Initialize V1 Document Verification Queue
    const QueueService = require('./services/v1/QueueService');
    const VerificationProcessor = require('./services/v1/VerificationProcessor');
    QueueService.onJob('verify_document', async (data) => {
        await VerificationProcessor.process(data.requestId);
    });
    QueueService.startPolling();
    console.log('  V1 API: http://localhost:' + PORT + '/v1');
});

module.exports = app;
