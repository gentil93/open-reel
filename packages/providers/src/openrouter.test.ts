import { expect, test } from "bun:test";
import { providerContract } from "./contract";
import { OpenRouterProvider } from "./openrouter";
import { collect, ctx, modelOf as model, params, scripted } from "./testing";

providerContract(new OpenRouterProvider());

const PNG = new Uint8Array([1, 2, 3]); // base64 "AQID"
const reference = { data: PNG, mime: "image/png" };
const IMAGE_URL = {
	type: "image_url",
	image_url: { url: "data:image/png;base64,AQID" },
};
const JOB = "https://openrouter.ai/api/v1/videos/job_1";
const VIDEO = { kind: "video" as const, id: "job_1" };

test("an image is generated in one request, made when the job is followed", async () => {
	const { fetch, calls } = scripted([
		[
			200,
			{
				data: [{ b64_json: "AQID", media_type: "image/webp" }],
				usage: { cost: 0.04 },
			},
		],
	]);
	const openrouter = new OpenRouterProvider(fetch, 0);
	const handle = await openrouter.submit(
		{
			model: model(openrouter, "openrouter/qwen/qwen-image-3-pro"),
			params: params({ aspectRatio: "3:2", seed: 7, count: 2 }),
			references: [reference],
		},
		ctx(),
	);
	expect(calls).toHaveLength(0);
	// Its handle holds whole images, so it is not kept across a restart.
	expect(openrouter.isResumable(handle)).toBe(false);

	expect(await collect(openrouter.events(handle, ctx()))).toEqual([
		{ type: "progress", message: "Generating", stage: "generating" },
		{
			type: "completed",
			outputs: [{ data: PNG, mime: "image/webp" }],
			costUsd: 0.04,
		},
	]);
	expect(calls[0]).toEqual({
		url: "https://openrouter.ai/api/v1/images",
		method: "POST",
		auth: "Bearer k",
		body: {
			model: "qwen/qwen-image-3-pro",
			prompt: "a red fox",
			aspect_ratio: "3:2",
			seed: 7,
			n: 2,
			input_references: [IMAGE_URL],
		},
	});
});

test("an image failure is reported, even inside a successful response", async () => {
	const image = {
		kind: "image" as const,
		body: { model: "x", prompt: "a red fox" },
	};
	const outcome = async (status: number, body: unknown) =>
		(
			await collect(
				new OpenRouterProvider(scripted([[status, body]]).fetch, 0).events(
					image,
					ctx(),
				),
			)
		).at(-1);

	expect(await outcome(402, { error: { message: "Out of credits" } })).toEqual({
		type: "failed",
		error: "Out of credits",
	});
	expect(await outcome(200, { error: { message: "Flagged" } })).toEqual({
		type: "failed",
		error: "Flagged",
	});
	expect(await outcome(200, { data: [] })).toEqual({
		type: "failed",
		error: "OpenRouter returned no images",
	});
});

test("a video is queued, polled, and downloaded through the API with the key", async () => {
	const { fetch, calls } = scripted([
		[202, { id: "job_1", status: "pending" }],
		[200, { status: "pending" }],
		[200, { status: "in_progress" }],
		[200, { status: "completed", usage: { cost: 1.2 } }],
	]);
	const openrouter = new OpenRouterProvider(fetch, 0);
	const handle = await openrouter.submit(
		{
			model: model(openrouter, "openrouter/google/veo-3.1-fast"),
			params: params({ aspectRatio: "16:9", durationSeconds: 8 }),
			references: [reference],
		},
		ctx(),
	);

	expect(calls[0]).toEqual({
		url: "https://openrouter.ai/api/v1/videos",
		method: "POST",
		auth: "Bearer k",
		body: {
			model: "google/veo-3.1-fast",
			prompt: "a red fox",
			aspect_ratio: "16:9",
			duration: 8,
			frame_images: [{ ...IMAGE_URL, frame_type: "first_frame" }],
		},
	});
	expect(handle).toEqual(VIDEO);
	expect(openrouter.isResumable(handle)).toBe(true);
	// The handle must survive being stored and read back.
	const restored = JSON.parse(JSON.stringify(handle));

	expect(await collect(openrouter.events(restored, ctx()))).toEqual([
		{ type: "progress", message: "In queue", stage: "queued" },
		{ type: "progress", message: "Generating", stage: "generating" },
		{
			type: "completed",
			outputs: [
				{
					url: `${JOB}/content?index=0`,
					headers: { authorization: "Bearer k" },
				},
			],
			costUsd: 1.2,
		},
	]);
	expect(calls.slice(1).map((c) => c.url)).toEqual([JOB, JOB, JOB]);
	expect(calls.every((c) => c.auth === "Bearer k")).toBe(true);
});

test("a rejected video submission surfaces OpenRouter's message", async () => {
	const { fetch } = scripted([[401, { error: { message: "No auth" } }]]);
	const openrouter = new OpenRouterProvider(fetch, 0);
	expect(
		openrouter.submit(
			{
				model: model(openrouter, "openrouter/runway/gen-4.5"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("No auth");
});

test("a video job that does not complete is reported as failed", async () => {
	const outcome = async (job: object) =>
		collect(
			new OpenRouterProvider(scripted([[200, job]]).fetch, 0).events(
				VIDEO,
				ctx(),
			),
		);

	expect(await outcome({ status: "failed", error: "Flagged" })).toEqual([
		{ type: "failed", error: "Flagged" },
	]);
	expect(await outcome({ status: "cancelled" })).toEqual([
		{ type: "failed", error: "The video job cancelled" },
	]);
});

test("never builds a request URL from an unexpected job id", async () => {
	const submit = scripted([[202, { id: "../../auth/keys" }]]);
	const openrouter = new OpenRouterProvider(submit.fetch, 0);
	expect(
		openrouter.submit(
			{
				model: model(openrouter, "openrouter/runway/gen-4.5"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("unexpected job id");

	const follow = scripted([]);
	expect(
		collect(
			new OpenRouterProvider(follow.fetch, 0).events(
				{ kind: "video", id: "x/../../auth/keys" },
				ctx(),
			),
		),
	).rejects.toThrow("Invalid OpenRouter job id");
	expect(follow.calls).toHaveLength(0);
});

test("a transient polling error is retried instead of losing the video", async () => {
	const flaky = scripted([
		[502, { error: { message: "Bad gateway" } }],
		[429, { error: { message: "Slow down" } }],
		[200, { status: "completed" }],
	]);
	const events = await collect(
		new OpenRouterProvider(flaky.fetch, 0).events(VIDEO, ctx()),
	);
	expect(events.at(-1)).toMatchObject({ type: "completed" });

	const down = scripted(
		Array.from(
			{ length: 6 },
			() => [503, { error: { message: "Unavailable" } }] as [number, unknown],
		),
	);
	expect(
		await collect(new OpenRouterProvider(down.fetch, 0).events(VIDEO, ctx())),
	).toEqual([{ type: "failed", error: "Unavailable" }]);
	expect(down.calls).toHaveLength(6);
});
