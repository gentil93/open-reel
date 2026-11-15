import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeProvider,
	FileKeyStore,
	FsAssetStore,
	JobEngine,
	LOCAL_USER,
	ProviderRegistry,
	ReelService,
	SqliteRepository,
	ValidationError,
} from "./index";

const dirs: string[] = [];
/** The PNG signature plus one byte: enough to pass as an uploaded image. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "open-reel-"));
	dirs.push(dir);
	return dir;
}

/** Builds the whole core on `dir`, as a fresh process would. */
function boot(dir: string, provider = new FakeProvider(), concurrency = 4) {
	const repo = new SqliteRepository(join(dir, "db.sqlite"));
	const assets = new FsAssetStore(join(dir, "assets"));
	const keys = new FileKeyStore(join(dir, "auth.json"));
	const registry = new ProviderRegistry().register(provider);
	const engine = new JobEngine({
		repo,
		assets,
		registry,
		keys,
		concurrencyPerProvider: concurrency,
	});
	const service = new ReelService({ repo, assets, registry, keys, engine });
	return { repo, assets, keys, engine, service, provider };
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Lets queued engine work reach its next await point. */
const settle = () => Bun.sleep(20);

describe("turns", () => {
	test("one prompt on two models yields one finished job per model", async () => {
		const app = boot(await tempDir());
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha", "fake/beta"],
			count: 2,
		});
		await app.engine.idle();

		const { turns, title } = await app.service.getSession(
			LOCAL_USER,
			session.id,
		);
		expect(title).toBe("a red fox");
		expect(turns).toHaveLength(1);
		const jobs = turns[0]?.jobs ?? [];
		expect(jobs.map((j) => j.modelId)).toEqual(["fake/alpha", "fake/beta"]);
		for (const job of jobs) {
			expect(job.status).toBe("succeeded");
			expect(job.assets).toHaveLength(2);
			expect(job.costUsd).toBeCloseTo(0.02);
		}

		const assetId = jobs[0]?.assets[0]?.id as string;
		const file = await app.service.getAssetFile(LOCAL_USER, assetId);
		expect(file.asset.mime).toBe("image/bmp");
		expect(file.blob.size).toBeGreaterThan(0);
	});

	test("a chosen output becomes the reference of the next turn", async () => {
		const app = boot(await tempDir());
		const first = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const session = await app.service.getSession(LOCAL_USER, first.session.id);
		const chosen = session.turns[0]?.jobs[0]?.assets[0]?.id as string;

		await app.service.createTurn(LOCAL_USER, {
			sessionId: session.id,
			prompt: "make it snow",
			modelIds: ["fake/alpha"],
			referenceAssetIds: [chosen],
		});
		await app.engine.idle();

		const after = await app.service.getSession(LOCAL_USER, session.id);
		expect(after.turns).toHaveLength(2);
		expect(after.turns[1]?.referenceAssetIds).toEqual([chosen]);
		expect(after.turns[1]?.jobs[0]?.status).toBe("succeeded");
	});

	test("parameters are fitted to each model", async () => {
		const app = boot(await tempDir());
		const { turn } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
			count: 5,
			aspectRatio: "9:21",
		});
		expect(turn.jobs[0]?.params.count).toBe(2);
		expect(turn.jobs[0]?.params.aspectRatio).toBeUndefined();
		await app.engine.idle();
	});

	test("rejects references for a model that cannot take them", async () => {
		const app = boot(await tempDir());
		const upload = await app.service.uploadAsset(LOCAL_USER, PNG);
		expect(
			app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds: ["fake/alpha", "fake/beta"],
				referenceAssetIds: [upload.id],
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(await app.service.listSessions(LOCAL_USER)).toHaveLength(0);
	});

	test("rejects unknown models and empty prompts", async () => {
		const app = boot(await tempDir());
		expect(
			app.service.createTurn(LOCAL_USER, { prompt: "x", modelIds: ["nope/x"] }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(
			app.service.createTurn(LOCAL_USER, {
				prompt: "  ",
				modelIds: ["fake/alpha"],
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("job engine", () => {
	test("a provider failure fails only that job, with its message", async () => {
		const app = boot(await tempDir());
		app.provider.failWith = "content policy";
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toBe("content policy");
		expect(job?.assets).toHaveLength(0);
	});

	test("canceling a running job stops it and tells the provider", async () => {
		const app = boot(await tempDir());
		app.provider.gate = gate().promise;
		const { turn, session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await settle();
		await app.service.cancelJob(LOCAL_USER, turn.jobs[0]?.id as string);
		await app.engine.idle();

		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("canceled");
		expect(app.provider.canceled).toHaveLength(1);
	});

	test("runs at most the configured number of jobs per provider", async () => {
		const app = boot(await tempDir(), new FakeProvider(), 1);
		const g = gate();
		app.provider.gate = g.promise;
		const { turn, session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		await settle();

		const during = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		expect(during?.map((j) => j.status)).toEqual(["running", "queued"]);

		// A job still waiting for a slot can be canceled too.
		await app.service.cancelJob(LOCAL_USER, turn.jobs[1]?.id as string);
		g.open();
		await app.engine.idle();
		const after = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		expect(after?.map((j) => j.status)).toEqual(["succeeded", "canceled"]);
		expect(app.provider.submitted).toHaveLength(1);
	});

	test("reports progress and status changes to listeners", async () => {
		const app = boot(await tempDir());
		const seen: string[] = [];
		app.engine.subscribe((userId, event) => {
			expect(userId).toBe(LOCAL_USER.userId);
			seen.push(event.type === "job.updated" ? event.job.status : "progress");
		});
		await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		expect(seen).toEqual(["running", "progress", "succeeded"]);
	});

	test("fails a job whose provider needs a key that is not configured", async () => {
		const provider = new FakeProvider();
		provider.requiresKey = true;
		const app = boot(await tempDir(), provider);
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toContain("No API key");

		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		await app.service.createTurn(LOCAL_USER, {
			sessionId: session.id,
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const retried = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[1]?.jobs[0];
		expect(retried?.status).toBe("succeeded");
	});
});

describe("job engine hardening", () => {
	test("a listener that throws does not change the job's outcome", async () => {
		const app = boot(await tempDir());
		app.engine.subscribe(() => {
			throw new Error("listener bug");
		});
		const error = console.error;
		console.error = () => {};
		try {
			const { session } = await app.service.createTurn(LOCAL_USER, {
				prompt: "x",
				modelIds: ["fake/alpha"],
			});
			await app.engine.idle();
			const job = (await app.service.getSession(LOCAL_USER, session.id))
				.turns[0]?.jobs[0];
			expect(job?.status).toBe("succeeded");
			expect(job?.error).toBeNull();
		} finally {
			console.error = error;
		}
	});

	test("refuses a result URL that is not HTTPS", async () => {
		const dir = await tempDir();
		const app = boot(dir);
		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		app.provider.outputUrl = `file://${join(dir, "auth.json")}`;
		const { session } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const job = (await app.service.getSession(LOCAL_USER, session.id)).turns[0]
			?.jobs[0];
		expect(job?.status).toBe("failed");
		expect(job?.error).toContain("not HTTPS");
		expect(job?.assets).toHaveLength(0);
	});
});

describe("restart", () => {
	async function interrupted(resumable: boolean) {
		const dir = await tempDir();
		const provider = new FakeProvider();
		provider.resumable = resumable;
		const before = boot(dir, provider, 1);
		provider.gate = new Promise(() => {});
		const { session } = await before.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha", "fake/beta"],
		});
		await settle();
		before.repo.close(); // the process dies with one job running, one queued

		const next = new FakeProvider();
		next.resumable = resumable;
		const after = boot(dir, next, 1);
		await after.engine.start();
		await after.engine.idle();
		const jobs = (await after.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs;
		return { jobs, provider: next };
	}

	test("a job interrupted mid-run fails; a queued one runs", async () => {
		const { jobs, provider } = await interrupted(false);
		expect(jobs?.map((j) => j.status)).toEqual(["failed", "succeeded"]);
		expect(jobs?.[0]?.error).toBe("Interrupted by a restart");
		expect(provider.submitted).toHaveLength(1);
	});

	test("a resumable provider re-attaches without submitting again", async () => {
		const { jobs, provider } = await interrupted(true);
		expect(jobs?.map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
		expect(provider.submitted).toHaveLength(1);
	});
});

describe("storage", () => {
	test("keys are stored owner-only and never listed by value", async () => {
		const dir = await tempDir();
		const app = boot(dir);
		await app.service.setProviderKey(LOCAL_USER, "fake", "secret");
		const mode = (await stat(join(dir, "auth.json"))).mode & 0o777;
		expect(mode).toBe(0o600);
		const providers = await app.service.listProviders(LOCAL_USER);
		expect(providers).toEqual([
			{ id: "fake", name: "Fake (fake)", requiresKey: false, hasKey: true },
		]);
		await app.service.deleteProviderKey(LOCAL_USER, "fake");
		expect((await app.service.listProviders(LOCAL_USER))[0]?.hasKey).toBe(
			false,
		);
	});

	test("the gallery is searchable by prompt and survives session deletion", async () => {
		const app = boot(await tempDir());
		const fox = await app.service.createTurn(LOCAL_USER, {
			prompt: "a red fox",
			modelIds: ["fake/alpha"],
		});
		await app.service.createTurn(LOCAL_USER, {
			prompt: "100% wool",
			modelIds: ["fake/alpha"],
		});
		await app.service.uploadAsset(LOCAL_USER, PNG);
		await app.engine.idle();

		const all = await app.service.listGallery(LOCAL_USER, { limit: 10 });
		expect(all).toHaveLength(2);
		const found = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "fox",
		});
		expect(found.map((i) => i.prompt)).toEqual(["a red fox"]);
		const literal = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "0%",
		});
		expect(literal.map((i) => i.prompt)).toEqual(["100% wool"]);

		await app.service.deleteSession(LOCAL_USER, fox.session.id);
		expect(await app.service.listSessions(LOCAL_USER)).toHaveLength(1);
		// The image keeps what produced it, so it stays searchable.
		const kept = await app.service.listGallery(LOCAL_USER, {
			limit: 10,
			query: "fox",
		});
		expect(kept.map((i) => [i.prompt, i.modelId, i.jobId])).toEqual([
			["a red fox", "fake/alpha", null],
		]);
		expect(
			await app.service.listGallery(LOCAL_USER, { limit: 10 }),
		).toHaveLength(2);
	});

	test("gallery pages do not skip images created in the same millisecond", async () => {
		const app = boot(await tempDir());
		const times = { a: 3, b: 2, c: 2, d: 1 };
		for (const [id, createdAt] of Object.entries(times)) {
			await app.repo.createAsset({
				id,
				userId: LOCAL_USER.userId,
				kind: "output",
				jobId: null,
				hash: "0".repeat(64),
				mime: "image/png",
				size: 1,
				prompt: null,
				modelId: null,
				params: null,
				createdAt,
			});
		}
		const seen: string[] = [];
		let before: { createdAt: number; id: string } | undefined;
		for (;;) {
			const page = await app.service.listGallery(LOCAL_USER, {
				limit: 2,
				before,
			});
			seen.push(...page.map((item) => item.id));
			before = page.at(-1);
			if (page.length < 2) break;
		}
		expect(seen).toEqual(["a", "c", "b", "d"]);
	});

	test("keys saved at the same time are all kept", async () => {
		const app = boot(await tempDir());
		await Promise.all(
			["one", "two", "three", "four"].map((id) =>
				app.keys.set(LOCAL_USER, id, `key-${id}`),
			),
		);
		expect((await app.keys.list(LOCAL_USER)).sort()).toEqual([
			"four",
			"one",
			"three",
			"two",
		]);
	});

	test("one user cannot read another user's data", async () => {
		const app = boot(await tempDir());
		const { session, turn } = await app.service.createTurn(LOCAL_USER, {
			prompt: "x",
			modelIds: ["fake/alpha"],
		});
		await app.engine.idle();
		const other = { userId: "other" };
		const assetId = (await app.service.getSession(LOCAL_USER, session.id))
			.turns[0]?.jobs[0]?.assets[0]?.id as string;

		expect(app.service.getSession(other, session.id)).rejects.toThrow();
		expect(app.service.getAssetFile(other, assetId)).rejects.toThrow();
		expect(
			app.service.cancelJob(other, turn.jobs[0]?.id as string),
		).rejects.toThrow();
		expect(await app.service.listGallery(other, { limit: 10 })).toHaveLength(0);
	});
});
