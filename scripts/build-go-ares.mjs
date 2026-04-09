import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const outputName = process.platform === "win32" ? "ares-registry.exe" : "ares-registry";
const outputPath = path.join("..", "..", "bin", outputName);

const result = spawnSync("go", ["build", "-C", "go/ares", "-o", outputPath, "./cmd/ares-registry"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
