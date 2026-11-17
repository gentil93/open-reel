import type { LocalModelFile, LocalModelSpec } from "@open-reel/core";
import { PROFILES } from "./profiles";

/** A file in a Hugging Face repository, at a fixed revision. */
const hf = (repo: string, revision: string, path: string) =>
	`https://huggingface.co/${repo}/resolve/${revision}/${path}`;

const GB = 1e9;

/** Repositories and the revision each is pinned to. */
const REPO = {
	sdxlTurbo: [
		"stabilityai/sdxl-turbo",
		"71153311d3dbb46851df1931d3ca6e939de83304",
	],
	sdxl: [
		"stabilityai/stable-diffusion-xl-base-1.0",
		"462165984030d82259a11f4367a4eed129e94a7b",
	],
	fluxGguf: [
		"city96/FLUX.1-schnell-gguf",
		"f495746ed9c5efcf4661f53ef05401dceadc17d2",
	],
	fluxEncoders: [
		"comfyanonymous/flux_text_encoders",
		"6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5",
	],
	comfyZImage: [
		"Comfy-Org/Z-Image-Turbo",
		"6fc90a3b1b653e935a0d175e260736de25b84df5",
	],
	zImageGguf: [
		"leejet/Z-Image-Turbo-GGUF",
		"c61c0e422dc8b541b7548cf33a4ef8302b0f8085",
	],
	qwenGguf: [
		"unsloth/Qwen3-4B-Instruct-2507-GGUF",
		"a06e946bb6b655725eafa393f4a9745d460374c9",
	],
	zImage: [
		"Tongyi-MAI/Z-Image-Turbo",
		"f332072aa78be7aecdf3ee76d5c247082da564a6",
	],
	comfyWan: ["Comfy-Org/Wan-2.1", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d"],
	umt5Gguf: [
		"city96/umt5-xxl-encoder-gguf",
		"b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7",
	],
} as const;

const file = (
	[repo, revision]: readonly [string, string],
	path: string,
	size: number,
	sha256: string,
	role: string,
): LocalModelFile => ({
	name: path.split("/").at(-1) as string,
	url: hf(repo, revision, path),
	size,
	sha256,
	role,
});

const WAN_NEGATIVE =
	"色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/** The image decoder FLUX and Z-Image share, stored once for both. */
const FLUX_VAE = file(
	REPO.comfyZImage,
	"split_files/vae/ae.safetensors",
	335_304_388,
	"afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
	"vae",
);
const FLUX_T5 = file(
	REPO.fluxEncoders,
	"t5xxl_fp8_e4m3fn.safetensors",
	4_893_934_904,
	"7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09",
	"t5xxl",
);
const FLUX_CLIP = file(
	REPO.fluxEncoders,
	"clip_l.safetensors",
	246_144_152,
	"660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
	"clip_l",
);

/**
 * The models open-reel can download, each in the variants it can run. Sizes
 * and hashes are the ones their repositories report at the pinned revision.
 *
 * `memoryBytes` is what a variant needs on the GPU to run at full speed: the
 * diffusion model and decoder plus working memory. Text encoders run once per
 * prompt and are moved to system memory when the GPU is short.
 */
export function builtinLocalModels(): LocalModelSpec[] {
	return [
		{
			id: "sdxl-turbo",
			profile: PROFILES.sdxlTurbo,
			name: "SDXL Turbo",
			author: "Stability AI",
			media: "image",
			summary:
				"A distilled SDXL that makes a 512px image in a single step. The quickest way to try ideas; non-commercial use only.",
			license: "Stability AI Non-Commercial",
			homepage: "https://huggingface.co/stabilityai/sdxl-turbo",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 8 * GB,
					files: [
						file(
							REPO.sdxlTurbo,
							"sd_xl_turbo_1.0_fp16.safetensors",
							6_938_081_905,
							"e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26",
							"model",
						),
					],
				},
			],
			defaults: {
				size: 512,
				aspectRatios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
				steps: 1,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.sdxlTurbo, "output_tile.jpg"),
					media: "image",
					caption: "Single-step samples from the model card",
				},
			],
		},
		{
			id: "sdxl-base",
			profile: PROFILES.sdxl,
			name: "Stable Diffusion XL",
			author: "Stability AI",
			media: "image",
			summary:
				"The 1024px general-purpose model with the largest ecosystem of fine-tunes and LoRAs.",
			license: "CreativeML Open RAIL++-M",
			homepage:
				"https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.sdxl,
							"sd_xl_base_1.0.safetensors",
							6_938_078_334,
							"31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
							"model",
						),
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
				steps: 30,
				cfgScale: 7,
			},
			demos: [
				{
					url: hf(...REPO.sdxl, "01.png"),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "flux-schnell",
			profile: PROFILES.fluxSchnell,
			name: "FLUX.1 schnell",
			author: "Black Forest Labs",
			media: "image",
			summary:
				"Detailed 1024px images in four steps, with strong prompt following.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/black-forest-labs/FLUX.1-schnell",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.fluxGguf,
							"flux1-schnell-Q8_0.gguf",
							12_687_821_728,
							"f6694941193b10148dbf1f0f498d4ccd3e9875c127fc53946213b68580c66f10",
							"diffusion_model",
						),
						FLUX_T5,
						FLUX_CLIP,
						FLUX_VAE,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.fluxGguf,
							"flux1-schnell-Q4_K_S.gguf",
							6_783_943_712,
							"4fd16477b3a5296d0cf722c4b92a9fd7f30d09ac7495826e4465d8de9c9fd973",
							"diffusion_model",
						),
						FLUX_T5,
						FLUX_CLIP,
						FLUX_VAE,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
				steps: 4,
				cfgScale: 1,
				sampler: "euler",
			},
			demos: [
				{
					url: "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/f8610f7cd567f4b4e9d76320e8774c8fda061723/templates/flux_schnell-1.webp",
					media: "image",
					caption: "A sample from ComfyUI's FLUX.1 schnell template",
				},
			],
		},
		{
			id: "z-image-turbo",
			profile: PROFILES.zImage,
			name: "Z-Image Turbo",
			author: "Tongyi-MAI (Alibaba)",
			media: "image",
			summary:
				"Photorealistic images in eight steps, and legible text in English and Chinese.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
			variants: [
				{
					id: "bf16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.comfyZImage,
							"split_files/diffusion_models/z_image_turbo_bf16.safetensors",
							12_309_866_400,
							"2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6",
							"diffusion_model",
						),
						file(
							REPO.comfyZImage,
							"split_files/text_encoders/qwen_3_4b.safetensors",
							8_044_982_048,
							"6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
							"llm",
						),
						FLUX_VAE,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 9 * GB,
					files: [
						file(
							REPO.zImageGguf,
							"z_image_turbo-Q8_0.gguf",
							6_577_440_704,
							"df1c5baa86d1398c979495a6072dbcee79444fdb884a2445582ba0769c44e9a1",
							"diffusion_model",
						),
						file(
							REPO.qwenGguf,
							"Qwen3-4B-Instruct-2507-Q8_0.gguf",
							4_280_405_600,
							"391c1e410fd9f4cf2de2b510273b56a84c19ce18f4fa3bfb3774031dac4ef068",
							"llm",
						),
						FLUX_VAE,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 6 * GB,
					files: [
						file(
							REPO.zImageGguf,
							"z_image_turbo-Q4_K.gguf",
							3_864_250_304,
							"14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd",
							"diffusion_model",
						),
						file(
							REPO.qwenGguf,
							"Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
							2_497_281_120,
							"3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
							"llm",
						),
						FLUX_VAE,
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"],
				steps: 8,
				cfgScale: 1,
			},
			demos: [
				{
					url: hf(...REPO.zImage, "assets/showcase_realistic.png"),
					media: "image",
					caption: "Photorealistic samples from the model card",
				},
				{
					url: hf(...REPO.zImage, "assets/showcase_rendering.png"),
					media: "image",
					caption: "Text rendering samples from the model card",
				},
			],
		},
		{
			id: "wan-2.1-t2v-1.3b",
			profile: PROFILES.wanLocal,
			name: "Wan 2.1 T2V 1.3B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			summary:
				"Short 480p clips from text. The small Wan model, made to run on consumer graphics cards.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 7 * GB,
					files: [
						file(
							REPO.comfyWan,
							"split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",
							2_838_303_560,
							"be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5",
							"diffusion_model",
						),
						file(
							REPO.umt5Gguf,
							"umt5-xxl-encoder-Q8_0.gguf",
							6_043_068_256,
							"2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc",
							"t5xxl",
						),
						file(
							REPO.comfyWan,
							"split_files/vae/wan_2.1_vae.safetensors",
							253_815_318,
							"2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
							"vae",
						),
					],
				},
			],
			defaults: {
				size: 832,
				aspectRatios: ["16:9", "9:16"],
				steps: 30,
				cfgScale: 6,
				sampler: "euler",
				flowShift: 3,
				fps: 16,
				durations: [2, 3, 5],
				// The negative prompt Wan's authors publish, in the Chinese it was trained on.
				negativePrompt: WAN_NEGATIVE,
			},
			demos: [
				{
					url: "https://cloud.video.taobao.com/vod/Jth64Y7wNoPcJki_Bo1ZJTDBvNjsgjlVKsNs05Fqfps.mp4",
					media: "video",
					caption: "The Wan 2.1 demo reel from the model card",
				},
			],
		},
	];
}
