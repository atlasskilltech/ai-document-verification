-- Atlas Student Verification Results Storage
-- Persists AI verification results that were previously only in-memory

CREATE TABLE IF NOT EXISTS atlas_verification_results (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    appln_id VARCHAR(100) NOT NULL,
    student_name VARCHAR(255) DEFAULT NULL,
    status ENUM('processing','completed','partial','error','skipped') DEFAULT 'processing',
    total_docs INT DEFAULT 0,
    uploaded INT DEFAULT 0,
    approved INT DEFAULT 0,
    rejected INT DEFAULT 0,
    errors INT DEFAULT 0,
    skipped INT DEFAULT 0,
    all_documents JSON DEFAULT NULL,
    verified_documents JSON DEFAULT NULL,
    start_time DATETIME DEFAULT NULL,
    end_time DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY idx_appln_id (appln_id),
    INDEX idx_status (status),
    INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verification run history
CREATE TABLE IF NOT EXISTS atlas_verification_runs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id VARCHAR(50) NOT NULL,
    status ENUM('running','completed','stopped','error') DEFAULT 'running',
    total_students INT DEFAULT 0,
    processed INT DEFAULT 0,
    completed INT DEFAULT 0,
    skipped_count INT DEFAULT 0,
    errors INT DEFAULT 0,
    total_docs_verified INT DEFAULT 0,
    total_approved INT DEFAULT 0,
    total_rejected INT DEFAULT 0,
    start_time DATETIME DEFAULT NULL,
    end_time DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY idx_run_id (run_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
