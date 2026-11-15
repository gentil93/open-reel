import { join, normalize, sep } from "node:path";
import type { Hono } from "hono";

/** Serves the built web UI from `dir`, falling back to index.html for client routes. */
export function serveWeb(app: Hono, dir: string): void {
	app.get("*", async (c) => {
		let requested: string;
		try {
			requested = decodeURIComponent(c.req.path);
		} catch {
			return c.notFound(); // malformed percent-encoding
		}
		const path = normalize(join(dir, requested));
		if (path !== dir && !path.startsWith(dir + sep)) return c.notFound();
		const file = Bun.file(path);
		if (c.req.path !== "/" && (await file.exists())) {
			const immutable = c.req.path.startsWith("/assets/");
			return new Response(file, {
				headers: {
					"cache-control": immutable
						? "public, max-age=31536000, immutable"
						: "no-cache",
				},
			});
		}
		return new Response(Bun.file(join(dir, "index.html")), {
			headers: { "cache-control": "no-cache" },
		});
	});
}
