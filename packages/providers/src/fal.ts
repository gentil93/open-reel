import type {
	GenerationParams,
	ModelSpec,
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
	ReferenceImage,
} from "@open-reel/core";
import { errorMessage, type Fetch, sleep, toDataUri } from "./http";

const QUEUE = "https://queue.fal.run";
const MAX_POLL_FAILURES = 5;
const RATIOS = [
	"21:9",
	"16:9",
	"3:2",
	"4:3",
	"5:4",
	"1:1",
	"4:5",
	"3:4",
	"2:3",
	"9:16",
];

/** fal's FLUX endpoints take named sizes instead of ratios. */
const FLUX_SIZES: Record<string, string> = {
	"1:1": "square_hd",
	"4:3": "landscape_4_3",
	"16:9": "landscape_16_9",
	"3:4": "portrait_4_3",
	"9:16": "portrait_16_9",
};

interface FalModel {
	spec: ModelSpec;
	/** The endpoint to call; some models use a separate one for editing. */
	endpoint(references: ReferenceImage[]): string;
	input(params: GenerationParams, references: ReferenceImage[]): object;
}

function spec(
	endpoint: string,
	name: string,
	rest: Pick<ModelSpec, "operations" | "capabilities">,
): ModelSpec {
	return {
		id: `fal/${endpoint}`,
		providerId: "fal",
		providerModelId: endpoint,
		name,
		media: "image",
		...rest,
	};
}

function flux(endpoint: string, name: string): FalModel {
	return {
		spec: spec(endpoint, name, {
			operations: ["generate"],
			capabilities: {
				aspectRatios: Object.keys(FLUX_SIZES),
				seed: true,
				maxCount: 4,
				maxReferenceImages: 0,
			},
		}),
		endpoint: () => endpoint,
		input: (params) => ({
			prompt: params.prompt,
			num_images: params.count,
			output_format: "png",
			...(params.aspectRatio && { image_size: FLUX_SIZES[params.aspectRatio] }),
			...(params.seed != null && { seed: params.seed }),
			...params.extras,
		}),
	};
}

const MODELS: FalModel[] = [
	flux("fal-ai/flux/schnell", "FLUX.1 schnell"),
	flux("fal-ai/flux/dev", "FLUX.1 dev"),
	{
		spec: spec("fal-ai/nano-banana", "Nano Banana", {
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: RATIOS,
				seed: true,
				maxCount: 4,
				maxReferenceImages: 4,
			},
		}),
		endpoint: (references) =>
			references.length > 0 ? "fal-ai/nano-banana/edit" : "fal-ai/nano-banana",
		input: (params, references) => ({
			prompt: params.prompt,
			num_images: params.count,
			output_format: "png",
			...(params.aspectRatio && { aspect_ratio: params.aspectRatio }),
			...(params.seed != null && { seed: params.seed }),
			...(references.length > 0 && {
				image_urls: references.map((r) => toDataUri(r.data, r.mime)),
			}),
			...params.extras,
		}),
	},
];

export interface FalHandle {
	statusUrl: string;
	responseUrl: string;
	cancelUrl: string;
}

/** We send the API key to these URLs, so they must point back at fal's queue. */
function queueUrl(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith(`${QUEUE}/`)) {
		throw new Error("fal returned an unexpected request URL");
	}
	return value;
}

export class FalProvider implements ProviderAdapter<FalHandle> {
	id = "fal";
	name = "fal";
	keyEnv = "FAL_KEY";
	requiresKey = true;
	resumable = true;

	constructor(
		private fetch: Fetch = globalThis.fetch,
		private pollMs = 1000,
	) {}

	listModels(): ModelSpec[] {
		return MODELS.map((model) => model.spec);
	}

	private headers(ctx: ProviderContext): Record<string, string> {
		return { authorization: `Key ${ctx.apiKey}` };
	}

	async submit(
		request: ProviderRequest,
		ctx: ProviderContext,
	): Promise<FalHandle> {
		const model = MODELS.find((m) => m.spec.id === request.model.id);
		if (!model) throw new Error(`Unknown fal model: ${request.model.id}`);
		const response = await this.fetch(
			`${QUEUE}/${model.endpoint(request.references)}`,
			{
				method: "POST",
				headers: { ...this.headers(ctx), "content-type": "application/json" },
				body: JSON.stringify(model.input(request.params, request.references)),
				signal: ctx.signal,
			},
		);
		if (!response.ok) throw new Error(await errorMessage(response));
		const body = (await response.json()) as Record<string, unknown>;
		return {
			statusUrl: queueUrl(body.status_url),
			responseUrl: queueUrl(body.response_url),
			cancelUrl: queueUrl(body.cancel_url),
		};
	}

	async *events(
		handle: FalHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		const init = { headers: this.headers(ctx), signal: ctx.signal };
		const statusUrl = queueUrl(handle.statusUrl);
		let failures = 0;
		for (;;) {
			// fal keeps working (and billing) whatever happens to one poll, so a
			// network error or a 429/5xx is retried before giving up on the job.
			const response = await this.fetch(statusUrl, init).catch((error) => {
				if (ctx.signal.aborted) throw error;
				return null;
			});
			if (!response || response.status === 429 || response.status >= 500) {
				if (++failures > MAX_POLL_FAILURES) {
					yield {
						type: "failed",
						error: response
							? await errorMessage(response)
							: "Lost the connection to fal",
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
			const status = (await response.json()) as {
				status: string;
				queue_position?: number;
				error?: string;
			};
			if (status.status === "COMPLETED") {
				// fal also reports failed and canceled requests as COMPLETED.
				if (status.error) {
					yield { type: "failed", error: status.error };
					return;
				}
				break;
			}
			yield {
				type: "progress",
				message:
					status.status === "IN_QUEUE"
						? `In queue (position ${status.queue_position ?? 0})`
						: "Generating",
			};
			await sleep(this.pollMs, ctx.signal);
		}

		const response = await this.fetch(queueUrl(handle.responseUrl), init);
		if (!response.ok) {
			yield { type: "failed", error: await errorMessage(response) };
			return;
		}
		const result = (await response.json()) as {
			images?: { url: string; content_type?: string }[];
		};
		if (!result.images?.length) {
			yield { type: "failed", error: "fal returned no images" };
			return;
		}
		yield {
			type: "completed",
			outputs: result.images.map((image) => ({
				url: image.url,
				mime: image.content_type,
			})),
		};
	}

	async cancel(handle: FalHandle, ctx: ProviderContext): Promise<void> {
		await this.fetch(queueUrl(handle.cancelUrl), {
			method: "PUT",
			headers: this.headers(ctx),
			signal: ctx.signal,
		});
	}
}
