import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  // Set TRIGGER_PROJECT_REF in your environment (from the Trigger.dev dashboard).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_crypto_scout_swarm",
  runtime: "node",
  logLevel: "info",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
});
