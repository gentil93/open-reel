import { afterEach, describe, expect, test } from "bun:test";
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
	summary: "",
	license: "MIT",
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
		dirs.push(dir);
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
		return { dir, calls, fake, provider, killed: () => killed, listeners };
	}

	async function run(
		provider: LocalProvider,
		signal = new AbortController().signal,
	) {
		await provider.load();
		const [model] = provider.listModels();
		const handle = await provider.submit({
			model: model as never,
			params: params(),
			references: [],
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
});
