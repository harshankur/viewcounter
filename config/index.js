const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true });

/**
 * Unified configuration loader
 * Loads from environment variables, JSON files, or defaults
 */
class Config {
    constructor() {
        this.dbInfo = this.loadDbInfo();
        this.allowed = this.loadAllowed();
        this.server = this.loadServerConfig();
    }

    /**
     * Load database configuration
     * Priority: dbInfo.json > environment variables > defaults
     */
    loadDbInfo() {
        const dbInfoPath = path.join(__dirname, '..', 'dbInfo.json');
        
        // Try loading from file first
        if (fs.existsSync(dbInfoPath)) {
            try {
                const fileConfig = JSON.parse(fs.readFileSync(dbInfoPath, 'utf8'));
                return {
                    mode: fileConfig.mode || 'connect',
                    host: fileConfig.host,
                    port: fileConfig.port || 3306,
                    database: fileConfig.database,
                    user: fileConfig.user,
                    password: fileConfig.password
                };
            } catch (error) {
                console.warn('Failed to parse dbInfo.json, falling back to environment variables');
            }
        }

        // Fall back to environment variables
        return {
            mode: process.env.DB_MODE || 'connect',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            database: process.env.DB_NAME || 'viewcounterdb',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || ''
        };
    }

    /**
     * Load allowed values configuration
     * Priority: allowed.json > defaults
     */
    loadAllowed() {
        const allowedPath = path.join(__dirname, '..', 'allowed.json');
        
        if (fs.existsSync(allowedPath)) {
            try {
                return JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
            } catch (error) {
                console.warn('Failed to parse allowed.json, using defaults');
            }
        }

        // Default allowed values
        return {
            appId: ['example_app'],
            deviceSize: ['small', 'medium', 'large']
        };
    }

    /**
     * Load server configuration
     */
    loadServerConfig() {
        return {
            port: parseInt(process.env.PORT || '3030', 10),
            nodeEnv: process.env.NODE_ENV || 'development',
            rateLimit: {
                windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
                max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10)
            },
            uniqueVisitorWindowHours: parseInt(process.env.UNIQUE_VISITOR_WINDOW_HOURS || '24', 10)
        };
    }

    /**
     * Check if configuration files exist
     */
    static hasConfigFiles() {
        const dbInfoPath = path.join(__dirname, '..', 'dbInfo.json');
        const allowedPath = path.join(__dirname, '..', 'allowed.json');
        
        return {
            hasDbInfo: fs.existsSync(dbInfoPath),
            hasAllowed: fs.existsSync(allowedPath),
            hasEither: fs.existsSync(dbInfoPath) || fs.existsSync(allowedPath)
        };
    }
}

module.exports = new Config();
