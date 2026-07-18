// Portions of this test might need careful handling since config is a singleton
// We use jest.resetModules() to test fresh instances
describe('Config Loader', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('should load defaults when no environment variables or files exist', () => {
        // Clear relevant env vars
        delete process.env.DB_MODE;
        delete process.env.DB_HOST;
        delete process.env.PORT;

        // Mock fs.existsSync to return false for config files
        const fsMock = require('fs');
        jest.spyOn(fsMock, 'existsSync').mockReturnValue(false);

        const config = require('../config/index');

        expect(config.dbInfo.mode).toBe('connect');
        expect(config.dbInfo.host).toBe('127.0.0.1');
        expect(config.server.port).toBe(3030);
        expect(config.allowed.appId).toContain('example_app');

        fsMock.existsSync.mockRestore();
    });

    test('should prioritize environment variables over defaults', () => {
        process.env.DB_MODE = 'create';
        process.env.DB_HOST = 'test-db-host';
        process.env.PORT = '4000';
        process.env.NODE_ENV = 'production';

        const fsMock = require('fs');
        jest.spyOn(fsMock, 'existsSync').mockReturnValue(false);

        const config = require('../config/index');

        expect(config.dbInfo.mode).toBe('create');
        expect(config.dbInfo.host).toBe('test-db-host');
        expect(config.server.port).toBe(4000);
        expect(config.server.nodeEnv).toBe('production');

        fsMock.existsSync.mockRestore();
    });

    test('should detect configuration files', () => {
        const fsMock = require('fs');
        const existsSpy = jest.spyOn(fsMock, 'existsSync');

        // Mock only for specific files
        existsSpy.mockImplementation((p) => {
            if (p.endsWith('dbInfo.json')) return true;
            if (p.endsWith('allowed.json')) return false;
            return false;
        });

        const config = require('../config/index');
        const status = config.constructor.hasConfigFiles();

        expect(status.hasDbInfo).toBe(true);
        expect(status.hasAllowed).toBe(false);
        expect(status.hasEither).toBe(true);

        existsSpy.mockRestore();
    });

    test('should parse dbInfo.json if it exists', () => {
        const fsMock = require('fs');
        jest.spyOn(fsMock, 'existsSync').mockImplementation(p => p.endsWith('dbInfo.json'));
        jest.spyOn(fsMock, 'readFileSync').mockReturnValue(JSON.stringify({
            mode: 'connect',
            host: 'file-host',
            user: 'file-user'
        }));

        const config = require('../config/index');

        expect(config.dbInfo.host).toBe('file-host');
        expect(config.dbInfo.user).toBe('file-user');

        fsMock.existsSync.mockRestore();
        fsMock.readFileSync.mockRestore();
    });
});
