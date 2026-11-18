import type {
	GenerationParams,
	ModelSpec,
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
	ReferenceImage,
} from "@open-reel/core";
import {
	errorMessage,
	type Fetch,
	refusal,
	send,
	sleep,
	toDataUri,
} from "./http";

const API = "https://api.replicate.com/v1";
const MAX_POLL_FAILURES = 5;
const IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

interface ReplicateModel {
	spec: ModelSpec;
	input(params: GenerationParams, references: ReferenceImage[]): object;
}

function spec(
	slug: string,
	name: string,
	media: ModelSpec["media"],
	capabilities: ModelSpec["capabilities"],
): ModelSpec {
	return {
		id: `replicate/${slug}`,
		providerId: "replicate",
		providerModelId: slug,
		name,
		media,
		operations:
			capabilities.maxReferenceImages > 0 ? ["generate", "edit"] : ["generate"],
		capabilities,
	};
}

/** The fields most models share, under the names Replicate's models use. */
function common(params: GenerationParams) {
	return {
		prompt: params.prompt,
		...(params.aspectRatio && { aspect_ratio: params.aspectRatio }),
		...(params.seed != null && { seed: params.seed }),
	};
}

/** A video model taking `duration` in seconds and, optionally, a first frame. */
function video(
	slug: string,
	name: string,
	options: {
		ratios: string[];
		durations: number[];
		seed: boolean;
		/** The name of the first-frame input. */
		imageField: string;
	},
): ReplicateModel {
	return {
		spec: spec(slug, name, "video", {
			aspectRatios: options.ratios,
			seed: options.seed,
			maxCount: 1,
			maxReferenceImages: 1,
			durations: options.durations,
		}),
		input: (params, [first]) => ({
			...common(params),
			...(params.durationSeconds != null && {
				duration: params.durationSeconds,
			}),
			...(first && { [options.imageField]: toDataUri(first.data, first.mime) }),
			...params.extras,
		}),
	};
}

const MODELS: ReplicateModel[] = [
	{
		spec: spec("black-forest-labs/flux-schnell", "FLUX.1 schnell", "image", {
			aspectRatios: IMAGE_RATIOS,
			seed: true,
			maxCount: 4,
			maxReferenceImages: 0,
		}),
		input: (params) => ({
			...common(params),
			num_outputs: params.count,
			output_format: "png",
			...params.extras,
		}),
	},
	{
		spec: spec("black-forest-labs/flux-1.1-pro", "FLUX 1.1 Pro", "image", {
			aspectRatios: IMAGE_RATIOS,
			seed: true,
			maxCount: 1,
			maxReferenceImages: 0,
		}),
		input: (params) => ({
			...common(params),
			output_format: "png",
			...params.extras,
		}),
	},
	video("google/veo-3.1-fast", "Veo 3.1 Fast", {
		ratios: ["16:9", "9:16"],
		durations: [4, 6, 8],
		seed: true,
		imageField: "image",
	}),
	video("kwaivgi/kling-v2.5-turbo-pro", "Kling 2.5 Turbo Pro", {
		ratios: ["16:9", "9:16", "1:1"],
		durations: [5, 10],
		seed: false,
		imageField: "start_image",
	}),
	video("minimax/hailuo-02", "Hailuo 02", {
		ratios: [],
		durations: [6, 10],
		seed: false,
		imageField: "first_frame_image",
	}),
	{
		spec: spec("wan-video/wan-2.2-t2v-fast", "Wan 2.2 Fast", "video", {
			aspectRatios: ["16:9", "9:16"],
			seed: true,
			maxCount: 1,
			maxReferenceImages: 0,
		}),
		input: (params) => ({ ...common(params), ...params.extras }),
	},
];

export interface ReplicateHandle {
	getUrl: string;
	cancelUrl: string;
}

interface Prediction {
	status: string;
	output?: unknown;
	error?: unknown;
	urls?: { get?: unknown; cancel?: unknown };
}

/** We send the API key to these URLs, so they must point back at Replicate. */
function apiUrl(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith(`${API}/`)) {
		throw new Error("Replicate returned an unexpected request URL");
	}
	return value;
}

export class ReplicateProvider implements ProviderAdapter<ReplicateHandle> {
	id = "replicate";
	name = "Replicate";
	keyEnv = "REPLICATE_API_TOKEN";
	requiresKey = true;
	resumable = true;

	constructor(
		private fetch: Fetch = globalThis.fetch,
		private pollMs = 1500,
	) {}

	listModels(): ModelSpec[] {
		return MODELS.map((model) => model.spec);
	}

	private headers(ctx: ProviderContext): Record<string, string> {
		return { authorization: `Bearer ${ctx.apiKey}` };
	}

	async submit(
		request: ProviderRequest,
		ctx: ProviderContext,
	): Promise<ReplicateHandle> {
		const model = MODELS.find((m) => m.spec.id === request.model.id);
		if (!model) throw new Error(`Unknown Replicate model: ${request.model.id}`);
		const response = await send(
			this.fetch,
			`${API}/models/${model.spec.providerModelId}/predictions`,
			{
				method: "POST",
				headers: { ...this.headers(ctx), "content-type": "application/json" },
				body: JSON.stringify({
					input: model.input(request.params, request.references),
				}),
				signal: ctx.signal,
			},
			this.name,
		);
		if (!response.ok) throw await refusal(response, this.name);
		const prediction = (await response.json()) as Prediction;
		return {
			getUrl: apiUrl(prediction.urls?.get),
			cancelUrl: apiUrl(prediction.urls?.cancel),
		};
	}

	async *events(
		handle: ReplicateHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		const init = { headers: this.headers(ctx), signal: ctx.signal };
		const getUrl = apiUrl(handle.getUrl);
		let failures = 0;
		for (;;) {
			// The prediction keeps running (and billing) whatever happens to one
			// poll, so a network error or a 429/5xx is retried before giving up.
			const response = await this.fetch(getUrl, init).catch((error) => {
				if (ctx.signal.aborted) throw error;
				return null;
			});
			if (!response || response.status === 429 || response.status >= 500) {
				if (++failures > MAX_POLL_FAILURES) {
					yield {
						type: "failed",
						error: response
							? await errorMessage(response)
							: "Lost the connection to Replicate",
						// The job may still finish there: trying again follows it.
						code: "connectionLost",
						params: { provider: this.name },
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
			const prediction = (await response.json()) as Prediction;
			if (prediction.status === "succeeded") {
				const urls = [prediction.output]
					.flat()
					.filter((value): value is string => typeof value === "string");
				if (urls.length === 0) {
					// Replicate deletes results an hour after the prediction finishes.
					yield { type: "failed", error: "Replicate returned no result" };
					return;
				}
				yield { type: "completed", outputs: urls.map((url) => ({ url })) };
				return;
			}
			if (
				prediction.status !== "starting" &&
				prediction.status !== "processing"
			) {
				yield {
					type: "failed",
					error:
						typeof prediction.error === "string" && prediction.error
							? prediction.error
							: `The prediction was ${prediction.status}`,
				};
				return;
			}
			yield {
				type: "progress",
				...(prediction.status === "starting"
					? { message: "Starting", stage: "starting" as const }
					: { message: "Generating", stage: "generating" as const }),
			};
			await sleep(this.pollMs, ctx.signal);
		}
	}

	async cancel(handle: ReplicateHandle, ctx: ProviderContext): Promise<void> {
		await this.fetch(apiUrl(handle.cancelUrl), {
			method: "POST",
			headers: this.headers(ctx),
			signal: ctx.signal,
		});
	}
}
