import type { LocalModelSpec } from "@open-reel/core";

/** A file in a Hugging Face repository, at a fixed revision. */
const hf = (repo: string, revision: string, path: string) =>
	`https://huggingface.co/${repo}/resolve/${revision}/${path}`;

const COMFY_Z_IMAGE = "6fc90a3b1b653e935a0d175e260736de25b84df5";
const COMFY_WAN = "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d";
const FLUX_ENCODERS = "6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5";
const Z_IMAGE = "f332072aa78be7aecdf3ee76d5c247082da564a6";

/** The image decoder FLUX and Z-Image share. */
const FLUX_VAE = {
	name: "ae.safetensors",
	url: hf(
		"Comfy-Org/Z-Image-Turbo",
		COMFY_Z_IMAGE,
		"split_files/vae/ae.safetensors",
	),
	size: 335_304_388,
	sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
};

/**
 * The models open-reel can download, as single-file weights. Sizes and hashes
 * are the ones their repositories report at the pinned revision.
 */
export function builtinLocalModels(): LocalModelSpec[] {
	return [
		{
			id: "sdxl-turbo",
			name: "SDXL Turbo",
			author: "Stability AI",
			media: "image",
			summary:
				"A distilled SDXL that makes a 512px image in a single step. The quickest way to try ideas; non-commercial use only.",
			license: "Stability AI Non-Commercial",
			homepage: "https://huggingface.co/stabilityai/sdxl-turbo",
			files: [
				{
					name: "sd_xl_turbo_1.0_fp16.safetensors",
					url: hf(
						"stabilityai/sdxl-turbo",
						"71153311d3dbb46851df1931d3ca6e939de83304",
						"sd_xl_turbo_1.0_fp16.safetensors",
					),
					size: 6_938_081_905,
					sha256:
						"e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26",
				},
			],
			demos: [
				{
					url: hf(
						"stabilityai/sdxl-turbo",
						"71153311d3dbb46851df1931d3ca6e939de83304",
						"output_tile.jpg",
					),
					media: "image",
					caption: "Single-step samples from the model card",
				},
			],
		},
		{
			id: "sdxl-base",
			name: "Stable Diffusion XL",
			author: "Stability AI",
			media: "image",
			summary:
				"The 1024px general-purpose model with the largest ecosystem of fine-tunes and LoRAs.",
			license: "CreativeML Open RAIL++-M",
			homepage:
				"https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0",
			files: [
				{
					name: "sd_xl_base_1.0.safetensors",
					url: hf(
						"stabilityai/stable-diffusion-xl-base-1.0",
						"462165984030d82259a11f4367a4eed129e94a7b",
						"sd_xl_base_1.0.safetensors",
					),
					size: 6_938_078_334,
					sha256:
						"31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
				},
			],
			demos: [
				{
					url: hf(
						"stabilityai/stable-diffusion-xl-base-1.0",
						"462165984030d82259a11f4367a4eed129e94a7b",
						"01.png",
					),
					media: "image",
					caption: "Samples from the model card",
				},
			],
		},
		{
			id: "flux-schnell",
			name: "FLUX.1 schnell",
			author: "Black Forest Labs",
			media: "image",
			summary:
				"Detailed 1024px images in four steps, with strong prompt following. Quantized to 4 bits to fit consumer graphics cards.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/black-forest-labs/FLUX.1-schnell",
			files: [
				{
					name: "flux1-schnell-Q4_K_S.gguf",
					url: hf(
						"city96/FLUX.1-schnell-gguf",
						"f495746ed9c5efcf4661f53ef05401dceadc17d2",
						"flux1-schnell-Q4_K_S.gguf",
					),
					size: 6_783_943_712,
					sha256:
						"4fd16477b3a5296d0cf722c4b92a9fd7f30d09ac7495826e4465d8de9c9fd973",
				},
				{
					name: "t5xxl_fp8_e4m3fn.safetensors",
					url: hf(
						"comfyanonymous/flux_text_encoders",
						FLUX_ENCODERS,
						"t5xxl_fp8_e4m3fn.safetensors",
					),
					size: 4_893_934_904,
					sha256:
						"7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09",
				},
				{
					name: "clip_l.safetensors",
					url: hf(
						"comfyanonymous/flux_text_encoders",
						FLUX_ENCODERS,
						"clip_l.safetensors",
					),
					size: 246_144_152,
					sha256:
						"660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
				},
				FLUX_VAE,
			],
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
			name: "Z-Image Turbo",
			author: "Tongyi-MAI (Alibaba)",
			media: "image",
			summary:
				"Photorealistic images in eight steps, and legible text in English and Chinese.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
			files: [
				{
					name: "z_image_turbo_bf16.safetensors",
					url: hf(
						"Comfy-Org/Z-Image-Turbo",
						COMFY_Z_IMAGE,
						"split_files/diffusion_models/z_image_turbo_bf16.safetensors",
					),
					size: 12_309_866_400,
					sha256:
						"2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6",
				},
				{
					name: "qwen_3_4b.safetensors",
					url: hf(
						"Comfy-Org/Z-Image-Turbo",
						COMFY_Z_IMAGE,
						"split_files/text_encoders/qwen_3_4b.safetensors",
					),
					size: 8_044_982_048,
					sha256:
						"6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
				},
				FLUX_VAE,
			],
			demos: [
				{
					url: hf(
						"Tongyi-MAI/Z-Image-Turbo",
						Z_IMAGE,
						"assets/showcase_realistic.png",
					),
					media: "image",
					caption: "Photorealistic samples from the model card",
				},
				{
					url: hf(
						"Tongyi-MAI/Z-Image-Turbo",
						Z_IMAGE,
						"assets/showcase_rendering.png",
					),
					media: "image",
					caption: "Text rendering samples from the model card",
				},
			],
		},
		{
			id: "wan-2.1-t2v-1.3b",
			name: "Wan 2.1 T2V 1.3B",
			author: "Wan-AI (Alibaba)",
			media: "video",
			summary:
				"Five-second 480p clips from text. The small Wan model, made to run on consumer graphics cards.",
			license: "Apache 2.0",
			homepage: "https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B",
			files: [
				{
					name: "wan2.1_t2v_1.3B_fp16.safetensors",
					url: hf(
						"Comfy-Org/Wan-2.1",
						COMFY_WAN,
						"split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",
					),
					size: 2_838_303_560,
					sha256:
						"be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5",
				},
				{
					name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
					url: hf(
						"Comfy-Org/Wan-2.1",
						COMFY_WAN,
						"split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
					),
					size: 6_735_906_897,
					sha256:
						"c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
				},
				{
					name: "wan_2.1_vae.safetensors",
					url: hf(
						"Comfy-Org/Wan-2.1",
						COMFY_WAN,
						"split_files/vae/wan_2.1_vae.safetensors",
					),
					size: 253_815_318,
					sha256:
						"2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
				},
			],
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
