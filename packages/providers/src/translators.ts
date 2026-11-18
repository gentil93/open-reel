import {
	CodedError,
	TRANSLATE_INSTRUCTIONS,
	type Translator,
} from "@open-reel/core";
import { type Fetch, refusal, send } from "./http";

/**
 * Puts prompts into English with a language model reached with the person's
 * own key. A prompt costs a fraction of a cent.
 *
 * Model names change often, so each service has a list, cheapest and newest
 * first: a name the service no longer knows (404) moves on to the next one,
 * which is then kept.
 */
export type CloudTranslatorId = "openai" | "google" | "openrouter";

const MODELS: Record<CloudTranslatorId, string[]> = {
	openai: ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"],
	google: [
		"gemini-3.5-flash-lite",
		"gemini-2.5-flash-lite",
		"gemini-2.5-flash",
	],
	openrouter: [
		"google/gemini-3.5-flash-lite",
		"google/gemini-2.5-flash-lite",
		"openai/gpt-5-nano",
		"openai/gpt-4o-mini",
	],
};

const NAMES: Record<CloudTranslatorId, string> = {
	openai: "OpenAI",
	google: "Google Gemini",
	openrouter: "OpenRouter",
};

export class CloudTranslator implements Translator {
	/** The model that answered last, by its place in the list. */
	private model = 0;

	constructor(
		readonly service: CloudTranslatorId,
		private apiKey: string,
		private fetch: Fetch = (url, init) => globalThis.fetch(url, init),
	) {}

	async toEnglish(prompt: string, signal: AbortSignal): Promise<string> {
		const models = MODELS[this.service];
		for (let i = this.model; i < models.length; i++) {
			const response = await this.ask(models[i] as string, prompt, signal);
			// A model this service does not know (any more): the next one.
			if (response.status === 404) continue;
			if (!response.ok) throw await refusal(response, NAMES[this.service]);
			this.model = i;
			const text = await this.read(response);
			if (!text) throw new Error("No translation came back");
			return text;
		}
		throw new CodedError(
			`${NAMES[this.service]} has none of the models open-reel translates with`,
		);
	}

	private ask(
		model: string,
		prompt: string,
		signal: AbortSignal,
	): Promise<Response> {
		if (this.service === "google") {
			return send(
				this.fetch,
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
				{
					method: "POST",
					headers: {
						"x-goog-api-key": this.apiKey,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						systemInstruction: { parts: [{ text: TRANSLATE_INSTRUCTIONS }] },
						contents: [{ role: "user", parts: [{ text: prompt }] }],
					}),
					signal,
				},
				NAMES.google,
			);
		}
		const url =
			this.service === "openai"
				? "https://api.openai.com/v1/chat/completions"
				: "https://openrouter.ai/api/v1/chat/completions";
		return send(
			this.fetch,
			url,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					"content-type": "application/json",
				},
				// Nothing else: newer models refuse settings older ones take,
				// such as the temperature.
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: TRANSLATE_INSTRUCTIONS },
						{ role: "user", content: prompt },
					],
				}),
				signal,
			},
			NAMES[this.service],
		);
	}

	private async read(response: Response): Promise<string | undefined> {
		if (this.service === "google") {
			const body = (await response.json()) as {
				candidates?: { content?: { parts?: { text?: string }[] } }[];
			};
			return body.candidates?.[0]?.content?.parts
				?.map((part) => part.text ?? "")
				.join("")
				.trim();
		}
		const body = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return body.choices?.[0]?.message?.content?.trim();
	}
}
