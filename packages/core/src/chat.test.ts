import { describe, expect, test } from "bun:test";
import {
	type ChatMessage,
	openAiMessages,
	openAiReply,
	openAiTools,
	parseArguments,
} from "./chat";

const picture = {
	type: "image" as const,
	data: "AAAA",
	mimeType: "image/webp",
};

const conversation: ChatMessage[] = [
	{ role: "user", content: [{ type: "text", text: "a fox" }] },
	{
		role: "assistant",
		text: "",
		toolCalls: [{ id: "c1", name: "generate", arguments: { prompt: "a fox" } }],
	},
	{
		role: "tool",
		callId: "c1",
		name: "generate",
		content: [{ type: "text", text: "done: ast_1" }, picture],
	},
	{ role: "assistant", text: "Here it is.", toolCalls: [] },
];

describe("a conversation in OpenAI's format", () => {
	test("carries tool calls and their results, with previews after them", () => {
		const out = openAiMessages("Be brief.", conversation, true);
		expect(out[0]).toEqual({ role: "system", content: "Be brief." });
		expect(out[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "c1",
					type: "function",
					function: { name: "generate", arguments: '{"prompt":"a fox"}' },
				},
			],
		});
		expect(out[3]).toEqual({
			role: "tool",
			tool_call_id: "c1",
			content: "done: ast_1",
		});
		// A tool message holds only text: the picture follows as the user's.
		expect(out[4]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Previews of the results above:" },
				{
					type: "image_url",
					image_url: { url: "data:image/webp;base64,AAAA" },
				},
			],
		});
		expect(out[5]).toMatchObject({ role: "assistant", content: "Here it is." });
	});

	test("leaves pictures out for a model that cannot see them", () => {
		const out = openAiMessages(
			"x",
			[
				{ role: "user", content: [{ type: "text", text: "hi" }, picture] },
				...conversation.slice(1),
			],
			false,
		);
		expect(JSON.stringify(out)).not.toContain("AAAA");
		expect(out).toHaveLength(5);
	});

	test("tools are described as functions", () => {
		expect(
			openAiTools([
				{
					name: "generate",
					description: "Makes",
					parameters: { type: "object" },
				},
			]),
		).toEqual([
			{
				type: "function",
				function: {
					name: "generate",
					description: "Makes",
					parameters: { type: "object" },
				},
			},
		]);
	});
});

describe("an answer in OpenAI's format", () => {
	test("gives the words and the calls, with their arguments read", () => {
		expect(
			openAiReply({
				choices: [
					{
						message: {
							content: " Making it. ",
							tool_calls: [
								{
									id: "x",
									function: {
										name: "generate",
										arguments: '{"prompt":"a fox"}',
									},
								},
								{ function: { name: "list_models", arguments: "not json" } },
							],
						},
					},
				],
			}),
		).toEqual({
			text: "Making it.",
			toolCalls: [
				{ id: "x", name: "generate", arguments: { prompt: "a fox" } },
				{ id: "call_1", name: "list_models", arguments: {} },
			],
		});
	});

	test("without an answer, says so", () => {
		expect(() => openAiReply({ choices: [] })).toThrow("No answer");
	});

	test("arguments that are not an object count as none", () => {
		expect(parseArguments("[1]")).toEqual({});
		expect(parseArguments(undefined)).toEqual({});
	});
});
