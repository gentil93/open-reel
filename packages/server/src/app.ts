import {
	isDemoSize,
	type JobEngine,
	LOCAL_USER,
	type LocalModelStore,
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
	models: LocalModelStore;
	/** Starts moving the local models to another folder. */
	moveModels?: (path: string) => Promise<void>;
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

/**
 * Reads a single-range `Range` header. Anything else (no header, several
 * ranges, another unit) is answered with the whole file, as HTTP allows.
 */
function parseRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | "unsatisfiable" | null {
	const match = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (match[1] === "" && match[2] === "")) return null;
	if (match[1] === "") {
		// "-N": the last N bytes.
		const length = Math.min(Number(match[2]), size);
		return length === 0
			? "unsatisfiable"
			: { start: size - length, end: size - 1 };
	}
	const start = Number(match[1]);
	const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	return start >= size || start > end ? "unsatisfiable" : { start, end };
}

/** Answers with a stored file, whole or the range the request asks for. */
function serveFile(c: Context, blob: Blob, mime: string): Response {
	const headers = {
		"content-type": mime,
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=31536000, immutable",
		// Stored files come from outside; they must never run as a page.
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox",
	};
	// Browsers ask for videos in pieces and cannot seek without this.
	const range = parseRange(c.req.header("range"), blob.size);
	if (range === "unsatisfiable") {
		return new Response(null, {
			status: 416,
			headers: { ...headers, "content-range": `bytes */${blob.size}` },
		});
	}
	if (range) {
		return new Response(blob.slice(range.start, range.end + 1), {
			status: 206,
			headers: {
				...headers,
				"content-length": String(range.end - range.start + 1),
				"content-range": `bytes ${range.start}-${range.end}/${blob.size}`,
			},
		});
	}
	return new Response(blob, {
		headers: { ...headers, "content-length": String(blob.size) },
	});
}

export function createApp(options: AppOptions): Hono {
	const { service, engine, models } = options;
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
		// The code and its values let the interface say it in the reader's language.
		const body = (e: ValidationError | NotFoundError) => ({
			error: e.message,
			...(e.code && { code: e.code, params: e.params }),
		});
		if (error instanceof ValidationError) return c.json(body(error), 400);
		if (error instanceof NotFoundError) return c.json(body(error), 404);
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

	app.get("/api/jobs/:id/preview", (c) => {
		const { data, mime } = service.jobPreview(user(c), c.req.param("id"));
		return new Response(data, {
			headers: { "content-type": mime, "cache-control": "no-store" },
		});
	});

	app.post("/api/jobs/:id/cancel", async (c) => {
		await service.cancelJob(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post("/api/jobs/:id/retry", async (c) => {
		await service.retryJob(user(c), c.req.param("id"));
		return c.body(null, 204);
	});

	app.post(
		"/api/assets",
		bodyLimit({
			maxSize: MAX_UPLOAD_BYTES,
			onError: (c) => c.json({ error: "The image is larger than 20 MB" }, 413),
		}),
		async (c) => {
			const data = new Uint8Array(await c.req.arrayBuffer());
			if (data.byteLength === 0) throw new ValidationError("Empty upload");
			return c.json(await service.uploadAsset(user(c), data), 201);
		},
	);
	app.get("/api/assets/:id", async (c) => {
		const { asset, blob } = await service.getAssetFile(
			user(c),
			c.req.param("id"),
		);
		return serveFile(c, blob, asset.mime);
	});

	// Models are shared by everyone using this installation.
	app.get("/api/local-models", async (c) => c.json(await models.list()));
	app.post("/api/local-models/:id/install", async (c) => {
		// No body, or one naming the variant to install instead of the best fit.
		const body = await c.req.json().catch(() => ({}));
		const variant = (body as { variant?: unknown } | null)?.variant;
		if (variant != null && typeof variant !== "string") {
			throw new ValidationError("variant must be a string");
		}
		await models.install(c.req.param("id"), variant ?? undefined);
		return c.body(null, 202);
	});
	app.post("/api/local-models/:id/cancel", async (c) => {
		await models.cancel(c.req.param("id"));
		return c.body(null, 204);
	});
	// The move goes on after the answer; its progress comes as events.
	app.post("/api/local-models/location", async (c) => {
		const body = await json(c);
		if (typeof body.path !== "string" || !body.path.trim()) {
			throw new ValidationError("path must name a folder");
		}
		const move = options.moveModels ?? ((path) => models.relocate(path));
		await move(body.path);
		return c.body(null, 202);
	});
	app.delete("/api/local-models/:id", async (c) => {
		await models.remove(c.req.param("id"));
		return c.body(null, 204);
	});
	app.get("/api/local-models/:id/demos/:index", async (c) => {
		const index = Number(c.req.param("index"));
		if (!Number.isInteger(index)) throw new NotFoundError("Demo not found");
		const size = c.req.query("size") ?? "original";
		if (!isDemoSize(size)) throw new ValidationError("Unknown demo size");
		const demo = await models.demo(c.req.param("id"), index, size);
		return serveFile(c, demo.blob, demo.mime);
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
			const send = (event: { type: string }) =>
				void stream.writeSSE({
					event: event.type,
					data: JSON.stringify(event),
				});
			const unsubscribeJobs = engine.subscribe((target, event) => {
				if (target === userId) send(event);
			});
			const unsubscribeModels = models.subscribe(send);
			const unsubscribe = () => {
				unsubscribeJobs();
				unsubscribeModels();
			};
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
