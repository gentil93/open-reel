import {
	mkdir,
	open,
	readdir,
	rename,
	rm,
	stat,
	statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../errors";
import { sniffMime } from "../mime";
import type {
	LocalModelEvent,
	LocalModelFile,
	LocalModelSpec,
	LocalModelState,
	LocalModelStatus,
	LocalModelsView,
} from "../types";

const MAX_DEMO_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type LocalModelListener = (event: LocalModelEvent) => void;

export interface LocalModelStoreOptions {
	/** Directory the models are kept in. */
	root: string;
	catalog: LocalModelSpec[];
	fetch?: Fetch;
}

interface Install {
	state: Exclude<LocalModelState, "available" | "installed">;
	controller: AbortController;
	/** Bytes of the file being downloaded that are on disk so far. */
	current: { sha256: string; bytes: number } | null;
	startedAt: number;
	/** Bytes received by this install, for the download speed. */
	transferred: number;
	lastProgress: number;
}

/** Sizes in the decimal units disks and download pages use. */
export function formatBytes(bytes: number): string {
	if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
	if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
	return `${(bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1)} GB`;
}

function assertCatalog(catalog: LocalModelSpec[]): void {
	const ids = new Set<string>();
	const sizes = new Map<string, number>();
	const https = (url: string) => {
		if (!url.startsWith("https://"))
			throw new Error(`Not an HTTPS URL: ${url}`);
	};
	for (const model of catalog) {
		if (!/^[a-z0-9][a-z0-9.-]*$/.test(model.id) || ids.has(model.id)) {
			throw new Error(`Invalid or repeated local model id: ${model.id}`);
		}
		ids.add(model.id);
		if (model.files.length === 0) {
			throw new Error(`Local model without files: ${model.id}`);
		}
		const names = new Set(model.files.map((file) => file.name));
		if (names.size !== model.files.length) {
			throw new Error(`Repeated file name in local model: ${model.id}`);
		}
		for (const file of model.files) {
			https(file.url);
			if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
				throw new Error(`Invalid hash for ${file.name} of ${model.id}`);
			}
			if (!Number.isInteger(file.size) || file.size <= 0) {
				throw new Error(`Invalid size for ${file.name} of ${model.id}`);
			}
			if ((sizes.get(file.sha256) ?? file.size) !== file.size) {
				throw new Error(`One hash, two sizes: ${file.name} of ${model.id}`);
			}
			sizes.set(file.sha256, file.size);
		}
		for (const demo of model.demos) https(demo.url);
	}
}

const sizeOf = (path: string) =>
	stat(path).then(
		(info) => info.size,
		() => 0,
	);

/**
 * Downloads, keeps and deletes the models that run on this machine.
 *
 * Files are stored once under their hash, so models that share a file (a text
 * encoder, a VAE) share its space on disk:
 *
 *   <root>/blobs/<sha256>        a complete, verified file
 *   <root>/blobs/<sha256>.part   a download in progress, kept to resume it
 *   <root>/installed/<id>        marks a model as installed
 *   <root>/demos/<sha256(url)>   a downloaded demo
 */
