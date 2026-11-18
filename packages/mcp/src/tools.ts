import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JobView, ModelSpec, TurnView } from "@open-reel/core/types";
import { z } from "zod";
import type { OpenReelClient } from "./client";

export interface McpOptions {
	/**
	 * Whether models that cost money (cloud models, on the person's own
	 * keys) may be used. Off, only models on this computer are.
	 */
	allowPaid: boolean;
	/** The most this process may spend on paid models, in US dollars. */
	spendLimitUsd: number | null;
	/** How long a generation is waited for before it is left running. */
	waitMs?: number;
	pollMs?: number;
	version?: string;
}

const TERMINAL = ["succeeded", "failed", "canceled"];
/** Pictures shown to the agent are made this small: enough to judge them. */
const PREVIEW_SIDE = 1024;
/** At most this many pictures are shown in one answer. */
const MAX_PREVIEWS = 8;
/** What open-reel's ids look like; anything else is not sent to it. */
const ID = /^[a-z]+_[A-Za-z0-9]+$/;
const ASSET_ID = /^ast_[A-Za-z0-9]+$/;

const isLocal = (model: ModelSpec) => model.providerId === "local";
const done = (jobs: JobView[]) =>
	jobs.every((job) => TERMINAL.includes(job.status));

const text = (value: string): CallToolResult => ({
	content: [{ type: "text", text: value }],
});
const failure = (value: string): CallToolResult => ({
	...text(value),
	isError: true,
});
const money = (usd: number) => `$${usd.toFixed(2)}`;

/** What a model can do, in a few words an agent can choose by. */
function describe(model: ModelSpec): string {
	const caps = model.capabilities;
	const can = [
		model.operations.includes("generate") && "makes from words",
		caps.maxReferenceImages > 0 &&
			caps.upscale == null &&
			(caps.strength != null
				? "redraws a given picture (strength)"
				: `follows up to ${caps.maxReferenceImages} given picture(s)`),
		caps.mask != null && "redraws only a masked part",
		caps.upscale != null && `upscales a picture ${caps.upscale}x`,
	].filter(Boolean);
	const cost = isLocal(model)
		? "free, runs on this computer"
		: model.pricing?.usdPerOutput != null
			? `about $${model.pricing.usdPerOutput} per ${model.media}`
			: model.pricing?.usdPerSecond != null
				? `about $${model.pricing.usdPerSecond} per second`
				: "paid, price unknown";
	const shapes = caps.aspectRatios.length
		? `; ratios ${caps.aspectRatios.join(", ")}`
		: "";
	const lengths = caps.durations?.length
		? `; lengths ${caps.durations.join(", ")} s`
		: "";
	return `- ${model.id} — ${model.name} (${model.media}): ${can.join(", ")}; ${cost}${shapes}${lengths}`;
}

/** What a job may cost, or null when the model does not say. */
function estimate(
	model: ModelSpec,
	count: number,
	seconds: number | undefined,
): number | null {
	if (isLocal(model)) return 0;
	const price = model.pricing;
	if (price?.usdPerOutput != null) return price.usdPerOutput * count;
	if (price?.usdPerSecond != null) {
		const length = seconds ?? model.capabilities.durations?.[0] ?? 5;
		return price.usdPerSecond * length * count;
	}
	return null;
}

/**
 * The tools an agent uses to make and find pictures and videos with
 * open-reel: on this computer's models by default, on paid ones only when
 * the person allowed it, and never installing models.
 */
