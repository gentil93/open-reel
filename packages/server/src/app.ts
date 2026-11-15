import {
	type JobEngine,
	LOCAL_USER,
	NotFoundError,
	type ReelService,
	type UserContext,
	ValidationError,
} from "@open-reel/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";

export interface AppOptions {
	service: ReelService;
	engine: JobEngine;
	/** Extra origins allowed to call the API, e.g. the Vite dev server. */
	allowedOrigins?: string[];
	/** Maps a request to its user. Local installs have a single user. */
	resolveUser?: (c: Context) => UserContext;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function hostname(host: string): string {
	return host.replace(/:\d+$/, "");
}

export function createApp(options: AppOptions): Hono {
	const { service, engine } = options;
	const user = options.resolveUser ?? (() => LOCAL_USER);
	const app = new Hono();

	// The server holds API keys and spends money, and browsers let any website
	// send requests to localhost. Refuse anything that is not same-origin.
	app.use("*", async (c, next) => {
		// Bun builds the request URL from the Host header.
		const host = new URL(c.req.url).host;
		if (!LOCAL_HOSTS.includes(hostname(host))) {
			return c.json({ error: "Forbidden host" }, 403);
		}
		// Compared as text: `Origin` can be "null" or otherwise not a URL.
		const origin = c.req.header("origin");
		if (
			origin &&
			origin !== `http://${host}` &&
			!options.allowedOrigins?.includes(origin)
		) {
			return c.json({ error: "Forbidden origin" }, 403);
		}
		await next();
	});

	app.onError((error, c) => {
		if (error instanceof ValidationError) {
			return c.json({ error: error.message }, 400);
		}
		if (error instanceof NotFoundError) {
			return c.json({ error: error.message }, 404);
		}
		console.error(error);
		return c.json({ error: "Internal error" }, 500);
	});

	const json = async (c: Context): Promise<Record<string, unknown>> => {
		const body = await c.req.json().catch(() => null);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new ValidationError("Expected a JSON object");
		}
		return body;
	};

	app.get("/api/models", (c) => c.json(service.listModels()));

	app.get("/api/providers", async (c) =>
		c.json(await service.listProviders(user(c))),
	);
	app.put("/api/providers/:id/key", async (c) => {
		const { key } = await json(c);
		if (typeof key !== "string") throw new ValidationError("Missing key");
		await service.setProviderKey(user(c), c.req.param("id"), key);
		return c.body(null, 204);
	});
	app.delete("/api/providers/:id/key", async (c) => {
		await service.deleteProviderKey(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/api/sessions", async (c) =>
		c.json(await service.listSessions(user(c))),
	);
	app.get("/api/sessions/:id", async (c) =>
		c.json(await service.getSession(user(c), c.req.param("id"))),
	);
	app.delete("/api/sessions/:id", async (c) => {
		await service.deleteSession(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post("/api/turns", async (c) => {
		const body = await json(c);
		if (
			!Array.isArray(body.modelIds) ||
			body.modelIds.some((id) => typeof id !== "string")
		) {
			throw new ValidationError("modelIds must be a list of model ids");
		}
		if (body.sessionId != null && typeof body.sessionId !== "string") {
			throw new ValidationError("sessionId must be a string");
		}
		// The remaining fields are validated by the service's schema.
		const result = await service.createTurn(user(c), body as never);
		return c.json(result, 201);
	});

	app.post("/api/jobs/:id/cancel", async (c) => {
		await service.cancelJob(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post(
		"/api/assets",
		bodyLimit({
			maxSize: MAX_UPLOAD_BYTES,
			onError: (c) => c.json({ error: "The image is larger than 20 MB" }, 413),
		}),
		async (c) => {
			const mime = (c.req.header("content-type") ?? "").split(";")[0] ?? "";
			const data = new Uint8Array(await c.req.arrayBuffer());
			if (data.byteLength === 0) throw new ValidationError("Empty upload");
			return c.json(await service.uploadAsset(user(c), data, mime), 201);
		},
	);
	app.get("/api/assets/:id", async (c) => {
		const { asset, blob } = await service.getAssetFile(
			user(c),
			c.req.param("id"),
		);
		return new Response(blob, {
			headers: {
				"content-type": asset.mime,
				"content-length": String(asset.size),
				"cache-control": "private, max-age=31536000, immutable",
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
			},
		});
	});

	app.get("/api/gallery", async (c) => {
		const limit = Number(c.req.query("limit") ?? 60);
		const before = c.req.query("before");
		const beforeId = c.req.query("beforeId");
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			throw new ValidationError("limit must be between 1 and 200");
		}
		if (
			(before == null) !== (beforeId == null) ||
			Number.isNaN(Number(before ?? 0))
		) {
			throw new ValidationError("before and beforeId must be given together");
		}
		return c.json(
			await service.listGallery(user(c), {
				limit,
				before:
					before != null && beforeId != null
						? { createdAt: Number(before), id: beforeId }
						: undefined,
				query: c.req.query("query") || undefined,
			}),
		);
	});

	app.get("/api/events", (c) => {
		const { userId } = user(c);
		return streamSSE(c, async (stream) => {
			const unsubscribe = engine.subscribe((target, event) => {
				if (target !== userId) return;
				void stream.writeSSE({
					event: event.type,
					data: JSON.stringify(event),
				});
			});
			stream.onAbort(unsubscribe);
			await stream.writeSSE({ event: "ready", data: "{}" });
			// Keeps the connection alive through idle proxies and detects dead clients.
			while (!stream.aborted && !stream.closed) {
				await stream.sleep(15_000);
				await stream.writeSSE({ event: "ping", data: "{}" });
			}
			unsubscribe();
		});
	});

	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

	return app;
}
