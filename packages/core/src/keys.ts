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
		return (await this.read())[ctx.userId]?.[providerId];
	}

	async set(ctx: UserContext, providerId: string, key: string) {
		await this.change((data) => {
			data[ctx.userId] = { ...data[ctx.userId], [providerId]: key };
		});
	}

	async delete(ctx: UserContext, providerId: string) {
		await this.change((data) => {
			delete data[ctx.userId]?.[providerId];
		});
	}

	async list(ctx: UserContext) {
		return Object.keys((await this.read())[ctx.userId] ?? {});
	}
}
