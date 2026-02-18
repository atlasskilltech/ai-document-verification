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
});

module.exports = app;
