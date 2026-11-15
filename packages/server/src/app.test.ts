import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "@open-reel/core";
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

async function setup() {
	// A nested path that does not exist yet, as on a first run.
	const root = await mkdtemp(join(tmpdir(), "open-reel-server-"));
	const dir = join(root, "data", "open-reel");
	const provider = new FakeProvider();
	const runtime: Runtime = await createRuntime({
		dataDir: dir,
		providers: [provider],
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
		body: new Uint8Array([1, 2, 3]),
	});
	expect(upload.status).toBe(201);
	const asset = (await upload.json()) as { id: string };

	const turn = await post("/api/turns", {
		prompt: "restyle",
		modelIds: ["fake/alpha"],
		referenceAssetIds: [asset.id],
	});
	expect(turn.status).toBe(201);
	await runtime.engine.idle();

	const rejected = await call("/api/assets", {
		method: "POST",
		headers: { "content-type": "text/html" },
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
