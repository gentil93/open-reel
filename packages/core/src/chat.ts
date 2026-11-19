/**
 * A conversation with a language model that can call tools: what the
 * assistant runs on. Each service speaks its own format; these types are the
 * common ground, and the OpenAI format (also spoken by OpenRouter and
 * llama.cpp's server) is converted to here.
 */

export type ChatPart =
	| { type: "text"; text: string }
	/** A picture, base64, for models that can look at pictures. */
	| { type: "image"; data: string; mimeType: string };

export interface ToolCall {
	/** Links the call to its result. */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/**
	 * What some services need given back with the call on the next turn
	 * (Gemini's thought signature). Opaque.
	 */
	signature?: string;
}

export type ChatMessage =
	| { role: "user"; content: ChatPart[] }
	| { role: "assistant"; text: string; toolCalls: ToolCall[] }
	| { role: "tool"; callId: string; name: string; content: ChatPart[] };

/** A tool as the model is told about it. */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema of its arguments, an object. */
	parameters: Record<string, unknown>;
}

export interface ChatReply {
	text: string;
	toolCalls: ToolCall[];
}

export interface ChatModel {
	/** Whether pictures in the conversation reach the model. */
	readonly vision: boolean;
	/** How much of a conversation fits, in characters; unset, all of it. */
	readonly contextChars?: number;
	/** The model's next turn: words, tool calls, or both. */
	chat(
		instructions: string,
		messages: ChatMessage[],
		tools: ToolSpec[],
		signal: AbortSignal,
	): Promise<ChatReply>;
}

const dataUrl = (part: { data: string; mimeType: string }) =>
	`data:${part.mimeType};base64,${part.data}`;

const textOf = (parts: ChatPart[]) =>
	parts
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");

/** In OpenAI's chat format: messages, with pictures only when seen. */
export function openAiMessages(
	instructions: string,
	messages: ChatMessage[],
	vision: boolean,
): Record<string, unknown>[] {
	const userContent = (parts: ChatPart[]) =>
		parts.map((part) =>
			part.type === "text"
				? { type: "text", text: part.text }
				: vision
					? { type: "image_url", image_url: { url: dataUrl(part) } }
					: { type: "text", text: "[a picture you cannot see]" },
		);
	const out: Record<string, unknown>[] = [
		{ role: "system", content: instructions },
	];
	// Pictures a tool returned: a tool message carries only text, so they
	// follow as the user's, once the results of a turn's calls are in.
	let pending: ChatPart[] = [];
	const flush = () => {
		if (pending.length === 0) return;
		out.push({
			role: "user",
			content: [
				{ type: "text", text: "Previews of the results above:" },
				...userContent(pending),
			],
		});
		pending = [];
	};
	for (const message of messages) {
		if (message.role !== "tool") flush();
		if (message.role === "user") {
			out.push({ role: "user", content: userContent(message.content) });
		} else if (message.role === "assistant") {
			out.push({
				role: "assistant",
				content: message.text || null,
				...(message.toolCalls.length > 0 && {
					tool_calls: message.toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					})),
				}),
			});
		} else {
			out.push({
				role: "tool",
				tool_call_id: message.callId,
				content: textOf(message.content) || "(no text)",
			});
			if (vision)
				pending.push(...message.content.filter((p) => p.type === "image"));
		}
	}
	flush();
	return out;
}

/** Tools in OpenAI's format. */
export function openAiTools(tools: ToolSpec[]): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

/** A turn from an OpenAI-format answer. */
export function openAiReply(body: unknown): ChatReply {
	const message = (
		body as {
			choices?: {
				message?: {
					content?: string | null;
					tool_calls?: {
						id?: string;
						function?: { name?: string; arguments?: string };
					}[];
				};
			}[];
		}
	).choices?.[0]?.message;
	if (!message) throw new Error("No answer came back");
	const toolCalls = (message.tool_calls ?? []).flatMap((call, i) => {
		const name = call.function?.name;
		if (!name) return [];
		return [
			{
				id: call.id || `call_${i}`,
				name,
				arguments: parseArguments(call.function?.arguments),
			},
		];
	});
	return { text: (message.content ?? "").trim(), toolCalls };
}

/** A call's arguments, `{}` when the model wrote something unreadable. */
export function parseArguments(
	raw: string | undefined,
): Record<string, unknown> {
	if (!raw) return {};
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value)
			? value
			: {};
	} catch {
		return {};
	}
}

/** A picture to look at, base64, and which one it is. */
export interface SeenPicture {
	data: string;
	mimeType: string;
	label?: string;
}

/**
 * Something that looks at pictures for a language model that cannot: what
 * each shows, judged against what the person asked for.
 */
export interface Eyes {
	look(
		pictures: SeenPicture[],
		asked: string,
		signal: AbortSignal,
	): Promise<string>;
}
