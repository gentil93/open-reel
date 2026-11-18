import {
	type ChatMessage,
	type ChatModel,
	type ChatPart,
	type ChatReply,
	CodedError,
	openAiMessages,
	openAiReply,
	openAiTools,
	type ToolCall,
	type ToolSpec,
} from "@open-reel/core";
import { type Fetch, refusal, send } from "./http";
import type { CloudTranslatorId } from "./translators";

/**
 * The assistant's brain reached with the person's own key: a model that
 * calls tools and looks at pictures. A turn costs about a cent.
 *
 * Model names change often, so each service has a list, best value first:
 * a name the service no longer knows (404) moves on to the next one, which
 * is then kept.
 */
const MODELS: Record<CloudTranslatorId, string[]> = {
	openai: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
	google: ["gemini-3.5-flash", "gemini-2.5-flash"],
	openrouter: [
		"google/gemini-3.5-flash",
		"openai/gpt-5-mini",
		"google/gemini-2.5-flash",
	],
};

const NAMES: Record<CloudTranslatorId, string> = {
	openai: "OpenAI",
	google: "Google Gemini",
	openrouter: "OpenRouter",
};

/** A Gemini part, as sent and answered. */
interface GeminiPart {
	text?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
	functionResponse?: {
		name: string;
		id?: string;
		response: Record<string, unknown>;
	};
	thoughtSignature?: string;
	thought?: boolean;
}

const geminiParts = (parts: ChatPart[]): GeminiPart[] =>
	parts.map((part) =>
		part.type === "text"
			? { text: part.text }
			: { inlineData: { mimeType: part.mimeType, data: part.data } },
	);

/** The conversation in Gemini's format: tool results go as the user's. */
export function geminiContents(messages: ChatMessage[]): unknown[] {
	const contents: { role: string; parts: GeminiPart[] }[] = [];
	const add = (role: string, parts: GeminiPart[]) => {
		const last = contents.at(-1);
		// Results of one turn's calls answer it together.
		if (last && last.role === role && role === "user") {
			last.parts.push(...parts);
		} else {
			contents.push({ role, parts });
		}
	};
	for (const message of messages) {
		if (message.role === "user") {
			add("user", geminiParts(message.content));
		} else if (message.role === "assistant") {
			add("model", [
				...(message.text ? [{ text: message.text }] : []),
				...message.toolCalls.map((call) => ({
					functionCall: { name: call.name, args: call.arguments },
					...(call.signature && { thoughtSignature: call.signature }),
				})),
			]);
		} else {
			const text = message.content
				.filter((p) => p.type === "text")
				.map((p) => (p.type === "text" ? p.text : ""))
				.join("\n");
			add("user", [
				{
					functionResponse: {
						name: message.name,
						response: { result: text },
					},
				},
				...geminiParts(message.content.filter((p) => p.type === "image")),
			]);
		}
	}
	return contents;
}

/** A turn from Gemini's answer. */
export function geminiReply(body: unknown): ChatReply {
	const parts =
		(body as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
			.candidates?.[0]?.content?.parts ?? [];
	const toolCalls: ToolCall[] = [];
	const text: string[] = [];
	for (const part of parts) {
		if (part.thought) continue;
		if (part.functionCall) {
			toolCalls.push({
				id: part.functionCall.id ?? `call_${toolCalls.length}`,
				name: part.functionCall.name,
				arguments: part.functionCall.args ?? {},
				...(part.thoughtSignature && { signature: part.thoughtSignature }),
			});
		} else if (part.text) {
			text.push(part.text);
		}
	}
	return { text: text.join("").trim(), toolCalls };
}

export class CloudChatModel implements ChatModel {
	readonly vision = true;
	/** The model that answered last, by its place in the list. */
	private model = 0;

	constructor(
		readonly service: CloudTranslatorId,
		private apiKey: string,
		private fetch: Fetch = (url, init) => globalThis.fetch(url, init),
	) {}

	async chat(
		instructions: string,
		messages: ChatMessage[],
		tools: ToolSpec[],
		signal: AbortSignal,
	): Promise<ChatReply> {
		const models = MODELS[this.service];
		for (let i = this.model; i < models.length; i++) {
			const response = await this.ask(
				models[i] as string,
				instructions,
				messages,
				tools,
				signal,
			);
			// A model this service does not know (any more): the next one.
			if (response.status === 404) continue;
			if (!response.ok) throw await refusal(response, NAMES[this.service]);
			this.model = i;
			const body = await response.json();
			return this.service === "google" ? geminiReply(body) : openAiReply(body);
		}
		throw new CodedError(
			`${NAMES[this.service]} has none of the models open-reel's assistant uses`,
		);
	}

	private ask(
		model: string,
		instructions: string,
		messages: ChatMessage[],
		tools: ToolSpec[],
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
						systemInstruction: { parts: [{ text: instructions }] },
						contents: geminiContents(messages),
						...(tools.length > 0 && {
							tools: [
								{
									functionDeclarations: tools.map((tool) => ({
										name: tool.name,
										description: tool.description,
										parametersJsonSchema: tool.parameters,
									})),
								},
							],
						}),
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
				// No temperature: newer models refuse settings older ones take.
				body: JSON.stringify({
					model,
					messages: openAiMessages(instructions, messages, true),
					...(tools.length > 0 && { tools: openAiTools(tools) }),
				}),
				signal,
			},
			NAMES[this.service],
		);
	}
}
