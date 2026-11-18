import type { LocalModelSpec } from "@open-reel/core";
import { GB, hf, type Repo } from "./shared";

/**
 * A pinned copy of the authors' release: the same file, by its hash, as
 * github.com/xinntao/Real-ESRGAN/releases/v0.1.0.
 */
const ANNOTATORS: Repo = [
	"lllyasviel/Annotators",
	"982e7edaec38759d914a963c48c4726685de7d96",
];

/** Models that make a picture larger and sharper, without words. */
export function upscaleModels(): LocalModelSpec[] {
	return [
		{
			id: "real-esrgan-x4plus",
			profile: {
				family: "real-esrgan",
				name: "Real-ESRGAN",
				author: "Tencent ARC",
				speed: 3,
				quality: 2,
				text: false,
				bestFor: ["detail"],
			},
			name: "Real-ESRGAN ×4",
			author: "Xintao Wang et al. (Tencent ARC)",
			media: "image",
			tasks: ["upscale"],
			summary:
				"Makes a picture four times larger and sharper, keeping it as it is. Small and fast: a 1024px picture comes out at 4096px in seconds.",
			license: "BSD 3-Clause",
			licenseUrl: "https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE",
			commercial: { kind: "allowed" },
			homepage: "https://github.com/xinntao/Real-ESRGAN",
			variants: [
				{
					id: "x4plus",
					label: "×4",
					engine: "sd-cpp",
					memoryBytes: 1.5 * GB,
					files: [
						{
							name: "RealESRGAN_x4plus.pth",
							url: hf(...ANNOTATORS, "RealESRGAN_x4plus.pth"),
							size: 67_040_989,
							sha256:
								"4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
							role: "upscale_model",
						},
					],
				},
			],
			defaults: {
				size: 1024,
				aspectRatios: [],
				steps: 1,
				cfgScale: 1,
				references: { as: "init", max: 1 },
				upscale: 4,
			},
			demos: [],
		},
	];
}
