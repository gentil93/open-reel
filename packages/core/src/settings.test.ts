import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSettingsStore } from "./settings";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true });
});

async function store() {
	const dir = await mkdtemp(join(tmpdir(), "open-reel-settings-"));
	dirs.push(dir);
	const path = join(dir, "settings.json");
	return { settings: new FileSettingsStore(path), path };
}

const ana = { userId: "ana" };
const bia = { userId: "bia" };

describe("settings", () => {
	test("translate on this computer until a person chooses otherwise", async () => {
		const { settings } = await store();
		expect(await settings.get(ana)).toEqual({ translateWith: "local" });
	});

	test("are kept per person, and survive a restart", async () => {
		const { settings, path } = await store();
		expect(await settings.set(ana, { translateWith: "openai" })).toEqual({
			translateWith: "openai",
		});
		expect(await settings.get(bia)).toEqual({ translateWith: "local" });
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "openai",
		});
	});

	test("a value open-reel does not know reads as the default", async () => {
		const { path } = await store();
		await writeFile(
			path,
			JSON.stringify({ ana: { translateWith: "carrier pigeon" } }),
		);
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "local",
		});
		await writeFile(path, "not json");
		expect(await new FileSettingsStore(path).get(ana)).toEqual({
			translateWith: "local",
		});
	});

	test("changes made at once are all kept", async () => {
		const { settings } = await store();
		await Promise.all([
			settings.set(ana, { translateWith: "google" }),
			settings.set(bia, { translateWith: "off" }),
		]);
		expect(await settings.get(ana)).toEqual({ translateWith: "google" });
		expect(await settings.get(bia)).toEqual({ translateWith: "off" });
	});
});
