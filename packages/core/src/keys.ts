import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UserContext } from "./types";

export interface KeyStore {
	get(ctx: UserContext, providerId: string): Promise<string | undefined>;
	set(ctx: UserContext, providerId: string, key: string): Promise<void>;
	delete(ctx: UserContext, providerId: string): Promise<void>;
	/** Provider ids that have a stored key. Never returns the keys themselves. */
	list(ctx: UserContext): Promise<string[]>;
}

type KeyFile = Record<string, Record<string, string>>;

/** Names that would reach an object's prototype instead of a key of its own. */
function isPrototypeName(name: string): boolean {
	return name === "__proto__" || name === "constructor" || name === "prototype";
}

/** API keys in a JSON file readable only by the owner. */
export class FileKeyStore implements KeyStore {
	/** Serializes changes so concurrent ones cannot overwrite each other. */
	private pending: Promise<void> = Promise.resolve();

	constructor(private path: string) {}

	private change(mutate: (data: KeyFile) => void): Promise<void> {
		const next = this.pending.then(async () => {
			const data = await this.read();
			mutate(data);
			await this.write(data);
		});
		this.pending = next.catch(() => {});
		return next;
	}

	private async read(): Promise<KeyFile> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) return {};
		return (await file.json()) as KeyFile;
	}

	private async write(data: KeyFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		// Written aside and renamed, so a crash cannot leave a half-written file.
		const tmp = `${this.path}.${crypto.randomUUID()}.tmp`;
		// Created owner-only from the start, so the keys are never readable by others.
		await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
		await rename(tmp, this.path);
	}

	async get(ctx: UserContext, providerId: string) {
		const data = await this.read();
		if (!Object.hasOwn(data, ctx.userId)) return undefined;
		const keys = data[ctx.userId];
		return keys && Object.hasOwn(keys, providerId)
			? keys[providerId]
			: undefined;
	}

	async set(ctx: UserContext, providerId: string, key: string) {
		if (isPrototypeName(ctx.userId) || isPrototypeName(providerId)) {
			throw new Error(`Not a provider: ${providerId}`);
		}
		await this.change((data) => {
			data[ctx.userId] = { ...data[ctx.userId], [providerId]: key };
		});
	}

	async delete(ctx: UserContext, providerId: string) {
		if (isPrototypeName(ctx.userId) || isPrototypeName(providerId)) return;
		await this.change((data) => {
			if (!Object.hasOwn(data, ctx.userId)) return;
			const keys = data[ctx.userId];
			if (keys && Object.hasOwn(keys, providerId)) delete keys[providerId];
		});
	}

	async list(ctx: UserContext) {
		const data = await this.read();
		return Object.hasOwn(data, ctx.userId)
			? Object.keys(data[ctx.userId] ?? {})
			: [];
	}
}
