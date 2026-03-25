// setup.js — Mock browser globals not available in the Node.js test environment.
// Loaded via jest.config.js setupFiles before each test suite.

global.chrome = {
    storage: {
        local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
        },
    },
    runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
    },
};
