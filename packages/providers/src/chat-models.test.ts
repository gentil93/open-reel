import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@open-reel/core";
import { CloudChatModel, geminiContents, geminiReply } from "./chat-models";

const signal = () => new AbortController().signal;
const tools = [
	{ name: "generate", description: "Makes", parameters: { type: "object" } },
];

const turn: ChatMessage[] = [
	{ role: "user", content: [{ type: "text", text: "a fox" }] },
	{
		role: "assistant",
		text: "",
		toolCalls: [
			{
				id: "call_0",
				name: "generate",
				arguments: { prompt: "a fox" },
				signature: "sig",
			},
		],
	},
	{
		role: "tool",
		callId: "call_0",
		name: "generate",
		content: [
			{ type: "text", text: "done: ast_1" },
			{ type: "image", data: "AAAA", mimeType: "image/webp" },
		],
	},
];

describe("the assistant on Gemini", () => {
	test("gives back calls with their signature, and results as the user's", () => {
		expect(geminiContents(turn)).toEqual([
			{ role: "user", parts: [{ text: "a fox" }] },
			{
				role: "model",
				parts: [
					{
						functionCall: { name: "generate", args: { prompt: "a fox" } },
						thoughtSignature: "sig",
					},
				],
			},
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							name: "generate",
							response: { result: "done: ast_1" },
						},
					},
					{ inlineData: { mimeType: "image/webp", data: "AAAA" } },
				],
			},
		]);
	});

	test("keeps what the person says next apart from the results", () => {
		const next = geminiContents([
			...turn,
			{ role: "user", content: [{ type: "text", text: "bigger" }] },
		]);
		expect(next).toHaveLength(4);
		expect(next.at(-1)).toEqual({ role: "user", parts: [{ text: "bigger" }] });
	});

	test("reads calls and words, skipping its thoughts", () => {
		expect(
			geminiReply({
				candidates: [
					{
						content: {
							parts: [
								{ text: "thinking…", thought: true },
								{ text: "Making it." },
								{
									functionCall: { name: "generate", args: { prompt: "x" } },
									thoughtSignature: "s1",
								},
							],
						},
					},
				],
			}),
		).toEqual({
			text: "Making it.",
			toolCalls: [
				{
					id: "call_0",
					name: "generate",
					arguments: { prompt: "x" },
					signature: "s1",
				},
			],
		});
	});

	test("sends tools as JSON Schema declarations", async () => {
		const asked: Record<string, unknown>[] = [];
		const model = new CloudChatModel("google", "key", async (url, init) => {
			asked.push({ url, body: JSON.parse(String(init?.body)) });
			return Response.json({
				candidates: [{ content: { parts: [{ text: "ok" }] } }],
			});
		});
		expect((await model.chat("Be brief.", turn, tools, signal())).text).toBe(
			"ok",
		);
		expect(asked[0]?.url).toContain("gemini-3.5-flash:generateContent");
		expect(asked[0]?.body).toMatchObject({
			systemInstruction: { parts: [{ text: "Be brief." }] },
			tools: [
				{
					functionDeclarations: [
						{
							name: "generate",
							description: "Makes",
							parametersJsonSchema: { type: "object" },
						},
					],
				},
			],
		});
	});
});

describe("the assistant on OpenAI and OpenRouter", () => {
	test("moves on to the next model a service no longer knows, and keeps it", async () => {
		const models: string[] = [];
		const model = new CloudChatModel(
			"openrouter",
			"key",
			async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				models.push(body.model);
				// No temperature: newer models refuse it.
				expect(body.temperature).toBeUndefined();
				expect(body.tools).toHaveLength(1);
				if (body.model === "google/gemini-3.5-flash") {
					return Response.json({}, { status: 404 });
				}
				return Response.json({
					choices: [{ message: { content: "ok" } }],
				});
			},
		);
		await model.chat("x", turn, tools, signal());
		await model.chat("x", turn, tools, signal());
		expect(models).toEqual([
			"google/gemini-3.5-flash",
			"openai/gpt-5-mini",
			"openai/gpt-5-mini",
		]);
	});

	test("a refusal says why", async () => {
		const model = new CloudChatModel("openai", "key", async () =>
			Response.json({ error: { message: "bad key" } }, { status: 401 }),
		);
		await expect(model.chat("x", turn, tools, signal())).rejects.toThrow();
	});
});