export class LocalModelStore {
	private root: string;
	private catalog: LocalModelSpec[];
	private fetch: Fetch;
	private listeners = new Set<LocalModelListener>();
	private installs = new Map<string, Install>();
	private errors = new Map<string, string>();
	private demos = new Map<string, Promise<string>>();
	/** One download at a time: they all compete for the same connection. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: LocalModelStoreOptions) {
		assertCatalog(options.catalog);
		this.root = options.root;
		this.catalog = options.catalog;
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	subscribe(listener: LocalModelListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: LocalModelEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("A local model listener failed", error);
			}
		}
	}

	private spec(id: string): LocalModelSpec {
		const model = this.catalog.find((m) => m.id === id);
		if (!model) throw new NotFoundError(`Unknown local model: ${id}`);
		return model;
	}

	private blob(sha256: string): string {
		return join(this.root, "blobs", sha256);
	}

	private marker(id: string): string {
		return join(this.root, "installed", id);
	}

	private async installedIds(): Promise<Set<string>> {
		const names = await readdir(join(this.root, "installed")).catch(() => []);
		return new Set(names);
	}

	/** Bytes on disk per hash: complete files, and what interrupted ones have. */
	private async onDisk(): Promise<{
		complete: Set<string>;
		partial: Map<string, number>;
	}> {
		const complete = new Set<string>();
		const partial = new Map<string, number>();
		const dir = join(this.root, "blobs");
		for (const name of await readdir(dir).catch(() => [])) {
			if (/^[a-f0-9]{64}$/.test(name)) complete.add(name);
			else if (/^[a-f0-9]{64}\.part$/.test(name)) {
				partial.set(name.slice(0, 64), await sizeOf(join(dir, name)));
			}
		}
		return { complete, partial };
	}

	async list(): Promise<LocalModelsView> {
		const [installed, disk] = await Promise.all([
			this.installedIds(),
			this.onDisk(),
		]);
		const held = (file: LocalModelFile, id: string) => {
			if (disk.complete.has(file.sha256)) return file.size;
			const current = this.installs.get(id)?.current;
			if (current?.sha256 === file.sha256) return current.bytes;
			return Math.min(disk.partial.get(file.sha256) ?? 0, file.size);
		};
		/** Hashes that models other than `id`, installed or installing, need. */
		const neededByOthers = (id: string) =>
			new Set(
				this.catalog
					.filter(
						(m) =>
							m.id !== id && (installed.has(m.id) || this.installs.has(m.id)),
					)
					.flatMap((m) => m.files.map((file) => file.sha256)),
			);

		const models = this.catalog.map((model): LocalModelStatus => {
			const { files, demos, ...rest } = model;
			const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
			const others = neededByOthers(model.id);
			const error = this.errors.get(model.id);
			return {
				...rest,
				state:
					this.installs.get(model.id)?.state ??
					(installed.has(model.id) ? "installed" : "available"),
				files: files.map((file) => ({
					name: file.name,
					size: file.size,
					present: disk.complete.has(file.sha256),
				})),
				demos: demos.map(({ url: _, ...demo }) => demo),
				size: unique.reduce((sum, file) => sum + file.size, 0),
				receivedBytes: unique.reduce(
					(sum, file) => sum + held(file, model.id),
					0,
				),
				reclaimableBytes: unique
					.filter((file) => !others.has(file.sha256))
					.reduce((sum, file) => sum + held(file, model.id), 0),
				...(error && { error }),
			};
		});

		const sizes = new Map(
			this.catalog.flatMap((m) => m.files.map((f) => [f.sha256, f.size])),
		);
		let usedBytes = 0;
		for (const hash of disk.complete) {
			usedBytes += sizes.get(hash) ?? (await sizeOf(this.blob(hash)));
		}
		for (const bytes of disk.partial.values()) usedBytes += bytes;
		return {
			models,
			disk: { path: this.root, freeBytes: await this.freeBytes(), usedBytes },
		};
	}

	private async freeBytes(): Promise<number> {
		await mkdir(this.root, { recursive: true });
		const info = await statfs(this.root);
		return info.bavail * info.bsize;
	}

	/** Where an installed model's files are, by file name. */
	async files(id: string): Promise<Record<string, string>> {
		const model = this.spec(id);
		if (!(await this.installedIds()).has(id)) {
			throw new ValidationError(`${model.name} is not installed`);
		}
		return Object.fromEntries(
			model.files.map((file) => [file.name, this.blob(file.sha256)]),
		);
	}

