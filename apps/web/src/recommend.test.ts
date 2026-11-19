import { describe, expect, test } from "bun:test";
import type {
	Fit,
	Hardware,
	LocalModelStatus,
	ModelProfile,
	ModelSpec,
	ProviderStatus,
} from "@hatchlight/core/types";
import {
	bestCloud,
	bestLocal,
	categoryOf,
	cloudFamilies,
	filterLocal,
	firstModel,
	fitLevel,
	gpuMemory,
	neededMemory,
	recommendedLocal,
	sortLocal,
} from "./recommend";

const GB = 2 ** 30;

function local(
	id: string,
	fit: Fit,
	options: Partial<LocalModelStatus> = {},
): LocalModelStatus {
	return {
		id,
		name: id,
		media: "image",
		tasks: ["text-to-image"],
		commercial: { kind: "allowed" },
		state: "available",
		ready: false,
		installed: false,
		size: 7 * GB,
		variant: "v",
		variants: [
			{
				id: "v",
				label: "16-bit",
				engine: "e",
				memoryBytes: 8 * GB,
				fit,
				size: 7 * GB,
				files: [],
			},
		],
		...options,
	} as LocalModelStatus;
}

function profile(
	family: string,
	speed: 1 | 2 | 3,
	quality: 1 | 2 | 3,
): ModelProfile {
	return {
		family,
		name: family,
		author: "a",
		speed,
		quality,
		text: false,
		bestFor: [],
	};
}

function cloud(
	id: string,
	providerId: string,
	options: Partial<ModelSpec> = {},
): ModelSpec {
	return {
		id,
		providerId,
		providerModelId: id,
		name: id,
		media: "image",
		operations: ["generate"],
		capabilities: {
			aspectRatios: [],
			seed: false,
			maxCount: 1,
			maxReferenceImages: 0,
		},
		...options,
	};
}

const keyed = (...ids: string[]): ProviderStatus[] =>
	["fal", "google", "openai", "local"].map((id) => ({
		id,
		name: id,
		requiresKey: id !== "local",
		hasKey: ids.includes(id),
	}));

describe("fit", () => {
	test("says how a model runs in plain levels", () => {
		expect(fitLevel("gpu")).toBe("great");
		expect(fitLevel("offload")).toBe("slow");
		expect(fitLevel("cpu")).toBe("slow");
		expect(fitLevel("none")).toBe("none");
	});

	test("reads the memory the chosen version needs and the GPU has", () => {
		expect(neededMemory(local("a", "gpu"))).toBe(8 * GB);
		expect(neededMemory(local("a", "gpu", { variant: null }))).toBeNull();
		const hardware = {
			gpus: [{ memoryBytes: 6 * GB }, { memoryBytes: 12 * GB }],
		} as Hardware;
		expect(gpuMemory(hardware)).toBe(12 * GB);
		expect(gpuMemory({ gpus: [] } as unknown as Hardware)).toBeNull();
	});
});

describe("bestLocal", () => {
	test("prefers a quick model that fits the graphics card", () => {
		const pick = bestLocal([
			local("sdxl-base", "gpu", { size: 6 * GB }),
			local("sdxl-turbo", "gpu"),
			local("flux-schnell", "offload"),
		]);
		expect(pick?.id).toBe("sdxl-turbo");
	});

	test("prefers what is already installed or installing", () => {
		const pick = bestLocal([
			local("sdxl-turbo", "gpu"),
			local("sdxl-base", "gpu", { state: "downloading" }),
		]);
		expect(pick?.id).toBe("sdxl-base");
	});

	test("recommends nothing without a graphics card that runs it", () => {
		expect(
			bestLocal([local("sdxl-turbo", "cpu"), local("z", "none")]),
		).toBeUndefined();
	});

	test("keeps to the media asked for", () => {
		const video = local("wan", "gpu", { media: "video" });
		expect(bestLocal([video], "image")).toBeUndefined();
		expect(bestLocal([video], "video")?.id).toBe("wan");
	});
});

