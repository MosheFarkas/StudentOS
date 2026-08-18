import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.test.ts', 'apps/relay/*.test.mjs', 'apps/desktop/src/*.test.mjs'],
    // Integration tests share one Postgres database, so parallel files would
    // race on the same rows. The suite is small; correctness beats speed here.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
});
