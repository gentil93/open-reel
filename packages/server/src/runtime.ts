import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	FakeProvider,
	FileKeyStore,
	FsAssetStore,
	JobEngine,
	type ProviderAdapter,
	ProviderRegistry,
	ReelService,
	SqliteRepository,
} from "@open-reel/core";
import { builtinProviders } from "@open-reel/providers";

export interface Runtime {
	service: ReelService;
	engine: JobEngine;
	/** Resumes jobs left unfinished by a previous process. */
	start(): Promise<void>;
	close(): void;
}

/** Another open-reel process is already using the data directory. */
export class DataDirInUseError extends Error {}

/**
 * Two processes on one data directory would each run the other's jobs, so the
 * directory is claimed with a lock file holding the owner's process id.
 */
function lockDataDir(dataDir: string): () => void {
	const path = join(dataDir, "open-reel.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx" });
			return () => rmSync(path, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = Number(readFileSync(path, "utf8"));
			if (isRunning(owner)) {
				throw new DataDirInUseError(
					`open-reel is already running on this data directory (process ${owner})`,
				);
			}
			rmSync(path, { force: true }); // left behind by a process that died
		}
	}
	throw new DataDirInUseError("Could not lock the data directory");
}

function isRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface RuntimeOptions {
	dataDir: string;
	/** Defaults to the built-in providers. */
	providers?: ProviderAdapter[];
}

/** Wires the core on a data directory. Call `start()` once ready to run jobs. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
	const providers = options.providers ?? builtinProviders();
	if (process.env.OPEN_REEL_FAKE === "1") {
		const fake = new FakeProvider();
		fake.delayMs = 1500;
		providers.push(fake);
	}
	const registry = new ProviderRegistry();
	for (const provider of providers) registry.register(provider);

	// Generated images and keys are private to the owner.
	await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
	const unlock = lockDataDir(options.dataDir);
	const repo = new SqliteRepository(join(options.dataDir, "open-reel.sqlite"));
	const assets = new FsAssetStore(join(options.dataDir, "assets"));
	const keys = new FileKeyStore(join(options.dataDir, "auth.json"));
	const engine = new JobEngine({ repo, assets, registry, keys });
	const service = new ReelService({ repo, assets, registry, keys, engine });
	return {
		service,
		engine,
		start: () => engine.start(),
		close: () => {
			repo.close();
			unlock();
		},
	};
}
