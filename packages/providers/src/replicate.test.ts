import { expect, test } from "bun:test";
import { providerContract } from "./contract";
import { ReplicateProvider } from "./replicate";
import { collect, ctx, modelOf as model, params, scripted } from "./testing";

providerContract(new ReplicateProvider());

const GET = "https://api.replicate.com/v1/predictions/p1";
const HANDLE = { getUrl: GET, cancelUrl: `${GET}/cancel` };
const CREATED = {
	id: "p1",
	status: "starting",
	urls: { get: GET, cancel: `${GET}/cancel` },
};

test("submits to the model's endpoint and polls the prediction to its outputs", async () => {
	const { fetch, calls } = scripted([
		[201, CREATED],
		[200, { status: "starting" }],
		[200, { status: "processing" }],
		[
			200,
			{
				status: "succeeded",
				output: [
					"https://replicate.delivery/a.png",
					"https://replicate.delivery/b.png",
				],
			},
		],
	]);
	const replicate = new ReplicateProvider(fetch, 0);
	const handle = await replicate.submit(
		{
			model: model(replicate, "replicate/black-forest-labs/flux-schnell"),
			params: params({ aspectRatio: "16:9", seed: 7, count: 2 }),
			references: [],
		},
		ctx(),
	);

	expect(calls[0]).toEqual({
		url: "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
		method: "POST",
		auth: "Bearer k",
		body: {
			input: {
				prompt: "a red fox",
				aspect_ratio: "16:9",
				seed: 7,
				num_outputs: 2,
				output_format: "png",
			},
		},
	});
	// The handle must survive being stored and read back.
	const restored = JSON.parse(JSON.stringify(handle));

	expect(await collect(replicate.events(restored, ctx()))).toEqual([
		{ type: "progress", message: "Starting", stage: "starting" },
		{ type: "progress", message: "Generating", stage: "generating" },
		{
			type: "completed",
			outputs: [
				{ url: "https://replicate.delivery/a.png" },
				{ url: "https://replicate.delivery/b.png" },
			],
		},
	]);
	expect(calls.slice(1).map((c) => c.url)).toEqual([GET, GET, GET]);
	expect(calls.every((c) => c.auth === "Bearer k")).toBe(true);
});

test("a video takes its length and its first frame under the model's own field", async () => {
	const { fetch, calls } = scripted([
		[201, CREATED],
		[201, CREATED],
	]);
	const replicate = new ReplicateProvider(fetch, 0);
	const request = {
		params: params({ aspectRatio: "9:16", durationSeconds: 10 }),
		references: [{ data: new Uint8Array([1, 2, 3]), mime: "image/png" }],
	};
	await replicate.submit(
		{
			...request,
			model: model(replicate, "replicate/kwaivgi/kling-v2.5-turbo-pro"),
		},
		ctx(),
	);
	await replicate.submit(
		{ ...request, model: model(replicate, "replicate/minimax/hailuo-02") },
		ctx(),
	);

	expect(calls[0]?.body).toEqual({
		input: {
			prompt: "a red fox",
			aspect_ratio: "9:16",
			duration: 10,
			start_image: "data:image/png;base64,AQID",
		},
	});
	expect(calls[1]?.body).toMatchObject({
		input: { first_frame_image: "data:image/png;base64,AQID" },
	});
});

test("a single-file result is one output", async () => {
	const { fetch } = scripted([
		[
			200,
			{ status: "succeeded", output: "https://replicate.delivery/clip.mp4" },
		],
	]);
	expect(
		await collect(new ReplicateProvider(fetch, 0).events(HANDLE, ctx())),
	).toEqual([
		{
			type: "completed",
			outputs: [{ url: "https://replicate.delivery/clip.mp4" }],
		},
	]);
});

test("a rejected submission surfaces Replicate's message", async () => {
	const { fetch } = scripted([[401, { detail: "Invalid token" }]]);
	const replicate = new ReplicateProvider(fetch, 0);
	expect(
		replicate.submit(
			{
				model: model(replicate, "replicate/black-forest-labs/flux-1.1-pro"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("Invalid token");
});

test("a prediction that does not succeed is reported as failed", async () => {
	const outcome = async (prediction: object) =>
		collect(
			new ReplicateProvider(scripted([[200, prediction]]).fetch, 0).events(
				HANDLE,
				ctx(),
			),
		);

	expect(await outcome({ status: "failed", error: "NSFW content" })).toEqual([
		{ type: "failed", error: "NSFW content" },
	]);
	expect(await outcome({ status: "canceled" })).toEqual([
		{ type: "failed", error: "The prediction was canceled" },
	]);
	// A result read after Replicate has deleted its files.
	expect(await outcome({ status: "succeeded", output: null })).toEqual([
		{ type: "failed", error: "Replicate returned no result" },
	]);
});

test("cancel calls the prediction's cancel URL", async () => {
	const { fetch, calls } = scripted([[200, { status: "canceled" }]]);
	await new ReplicateProvider(fetch, 0).cancel(HANDLE, ctx());
	expect(calls[0]).toMatchObject({
		url: `${GET}/cancel`,
		method: "POST",
		auth: "Bearer k",
	});
});

test("never sends the key to a URL outside Replicate's API", async () => {
	const submit = scripted([
		[
			201,
			{ ...CREATED, urls: { ...CREATED.urls, get: "https://evil.example/p1" } },
		],
	]);
	const replicate = new ReplicateProvider(submit.fetch, 0);
	expect(
		replicate.submit(
			{
				model: model(replicate, "replicate/black-forest-labs/flux-schnell"),
				params: params(),
				references: [],
			},
			ctx(),
		),
	).rejects.toThrow("unexpected request URL");

	const follow = scripted([]);
	const stored = { ...HANDLE, getUrl: "https://evil.example/p1" };
	expect(
		collect(new ReplicateProvider(follow.fetch, 0).events(stored, ctx())),
	).rejects.toThrow("unexpected request URL");
	expect(
		new ReplicateProvider(follow.fetch, 0).cancel(
			{ ...HANDLE, cancelUrl: "https://evil.example/cancel" },
			ctx(),
		),
	).rejects.toThrow("unexpected request URL");
	expect(follow.calls).toHaveLength(0);
});

test("a transient polling error is retried instead of losing the prediction", async () => {
	const flaky = scripted([
		[502, { detail: "Bad gateway" }],
		[429, { detail: "Slow down" }],
		[
			200,
			{ status: "succeeded", output: ["https://replicate.delivery/a.png"] },
		],
	]);
	const events = await collect(
		new ReplicateProvider(flaky.fetch, 0).events(HANDLE, ctx()),
	);
	expect(events.at(-1)).toMatchObject({ type: "completed" });

	const down = scripted(
		Array.from(
			{ length: 6 },
			() => [503, { detail: "Unavailable" }] as [number, unknown],
		),
	);
	expect(
		await collect(new ReplicateProvider(down.fetch, 0).events(HANDLE, ctx())),
	).toEqual([
		{
			type: "failed",
			error: "Unavailable",
			code: "connectionLost",
			params: { provider: "Replicate" },
		},
	]);
	expect(down.calls).toHaveLength(6);
});
