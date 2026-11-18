import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeProvider,
	type LocalEngineSpec,
	type LocalModelSpec,
} from "@open-reel/core";
import { zip } from "@open-reel/core/testing";
import {
	createApp,
	createRuntime,
	DataDirInUseError,
	type Runtime,
} from "./index";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const WEIGHTS = new TextEncoder().encode("the weights of a small model");
const ENGINE = zip([{ name: "run", data: new TextEncoder().encode("run") }]);
const hash = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");
const ENGINES: LocalEngineSpec[] = [
	{
		id: "run",
		name: "Runner",
		homepage: "https://engine.example",
		license: "MIT",
		builds: [
			{
				id: "run-cpu",
				engine: "run",
				version: "1",
				backend: "cpu",
				os: "linux",
				arch: "x64",
				executable: "run",
				files: [
					{
						name: "run.zip",
						url: "https://models.example/run.zip",
						size: ENGINE.byteLength,
						sha256: hash(ENGINE),
					},
				],
			},
		],
	},
];
const LOCAL_MODEL: LocalModelSpec = {
	id: "tiny",
	name: "Tiny",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "A model for tests.",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants: [
		{
			id: "full",
			label: "Full",
			engine: "run",
			memoryBytes: 1,
			files: [
				{
					name: "tiny.safetensors",
					url: "https://models.example/tiny.safetensors",
					size: WEIGHTS.byteLength,
					sha256: hash(WEIGHTS),
					role: "model",
				},
			],
		},
	],
	demos: [{ url: "https://models.example/demo.png", media: "image" }],
	defaults: { size: 512, aspectRatios: ["1:1"], steps: 1, cfgScale: 1 },
};
/** Stands in for the hosts models and their demos are downloaded from. */
const download = async (url: string) =>
	new Response(
		url.endsWith(".png") ? PNG : url.endsWith(".zip") ? ENGINE : WEIGHTS,
	);

