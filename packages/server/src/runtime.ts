import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	FakeProvider,
	FileKeyStore,
	FileSettingsStore,
	FsAssetStore,
	type Hardware,
	improvePrompt,
	JobEngine,
	type LanguageModel,
	type LocalEngineSpec,
	type LocalModelSpec,
	LocalModelStore,
	LocalProvider,
	LocalTranslator,
	type ProviderAdapter,
	ProviderRegistry,
	promptStyle,
	ReelService,
	type SettingsStore,
	SqliteRepository,
	type UserContext,
	ValidationError,
	writerChoice,
} from "@open-reel/core";
import {
	builtinEngines,
	builtinLocalModels,
	builtinProviders,
	CloudTranslator,
	type CloudTranslatorId,
} from "@open-reel/providers";

export interface Runtime {
	service: ReelService;
	engine: JobEngine;
	models: LocalModelStore;
	settings: SettingsStore;
	/** Whether the prompt translator on this computer is installed. */
	translatorReady(): boolean;
	/** A richer prompt for a short idea, written for the models named. */
	improvePrompt(
		ctx: UserContext,
		request: ImproveRequest,
		signal: AbortSignal,
	): Promise<string>;
	/** Starts moving the local models to another folder. */
	moveModels(path: string): Promise<void>;
	/** Resumes jobs left unfinished by a previous process. */
	start(): Promise<void>;
	close(): void;
}

export interface ImproveRequest {
	prompt: string;
	/** The models the prompt is for; unknown ones are left out. */
	modelIds: string[];
	/** The person is changing a picture they gave. */
	editing: boolean;
	/** The language the person reads, e.g. "pt-BR", to write the prompt in. */
	language?: string;
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
	/** Where models and engines go. Defaults to `models` in the data directory. */
	modelsDir?: string;
	/**
	 * Where another models folder, chosen in the app, is written down.
	 * Without it the folder cannot be changed from the app.
	 */
	modelsLocationFile?: string;
	/** Defaults to the built-in providers. */
	providers?: ProviderAdapter[];
	/** Models that can be downloaded. Defaults to the built-in catalog. */
	localModels?: LocalModelSpec[];
	/** Engines that run them. Defaults to the built-in ones. */
	engines?: LocalEngineSpec[];
	/** Defaults to looking at this machine. */
	hardware?: () => Promise<Hardware>;
	/** Used to download models and their demos. */
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** Database migrations. Defaults to the ones in the source tree. */
	migrationsDir?: string;
	/** Tries a freshly installed engine. Defaults to running it. */
	checkEngine?: (executable: string) => Promise<string | null>;
}

/** Wires the core on a data directory. Call `start()` once ready to run jobs. */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
	const providers = options.providers ?? builtinProviders();
	if (process.env.OPEN_REEL_FAKE === "1") {
		const fake = new FakeProvider();
		fake.delayMs = 1500;
		providers.push(fake);
	}
	const catalog = options.localModels ?? builtinLocalModels();
	const models = new LocalModelStore({
		root: options.modelsDir ?? join(options.dataDir, "models"),
		catalog,
		engines: options.engines ?? builtinEngines(),
		fetch: options.fetch,
		hardware: options.hardware,
		checkEngine: options.checkEngine,
		locationFile: options.modelsLocationFile,
	});
	// Installed local models are offered next to the remote ones.
	const local = new LocalProvider({ store: models, catalog });
	await local.load();
	const registry = new ProviderRegistry();
	for (const provider of [...providers, local]) registry.register(provider);
	local.onChange = () => registry.refresh(local.id);

	// Generated images and keys are private to the owner.
	await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
	const unlock = lockDataDir(options.dataDir);
	const repo = new SqliteRepository(
		join(options.dataDir, "open-reel.sqlite"),
		options.migrationsDir,
	);
	const assets = new FsAssetStore(join(options.dataDir, "assets"));
	const keys = new FileKeyStore(join(options.dataDir, "auth.json"));
	// Puts prompts into English for the models that read only English, once
	// its model is installed.
	const translatorModel = catalog.find((m) =>
		m.tasks.includes("prompt-translation"),
	);
	const translator = new LocalTranslator({
		store: models,
		model: translatorModel?.id ?? "",
	});
	let translatorReady = translatorModel ? await translator.ready() : false;
	// Checks overlap (an install says it changed several times); only the
	// latest one counts.
	let check = 0;
	models.subscribe((event) => {
		if (event.type !== "models.changed") return;
		const mine = ++check;
		void translator.ready().then((ready) => {
			if (mine !== check) return;
			translatorReady = ready;
			if (!ready) translator.stop();
		});
	});
	// Models kept loaded let go of their files before files are deleted or
	// moved: Windows does neither to an open file.
	models.onLetGo(() => local.unloadIdle());
	models.onLetGo(() => translator.stopAndWait());
	const settings = new FileSettingsStore(
		join(options.dataDir, "settings.json"),
	);
	// One per service and key, so the jobs of a turn share a translation.
	const clouds = new Map<string, CloudTranslator>();
	const cloudFor = async (
		ctx: UserContext,
		service: CloudTranslatorId,
	): Promise<CloudTranslator | null> => {
		const adapter = registry.adapter(service);
		const key =
			(await keys.get(ctx, service)) ??
			(adapter?.keyEnv ? process.env[adapter.keyEnv] : undefined);
		if (!key) return null;
		const id = `${service}:${key}`;
		let cloud = clouds.get(id);
		if (!cloud) {
			cloud = new CloudTranslator(service, key, options.fetch);
			clouds.set(id, cloud);
		}
		return cloud;
	};
	const translatorFor = async (userId: string) => {
		const ctx = { userId };
		const { translateWith } = await settings.get(ctx);
		if (translateWith === "off") return null;
		if (translateWith === "local") return translatorReady ? translator : null;
		return cloudFor(ctx, translateWith);
	};
	const writerFor = async (ctx: UserContext): Promise<LanguageModel | null> => {
		const services = ["openai", "google", "openrouter"] as const;
		const reachable = new Set<CloudTranslatorId>();
		for (const service of services) {
			if (await cloudFor(ctx, service)) reachable.add(service);
		}
		const choice = writerChoice(
			await settings.get(ctx),
			translatorReady,
			(service) => reachable.has(service),
		);
		if (choice === "local") return translator;
		return choice ? cloudFor(ctx, choice) : null;
	};
	const engine = new JobEngine({
		repo,
		assets,
		registry,
		keys,
		translator: translatorFor,
	});
	const service = new ReelService({ repo, assets, registry, keys, engine });
	return {
		service,
		engine,
		models,
		settings,
		translatorReady: () => translatorReady,
		improvePrompt: async (ctx, request, signal) => {
			const writer = await writerFor(ctx);
			if (!writer) {
				throw new ValidationError(
					"No language model to write with: install the one for this computer or add a key",
					"noLanguageModel",
				);
			}
			const byId = new Map(service.listModels().map((m) => [m.id, m]));
			const models = request.modelIds.flatMap((id) => byId.get(id) ?? []);
			return improvePrompt(
				writer,
				request.prompt,
				promptStyle(models, request.editing, request.language),
				signal,
			);
		},
		moveModels: (path) => models.relocate(path),
		start: () => engine.start(),
		close: () => {
			// Downloads stop with the process; what they fetched is resumed later.
			void models.close();
			local.close();
			translator.stop();
			repo.close();
			unlock();
		},
	};
}
