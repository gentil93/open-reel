import { describe, expect, test } from "bun:test";
import { roleOption } from "@open-reel/core";
import en from "../../../../apps/web/src/locales/en.json";
import ptBR from "../../../../apps/web/src/locales/pt-BR.json";
import { builtinLocalModels } from "./index";

const models = builtinLocalModels();
const PINNED =
	/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/\S+$/;

describe("the local models catalog", () => {
	test("ids are unique", () => {
		const ids = models.map((m) => m.id);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
	});

	test("every file is pinned to a commit and has a hash and a size", () => {
		for (const model of models) {
			for (const variant of model.variants) {
				for (const file of variant.files) {
					const where = `${model.id}/${variant.id}/${file.name}`;
					expect(file.url, where).toMatch(PINNED);
					expect(file.sha256, where).toMatch(/^[0-9a-f]{64}$/);
					expect(file.size, where).toBeGreaterThan(0);
				}
			}
		}
	});

	test("every file goes to an engine option, once per variant", () => {
		for (const model of models) {
			for (const variant of model.variants) {
				const roles = variant.files.map((f) => f.role ?? "");
				const names = variant.files.map((f) => f.name);
				const where = `${model.id}/${variant.id}`;
				expect(new Set(roles).size, where).toBe(roles.length);
				expect(new Set(names).size, where).toBe(names.length);
				for (const role of roles) expect(() => roleOption(role)).not.toThrow();
			}
		}
	});

	test("a model that takes pictures says how, and one that says how takes them", () => {
		for (const model of models) {
			const takes = model.tasks.some(
				(t) =>
					t === "image-edit" ||
					t === "image-to-video" ||
					t === "image-to-image" ||
					t === "upscale",
			);
			expect(Boolean(model.defaults.references), model.id).toBe(takes);
			// Redrawing and animating start from the picture; editing follows it.
			if (
				model.tasks.includes("image-to-video") ||
				model.tasks.includes("image-to-image") ||
				model.tasks.includes("upscale")
			) {
				expect(model.defaults.references?.as, model.id).toBe("init");
			}
		}
	});

	test("tasks match the media", () => {
		for (const model of models) {
			const video = model.tasks.some((t) => t.endsWith("video"));
			expect(model.media === "video", model.id).toBe(video);
			expect(model.tasks.length, model.id).toBeGreaterThan(0);
		}
	});

	test("variants come best first and need more memory than they download", () => {
		for (const model of models) {
			expect(model.variants.length, model.id).toBeGreaterThan(0);
			const memory = model.variants.map((v) => v.memoryBytes);
			expect(memory, model.id).toEqual(memory.toSorted((a, b) => b - a));
			// Weights converted while loading (`--type`) can take less than the file.
			if (model.defaults.engineArgs?.includes("--type")) continue;
			for (const variant of model.variants) {
				const diffusion = variant.files.find(
					(f) => f.role === "diffusion_model" || f.role === "model",
				);
				expect(
					variant.memoryBytes,
					`${model.id}/${variant.id}`,
				).toBeGreaterThan(diffusion?.size ?? 0);
			}
		}
	});

	test("every model links its license and says what paid work it allows", () => {
		for (const model of models) {
			expect(model.licenseUrl, model.id).toStartWith("https://");
			expect(model.homepage, model.id).toStartWith("https://");
			expect(["allowed", "limited", "none"]).toContain(model.commercial.kind);
		}
	});

	test("the app says every model's summary, in English and Portuguese", () => {
		const catalogs = [en, ptBR] as Record<string, unknown>[];
		for (const model of models) {
			const key = `models.summary.${model.id}`;
			expect((en as Record<string, unknown>)[key], key).toBe(model.summary);
			for (const catalog of catalogs) expect(catalog[key], key).toBeString();
		}
	});
});
