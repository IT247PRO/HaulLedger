import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('../migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values. Email and Stripe API keys stay unset so "not configured" paths are the default.
            INTEGRATIONS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
            STRIPE_PRICE_STARTER: 'price_starter_test',
            STRIPE_PRICE_FLEET: 'price_fleet_test',
            APP_URL: 'https://app.haulledger.test',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
