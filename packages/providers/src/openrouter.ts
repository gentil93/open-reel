import type {
	ModelSpec,
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "@open-reel/core";
import { errorMessage, type Fetch, sleep, toDataUri } from "./http";

const API = "https://openrouter.ai/api/v1";
const MAX_POLL_FAILURES = 5;

/** Capabilities as OpenRouter's model listings report them. */
const IMAGE_MODELS: [
	id: string,
	name: string,
	ratios: string[],
	maxCount: number,
	maxReferences: number,
	seed: boolean,
][] = [
	[
		"google/gemini-nano-banana-2.1",
		"Nano Banana 2.1",
		["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
		1,
		14,
		false,
	],
	[
		"openai/gpt-image-2.6-sunburst",
		"GPT Image 2.6 Sunburst",
		["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
		4,
		16,
		false,
	],
	[
		"openai/gpt-image-2.6-flare",
		"GPT Image 2.6 Flare",
		["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
		4,
		16,
		false,
	],
	[
		"black-forest-labs/flux-3-image",
		"FLUX 3 Image",
		["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"],
		1,
		10,
		false,
	],
	[
		"bytedance-seed/seedream-5-5",
		"Seedream 5.5",
		["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
		1,
		10,
		true,
	],
	[
		"qwen/qwen-image-3-pro",
		"Qwen Image 3 Pro",
		["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"],
		4,
		3,
		true,
	],
];

/** Every one of these takes a first frame. */
const VIDEO_MODELS: [
	id: string,
	name: string,
	ratios: string[],
	durations: number[],
	seed: boolean,
][] = [
	["google/veo-3.1-fast", "Veo 3.1 Fast", ["16:9", "9:16"], [4, 6, 8], true],
	["google/veo-3.1-lite", "Veo 3.1 Lite", ["16:9", "9:16"], [4, 6, 8], true],
	[
		"kwaivgi/kling-v3.0-std",
		"Kling 3.0 Standard",
		["16:9", "9:16", "1:1"],
		[5, 10, 15],
		false,
	],
	[
		"alibaba/wan-3.0",
		"Wan 3.0",
		["16:9", "4:3", "1:1", "3:4", "9:16"],
		[5, 10, 15],
		true,
	],
	[
		"minimax/hailuo-3",
		"Hailuo H3",
		["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
		[5, 10, 15],
		false,
	],
	["runway/gen-4.5", "Runway Gen-4.5", ["16:9", "9:16"], [5, 10], true],
];

export type OpenRouterHandle =
	/** Images answer in one request, made when the job is followed. */
	| { kind: "image"; body: Record<string, unknown> }
	/** Videos are queued on OpenRouter's side. */
	| { kind: "video"; id: string };

interface VideoJob {
	id?: unknown;
	status?: string;
	error?: unknown;
	usage?: { cost?: number | null };
}

export class OpenRouterProvider implements ProviderAdapter<OpenRouterHandle> {
	id = "openrouter";
	name = "OpenRouter";
	keyEnv = "OPENROUTER_API_KEY";
	requiresKey = true;
	resumable = false;

	constructor(
		private fetch: Fetch = globalThis.fetch,
		private pollMs = 3000,
	) {}

	isResumable(handle: OpenRouterHandle): boolean {
		return handle.kind === "video";
	}

	listModels(): ModelSpec[] {
		const base = (id: string, name: string) => ({
			id: `openrouter/${id}`,
			providerId: "openrouter",
			providerModelId: id,
			name,
			operations: ["generate", "edit"] as ModelSpec["operations"],
		});
		return [
			...IMAGE_MODELS.map(
				([id, name, aspectRatios, maxCount, maxReferenceImages, seed]) => ({
					...base(id, name),
					media: "image" as const,
					capabilities: { aspectRatios, seed, maxCount, maxReferenceImages },
				}),
			),
			...VIDEO_MODELS.map(([id, name, aspectRatios, durations, seed]) => ({
				...base(id, name),
				media: "video" as const,
				capabilities: {
					aspectRatios,
					seed,
					maxCount: 1,
					maxReferenceImages: 1,
					durations,
				},
			})),
		];
	}

	private headers(ctx: ProviderContext): Record<string, string> {
		return { authorization: `Bearer ${ctx.apiKey}` };
	}

	private post(path: string, body: unknown, ctx: ProviderContext) {
		return this.fetch(`${API}/${path}`, {
			method: "POST",
			headers: { ...this.headers(ctx), "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: ctx.signal,
		});
	}

	async submit(
		request: ProviderRequest,
		ctx: ProviderContext,
	): Promise<OpenRouterHandle> {
		const { model, params, references } = request;
		const images = references.map((r) => ({
			type: "image_url",
			image_url: { url: toDataUri(r.data, r.mime) },
		}));
		const body: Record<string, unknown> = {
			model: model.providerModelId,
			prompt: params.prompt,
			...(params.aspectRatio && { aspect_ratio: params.aspectRatio }),
			...(params.seed != null && { seed: params.seed }),
		};

		if (model.media === "image") {
			if (params.count > 1) body.n = params.count;
			if (images.length > 0) body.input_references = images;
			return { kind: "image", body: { ...body, ...params.extras } };
		}

		if (params.durationSeconds != null) body.duration = params.durationSeconds;
		if (images.length > 0) {
			body.frame_images = images.map((image) => ({
				...image,
				frame_type: "first_frame",
			}));
		}
		const response = await this.post(
			"videos",
			{ ...body, ...params.extras },
			ctx,
		);
		if (!response.ok) throw new Error(await errorMessage(response));
		const job = (await response.json()) as VideoJob;
		// The id becomes part of a URL the API key is sent to.
		if (typeof job.id !== "string" || !/^[\w-]+$/.test(job.id)) {
			throw new Error("OpenRouter returned an unexpected job id");
		}
		return { kind: "video", id: job.id };
	}

	events(
		handle: OpenRouterHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		return handle.kind === "image"
			? this.image(handle.body, ctx)
			: this.video(handle.id, ctx);
	}

	private async *image(
		body: Record<string, unknown>,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		yield { type: "progress", message: "Generating" };
		const response = await this.post("images", body, ctx);
		if (!response.ok) {
			yield { type: "failed", error: await errorMessage(response) };
			return;
		}
		const result = (await response.json()) as {
			data?: { b64_json?: string; media_type?: string }[];
			usage?: { cost?: number | null };
			error?: { message?: string };
		};
		const images = (result.data ?? []).filter((d) => d.b64_json);
		if (images.length === 0) {
			// OpenRouter can report a provider's failure inside a 200 response.
			yield {
				type: "failed",
				error: result.error?.message ?? "OpenRouter returned no images",
			};
			return;
		}
		yield {
			type: "completed",
			outputs: images.map((image) => ({
				data: new Uint8Array(Buffer.from(image.b64_json as string, "base64")),
				mime: image.media_type ?? "image/png",
			})),
			...(result.usage?.cost != null && { costUsd: result.usage.cost }),
		};
	}

	private async *video(
		id: string,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		if (!/^[\w-]+$/.test(id)) throw new Error("Invalid OpenRouter job id");
		const url = `${API}/videos/${id}`;
		const init = { headers: this.headers(ctx), signal: ctx.signal };
		let failures = 0;
		for (;;) {
			// The job keeps running (and billing) whatever happens to one poll, so
			// a network error or a 429/5xx is retried before giving up on it.
			const response = await this.fetch(url, init).catch((error) => {
				if (ctx.signal.aborted) throw error;
				return null;
			});
			if (!response || response.status === 429 || response.status >= 500) {
				if (++failures > MAX_POLL_FAILURES) {
					yield {
						type: "failed",
						error: response
							? await errorMessage(response)
							: "Lost the connection to OpenRouter",
					};
					return;
				}
				await sleep(this.pollMs * 2 ** failures, ctx.signal);
				continue;
			}
			failures = 0;
			if (!response.ok) {
				yield { type: "failed", error: await errorMessage(response) };
				return;
			}
			const job = (await response.json()) as VideoJob;
			if (job.status === "completed") {
				yield {
					type: "completed",
					// Downloaded through the API, which needs the key; the signed
					// links in the response expire.
					outputs: [
						{ url: `${url}/content?index=0`, headers: this.headers(ctx) },
					],
					...(job.usage?.cost != null && { costUsd: job.usage.cost }),
				};
				return;
			}
			if (job.status !== "pending" && job.status !== "in_progress") {
				yield {
					type: "failed",
					error:
						typeof job.error === "string" && job.error
							? job.error
							: `The video job ${job.status ?? "ended without a status"}`,
				};
				return;
			}
			yield {
				type: "progress",
				message: job.status === "pending" ? "In queue" : "Generating",
			};
			await sleep(this.pollMs, ctx.signal);
		}
	}
}
