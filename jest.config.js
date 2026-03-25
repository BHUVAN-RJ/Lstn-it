module.exports = {
    testEnvironment: 'node',
    transform: {
        '^.+\\.js$': 'babel-jest',
    },
    testMatch: ['**/test/**/*.test.js'],
    // Mock chrome extension APIs since tests run in Node
    setupFiles: ['./test/setup.js'],
};
