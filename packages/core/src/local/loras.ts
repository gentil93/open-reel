import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../errors";
import { LORA_BASES, LORA_ID, type LoraBase, type LoraInfo } from "../types";

/**
 * A LoRA is a small file that teaches a model a style, a subject or a
 * character. It only works with the family of models it was trained on, so
 * each one is read when added to learn which family that is.
 */

/** A safetensors header larger than this is not a LoRA's. */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;
/** Larger files are full models, not LoRAs. */
export const MAX_LORA_BYTES = 4 * 1024 * 1024 * 1024;
const ID = LORA_ID;
/** An upload that stopped half way: older than this, nobody is writing it. */
const STALE_PART_MS = 60 * 60 * 1000;

export interface SafetensorsHeader {
	/** Tensor names, e.g. "lora_unet_input_blocks_4_1_proj_in.alpha". */
	keys: string[];
	/** What the trainer wrote down, such as `ss_tag_frequency`. */
	metadata: Record<string, string>;
}

function notALora(): ValidationError {
	return new ValidationError(
		"This file is not a LoRA in the safetensors format",
		"loraUnreadable",
	);
}

/** Reads the names and metadata at the start of a safetensors file. */
export async function readSafetensorsHeader(
	file: Blob,
): Promise<SafetensorsHeader> {
	if (file.size < 8) throw notALora();
	const head = new DataView(await file.slice(0, 8).arrayBuffer());
	const length = Number(head.getBigUint64(0, true));
	if (length < 2 || length > MAX_HEADER_BYTES || 8 + length > file.size) {
		throw notALora();
	}
	let header: unknown;
	try {
		header = JSON.parse(await file.slice(8, 8 + length).text());
	} catch {
		throw notALora();
	}
	if (!header || typeof header !== "object" || Array.isArray(header)) {
		throw notALora();
	}
	const { __metadata__: raw, ...tensors } = header as Record<string, unknown>;
	const metadata: Record<string, string> = {};
	if (raw && typeof raw === "object") {
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string") metadata[key] = value;
		}
	}
	return { keys: Object.keys(tensors), metadata };
}

