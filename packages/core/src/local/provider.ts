import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sniffMime } from "../mime";
import type {
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "../provider";
import type {
	GenerationParams,
	LocalModelDefaults,
	LocalModelSpec,
	ModelSpec,
} from "../types";
import type { LocalModelStore, LocalRuntime } from "./store";
import { WarmEngines } from "./warm";

export interface LocalHandle {
	modelId: string;
	params: GenerationParams;
	/** Pictures the person gave, written to the scratch folder at submit. */
	references?: string[];
}

/** Turns a path into one the engine can open, e.g. a Windows path under WSL. */
export type PathMapper = (path: string) => Promise<string>;

/** Starts the engine; tests replace it with a fake process. */
export type Spawn = (argv: string[]) => {
	output: AsyncIterable<string>;
	exited: Promise<number>;
	kill(): void;
};

const spawnProcess: Spawn = (argv) => {
	const child = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	async function* lines() {
		// Progress bars redraw with carriage returns; split on those too.
		const queue: string[] = [];
		const waiting: { wake: (() => void) | null } = { wake: null };
		const notify = () => {
			waiting.wake?.();
			waiting.wake = null;
		};
		const readers = [child.stdout, child.stderr].map(async (stream) => {
			let rest = "";
			for await (const text of stream.pipeThrough(new TextDecoderStream())) {
				const parts = (rest + text).split(/[\r\n]/);
				rest = parts.pop() ?? "";
				queue.push(...parts);
				notify();
			}
			if (rest) queue.push(rest);
		});
		let open = true;
		void Promise.all(readers).finally(() => {
			open = false;
			notify();
		});
		while (open || queue.length > 0) {
			const line = queue.shift();
			if (line != null) {
				yield line;
				continue;
			}
			await new Promise<void>((resolve) => {
				waiting.wake = resolve;
			});
		}
	}
	return { output: lines(), exited: child.exited, kill: () => child.kill() };
};

const windowsPath: PathMapper = async (path) => {
	const child = Bun.spawn(["wslpath", "-w", path], { stdout: "pipe" });
	const text = (await new Response(child.stdout).text()).trim();
	if ((await child.exited) !== 0 || !text) {
		throw new Error(`Could not translate ${path} for Windows`);
	}
	return text;
};

/**
 * The engine option for each role a file can have: stable-diffusion.cpp's
 * file options. Most roles are spelled as their option.
 */
const ROLE_OPTIONS: Record<string, string> = {
	model: "-m",
	diffusion_model: "--diffusion-model",
	"high-noise-diffusion-model": "--high-noise-diffusion-model",
	vae: "--vae",
	taesd: "--taesd",
	clip_l: "--clip_l",
	clip_g: "--clip_g",
	clip_vision: "--clip_vision",
	t5xxl: "--t5xxl",
	llm: "--llm",
	llm_vision: "--llm_vision",
	tokenizer: "--tokenizer",
	"embeddings-connectors": "--embeddings-connectors",
};

/** The engine option for a file's role; an unknown role is refused, not guessed. */
export function roleOption(role: string): string {
	const option = ROLE_OPTIONS[role];
	if (!option) throw new Error(`No engine option for a ${role} file`);
	return option;
}

/** Options every run of a model takes: its own, and offloading when short. */
function modelOptions(runtime: LocalRuntime): string[] {
	return [
		...(runtime.model.defaults.engineArgs ?? []),
		...(runtime.fit === "offload" ? ["--offload-to-cpu"] : []),
	];
}

/** Width and height for a ratio, the longer side `size`, in steps of `step`. */
export function dimensions(
	size: number,
	ratio: string | undefined,
	step = 64,
): { width: number; height: number } {
	const [w = 1, h = 1] = (ratio ?? "1:1").split(":").map(Number);
	const round = (value: number) =>
		Math.max(step, Math.round(value / step) * step);
	return w >= h
		? { width: round(size), height: round((size * h) / w) }
		: { width: round((size * w) / h), height: round(size) };
}

/** The engine's arguments for one job, with paths as the engine sees them. */
export async function engineArguments(
	runtime: LocalRuntime,
	defaults: LocalModelDefaults,
	params: GenerationParams,
	output: string,
	path: PathMapper,
	references: string[] = [],
): Promise<string[]> {
	const video = runtime.model.media === "video";
	const { width, height } = dimensions(
		defaults.size,
		params.aspectRatio ?? defaults.aspectRatios[0],
		video ? 16 : 64,
	);
	const args = ["-M", video ? "vid_gen" : "img_gen"];
	for (const [role, file] of Object.entries(runtime.files)) {
		args.push(roleOption(role), await path(file));
	}
	args.push(
		"-p",
		params.prompt,
		"--steps",
		String(defaults.steps),
		"--cfg-scale",
		String(defaults.cfgScale),
		"-W",
		String(width),
		"-H",
		String(height),
		"-s",
		String(params.seed ?? Math.floor(Math.random() * 2 ** 31)),
		"-o",
		await path(output),
	);
	if (defaults.sampler) args.push("--sampling-method", defaults.sampler);
	if (defaults.negativePrompt) args.push("-n", defaults.negativePrompt);
	if (defaults.flowShift != null) {
		args.push("--flow-shift", String(defaults.flowShift));
	}
	if (defaults.references) {
		const flag = defaults.references.as === "init" ? "-i" : "-r";
		for (const reference of references.slice(0, defaults.references.max)) {
			args.push(flag, await path(reference));
		}
	}
	args.push(...modelOptions(runtime));
	if (video) {
		const fps = defaults.fps ?? 16;
		const seconds = params.durationSeconds ?? defaults.durations?.[0] ?? 2;
		// Wan makes 4n + 1 frames.
		const frames = Math.round((fps * seconds) / 4) * 4 + 1;
		args.push("--video-frames", String(frames), "--fps", String(fps));
	}
	return args;
}

/** Reads "| 3/8 - 1.2s/it" from the engine's sampling progress bar. */
export function samplingProgress(
	line: string,
): { step: number; steps: number } | null {
	const match = line.match(
		/\|[=> ]*\|\s*(\d+)\/(\d+)\s+-\s+[\d.]+\s*(?:s\/it|it\/s)/,
	);
	if (!match) return null;
	const steps = Number(match[2]);
	return steps > 0 ? { step: Math.min(Number(match[1]), steps), steps } : null;
}

export interface LocalProviderOptions {
	store: LocalModelStore;
	catalog: LocalModelSpec[];
	spawn?: Spawn;
	/** For engines that run as Windows programs under WSL. */
	windowsPath?: PathMapper;
	/**
	 * Keeps a model loaded between pictures. `false` runs the engine once per
	 * picture, as tests and engines without a server do.
	 */
	warm?: WarmEngines | false;
}

/** At most this many pictures are shown while one forms: each costs a decode. */
const PREVIEWS_PER_JOB = 4;

/**
 * How many sampling steps go between pictures of a job in progress, or null
 * when there is nothing worth showing (a single step is the final picture).
 */
export function previewInterval(steps: number): number | null {
	return steps > 1 ? Math.ceil(steps / PREVIEWS_PER_JOB) : null;
}

/** A PNG the engine has finished writing: it ends with its IEND chunk. */
function completePng(data: Uint8Array): boolean {
	const end = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
	return (
		data.length > end.length &&
		end.every((byte, i) => data[data.length - end.length + i] === byte)
	);
}

/** What a model can be asked to do: make from words, change a picture, or both. */
export function operationsOf(model: LocalModelSpec): ModelSpec["operations"] {
	const operations: ModelSpec["operations"] = [];
	if (model.tasks.some((t) => t === "text-to-image" || t === "text-to-video")) {
		operations.push("generate");
	}
	if (model.defaults.references) operations.push("edit");
	return operations;
}

/** The engine's server program, next to its one-shot program. */
function serverProgram(executable: string): string {
	return join(
		dirname(executable),
		basename(executable).replace("sd-cli", "sd-server"),
	);
}

/**
 * Runs installed local models. Its models are the installed ones, so the list
 * changes; `onChange` is told when it does.
 */
export class LocalProvider implements ProviderAdapter<LocalHandle> {
	id = "local";
	name = "This computer";
	requiresKey = false;
	// A job lives in the engine process, which dies with open-reel.
	resumable = false;
	// One picture and one video at a time (see lineOf), and both at once only
	// when they fit in the GPU's memory: the GPU lock decides.
	maxConcurrency = 1;
	onChange: (() => void) | null = null;
	private installed: string[] = [];
	private store: LocalModelStore;
	private catalog: LocalModelSpec[];
	private spawn: Spawn;
	private windowsPath: PathMapper;
	private warm: WarmEngines | false;

	constructor(options: LocalProviderOptions) {
		this.store = options.store;
		this.catalog = options.catalog;
		this.spawn = options.spawn ?? spawnProcess;
		this.windowsPath = options.windowsPath ?? windowsPath;
		this.warm =
			options.warm ??
			new WarmEngines({ spawn: this.spawn, gpu: this.store.gpu });
		this.store.subscribe((event) => {
			if (event.type === "models.changed") void this.load();
		});
	}

	/** Reads which models are installed. */
	async load(): Promise<void> {
		const view = await this.store.list();
		// Offered only once its engine is there too.
		const installed = view.models.filter((m) => m.ready).map((m) => m.id);
		// A loaded model holds its files open, and Windows cannot delete them.
		const loaded = this.warm ? this.warm.loaded?.split(":")[0] : null;
		if (this.warm && loaded && !installed.includes(loaded)) this.warm.stop();
		if (installed.join() === this.installed.join()) return;
		this.installed = installed;
		this.onChange?.();
	}

	/**
	 * Pictures and videos wait in separate lines: the loaded model is one, so
	 * a second job of the same kind could only wait for it.
	 */
	lineOf(modelId: string): string {
		const id = modelId.replace(/^local\//, "");
		return this.catalog.find((model) => model.id === id)?.media ?? "image";
	}

	listModels(): ModelSpec[] {
		return this.catalog
			.filter((model) => this.installed.includes(model.id))
			.map((model) => ({
				id: `local/${model.id}`,
				providerId: this.id,
				providerModelId: model.id,
				name: model.name,
				media: model.media,
				operations: operationsOf(model),
				capabilities: {
					aspectRatios: model.defaults.aspectRatios,
					seed: true,
					maxCount: 1,
					maxReferenceImages: model.defaults.references?.max ?? 0,
					...(model.defaults.durations && {
						durations: model.defaults.durations,
					}),
				},
				pricing: { usdPerOutput: 0 },
				...(model.profile && { profile: model.profile }),
			}));
	}

	async submit(request: ProviderRequest): Promise<LocalHandle> {
		const handle: LocalHandle = {
			modelId: request.model.providerModelId,
			params: request.params,
		};
		const spec = this.catalog.find((m) => m.id === handle.modelId);
		const max = spec?.defaults.references?.max ?? 0;
		if (request.references.length === 0 || max === 0) return handle;
		// The engine reads pictures from files, kept next to its output.
		const { scratch } = await this.store.runtime(handle.modelId);
		await mkdir(scratch, { recursive: true });
		handle.references = [];
		for (const reference of request.references.slice(0, max)) {
			const extension = reference.mime.split("/")[1] ?? "png";
			const path = join(scratch, `${crypto.randomUUID()}.${extension}`);
			await Bun.write(path, reference.data);
			handle.references.push(path);
		}
		return handle;
	}

	async *events(
		handle: LocalHandle,
		ctx: ProviderContext,
	): AsyncIterable<ProviderEvent> {
		const runtime = await this.store.runtime(handle.modelId);
		const video = runtime.model.media === "video";
		await mkdir(runtime.scratch, { recursive: true });
		const output = join(
			runtime.scratch,
			`${crypto.randomUUID()}.${video ? "webm" : "png"}`,
		);
		const path = runtime.throughWindows
			? this.windowsPath
			: async (p: string) => p;

		// Pictures go through a server that keeps the model loaded, when the
		// engine has one. Not under WSL, where the server's port on the Windows
		// side cannot be reached, and not yet for video.
		const server = serverProgram(runtime.executable);
		if (
			this.warm &&
			!video &&
			!handle.references?.length &&
			!runtime.throughWindows &&
			server !== runtime.executable &&
			(await Bun.file(server).exists())
		) {
			const defaults = runtime.model.defaults;
			const { width, height } = dimensions(
				defaults.size,
				handle.params.aspectRatio ?? defaults.aspectRatios[0],
			);
			const argv = [server];
			for (const [role, file] of Object.entries(runtime.files)) {
				argv.push(roleOption(role), file);
			}
			argv.push(...modelOptions(runtime));
			try {
				yield* this.warm.run(
					`${runtime.model.id}:${runtime.variant.id}`,
					argv,
					{
						video: false,
						prompt: handle.params.prompt,
						negativePrompt: defaults.negativePrompt,
						width,
						height,
						seed: handle.params.seed ?? Math.floor(Math.random() * 2 ** 31),
						steps: defaults.steps,
						cfgScale: defaults.cfgScale,
						sampler: defaults.sampler,
						flowShift: defaults.flowShift,
						previewInterval: previewInterval(defaults.steps) ?? undefined,
					},
					ctx.signal,
					runtime.variant.memoryBytes,
				);
				return;
			} catch (error) {
				if (ctx.signal.aborted) throw error;
				// The server would not start; run the engine once instead.
			}
		}
		const hold = yield* this.store.gpu.acquire(
			runtime.variant.memoryBytes,
			ctx.signal,
		);
		try {
			yield* this.once(runtime, handle, ctx, output, path);
		} finally {
			hold.release();
		}
	}

	/** Runs the engine once for this job. */
	private async *once(
		runtime: LocalRuntime,
		handle: LocalHandle,
		ctx: ProviderContext,
		output: string,
		path: PathMapper,
	): AsyncIterable<ProviderEvent> {
		const video = runtime.model.media === "video";
		const argv = [
			runtime.executable,
			...(await engineArguments(
				runtime,
				runtime.model.defaults,
				handle.params,
				output,
				path,
				handle.references,
			)),
		];
		// The engine writes the picture as it forms, numbered from 000.
		const interval = video
			? null
			: previewInterval(runtime.model.defaults.steps);
		const previewBase = output.replace(/\.png$/, "");
		const previewFile = (index: number) =>
			`${previewBase}-${String(index).padStart(3, "0")}.png`;
		let nextPreview = 0;
		if (interval != null) {
			argv.push(
				"--preview",
				"vae",
				"--preview-interval",
				String(interval),
				"--preview-path",
				await path(`${previewBase}-%03d.png`),
			);
		}

		yield { type: "progress", message: "Loading the model", stage: "loading" };
		const child = this.spawn(argv);
		// A killed process may not close its output; stop reading on abort.
		const aborted = new Promise<never>((_, reject) => {
			const stop = () => {
				child.kill();
				reject(ctx.signal.reason);
			};
			if (ctx.signal.aborted) stop();
			else ctx.signal.addEventListener("abort", stop, { once: true });
		});
		aborted.catch(() => {});
		const lines = child.output[Symbol.asyncIterator]();
		const tail: string[] = [];
		try {
			let last = -1;
			for (;;) {
				const next = await Promise.race([lines.next(), aborted]);
				if (next.done) break;
				const line = next.value;
				if (line.trim()) tail.push(line.trim());
				if (tail.length > 20) tail.shift();
				const sampling = samplingProgress(line);
				// The bar redraws many times a second; report whole percents.
				const fraction = sampling && sampling.step / sampling.steps;
				if (
					sampling &&
					fraction != null &&
					Math.floor(fraction * 100) !== last
				) {
					last = Math.floor(fraction * 100);
					// The newest picture the engine has finished writing, if any.
					let preview: { data: Uint8Array; mime: string } | undefined;
					while (interval != null) {
						const data = await Bun.file(previewFile(nextPreview))
							.bytes()
							.catch(() => null);
						if (!data || !completePng(data)) break;
						preview = { data, mime: "image/png" };
						nextPreview++;
					}
					yield {
						type: "progress",
						fraction,
						message: "Generating",
						stage: "generating",
						step: sampling.step,
						steps: sampling.steps,
						...(preview && { preview }),
					};
				}
			}
			const code = await Promise.race([child.exited, aborted]);
			if (code !== 0) {
				const reason = tail.filter((l) => /error|fail/i.test(l)).at(-1);
				const detail = reason?.replace(/^\[\w\]\s*/, "");
				// A crash may not happen twice (memory another program held, a
				// driver hiccup), and trying again costs nothing but time: once.
				const retry = { attempts: 2 };
				yield detail
					? {
							type: "failed",
							error: `The engine stopped: ${detail}`,
							code: "engineStopped",
							params: { reason: detail },
							retry,
						}
					: {
							type: "failed",
							error: `The engine stopped with code ${code}`,
							code: "engineExitCode",
							params: { code },
							retry,
						};
				return;
			}
			const data = await Bun.file(output)
				.bytes()
				.catch(() => null);
			const mime = data && sniffMime(data);
			if (!data || !mime) {
				yield {
					type: "failed",
					error: "The engine produced no result",
					code: "engineNoResult",
				};
				return;
			}
			yield { type: "completed", outputs: [{ data, mime }], costUsd: 0 };
		} finally {
			child.kill();
			await rm(output, { force: true });
			for (const reference of handle.references ?? []) {
				await rm(reference, { force: true });
			}
			for (let i = 0; i <= nextPreview + PREVIEWS_PER_JOB; i++) {
				await rm(previewFile(i), { force: true });
			}
		}
	}

	async cancel(): Promise<void> {
		// Aborting the job's signal already stops the engine.
	}

	/** Unloads the model, so no engine outlives open-reel. */
	close(): void {
		if (this.warm) this.warm.stop();
		this.store.gpu.close();
	}
}
