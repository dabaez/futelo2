/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/__tests__/**/*.test.js'],
  // Run all tests serially – better-sqlite3 uses a single file and we don't
  // want concurrent writers hitting the same temp DB from different workers.
  maxWorkers: 1,
  // Print individual test names for easier debugging
  verbose: true,
  // Collect coverage from the source files we actually care about
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js',  // covered by api.test.js integration tests
  ],
  coverageThreshold: {
    global: { lines: 70 },
  },
};
