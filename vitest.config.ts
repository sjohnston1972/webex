import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Fixed test secrets. CI has no .dev.vars, and the suite should
              // not depend on whatever PIN a developer happens to have locally
              // — test/helpers.ts unlocks with this one. Dummy values only:
              // nothing here reaches Cloudflare, Webex or CUCM.
              PIN_CODE: "435040",
              ENC_KEY: "d2ViZXhtaWdyYXRlLXZpdGVzdC1kdW1teS1rZXktMzI=",
              WEBEX_CLIENT_ID: "test-client-id",
              WEBEX_SECRET: "test-client-secret",
              WEBEX_REDIRECT_URL: "http://localhost:8787/auth/callback",
            },
          },
        },
      },
    },
  };
});
