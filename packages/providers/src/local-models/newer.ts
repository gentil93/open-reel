import type { LocalModelSpec } from "@hatchlight/core";
import {
	ALL_RATIOS,
	APACHE_2,
	file,
	GB,
	hf,
	MIT,
	type Repo,
	SHARED,
} from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	comfyHiDream: [
		"Comfy-Org/HiDream-O1-Image",
		"7b75f4cd7e757d55d9bd1d30fb40375fb446f38c",
	],
	hiDreamDev: [
		"HiDream-ai/HiDream-O1-Image-Dev",
		"c0bada0e15c54a9f96a6d1ecc35575b32bc21544",
	],
	lladaTurboGguf: [
		"fszontagh/LLaDA-Image-Turbo-GGUF",
		"73e2e2adecb76bcf1f89fc37a636912c551349a9",
	],
	lladaTurbo: [
		"inclusionAI/LLaDA-Image-Turbo",
		"f4afc52d925bbac4e22a1c947111fc1f127e37e5",
	],
	comfyBoogu: [
		"Comfy-Org/Boogu-Image",
		"8606e7df2f5389282617b8b534db290e1f5d7811",
	],
	qwen3Vl8b: [
		"unsloth/Qwen3-VL-8B-Instruct-GGUF",
		"b93a7ee713758252c555be4210c00540df954dc2",
	],
	booguTurbo: [
		"Boogu/Boogu-Image-0.1-Turbo",
		"53ad54522023f64d049f7f38e4d679359ef3fb92",
	],
	booguEditTurbo: [
		"Boogu/Boogu-Image-0.1-Edit-Turbo",
		"132a0ab9051b42c1d9be4919a68873d1f132c0c8",
	],
} as const satisfies Record<string, Repo>;

/** Files more than one model of this group uses. */
const FILES = {
	/** Qwen3-VL 8B Instruct, the text encoder of Boogu-Image. */
	qwen3Vl8bQ8: file(
		REPO.qwen3Vl8b,
		"Qwen3-VL-8B-Instruct-Q8_0.gguf",
		8_709_520_224,
		"cb8616bf6ed228982d9e47d7b72b42195342efa26044b0ee1873e61d9e78d3d7",
		"llm",
	),
	qwen3Vl8bVision: file(
		REPO.qwen3Vl8b,
		"mmproj-F16.gguf",
		1_159_030_336,
		"d406d03ebabefdef86a2c86bf0c1b65f9e046f7a81c218f25de4931b46a07fc4",
		"llm_vision",
	),
	/** The LLaDA2 tokenizer, the FLUX.2 decoder and the connectors, with SigVQ. */
	lladaTokenizer: file(
		REPO.lladaTurbo,
		"tokenizer/tokenizer.json",
		15_297_062,
		"2197aeddaf09785316673451ca6fb86dcfcfdb108972a3145d106b8fa4c927e6",
		"tokenizer",
	),
	lladaVae: file(
		REPO.lladaTurbo,
		"vae/diffusion_pytorch_model.safetensors",
		168_120_872,
		"19874383f29bd4a716be716520647261e38aeaa50dcc29559e5f8d8186cf8f43",
		"vae",
	),
	lladaTurboConnectors: file(
		REPO.lladaTurboGguf,
		"llada-image-turbo-connectors-edit.safetensors",
		3_348_225_976,
		"e0e88841b1a9eb7b11f813f3f139507438b541a585fc6aa4a7bf842e732304ca",
		"embeddings-connectors",
	),
} as const;

/**
 * Image models released in 2026 that stable-diffusion.cpp runs:
 * HiDream-O1-Image, LLaDA-Image and Boogu-Image.
 */
