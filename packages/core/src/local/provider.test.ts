import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dimensions,
	engineArguments,
	type LocalModelSpec,
	LocalProvider,
	type LocalRuntime,
	type ProviderEvent,
	previewInterval,
	type Spawn,
	samplingProgress,
} from "../index";

import { GpuLock } from "./gpu";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const params = (over: object = {}) => ({
	prompt: "a red fox",
	count: 1,
	referenceAssetIds: [],
	extras: {},
	...over,
});

const FLUX: LocalModelSpec = {
	id: "flux",
	name: "FLUX",
	author: "Example",
	media: "image",
	tasks: ["text-to-image"],
	summary: "",
	license: "MIT",
	licenseUrl: "https://license.example",
	commercial: { kind: "allowed" },
	homepage: "https://models.example",
	variants: [],
	demos: [],
	defaults: {
		size: 1024,
		aspectRatios: ["1:1", "16:9"],
		steps: 4,
		cfgScale: 1,
		sampler: "euler",
	},
};
const WAN: LocalModelSpec = {
	...FLUX,
	id: "wan",
	media: "video",
	tasks: ["text-to-video"],
	defaults: {
		size: 832,
		aspectRatios: ["16:9"],
		steps: 30,
		cfgScale: 6,
		flowShift: 3,
		fps: 16,
		durations: [2, 5],
		negativePrompt: "static",
	},
};

const runtime = (
	model: LocalModelSpec,
	scratch = "/scratch",
	fit: LocalRuntime["fit"] = "gpu",
): LocalRuntime => ({
	model,
	variant: { id: "v", label: "v", engine: "sd", memoryBytes: 1, files: [] },
	build: {
		id: "b",
		engine: "sd",
		version: "1",
		backend: "cuda",
		os: "win32",
		arch: "x64",
		files: [],
		executable: "sd-cli.exe",
	},
	executable: "/engines/b/sd-cli.exe",
	throughWindows: true,
	fit,
	files:
		model.media === "video"
			? { diffusion_model: "/m/wan", t5xxl: "/m/t5", vae: "/m/vae" }
			: {
					diffusion_model: "/m/flux",
					t5xxl: "/m/t5",
					clip_l: "/m/clip",
					vae: "/m/ae",
				},
	scratch,
});
const windows = async (path: string) => `C:${path.replaceAll("/", "\\")}`;

