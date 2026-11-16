import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LocalModelEvent,
	type LocalModelSpec,
	LocalModelStore,
	NotFoundError,
	ValidationError,
} from "../index";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(data).digest("hex");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const UNET_A = bytes("weights of model a");
const UNET_B = bytes("weights of model b, a little longer");
const ENCODER = bytes("a text encoder both models use");
const url = (name: string) => `https://models.example/${name}`;

const file = (name: string, data: Uint8Array) => ({
	name,
	url: url(name),
	size: data.byteLength,
	sha256: sha256(data),
});
const model = (
	id: string,
	files: LocalModelSpec["files"],
	demos: LocalModelSpec["demos"] = [],
): LocalModelSpec => ({
	id,
	name: `Model ${id}`,
	author: "Example",
	media: "image",
	summary: "A model for tests.",
	license: "MIT",
	homepage: "https://models.example",
	files,
	demos,
});
const CATALOG = [
	model(
		"a",
		[file("a.safetensors", UNET_A), file("encoder.safetensors", ENCODER)],
		[
			{ url: url("demo.png"), media: "image", caption: "A sample" },
			{ url: url("page.html"), media: "image" },
		],
	),
	model("b", [
		file("b.safetensors", UNET_B),
		file("encoder.safetensors", ENCODER),
	]),
];

/** A server holding `files`, answering ranges as a download host does. */
function remote(files: Record<string, Uint8Array>) {
	const requests: { url: string; range: string | null }[] = [];
	const control = {
		/** When set, a download stalls on this after its first bytes. */
		hold: null as Promise<void> | null,
		status: 200,
		ignoreRange: false,
		/** How many bytes to leave out of the end of each answer. */
		cut: 0,
	};
	const fetch = async (target: string, init?: RequestInit) => {
		const range = new Headers(init?.headers).get("range");
		requests.push({ url: target, range });
		const data = files[target];
		if (!data) return new Response("Not found", { status: 404 });
		if (control.status !== 200) {
			return new Response("Unavailable", { status: control.status });
		}
		const start =
			range && !control.ignoreRange ? Number(range.match(/\d+/)?.[0]) : 0;
		const body = data.slice(start, data.length - control.cut);
		const signal = init?.signal;
		const { hold } = control;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const aborted = new Promise<never>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				});
				try {
					controller.enqueue(body.slice(0, 4));
					if (hold) await Promise.race([hold, aborted]);
					if (body.length > 4) controller.enqueue(body.slice(4));
					controller.close();
				} catch (error) {
					controller.error(error);
				}
			},
		});
		return new Response(stream, { status: start > 0 ? 206 : 200 });
	};
	return { fetch, requests, control };
}

