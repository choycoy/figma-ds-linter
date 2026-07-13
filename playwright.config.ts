import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    viewport: { width: 380, height: 560 },
    trace: "retain-on-failure",
  },
});
