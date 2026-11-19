import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ValidationError } from "../errors";
import { sniffMime } from "../mime";
import type {
	ProviderAdapter,
	ProviderContext,
	ProviderEvent,
	ProviderRequest,
} from "../provider";
import {
	DEFAULT_MASK_STRENGTH,
	DEFAULT_STRENGTH,
	type GenerationParams,
	type LocalModelDefaults,
	type LocalModelSpec,
	MAX_LORAS,
	type ModelSpec,
} from "../types";
import type { LocalModelStore, LocalRuntime } from "./store";
import { WarmEngines } from "./warm";

export interface LocalHandle {
	modelId: string;
	params: GenerationParams;
	/**
	 * Pictures the person gave, made ready for the engine. They are written
	 * to files for each run, so a run tried again finds them there too.
	 */
	pictures?: { data: Uint8Array; extension: string }[];
	/** The size to make, when it follows a picture being redrawn. */
	size?: { width: number; height: number };
	/** What of the picture to redraw, made ready for the engine. */
	mask?: Uint8Array;
	/**
	 * LoRAs checked against the model. Found by id when the job runs: the
	 * models folder may have moved since.
	 */
	loras?: HandleLora[];
}

export interface HandleLora {
	id: string;
	weight: number;
	/** Put before the prompt when the prompt lacks it. */
	trigger: string | null;
}

/** A LoRA as the engine is given it. */
export interface EngineLora extends HandleLora {
	/** Its file, on this side: the engine is told its folder. */
	path: string;
}

/**
 * The prompt with the LoRAs named the way the engine reads them,
 * `<lora:name:weight>`, and their trigger words when missing.
 */
