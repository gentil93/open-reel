import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UserContext } from "./types";

export interface StoredBlob {
	hash: string;
	size: number;
}

export interface AssetStore {
	put(ctx: UserContext, data: Uint8Array): Promise<StoredBlob>;
	get(ctx: UserContext, hash: string): Promise<Blob | null>;
}

/** Content-addressed files on disk: `<root>/<userId>/<hash[0..2]>/<hash>`. */
export class FsAssetStore implements AssetStore {
	constructor(private root: string) {}

	private path(ctx: UserContext, hash: string): string {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid asset hash");
		if (!/^[\w-]+$/.test(ctx.userId)) throw new Error("Invalid user id");
		return join(this.root, ctx.userId, hash.slice(0, 2), hash);
	}

	async put(ctx: UserContext, data: Uint8Array): Promise<StoredBlob> {
		const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
		const path = this.path(ctx, hash);
		if (!(await Bun.file(path).exists())) {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${crypto.randomUUID()}.tmp`;
			await Bun.write(tmp, data);
			await rename(tmp, path);
		}
		return { hash, size: data.byteLength };
	}

	async get(ctx: UserContext, hash: string): Promise<Blob | null> {
		const file = Bun.file(this.path(ctx, hash));
		return (await file.exists()) ? file : null;
	}
}
