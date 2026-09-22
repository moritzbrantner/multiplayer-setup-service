import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "results/results.json" }]],
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    { name: "chromium-desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
    { name: "chromium-touch", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: [
    {
      command: "target/release/multiplayer-setup-service",
      cwd: root,
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: false,
      env: {
        BIND_ADDR: "127.0.0.1:8787",
        ALLOWED_ORIGINS: "http://127.0.0.1:4173",
        TURN_URLS: "turn:127.0.0.1:3478?transport=udp",
        TURN_SHARED_SECRET: "isolated-ci-fixture-not-for-production",
      },
    },
    { command: "python3 -m http.server 4173 --bind 127.0.0.1 --directory web", cwd: root, url: "http://127.0.0.1:4173", reuseExistingServer: false },
    { command: "turnserver -c e2e/turnserver.conf", cwd: root, port: 3478, reuseExistingServer: false },
  ],
});
