import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        env: {
            WEBHOOK_SECRET: 'test-secret',
            BASE_URL: 'https://era.ndi.mx',
            DEFAULT_EMAIL: 'test@example.com',
        },
    },
});
