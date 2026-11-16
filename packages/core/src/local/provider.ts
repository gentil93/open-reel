import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

export interface LocalHandle {
	modelId: string;
	params: GenerationParams;
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

/** The engine option for each role a file can have. */
const ROLE_OPTIONS: Record<string, string> = {
	model: "-m",
	diffusion_model: "--diffusion-model",
	vae: "--vae",
	clip_l: "--clip_l",
	t5xxl: "--t5xxl",
	llm: "--llm",
};

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
): Promise<string[]> {
	const video = runtime.model.media === "video";
	const { width, height } = dimensions(
		defaults.size,
		params.aspectRatio,
		video ? 16 : 64,
	);
	const args = ["-M", video ? "vid_gen" : "img_gen"];
	for (const [role, file] of Object.entries(runtime.files)) {
		const option = ROLE_OPTIONS[role];
		if (!option) throw new Error(`No engine option for a ${role} file`);
		args.push(option, await path(file));
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
export function samplingProgress(line: string): number | null {
	const match = line.match(
		/\|[=> ]*\|\s*(\d+)\/(\d+)\s+-\s+[\d.]+\s*(?:s\/it|it\/s)/,
	);
	if (!match) return null;
	const done = Number(match[1]);
	const total = Number(match[2]);
	return total > 0 ? Math.min(1, done / total) : null;
}

export interface LocalProviderOptions {
	store: LocalModelStore;
	catalog: LocalModelSpec[];
	spawn?: Spawn;
	/** For engines that run as Windows programs under WSL. */
	windowsPath?: PathMapper;
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
	// Every local model shares the one GPU.
	maxConcurrency = 1;
	onChange: (() => void) | null = null;
	private installed: string[] = [];
	private store: LocalModelStore;
	private catalog: LocalModelSpec[];
	private spawn: Spawn;
	private windowsPath: PathMapper;

	constructor(options: LocalProviderOptions) {
		this.store = options.store;
		this.catalog = options.catalog;
		this.spawn = options.spawn ?? spawnProcess;
		this.windowsPath = options.windowsPath ?? windowsPath;
		this.store.subscribe((event) => {
			if (event.type === "models.changed") void this.load();
		});
	}

	/** Reads which models are installed. */
	async load(): Promise<void> {
		const view = await this.store.list();
		// Offered only once its engine is there too.
		const installed = view.models.filter((m) => m.ready).map((m) => m.id);
		if (installed.join() === this.installed.join()) return;
		this.installed = installed;
		this.onChange?.();
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
				operations: ["generate"],
				capabilities: {
					aspectRatios: model.defaults.aspectRatios,
					seed: true,
					maxCount: 1,
					maxReferenceImages: 0,
					...(model.defaults.durations && {
						durations: model.defaults.durations,
					}),
				},
				pricing: { usdPerOutput: 0 },
			}));
	}

	async submit(request: ProviderRequest): Promise<LocalHandle> {
		return {
			modelId: request.model.providerModelId,
			params: request.params,
		};
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
		const argv = [
			runtime.executable,
			...(await engineArguments(
				runtime,
				runtime.model.defaults,
				handle.params,
				output,
				path,
			)),
		];

		yield { type: "progress", message: "Loading the model" };
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
				const fraction = samplingProgress(line);
				// The bar redraws many times a second; report whole percents.
				if (fraction != null && Math.floor(fraction * 100) !== last) {
					last = Math.floor(fraction * 100);
					yield { type: "progress", fraction, message: "Generating" };
				}
			}
			const code = await Promise.race([child.exited, aborted]);
			if (code !== 0) {
				const reason = tail.filter((l) => /error|fail/i.test(l)).at(-1);
				yield {
					type: "failed",
					error: reason
						? `The engine stopped: ${reason.replace(/^\[\w\]\s*/, "")}`
						: `The engine stopped with code ${code}`,
				};
				return;
			}
			const data = await Bun.file(output)
				.bytes()
				.catch(() => null);
			const mime = data && sniffMime(data);
			if (!data || !mime) {
				yield { type: "failed", error: "The engine produced no result" };
				return;
			}
			yield { type: "completed", outputs: [{ data, mime }], costUsd: 0 };
		} finally {
			child.kill();
			await rm(output, { force: true });
		}
	}

	async cancel(): Promise<void> {
		// Aborting the job's signal already stops the engine.
	}
}
