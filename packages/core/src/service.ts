import type { AssetStore } from "./assets";
import type { GalleryQuery, Repository } from "./db/repository";
import type { JobEngine } from "./engine";
import { NotFoundError, ValidationError } from "./errors";
import { newId } from "./ids";
import type { KeyStore } from "./keys";
import type { ProviderRegistry } from "./provider";
import {
	type Asset,
	type CreateTurnInput,
	type GalleryItem,
	type GenerationParams,
	generationParamsSchema,
	type Job,
	type ModelSpec,
	type ProviderStatus,
	type Session,
	type Turn,
	type TurnView,
	type UserContext,
} from "./types";

export interface ReelServiceDeps {
	repo: Repository;
	assets: AssetStore;
	registry: ProviderRegistry;
	keys: KeyStore;
	engine: JobEngine;
}

/** The image type the bytes really are, whatever the uploader claimed. */
function sniffImageMime(data: Uint8Array): string | null {
	const starts = (bytes: number[], at = 0) =>
		bytes.every((byte, i) => data[at + i] === byte);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	// "RIFF" <size> "WEBP"
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8))
		return "image/webp";
	return null;
}

/** Fits the requested parameters to what one model supports. */
export function adaptParams(
	model: ModelSpec,
	params: GenerationParams,
): GenerationParams {
	const caps = model.capabilities;
	if (params.referenceAssetIds.length > caps.maxReferenceImages) {
		throw new ValidationError(
			caps.maxReferenceImages === 0
				? `${model.name} does not accept reference images`
				: `${model.name} accepts at most ${caps.maxReferenceImages} reference images`,
		);
	}
	return {
		...params,
		count: Math.min(params.count, caps.maxCount),
		aspectRatio:
			params.aspectRatio && caps.aspectRatios.includes(params.aspectRatio)
				? params.aspectRatio
				: undefined,
		seed: caps.seed ? params.seed : undefined,
	};
}

/** The application's operations, shared by every interface (HTTP, CLI, desktop). */
export class ReelService {
	constructor(private deps: ReelServiceDeps) {}

	listModels(): ModelSpec[] {
		return this.deps.registry.listModels();
	}

	async listProviders(ctx: UserContext): Promise<ProviderStatus[]> {
		const stored = await this.deps.keys.list(ctx);
		return this.deps.registry.listAdapters().map((adapter) => ({
			id: adapter.id,
			name: adapter.name,
			requiresKey: adapter.requiresKey,
			hasKey:
				stored.includes(adapter.id) ||
				Boolean(adapter.keyEnv && process.env[adapter.keyEnv]),
		}));
	}

	async setProviderKey(ctx: UserContext, providerId: string, key: string) {
		this.requireProvider(providerId);
		if (!key.trim()) throw new ValidationError("The key is empty");
		await this.deps.keys.set(ctx, providerId, key.trim());
	}

	async deleteProviderKey(ctx: UserContext, providerId: string) {
		this.requireProvider(providerId);
		await this.deps.keys.delete(ctx, providerId);
	}

	private requireProvider(providerId: string) {
		if (!this.deps.registry.adapter(providerId)) {
			throw new NotFoundError(`Unknown provider: ${providerId}`);
		}
	}

	listSessions(ctx: UserContext): Promise<Session[]> {
		return this.deps.repo.listSessions(ctx);
	}

	async getSession(
		ctx: UserContext,
		id: string,
	): Promise<Session & { turns: TurnView[] }> {
		const session = await this.deps.repo.getSession(ctx, id);
		if (!session) throw new NotFoundError("Session not found");
		return { ...session, turns: await this.deps.repo.listTurns(ctx, id) };
	}

	async deleteSession(ctx: UserContext, id: string): Promise<void> {
		const session = await this.getSession(ctx, id);
		for (const job of session.turns.flatMap((turn) => turn.jobs)) {
			await this.deps.engine.cancel(job.id);
		}
		await this.deps.repo.deleteSession(ctx, id);
	}

