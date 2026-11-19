import type {
	ModelSpec,
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "@hatchlight/core";
import {
	BUSY_WHILE_WAITING,
	type Fetch,
	failedEvent,
	refusal,
	send,
} from "./http";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const RATIOS = [
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
];

const MODELS: [id: string, name: string, maxReferences: number][] = [
	["gemini-3-pro-image", "Nano Banana Pro", 14],
	["gemini-2.5-flash-image", "Nano Banana", 3],
];

export interface GoogleHandle {
	model: string;
	body: Record<string, unknown>;
}

interface GenerateContentResponse {
	candidates?: {
		finishReason?: string;
		content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] };
	}[];
	promptFeedback?: { blockReason?: string };
}

/**
 * Gemini image models through `generateContent`. Each request returns one
 * image and finishes in a single call, so jobs are not resumable.
 */
export class GoogleProvider implements ProviderAdapter<GoogleHandle> {
	id = "google";
	name = "Google Gemini";
	keyEnv = "GEMINI_API_KEY";
	requiresKey = true;
	resumable = false;

	constructor(private fetch: Fetch = globalThis.fetch) {}

	listModels(): ModelSpec[] {
		return MODELS.map(([id, name, maxReferenceImages]) => ({
			id: `google/${id}`,
			providerId: "google",
			providerModelId: id,
			name,
			media: "image",
			operations: ["generate", "edit"],
			capabilities: {
				aspectRatios: RATIOS,
				seed: false,
				maxCount: 1,
				maxReferenceImages,
			},
		}));
	}

	async submit(request: ProviderRequest): Promise<GoogleHandle> {
		const { params, references } = request;
		return {
			model: request.model.providerModelId,
			body: {
				contents: [
					{
						parts: [
							...references.map((r) => ({
								inlineData: {
									mimeType: r.mime,
									data: Buffer.from(r.data).toString("base64"),
								},
							})),
							{ text: params.prompt },
						],
					},
				],
				generationConfig: {
					responseModalities: ["IMAGE"],
					...(params.aspectRatio && {
						imageConfig: { aspectRatio: params.aspectRatio },
					}),
					...params.extras,
				},
			},
		};
	}

	async *events(
		handle: GoogleHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		yield { type: "progress", message: "Generating", stage: "generating" };
		const response = await send(
			this.fetch,
			`${API}/${handle.model}:generateContent`,
			{
				method: "POST",
				headers: {
					"x-goog-api-key": ctx.apiKey ?? "",
					"content-type": "application/json",
				},
				body: JSON.stringify(handle.body),
				signal: ctx.signal,
			},
			this.name,
		);
		if (!response.ok) {
			yield failedEvent(await refusal(response, this.name, BUSY_WHILE_WAITING));
			return;
		}
		const result = (await response.json()) as GenerateContentResponse;
		const candidate = result.candidates?.[0];
		const images = (candidate?.content?.parts ?? []).flatMap(
			(part) => part.inlineData ?? [],
		);
		if (images.length === 0) {
			// A refusal is a normal 200 response with a reason instead of an image.
			const reason =
				result.promptFeedback?.blockReason ?? candidate?.finishReason;
			yield {
				type: "failed",
				error: reason
					? `Gemini returned no image (${reason})`
					: "Gemini returned no image",
			};
			return;
		}
		yield {
			type: "completed",
			outputs: images.map((image) => ({
				data: new Uint8Array(Buffer.from(image.data, "base64")),
				mime: image.mimeType,
			})),
		};
	}
}
