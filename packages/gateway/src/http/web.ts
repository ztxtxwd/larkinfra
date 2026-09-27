import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { findUpFile } from "@larkinfra/shared";

function resolveWebDist(): string | undefined {
  const fromEnv = process.env.LARKINFRA_WEB_DIST;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "index.html"))) {
    return path.resolve(fromEnv);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../web/dist"),
    path.resolve(process.cwd(), "packages/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
  ];
  const rootConfig = findUpFile("pnpm-workspace.yaml");
  if (rootConfig) {
    candidates.unshift(
      path.resolve(path.dirname(rootConfig), "packages/web/dist"),
    );
  }
  return candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
}

export function mountWebUi(app: Hono): string | undefined {
  const dist = resolveWebDist();
  if (!dist) {
    app.get("/ui", (c) =>
      c.text(
        "Web UI not built. Run: pnpm --filter @larkinfra/web build",
        503,
      ),
    );
    return undefined;
  }

  app.get("/", (c) => c.redirect("/ui/", 302));
  app.get("/ui", (c) => c.redirect("/ui/", 302));

  app.use(
    "/ui/*",
    serveStatic({
      root: dist,
      rewriteRequestPath: (p) => {
        let rel = p.replace(/^\/ui\/?/, "");
        if (!rel || rel.endsWith("/")) rel = "index.html";
        const abs = path.join(dist, rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return `/${rel}`;
        return "/index.html";
      },
    }),
  );

  return dist;
}
