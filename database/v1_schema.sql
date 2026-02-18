-- =====================================================
-- AI Document Verification Platform - V1 Schema
-- =====================================================

-- =====================================================
-- 1. Users (API clients)
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role ENUM('admin', 'user') DEFAULT 'user',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- =====================================================
-- 2. API Keys
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_api_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    api_key VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) DEFAULT 'Default',
    rate_limit INT DEFAULT 1000 COMMENT 'requests per hour',
    burst_limit INT DEFAULT 50 COMMENT 'requests per minute',
    status ENUM('active', 'revoked', 'expired') DEFAULT 'active',
    last_used_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE CASCADE
);

-- =====================================================
-- 3. Document Master (admin + user configured doc types)
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_document_master (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100) NOT NULL,
    allowed_formats JSON DEFAULT '["jpg","png","pdf"]',
    max_size_mb INT DEFAULT 5,
    required_fields JSON COMMENT 'Fields AI should extract',
    validation_rules JSON COMMENT 'Regex or rule sets for validation',
    is_active TINYINT(1) DEFAULT 1,
    user_id BIGINT NULL COMMENT 'NULL = global/admin type, set = user-specific type',
    created_by BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES v1_users(id) ON DELETE SET NULL,
    UNIQUE KEY unique_code_per_scope (code, user_id)
);

-- =====================================================
-- 4. Verification Requests
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_verification_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    system_reference_id VARCHAR(50) UNIQUE NOT NULL,
    client_reference_id VARCHAR(255) NULL,
    user_id BIGINT NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    file_url TEXT NOT NULL,
    metadata JSON NULL,
    status ENUM('accepted', 'processing', 'verified', 'rejected', 'failed') DEFAULT 'accepted',
    confidence DECIMAL(5,2) NULL,
    risk_score DECIMAL(5,4) NULL,
    extracted_data JSON NULL,
    ai_response JSON NULL COMMENT 'Full AI response for debugging',
    issues JSON NULL COMMENT 'List of issues found',
    processed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE CASCADE
);

-- Index for fast status lookups
CREATE INDEX idx_v1_vr_status ON v1_verification_requests(status);
CREATE INDEX idx_v1_vr_user ON v1_verification_requests(user_id);
CREATE INDEX idx_v1_vr_sysref ON v1_verification_requests(system_reference_id);

-- =====================================================
-- 5. Webhooks
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_webhooks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    url TEXT NOT NULL,
    secret VARCHAR(255) NOT NULL COMMENT 'For signing webhook payloads',
    events JSON DEFAULT '["document.verified","document.rejected","document.failed"]',
    is_active TINYINT(1) DEFAULT 1,
    last_triggered_at TIMESTAMP NULL,
    failure_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE CASCADE
);

-- =====================================================
-- 6. Webhook Delivery Log
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_webhook_deliveries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    webhook_id BIGINT NOT NULL,
    verification_request_id BIGINT NOT NULL,
    event VARCHAR(100) NOT NULL,
    payload JSON NOT NULL,
    response_status INT NULL,
    response_body TEXT NULL,
    status ENUM('pending', 'delivered', 'failed') DEFAULT 'pending',
    attempts INT DEFAULT 0,
    next_retry_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES v1_webhooks(id) ON DELETE CASCADE,
    FOREIGN KEY (verification_request_id) REFERENCES v1_verification_requests(id) ON DELETE CASCADE
);

-- =====================================================
-- 7. Rate Limit Tracking
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_rate_limit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    api_key_id BIGINT NOT NULL,
    window_start TIMESTAMP NOT NULL,
    request_count INT DEFAULT 1,
    FOREIGN KEY (api_key_id) REFERENCES v1_api_keys(id) ON DELETE CASCADE,
    UNIQUE KEY unique_window (api_key_id, window_start)
);

-- =====================================================
-- 8. Bulk Verification Jobs
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_bulk_jobs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    bulk_id VARCHAR(50) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL,
    total_documents INT NOT NULL DEFAULT 0,
    completed INT NOT NULL DEFAULT 0,
    verified INT NOT NULL DEFAULT 0,
    rejected INT NOT NULL DEFAULT 0,
    failed INT NOT NULL DEFAULT 0,
    status ENUM('queued', 'processing', 'completed', 'partial', 'failed') DEFAULT 'queued',
    callback_url TEXT NULL COMMENT 'Optional URL to POST final summary',
    metadata JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE CASCADE
);

CREATE INDEX idx_v1_bulk_user ON v1_bulk_jobs(user_id);
CREATE INDEX idx_v1_bulk_status ON v1_bulk_jobs(status);

-- Link table: connects bulk job to individual verification requests
CREATE TABLE IF NOT EXISTS v1_bulk_job_items (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    bulk_job_id BIGINT NOT NULL,
    verification_request_id BIGINT NOT NULL,
    item_index INT NOT NULL COMMENT 'Ordering within the batch',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bulk_job_id) REFERENCES v1_bulk_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (verification_request_id) REFERENCES v1_verification_requests(id) ON DELETE CASCADE,
    UNIQUE KEY unique_bulk_item (bulk_job_id, verification_request_id)
);

-- =====================================================
-- 9. Audit Log
-- =====================================================
CREATE TABLE IF NOT EXISTS v1_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    action VARCHAR(255) NOT NULL,
    resource_type VARCHAR(100) NULL,
    resource_id VARCHAR(100) NULL,
    details JSON NULL,
    ip_address VARCHAR(45) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES v1_users(id) ON DELETE SET NULL
);

-- =====================================================
-- 9. Seed Data
-- =====================================================

-- Default admin user (password: admin123)
INSERT INTO v1_users (name, email, password, role) VALUES
('Platform Admin', 'admin@verify.com', '$2b$10$defaulthashedpassword', 'admin');

-- Default document types
INSERT INTO v1_document_master (name, code, allowed_formats, max_size_mb, required_fields, validation_rules) VALUES
('Aadhaar Card', 'aadhaar', '["jpg","png","pdf"]', 5, '["name","dob","id_number"]', '{"id_number": "^[0-9]{4}\\\\s?[0-9]{4}\\\\s?[0-9]{4}$"}'),
('PAN Card', 'pan', '["jpg","png","pdf"]', 5, '["name","pan_number","dob"]', '{"pan_number": "^[A-Z]{5}[0-9]{4}[A-Z]$"}'),
('Passport', 'passport', '["jpg","png","pdf"]', 10, '["name","passport_number","dob","expiry_date","nationality"]', '{"passport_number": "^[A-Z][0-9]{7}$"}'),
('Driving License', 'driving_license', '["jpg","png","pdf"]', 5, '["name","license_number","dob","expiry_date"]', NULL),
('Voter ID', 'voter_id', '["jpg","png","pdf"]', 5, '["name","voter_id_number","dob"]', NULL),
('Bank Statement', 'bank_statement', '["pdf"]', 10, '["account_holder_name","account_number","bank_name"]', NULL),
('Utility Bill', 'utility_bill', '["jpg","png","pdf"]', 5, '["name","address","bill_date"]', NULL),
('10th Marksheet', 'marksheet_10', '["jpg","png","pdf"]', 5, '["name","roll_number","percentage","board"]', NULL),
('12th Marksheet', 'marksheet_12', '["jpg","png","pdf"]', 5, '["name","roll_number","percentage","board"]', NULL),
('Graduation Certificate', 'graduation_cert', '["jpg","png","pdf"]', 5, '["name","degree","university","year_of_passing"]', NULL);