export function newerModels(): LocalModelSpec[] {
	return [
		{
			id: "hidream-o1-image-dev",
			profile: {
				family: "hidream-o1-image",
				name: "HiDream-O1-Image",
				author: "HiDream.ai",
				speed: 1,
				quality: 3,
				text: true,
				bestFor: ["detail", "text", "instructions"],
			},
			name: "HiDream-O1-Image Dev",
			author: "HiDream.ai",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"An 8B model that works on pixels directly, with no separate text encoder or decoder. Strong at long text and layouts, and slow on most cards.",
			...MIT,
			homepage: "https://huggingface.co/HiDream-ai/HiDream-O1-Image-Dev",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 19 * GB,
					files: [
						file(
							REPO.comfyHiDream,
							"checkpoints/hidream_o1_image_dev_bf16.safetensors",
							16_365_209_824,
							"cede93912730dd046fd39a20af008344a7dce75dafabd16e419a222c3e504051",
							"model",
						),
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 28,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.hiDreamDev, "assets/general.webp"),
					media: "image",
					caption: "Samples from the model card",
				},
				{
					url: hf(...REPO.hiDreamDev, "assets/text-layout.webp"),
					media: "image",
					caption: "Long text and layout samples from the model card",
				},
			],
		},
		{
			id: "llada-image-turbo",
			profile: {
				family: "llada-image",
				name: "LLaDA-Image",
				author: "inclusionAI (Ant Group)",
				speed: 2,
				quality: 2,
				text: true,
				bestFor: ["editing", "instructions"],
			},
			name: "LLaDA-Image Turbo",
			author: "inclusionAI (Ant Group)",
			media: "image",
			tasks: ["text-to-image", "image-edit"],
			summary:
				"A 6B model that makes images and edits them by instruction in four steps. Its text encoder is large, about 10 to 18 GB.",
			...APACHE_2,
			homepage: "https://huggingface.co/inclusionAI/LLaDA-Image-Turbo",
			variants: [
				{
					id: "f16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 17 * GB,
					files: [
						file(
							REPO.lladaTurboGguf,
							"llada-image-turbo-f16.gguf",
							13_080_491_424,
							"113ea8596fa62c5aedd9c39c5bce305c1f708df55f510be092ed69c2c521a31d",
							"diffusion_model",
						),
						file(
							REPO.lladaTurboGguf,
							"llada-image-turbo-text_encoder-q8_0.gguf",
							17_676_202_624,
							"dc95123508eeb92593c2e63c5f0dbd7e678e3694766fcbbaa792da3e740ca6f0",
							"llm",
						),
						FILES.lladaTokenizer,
						FILES.lladaTurboConnectors,
						FILES.lladaVae,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 11 * GB,
					files: [
						file(
							REPO.lladaTurboGguf,
							"llada-image-turbo-q8_0.gguf",
							6_951_851_424,
							"101d85567805858b12583a1b9647568c163aa843140cee68c31c2d4d893a434f",
							"diffusion_model",
						),
						file(
							REPO.lladaTurboGguf,
							"llada-image-turbo-text_encoder-q4_K.gguf",
							9_692_566_528,
							"3efd1f42856ab18f2e2d4a0ac277943801336e5641b21905c2131a04e96b8a40",
							"llm",
						),
						FILES.lladaTokenizer,
						FILES.lladaTurboConnectors,
						FILES.lladaVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 4,
				cfgScale: 1,
				references: { as: "ref", max: 1 },
			},
			demos: [
				{
					url: hf(...REPO.lladaTurbo, "assets/demo.jpg"),
					media: "image",
					caption: "Samples from the model card",
				},
				{
					url: hf(...REPO.lladaTurbo, "assets/edit_demo.jpg"),
					media: "image",
					caption: "Edits from the model card",
				},
			],
		},
		{
			id: "boogu-image-turbo",
			profile: {
				family: "boogu-image",
				name: "Boogu-Image",
				author: "Boogu",
				speed: 2,
				quality: 3,
				text: true,
				bestFor: ["photo", "text"],
			},
			name: "Boogu-Image Turbo",
			author: "Boogu",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A 10B model distilled to four steps, for photorealistic 1024px images with text in English and Chinese.",
			...APACHE_2,
			homepage: "https://huggingface.co/Boogu/Boogu-Image-0.1-Turbo",
			variants: [
				{
					id: "int8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 14 * GB,
					files: [
						file(
							REPO.comfyBoogu,
							"diffusion_models/boogu_image_turbo_hotfix_int8_convrot.safetensors",
							11_370_550_632,
							"ba2e6d956e5e97fccfcfa95eddccc33056306b5d68db37e8ad3ffff575261865",
							"diffusion_model",
						),
						FILES.qwen3Vl8bQ8,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 4,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.booguTurbo, "assets/photography_triptych.png"),
					media: "image",
					caption: "Photographic samples from the model card",
				},
				{
					url: hf(...REPO.booguTurbo, "assets/text_rendering_triptych.png"),
					media: "image",
					caption: "Text rendering samples from the model card",
				},
			],
		},
		{
			id: "boogu-image-edit-turbo",
			profile: {
				family: "boogu-image-edit",
				name: "Boogu-Image Edit",
				author: "Boogu",
				speed: 2,
				quality: 3,
				text: true,
				bestFor: ["editing", "instructions"],
			},
			name: "Boogu-Image Edit Turbo",
			author: "Boogu",
			media: "image",
			tasks: ["image-edit"],
			summary:
				"Edits a single picture by written instruction in four steps: adding, removing or replacing things, restyling and changing text.",
			...APACHE_2,
			homepage: "https://huggingface.co/Boogu/Boogu-Image-0.1-Edit-Turbo",
			variants: [
				{
					id: "int8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 14 * GB,
					files: [
						file(
							REPO.comfyBoogu,
							"diffusion_models/boogu_image_edit_turbo_hotfix_1k_20260708_int8_convrot.safetensors",
							10_326_755_028,
							"b0bdd36eb559d62e8169e16a1e8b4438f8be17fc092ca9d43a2d8460c1d79e6a",
							"diffusion_model",
						),
						FILES.qwen3Vl8bQ8,
						FILES.qwen3Vl8bVision,
						SHARED.fluxVae,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 4,
				cfgScale: 1,
				references: { as: "ref", max: 1 },
			},
			demos: [
				{
					url: hf(...REPO.booguEditTurbo, "assets/edit_cases_combined.png"),
					media: "image",
					caption: "Edits from the model card",
				},
			],
		},
	];
}