async function setup() {
	// A nested path that does not exist yet, as on a first run.
	const root = await mkdtemp(join(tmpdir(), "open-reel-server-"));
	const dir = join(root, "data", "open-reel");
	const provider = new FakeProvider();
	const runtime: Runtime = await createRuntime({
		dataDir: dir,
		providers: [provider],
		localModels: [LOCAL_MODEL],
		engines: ENGINES,
		hardware: async () => ({
			os: "linux",
			arch: "x64",
			wsl: false,
			memoryBytes: 8 * 1024 ** 3,
			gpus: [],
		}),
		// The test engine is not a real program.
		checkEngine: async () => null,
		fetch: download,
	});
	cleanups.push(async () => {
		await runtime.engine.idle();
		runtime.close();
		await rm(root, { recursive: true });
	});
	await runtime.start();
	const app = createApp(runtime);
	const call = (path: string, init?: RequestInit) =>
		app.request(`http://localhost:4096${path}`, init);
	const post = (path: string, body: unknown, method = "POST") =>
		call(path, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { call, post, runtime, provider, dir };
}

test("a turn is created, runs, and shows up in its session", async () => {
	const { call, post, runtime } = await setup();
	expect(((await (await call("/api/models")).json()) as unknown[]).length).toBe(
		2,
	);

	const created = await post("/api/turns", {
		prompt: "a red fox",
		modelIds: ["fake/alpha", "fake/beta"],
	});
	expect(created.status).toBe(201);
	const { session } = (await created.json()) as { session: { id: string } };
	await runtime.engine.idle();

	const sessions = (await (await call("/api/sessions")).json()) as unknown[];
	expect(sessions).toHaveLength(1);
	const detail = (await (await call(`/api/sessions/${session.id}`)).json()) as {
		turns: { jobs: { status: string; assets: { id: string }[] }[] }[];
	};
	const jobs = detail.turns[0]?.jobs ?? [];
	expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);

	const image = await call(`/api/assets/${jobs[0]?.assets[0]?.id}`);
	expect(image.status).toBe(200);
	expect(image.headers.get("content-type")).toBe("image/bmp");
	// Stored files come from providers; they must never run as a page.
	expect(image.headers.get("content-security-policy")).toBe("sandbox");
	expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0);

	const gallery = (await (
		await call("/api/gallery?query=fox")
	).json()) as unknown[];
	expect(gallery).toHaveLength(2);

	expect(
		(await call(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
	).toBe(204);
	expect((await call(`/api/sessions/${session.id}`)).status).toBe(404);
});

test("invalid requests get a 400 with the reason", async () => {
	const { post, call } = await setup();
	for (const body of [
		{ prompt: "x", modelIds: [] },
		{ prompt: "x", modelIds: ["nope/x"] },
		{ prompt: "", modelIds: ["fake/alpha"] },
		{ prompt: "x", modelIds: "fake/alpha" },
		{ prompt: "x", modelIds: ["fake/alpha"], count: "many" },
		[],
	]) {
		const response = await post("/api/turns", body);
		expect(response.status).toBe(400);
		expect(typeof ((await response.json()) as { error: string }).error).toBe(
			"string",
		);
	}
	const unknown = await post("/api/turns", {
		prompt: "x",
		modelIds: ["nope/x"],
	});
	expect(await unknown.json()).toEqual({
		error: "Unknown model: nope/x",
		code: "unknownModel",
		params: { model: "nope/x" },
	});
	expect((await call("/api/gallery?limit=0")).status).toBe(400);
	expect((await call("/api/gallery?before=5")).status).toBe(400);
	expect((await call("/api/sessions/missing")).status).toBe(404);
	expect((await call("/api/nothing-here")).status).toBe(404);
	expect(
		(await call("/api/jobs/missing/cancel", { method: "POST" })).status,
	).toBe(404);
});

test("uploads are stored and usable as references", async () => {
	const { call, post, runtime } = await setup();
	const upload = await call("/api/assets", {
		method: "POST",
		headers: { "content-type": "image/png" },
		body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
	});
	expect(upload.status).toBe(201);
	const asset = (await upload.json()) as { id: string; mime: string };
	expect(asset.mime).toBe("image/png");

	const turn = await post("/api/turns", {
		prompt: "restyle",
		modelIds: ["fake/alpha"],
		referenceAssetIds: [asset.id],
	});
	expect(turn.status).toBe(201);
	await runtime.engine.idle();

	const rejected = await call("/api/assets", {
		method: "POST",
		// The claimed type is ignored; the bytes decide.
		headers: { "content-type": "image/png" },
		body: "<script>",
	});
	expect(rejected.status).toBe(400);
});

test("keys can be set and removed but are never sent back", async () => {
	const { call, post } = await setup();
	expect(
		(await post("/api/providers/fake/key", { key: "s3cret" }, "PUT")).status,
	).toBe(204);
	const text = await (await call("/api/providers")).text();
	expect(JSON.parse(text)[0].hasKey).toBe(true);
	expect(text).not.toContain("s3cret");
	expect(
		(await call("/api/providers/fake/key", { method: "DELETE" })).status,
	).toBe(204);
	expect(
		(await post("/api/providers/nope/key", { key: "x" }, "PUT")).status,
	).toBe(404);
});

test("requests from other websites or hosts are refused", async () => {
	const { call, runtime } = await setup();
	const crossSite = await call("/api/turns", {
		method: "POST",
		headers: { origin: "https://evil.example", "content-type": "text/plain" },
		body: JSON.stringify({ prompt: "x", modelIds: ["fake/alpha"] }),
	});
	expect(crossSite.status).toBe(403);

	const rebound = await createApp(runtime).request(
		"http://evil.example/api/models",
	);
	expect(rebound.status).toBe(403);

	// Sandboxed frames and file:// pages send a literal "null" origin.
	const opaque = await call("/api/models", { headers: { origin: "null" } });
	expect(opaque.status).toBe(403);

	const sameOrigin = await call("/api/models", {
		headers: { origin: "http://localhost:4096" },
	});
	expect(sameOrigin.status).toBe(200);

	const dev = await createApp({
		...runtime,
		allowedOrigins: ["http://localhost:5173"],
	}).request("http://localhost:4096/api/models", {
		headers: { origin: "http://localhost:5173" },
	});
	expect(dev.status).toBe(200);
});

test("a second process cannot take over a data directory in use", async () => {
	const { dir, runtime, post } = await setup();
	runtime.engine.subscribe(() => {});
	expect(
		createRuntime({ dataDir: dir, providers: [new FakeProvider()] }),
	).rejects.toBeInstanceOf(DataDirInUseError);

	// The first process is untouched and still runs jobs.
	const created = await post("/api/turns", {
		prompt: "x",
		modelIds: ["fake/alpha"],
	});
	expect(created.status).toBe(201);
});

test("a lock left by a dead process is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "open-reel-lock-"));
	await Bun.write(join(root, "open-reel.lock"), "2147483646");
	const runtime = await createRuntime({
		dataDir: root,
		providers: [new FakeProvider()],
	});
	expect(await Bun.file(join(root, "open-reel.lock")).text()).toBe(
		String(process.pid),
	);
	runtime.close();
	expect(await Bun.file(join(root, "open-reel.lock")).exists()).toBe(false);
	await rm(root, { recursive: true });
});