/** The family a trainer named, in `modelspec.architecture` or kohya's notes. */
function baseFromMetadata(
	metadata: Record<string, string>,
): LoraBase | "unknown" | null {
	const named = [
		metadata["modelspec.architecture"],
		metadata.ss_base_model_version,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	if (!named) return null;
	if (/stable-diffusion-xl|sdxl/.test(named)) return "sdxl";
	if (/stable-diffusion-v1|sd_v1|sd-v1/.test(named)) return "sd1";
	if (/flux/.test(named)) return "flux";
	if (/wan/.test(named)) return "wan";
	if (/z-image|zimage/.test(named)) return "z-image";
	// Named, but a family open-reel has no model for (SD 2, SD 3…): the
	// tensor names would mistake it for one it has.
	return "unknown";
}

/** The family the tensor names belong to, when the trainer left no note. */
function baseFromKeys(keys: string[]): LoraBase | null {
	const any = (pattern: RegExp) => keys.some((key) => pattern.test(key));
	if (any(/double_blocks|single_blocks|single_transformer_blocks/)) {
		return "flux";
	}
	if (any(/noise_refiner|context_refiner/)) return "z-image";
	if (any(/blocks[._]\d+[._](cross_attn|self_attn)/)) return "wan";
	// SDXL has a second text encoder and names its UNet blocks the SGM way;
	// its attention blocks go deeper than SD 1's two transformer blocks.
	if (
		any(/lora_te2_|text_encoder_2/) ||
		any(/lora_unet_(input_blocks|output_blocks|middle_block)_/) ||
		any(
			/(down|up)_blocks[._]\d+[._]attentions[._]\d+[._]transformer_blocks[._][2-9]/,
		)
	) {
		return "sdxl";
	}
	if (any(/lora_unet_down_blocks_|lora_te_text_model|unet\.down_blocks/)) {
		return "sd1";
	}
	return null;
}

/** Which family of models a LoRA is for, or null when it cannot be told. */
export function loraBaseOf(header: SafetensorsHeader): LoraBase | null {
	const named = baseFromMetadata(header.metadata);
	if (named === "unknown") return null;
	return named ?? baseFromKeys(header.keys);
}

/**
 * The word that calls the LoRA up, when its trainer put one in every
 * caption (kohya counts each caption's tags in `ss_tag_frequency`).
 */
export function triggerOf(metadata: Record<string, string>): string | null {
	try {
		const frequency = JSON.parse(metadata.ss_tag_frequency ?? "null") as Record<
			string,
			Record<string, number>
		> | null;
		if (!frequency || typeof frequency !== "object") return null;
		const dirs = JSON.parse(metadata.ss_dataset_dirs ?? "null") as Record<
			string,
			{ img_count?: number }
		> | null;
		const counts = new Map<string, number>();
		for (const tags of Object.values(frequency)) {
			for (const [tag, count] of Object.entries(tags ?? {})) {
				if (typeof count !== "number") continue;
				counts.set(tag.trim(), (counts.get(tag.trim()) ?? 0) + count);
			}
		}
		const pictures = dirs
			? Object.values(dirs).reduce((sum, dir) => sum + (dir?.img_count ?? 0), 0)
			: Math.max(0, ...counts.values());
		if (pictures < 2) return null;
		// In every caption, and a word rather than a description.
		const [trigger] = [...counts]
			.filter(
				([tag, count]) =>
					count >= pictures &&
					tag.length <= 40 &&
					// Plain words: the engine reads `<…:…>` as an order.
					!/[<>:]/.test(tag),
			)
			.map(([tag]) => tag);
		return trigger || null;
	} catch {
		return null;
	}
}

/** A name people can read: the trainer's title, else the file's name. */
function nameOf(metadata: Record<string, string>, fileName: string): string {
	const named =
		metadata["modelspec.title"]?.trim() || metadata.ss_output_name?.trim();
	const fallback = fileName.replace(/\.safetensors$/i, "").trim();
	return (named || fallback || "LoRA").slice(0, 80);
}

/** An id the engine can read inside a prompt: `<lora:id:1>`. */
export function loraId(name: string, taken: (id: string) => boolean): string {
	const base =
		name
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 56) || "lora";
	if (!taken(base)) return base;
	for (let n = 2; ; n++) {
		const id = `${base}-${n}`;
		if (!taken(id)) return id;
	}
}

export interface LoraShelfOptions {
	/** The models folder, which can change while the app runs. */
	root: () => string;
	/** Throws when the folder cannot be written now, e.g. while it moves. */
	check?: () => void;
	/** Told after a LoRA is added or deleted. */
	changed?: () => void;
}

/** The LoRAs kept in the models folder, each a file and its notes. */
export class LoraShelf {
	private options: LoraShelfOptions;
	/** Uploads being written, which a move of the folder must wait for. */
	private uploads = 0;
	/** Ids are chosen and taken one upload at a time. */
	private naming: Promise<unknown> = Promise.resolve();

	constructor(options: LoraShelfOptions) {
		this.options = options;
	}

	/** An upload is being written into the folder. */
	get busy(): boolean {
		return this.uploads > 0;
	}

	/** Removes what uploads that stopped half way left behind. */
	async sweep(): Promise<void> {
		for (const name of await readdir(this.dir).catch(() => [] as string[])) {
			if (!name.endsWith(".part")) continue;
			const file = join(this.dir, name);
			const info = await stat(file).catch(() => null);
			if (info && Date.now() - info.mtimeMs > STALE_PART_MS) {
				await rm(file, { force: true });
			}
		}
	}

	private get dir(): string {
		return join(this.options.root(), "loras");
	}

	/** The file the engine reads for a LoRA. */
	path(id: string): string {
		if (!ID.test(id)) throw new NotFoundError("LoRA not found", "loraMissing");
		return join(this.dir, `${id}.safetensors`);
	}

