import type { LocalModelSpec } from "@open-reel/core";
import { classicModels } from "./classic";
import { flux2Models } from "./flux2";
import { newerModels } from "./newer";
import { qwenModels } from "./qwen";
import { starterModels } from "./starter";
import { textModels } from "./text";
import { upscaleModels } from "./upscale";
import { videoModels } from "./video";
import { zimageModels } from "./zimage";

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
		...starterModels(),
		...zimageModels(),
		...flux2Models(),
		...qwenModels(),
		...newerModels(),
		...classicModels(),
		...videoModels(),
		...upscaleModels(),
		...textModels(),
	];
}
