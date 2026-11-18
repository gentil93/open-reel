import type { LocalModelFile, LocalModelSpec } from "@open-reel/core";

/** A file in a Hugging Face repository, at a fixed revision. */
export const hf = (repo: string, revision: string, path: string) =>
	`https://huggingface.co/${repo}/resolve/${revision}/${path}`;

export const GB = 1e9;

/** A repository and the revision (commit) it is pinned to. */
export type Repo = readonly [repo: string, revision: string];

export const file = (
	[repo, revision]: Repo,
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

/** Every ratio the interface offers, for models that take any size. */
export const ALL_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];

type Terms = Pick<LocalModelSpec, "license" | "licenseUrl" | "commercial">;

export const APACHE_2: Terms = {
	license: "Apache 2.0",
	licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
	commercial: { kind: "allowed" },
};

export const MIT: Terms = {
	license: "MIT",
	licenseUrl: "https://opensource.org/license/mit",
	commercial: { kind: "allowed" },
};

/**
 * The OpenRAIL licenses allow any use, paid work included, except the uses
 * their use-based restrictions list; `url` is the model's own copy.
 */
export const openRail = (name: string, url: string): Terms => ({
	license: name,
	licenseUrl: url,
	commercial: { kind: "allowed" },
});

/** Pinned repositories whose files more than one model uses. */
export const SHARED_REPO = {
	comfyZImage: [
		"Comfy-Org/Z-Image-Turbo",
		"6fc90a3b1b653e935a0d175e260736de25b84df5",
	],
	fluxEncoders: [
		"comfyanonymous/flux_text_encoders",
		"6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5",
	],
	qwen3Instruct: [
		"unsloth/Qwen3-4B-Instruct-2507-GGUF",
		"a06e946bb6b655725eafa393f4a9745d460374c9",
	],
	comfyWan: ["Comfy-Org/Wan-2.1", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d"],
	umt5Gguf: [
		"city96/umt5-xxl-encoder-gguf",
		"b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7",
	],
} as const satisfies Record<string, Repo>;

/**
 * Files more than one model uses. Files with the same hash are stored once,
 * so a model that reuses one of these downloads less.
 */
export const SHARED = {
	/** The FLUX.1 image decoder (`ae.safetensors`), also used by Z-Image. */
	fluxVae: file(
		SHARED_REPO.comfyZImage,
		"split_files/vae/ae.safetensors",
		335_304_388,
		"afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
		"vae",
	),
	fluxT5: file(
		SHARED_REPO.fluxEncoders,
		"t5xxl_fp8_e4m3fn.safetensors",
		4_893_934_904,
		"7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09",
		"t5xxl",
	),
	fluxClip: file(
		SHARED_REPO.fluxEncoders,
		"clip_l.safetensors",
		246_144_152,
		"660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
		"clip_l",
	),
	/**
	 * Qwen3 4B (the base model, despite the group's name), the text encoder
	 * Z-Image and FLUX.2 klein 4B ship with. The GGUF files below are the
	 * Instruct 2507 version, which stable-diffusion.cpp's Z-Image guide uses.
	 */
	qwen3InstructBf16: file(
		SHARED_REPO.comfyZImage,
		"split_files/text_encoders/qwen_3_4b.safetensors",
		8_044_982_048,
		"6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
		"llm",
	),
	qwen3InstructQ8: file(
		SHARED_REPO.qwen3Instruct,
		"Qwen3-4B-Instruct-2507-Q8_0.gguf",
		4_280_405_600,
		"391c1e410fd9f4cf2de2b510273b56a84c19ce18f4fa3bfb3774031dac4ef068",
		"llm",
	),
	qwen3InstructQ4: file(
		SHARED_REPO.qwen3Instruct,
		"Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
		2_497_281_120,
		"3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
		"llm",
	),
	/** UMT5-XXL, the text encoder of every Wan model. */
	umt5Q8: file(
		SHARED_REPO.umt5Gguf,
		"umt5-xxl-encoder-Q8_0.gguf",
		6_043_068_256,
		"2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc",
		"t5xxl",
	),
	/** The Wan 2.1 video decoder, used by every Wan model but Wan 2.2 5B. */
	wan21Vae: file(
		SHARED_REPO.comfyWan,
		"split_files/vae/wan_2.1_vae.safetensors",
		253_815_318,
		"2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
		"vae",
	),
} as const;

/** The negative prompt Wan's authors publish, in the Chinese it was trained on. */
export const WAN_NEGATIVE =
	"色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";
