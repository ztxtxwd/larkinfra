import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

/** Walk up from cwd looking for `filename`. */
export function findUpFile(
  filename: string,
  startDir = process.cwd(),
  maxDepth = 8,
): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Walk up from cwd (and optional start) to load the nearest `.env`. */
export function loadEnv(options?: {
  startDir?: string;
  filename?: string;
}): string | undefined {
  const filename = options?.filename ?? ".env";
  const starts = [
    options?.startDir,
    process.cwd(),
    path.dirname(process.cwd()),
  ].filter(Boolean) as string[];

  const seen = new Set<string>();
  for (const start of starts) {
    if (seen.has(path.resolve(start))) continue;
    const found = findUpFile(filename, start);
    if (found) {
      dotenvConfig({ path: found, override: false });
      return found;
    }
    seen.add(path.resolve(start));
  }
  return undefined;
}
