import type { AssetStore } from "./assets";
import type { JobPatch, Repository } from "./db/repository";
import { newId } from "./ids";
import type { KeyStore } from "./keys";
import { sniffMime } from "./mime";
import type {
	ProviderAdapter,
	ProviderOutput,
	ProviderRegistry,
	ReferenceImage,
} from "./provider";
import {
	type EngineEvent,
	type GenerationParams,
	type Job,
	type ModelSpec,
	TERMINAL_STATUSES,
	type UserContext,
} from "./types";

const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

function isResumable(adapter: ProviderAdapter, handle: unknown): boolean {
	return adapter.isResumable?.(handle) ?? adapter.resumable;
}

/** What a job cost going by the model's list price, when it has one. */
function estimateCost(
	model: ModelSpec,
	params: GenerationParams,
	outputs: number,
): number | null {
	const { usdPerSecond, usdPerOutput } = model.pricing ?? {};
	if (usdPerSecond != null && params.durationSeconds != null) {
		return usdPerSecond * params.durationSeconds * outputs;
	}
	return usdPerOutput == null ? null : usdPerOutput * outputs;
}

export type EngineListener = (userId: string, event: EngineEvent) => void;

export interface JobEngineDeps {
	repo: Repository;
	assets: AssetStore;
	registry: ProviderRegistry;
	keys: KeyStore;
	/** Jobs running at once per provider. Defaults to 4. */
	concurrencyPerProvider?: number;
}

/**
 * Runs jobs against their providers: queues them per provider, follows each
 * one to completion, stores the outputs and reports progress to listeners.
 */
export class JobEngine {
	private listeners = new Set<EngineListener>();
	private controllers = new Map<string, AbortController>();
	private waiting = new Map<string, string[]>();
	private active = new Map<string, number>();
	private inflight = new Set<Promise<void>>();
	private limit: number;

	constructor(private deps: JobEngineDeps) {
		this.limit = deps.concurrencyPerProvider ?? 4;
	}

