import type { LocalModelSpec } from "@open-reel/core";
import {
	ALL_RATIOS,
	APACHE_2,
	file,
	GB,
	hf,
	MIT,
	openRail,
	type Repo,
	SHARED,
} from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	sd15Gguf: [
		"second-state/stable-diffusion-v1-5-GGUF",
		"031b5f5df991f511b3f5fa8fed6d99048ababb69",
	],
	pixartSigma: [
		"PixArt-alpha/PixArt-Sigma-XL-2-1024-MS",
		"e102b3591cc82e97071b8b4cb90d834d0c487207",
	],
	iris: ["speridlabs/iris-3b", "adc05b909fb05d4276d26aae5a52b36406b2ef26"],
	qwen3VlGguf: [
		"Qwen/Qwen3-VL-4B-Instruct-GGUF",
		"1cd86afb9a95c410a6038ab3b40d8b578c892266",
	],
	miniT2i: ["MiniT2I/MiniT2I", "5b4da2870d1554992670d1005567e9d55b1b37bb"],
	flanT5: ["google/flan-t5-large", "0613663d0d48ea86ba8cb3d7a44f0f65dc596a2a"],
} as const satisfies Record<string, Repo>;

/**
 * Small, older or minimalist image models: they run on modest graphics cards,
 * and some on the processor alone.
 */
export function classicModels(): LocalModelSpec[] {
	return [
		{
			id: "sd-1.5",
			englishPrompts: true,
			profile: {
				family: "sd-1.5",
				name: "Stable Diffusion 1.5",
				author: "Stability AI",
				speed: 3,
				quality: 1,
				text: false,
				bestFor: ["speed", "drafts"],
			},
			name: "Stable Diffusion 1.5",
			author: "Runway, Stability AI and CompVis",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"The small 512px model that started local image generation. It runs on weak graphics cards and even on the processor alone.",
			...openRail(
				"CreativeML OpenRAIL-M",
				"https://huggingface.co/spaces/CompVis/stable-diffusion-license",
			),
			homepage:
				"https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 5 * GB,
					files: [
						file(
							REPO.sd15Gguf,
							"stable-diffusion-v1-5-pruned-emaonly-f16.gguf",
							2_132_586_944,
							"da017009aa86a3f46468857d95833435fe55e4a2856afab76ba7722ef8ee4d8b",
							"model",
						),
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 4 * GB,
					files: [
						file(
							REPO.sd15Gguf,
							"stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf",
							1_566_768_416,
							"b8944e9fe0b69b36ae1b5bb0185b3a7b8ef14347fe0fa9af6c64c4829022261f",
							"model",
						),
					],
				},
			],
			defaults: {
				size: 512,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 7,
			},
			demos: [],
		},
		{
			id: "pixart-sigma",
			englishPrompts: true,
			profile: {
				family: "pixart-sigma",
				name: "PixArt-Σ",
				author: "PixArt-alpha",
				speed: 3,
				quality: 2,
				text: false,
				bestFor: ["illustration", "drafts"],
			},
			name: "PixArt-Σ",
			author: "PixArt-alpha (Huawei Noah's Ark Lab)",
			media: "image",
			tasks: ["text-to-image", "image-to-image"],
			summary:
				"A small transformer that makes 1024px images in twenty steps, following long prompts through its T5 text encoder.",
			...openRail(
				"CreativeML Open RAIL++-M",
				"https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
			),
			homepage: "https://huggingface.co/PixArt-alpha/PixArt-Sigma-XL-2-1024-MS",
			variants: [
				{
					id: "fp32",
					label: "32-bit",
					engine: "sd-cpp",
					memoryBytes: 5 * GB,
					files: [
						file(
							REPO.pixartSigma,
							"transformer/diffusion_pytorch_model.safetensors",
							2_443_492_488,
							"2fa4dee9229c02b03163f57bdb8e80c7a5ee364b7161796abe9c05e8dd13f239",
							"diffusion_model",
						),
						{
							...file(
								REPO.pixartSigma,
								"vae/diffusion_pytorch_model.safetensors",
								334_643_238,
								"1b909373b28f2137098b0fd9dbc6f97f8410854f31f84ddc9fa04b077b0ace2c",
								"vae",
							),
							// The transformer has the same file name, and names must differ.
							name: "pixart_sigma_vae.safetensors",
						},
						SHARED.fluxT5,
					],
				},
			],
			defaults: {
				references: { as: "init", max: 1 },
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 20,
				cfgScale: 4.5,
			},
			demos: [
				{
					url: hf(...REPO.pixartSigma, "asset/4K_image.jpg"),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "iris-3b",
			profile: {
				family: "iris-3b",
				name: "Iris-3B",
				author: "Sperid Labs",
				speed: 1,
				quality: 2,
				text: false,
				bestFor: ["photo", "detail"],
			},
			name: "Iris-3B",
			author: "Sperid Labs",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A 3B model that draws 1024px images directly in pixels, without an image decoder. Detailed portraits and photographs, at a hundred steps.",
			...APACHE_2,
			homepage: "https://huggingface.co/speridlabs/iris-3b",
			variants: [
				{
					id: "fp32",
					label: "32-bit",
					engine: "sd-cpp",
					memoryBytes: 14 * GB,
					files: [
						file(
							REPO.iris,
							"model.safetensors",
							11_950_112_680,
							"a90e1f4c197bac8491f82078def68884b6a3527ea7fc97a693e3e367372aa80f",
							"diffusion_model",
						),
						file(
							REPO.qwen3VlGguf,
							"Qwen3VL-4B-Instruct-Q8_0.gguf",
							4_280_406_144,
							"054721f478bc5fa6beffb7f38eae575d45298f88cbb8d2f83ef675a727863eb1",
							"llm",
						),
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ALL_RATIOS,
				steps: 100,
				cfgScale: 3,
			},
			demos: [
				{
					url: hf(...REPO.iris, "assets/gallery/0005.jpg"),
					media: "image",
					caption: "A sample from the model card",
				},
				{
					url: hf(...REPO.iris, "assets/gallery/0020.jpg"),
					media: "image",
					caption: "A portrait from the model card",
				},
			],
		},
		{
			id: "minit2i-b-16",
			englishPrompts: true,
			profile: {
				family: "minit2i",
				name: "MiniT2I",
				author: "MiniT2I",
				speed: 3,
				quality: 1,
				text: false,
				bestFor: ["drafts"],
			},
			name: "MiniT2I B/16",
			author: "MiniT2I",
			media: "image",
			tasks: ["text-to-image"],
			summary:
				"A minimalist research model that makes square 512px images in pixels. Small enough for modest graphics cards.",
			...MIT,
			homepage: "https://huggingface.co/MiniT2I/MiniT2I",
			variants: [
				{
					id: "fp32",
					label: "32-bit",
					engine: "sd-cpp",
					memoryBytes: 4 * GB,
					files: [
						file(
							REPO.miniT2i,
							"minit2i-b-16/transformer/diffusion_pytorch_model.safetensors",
							1_032_534_472,
							"5114de36379acd45f810001d9da82d48f96559ce4428cde7a79b1e724983ced1",
							"diffusion_model",
						),
						file(
							REPO.flanT5,
							"model.safetensors",
							3_132_668_804,
							"a9dd06ce490f139af36e9eb77dd3758b4fd07a08a73d5a1abe5ff2591e2d388e",
							"t5xxl",
						),
					],
				},
			],
			defaults: {
				size: 512,
				aspectRatios: ["1:1"],
				steps: 100,
				cfgScale: 6,
				sampler: "euler",
			},
			demos: [],
		},
	];
}