test("the event stream reports a job from start to finish", async () => {
	const { call, post } = await setup();
	const stream = await call("/api/events");
	expect(stream.headers.get("content-type")).toContain("text/event-stream");
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let text = "";
	const readUntil = async (marker: string) => {
		while (!text.includes(marker)) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`Stream ended before ${marker}`);
			text += decoder.decode(value);
		}
	};
	await readUntil("event: ready");
	await post("/api/turns", { prompt: "x", modelIds: ["fake/alpha"] });
	await readUntil('"status":"succeeded"');
	expect(text).toContain("event: job.progress");
	expect(text).toContain("event: job.updated");
	await reader.cancel();
});

test("a stored file can be read in ranges, as video players do", async () => {
	const { call } = await setup();
	const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];
	const upload = await call("/api/assets", {
		method: "POST",
		body: new Uint8Array(bytes),
	});
	const { id } = (await upload.json()) as { id: string };
	const get = (range: string) =>
		call(`/api/assets/${id}`, { headers: { range } });
	const read = async (response: Response) =>
		Array.from(new Uint8Array(await response.arrayBuffer()));

	expect((await call(`/api/assets/${id}`)).headers.get("accept-ranges")).toBe(
		"bytes",
	);

	const middle = await get("bytes=1-3");
	expect(middle.status).toBe(206);
	expect(middle.headers.get("content-range")).toBe("bytes 1-3/9");
	expect(middle.headers.get("content-length")).toBe("3");
	expect(middle.headers.get("content-type")).toBe("image/png");
	expect(await read(middle)).toEqual(bytes.slice(1, 4));

	const open = await get("bytes=7-");
	expect(open.headers.get("content-range")).toBe("bytes 7-8/9");
	expect(await read(open)).toEqual(bytes.slice(7));

	const beyond = await get("bytes=4-999");
	expect(beyond.headers.get("content-range")).toBe("bytes 4-8/9");

	const suffix = await get("bytes=-2");
	expect(suffix.headers.get("content-range")).toBe("bytes 7-8/9");
	expect(await read(suffix)).toEqual(bytes.slice(7));

	for (const range of ["bytes=9-", "bytes=5-2", "bytes=-0"]) {
		const response = await get(range);
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */9");
	}

	// Anything that is not one byte range is answered with the whole file.
	for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
		const response = await get(range);
		expect(response.status).toBe(200);
		expect(await read(response)).toEqual(bytes);
	}
});

