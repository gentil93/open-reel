import type { ProviderEvent } from "../provider";
import type { Spawn } from "./provider";

/**
 * Keeps a local model loaded between pictures by running the engine as a
 * server (stable-diffusion.cpp's `sd-server`) instead of once per picture.
 * Loading a model takes seconds; with it loaded, SDXL Turbo makes a picture
 * in under half a second instead of about five.
 *
 * One model is loaded at a time, since they share the GPU's memory. The
 * server stops after a while unused, to give that memory back.
 */

/** How long a loaded model waits for another job before it is unloaded. */
export const IDLE_MS = 10 * 60_000;
/** How long a model may take to load before the server is given up on. */
const START_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 250;

/** A request the server understands: `/sdcpp/v1/img_gen` or `vid_gen`. */
export interface WarmRequest {
	video: boolean;
	prompt: string;
	negativePrompt?: string;
	width: number;
	height: number;
	seed: number;
	steps: number;
	cfgScale: number;
	sampler?: string;
	flowShift?: number;
	frames?: number;
	fps?: number;
}

interface Running {
	key: string;
	url: string;
	stop(): void;
	exited: Promise<number>;
}

interface JobStatus {
	status: "queued" | "generating" | "completed" | "failed" | "cancelled";
	progress?: {
		completed?: number | null;
		total?: number | null;
		unit?: string;
	};
	result?: {
		images?: { b64_json: string }[];
		b64_json?: string;
		mime_type?: string;
	} | null;
	error?: { code?: string; message?: string } | null;
}

export interface WarmEnginesOptions {
	spawn: Spawn;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** A free loopback port for a new server. */
	freePort?: () => Promise<number>;
	idleMs?: number;
}

async function freeLoopbackPort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	probe.stop(true);
	return port as number;
}

export class WarmEngines {
	private running: Running | null = null;
	private starting: Promise<Running> | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private spawn: Spawn;
	private fetch: (url: string, init?: RequestInit) => Promise<Response>;
	private freePort: () => Promise<number>;
	private idleMs: number;

