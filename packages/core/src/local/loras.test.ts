import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LoraShelf,
	loraBaseOf,
	loraId,
	readSafetensorsHeader,
	triggerOf,
} from "./loras";
import { safetensors } from "./testing";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

/** The names kohya's sd-scripts gives an SDXL LoRA, as in a real one. */
const SDXL_KEYS = [
	"lora_unet_input_blocks_4_1_proj_in.alpha",
	"lora_unet_input_blocks_4_1_proj_in.lora_down.weight",
	"lora_unet_output_blocks_5_1_transformer_blocks_1_ff_net_2.lora_up.weight",
];

/** What kohya wrote in a LoRA trained on 16 captioned pictures. */
const KOHYA_NOTES = {
	ss_output_name: "qzporcelain",
	ss_base_model_version: "sdxl_base_v1-0",
	"modelspec.architecture": "stable-diffusion-xl-v1-base/lora",
	"modelspec.title": "qzporcelain",
	ss_dataset_dirs: JSON.stringify({
		"10_qzporcelain": { n_repeats: 10, img_count: 16 },
	}),
	ss_tag_frequency: JSON.stringify({
		"10_qzporcelain": {
			qzporcelain: 16,
			"studio photo": 7,
			"a figurine of a fox": 1,
		},
	}),
};

describe("reading a LoRA", () => {
	test("the header gives the tensor names and the trainer's notes", async () => {
		const header = await readSafetensorsHeader(
			new Blob([safetensors(SDXL_KEYS, { ss_output_name: "fox" })]),
		);
		expect(header.keys).toEqual(SDXL_KEYS);
		expect(header.metadata).toEqual({ ss_output_name: "fox" });
	});

	test("a file that is not safetensors is refused", async () => {
		for (const bytes of [
			new Uint8Array([1, 2, 3]),
			new Uint8Array(64),
			new TextEncoder().encode("PK\u0003\u0004 a zip, not a LoRA"),
		]) {
			await expect(readSafetensorsHeader(new Blob([bytes]))).rejects.toThrow(
				"not a LoRA",
			);
		}
	});

	test("the family comes from the trainer's notes when they name it", () => {
		const base = (metadata: Record<string, string>) =>
			loraBaseOf({ keys: [], metadata });
		expect(base(KOHYA_NOTES)).toBe("sdxl");
		expect(base({ ss_base_model_version: "sd_v1" })).toBe("sd1");
		expect(base({ "modelspec.architecture": "flux-1-dev/lora" })).toBe("flux");
		expect(base({})).toBeNull();
		// A family open-reel has no model for is not guessed from the names.
		expect(
			loraBaseOf({
				keys: ["lora_unet_down_blocks_0_attentions_0_proj_in.alpha"],
				metadata: { ss_base_model_version: "sd_v2" },
			}),
		).toBeNull();
	});

	test("without notes, the family comes from the tensor names", () => {
		const base = (keys: string[]) => loraBaseOf({ keys, metadata: {} });
		expect(base(SDXL_KEYS)).toBe("sdxl");
		expect(base(["lora_te2_text_model_encoder_layers_0_mlp_fc1.alpha"])).toBe(
			"sdxl",
		);
		expect(
			base([
				"lora_unet_down_blocks_0_attentions_0_proj_in.alpha",
				"lora_te_text_model_encoder_layers_0_mlp_fc1.alpha",
			]),
		).toBe("sd1");
		expect(
			base(["lora_unet_double_blocks_0_img_attn_proj.lora_down.weight"]),
		).toBe("flux");
		expect(base(["diffusion_model.blocks.0.cross_attn.k.lora_A.weight"])).toBe(
			"wan",
		);
		expect(base(["model.weight"])).toBeNull();
		// Deep transformer blocks alone are not SDXL: SD 3 and others have them.
		expect(
			base(["transformer.transformer_blocks.5.attn.to_q.lora_A.weight"]),
		).toBeNull();
		expect(
			base([
				"unet.down_blocks.2.attentions.1.transformer_blocks.7.attn1.to_q.lora_A.weight",
			]),
		).toBe("sdxl");
	});

	test("the trigger word is the tag in every caption", () => {
		expect(triggerOf(KOHYA_NOTES)).toBe("qzporcelain");
		// No tag in every caption: no trigger.
		expect(
			triggerOf({
				...KOHYA_NOTES,
				ss_tag_frequency: JSON.stringify({ d: { fox: 3, cat: 4 } }),
			}),
		).toBeNull();
		expect(triggerOf({})).toBeNull();
		// A tag the engine would read as an order is no trigger.
		expect(
			triggerOf({
				ss_tag_frequency: JSON.stringify({ d: { "<lora:x:9>": 3 } }),
				ss_dataset_dirs: JSON.stringify({ d: { img_count: 3 } }),
			}),
		).toBeNull();
		expect(triggerOf({ ss_tag_frequency: "not json" })).toBeNull();
	});

	test("ids are names the engine can read in a prompt, never reused", () => {
		const taken = new Set(["porcelain"]);
		expect(loraId("Porcelain", (id) => taken.has(id))).toBe("porcelain-2");
		expect(loraId("Estilo Pôr-do-Sol!", () => false)).toBe("estilo-por-do-sol");
		expect(loraId("<lora:x:1>", () => false)).toBe("lora-x-1");
		expect(loraId("!!!", () => false)).toBe("lora");
	});
});

