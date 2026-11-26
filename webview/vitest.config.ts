import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Use jsdom storage, not Node's experimental global localStorage.
    execArgv: ["--no-experimental-webstorage"],
    // Required for @testing-library/react's automatic DOM cleanup between tests.
    globals: true,
    tags: [
      { name: "history-stress", description: "Large transcript paging for Slow and CI" },
      {
        name: "app-detail",
        description: "Secondary panels, telemetry and render cost for Slow and CI",
      },
    ],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, "tests/browser/**"],
    // Otherwise every stylesheet reads as empty, even with ?raw.
    css: { include: [/(?:styles|UsageOverview)\.css/, /sarasa-mono-sc\/[\w-]+\/result\.css/] },
  },
});
