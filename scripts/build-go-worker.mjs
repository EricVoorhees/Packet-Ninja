import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const outputName = process.platform === "win32" ? "command-worker-go.exe" : "command-worker-go";
const outputPath = path.join("..", "..", "bin", outputName);

const result = spawnSync("go", ["build", "-C", "go/command-worker", "-o", outputPath, "."], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

