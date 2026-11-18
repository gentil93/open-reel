import type { JobView, ModelSpec, TurnView } from "@open-reel/core/types";

export const TERMINAL = ["succeeded", "failed", "canceled"];

export const isLocal = (model: ModelSpec) => model.providerId === "local";
export const done = (jobs: JobView[]) =>
	jobs.every((job) => TERMINAL.includes(job.status));
export const money = (usd: number) => `$${usd.toFixed(2)}`;

/** What a job may cost, or null when the model does not say. */
export function estimate(
	model: ModelSpec,
	count: number,
	seconds: number | undefined,
): number | null {
	if (isLocal(model)) return 0;
	const price = model.pricing;
	if (price?.usdPerOutput != null) return price.usdPerOutput * count;
	if (price?.usdPerSecond != null) {
		const length = seconds ?? model.capabilities.durations?.[0] ?? 5;
		return price.usdPerSecond * length * count;
	}
	return null;
}

/** What turns cost each model, by its id, as expected before they run. */
export type Expected = Map<string, number>;

/**
 * Keeps paid generations within a limit. What a turn may cost is held from
 * before it is made until it ends, however it is followed, so calls made
 * meanwhile see it; once it ends, what it really cost is counted.
 */
export class SpendGuard {
	/** Spent on turns that have ended. */
	private spentUsd = 0;
	private held = new Map<string, { usd: number; perJob: Expected }>();

	constructor(readonly limitUsd: number | null) {}

	/** Spent, and held for turns still running. */
	committed(): number {
		return (
			this.spentUsd + [...this.held.values()].reduce((sum, h) => sum + h.usd, 0)
		);
	}

	/** What is left under the limit; null without one. */
	left(): number | null {
		return this.limitUsd == null
			? null
			: Math.max(0, this.limitUsd - this.committed());
	}

	/**
	 * Holds what a turn with these models may cost, under a key to move or
	 * release it by; or says why it may not run.
	 */
	hold(
		key: string,
		models: ModelSpec[],
		count: number,
		seconds: number | undefined,
	): { ok: true; usd: number } | { ok: false; reason: string } {
		const perJob: Expected = new Map();
		for (const model of models) {
			const usd = estimate(model, count, seconds);
			if (usd == null) {
				if (this.limitUsd != null) {
					return {
						ok: false,
						reason: `${model.name} does not say what it costs, so it cannot be kept within the spending limit.`,
					};
				}
			} else {
				perJob.set(model.id, usd);
			}
		}
		const usd = [...perJob.values()].reduce((sum, value) => sum + value, 0);
		const limit = this.limitUsd;
		if (limit != null && usd > 0 && this.committed() + usd > limit) {
			return {
				ok: false,
				reason: `This would cost about ${money(usd)}, over what is left of the ${money(limit)} limit (${money(Math.max(0, limit - this.committed()))}).`,
			};
		}
		this.held.set(key, { usd, perJob });
		return { ok: true, usd };
	}

	/** Lets a hold go: what it was for never started. */
	release(key: string): void {
		this.held.delete(key);
	}

	/** Moves a hold to the turn it became. */
	rename(from: string, to: string): void {
		const hold = this.held.get(from);
		if (!hold) return;
		this.held.delete(from);
		this.held.set(to, hold);
	}

	/** Counts what an ended turn cost, once, and lets its hold go. */
	settle(turn: TurnView): void {
		const hold = this.held.get(turn.id);
		if (!hold || !done(turn.jobs)) return;
		this.held.delete(turn.id);
		for (const job of turn.jobs) {
			if (job.providerId === "local") continue;
			// A paid job that made something and said no price costs what it
			// was expected to.
			this.spentUsd +=
				job.costUsd ??
				(job.status === "succeeded" ? (hold.perJob.get(job.modelId) ?? 0) : 0);
		}
	}
}