	subscribe(listener: EngineListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Picks up jobs left unfinished by a previous process. */
	async start(): Promise<void> {
		for (const job of await this.deps.repo.listUnfinishedJobs()) {
			const adapter = this.deps.registry.adapter(job.providerId);
			const canContinue =
				job.status === "queued" ||
				(adapter != null &&
					job.handle != null &&
					isResumable(adapter, job.handle));
			if (canContinue) {
				this.enqueue(job);
			} else {
				await this.update(job.id, {
					status: "failed",
					error: "Interrupted by a restart",
					finishedAt: Date.now(),
				});
			}
		}
	}

	enqueue(job: Pick<Job, "id" | "providerId">): void {
		const queue = this.waiting.get(job.providerId) ?? [];
		queue.push(job.id);
		this.waiting.set(job.providerId, queue);
		this.pump(job.providerId);
	}

	async cancel(jobId: string): Promise<void> {
		const controller = this.controllers.get(jobId);
		if (controller) {
			controller.abort();
			return;
		}
		for (const queue of this.waiting.values()) {
			const index = queue.indexOf(jobId);
			if (index === -1) continue;
			queue.splice(index, 1);
			await this.update(jobId, { status: "canceled", finishedAt: Date.now() });
			return;
		}
	}

	/** Resolves once no job is queued or running. */
	async idle(): Promise<void> {
		while (this.inflight.size > 0) await Promise.all(this.inflight);
	}

	private pump(providerId: string): void {
		const queue = this.waiting.get(providerId) ?? [];
		while ((this.active.get(providerId) ?? 0) < this.limit) {
			const jobId = queue.shift();
			if (!jobId) return;
			this.active.set(providerId, (this.active.get(providerId) ?? 0) + 1);
			const run = this.run(jobId)
				// run() records its own failures; this only catches a failure to record
				// one (e.g. the database is unavailable). The job is settled on restart.
				.catch((error) =>
					console.error(`Job ${jobId} could not be settled`, error),
				)
				.finally(() => {
					this.inflight.delete(run);
					this.active.set(providerId, (this.active.get(providerId) ?? 1) - 1);
					this.pump(providerId);
				});
			this.inflight.add(run);
		}
	}

	private async run(jobId: string): Promise<void> {
		const job = await this.deps.repo.findJob(jobId);
		if (!job || TERMINAL_STATUSES.includes(job.status)) return;

		const controller = new AbortController();
		this.controllers.set(jobId, controller);
		const { registry, keys } = this.deps;
		const adapter = registry.adapter(job.providerId);
		const ctx: UserContext = { userId: job.userId };
		let handle = job.handle;
		let pctx = {
			apiKey: undefined as string | undefined,
			signal: controller.signal,
		};

		try {
			const model = registry.model(job.modelId);
			if (!adapter || !model) {
				throw new Error(`Model is not available: ${job.modelId}`);
			}
			const apiKey =
				(await keys.get(ctx, adapter.id)) ??
				(adapter.keyEnv ? process.env[adapter.keyEnv] : undefined);
			if (adapter.requiresKey && !apiKey) {
				throw new Error(`No API key configured for ${adapter.name}`);
			}
			pctx = { apiKey, signal: controller.signal };

			if (handle == null) {
				await this.update(jobId, { status: "running", startedAt: Date.now() });
				const references = await this.loadReferences(
					ctx,
					job.params.referenceAssetIds,
				);
				handle = await adapter.submit(
					{ model, params: job.params, references },
					pctx,
				);
				// Only a resumable handle is worth storing; others can embed whole images.
				if (isResumable(adapter, handle)) await this.update(jobId, { handle });
			}

			for await (const event of adapter.events(handle, pctx)) {
				if (event.type === "progress") {
					this.emit(job.userId, {
						type: "job.progress",
						jobId,
						fraction: event.fraction,
						message: event.message,
					});
				} else if (event.type === "failed") {
					throw new Error(event.error);
				} else {
					for (const output of event.outputs) {
						await this.storeOutput(ctx, job, output, controller.signal);
					}
					await this.update(jobId, {
						status: "succeeded",
						error: null,
						finishedAt: Date.now(),
						costUsd:
							event.costUsd ??
							estimateCost(model, job.params, event.outputs.length),
					});
					return;
				}
			}
			throw new Error("The provider ended without a result");
		} catch (error) {
			if (controller.signal.aborted) {
				if (handle != null) {
					// The job is canceled locally either way; this only saves provider-side work.
					await adapter
						?.cancel?.(handle, {
							...pctx,
							signal: new AbortController().signal,
						})
						.catch(() => {});
				}
				await this.update(jobId, {
					status: "canceled",
					finishedAt: Date.now(),
				});
			} else {
				await this.update(jobId, {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					finishedAt: Date.now(),
				});
			}
		} finally {
			this.controllers.delete(jobId);
		}
	}

	private async loadReferences(
		ctx: UserContext,
		assetIds: string[],
	): Promise<ReferenceImage[]> {
		const assets = await this.deps.repo.getAssets(ctx, assetIds);
		return Promise.all(
			assetIds.map(async (id) => {
				const asset = assets.find((a) => a.id === id);
				const blob = asset && (await this.deps.assets.get(ctx, asset.hash));
				if (!asset || !blob)
					throw new Error(`Reference image is missing: ${id}`);
				return { data: await blob.bytes(), mime: asset.mime };
			}),
		);
	}

	private async storeOutput(
		ctx: UserContext,
		job: Job,
		output: ProviderOutput,
		signal: AbortSignal,
	): Promise<void> {
		let data: Uint8Array;
		let mime = output.mime;
		if ("url" in output) {
			// A provider's response must not be able to make us read local files.
			if (!output.url.startsWith("https://")) {
				throw new Error("The provider returned a result URL that is not HTTPS");
			}
			const response = await fetch(output.url, {
				headers: output.headers,
				signal,
			});
			if (!response.ok) {
				throw new Error(
					`Could not download the result (HTTP ${response.status})`,
				);
			}
			if (Number(response.headers.get("content-length")) > MAX_OUTPUT_BYTES) {
				throw new Error("The result is too large to store");
			}
			data = await response.bytes();
			mime ??= response.headers.get("content-type")?.split(";")[0];
		} else {
			data = output.data;
		}
		if (data.byteLength > MAX_OUTPUT_BYTES) {
			throw new Error("The result is too large to store");
		}
		const stored = await this.deps.assets.put(ctx, data);
		await this.deps.repo.createAsset({
			id: newId("ast"),
			userId: ctx.userId,
			kind: "output",
			jobId: job.id,
			prompt: job.params.prompt,
			modelId: job.modelId,
			params: job.params,
			hash: stored.hash,
			// Providers and their CDNs mislabel files often enough to check.
			mime: sniffMime(data) ?? mime ?? "application/octet-stream",
			size: stored.size,
			createdAt: Date.now(),
		});
	}

	private async update(jobId: string, patch: JobPatch): Promise<void> {
		await this.deps.repo.updateJob(jobId, patch);
		const job = await this.deps.repo.findJob(jobId);
		if (job) this.emit(job.userId, { type: "job.updated", job });
	}

	private emit(userId: string, event: EngineEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(userId, event);
			} catch (error) {
				// A broken listener must not change the outcome of a job.
				console.error("A job event listener failed", error);
			}
		}
	}
}
