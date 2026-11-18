import {
	CodedError,
	isDemoSize,
	isTranslateWith,
	type JobEngine,
	LOCAL_USER,
	type LocalModelStore,
	NotFoundError,
	type ReelService,
	type SettingsStore,
	TRANSLATE_WITH,
	type UserContext,
	ValidationError,
} from "@open-reel/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Agents } from "./agents";
import type { ImproveRequest } from "./runtime";

export interface AppOptions {
	service: ReelService;
	engine: JobEngine;
	models: LocalModelStore;
	/** Starts moving the local models to another folder. */
	moveModels?: (path: string) => Promise<void>;
	/** A person's choices the server acts on, such as how to translate. */
	settings?: SettingsStore;
	/** Extra origins allowed to call the API, e.g. the Vite dev server. */
	allowedOrigins?: string[];
	/** Maps a request to its user. Local installs have a single user. */
	resolveUser?: (c: Context) => UserContext;
	/** Connects AI agents to this installation; absent where it cannot. */
	agents?: Agents;
	/** A richer prompt for a short idea; absent where no model can write. */
	improvePrompt?: (
		ctx: UserContext,
		request: ImproveRequest,
		signal: AbortSignal,
	) => Promise<string>;
}

/**
 * The longest idea a person may ask to improve: with the instructions and
 * the answer, it must fit the local language model's context.
 */
const MAX_IDEA_LENGTH = 1000;

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
		const body = (e: CodedError) => ({
			error: e.message,
			...(e.code && { code: e.code, params: e.params }),
		});
		if (error instanceof ValidationError) return c.json(body(error), 400);
		if (error instanceof NotFoundError) return c.json(body(error), 404);
		// Something the server relies on failed in a way a person can be told.
		if (error instanceof CodedError && error.code) {
			return c.json(body(error), 502);
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

	// Connecting agents writes to their settings, on the person's request.
	const agents = options.agents;
	if (agents) {
		app.get("/api/agents", async (c) => c.json(await agents.status()));
		app.put("/api/agents/claude-desktop", async (c) => {
			const body = (await c.req.json().catch(() => null)) as {
				allowPaid?: unknown;
				spendLimitUsd?: unknown;
			} | null;
			const limit = body?.spendLimitUsd ?? null;
			if (
				typeof body?.allowPaid !== "boolean" ||
				(limit !== null &&
					!(typeof limit === "number" && Number.isFinite(limit) && limit >= 0))
			) {
				throw new ValidationError(
					"allowPaid must be true or false, and spendLimitUsd zero or more, or null",
				);
			}
			await agents.connectClaudeDesktop({
				allowPaid: body.allowPaid,
				spendLimitUsd: body.allowPaid ? (limit as number | null) : null,
			});
			return c.body(null, 204);
		});
		app.delete("/api/agents/claude-desktop", async (c) => {
			await agents.disconnectClaudeDesktop();
			return c.body(null, 204);
		});
	}
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
	app.post("/api/prompts/improve", async (c) => {
		if (!options.improvePrompt) throw new NotFoundError("No writer here");
		const body = await json(c);
		const { prompt, modelIds, editing, language } = body;
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new ValidationError("prompt must be some text");
		}
		if (prompt.length > MAX_IDEA_LENGTH) {
			throw new ValidationError(
				`prompt must be at most ${MAX_IDEA_LENGTH} characters`,
			);
		}
		if (
			!Array.isArray(modelIds) ||
			!modelIds.every((id) => typeof id === "string")
		) {
			throw new ValidationError("modelIds must be a list of model ids");
		}
		if (
			language !== undefined &&
			(typeof language !== "string" ||
				!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language))
		) {
			throw new ValidationError(
				"language must be a language code such as pt-BR",
			);
		}
		const improved = await options.improvePrompt(
			user(c),
			{
				prompt,
				modelIds,
				editing: editing === true,
				...(typeof language === "string" && { language }),
			},
			// The person gave up: the language model stops too.
			c.req.raw.signal,
		);
		return c.json({ prompt: improved });
	});
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
	app.get("/api/settings", async (c) => {
		if (!options.settings) throw new NotFoundError("No settings here");
		return c.json(await options.settings.get(user(c)));
	});
	app.put("/api/settings", async (c) => {
		if (!options.settings) throw new NotFoundError("No settings here");
		const body = await json(c);
		if (
			body.translateWith !== undefined &&
			!isTranslateWith(body.translateWith)
		) {
			throw new ValidationError(
				`translateWith must be one of ${TRANSLATE_WITH.join(", ")}`,
			);
		}
		return c.json(
			await options.settings.set(user(c), {
				...(isTranslateWith(body.translateWith) && {
					translateWith: body.translateWith,
				}),
			}),
		);
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