export function createMcpServer(
	client: OpenReelClient,
	options: McpOptions,
): McpServer {
	const waitMs = options.waitMs ?? 15 * 60_000;
	const pollMs = options.pollMs ?? 1000;
	/** Spent on turns that have ended. */
	let spentUsd = 0;
	/**
	 * What turns still running may cost, held back from the limit from
	 * before they are made until they end, however they are followed.
	 */
	const held = new Map<string, { usd: number; perJob: Map<string, number> }>();
	const committed = () =>
		spentUsd + [...held.values()].reduce((sum, h) => sum + h.usd, 0);

	/** Counts what an ended turn cost, once, and lets its hold go. */
	function settle(turn: TurnView) {
		const hold = held.get(turn.id);
		if (!hold || !done(turn.jobs)) return;
		held.delete(turn.id);
		for (const job of turn.jobs) {
			if (job.providerId === "local") continue;
			// A paid job that made something and said no price costs what it
			// was expected to.
			spentUsd +=
				job.costUsd ??
				(job.status === "succeeded" ? (hold.perJob.get(job.modelId) ?? 0) : 0);
		}
	}

	const server = new McpServer(
		{ name: "open-reel", version: options.version ?? "0.0.0" },
		{
			instructions:
				"open-reel makes pictures and videos with the models its user installed (local, free) and, when allowed, with paid cloud models on the user's own keys. Call list_models first to see what can be used. Pass returned picture ids (ast_…) back as reference_images to iterate on a result. Models can only be installed by the user, in the open-reel app.",
		},
	);

	/** Models the agent may use now: ready, and paid only when allowed. */
	async function usable(): Promise<ModelSpec[]> {
		const [models, providers] = await Promise.all([
			client.models(),
			client.providers(),
		]);
		const ready = new Set(
			providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
		);
		return models.filter(
			(m) => ready.has(m.providerId) && (options.allowPaid || isLocal(m)),
		);
	}

	/** Picture ids as they are, files read and uploaded. */
	async function references(given: string[]): Promise<string[]> {
		const ids: string[] = [];
		for (const item of given) {
			if (ASSET_ID.test(item)) {
				ids.push(item);
				continue;
			}
			const data = new Uint8Array(await readFile(resolve(item)));
			ids.push((await client.upload(data)).id);
		}
		return ids;
	}

	/** A smaller copy of a picture to show the agent, or null if it cannot. */
	async function preview(data: Uint8Array) {
		try {
			const size = await new Bun.Image(data).metadata();
			const small = await new Bun.Image(data)
				.resize(PREVIEW_SIDE, PREVIEW_SIDE, {
					fit: "inside",
					withoutEnlargement: true,
				})
				.webp({ quality: 85 })
				.bytes();
			return {
				size,
				content: {
					type: "image" as const,
					data: Buffer.from(small).toString("base64"),
					mimeType: "image/webp",
				},
			};
		} catch {
			return null;
		}
	}

	/** Says how a turn's jobs stand, with previews of what they made. */
	async function report(
		jobs: JobView[],
		models: ModelSpec[],
		images: CallToolResult["content"],
	): Promise<string[]> {
		const lines: string[] = [];
		for (const job of jobs) {
			const name =
				models.find((m) => m.id === job.modelId)?.name ?? job.modelId;
			const seconds =
				job.startedAt && job.finishedAt
					? ` in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)} s`
					: "";
			const paid = job.costUsd ? `, $${job.costUsd.toFixed(3)}` : "";
			if (job.status !== "succeeded") {
				lines.push(
					`- ${name}: ${job.status}${job.error ? `: ${job.error}` : ""}`,
				);
				continue;
			}
			const made: string[] = [];
			for (const asset of job.assets) {
				const shown =
					asset.mime.startsWith("image/") && images.length < MAX_PREVIEWS
						? await preview((await client.asset(asset.id)).data)
						: null;
				if (shown) {
					images.push(shown.content);
					made.push(`${asset.id} (${shown.size.width}x${shown.size.height})`);
				} else {
					made.push(`${asset.id} (${asset.mime})`);
				}
			}
			lines.push(`- ${name}: done${seconds}${paid}. ${made.join(", ")}`);
		}
		return lines;
	}

	interface Progress {
		tick(message: string): Promise<void>;
		signal: AbortSignal;
	}

	/** Makes a turn, waits for it, and says what came of it. */
	async function run(
		input: {
			prompt: string;
			modelIds: string[];
			references: string[];
			sessionId?: string;
			aspectRatio?: string;
			count?: number;
			seed?: number;
			durationSeconds?: number;
			strength?: number;
			wait: boolean;
		},
		models: ModelSpec[],
		progress: Progress,
	): Promise<CallToolResult> {
		const chosen = input.modelIds.map(
			(id) => models.find((m) => m.id === id) as ModelSpec,
		);
		const perJob = new Map<string, number>();
		for (const model of chosen) {
			const usd = estimate(model, input.count ?? 1, input.durationSeconds);
			if (usd == null) {
				if (options.spendLimitUsd != null) {
					return failure(
						`${model.name} does not say what it costs, so it cannot be kept within the spending limit.`,
					);
				}
			} else {
				perJob.set(model.id, usd);
			}
		}
		const total = [...perJob.values()].reduce((sum, usd) => sum + usd, 0);
		const limit = options.spendLimitUsd;
		if (limit != null && total > 0 && committed() + total > limit) {
			return failure(
				`This would cost about ${money(total)}, over what is left of the ${money(limit)} limit (${money(Math.max(0, limit - committed()))}).`,
			);
		}
		// Held from now, before anything can wait: a call made meanwhile sees it.
		const hold = { usd: total, perJob };
		const pending = `pending-${crypto.randomUUID()}`;
		held.set(pending, hold);

		let session: { id: string };
		let turn: TurnView;
		try {
			const ids = await references(input.references);
			({ session, turn } = await client.createTurn({
				prompt: input.prompt,
				modelIds: input.modelIds,
				referenceAssetIds: ids,
				...(input.sessionId && { sessionId: input.sessionId }),
				...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
				...(input.count != null && { count: input.count }),
				...(input.seed != null && { seed: input.seed }),
				...(input.durationSeconds != null && {
					durationSeconds: input.durationSeconds,
				}),
				...(input.strength != null && { strength: input.strength }),
			}));
		} catch (error) {
			held.delete(pending);
			throw error;
		}
		held.delete(pending);
		held.set(turn.id, hold);

		let jobs: JobView[] = turn.jobs;
		const started = Date.now();
		let stopped = false;
		try {
			while (input.wait && !done(jobs)) {
				if (Date.now() - started > waitMs || progress.signal.aborted) {
					stopped = true;
					break;
				}
				await Bun.sleep(pollMs);
				const detail = await client.session(session.id);
				const current = detail.turns.find((t) => t.id === turn.id);
				if (current) {
					jobs = current.jobs;
					settle(current);
				}
				const finished = jobs.filter((j) => TERMINAL.includes(j.status));
				await progress.tick(`${finished.length} of ${jobs.length} done`);
			}
		} catch (error) {
			if (!progress.signal.aborted) throw error;
			stopped = true;
		}
		settle({ ...turn, jobs });

		const images: CallToolResult["content"] = [];
		const lines = [
			`Session ${session.id}, turn ${turn.id} (the user can open it at ${client.sessionUrl(session.id)}).`,
			...(await report(jobs, models, images)),
		];
		if (!done(jobs)) {
			lines.push(
				stopped
					? `Stopped waiting; it goes on. Call job_status with session ${session.id} later.`
					: `Started. Call job_status with session ${session.id} for the results.`,
			);
		}
		if (limit != null && committed() > 0) {
			lines.push(
				`Spent or held so far: ${money(committed())} of ${money(limit)}.`,
			);
		}
		return { content: [{ type: "text", text: lines.join("\n") }, ...images] };
	}

	/** Tells the agent the call is alive, when it asked to be told. */
	const progressOf = (extra: {
		_meta?: { progressToken?: string | number };
		signal: AbortSignal;
		sendNotification: (notification: never) => Promise<void>;
	}): Progress => {
		let ticks = 0;
		return {
			signal: extra.signal,
			// Every look, not only when a job ends: clients give up on a call
			// that is silent for long, and a video takes minutes.
			async tick(message) {
				const token = extra._meta?.progressToken;
				if (token == null) return;
				ticks++;
				await extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken: token, progress: ticks, message },
				} as never);
			},
		};
	};

	server.registerTool(
		"list_models",
		{
			title: "List models",
			description:
				"Lists the models that can be used now, with what each can do (make from words, redraw or follow given pictures, redraw a masked part, upscale), its cost, and the ratios and video lengths it accepts. Local models are free and run on the user's computer. Only installed models are listed; the user installs more in the open-reel app.",
			inputSchema: {
				media: z
					.enum(["image", "video"])
					.optional()
					.describe("Only models that make this."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ media }) => {
			const models = (await usable()).filter(
				(m) => media == null || m.media === media,
			);
			if (models.length === 0) {
				return text(
					options.allowPaid
						? "No model can be used now. The user can install local models, or add an API key, in the open-reel app."
						: "No local model is installed. The user can install one from Local models in the open-reel app. (Paid models are off for this connection.)",
				);
			}
			const limit = options.spendLimitUsd;
			const note = options.allowPaid
				? limit != null
					? `Paid models are allowed, up to ${money(limit)} in all (${money(Math.max(0, limit - committed()))} left).`
					: "Paid models are allowed, without a limit."
				: "Only local models are allowed for this connection.";
			return text([...models.map(describe), "", note].join("\n"));
		},
	);

	server.registerTool(
		"generate",
		{
			title: "Make pictures or videos",
			description:
				"Makes pictures or videos from a prompt, waits for them, and returns small previews with their ids. Give several models to compare them on the same prompt. Give reference_images to redraw, edit or animate a picture: ids from earlier results (ast_…) or paths of image files. Pass session_id to keep iterating in the same session. Without models, the first free local model that fits is used.",
			inputSchema: {
				prompt: z.string().min(1).describe("What to make, or what to change."),
				models: z
					.array(z.string())
					.optional()
					.describe("Model ids from list_models; several compare them."),
				reference_images: z
					.array(z.string())
					.optional()
					.describe("Picture ids (ast_…) or image file paths to start from."),
				strength: z
					.number()
					.min(0.05)
					.max(1)
					.optional()
					.describe(
						"For models that redraw a picture: how much it changes, 0.05 to 1.",
					),
				aspect_ratio: z.string().optional().describe('Such as "16:9".'),
				count: z.number().int().min(1).max(8).optional(),
				seed: z.number().int().nonnegative().optional(),
				duration_seconds: z
					.number()
					.int()
					.optional()
					.describe("Video length, for video models."),
				session_id: z.string().regex(ID).optional(),
				wait: z
					.boolean()
					.optional()
					.describe(
						"Wait for the results (default). False returns at once; use job_status later.",
					),
			},
		},
		async (args, extra) => {
			const models = await usable();
			const given = args.reference_images ?? [];
			let ids = args.models ?? [];
			if (ids.length === 0) {
				const fit = models.find(
					(m) =>
						isLocal(m) &&
						m.media === "image" &&
						m.capabilities.upscale == null &&
						(given.length > 0
							? m.capabilities.maxReferenceImages >= given.length
							: m.operations.includes("generate")),
				);
				if (!fit) {
					return failure(
						given.length > 0
							? "No installed local model can start from a picture. Name one with models, or the user can install one in the open-reel app."
							: "No local model is installed. The user can install one from Local models in the open-reel app.",
					);
				}
				ids = [fit.id];
			}
			// Checked before any file is read or uploaded.
			const unknown = ids.filter((id) => !models.some((m) => m.id === id));
			if (unknown.length > 0) {
				return failure(
					`Cannot use ${unknown.join(", ")}: not installed, without a key, or paid while paid models are off. Call list_models for what can be used.`,
				);
			}
			return run(
				{
					prompt: args.prompt,
					modelIds: ids,
					references: given,
					sessionId: args.session_id,
					aspectRatio: args.aspect_ratio,
					count: args.count,
					seed: args.seed,
					durationSeconds: args.duration_seconds,
					strength: args.strength,
					wait: args.wait ?? true,
				},
				models,
				progressOf(extra as never),
			);
		},
	);

	server.registerTool(
		"upscale",
		{
			title: "Upscale a picture",
			description:
				"Makes a picture larger and sharper with an installed upscaler, free and local when one is. Give a picture id (ast_…) or an image file path.",
			inputSchema: {
				image: z
					.string()
					.describe("A picture id (ast_…) or an image file path."),
				session_id: z.string().regex(ID).optional(),
			},
		},
		async (args, extra) => {
			const models = await usable();
			const upscalers = models.filter((m) => m.capabilities.upscale != null);
			// A free one on this computer first.
			const upscaler = upscalers.find(isLocal) ?? upscalers[0];
			if (!upscaler) {
				return failure(
					"No upscaler is installed. The user can install Real-ESRGAN from Local models in the open-reel app.",
				);
			}
			return run(
				{
					prompt: `Upscale ×${upscaler.capabilities.upscale}`,
					modelIds: [upscaler.id],
					references: [args.image],
					sessionId: args.session_id,
					wait: true,
				},
				models,
				progressOf(extra as never),
			);
		},
	);

	server.registerTool(
		"job_status",
		{
			title: "Check a session",
			description:
				"Says how a session's latest turn, and any turn still running, stand, with previews of what is done. For generations started with wait set to false, or that took too long.",
			inputSchema: { session_id: z.string().regex(ID) },
			annotations: { readOnlyHint: true },
		},
		async ({ session_id }) => {
			const [detail, models] = await Promise.all([
				client.session(session_id),
				client.models(),
			]);
			const latest = detail.turns.at(-1);
			if (!latest) return text("The session has nothing in it yet.");
			const shown = detail.turns.filter((t) => t === latest || !done(t.jobs));
			const images: CallToolResult["content"] = [];
			const lines: string[] = [];
			for (const turn of shown) {
				settle(turn);
				lines.push(`Turn ${turn.id}: "${turn.prompt}"`);
				lines.push(...(await report(turn.jobs, models, images)));
			}
			return { content: [{ type: "text", text: lines.join("\n") }, ...images] };
		},
	);

	server.registerTool(
		"search_gallery",
		{
			title: "Search the gallery",
			description:
				"Finds pictures and videos made before, newest first, by words in their prompts. Returns ids to use with get_image, save_image, or as reference_images.",
			inputSchema: {
				query: z.string().optional(),
				limit: z.number().int().min(1).max(50).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ query, limit }) => {
			const items = await client.gallery({ query, limit: limit ?? 20 });
			if (items.length === 0) return text("Nothing found.");
			return text(
				items
					.map(
						(item) =>
							`- ${item.id} — ${item.mime} — ${item.modelId ?? "uploaded"} — ${new Date(item.createdAt).toISOString()} — "${item.prompt ?? ""}"`,
					)
					.join("\n"),
			);
		},
	);

	server.registerTool(
		"get_image",
		{
			title: "Look at a picture",
			description: "Shows a picture by its id, made small enough to look at.",
			inputSchema: { asset_id: z.string().regex(ASSET_ID) },
			annotations: { readOnlyHint: true },
		},
		async ({ asset_id }) => {
			const { data, mime } = await client.asset(asset_id);
			const shown = mime.startsWith("image/") ? await preview(data) : null;
			if (!shown) {
				return text(
					`${asset_id} is a ${mime} that cannot be shown; save_image saves it.`,
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `${asset_id}: ${shown.size.width}x${shown.size.height} ${mime}`,
					},
					shown.content,
				],
			};
		},
	);

	server.registerTool(
		"save_image",
		{
			title: "Save a picture or video",
			description:
				"Writes a picture or video, at full size, to a file. The path must be absolute; an existing file is kept unless overwrite is true.",
			inputSchema: {
				asset_id: z.string().regex(ASSET_ID),
				path: z.string().describe("Absolute path of the file to write."),
				overwrite: z.boolean().optional(),
			},
		},
		async ({ asset_id, path, overwrite }) => {
			if (!isAbsolute(path)) return failure("The path must be absolute.");
			const { data, mime } = await client.asset(asset_id);
			await mkdir(dirname(path), { recursive: true });
			try {
				// Created only if nothing is there, a link included, unless asked.
				await writeFile(path, data, { flag: overwrite ? "w" : "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return failure(`${path} exists; pass overwrite true to replace it.`);
			}
			return text(
				`Saved ${asset_id} (${mime}, ${data.byteLength} bytes) to ${path}`,
			);
		},
	);

	return server;
}