describe("the shelf", () => {
	async function setup() {
		const root = await mkdtemp(join(tmpdir(), "open-reel-loras-"));
		dirs.push(root);
		let changes = 0;
		const shelf = new LoraShelf({
			root: () => root,
			changed: () => changes++,
		});
		return { root, shelf, changes: () => changes };
	}

	test("a LoRA is kept with its family, name and trigger, and listed", async () => {
		const { root, shelf, changes } = await setup();
		const info = await shelf.add(
			new Blob([safetensors(SDXL_KEYS, KOHYA_NOTES)]),
			"downloaded (1).safetensors",
		);
		expect(info).toMatchObject({
			id: "qzporcelain",
			name: "qzporcelain",
			base: "sdxl",
			trigger: "qzporcelain",
		});
		expect(changes()).toBe(1);
		expect(await shelf.list()).toEqual([info]);
		expect(shelf.path("qzporcelain")).toBe(
			join(root, "loras", "qzporcelain.safetensors"),
		);
		expect((await readdir(join(root, "loras"))).sort()).toEqual([
			"qzporcelain.json",
			"qzporcelain.safetensors",
		]);
	});

	test("without a title the file's name names it; the same name twice gets two ids", async () => {
		const { shelf } = await setup();
		const file = () => new Blob([safetensors(SDXL_KEYS)]);
		const first = await shelf.add(file(), "Watercolor.safetensors");
		const second = await shelf.add(file(), "Watercolor.safetensors");
		expect([first.id, first.name, first.trigger]).toEqual([
			"watercolor",
			"Watercolor",
			null,
		]);
		expect(second.id).toBe("watercolor-2");
		expect((await shelf.list()).map((l) => l.id).sort()).toEqual([
			"watercolor",
			"watercolor-2",
		]);
	});

	test("a file it cannot read, or for an unknown family, leaves nothing behind", async () => {
		const { root, shelf, changes } = await setup();
		await expect(
			shelf.add(new Blob([new Uint8Array(32)]), "x.safetensors"),
		).rejects.toMatchObject({ code: "loraUnreadable" });
		await expect(
			shelf.add(new Blob([safetensors(["model.weight"])]), "x.safetensors"),
		).rejects.toMatchObject({ code: "loraUnknownBase" });
		expect(await readdir(join(root, "loras"))).toEqual([]);
		expect(changes()).toBe(0);
	});

	test("a LoRA can be deleted; one that is not there is not found", async () => {
		const { root, shelf } = await setup();
		await shelf.add(new Blob([safetensors(SDXL_KEYS)]), "a.safetensors");
		await shelf.remove("a");
		expect(await shelf.list()).toEqual([]);
		expect(await readdir(join(root, "loras"))).toEqual([]);
		await expect(shelf.remove("a")).rejects.toMatchObject({
			code: "loraMissing",
		});
		await expect(shelf.get("../escape")).rejects.toMatchObject({
			code: "loraMissing",
		});
	});

	test("the shelf follows the models folder when it moves", async () => {
		const { shelf } = await setup();
		const other = await mkdtemp(join(tmpdir(), "open-reel-loras-"));
		dirs.push(other);
		let root = other;
		const moving = new LoraShelf({ root: () => root });
		await moving.add(new Blob([safetensors(SDXL_KEYS)]), "a.safetensors");
		root = await mkdtemp(join(tmpdir(), "open-reel-loras-"));
		dirs.push(root);
		expect(await moving.list()).toEqual([]);
		expect(await shelf.list()).toEqual([]);
	});

	test("notes for an unknown family, and stale half uploads, are not kept", async () => {
		const { root, shelf } = await setup();
		await shelf.add(new Blob([safetensors(SDXL_KEYS)]), "a.safetensors");
		await Bun.write(join(root, "loras", "a.json"), '{"name":"a","base":"sd3"}');
		expect(await shelf.list()).toEqual([]);
		const part = join(root, "loras", "old.part");
		await Bun.write(part, "half");
		await utimes(part, new Date(0), new Date(0));
		await Bun.write(join(root, "loras", "new.part"), "half");
		await shelf.sweep();
		expect((await readdir(join(root, "loras"))).sort()).toEqual([
			"a.json",
			"a.safetensors",
			"new.part",
		]);
	});

	test("two uploads of one name at once get two ids", async () => {
		const { shelf } = await setup();
		const file = () => new Blob([safetensors(SDXL_KEYS)]);
		const [a, b] = await Promise.all([
			shelf.add(file(), "Same.safetensors"),
			shelf.add(file(), "Same.safetensors"),
		]);
		expect([a.id, b.id].sort()).toEqual(["same", "same-2"]);
		expect(await shelf.list()).toHaveLength(2);
	});

	test("an upload in progress keeps the shelf busy", async () => {
		const { shelf } = await setup();
		let release!: () => void;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				controller.enqueue(safetensors(SDXL_KEYS));
				controller.close();
			},
		});
		const adding = shelf.add(body, "slow.safetensors");
		while (!release) await Bun.sleep(1);
		expect(shelf.busy).toBe(true);
		release();
		await adding;
		expect(shelf.busy).toBe(false);
	});

	test("nothing is written while the folder cannot be", async () => {
		const root = await mkdtemp(join(tmpdir(), "open-reel-loras-"));
		dirs.push(root);
		const shelf = new LoraShelf({
			root: () => root,
			check: () => {
				throw new Error("moving");
			},
		});
		await expect(
			shelf.add(new Blob([safetensors(SDXL_KEYS)]), "a.safetensors"),
		).rejects.toThrow("moving");
		expect(await readdir(root)).toEqual([]);
	});
});