describe("engine arguments", () => {
	test("sizes follow the ratio, in steps the model accepts", () => {
		expect(dimensions(1024, "1:1")).toEqual({ width: 1024, height: 1024 });
		expect(dimensions(1024, "16:9")).toEqual({ width: 1024, height: 576 });
		expect(dimensions(1024, "9:16")).toEqual({ width: 576, height: 1024 });
		expect(dimensions(832, "16:9", 16)).toEqual({ width: 832, height: 464 });
		expect(dimensions(512, undefined)).toEqual({ width: 512, height: 512 });
	});

	test("an image job names each file by its role, as Windows paths", async () => {
		const args = await engineArguments(
			runtime(FLUX),
			FLUX.defaults,
			params({ aspectRatio: "16:9", seed: 7 }),
			"/scratch/out.png",
			windows,
		);
		expect(args).toEqual([
			"-M",
			"img_gen",
			"--diffusion-model",
			"C:\\m\\flux",
			"--t5xxl",
			"C:\\m\\t5",
			"--clip_l",
			"C:\\m\\clip",
			"--vae",
			"C:\\m\\ae",
			"-p",
			"a red fox",
			"--steps",
			"4",
			"--cfg-scale",
			"1",
			"-W",
			"1024",
			"-H",
			"576",
			"-s",
			"7",
			"-o",
			"C:\\scratch\\out.png",
			"--sampling-method",
			"euler",
		]);
	});

	test("a video job asks for the frames its length needs", async () => {
		const args = await engineArguments(
			runtime(WAN),
			WAN.defaults,
			params({ durationSeconds: 5 }),
			"/scratch/out.webm",
			async (p) => p,
		);
		expect(args.slice(0, 2)).toEqual(["-M", "vid_gen"]);
		const after = (flag: string) => args[args.indexOf(flag) + 1];
		expect(after("--video-frames")).toBe("81");
		expect(after("--fps")).toBe("16");
		expect(after("--flow-shift")).toBe("3");
		expect(after("-n")).toBe("static");
		expect(after("-W")).toBe("832");
		// Without a ratio asked, the model's own first one, not a square.
		expect(after("-H")).toBe("464");
	});

	test("an editing model is given the pictures to follow, up to its limit", async () => {
		const edit: LocalModelSpec = {
			...FLUX,
			tasks: ["text-to-image", "image-edit"],
			defaults: {
				...FLUX.defaults,
				references: { as: "ref", max: 2 },
				engineArgs: ["--scheduler", "simple"],
			},
		};
		const args = await engineArguments(
			runtime(edit),
			edit.defaults,
			params(),
			"/o.png",
			async (p) => p,
			["/s/a.png", "/s/b.png", "/s/c.png"],
		);
		expect(args.slice(-6)).toEqual([
			"-r",
			"/s/a.png",
			"-r",
			"/s/b.png",
			"--scheduler",
			"simple",
		]);
	});

	test("an image-to-video model starts from the picture", async () => {
		const animate: LocalModelSpec = {
			...WAN,
			tasks: ["text-to-video", "image-to-video"],
			defaults: { ...WAN.defaults, references: { as: "init", max: 1 } },
		};
		const args = await engineArguments(
			runtime(animate),
			animate.defaults,
			params(),
			"/o.webm",
			async (p) => p,
			["/s/first.png"],
		);
		expect(args[args.indexOf("-i") + 1]).toBe("/s/first.png");
		expect(args).not.toContain("-r");
	});

	test("a model that does not fit the graphics card keeps part in memory", async () => {
		const fits = await engineArguments(
			runtime(FLUX),
			FLUX.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		const short = await engineArguments(
			runtime(FLUX, "/scratch", "offload"),
			FLUX.defaults,
			params(),
			"/o.png",
			async (p) => p,
		);
		expect(fits).not.toContain("--offload-to-cpu");
		expect(short.at(-1)).toBe("--offload-to-cpu");
	});

	test("a file with an unknown role is refused rather than guessed", async () => {
		const odd = { ...runtime(FLUX), files: { lora: "/m/lora" } };
		expect(
			engineArguments(odd, FLUX.defaults, params(), "/o.png", windows),
		).rejects.toThrow("No engine option for a lora file");
	});

	test("a forming picture is shown about four times, never for one step", () => {
		expect(previewInterval(1)).toBeNull();
		expect(previewInterval(4)).toBe(1);
		expect(previewInterval(8)).toBe(2);
		expect(previewInterval(30)).toBe(8);
	});

	test("progress is read from the sampling bar only", () => {
		expect(
			samplingProgress(
				"  |============>          | 1/4 -   5.02s/it - ETA 00:15",
			),
		).toEqual({ step: 1, steps: 4 });
		expect(samplingProgress("  |=====>| 30/30 - 2.10it/s")).toEqual({
			step: 30,
			steps: 30,
		});
		// Loading bars count tensors, not steps.
		expect(samplingProgress("  |######   | 18/219 - 615.45MB/s")).toBeNull();
		expect(samplingProgress("[I] generating image: 1/1 - seed 42")).toBeNull();
	});
});

describe("running", () => {
	/** A store that has one installed model, with its scratch in `dir`. */
	async function setup(model = FLUX) {
		const dir = await mkdtemp(join(tmpdir(), "open-reel-local-"));
		const gpuRoot = await mkdtemp(join(tmpdir(), "open-reel-gpu-"));
		dirs.push(dir, gpuRoot);
		const listeners: ((event: { type: string }) => void)[] = [];
		const store = {
			list: async () => ({
				models: [{ id: model.id, installed: true, ready: true }],
			}),
			runtime: async () => ({ ...runtime(model, dir), throughWindows: false }),
			subscribe: (listener: (event: { type: string }) => void) => {
				listeners.push(listener);
				return () => {};
			},
			gpu: new GpuLock({ root: gpuRoot, capacity: async () => 12 * 2 ** 30 }),
		};
		const calls: string[][] = [];
		let killed = 0;
		/** Prints `lines`, then writes `result` where the job asked for it. */
		const fake =
			(lines: string[], code = 0, result: Uint8Array | null = PNG): Spawn =>
			(argv) => {
				calls.push(argv);
				const output = argv[argv.indexOf("-o") + 1] as string;
				let finish!: (code: number) => void;
				const exited = new Promise<number>((resolve) => {
					finish = resolve;
				});
				return {
					output: (async function* () {
						for (const line of lines) {
							if (line === "HANG") await new Promise(() => {});
							yield line;
						}
						if (result) await Bun.write(output, result);
						finish(code);
					})(),
					exited,
					kill: () => {
						killed++;
						finish(137);
					},
				};
			};
		const provider = (spawn: Spawn) =>
			new LocalProvider({
				store: store as never,
				catalog: [model],
				spawn,
			});
		return {
			dir,
			gpuRoot,
			calls,
			fake,
			provider,
			killed: () => killed,
			listeners,
		};
	}

	async function run(
		provider: LocalProvider,
		signal = new AbortController().signal,
		references: { data: Uint8Array; mime: string }[] = [],
	) {
		await provider.load();
		const [model] = provider.listModels();
		const handle = await provider.submit({
			model: model as never,
			params: params(),
			references,
		});
		const events: ProviderEvent[] = [];
		for await (const event of provider.events(handle, {
			apiKey: undefined,
			signal,
		})) {
			events.push(event);
		}
		return events;
	}

	test("installed models are offered, free and without references", async () => {
		const { provider, fake } = await setup();
		const local = provider(fake([]));
		let changed = 0;
		local.onChange = () => changed++;
		expect(local.listModels()).toEqual([]);
		await local.load();
		expect(changed).toBe(1);
		expect(local.listModels()).toEqual([
			{
				id: "local/flux",
				providerId: "local",
				providerModelId: "flux",
				name: "FLUX",
				media: "image",
				operations: ["generate"],
				capabilities: {
					aspectRatios: ["1:1", "16:9"],
					seed: true,
					maxCount: 1,
					maxReferenceImages: 0,
				},
				pricing: { usdPerOutput: 0 },
			},
		]);
		await local.load();
		expect(changed).toBe(1); // nothing changed
	});

	test("a job reports sampling progress and returns the image", async () => {
		const { provider, fake, calls, dir } = await setup();
		const events = await run(
			provider(
				fake([
					"[I] loading model",
					"  |=====>      | 1/4 - 2.00s/it",
					"  |=====>      | 1/4 - 2.00s/it",
					"  |=========>  | 4/4 - 1.00s/it",
				]),
			),
		);
		expect(events).toEqual([
			{ type: "progress", message: "Loading the model", stage: "loading" },
			{
				type: "progress",
				fraction: 0.25,
				message: "Generating",
				stage: "generating",
				step: 1,
				steps: 4,
			},
			{
				type: "progress",
				fraction: 1,
				message: "Generating",
				stage: "generating",
				step: 4,
				steps: 4,
			},
			{
				type: "completed",
				outputs: [{ data: PNG, mime: "image/png" }],
				costUsd: 0,
			},
		]);
		expect(calls[0]?.[0]).toBe("/engines/b/sd-cli.exe");
		// The engine's output is removed once read.
		expect(await readdir(dir)).toEqual([]);
	});

	test("models that take pictures are offered for editing", async () => {
		const both: LocalModelSpec = {
			...FLUX,
			tasks: ["text-to-image", "image-edit"],
			defaults: { ...FLUX.defaults, references: { as: "ref", max: 3 } },
		};
		const editOnly: LocalModelSpec = { ...both, tasks: ["image-edit"] };
		for (const [model, operations] of [
			[both, ["generate", "edit"]],
			[editOnly, ["edit"]],
		] as const) {
			const { provider, fake } = await setup(model);
			const local = provider(fake([]));
			await local.load();
			const [listed] = local.listModels();
			expect(listed?.operations).toEqual([...operations]);
			expect(listed?.capabilities.maxReferenceImages).toBe(3);
		}
	});

	test("a picture to follow is handed to the engine as a file, then removed", async () => {
		const edit: LocalModelSpec = {
			...FLUX,
			tasks: ["image-edit"],
			defaults: { ...FLUX.defaults, references: { as: "ref", max: 1 } },
		};
		const { provider, fake, calls, dir } = await setup(edit);
		let given: Uint8Array = new Uint8Array();
		const spawn: Spawn = (argv) => {
			const path = argv[argv.indexOf("-r") + 1] as string;
			given = new Uint8Array(readFileSync(path));
			return fake([])(argv);
		};
		const events = await run(provider(spawn), undefined, [
			{ data: new Uint8Array([9, 8, 7]), mime: "image/jpeg" },
		]);
		expect(events.at(-1)?.type).toBe("completed");
		expect(calls[0]?.[calls[0].indexOf("-r") + 1]).toEndWith(".jpeg");
		expect(given).toEqual(new Uint8Array([9, 8, 7]));
		expect(await readdir(dir)).toEqual([]);
	});

	test("a failing engine reports its last error line", async () => {
		const { provider, fake } = await setup();
		const events = await run(
			provider(
				fake(
					["[I] loading", "[E] failed to load model: out of memory"],
					1,
					null,
				),
			),
		);
		expect(events.at(-1)).toEqual({
			type: "failed",
			error: "The engine stopped: failed to load model: out of memory",
			code: "engineStopped",
			params: { reason: "failed to load model: out of memory" },
		});
		const silent = await run(provider(fake([], 3, null)));
		expect(silent.at(-1)).toEqual({
			type: "failed",
			error: "The engine stopped with code 3",
			code: "engineExitCode",
			params: { code: 3 },
		});
		const empty = await run(provider(fake([], 0, null)));
		expect(empty.at(-1)).toEqual({
			type: "failed",
			error: "The engine produced no result",
			code: "engineNoResult",
		});
	});

	test("canceling stops the engine", async () => {
		const { provider, fake, killed } = await setup();
		const controller = new AbortController();
		const local = provider(fake(["  |=>  | 1/4 - 1.00s/it", "HANG"]));
		const job = run(local, controller.signal);
		await Bun.sleep(20);
		controller.abort();
		expect(job).rejects.toThrow();
		await Bun.sleep(10);
		expect(killed()).toBeGreaterThan(0);
	});

	test("pictures and videos wait in separate lines", async () => {
		const local = new LocalProvider({
			store: { subscribe: () => () => {} } as never,
			catalog: [FLUX, WAN],
			warm: false,
		});
		expect(local.lineOf("local/flux")).toBe("image");
		expect(local.lineOf("local/wan")).toBe("video");
	});

	test("a job waits while another open-reel holds the GPU's memory", async () => {
		const { provider, fake, calls, gpuRoot } = await setup();
		const other = new GpuLock({
			root: gpuRoot,
			capacity: async () => 12 * 2 ** 30,
		});
		const it = other.acquire(12 * 2 ** 30, new AbortController().signal);
		let held = await it.next();
		while (!held.done) held = await it.next();
		const local = provider(fake(["  |====| 4/4 - 1.00s/it"]));
		const job = run(local);
		await Bun.sleep(30);
		expect(calls.length).toBe(0);
		held.value.release();
		const events = await job;
		expect(
			events.some((e) => e.type === "progress" && e.stage === "waitingGpu"),
		).toBe(true);
		expect(events.at(-1)?.type).toBe("completed");
	});
});
