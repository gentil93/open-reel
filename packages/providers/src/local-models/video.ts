import type { LocalModelDefaults, LocalModelSpec } from "@hatchlight/core";
import { APACHE_2, file, GB, type Repo, SHARED, WAN_NEGATIVE } from "./shared";

/** Repositories and the revision each is pinned to. */
const REPO = {
	comfyWan21: ["Comfy-Org/Wan-2.1", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d"],
	comfyWan22: ["Comfy-Org/Wan-2.2", "ee6f4a40737a995bf5818954cfce6d59443b0f04"],
	ti2v5bGguf: [
		"QuantStack/Wan2.2-TI2V-5B-GGUF",
		"57437632ddd08bdcbd1508c866aa22e126ed51d2",
	],
	t2vA14bGguf: [
		"QuantStack/Wan2.2-T2V-A14B-GGUF",
		"73eafba53a1a8f29254e4c77f92e74ea27d7cd6f",
	],
	i2vA14bGguf: [
		"QuantStack/Wan2.2-I2V-A14B-GGUF",
		"6c6717459277b9cd1f72579d78a0fd62a79e57dc",
	],
	t2v14bGguf: [
		"city96/Wan2.1-T2V-14B-gguf",
		"511cbce9f475a6ca0269be901d23b125f44f5c0d",
	],
	i2v14bGguf: [
		"city96/Wan2.1-I2V-14B-480P-gguf",
		"b4b6b3b3f0f64975fb33b1d5d1a46ca24e065f03",
	],
} as const satisfies Record<string, Repo>;

/** The Wan 2.2 video decoder, used only by Wan 2.2 TI2V 5B. */
const WAN22_VAE = file(
	REPO.comfyWan22,
	"split_files/vae/wan2.2_vae.safetensors",
	1_409_400_960,
	"e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
	"vae",
);

/** The image encoder Wan 2.1 image-to-video reads the first frame with. */
const CLIP_VISION_H = file(
	REPO.comfyWan21,
	"split_files/clip_vision/clip_vision_h.safetensors",
	1_264_219_396,
	"64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161",
	"clip_vision",
);

/** The Wan 2.1 and 2.2 demo reels from the Wan-AI model cards. */
const WAN21_REEL =
	"https://cloud.video.taobao.com/vod/Jth64Y7wNoPcJki_Bo1ZJTDBvNjsgjlVKsNs05Fqfps.mp4";
const WAN22_REEL =
	"https://cloud.video.taobao.com/vod/4szTT1B0LqXvJzmuEURfGRA-nllnqN_G2AT0ZWkQXoQ.mp4";

/** How the 14B Wan 2.1 models run, as stable-diffusion.cpp's examples do. */
const WAN21_14B: LocalModelDefaults = {
	size: 832,
	aspectRatios: ["16:9", "9:16"],
	steps: 30,
	cfgScale: 6,
	sampler: "euler",
	flowShift: 3,
	fps: 16,
	durations: [2, 3, 5],
	negativePrompt: WAN_NEGATIVE,
};

/**
 * How the Wan 2.2 A14B models run: `--steps` is the low-noise expert's share,
 * and the high-noise expert, which shapes the first steps, gets its own.
 */
const WAN22_A14B: LocalModelDefaults = {
	size: 832,
	aspectRatios: ["16:9", "9:16"],
	steps: 10,
	cfgScale: 3.5,
	sampler: "euler",
	flowShift: 3,
	fps: 16,
	durations: [2, 3, 5],
	negativePrompt: WAN_NEGATIVE,
	engineArgs: [
		"--high-noise-steps",
		"8",
		"--high-noise-cfg-scale",
		"3.5",
		"--high-noise-sampling-method",
		"euler",
	],
};

/**
 * Video models beyond the starter set: the larger Wan 2.1 and Wan 2.2 models.
 */
export function videoModels(): LocalModelSpec[] {
	return [
		{
			id: "wan-2.2-ti2v-5b",
			profile: {
				family: "wan-2.2-ti2v-5b",
				name: "Wan 2.2 5B",
				author: "Alibaba",
				speed: 2,
				quality: 2,
				text: false,
				bestFor: ["motion", "detail"],
			},
			name: "Wan 2.2 TI2V 5B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["text-to-video", "image-to-video"],
			summary:
				"720p clips at 24 frames per second, from text or from a starting picture. The Wan 2.2 model sized for a single consumer graphics card.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B",
			variants: [
				{
					id: "fp16",
					label: "16-bit",
					engine: "sd-cpp",
					memoryBytes: 17 * GB,
					files: [
						file(
							REPO.comfyWan22,
							"split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
							9_999_658_848,
							"456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						WAN22_VAE,
					],
				},
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 12 * GB,
					files: [
						file(
							REPO.ti2v5bGguf,
							"Wan2.2-TI2V-5B-Q8_0.gguf",
							5_400_179_040,
							"57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						WAN22_VAE,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 10 * GB,
					files: [
						file(
							REPO.ti2v5bGguf,
							"Wan2.2-TI2V-5B-Q4_K_M.gguf",
							3_433_116_000,
							"95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						WAN22_VAE,
					],
				},
			],
			defaults: {
				size: 1280,
				aspectRatios: ["16:9", "9:16"],
				steps: 30,
				cfgScale: 6,
				sampler: "euler",
				flowShift: 3,
				fps: 24,
				durations: [2, 3, 5],
				negativePrompt: WAN_NEGATIVE,
				references: { as: "init", max: 1 },
			},
			demos: [
				{
					url: WAN22_REEL,
					media: "video",
					caption: "The Wan 2.2 demo reel from the model card",
				},
			],
		},
		{
			id: "wan-2.2-t2v-a14b",
			profile: {
				family: "wan-2.2-t2v-a14b",
				name: "Wan 2.2 14B",
				author: "Alibaba",
				speed: 1,
				quality: 3,
				text: false,
				bestFor: ["motion", "cinema"],
			},
			name: "Wan 2.2 T2V A14B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["text-to-video"],
			summary:
				"The largest open Wan model for clips from text, with two experts, one for the overall layout and one for detail. Strong at cinematic lighting and complex motion, but slow on consumer cards.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.2-T2V-A14B",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 36 * GB,
					files: [
						file(
							REPO.t2vA14bGguf,
							"LowNoise/Wan2.2-T2V-A14B-LowNoise-Q8_0.gguf",
							15_404_970_496,
							"71574f62260f3ba305c31085c922a2b1b6672dbfdbe07717c066688ea56966fc",
							"diffusion_model",
						),
						file(
							REPO.t2vA14bGguf,
							"HighNoise/Wan2.2-T2V-A14B-HighNoise-Q8_0.gguf",
							15_404_970_496,
							"e15fecd4ce8f7effe1c4d9ab2c51d37b071bf3dd8b7f1b73e9fc27ac28f6820a",
							"high-noise-diffusion-model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 24 * GB,
					files: [
						file(
							REPO.t2vA14bGguf,
							"LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf",
							9_650_090_496,
							"091a5bae02e14aa016bc9b10a7892efda4c629346b81c5dcebbe30ea2ac8923a",
							"diffusion_model",
						),
						file(
							REPO.t2vA14bGguf,
							"HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf",
							9_650_090_496,
							"e0c490c6e316fd91ff52034e4ca66b825717e33ff11624585c0ccfcb5d410c59",
							"high-noise-diffusion-model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
			],
			defaults: WAN22_A14B,
			demos: [
				{
					url: WAN22_REEL,
					media: "video",
					caption: "The Wan 2.2 demo reel from the model card",
				},
			],
		},
		{
			id: "wan-2.2-i2v-a14b",
			profile: {
				family: "wan-2.2-i2v-a14b",
				name: "Wan 2.2 14B Image to Video",
				author: "Alibaba",
				speed: 1,
				quality: 3,
				text: false,
				bestFor: ["motion", "cinema"],
			},
			name: "Wan 2.2 I2V A14B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["image-to-video"],
			summary:
				"Brings a picture to life: the largest open Wan model, making a clip that starts from the given frame and follows the prompt.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 36 * GB,
					files: [
						file(
							REPO.i2vA14bGguf,
							"LowNoise/Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf",
							15_406_608_896,
							"029c7adc74de4f7804905c5e4fb9335d0862cd2fc37191df526aeac13b64425e",
							"diffusion_model",
						),
						file(
							REPO.i2vA14bGguf,
							"HighNoise/Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf",
							15_406_608_896,
							"619a66032c28e1b27882dfccc0bf93e51edb1491e8d4e4c6f291726abe4de8aa",
							"high-noise-diffusion-model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 24 * GB,
					files: [
						file(
							REPO.i2vA14bGguf,
							"LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf",
							9_651_728_896,
							"e2f98d834af009d035c6b0918268f2eba0aa8a63025ce942277e2384d40b0866",
							"diffusion_model",
						),
						file(
							REPO.i2vA14bGguf,
							"HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf",
							9_651_728_896,
							"836250abfaa3411694e2c9cf3a0cc18265329d5156d81aa116d5366b0f8f02e7",
							"high-noise-diffusion-model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
			],
			defaults: { ...WAN22_A14B, references: { as: "init", max: 1 } },
			demos: [
				{
					url: WAN22_REEL,
					media: "video",
					caption: "The Wan 2.2 demo reel from the model card",
				},
			],
		},
		{
			id: "wan-2.1-t2v-14b",
			profile: {
				family: "wan-2.1-t2v-14b",
				name: "Wan 2.1 14B",
				author: "Alibaba",
				speed: 1,
				quality: 2,
				text: false,
				bestFor: ["motion"],
			},
			name: "Wan 2.1 T2V 14B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["text-to-video"],
			summary:
				"Clips from text with more detail and steadier motion than the small Wan 2.1, at the cost of speed and memory.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.1-T2V-14B",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 21 * GB,
					files: [
						file(
							REPO.t2v14bGguf,
							"wan2.1-t2v-14b-Q8_0.gguf",
							15_879_461_504,
							"cd4f1cc5cd4b63f25898340e997d6299984114e8755be5407bc585a1e0ec9f38",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 15 * GB,
					files: [
						file(
							REPO.t2v14bGguf,
							"wan2.1-t2v-14b-Q4_K_M.gguf",
							10_124_581_504,
							"c9a64d612831debbac77af93744d4b5196b840bf65e9f9f5b958d03fc3baddf2",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						SHARED.wan21Vae,
					],
				},
			],
			defaults: WAN21_14B,
			demos: [
				{
					url: WAN21_REEL,
					media: "video",
					caption: "The Wan 2.1 demo reel from the model card",
				},
			],
		},
		{
			id: "wan-2.1-i2v-14b-480p",
			profile: {
				family: "wan-2.1-i2v-14b",
				name: "Wan 2.1 14B Image to Video",
				author: "Alibaba",
				speed: 1,
				quality: 2,
				text: false,
				bestFor: ["motion"],
			},
			name: "Wan 2.1 I2V 14B 480P",
			author: "Wan-AI (Alibaba)",
			media: "video",
			tasks: ["image-to-video"],
			summary:
				"Animates a picture into a 480p clip that starts from it and follows the prompt.",
			...APACHE_2,
			homepage: "https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P",
			variants: [
				{
					id: "q8",
					label: "8-bit",
					engine: "sd-cpp",
					memoryBytes: 23 * GB,
					files: [
						file(
							REPO.i2v14bGguf,
							"wan2.1-i2v-14b-480p-Q8_0.gguf",
							18_144_640_384,
							"db961e33570a3a7902614ea52b6e77a33d284dfc85743a05e880a02da1164b45",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						CLIP_VISION_H,
						SHARED.wan21Vae,
					],
				},
				{
					id: "q4",
					label: "4-bit",
					engine: "sd-cpp",
					memoryBytes: 16 * GB,
					files: [
						file(
							REPO.i2v14bGguf,
							"wan2.1-i2v-14b-480p-Q4_K_M.gguf",
							11_341_184_384,
							"d91f7139acadb42ea05cdf97b311e5099f714f11fbe4d90916500e2f53cbba82",
							"diffusion_model",
						),
						SHARED.umt5Q8,
						CLIP_VISION_H,
						SHARED.wan21Vae,
					],
				},
			],
			defaults: { ...WAN21_14B, references: { as: "init", max: 1 } },
			demos: [
				{
					url: WAN21_REEL,
					media: "video",
					caption: "The Wan 2.1 demo reel from the model card",
				},
			],
		},
	];
}