	/** Starts downloading a model. Progress and the outcome arrive as events. */
	async install(id: string): Promise<void> {
		const model = this.spec(id);
		if (this.installs.has(id)) return;
		const view = await this.list();
		const status = view.models.find((m) => m.id === id) as LocalModelStatus;
		if (status.state === "installed") return;
		// Other installs waiting in line will need their space too.
		const pending = view.models
			.filter((m) => m.id === id || this.installs.has(m.id))
			.reduce((sum, m) => sum + m.size - m.receivedBytes, 0);
		if (pending > view.disk.freeBytes) {
			throw new ValidationError(
				`Not enough disk space: ${formatBytes(pending)} to download, ${formatBytes(view.disk.freeBytes)} free`,
			);
		}

		const install: Install = {
			state: "queued",
			controller: new AbortController(),
			current: null,
			startedAt: 0,
			transferred: 0,
			lastProgress: 0,
		};
		this.installs.set(id, install);
		this.errors.delete(id);
		this.emit({ type: "models.changed" });

		const run = async () => {
			if (this.installs.get(id) !== install) return; // canceled while waiting
			try {
				install.state = "downloading";
				install.startedAt = Date.now();
				this.emit({ type: "models.changed" });
				for (const file of model.files) {
					await this.download(model, file, install);
				}
				await mkdir(join(this.root, "installed"), { recursive: true });
				await Bun.write(this.marker(id), "");
			} catch (error) {
				if (!install.controller.signal.aborted) {
					this.errors.set(
						id,
						error instanceof Error ? error.message : String(error),
					);
				}
			} finally {
				this.installs.delete(id);
				this.emit({ type: "models.changed" });
			}
		};
		this.queue = this.queue.then(run);
	}

	private progress(
		model: LocalModelSpec,
		install: Install,
		force = false,
	): void {
		const now = Date.now();
		if (!force && now - install.lastProgress < PROGRESS_INTERVAL_MS) return;
		install.lastProgress = now;
		void this.list().then((view) => {
			const status = view.models.find((m) => m.id === model.id);
			if (!status || !this.installs.has(model.id)) return;
			const seconds = Math.max((now - install.startedAt) / 1000, 0.001);
			this.emit({
				type: "model.progress",
				id: model.id,
				state: install.state,
				receivedBytes: status.receivedBytes,
				size: status.size,
				bytesPerSecond: Math.round(install.transferred / seconds),
			});
		});
	}

	private async download(
		model: LocalModelSpec,
		file: LocalModelFile,
		install: Install,
	): Promise<void> {
		const { signal } = install.controller;
		const path = this.blob(file.sha256);
		if (await Bun.file(path).exists()) return;
		await mkdir(join(this.root, "blobs"), { recursive: true });
		const part = `${path}.part`;

		let have = await sizeOf(part);
		if (have > file.size) {
			await rm(part, { force: true });
			have = 0;
		}
		install.state = "downloading";
		install.current = { sha256: file.sha256, bytes: have };

		if (have < file.size) {
			const response = await this.fetch(file.url, {
				headers: have > 0 ? { range: `bytes=${have}-` } : {},
				signal,
			});
			if (!response.ok || !response.body) {
				throw new Error(
					`Could not download ${file.name} (HTTP ${response.status})`,
				);
			}
			// A server that ignores the range sends the file from the start.
			const resumed = response.status === 206;
			if (!resumed) install.current.bytes = 0;
			const out = await open(part, resumed ? "a" : "w");
			try {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					if (install.current.bytes + chunk.byteLength > file.size) {
						throw new Error(`${file.name} is larger than expected`);
					}
					await out.write(chunk);
					install.current.bytes += chunk.byteLength;
					install.transferred += chunk.byteLength;
					this.progress(model, install);
				}
			} finally {
				await out.close();
			}
			signal.throwIfAborted();
			if (install.current.bytes !== file.size) {
				throw new Error(`The download of ${file.name} was cut short`);
			}
		}

