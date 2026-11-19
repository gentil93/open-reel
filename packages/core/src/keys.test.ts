import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyStore } from "./keys";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "hatchlight-keys-"));
	dirs.push(dir);
	return new FileKeyStore(join(dir, "auth.json"));
}

const me = { userId: "local" };

describe("API keys on disk", () => {
	test("are kept, listed and deleted per provider", async () => {
		const keys = await store();
		await keys.set(me, "fal", "k1");
		await keys.set(me, "openai", "k2");
		expect(await keys.get(me, "fal")).toBe("k1");
		expect((await keys.list(me)).sort()).toEqual(["fal", "openai"]);
		await keys.delete(me, "fal");
		expect(await keys.get(me, "fal")).toBeUndefined();
		expect(await keys.list(me)).toEqual(["openai"]);
	});

	test("names that reach an object's prototype never touch it", async () => {
		const keys = await store();
		await keys.set(me, "fal", "k1");
		await expect(keys.set(me, "__proto__", "x")).rejects.toThrow();
		await expect(
			keys.set({ userId: "__proto__" }, "fal", "x"),
		).rejects.toThrow();
		await keys.delete(me, "__proto__");
		await keys.delete({ userId: "__proto__" }, "toString");
		expect(await keys.get(me, "constructor")).toBeUndefined();
		expect(await keys.get({ userId: "__proto__" }, "fal")).toBeUndefined();
		expect(await keys.list({ userId: "constructor" })).toEqual([]);
		expect(typeof Object.prototype.toString).toBe("function");
		expect(await keys.get(me, "fal")).toBe("k1");
	});
});
