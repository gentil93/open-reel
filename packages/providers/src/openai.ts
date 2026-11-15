import type {
	ModelSpec,
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "@open-reel/core";
import { errorMessage, type Fetch, toDataUri } from "./http";

const API = "https://api.openai.com/v1/images";

/** Sizes every GPT image model accepts. */
const SIZES: Record<string, string> = {
	"1:1": "1024x1024",
	"3:2": "1536x1024",
	"2:3": "1024x1536",
};

const MODELS: [id: string, name: string][] = [
	["gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"],
	["gpt-image-2.5-flare", "GPT Image 2.5 Flare"],
	["gpt-image-2", "GPT Image 2"],
];

export interface OpenAIHandle {
	path: "generations" | "edits";
	body: Record<string, unknown>;
}

/**
 * OpenAI's Images API answers in a single request, so the work happens in
 * `events` and a job cannot be re-attached after a restart.
 */
export class OpenAIProvider implements ProviderAdapter<OpenAIHandle> {
	id = "openai";
	name = "OpenAI";
	keyEnv = "OPENAI_API_KEY";
	requiresKey = true;
	resumable = false;

	constructor(private fetch: Fetch = globalThis.fetch) {}

	listModels(): ModelSpec[] {
		return MODELS.map(([id, name]) => ({
			id: `openai/${id}`,
			providerId: "openai",
			providerModelId: id,
			name,
			media: "image",
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: Object.keys(SIZES),
				seed: false,
				maxCount: 4,
				maxReferenceImages: 16,
			},
		}));
	}

	async submit(request: ProviderRequest): Promise<OpenAIHandle> {
		const { params, references } = request;
		const body: Record<string, unknown> = {
			model: request.model.providerModelId,
			prompt: params.prompt,
			n: params.count,
			...(params.aspectRatio && { size: SIZES[params.aspectRatio] }),
			...params.extras,
		};
		if (references.length === 0) return { path: "generations", body };
		body.images = references.map((r) => ({
			image_url: toDataUri(r.data, r.mime),
		}));
		return { path: "edits", body };
	}

	async *events(
		handle: OpenAIHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		yield { type: "progress", message: "Generating" };
		const response = await this.fetch(`${API}/${handle.path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ctx.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(handle.body),
			signal: ctx.signal,
		});
		if (!response.ok) {
			yield { type: "failed", error: await errorMessage(response) };
			return;
		}
		const result = (await response.json()) as {
			data?: { b64_json?: string }[];
			output_format?: string;
		};
		const images = (result.data ?? []).flatMap((d) => d.b64_json ?? []);
		if (images.length === 0) {
			yield { type: "failed", error: "OpenAI returned no images" };
			return;
		}
		yield {
			type: "completed",
			outputs: images.map((image) => ({
				data: new Uint8Array(Buffer.from(image, "base64")),
				mime: `image/${result.output_format ?? "png"}`,
			})),
		};
	}
}
