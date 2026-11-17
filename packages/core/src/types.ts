import { z } from "zod";
import type { ErrorParams } from "./errors";

export type Media = "image" | "video";

/** Where a job is, in words every provider can say the same way. */
export type ProgressStage = "queued" | "starting" | "loading" | "generating";
export type Operation = "generate" | "edit";

/** Who an operation runs for. Local installs use a single fixed user. */
export interface UserContext {
	userId: string;
}

export const LOCAL_USER: UserContext = { userId: "local" };

export const generationParamsSchema = z.object({
	prompt: z.string().trim().min(1),
	aspectRatio: z
		.string()
		.regex(/^\d+:\d+$/)
		.optional(),
	seed: z.number().int().nonnegative().optional(),
	count: z.number().int().min(1).max(8).default(1),
	/** Length of a video. Ignored by image models. */
	durationSeconds: z.number().int().min(1).max(120).optional(),
	referenceAssetIds: z.array(z.string()).default([]),
	/** Model-specific parameters, passed through to the provider untouched. */
	extras: z.record(z.string(), z.unknown()).default({}),
});

export type GenerationParams = z.infer<typeof generationParamsSchema>;
export type GenerationParamsInput = z.input<typeof generationParamsSchema>;

export interface ModelCapabilities {
	/** Supported ratios such as "16:9". Empty means the model has no ratio control. */
	aspectRatios: string[];
	seed: boolean;
	maxCount: number;
	/** 0 means the model cannot take reference images. */
	maxReferenceImages: number;
	/**
	 * Video lengths in seconds the model can produce, ascending. Absent or empty
	 * means the length cannot be chosen.
	 */
	durations?: number[];
}

/** What a model is good at, shown as tags; the interface translates each. */
export type BestFor =
	| "speed"
	| "drafts"
	| "photo"
	| "text"
	| "illustration"
	| "editing"
	| "instructions"
	| "detail"
	| "motion"
	| "cinema"
	| "sound";

/**
 * How a model compares with others, so people can choose without knowing
 * model names. Curated by the project, not reported by providers.
 */
export interface ModelProfile {
	/**
	 * The same model reached through different services shares a family, so
	 * it is shown once, e.g. Nano Banana through Google, fal and OpenRouter.
	 */
	family: string;
	/** The family's name as people know it. */
	name: string;
	/** Who made the model. */
	author: string;
	/** 1 slow to 3 fast, relative to other models of the same media. */
	speed: 1 | 2 | 3;
	/** 1 basic to 3 best, relative to other models of the same media. */
	quality: 1 | 2 | 3;
	/** Writes legible words inside pictures. */
	text: boolean;
	bestFor: BestFor[];
	/**
	 * A picture of the shared comparison prompt made with this model, by its
	 * file name among the interface's samples.
	 */
	sample?: string;
}

export interface ModelSpec {
	/** Globally unique: `${providerId}/${providerModelId}`. */
	id: string;
	providerId: string;
	providerModelId: string;
	name: string;
	media: Media;
	operations: Operation[];
	capabilities: ModelCapabilities;
	/** Used to estimate a job's cost when the provider does not report one. */
	pricing?: { usdPerOutput?: number; usdPerSecond?: number };
	/** Absent for models the project has not described yet. */
	profile?: ModelProfile;
}

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "canceled";

export const TERMINAL_STATUSES: readonly JobStatus[] = [
	"succeeded",
	"failed",
	"canceled",
];