async function setup(catalog = CATALOG) {
	const root = await mkdtemp(join(tmpdir(), "open-reel-models-"));
	dirs.push(root);
	const host = remote({
		[url("a.safetensors")]: UNET_A,
		[url("b.safetensors")]: UNET_B,
		[url("encoder.safetensors")]: ENCODER,
		[url("demo.png")]: PNG,
		[url("page.html")]: bytes("<script>alert(1)</script>"),
	});
	const store = new LocalModelStore({ root, catalog, fetch: host.fetch });
	const events: LocalModelEvent[] = [];
	store.subscribe((event) => events.push(event));
	const status = async (id: string) => {
		const found = (await store.list()).models.find((m) => m.id === id);
		if (!found) throw new Error(`Not listed: ${id}`);
		return found;
	};
	const blobs = () => readdir(join(root, "blobs")).catch(() => []);
	return { root, store, events, status, blobs, ...host };
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

async function until(condition: () => Promise<boolean> | boolean) {
	for (let i = 0; i < 200; i++) {
		if (await condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for a condition");
}

test("lists the catalog with what each model takes on disk", async () => {
	const { store } = await setup();
	const view = await store.list();
	expect(view.models.map((m) => [m.id, m.state, m.size])).toEqual([
		["a", "available", UNET_A.length + ENCODER.length],
		["b", "available", UNET_B.length + ENCODER.length],
	]);
	expect(view.models[0]).toMatchObject({
		receivedBytes: 0,
		reclaimableBytes: 0,
		files: [
			{ name: "a.safetensors", size: UNET_A.length, present: false },
			{ name: "encoder.safetensors", size: ENCODER.length, present: false },
		],
		// Where demos come from stays on the server.
		demos: [{ media: "image", caption: "A sample" }, { media: "image" }],
	});
	expect(view.disk.usedBytes).toBe(0);
	expect(view.disk.freeBytes).toBeGreaterThan(0);
});

test("installing downloads every file, checks it, and reports progress", async () => {
	const { store, status, events } = await setup();
	await store.install("a");
	expect((await status("a")).state).not.toBe("available");
	await store.idle();

	const installed = await status("a");
	expect(installed).toMatchObject({
		state: "installed",
		receivedBytes: installed.size,
		reclaimableBytes: installed.size,
	});
	expect(installed.files.every((f) => f.present)).toBe(true);
	expect((await store.list()).disk.usedBytes).toBe(installed.size);

	const paths = await store.files("a");
	expect(Object.keys(paths)).toEqual(["a.safetensors", "encoder.safetensors"]);
	expect(await Bun.file(paths["a.safetensors"] as string).bytes()).toEqual(
		UNET_A,
	);

	await Bun.sleep(20); // progress is reported off the download's own path
	expect(events.at(-1)).toEqual({ type: "models.changed" });
	const progress = events.filter((e) => e.type === "model.progress");
	expect(progress.length).toBeGreaterThan(0);
	expect(progress.at(-1)).toMatchObject({ id: "a", size: installed.size });

	// Installing again does nothing.
	const before = events.length;
	await store.install("a");
	expect(events).toHaveLength(before);
});

test("a file two models share is downloaded and stored once", async () => {
	const { store, status, requests, blobs } = await setup();
	await store.install("a");
	await store.idle();
	expect(await status("b")).toMatchObject({
		state: "available",
		receivedBytes: ENCODER.length,
		reclaimableBytes: 0,
	});

	await store.install("b");
	await store.idle();
	expect(requests.map((r) => r.url)).toEqual([
		url("a.safetensors"),
		url("encoder.safetensors"),
		url("b.safetensors"),
	]);
	expect(await blobs()).toHaveLength(3);
	// Deleting one frees only what the other does not use.
	expect((await status("a")).reclaimableBytes).toBe(UNET_A.length);

	await store.remove("a");
	expect((await status("a")).state).toBe("available");
	expect((await status("b")).state).toBe("installed");
	expect((await blobs()).sort()).toEqual(
		[sha256(UNET_B), sha256(ENCODER)].sort(),
	);
	expect(store.files("a")).rejects.toBeInstanceOf(ValidationError);

	await store.remove("b");
	expect(await blobs()).toEqual([]);
	expect((await store.list()).disk.usedBytes).toBe(0);
});

test("a canceled install keeps what it downloaded and resumes from there", async () => {
	const { store, status, requests, control, blobs } = await setup();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(async () => (await status("a")).receivedBytes === 4);
	expect((await status("a")).state).toBe("downloading");

	await store.cancel("a");
	expect(await status("a")).toMatchObject({
		state: "available",
		receivedBytes: 4,
	});
	expect((await status("a")).error).toBeUndefined();
	expect(await blobs()).toEqual([`${sha256(UNET_A)}.part`]);

	control.hold = null;
	await store.install("a");
	await store.idle();
	expect((await status("a")).state).toBe("installed");
	expect(requests.map((r) => r.range)).toEqual([null, "bytes=4-", null]);
	expect(
		await Bun.file((await store.files("a"))["a.safetensors"] as string).bytes(),
	).toEqual(UNET_A);
});

test("a host that ignores the range is downloaded from the start", async () => {
	const { store, status, control } = await setup();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(async () => (await status("a")).receivedBytes === 4);
	await store.cancel("a");

	control.hold = null;
	control.ignoreRange = true;
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ state: "installed" });
});

test("deleting a half-downloaded model removes what it had fetched", async () => {
	const { store, status, control, blobs } = await setup();
	control.hold = new Promise(() => {});
	await store.install("a");
	await until(async () => (await status("a")).receivedBytes === 4);
	await store.remove("a");
	expect(await status("a")).toMatchObject({
		state: "available",
		receivedBytes: 0,
	});
	expect(await blobs()).toEqual([]);
});

test("a file that fails its check is discarded and reported", async () => {
	const { store, status, blobs, root } = await setup();
	const tampered = remote({
		[url("a.safetensors")]: bytes("weights of model A"), // same length
		[url("encoder.safetensors")]: ENCODER,
	});
	const bad = new LocalModelStore({
		root,
		catalog: CATALOG,
		fetch: tampered.fetch,
	});
	await bad.install("a");
	await bad.idle();
	const failed = (await bad.list()).models[0];
	expect(failed).toMatchObject({ state: "available", receivedBytes: 0 });
	expect(failed?.error).toBe("a.safetensors did not match its expected hash");
	expect(await blobs()).toEqual([]);

	// Trying again starts clean.
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({ state: "installed" });
});

test("a download that fails or is cut short is reported, and can be retried", async () => {
	const { store, status, control } = await setup();
	control.status = 503;
	await store.install("a");
	await store.idle();
	expect((await status("a")).error).toBe(
		"Could not download a.safetensors (HTTP 503)",
	);

	control.status = 200;
	control.cut = 1;
	await store.install("a");
	await store.idle();
	expect(await status("a")).toMatchObject({
		state: "available",
		error: "The download of a.safetensors was cut short",
		receivedBytes: UNET_A.length - 1,
	});

	control.cut = 0;
	await store.install("a");
	await store.idle();
	const done = await status("a");
	expect(done.state).toBe("installed");
	expect(done.error).toBeUndefined();
});

test("installs run one at a time, and a waiting one cancels at once", async () => {
	const { store, status, control } = await setup();
	const hold = gate();
	control.hold = hold.promise;
	await store.install("a");
	await store.install("b");
	await until(async () => (await status("a")).state === "downloading");
	expect((await status("b")).state).toBe("queued");

	await store.cancel("b");
	expect((await status("b")).state).toBe("available");
	hold.open();
	await store.idle();
	expect((await status("a")).state).toBe("installed");
	expect((await status("b")).state).toBe("available");
});

test("refuses a model that does not fit on the disk", async () => {
	const huge = { ...file("huge.safetensors", UNET_A), size: 1e18 };
	const { store, requests } = await setup([model("huge", [huge])]);
	expect(store.install("huge")).rejects.toBeInstanceOf(ValidationError);
	expect(store.install("huge")).rejects.toThrow("Not enough disk space");
	await store.idle();
	expect(requests).toHaveLength(0);
});

test("unknown models and malformed catalogs are refused", async () => {
	const { store, root } = await setup();
	expect(store.install("nope")).rejects.toBeInstanceOf(NotFoundError);
	expect(store.remove("nope")).rejects.toBeInstanceOf(NotFoundError);

	const invalid = (spec: LocalModelSpec) => () =>
		new LocalModelStore({ root, catalog: [spec] });
	const good = file("a.safetensors", UNET_A);
	expect(invalid(model("../escape", [good]))).toThrow("Invalid or repeated");
	expect(invalid(model("a", []))).toThrow("without files");
	expect(invalid(model("a", [good, good]))).toThrow("Repeated file name");
	expect(invalid(model("a", [{ ...good, sha256: "abc" }]))).toThrow(
		"Invalid hash",
	);
	expect(
		invalid(model("a", [{ ...good, url: "http://models.example/a" }])),
	).toThrow("Not an HTTPS URL");
	expect(
		invalid(
			model("a", [good], [{ url: "file:///etc/passwd", media: "image" }]),
		),
	).toThrow("Not an HTTPS URL");
});

test("a demo is fetched once, kept, and served as what its bytes are", async () => {
	const { store, requests } = await setup();
	const [first, second] = await Promise.all([
		store.demo("a", 0),
		store.demo("a", 0),
	]);
	expect(first.mime).toBe("image/png");
	expect(await first.blob.bytes()).toEqual(PNG);
	expect(second.mime).toBe("image/png");
	await store.demo("a", 0);
	expect(requests).toEqual([{ url: url("demo.png"), range: null }]);

	// Whatever the catalog links to, only images and videos are stored.
	expect(store.demo("a", 1)).rejects.toThrow("not an image or a video");
	expect(store.demo("a", 2)).rejects.toBeInstanceOf(NotFoundError);
	expect(store.demo("a", -1)).rejects.toBeInstanceOf(NotFoundError);
});
