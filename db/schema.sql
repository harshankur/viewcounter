-- Schema for view counter database
-- This file is used when DB_MODE=create to auto-initialize the database

-- Create database if it doesn't exist
CREATE DATABASE IF NOT EXISTS `{{DB_NAME}}` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `{{DB_NAME}}`;

-- Migration tracking table
CREATE TABLE IF NOT EXISTS `_migrations` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `version` VARCHAR(50) NOT NULL UNIQUE,
    `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Template for app-specific view tables
-- Actual tables will be created dynamically based on allowed.json appIds
-- Table name format: {{APP_ID}}
CREATE TABLE IF NOT EXISTS `{{APP_ID}}` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    
    -- Identifiers (Anonymized)
    `masked_ip` VARCHAR(45) NOT NULL,
    `visitor_hash` VARCHAR(64) NOT NULL,
    `country` VARCHAR(2) DEFAULT NULL,
    `timestamp` DATETIME NOT NULL,
    `devicesize` VARCHAR(20) NOT NULL,
    
    -- Page tracking
    `page_path` VARCHAR(500) DEFAULT NULL,
    `page_title` VARCHAR(200) DEFAULT NULL,
    
    -- Referrer tracking
    `referrer` VARCHAR(500) DEFAULT NULL,
    `referrer_domain` VARCHAR(200) DEFAULT NULL,
    `source_type` VARCHAR(20) DEFAULT NULL,  -- direct, search, social, email, campaign, referral

    -- User agent parsing
    `browser` VARCHAR(50) DEFAULT NULL,
    `browser_version` VARCHAR(20) DEFAULT NULL,
    `os` VARCHAR(50) DEFAULT NULL,
    `os_version` VARCHAR(20) DEFAULT NULL,
    `device_type` VARCHAR(20) DEFAULT NULL,  -- mobile, tablet, desktop
    
    -- Session tracking
    `session_id` VARCHAR(64) DEFAULT NULL,
    
    -- Custom events
    `event_type` VARCHAR(50) DEFAULT 'pageview',  -- pageview, click, submit, etc.
    `event_data` JSON DEFAULT NULL,
    
    -- Uniqueness tracking
    `is_unique` TINYINT(1) DEFAULT 1,  -- 1 if first view in window, 0 otherwise
    
    -- Indexes
    INDEX `idx_timestamp` (`timestamp`),
    INDEX `idx_visitor_timestamp` (`visitor_hash`, `timestamp`),
    INDEX `idx_masked_ip` (`masked_ip`),
    INDEX `idx_country` (`country`),
    INDEX `idx_devicesize` (`devicesize`),
    INDEX `idx_page_path` (`page_path`(255)),
    INDEX `idx_referrer_domain` (`referrer_domain`),
    INDEX `idx_source_type` (`source_type`),
    INDEX `idx_browser` (`browser`),
    INDEX `idx_os` (`os`),
    INDEX `idx_device_type` (`device_type`),
    INDEX `idx_session_id` (`session_id`),
    INDEX `idx_event_type` (`event_type`),
    INDEX `idx_is_unique` (`is_unique`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