	private notes(id: string): string {
		return join(this.dir, `${id}.json`);
	}

	async list(): Promise<LoraInfo[]> {
		const names = await readdir(this.dir).catch(() => [] as string[]);
		const loras: LoraInfo[] = [];
		for (const name of names) {
			const id = name.replace(/\.json$/, "");
			if (id === name || !ID.test(id)) continue;
			const info = await this.read(id);
			if (info) loras.push(info);
		}
		return loras.sort((a, b) => b.addedAt - a.addedAt);
	}

	/** A LoRA's notes, when its file is there too. */
	async get(id: string): Promise<LoraInfo> {
		const info = ID.test(id) ? await this.read(id) : null;
		if (!info) {
			throw new NotFoundError("LoRA not found", "loraMissing", { id });
		}
		return info;
	}

	private async read(id: string): Promise<LoraInfo | null> {
		const file = await stat(this.path(id)).catch(() => null);
		if (!file?.isFile()) return null;
		const notes = await Bun.file(this.notes(id))
			.json()
			.catch(() => null);
		if (!notes || typeof notes !== "object") return null;
		const { name, base, trigger, addedAt } = notes as Partial<LoraInfo>;
		if (typeof name !== "string" || !LORA_BASES.includes(base as LoraBase)) {
			return null;
		}
		return {
			id,
			name,
			base: base as LoraBase,
			trigger: typeof trigger === "string" ? trigger : null,
			size: file.size,
			addedAt: typeof addedAt === "number" ? addedAt : file.mtimeMs,
		};
	}

	/**
	 * Keeps a LoRA, read from `body`. It is written beside the others first
	 * and kept only once it reads as a LoRA for a known family.
	 */
	async add(
		body: ReadableStream<Uint8Array> | Blob,
		fileName: string,
	): Promise<LoraInfo> {
		this.options.check?.();
		await this.sweep();
		this.uploads++;
		const dir = this.dir;
		await mkdir(dir, { recursive: true }).catch((error) => {
			this.uploads--;
			throw error;
		});
		const part = join(dir, `${crypto.randomUUID()}.part`);
		try {
			const written = await Bun.write(part, new Response(body));
			if (written > MAX_LORA_BYTES) {
				throw new ValidationError(
					"This file is too large to be a LoRA",
					"loraTooLarge",
				);
			}
			const header = await readSafetensorsHeader(Bun.file(part));
			const base = loraBaseOf(header);
			if (!base) {
				throw new ValidationError(
					"This file does not look like a LoRA for a model open-reel knows",
					"loraUnknownBase",
				);
			}
			const name = nameOf(header.metadata, fileName);
			const trigger = triggerOf(header.metadata);
			const keep = async (): Promise<LoraInfo> => {
				const existing = new Set(
					(await readdir(dir).catch(() => [] as string[])).map((n) =>
						n.replace(/\.(safetensors|json)$/, ""),
					),
				);
				const id = loraId(name, (candidate) => existing.has(candidate));
				const info: LoraInfo = {
					id,
					name,
					base,
					trigger,
					size: written,
					addedAt: Date.now(),
				};
				const { id: _, size: __, ...notes } = info;
				const notesFile = join(dir, `${id}.json`);
				await Bun.write(notesFile, JSON.stringify(notes, null, "\t"));
				try {
					await rename(part, join(dir, `${id}.safetensors`));
				} catch (error) {
					await rm(notesFile, { force: true });
					throw error;
				}
				return info;
			};
			const kept = this.naming.then(keep, keep);
			this.naming = kept.catch(() => {});
			const info = await kept;
			this.options.changed?.();
			return info;
		} finally {
			this.uploads--;
			await rm(part, { force: true });
		}
	}

	async remove(id: string): Promise<void> {
		this.options.check?.();
		await this.get(id);
		// The file goes first: notes without a file are not listed.
		await rm(this.path(id), { force: true });
		await rm(this.notes(id), { force: true });
		this.options.changed?.();
	}
}