describe("cloud families", () => {
	const banana = profile("nano-banana", 2, 3);
	const flux = profile("flux", 3, 2);
	const models = [
		cloud("fal/banana", "fal", { profile: banana }),
		cloud("google/banana", "google", { profile: banana }),
		cloud("fal/flux", "fal", { profile: flux }),
		cloud("local/flux", "local", { profile: flux }),
		cloud("fal/unknown", "fal"),
	];

	test("show each model once, with every service that offers it", () => {
		const families = cloudFamilies(models, keyed(), "image");
		expect(families.map((f) => f.profile.family)).toEqual([
			"nano-banana",
			"flux",
		]);
		expect(families[0]?.routes.map((r) => r.id)).toEqual([
			"fal/banana",
			"google/banana",
		]);
		// Local models are chosen from the local catalog instead.
		expect(families[1]?.routes.map((r) => r.id)).toEqual(["fal/flux"]);
	});

	test("use a service that has a key", () => {
		const [banana] = cloudFamilies(models, keyed("google"), "image");
		expect(banana?.ready?.id).toBe("google/banana");
	});

	test("recommend a ready model first, then the fastest", () => {
		expect(
			bestCloud(cloudFamilies(models, keyed(), "image"))?.profile.family,
		).toBe("flux");
		expect(
			bestCloud(cloudFamilies(models, keyed("google"), "image"))?.profile
				.family,
		).toBe("nano-banana");
	});
});

describe("firstModel", () => {
	test("picks a free model before a paid one, among ready ones", () => {
		const models = [
			cloud("fal/a", "fal", { pricing: { usdPerOutput: 0.04 } }),
			cloud("local/b", "local", { pricing: { usdPerOutput: 0 } }),
			cloud("google/c", "google", { pricing: { usdPerOutput: 0.01 } }),
		];
		expect(firstModel(models, keyed("fal"))?.id).toBe("local/b");
		expect(firstModel(models.slice(0, 1), keyed())).toBeUndefined();
	});
});

describe("the local models list", () => {
	const ALL = {
		category: "all",
		runsWell: false,
		commercial: false,
		installed: false,
	} as const;
	const editor = local("editor", "gpu", { tasks: ["image-edit"] });
	const both = local("both", "gpu", {
		tasks: ["text-to-image", "image-edit"],
	});
	const clip = local("clip", "offload", {
		media: "video",
		tasks: ["text-to-video", "image-to-video"],
	});
	const personal = local("personal", "gpu", {
		commercial: { kind: "none" },
	});
	const big = local("big", "none");
	const models = [editor, both, clip, personal, big];

	test("a model sits on the shelf of what it is mainly for", () => {
		expect(models.map(categoryOf)).toEqual([
			"edit",
			"image",
			"video",
			"image",
			"image",
		]);
	});

	test("a shelf also shows models that can do its job as a second use", () => {
		const ids = (filter: Partial<typeof ALL> | object) =>
			filterLocal(models, { ...ALL, ...filter }).map((m) => m.id);
		expect(ids({ category: "edit" })).toEqual(["editor", "both"]);
		expect(ids({ category: "video" })).toEqual(["clip"]);
		expect(ids({ runsWell: true })).toEqual(["editor", "both", "personal"]);
		expect(ids({ commercial: true })).not.toContain("personal");
		expect(ids({ installed: true })).toEqual([]);
	});

	test("what runs well here comes first, then the better model", () => {
		const good = local("good", "gpu", {
			profile: profile("good", 1, 3),
		});
		const fast = local("fast", "gpu", {
			profile: profile("fast", 3, 1),
		});
		const mine = local("mine", "offload", { state: "installed" });
		expect(sortLocal([big, fast, mine, good]).map((m) => m.id)).toEqual([
			"mine",
			"good",
			"fast",
			"big",
		]);
	});

	test("each shelf recommends its best model that runs at full speed", () => {
		const good = local("good", "gpu", { profile: profile("good", 1, 3) });
		const picks = recommendedLocal([...models, good]);
		expect([...picks].sort()).toEqual(["editor", "good"]);
		// The only video model would spill out of the graphics card.
		expect(picks.has("clip")).toBe(false);
	});
});