		install.state = "verifying";
		this.progress(model, install, true);
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const chunk of Bun.file(part).stream()) {
			signal.throwIfAborted();
			hasher.update(chunk);
		}
		if (hasher.digest("hex") !== file.sha256) {
			// Nothing of a file that fails the check is worth resuming.
			await rm(part, { force: true });
			throw new Error(`${file.name} did not match its expected hash`);
		}
		await rename(part, path);
		install.current = null;
	}

	/** Stops an install. What was downloaded is kept, to resume from. */
	async cancel(id: string): Promise<void> {
		this.spec(id);
		const install = this.installs.get(id);
		if (!install) return;
		install.controller.abort();
		if (install.state === "queued") {
			// Its turn has not come; do not wait for the downloads ahead of it.
			this.installs.delete(id);
			this.emit({ type: "models.changed" });
			return;
		}
		await this.settled(id);
	}

	private async settled(id: string): Promise<void> {
		while (this.installs.has(id)) {
			await new Promise<void>((resolve) => {
				const unsubscribe = this.subscribe((event) => {
					if (event.type !== "models.changed") return;
					unsubscribe();
					resolve();
				});
			});
		}
	}

	/**
	 * Deletes a model, installed or half downloaded. Files that another
	 * installed or installing model uses are kept.
	 */
	async remove(id: string): Promise<void> {
		const model = this.spec(id);
		await this.cancel(id);
		this.errors.delete(id);
		await rm(this.marker(id), { force: true });
		const installed = await this.installedIds();
		const needed = new Set(
			this.catalog
				.filter((m) => installed.has(m.id) || this.installs.has(m.id))
				.flatMap((m) => m.files.map((file) => file.sha256)),
		);
		for (const file of model.files) {
			if (needed.has(file.sha256)) continue;
			await rm(this.blob(file.sha256), { force: true });
			await rm(`${this.blob(file.sha256)}.part`, { force: true });
		}
		this.emit({ type: "models.changed" });
	}

	/** A model's demo, downloaded on first use and kept. */
	async demo(id: string, index: number): Promise<{ blob: Blob; mime: string }> {
		const demo = this.spec(id).demos[index];
		if (!demo) throw new NotFoundError("Demo not found");
		const name = new Bun.CryptoHasher("sha256").update(demo.url).digest("hex");
		const path = join(this.root, "demos", name);
		if (!(await Bun.file(path).exists())) {
			let pending = this.demos.get(name);
			if (!pending) {
				pending = this.fetchDemo(demo.url, path).finally(() =>
					this.demos.delete(name),
				);
				this.demos.set(name, pending);
			}
			await pending;
		}
		const blob = Bun.file(path);
		const mime = sniffMime(await blob.slice(0, 32).bytes());
		if (!mime) throw new Error("The stored demo is not an image or a video");
		return { blob, mime };
	}

	private async fetchDemo(url: string, path: string): Promise<string> {
		const response = await this.fetch(url, {
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) {
			throw new Error(`Could not download the demo (HTTP ${response.status})`);
		}
		if (Number(response.headers.get("content-length")) > MAX_DEMO_BYTES) {
			throw new Error("The demo is too large");
		}
		const data = await response.bytes();
		// It will be served from this origin, so it must be what it claims.
		if (data.byteLength > MAX_DEMO_BYTES || !sniffMime(data)) {
			throw new Error("The demo is not an image or a video");
		}
		await mkdir(join(this.root, "demos"), { recursive: true });
		const tmp = `${path}.${crypto.randomUUID()}.tmp`;
		await Bun.write(tmp, data);
		await rename(tmp, path);
		return path;
	}

	/** Resolves once no install is queued or running. */
	async idle(): Promise<void> {
		while (this.installs.size > 0) await this.queue;
	}

	/** Stops every install. Downloads are kept, to resume from. */
	async close(): Promise<void> {
		for (const install of this.installs.values()) install.controller.abort();
		await this.idle();
	}
}
