import type {
	EngineEvent,
	JobView,
	LocalModelEvent,
} from "@open-reel/core/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { SessionDetail } from "./api";

// Latest progress message per running job. Kept outside the query cache
// because it changes often and is never fetched.
const progress = new Map<string, string>();
const watchers = new Set<() => void>();
const notify = () => {
	for (const watcher of watchers) watcher();
};

export function useProgress(jobId: string): string | undefined {
	return useSyncExternalStore(
		(watcher) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		() => progress.get(jobId),
	);
}

type ModelProgress = Extract<LocalModelEvent, { type: "model.progress" }>;
// Latest progress per model being installed, for the same reason.
const modelProgress = new Map<string, ModelProgress>();

export function useModelProgress(modelId: string): ModelProgress | undefined {
	return useSyncExternalStore(
		(watcher) => {
			watchers.add(watcher);
			return () => watchers.delete(watcher);
		},
		() => modelProgress.get(modelId),
	);
}

async function applyJob(client: QueryClient, job: JobView): Promise<void> {
	// A fetch already in flight may carry an older state of this job and would
	// overwrite the update when it lands.
	await client.cancelQueries({ queryKey: ["session"] });
	let found = false;
	client.setQueriesData<SessionDetail>({ queryKey: ["session"] }, (session) => {
		if (!session?.turns.some((t) => t.jobs.some((j) => j.id === job.id))) {
			return session;
		}
		found = true;
		return {
			...session,
			turns: session.turns.map((turn) => ({
				...turn,
				jobs: turn.jobs.map((j) => (j.id === job.id ? job : j)),
			})),
		};
	});
	// The turn may not be in the cache yet (its request is still in flight).
	if (!found) void client.invalidateQueries({ queryKey: ["session"] });
	if (job.status === "succeeded") {
		void client.invalidateQueries({ queryKey: ["gallery"] });
	}
}

/** Keeps cached sessions in step with the server's job events. */
export function useLiveJobs(): void {
	const client = useQueryClient();
	useEffect(() => {
		const source = new EventSource("/api/events");
		let order: Promise<void> = Promise.resolve();
		let connectedBefore = false;
		source.addEventListener("ready", () => {
			// After a reconnect, events may have been missed.
			if (connectedBefore) {
				void client.invalidateQueries({ queryKey: ["session"] });
				void client.invalidateQueries({ queryKey: ["local-models"] });
			}
			connectedBefore = true;
		});
		source.addEventListener("models.changed", () => {
			// An install started or ended; what was known about it is stale.
			modelProgress.clear();
			notify();
			void client.invalidateQueries({ queryKey: ["local-models"] });
		});
		source.addEventListener("model.progress", (message) => {
			const event = JSON.parse(message.data) as LocalModelEvent;
			if (event.type !== "model.progress") return;
			modelProgress.set(event.id, event);
			notify();
		});
		source.addEventListener("job.updated", (message) => {
			const event = JSON.parse(message.data) as EngineEvent;
			if (event.type !== "job.updated") return;
			if (event.job.status !== "running") progress.delete(event.job.id);
			order = order.then(() => applyJob(client, event.job));
			notify();
		});
		source.addEventListener("job.progress", (message) => {
			const event = JSON.parse(message.data) as EngineEvent;
			if (event.type !== "job.progress") return;
			const text =
				event.message ??
				(event.fraction == null
					? undefined
					: `${Math.round(event.fraction * 100)}%`);
			if (text) progress.set(event.jobId, text);
			notify();
		});
		return () => source.close();
	}, [client]);
}
