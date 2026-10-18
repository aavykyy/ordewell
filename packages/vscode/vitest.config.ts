import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import * as path from 'path';
import { sharedTest } from '../../vitest.shared';

export default defineConfig({
  plugins: [react()],
  test: {
    ...sharedTest,
    // Node-env adapter tests, jsdom for React component tests.
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: [...sharedTest.setupFiles, 'src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/fixtures/**',
        '**/*.d.ts',
        'src/test/**',
        'src/test-integration/**',
        'dist/**',
        'dist-test/**',
      ],
    },
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/vscode.mock.ts'),
    },
  },
});