export function loraPrompt(prompt: string, loras: HandleLora[]): string {
	// LoRAs come only from the shelf, checked against the model: a tag
	// pasted with a prompt found online would skip that.
	const written = prompt
		.replace(/<(lora|lyco|hypernet):[^>]*>/gi, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	const used = loras.filter((lora) => lora.weight !== 0);
	if (used.length === 0) return written;
	const has = (word: string) =>
		new RegExp(
			`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
			"iu",
		).test(written);
	const triggers = [
		...new Set(
			used
				.map((lora) => lora.trigger)
				.filter((t): t is string => !!t && !has(t)),
		),
	];
	const text = triggers.length ? `${triggers.join(", ")}, ${written}` : written;
	const tags = used.map(
		(lora) => `<lora:${lora.id}:${Math.round(lora.weight * 100) / 100}>`,
	);
	return `${text} ${tags.join(" ")}`;
}

/** Turns a path into one the engine can open, e.g. a Windows path under WSL. */
export type PathMapper = (path: string) => Promise<string>;

/** Starts the engine; tests replace it with a fake process. */
export type Spawn = (argv: string[]) => {
	output: AsyncIterable<string>;
	exited: Promise<number>;
	kill(): void;
};

export const spawnProcess: Spawn = (argv) => {
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

export const windowsPath: PathMapper = async (path) => {
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
	upscale_model: "--upscale-model",
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

/** A picture model that starts from a picture: image-to-image. */
export function redraws(model: LocalModelSpec): boolean {
	return (
		model.media === "image" &&
		model.defaults.references?.as === "init" &&
		model.defaults.upscale == null
	);
}

/**
 * The longest side a picture is upscaled from: four times larger it is
 * already over 6000 pixels, and the engine's memory grows with it.
 */
export const MAX_UPSCALE_INPUT = 1536;

/**
 * Steps to ask for when redrawing: the engine runs only `steps × strength`
 * of them, rounded down, which for a model distilled to one to four steps
 * would be none, and would make most strengths alike. Asking for enough that
 * about four are run gives every model a strength that means something.
 */
export function redrawSteps(steps: number, strength: number): number {
	return Math.max(steps, Math.ceil(4 / strength));
}

/** The engine's arguments for one job, with paths as the engine sees them. */
export async function engineArguments(
	runtime: LocalRuntime,
	defaults: LocalModelDefaults,
	params: GenerationParams,
	output: string,
	path: PathMapper,
	references: string[] = [],
	/** The size to make instead of the ratio's, e.g. the redrawn picture's. */
	size?: { width: number; height: number },
	/** What of the redrawn picture to change: white is redrawn. */
	mask?: string,
	/** LoRAs to add; all in one folder. */
	loras: EngineLora[] = [],
): Promise<string[]> {
	if (defaults.upscale != null) {
		const [picture] = references;
		if (!picture) throw new Error("An upscaler needs a picture");
		const args = ["-M", "upscale"];
		for (const [role, file] of Object.entries(runtime.files)) {
			args.push(roleOption(role), await path(file));
		}
		args.push("-i", await path(picture), "-o", await path(output));
		return [...args, ...modelOptions(runtime)];
	}
	const video = runtime.model.media === "video";
	const { width, height } =
		size ??
		dimensions(
			defaults.size,
			params.aspectRatio ?? defaults.aspectRatios[0],
			video ? 16 : 64,
		);
	const redrawing = redraws(runtime.model) && references.length > 0;
	const masked = redrawing && mask != null;
	const strength =
		params.strength ?? (masked ? DEFAULT_MASK_STRENGTH : DEFAULT_STRENGTH);
	const steps = redrawing
		? redrawSteps(defaults.steps, strength)
		: defaults.steps;
	const args = ["-M", video ? "vid_gen" : "img_gen"];
	for (const [role, file] of Object.entries(runtime.files)) {
		args.push(roleOption(role), await path(file));
	}
	args.push(
		"-p",
		loraPrompt(params.prompt, loras),
		"--steps",
		String(steps),
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
	if (redrawing) args.push("--strength", String(strength));
	if (masked) args.push("--mask", await path(mask));
	const [lora] = loras;
	if (lora) args.push("--lora-model-dir", await path(dirname(lora.path)));
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
			.flatMap((model) =>
				// A text model helps the others; it makes no pictures itself.
				model.media === "text" ? [] : [{ ...model, media: model.media }],
			)
			.map((model) => ({
				id: `local/${model.id}`,
				providerId: this.id,
				providerModelId: model.id,
				name: model.name,
				media: model.media,
				operations: operationsOf(model),
				capabilities: {
					aspectRatios: model.defaults.upscale
						? []
						: model.defaults.aspectRatios,
					seed: true,
					maxCount: 1,
					maxReferenceImages: model.defaults.references?.max ?? 0,
					...(redraws(model) && {
						strength: DEFAULT_STRENGTH,
						mask: DEFAULT_MASK_STRENGTH,
					}),
					...(model.defaults.upscale != null && {
						upscale: model.defaults.upscale,
					}),
					...(model.defaults.durations && {
						durations: model.defaults.durations,
					}),
					...(model.englishPrompts && { englishPrompts: true }),
					...(model.loraBase && { loraBase: model.loraBase }),
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
		const loras = request.params.loras ?? [];
		if (spec && loras.length > 0)
			handle.loras = await this.checkLoras(spec, loras);
		const max = spec?.defaults.references?.max ?? 0;
		if (!spec || request.references.length === 0 || max === 0) return handle;
		const [first] = request.references;
		const readable = (data: Uint8Array) => {
			const picture = new Bun.Image(data);
			return picture
				.metadata()
				.then((size) => ({ picture, ...size }))
				.catch(() => {
					throw new ValidationError(
						"The reference picture cannot be read",
						"referenceUnreadable",
					);
				});
		};
		if (spec.defaults.upscale != null && first) {
			// As a PNG the engine surely reads, no larger than it can take.
			const { picture, width, height } = await readable(first.data);
			const shrink = Math.max(width, height) > MAX_UPSCALE_INPUT;
			const data = await (shrink
				? picture.resize(MAX_UPSCALE_INPUT, MAX_UPSCALE_INPUT, {
						fit: "inside",
					})
				: picture
			)
				.png()
				.bytes();
			handle.pictures = [{ data, extension: "png" }];
			return handle;
		}
		if (redraws(spec) && first) {
			// The new picture keeps the old one's shape, at the model's size;
			// the engine is given it at exactly that size.
			const { picture, width, height } = await readable(first.data);
			const size = dimensions(spec.defaults.size, `${width}:${height}`);
			handle.size = size;
			handle.pictures = [
				{
					data: await picture
						.resize(size.width, size.height, { fit: "fill" })
						.png()
						.bytes(),
					extension: "png",
				},
			];
			if (request.mask) {
				// Marked on the picture as shown: stretched the same way.
				const marked = await readable(request.mask.data);
				handle.mask = await marked.picture
					.resize(size.width, size.height, { fit: "fill" })
					.png()
					.bytes();
			}
			return handle;
		}
		handle.pictures = request.references.slice(0, max).map((reference) => ({
			data: reference.data,
			extension: reference.mime.split("/")[1] ?? "png",
		}));
		return handle;
	}

	/** The LoRAs asked for, each one there and made for this model. */
	private async checkLoras(
		spec: LocalModelSpec,
		asked: { id: string; weight: number }[],
	): Promise<HandleLora[]> {
		const checked: HandleLora[] = [];
		let other: string | null = null;
		for (const { id, weight } of asked) {
			const lora = await this.store.loras.get(id);
			// One prompt can go to models of different families, each with
			// LoRAs of its own: the others' are left out.
			if (!spec.loraBase || lora.base !== spec.loraBase) {
				other = lora.name;
				continue;
			}
			if (!checked.some((c) => c.id === id)) {
				checked.push({ id, weight, trigger: lora.trigger });
			}
		}
		if (checked.length > MAX_LORAS) {
			throw new ValidationError(
				`At most ${MAX_LORAS} LoRAs can be used at once`,
				"tooManyLoras",
				{ max: MAX_LORAS },
			);
		}
		if (checked.length === 0 && other) {
			throw new ValidationError(
				`${other} is not made for ${spec.name}`,
				"loraWrongBase",
				{ lora: other, model: spec.name },
			);
		}
		return checked;
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
			!handle.pictures?.length &&
			// Not checked with LoRAs yet: the engine run once is.
			!handle.loras?.length &&
			runtime.model.defaults.upscale == null &&
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
						prompt: loraPrompt(handle.params.prompt, []),
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
		// Written for this run and removed after it: a run tried again
		// writes them anew.
		const written: string[] = [];
		const write = async (data: Uint8Array, name: string) => {
			const file = join(runtime.scratch, `${crypto.randomUUID()}${name}`);
			written.push(file);
			await Bun.write(file, data);
			return file;
		};
		try {
			const references: string[] = [];
			for (const picture of handle.pictures ?? []) {
				references.push(await write(picture.data, `.${picture.extension}`));
			}
			const mask = handle.mask && (await write(handle.mask, "-mask.png"));
			const hold = yield* this.store.gpu.acquire(
				runtime.variant.memoryBytes,
				ctx.signal,
			);
			try {
				yield* this.once(runtime, handle, ctx, output, path, references, mask);
			} finally {
				hold.release();
			}
		} finally {
			for (const file of written) await rm(file, { force: true });
		}
	}

	/** Runs the engine once for this job. */
	private async *once(
		runtime: LocalRuntime,
		handle: LocalHandle,
		ctx: ProviderContext,
		output: string,
		path: PathMapper,
		references: string[],
		mask: string | undefined,
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
				references,
				handle.size,
				mask,
				await this.engineLoras(handle),
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
			for (let i = 0; i <= nextPreview + PREVIEWS_PER_JOB; i++) {
				await rm(previewFile(i), { force: true });
			}
		}
	}

	/** The handle's LoRAs, found where the models folder is now. */
	private async engineLoras(handle: LocalHandle): Promise<EngineLora[]> {
		const loras: EngineLora[] = [];
		for (const lora of handle.loras ?? []) {
			// Deleted since the job was asked for: say so, not a vague failure.
			await this.store.loras.get(lora.id);
			loras.push({ ...lora, path: this.store.loras.path(lora.id) });
		}
		return loras;
	}

	async cancel(): Promise<void> {
		// Aborting the job's signal already stops the engine.
	}

	/** Unloads a model kept loaded between pictures, unless a job uses it. */
	async unloadIdle(): Promise<void> {
		if (this.warm === false) return;
		// Windows lets go of the files only once the engine has exited.
		if (this.warm.unused) await this.warm.stopAndWait();
	}

	/** Unloads the model, so no engine outlives open-reel. */
	close(): void {
		if (this.warm) this.warm.stop();
		this.store.gpu.close();
	}
}
