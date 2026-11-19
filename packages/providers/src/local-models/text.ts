import type { LocalModelFile, LocalModelSpec } from "@hatchlight/core";
import { QWEN_VL } from "./qwen";
import { APACHE_2, GB, SHARED } from "./shared";

/** One of Z-Image's files, as the model the translator runs. */
const asModel = (file: LocalModelFile): LocalModelFile => ({
	...file,
	role: "model",
});

/**
 * Models that help the others rather than make pictures: set up in
 * Settings, never offered for generating.
 */
export function textModels(): LocalModelSpec[] {
	return [
		{
			// Smaller ones (Qwen2.5 1.5B, Qwen3 1.7B) were tried: they turned
			// "laranja" into "yellow", "roxos" into "red", "romãs" into
			// "oranges". This one gets colors and most words right.
			id: "qwen3-4b-instruct",
			name: "Qwen3 4B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["prompt-translation"],
			summary:
				"A language model that puts prompts into English, for the models that read only English. It runs on the processor, in a few seconds per prompt, and is the same file Z-Image reads prompts with: with Z-Image installed, nothing more is downloaded.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 6 * GB,
					files: [asModel(SHARED.qwen3InstructQ8)],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					memoryBytes: 4 * GB,
					files: [asModel(SHARED.qwen3InstructQ4)],
				},
			],
			// A text model makes no pictures: these are never read.
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
		{
			// It sees well but calls tools badly (the same call seven times,
			// model names for ids), so the assistant on this computer keeps
			// thinking with Qwen3 4B and asks this one what pictures show.
			id: "qwen2.5-vl-7b",
			name: "Qwen2.5-VL 7B Instruct",
			author: "Qwen (Alibaba)",
			media: "text",
			tasks: ["picture-description"],
			summary:
				"A language model that looks at pictures, so the assistant on this computer can tell whether what it made matches what was asked. It runs on the processor, about half a minute per picture. Qwen-Image and LongCat-Image read prompts with the same file.",
			...APACHE_2,
			homepage: "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct",
			variants: [
				{
					// 4-bit only: on the processor, 8-bit doubles the wait.
					id: "q4",
					label: "4-bit",
					engine: "llama-cpp",
					// In the computer's memory: it runs on the processor.
					memoryBytes: 7 * GB,
					files: [
						{ ...QWEN_VL.q4, role: "model" },
						{ ...QWEN_VL.vision, role: "llm_vision" },
					],
				},
			],
			defaults: { size: 0, aspectRatios: [], steps: 0, cfgScale: 0 },
			demos: [],
		},
	];
}
