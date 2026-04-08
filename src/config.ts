import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionConfigOptions {
  runtimeDir: string;
  storageDir: string;
  port: number;
  offline: boolean;
}

export async function writeRegistryConfig(options: SessionConfigOptions): Promise<string> {
  await mkdir(options.runtimeDir, { recursive: true });
  await mkdir(options.storageDir, { recursive: true });

  const configPath = path.join(options.runtimeDir, "package-ninja.registry.config.json");
  const config = buildRegistryConfig(options);

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return configPath;
}

export function buildRegistryConfig(options: SessionConfigOptions): Record<string, unknown> {
  const packages = options.offline
    ? {
        "@*/*": {
          access: "$all",
          publish: "$all",
          unpublish: "$all"
        },
        "**": {
          access: "$all",
          publish: "$all",
          unpublish: "$all"
        }
      }
    : {
        "@*/*": {
          access: "$all",
          publish: "$all",
          unpublish: "$all",
          proxy: "npmjs"
        },
        "**": {
          access: "$all",
          publish: "$all",
          unpublish: "$all",
          proxy: "npmjs"
        }
      };

  return {
    storage: options.storageDir,
    auth: {
      htpasswd: {
        file: path.join(options.runtimeDir, "htpasswd")
      }
    },
    uplinks: options.offline
      ? {}
      : {
          npmjs: {
            url: "https://registry.npmjs.org/"
          }
        },
    packages,
    middlewares: {
      audit: {
        enabled: !options.offline
      }
    },
    logs: {
      type: "stdout",
      format: "pretty",
      level: "http"
    },
    publish: {
      allow_offline: true
    },
    userRateLimit: {
      windowMs: 60_000,
      max: 300
    },
    listen: `127.0.0.1:${options.port}`,
    _debug: true
  };
}