	async createTurn(
		ctx: UserContext,
		input: CreateTurnInput,
	): Promise<{ session: Session; turn: TurnView }> {
		const { sessionId, modelIds, ...rawParams } = input;
		const parsed = generationParamsSchema.safeParse(rawParams);
		if (!parsed.success) {
			throw new ValidationError(
				parsed.error.issues[0]?.message ?? "Invalid input",
			);
		}
		const params = parsed.data;
		if (modelIds.length === 0)
			throw new ValidationError("Choose at least one model");

		const models = [...new Set(modelIds)].map((id) => {
			const model = this.deps.registry.model(id);
			if (!model) throw new ValidationError(`Unknown model: ${id}`);
			return model;
		});
		const references = await this.deps.repo.getAssets(
			ctx,
			params.referenceAssetIds,
		);
		if (references.length !== new Set(params.referenceAssetIds).size) {
			throw new ValidationError("A reference image was not found");
		}
		const jobParams = models.map((model) => adaptParams(model, params));

		const now = Date.now();
		let session: Session;
		if (sessionId) {
			const existing = await this.deps.repo.getSession(ctx, sessionId);
			if (!existing) throw new NotFoundError("Session not found");
			session = { ...existing, updatedAt: now };
		} else {
			session = {
				id: newId("ses"),
				userId: ctx.userId,
				title: params.prompt.slice(0, 80),
				createdAt: now,
				updatedAt: now,
			};
			await this.deps.repo.createSession(session);
		}

		const turn: Turn = {
			id: newId("trn"),
			sessionId: session.id,
			userId: ctx.userId,
			prompt: params.prompt,
			referenceAssetIds: params.referenceAssetIds,
			createdAt: now,
		};
		const jobs: Job[] = models.map((model, index) => ({
			id: newId("job"),
			turnId: turn.id,
			position: index,
			userId: ctx.userId,
			providerId: model.providerId,
			modelId: model.id,
			params: jobParams[index] as GenerationParams,
			status: "queued",
			handle: null,
			error: null,
			costUsd: null,
			createdAt: now,
			startedAt: null,
			finishedAt: null,
		}));
		await this.deps.repo.createTurn(turn, jobs);
		for (const job of jobs) this.deps.engine.enqueue(job);

		return {
			session,
			turn: { ...turn, jobs: jobs.map((job) => ({ ...job, assets: [] })) },
		};
	}

	async cancelJob(ctx: UserContext, jobId: string): Promise<void> {
		const job = await this.deps.repo.findJob(jobId);
		if (!job || job.userId !== ctx.userId)
			throw new NotFoundError("Job not found");
		await this.deps.engine.cancel(jobId);
	}

	async uploadAsset(ctx: UserContext, data: Uint8Array): Promise<Asset> {
		const mime = sniffImageMime(data);
		if (!mime) {
			throw new ValidationError(
				"Only PNG, JPEG and WebP images can be uploaded",
			);
		}
		const stored = await this.deps.assets.put(ctx, data);
		const asset: Asset = {
			id: newId("ast"),
			userId: ctx.userId,
			kind: "upload",
			jobId: null,
			hash: stored.hash,
			mime,
			size: stored.size,
			prompt: null,
			modelId: null,
			params: null,
			createdAt: Date.now(),
		};
		await this.deps.repo.createAsset(asset);
		return asset;
	}

	async getAssetFile(
		ctx: UserContext,
		id: string,
	): Promise<{ asset: Asset; blob: Blob }> {
		const [asset] = await this.deps.repo.getAssets(ctx, [id]);
		const blob = asset && (await this.deps.assets.get(ctx, asset.hash));
		if (!asset || !blob) throw new NotFoundError("Asset not found");
		return { asset, blob };
	}

	listGallery(ctx: UserContext, query: GalleryQuery): Promise<GalleryItem[]> {
		return this.deps.repo.listGallery(ctx, query);
	}
}
