import type { LocalModelSpec } from "@open-reel/core";
import { APACHE_2, file, GB, type Repo } from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	qwen: [
		"Qwen/Qwen2.5-1.5B-Instruct-GGUF",
		"91cad51170dc346986eccefdc2dd33a9da36ead9",
	],
} as const satisfies Record<string, Repo>;

/**
 * Models that help the others rather than make pictures: set up in
 * Settings, never offered for generating.
 */
export function textModels(): LocalModelSpec[] {
	return [
		{
			id: "qwen2.5-1.5b-instruct",
			name: "Qwen2.5 1.5B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["prompt-translation"],
			summary:
				"A small language model that puts prompts into English, for the models that read only English. It runs on the processor, in a second or two per prompt.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct",
			variants: [
				{
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 2 * GB,
					files: [
						file(
							REPO.qwen,
							"qwen2.5-1.5b-instruct-q4_k_m.gguf",
							1_117_320_736,
							"6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
							"model",
						),
					],
				},
			],
			// A text model makes no pictures: these are never read.
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
	];
}
