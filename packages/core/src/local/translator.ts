import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TRANSLATE_INSTRUCTIONS, type Translator } from "../translate";
import {
	type PathMapper,
	type Spawn,
	spawnProcess,
	windowsPath,
} from "./provider";
import type { LocalModelStore, LocalRuntime } from "./store";

/**
 * Puts prompts into English with a small language model installed on this
 * computer, run by llama.cpp on the processor.
 *
 * Where it can, the model stays loaded in `llama-server` between prompts
 * (loading takes a few seconds, a prompt a second). Under WSL the engine is
 * a Windows program whose server cannot be reached from Linux, so each
 * prompt runs `llama-completion` once instead.
 */

/** A model unused this long is unloaded, to give its memory back. */
const IDLE_MS = 5 * 60_000;
const START_TIMEOUT_MS = 2 * 60_000;
const POLL_MS = 250;
/** Enough for a long prompt; a translation is about as long as its prompt. */
const MAX_TOKENS = 512;
const CONTEXT = 2048;

/** Runs a program to its end, giving its output. */
export type RunOnce = (
	argv: string[],
	signal: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runOnce: RunOnce = async (argv, signal) => {
	// Already given up: an abort listener would never fire.
	signal.throwIfAborted();
	const child = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stop = () => child.kill();
	signal.addEventListener("abort", stop, { once: true });
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		signal.throwIfAborted();
		return { code, stdout, stderr };
	} finally {
		signal.removeEventListener("abort", stop);
	}
};

async function freeLoopbackPort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port as number;
	probe.stop(true);
	return port;
}

/**
 * A prompt in Qwen's chat format (ChatML), for a run without the server,
 * which applies the model's own format.
 */
export function chatPrompt(system: string, user: string): string {
	return [
		`<|im_start|>system\n${system}<|im_end|>`,
		`<|im_start|>user\n${user}<|im_end|>`,
		"<|im_start|>assistant\n",
	].join("\n");
}

export interface LocalTranslatorOptions {
	store: LocalModelStore;
	/** The catalog model that translates. */
	model: string;
	spawn?: Spawn;
	run?: RunOnce;
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	freePort?: () => Promise<number>;
	windowsPath?: PathMapper;
	idleMs?: number;
}

interface Server {
	key: string;
	url: string;
	stop(): void;
	exited: Promise<number>;
}

export class LocalTranslator implements Translator {
	private store: LocalModelStore;
	private model: string;
	private spawn: Spawn;
	private run: RunOnce;
	private fetch: (url: string, init?: RequestInit) => Promise<Response>;
	private freePort: () => Promise<number>;
	private windowsPath: PathMapper;
	private idleMs: number;
	private server: Promise<Server> | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;
	/** The model the server has loaded, by its program and file. */
	private serverKey: string | null = null;
	/** Translations through the server now: it is not unloaded under them. */
	private inFlight = 0;
	/** Bumped by every stop, so a start under way knows it is unwanted. */
	private generation = 0;

	constructor(options: LocalTranslatorOptions) {
		this.store = options.store;
		this.model = options.model;
		this.spawn = options.spawn ?? spawnProcess;
		this.run = options.run ?? runOnce;
		this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.freePort = options.freePort ?? freeLoopbackPort;
		this.windowsPath = options.windowsPath ?? windowsPath;
		this.idleMs = options.idleMs ?? IDLE_MS;
	}

	/** Whether the model and its engine are installed, so it can translate. */
	async ready(): Promise<boolean> {
		const view = await this.store.list().catch(() => null);
		return view?.models.find((m) => m.id === this.model)?.ready ?? false;
	}

	async toEnglish(prompt: string, signal: AbortSignal): Promise<string> {
		const runtime = await this.store.runtime(this.model);
		return runtime.throughWindows
			? this.once(runtime, prompt, signal)
			: this.served(runtime, prompt, signal);
	}

