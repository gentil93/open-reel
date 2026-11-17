import { describe, expect, test } from "bun:test";
import type { Media } from "@open-reel/core";
import { builtinProviders } from "./index";
import { builtinLocalModels } from "./local-models";
import { profiledModelIds, profileFor } from "./profiles";

const cloudModels = builtinProviders().flatMap((p) => p.listModels());

describe("model profiles", () => {
	test("cloud models list with their profiles", () => {
		for (const model of cloudModels) {
			expect(model.profile).toEqual(profileFor(model.id));
		}
		expect(cloudModels.some((m) => m.profile)).toBe(true);
	});

	test("no profile points at a model that does not exist", () => {
		const ids = new Set(cloudModels.map((m) => m.id));
		// An id here that no provider lists is a typo or a removed model.
		expect(profiledModelIds().filter((id) => !ids.has(id))).toEqual([]);
	});

	test("every local model has a profile", () => {
		for (const model of builtinLocalModels()) {
			expect(model.profile).toBeDefined();
		}
	});

	test("a family keeps one media", () => {
		const media = new Map<string, Media>();
		for (const model of cloudModels) {
			if (!model.profile) continue;
			const seen = media.get(model.profile.family);
			if (seen) expect(model.media).toBe(seen);
			media.set(model.profile.family, model.media);
		}
	});
});
