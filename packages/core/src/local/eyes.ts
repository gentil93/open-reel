import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Eyes, SeenPicture } from "../chat";
import { type PathMapper, windowsPath } from "./provider";
import type { LocalModelStore } from "./store";
import { type RunOnce, runOnce } from "./translator";

/** Pictures looked at per call: each takes about half a minute on a CPU. */
export const MAX_LOOKED_AT = 2;
/** Enough for a few sentences about one picture. */
const MAX_TOKENS = 200;
/** The longest request quoted to the model. */
const MAX_ASKED = 500;

/** What the model is asked about one picture. */
export function lookPrompt(asked: string): string {
	const request = asked.trim().slice(0, MAX_ASKED);
	return [
		request
			? `The person asked for: "${request}".`
			: "The person asked for a picture.",
		"In two or three sentences, in English: say what the picture shows, then say plainly whether it matches what was asked and what, if anything, is off (something missing, cut off, the wrong number of things, misspelled text).",
	].join(" ");
}

export interface LocalEyesOptions {
	store: LocalModelStore;
	/** The catalog model that looks at pictures. */
	model: string;
	run?: RunOnce;
	windowsPath?: PathMapper;
}

/**
 * A model on this computer that looks at pictures (Qwen2.5-VL), run once
 * per picture with llama.cpp's multimodal program: it works from WSL too,
 * where llama.cpp's server on the Windows side cannot be reached.
 */
export class LocalEyes implements Eyes {
	private store: LocalModelStore;
	private model: string;
	private run: RunOnce;
	private windowsPath: PathMapper;

	constructor(options: LocalEyesOptions) {
		this.store = options.store;
		this.model = options.model;
		this.run = options.run ?? runOnce;
		this.windowsPath = options.windowsPath ?? windowsPath;
	}

	/** Whether the model and its engine are installed. */
	async ready(): Promise<boolean> {
		const view = await this.store.list().catch(() => null);
		return view?.models.find((m) => m.id === this.model)?.ready ?? false;
	}

	async look(
		pictures: SeenPicture[],
		asked: string,
		signal: AbortSignal,
	): Promise<string> {
		const runtime = await this.store.runtime(this.model);
		const model = runtime.files.model;
		const projector = runtime.files.llm_vision;
		if (!model || !projector) {
			throw new Error("The model that looks at pictures is incomplete");
		}
		const path = runtime.throughWindows
			? this.windowsPath
			: async (p: string) => p;
		const program = join(
			dirname(runtime.executable),
			basename(runtime.executable).replace("llama-server", "llama-mtmd-cli"),
		);
		await mkdir(runtime.scratch, { recursive: true });
		const said: string[] = [];
		for (const picture of pictures.slice(0, MAX_LOOKED_AT)) {
			const extension = picture.mimeType.split("/")[1] ?? "jpeg";
			const file = join(
				runtime.scratch,
				`${crypto.randomUUID()}.look.${extension}`,
			);
			await Bun.write(file, Buffer.from(picture.data, "base64"));
			try {
				const { code, stdout, stderr } = await this.run(
					[
						program,
						"-m",
						await path(model),
						"--mmproj",
						await path(projector),
						"--image",
						await path(file),
						"-p",
						lookPrompt(asked),
						"-n",
						String(MAX_TOKENS),
						"--temp",
						"0.2",
						"--no-perf",
					],
					signal,
				);
				if (code !== 0) {
					const reason = stderr.trim().split(/\r?\n/).at(-1);
					throw new Error(
						`Looking at the picture failed: ${reason ?? `code ${code}`}`,
					);
				}
				const text = stdout.replace(/\s+/g, " ").trim();
				said.push(picture.label ? `${picture.label}: ${text}` : text);
			} finally {
				await rm(file, { force: true });
			}
		}
		return said.join("\n");
	}
}