test("a local model is listed, installed, and deleted", async () => {
	const { call, runtime } = await setup();
	type View = {
		models: { id: string; state: string; size: number; demos: object[] }[];
		disk: { freeBytes: number; usedBytes: number };
	};
	const list = async () =>
		(await (await call("/api/local-models")).json()) as View;

	const before = await list();
	expect(before.models).toHaveLength(1);
	expect(before.models[0]).toMatchObject({
		id: "tiny",
		state: "available",
		// The engine comes with the first model.
		size: WEIGHTS.byteLength + ENGINE.byteLength,
		demos: [{ media: "image" }],
	});
	// Where files come from is the server's business.
	expect(JSON.stringify(before)).not.toContain("models.example/");

	const stream = await call("/api/events");
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
	const install = await call("/api/local-models/tiny/install", {
		method: "POST",
	});
	expect(install.status).toBe(202);
	await runtime.models.idle();
	const installed = await list();
	expect(installed.models[0]?.state).toBe("installed");
	// The weights and the extracted engine.
	expect(installed.disk.usedBytes).toBe(WEIGHTS.byteLength + 3);
	let text = "";
	while (!text.includes("event: models.changed")) {
		text += new TextDecoder().decode((await reader.read()).value);
	}
	await reader.cancel();

	const remove = await call("/api/local-models/tiny", { method: "DELETE" });
	expect(remove.status).toBe(204);
	expect((await list()).disk.usedBytes).toBe(0);

	for (const [path, method] of [
		["/api/local-models/nope/install", "POST"],
		["/api/local-models/nope/cancel", "POST"],
		["/api/local-models/nope", "DELETE"],
		["/api/local-models/nope/demos/0", "GET"],
		["/api/local-models/tiny/demos/7", "GET"],
		["/api/local-models/tiny/demos/x", "GET"],
	] as const) {
		expect((await call(path, { method })).status).toBe(404);
	}
});

test("a model's demo is served from this origin, and never as a page", async () => {
	const { call } = await setup();
	const demo = await call("/api/local-models/tiny/demos/0");
	expect(demo.status).toBe(200);
	expect(demo.headers.get("content-type")).toBe("image/png");
	expect(demo.headers.get("content-security-policy")).toBe("sandbox");
	expect(new Uint8Array(await demo.arrayBuffer())).toEqual(PNG);

	const part = await call("/api/local-models/tiny/demos/0", {
		headers: { range: "bytes=0-3" },
	});
	expect(part.status).toBe(206);
	expect(part.headers.get("content-range")).toBe("bytes 0-3/9");
});

test("a prompt is improved by the language model, and refused without one", async () => {
	const { post, runtime } = await setup();
	// Nothing installed and no key: there is nothing to write with.
	const none = await post("/api/prompts/improve", {
		prompt: "a fox",
		modelIds: ["fake/alpha"],
	});
	expect(none.status).toBe(400);
	expect(((await none.json()) as { code: string }).code).toBe(
		"noLanguageModel",
	);

	const asked: unknown[] = [];
	const app = createApp({
		...runtime,
		improvePrompt: async (_ctx, request) => {
			asked.push(request);
			return "a red fox curled up in fresh snow";
		},
	});
	const improve = (body: unknown) =>
		app.request("http://localhost:4096/api/prompts/improve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const answer = await improve({
		prompt: "a fox",
		modelIds: ["fake/alpha"],
		editing: true,
		language: "pt-BR",
	});
	expect(await answer.json()).toEqual({
		prompt: "a red fox curled up in fresh snow",
	});
	expect(asked).toEqual([
		{
			prompt: "a fox",
			modelIds: ["fake/alpha"],
			editing: true,
			language: "pt-BR",
		},
	]);
	for (const bad of [
		{ prompt: " ", modelIds: [] },
		{ prompt: "a fox", modelIds: "fake/alpha" },
		{ prompt: "x".repeat(1001), modelIds: [] },
		{ prompt: "a fox", modelIds: [], language: "<script>" },
	]) {
		expect((await improve(bad)).status).toBe(400);
	}
});
