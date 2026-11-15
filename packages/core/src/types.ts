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
	pricing?: { usdPerOutput: number };
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