	/** Through the server, started if it is not running. */
	private async served(
		runtime: LocalRuntime,
		prompt: string,
		signal: AbortSignal,
	): Promise<string> {
		clearTimeout(this.idle);
		this.inFlight++;
		try {
			const server = await this.started(runtime);
			signal.throwIfAborted();
			const response = await this.fetch(`${server.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					messages: [
						{ role: "system", content: TRANSLATE_INSTRUCTIONS },
						{ role: "user", content: prompt },
					],
					temperature: 0,
					max_tokens: MAX_TOKENS,
				}),
				signal,
			});
			if (!response.ok) {
				throw new Error(`The translator refused (HTTP ${response.status})`);
			}
			const body = (await response.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const text = body.choices?.[0]?.message?.content;
			if (typeof text !== "string") throw new Error("No translation came back");
			return text;
		} finally {
			this.inFlight--;
			// Unloaded once nothing has used it for a while.
			if (this.inFlight === 0) {
				clearTimeout(this.idle);
				this.idle = setTimeout(() => this.stop(), this.idleMs);
				this.idle.unref?.();
			}
		}
	}

	/** The server with this runtime's model, started if need be. */
	private started(runtime: LocalRuntime): Promise<Server> {
		const key = `${runtime.executable}:${runtime.files.model}`;
		// Another model now (another variant, another engine): the old goes.
		if (this.server && this.serverKey !== key) this.stop();
		if (!this.server) {
			const generation = this.generation;
			const starting = this.start(key, runtime, generation);
			this.server = starting;
			this.serverKey = key;
			starting.catch(() => {
				if (this.server === starting) this.forget();
			});
		}
		return this.server;
	}

	private forget(): void {
		this.server = null;
		this.serverKey = null;
	}

	private async start(
		key: string,
		runtime: LocalRuntime,
		generation: number,
	): Promise<Server> {
		const model = runtime.files.model;
		if (!model) throw new Error("The translator has no model file");
		const port = await this.freePort();
		const child = this.spawn([
			runtime.executable,
			"-m",
			model,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"-c",
			String(CONTEXT),
			"-np",
			"1",
		]);
		// Read, so the pipe never fills.
		void (async () => {
			for await (const _ of child.output);
		})().catch(() => {});
		let exited = false;
		const url = `http://127.0.0.1:${port}`;
		const server: Server = {
			key,
			url,
			stop: () => child.kill(),
			exited: child.exited,
		};
		void child.exited.then(() => {
			exited = true;
			// It died (out of memory, killed): the next prompt starts another.
			void this.server?.then((current) => {
				if (current === server) this.forget();
			});
		});
		const started = Date.now();
		for (;;) {
			if (exited) throw new Error("The translator would not start");
			if (this.generation !== generation) {
				// Stopped while it started: nobody gets a server about to go.
				child.kill();
				throw new Error("The translator was stopped");
			}
			if (Date.now() - started > START_TIMEOUT_MS) {
				child.kill();
				throw new Error("The translator took too long to start");
			}
			const health = await this.fetch(`${url}/health`).catch(() => null);
			if (health?.ok) break;
			await Bun.sleep(POLL_MS);
		}
		return server;
	}

	/** Runs the model once for this prompt, through a file it reads. */
	private async once(
		runtime: LocalRuntime,
		prompt: string,
		signal: AbortSignal,
	): Promise<string> {
		const model = runtime.files.model;
		if (!model) throw new Error("The translator has no model file");
		const program = join(
			dirname(runtime.executable),
			basename(runtime.executable).replace("llama-server", "llama-completion"),
		);
		await mkdir(runtime.scratch, { recursive: true });
		const file = join(runtime.scratch, `${crypto.randomUUID()}.prompt.txt`);
		await Bun.write(file, chatPrompt(TRANSLATE_INSTRUCTIONS, prompt));
		try {
			const { code, stdout, stderr } = await this.run(
				[
					program,
					"-m",
					await this.windowsPath(model),
					"-f",
					await this.windowsPath(file),
					"-no-cnv",
					"--no-display-prompt",
					"--temp",
					"0",
					"-n",
					String(MAX_TOKENS),
					"-c",
					String(CONTEXT),
					// Not --log-disable: in llama-completion it silences the
					// generated text too.
					"--no-perf",
				],
				signal,
			);
			if (code !== 0) {
				const reason = stderr.trim().split(/\r?\n/).at(-1);
				throw new Error(`The translator stopped: ${reason ?? `code ${code}`}`);
			}
			// It marks where the model stopped.
			return stdout.replace(/\s*\[end of text\]\s*$/, "").trim();
		} finally {
			await rm(file, { force: true });
		}
	}

	/** Unloads the model. */
	stop(): void {
		void this.stopAndWait();
	}

	/**
	 * Unloads the model and resolves once its server has exited: on Windows
	 * its file can be moved or deleted only then.
	 */
	async stopAndWait(): Promise<void> {
		clearTimeout(this.idle);
		// A start under way sees this and gives up.
		this.generation++;
		const server = this.server;
		this.forget();
		const running = await server?.catch(() => null);
		running?.stop();
		await running?.exited;
	}
}
