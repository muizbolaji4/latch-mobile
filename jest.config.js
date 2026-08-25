/**
 * Two projects, because the wallet's two kinds of test need different worlds.
 *
 * `node` runs the pure-logic suites — key derivation, signing, encoding. These
 * must not load the Expo environment: its stream polyfill throws when the
 * Stellar SDK's axios adapter probes ReadableStream at import time, which kills
 * the run before a single test executes.
 *
 * `components` runs anything that renders or touches React Native, under
 * jest-expo. It has no tests yet — the crypto surface is the priority — but the
 * slot is here so adding one does not mean rearranging the config.
 */
module.exports = {
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/lib/**/*.test.ts',
        '<rootDir>/src/utils/**/*.test.ts',
        '<rootDir>/src/api/**/*.test.ts',
      ],
      transform: {
        '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }],
      },
      // @noble, @scure and the Stellar SDK ship ESM that Jest cannot load
      // untransformed.
      transformIgnorePatterns: [
        '/node_modules/(?!(@noble|@scure|@stellar|stellar-hd-wallet))',
      ],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
      },
    },
    {
      displayName: 'components',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/components/**/*.test.tsx', '<rootDir>/app/**/*.test.tsx'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
      },
    },
  ],
  testPathIgnorePatterns: ['/node_modules/', '/reference/', '/dist/', '/ios/', '/android/'],
};