export interface Session {
	id: string;
	userId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

export interface Turn {
	id: string;
	sessionId: string;
	userId: string;
	prompt: string;
	referenceAssetIds: string[];
	createdAt: number;
}

export interface Job {
	id: string;
	turnId: string;
	/** Order within the turn, matching the order the models were chosen in. */
	position: number;
	userId: string;
	providerId: string;
	modelId: string;
	/** The parameters actually sent, after adapting to the model's capabilities. */
	params: GenerationParams;
	status: JobStatus;
	/** Provider-side reference used to re-attach after a restart. */
	handle: unknown | null;
	error: string | null;
	/** Lets the interface say `error` in the reader's language. */
	errorCode: string | null;
	errorParams: ErrorParams | null;
	costUsd: number | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
}

export type AssetKind = "output" | "upload";

export interface Asset {
	id: string;
	userId: string;
	kind: AssetKind;
	/** Null for uploads, and for outputs whose session was deleted. */
	jobId: string | null;
	hash: string;
	mime: string;
	size: number;
	/** What produced an output. Stored here so it outlives the session. */
	prompt: string | null;
	modelId: string | null;
	params: GenerationParams | null;
	createdAt: number;
}

export interface JobView extends Job {
	assets: Asset[];
}

export interface TurnView extends Turn {
	jobs: JobView[];
}

export type GalleryItem = Asset;

export interface CreateTurnInput extends GenerationParamsInput {
	/** Omit to start a new session. */
	sessionId?: string;
	/** One job is created per model; more than one makes a comparison. */
	modelIds: string[];
}

export interface ProviderStatus {
	id: string;
	name: string;
	requiresKey: boolean;
	hasKey: boolean;
}

export type EngineEvent =
	| { type: "job.updated"; job: JobView }
	| {
			type: "job.progress";
			jobId: string;
			fraction?: number;
			message?: string;
			stage?: ProgressStage;
			position?: number;
			step?: number;
			steps?: number;
	  };

export type GpuVendor = "nvidia" | "amd" | "apple" | "intel";

export interface Gpu {
	vendor: GpuVendor;
	name: string;
	/** Memory the GPU can use. On Apple silicon it shares the system's. */
	memoryBytes: number;
	/** The NVIDIA driver version, which decides the CUDA versions it runs. */
	driver?: string;
}

export interface Hardware {
	os: "linux" | "darwin" | "win32" | "other";
	arch: "x64" | "arm64" | "other";
	/** Linux under Windows: the GPU is reached through the Windows driver. */
	wsl: boolean;
	memoryBytes: number;
	gpus: Gpu[];
}

/** How an engine reaches the hardware. */
export type Backend = "cuda" | "rocm" | "metal" | "vulkan" | "cpu";

/** How well a variant of a model runs on this machine. */
export type Fit =
	/** On the GPU, at full speed. */
	| "gpu"
	/** On the GPU, moving weights in from system memory: slower. */
	| "offload"
	/** On the CPU: much slower. */
	| "cpu"
	/** Not at all: it does not fit in this machine's memory. */
	| "none";

/** A file to download, checked by its hash after downloading. */
export interface LocalModelFile {
	/** The name the file is known by, unique within its variant or build. */
	name: string;
	/** Where to download it from. Pinned to a revision, so it never changes. */
	url: string;
	size: number;
	/** Files with the same hash are stored once. */
	sha256: string;
	/** What the engine uses it for, e.g. "vae". */
	role?: string;
}

/** What is needed to pick a build for a machine. */
export interface EngineBuildSpec {
	id: string;
	engine: string;
	backend: Backend;
	os: "linux" | "darwin" | "win32";
	arch: "x64" | "arm64";
	/** The oldest NVIDIA driver it runs on, as `major.minor`. */
	minNvidiaDriver?: string;
}

/** One downloadable build of an engine, for one platform and backend. */
export interface EngineBuild extends EngineBuildSpec {
	version: string;
	/** Zip archives, extracted together into the build's folder. */
	files: LocalModelFile[];
	/** The program to run, relative to the build's folder. */
	executable: string;
}

/** A program that runs local models. */
export interface LocalEngineSpec {
	id: string;
	name: string;
	homepage: string;
	license: string;
	builds: EngineBuild[];
}

/** What is needed to pick a variant for a machine. */
export interface VariantSpec {
	id: string;
	/** What sets it apart, e.g. "4-bit". */
	label: string;
	engine: string;
	/** GPU memory to run at full speed, without offloading. */
	memoryBytes: number;
}

/** One way to run a model: its weights at one precision, for one engine. */
export interface LocalModelVariant extends VariantSpec {
	files: LocalModelFile[];
}

/** A sample of what a model produces, published by its authors. */
export interface LocalModelDemo {
	url: string;
	media: Media;
	caption?: string;
}

/** How a local model is run when the request does not say otherwise. */
export interface LocalModelDefaults {
	/** The longer side of the output, in pixels; the other follows the ratio. */
	size: number;
	aspectRatios: string[];
	steps: number;
	cfgScale: number;
	sampler?: string;
	/** Tells the model what to avoid; some models are trained to expect one. */
	negativePrompt?: string;
	/** Shift of the noise schedule, for flow models such as Wan. */
	flowShift?: number;
	/** Video models: frames per second, and the lengths they can make. */
	fps?: number;
	durations?: number[];
}

/** A model that can be downloaded and kept on this machine. */
export interface LocalModelSpec {
	id: string;
	name: string;
	author: string;
	media: Media;
	summary: string;
	license: string;
	/** The model's page, for its full description and license terms. */
	homepage: string;
	/** Best quality first. */
	variants: LocalModelVariant[];
	demos: LocalModelDemo[];
	defaults: LocalModelDefaults;
	profile?: ModelProfile;
}

export type LocalModelState =
	| "available"
	| "queued"
	| "downloading"
	| "verifying"
	| "installed";

export interface LocalVariantStatus extends VariantSpec {
	fit: Fit;
	/** What its files take on disk. */
	size: number;
	files: { name: string; size: number; present: boolean }[];
}

export interface LocalModelStatus
	extends Omit<LocalModelSpec, "variants" | "demos" | "defaults"> {
	state: LocalModelState;
	variants: LocalVariantStatus[];
	/**
	 * The variant installed, or being installed, or the one an install would
	 * pick for this machine. Null when no variant runs here.
	 */
	variant: string | null;
	/** Whether `variant` is installed, rather than proposed. */
	installed: boolean;
	/** Installed with its engine, so it can run. */
	ready: boolean;
	/** What installing `variant` downloads: its files and, if missing, its engine. */
	size: number;
	/** How much of `size` is on disk now, counting interrupted downloads. */
	receivedBytes: number;
	/** What deleting it frees: files other installed models use stay. */
	reclaimableBytes: number;
	/** Demos are fetched through the server, by their position in this list. */
	demos: Omit<LocalModelDemo, "url">[];
	/** Why the last install stopped, if it failed. */
	error?: string;
	/** Lets the interface say `error` in the reader's language. */
	errorCode?: string;
	errorParams?: ErrorParams;
}

/** The build of an engine this machine would run. */
export interface LocalEngineStatus {
	engine: string;
	name: string;
	build: string;
	version: string;
	backend: Backend;
	/** Run from WSL as a Windows program, to reach the GPU. */
	throughWindows: boolean;
	installed: boolean;
	/** What it takes to download. */
	size: number;
	/** Installed models that run on it. It is deleted with the last one. */
	usedBy: string[];
}

export interface LocalModelsView {
	hardware: Hardware;
	engines: LocalEngineStatus[];
	models: LocalModelStatus[];
	disk: {
		/** Where models and engines are stored. */
		path: string;
		freeBytes: number;
		/** Taken by models and engines, including interrupted downloads. */
		usedBytes: number;
	};
}

export type LocalModelEvent =
	/** A model was installed, deleted, or its install started or stopped. */
	| { type: "models.changed" }
	| {
			type: "model.progress";
			id: string;
			state: LocalModelState;
			receivedBytes: number;
			size: number;
			bytesPerSecond: number;
	  };
