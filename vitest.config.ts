import { defineConfig } from 'vitest/config';

// `npm run test:unit` runs only what needs no browser, on any platform.
const unit = process.env.npm_lifecycle_event === 'test:unit';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup.ts'],
    env: unit ? { LINEWORK_SKIP_E2E: '1' } : {},
  },
});
