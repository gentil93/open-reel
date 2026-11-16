import { z } from "zod";

export type Media = "image" | "video";
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
	  };

/** One file of a model that runs on this machine. */
export interface LocalModelFile {
	/** The name the file is known by, unique within its model. */
	name: string;
	/** Where to download it from. Pinned to a revision, so it never changes. */
	url: string;
	size: number;
	/** Checked after downloading. Files with the same hash are stored once. */
	sha256: string;
}

/** A sample of what a model produces, published by its authors. */
export interface LocalModelDemo {
	url: string;
	media: Media;
	caption?: string;
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
	files: LocalModelFile[];
	demos: LocalModelDemo[];
}

export type LocalModelState =
	| "available"
	| "queued"
	| "downloading"
	| "verifying"
	| "installed";

export interface LocalModelStatus
	extends Omit<LocalModelSpec, "files" | "demos"> {
	state: LocalModelState;
	files: { name: string; size: number; present: boolean }[];
	/** Demos are fetched through the server, by their position in this list. */
	demos: Omit<LocalModelDemo, "url">[];
	/** What the model takes on disk once installed. */
	size: number;
	/** How much of `size` is on disk now, counting interrupted downloads. */
	receivedBytes: number;
	/** What deleting it frees: files other installed models use stay. */
	reclaimableBytes: number;
	/** Why the last install stopped, if it failed. */
	error?: string;
}

export interface LocalModelsView {
	models: LocalModelStatus[];
	disk: {
		/** Where models are stored. */
		path: string;
		freeBytes: number;
		/** Taken by models, including interrupted downloads. */
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
