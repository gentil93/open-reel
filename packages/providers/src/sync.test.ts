import { expect, test } from "bun:test";
import { providerContract } from "./contract";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";
import { collect, ctx, modelOf, params, scripted } from "./testing";

providerContract(new OpenAIProvider());
providerContract(new GoogleProvider());

const PNG = new Uint8Array([1, 2, 3]); // base64 "AQID"
const reference = { data: PNG, mime: "image/png" };

test("openai: generates through the generations endpoint", async () => {
	const { fetch, calls } = scripted([
		[
			200,
			{
				data: [{ b64_json: "AQID" }, { b64_json: "AQID" }],
				output_format: "png",
			},
		],
	]);
	const openai = new OpenAIProvider(fetch);
	const handle = await openai.submit({
		model: modelOf(openai, "openai/gpt-image-2"),
		params: params({ aspectRatio: "3:2", count: 2 }),
		references: [],
	});
	expect(calls).toHaveLength(0); // nothing is sent until the job is followed

	expect(await collect(openai.events(handle, ctx()))).toEqual([
		{ type: "progress", message: "Generating" },
		{
			type: "completed",
			outputs: [
				{ data: PNG, mime: "image/png" },
				{ data: PNG, mime: "image/png" },
			],
		},
	]);
	expect(calls[0]).toEqual({
		url: "https://api.openai.com/v1/images/generations",
		method: "POST",
		auth: "Bearer k",
		body: {
			model: "gpt-image-2",
			prompt: "a red fox",
			n: 2,
			size: "1536x1024",
		},
	});
});

test("openai: references switch to the edits endpoint", async () => {
	const { fetch, calls } = scripted([[200, { data: [{ b64_json: "AQID" }] }]]);
	const openai = new OpenAIProvider(fetch);
	const handle = await openai.submit({
		model: modelOf(openai, "openai/gpt-image-2.5-flare"),
		params: params(),
		references: [reference],
	});
	await collect(openai.events(handle, ctx()));
	expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/edits");
	expect(calls[0]?.body).toEqual({
		model: "gpt-image-2.5-flare",
		prompt: "a red fox",
		n: 1,
		images: [{ image_url: "data:image/png;base64,AQID" }],
	});
});

test("openai: an API error becomes a failed job with its message", async () => {
	const { fetch } = scripted([
		[
			400,
			{
				error: {
					message: "Rejected by the safety system",
					code: "moderation_blocked",
				},
			},
		],
	]);
	const openai = new OpenAIProvider(fetch);
	const handle = await openai.submit({
		model: modelOf(openai, "openai/gpt-image-2"),
		params: params(),
		references: [],
	});
	expect(await collect(openai.events(handle, ctx()))).toEqual([
		{ type: "progress", message: "Generating" },
		{ type: "failed", error: "Rejected by the safety system" },
	]);
});

test("google: sends references and ratio, and reads the inline image", async () => {
	const { fetch, calls } = scripted([
		[
			200,
			{
				candidates: [
					{
						finishReason: "STOP",
						content: {
							parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }],
						},
					},
				],
			},
		],
	]);
	const google = new GoogleProvider(fetch);
	const handle = await google.submit({
		model: modelOf(google, "google/gemini-2.5-flash-image"),
		params: params({ aspectRatio: "16:9" }),
		references: [reference],
	});
	expect(await collect(google.events(handle, ctx()))).toEqual([
		{ type: "progress", message: "Generating" },
		{ type: "completed", outputs: [{ data: PNG, mime: "image/png" }] },
	]);
	expect(calls[0]?.url).toBe(
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
	);
	expect(calls[0]?.key).toBe("k");
	expect(calls[0]?.body).toEqual({
		contents: [
			{
				parts: [
					{ inlineData: { mimeType: "image/png", data: "AQID" } },
					{ text: "a red fox" },
				],
			},
		],
		generationConfig: {
			responseModalities: ["IMAGE"],
			imageConfig: { aspectRatio: "16:9" },
		},
	});
});

test("google: a refusal is reported with its reason", async () => {
	const submitAndCollect = async (response: unknown) => {
		const google = new GoogleProvider(scripted([[200, response]]).fetch);
		const handle = await google.submit({
			model: modelOf(google, "google/gemini-3-pro-image"),
			params: params(),
			references: [],
		});
		return (await collect(google.events(handle, ctx()))).at(-1);
	};
	expect(
		await submitAndCollect({
			promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
		}),
	).toEqual({
		type: "failed",
		error: "Gemini returned no image (PROHIBITED_CONTENT)",
	});
	expect(
		await submitAndCollect({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }),
	).toEqual({
		type: "failed",
		error: "Gemini returned no image (IMAGE_SAFETY)",
	});
});