	constructor(options: WarmEnginesOptions) {
		this.spawn = options.spawn;
		this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.freePort = options.freePort ?? freeLoopbackPort;
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	/** The model loaded now, by the key it was started with. */
	get loaded(): string | null {
		return this.running?.key ?? null;
	}

	/**
	 * A server with `key`'s model loaded, started from `argv` (the server
	 * program and its model options) if it is not running already.
	 */
	private async server(
		key: string,
		argv: string[],
		signal: AbortSignal,
	): Promise<Running> {
		if (this.running?.key === key) return this.running;
		if (this.starting) await this.starting.catch(() => {});
		if (this.running?.key === key) return this.running;
		this.stop();
		this.starting = this.start(key, argv, signal);
		try {
			this.running = await this.starting;
			return this.running;
		} finally {
			this.starting = null;
		}
	}

	private async start(
		key: string,
		argv: string[],
		signal: AbortSignal,
	): Promise<Running> {
		const port = await this.freePort();
		const child = this.spawn([
			...argv,
			"--listen-ip",
			"127.0.0.1",
			"--listen-port",
			String(port),
		]);
		const url = `http://127.0.0.1:${port}`;
		const tail: string[] = [];
		let up = false;
		// Reads the output so the pipe never fills, and learns when it listens.
		const reading = (async () => {
			for await (const line of child.output) {
				if (line.trim()) tail.push(line.trim());
				if (tail.length > 20) tail.shift();
				if (/listening on/i.test(line)) up = true;
			}
		})();
		reading.catch(() => {});
		let exited = false;
		void child.exited.then(() => {
			exited = true;
			if (this.running?.key === key) this.running = null;
		});
		const started = Date.now();
		while (!up) {
			if (exited || signal.aborted || Date.now() - started > START_TIMEOUT_MS) {
				child.kill();
				const reason =
					tail.filter((l) => /error|fail/i.test(l)).at(-1) ??
					(signal.aborted ? "canceled" : "the engine server did not start");
				throw new Error(reason.replace(/^\[\w\]\s*/, ""));
			}
			await Bun.sleep(POLL_MS);
		}
		return { key, url, stop: () => child.kill(), exited: child.exited };
	}

	/** Unloads the model, freeing the GPU's memory. */
	stop(): void {
		clearTimeout(this.idle);
		this.running?.stop();
		this.running = null;
	}

	/**
	 * Runs one job on the server for `key`, starting it with `argv` if needed.
	 * Throws if the server cannot be started, so the caller can fall back to
	 * running the engine once for this job.
	 */
	async *run(
		key: string,
		argv: string[],
		request: WarmRequest,
		signal: AbortSignal,
	): AsyncIterable<ProviderEvent> {
		clearTimeout(this.idle);
		const fresh = this.running?.key !== key;
		if (fresh) {
			yield {
				type: "progress",
				message: "Loading the model",
				stage: "loading",
			};
		}
		const server = await this.server(key, argv, signal);
		try {
			yield* this.job(server, request, signal);
		} finally {
			clearTimeout(this.idle);
			this.idle = setTimeout(() => this.stop(), this.idleMs);
		}
	}

	private async *job(
		server: Running,
		request: WarmRequest,
		signal: AbortSignal,
	): AsyncIterable<ProviderEvent> {
		const body = {
			prompt: request.prompt,
			negative_prompt: request.negativePrompt ?? "",
			width: request.width,
			height: request.height,
			seed: request.seed,
			sample_params: {
				sample_steps: request.steps,
				guidance: { txt_cfg: request.cfgScale },
				...(request.sampler && { sample_method: request.sampler }),
				...(request.flowShift != null && { flow_shift: request.flowShift }),
			},
			...(request.video
				? {
						video_frames: request.frames,
						fps: request.fps,
						output_format: "webm",
					}
				: { batch_count: 1, output_format: "png" }),
		};
		const submitted = await this.fetch(
			`${server.url}/sdcpp/v1/${request.video ? "vid_gen" : "img_gen"}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		if (!submitted.ok) {
			throw new Error(`The engine refused the job (HTTP ${submitted.status})`);
		}
		const { id } = (await submitted.json()) as { id: string };
		const cancel = () =>
			void this.fetch(`${server.url}/sdcpp/v1/jobs/${id}/cancel`, {
				method: "POST",
			}).catch(() => {});
		signal.addEventListener("abort", cancel, { once: true });
		try {
			let last = -1;
			for (;;) {
				if (signal.aborted) return;
				const response = await this.fetch(`${server.url}/sdcpp/v1/jobs/${id}`);
				const job = (await response.json()) as JobStatus;
				const { completed, total, unit } = job.progress ?? {};
				if (
					job.status === "generating" &&
					unit === "steps" &&
					total &&
					completed != null &&
					completed !== last
				) {
					last = completed;
					yield {
						type: "progress",
						fraction: Math.min(1, completed / total),
						message: "Generating",
						stage: "generating",
						step: Math.min(completed, total),
						steps: total,
					};
				}
				if (job.status === "completed") {
					const encoded = request.video
						? job.result?.b64_json
						: job.result?.images?.[0]?.b64_json;
					if (!encoded) {
						yield {
							type: "failed",
							error: "The engine produced no result",
							code: "engineNoResult",
						};
						return;
					}
					yield {
						type: "completed",
						outputs: [
							{
								data: Uint8Array.from(Buffer.from(encoded, "base64")),
								mime: request.video
									? (job.result?.mime_type ?? "video/webm")
									: "image/png",
							},
						],
						costUsd: 0,
					};
					return;
				}
				if (job.status === "failed") {
					const reason = job.error?.message ?? "unknown error";
					yield {
						type: "failed",
						error: `The engine stopped: ${reason}`,
						code: "engineStopped",
						params: { reason },
					};
					return;
				}
				if (job.status === "cancelled") return;
				await Bun.sleep(POLL_MS);
			}
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}
}
