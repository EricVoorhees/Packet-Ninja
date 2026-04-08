import test from "node:test";
import assert from "node:assert/strict";
import { buildRegistryConfig } from "./config.js";

test("buildRegistryConfig enables npmjs proxy in online mode", () => {
  const config = buildRegistryConfig({
    runtimeDir: "/tmp/package-ninja",
    storageDir: "/tmp/package-ninja/storage",
    port: 4873,
    offline: false
  });

  assert.deepEqual(config.uplinks, {
    npmjs: {
      url: "https://registry.npmjs.org/"
    }
  });
  assert.equal((config.middlewares as { audit: { enabled: boolean } }).audit.enabled, true);
});

test("buildRegistryConfig removes uplinks in offline mode", () => {
  const config = buildRegistryConfig({
    runtimeDir: "/tmp/package-ninja",
    storageDir: "/tmp/package-ninja/storage",
    port: 4873,
    offline: true
  });

  assert.deepEqual(config.uplinks, {});
  assert.equal((config.middlewares as { audit: { enabled: boolean } }).audit.enabled, false);
  assert.deepEqual((config.packages as Record<string, Record<string, string>>)["**"], {
    access: "$all",
    publish: "$all",
    unpublish: "$all"
  });
});
