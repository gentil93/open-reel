import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVariable, LEGACY_NAME } from "./legacy";
import {
	chosenModelsDir,
	defaultDataDir,
	defaultModelsDir,
	modelsLocationFile,
	pathHere,
	plainPath,
	portablePath,
} from "./paths";

describe("defaultDataDir", () => {
	test("follows each system's convention", () => {
		expect(defaultDataDir("linux", {}, "/home/ana")).toBe(
			"/home/ana/.local/share/hatchlight",
		);
		expect(
			defaultDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/ana"),
		).toBe("/data/hatchlight");
		expect(defaultDataDir("darwin", {}, "/Users/ana")).toBe(
			"/Users/ana/Library/Application Support/hatchlight",
		);
		expect(
			defaultDataDir(
				"win32",
				{ APPDATA: "C:\\Users\\ana\\AppData\\Roaming" },
				"",
			),
		).toBe("C:\\Users\\ana\\AppData\\Roaming\\hatchlight");
	});

	test("an explicit directory wins", () => {
		expect(defaultDataDir("win32", { HATCHLIGHT_DATA_DIR: "/x" }, "")).toBe(
			"/x",
		);
		expect(
			defaultDataDir(
				"win32",
				{ [envVariable(LEGACY_NAME, "DATA_DIR")]: "/old" },
				"",
			),
		).toBe("/old");
	});

	test("stays in the folder from before the rename while the new one has no gallery", async () => {
		const home = await mkdtemp(join(tmpdir(), "hatchlight-paths-"));
		try {
			const share = join(home, ".local", "share");
			const current = join(share, "hatchlight");
			const legacy = join(share, LEGACY_NAME);
			expect(defaultDataDir("linux", {}, home)).toBe(current);
			await mkdir(legacy, { recursive: true });
			expect(defaultDataDir("linux", {}, home)).toBe(legacy);
			// A new folder that exists but has no gallery does not count.
			await mkdir(current);
			expect(defaultDataDir("linux", {}, home)).toBe(legacy);
			await writeFile(join(legacy, `${LEGACY_NAME}.sqlite`), "");
			expect(defaultDataDir("linux", {}, home)).toBe(legacy);
			await writeFile(join(current, "hatchlight.sqlite"), "");
			expect(defaultDataDir("linux", {}, home)).toBe(current);
		} finally {
			await rm(home, { recursive: true });
		}
		const roaming = "C:\\Users\\ana\\AppData\\Roaming";
		expect(
			defaultDataDir(
				"win32",
				{ APPDATA: roaming },
				"",
				(path) => path === `${roaming}\\${LEGACY_NAME}`,
			),
		).toBe(`${roaming}\\${LEGACY_NAME}`);
	});
});

describe("plainPath", () => {
	test("drops the long-path prefix Windows gives some paths", () => {
		expect(plainPath("\\\\?\\C:\\Program Files\\hatchlight")).toBe(
			"C:\\Program Files\\hatchlight",
		);
	});

	test("leaves other paths alone", () => {
		expect(plainPath("C:\\hatchlight")).toBe("C:\\hatchlight");
		expect(plainPath("\\\\?\\UNC\\server\\share")).toBe(
			"\\\\?\\UNC\\server\\share",
		);
		expect(plainPath("/home/ana/hatchlight")).toBe("/home/ana/hatchlight");
	});
});

describe("defaultModelsDir", () => {
	test("keeps models in the local, not roaming, app data on Windows", async () => {
		expect(
			await defaultModelsDir(
				"C:\\Users\\ana\\AppData\\Roaming\\hatchlight",
				"win32",
				{
					LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
				},
			),
		).toBe("C:\\Users\\ana\\AppData\\Local\\hatchlight\\models");
	});

	test("keeps them with the data elsewhere, unless told otherwise", async () => {
		expect(await defaultModelsDir("/d", "darwin", {})).toBe("/d/models");
		expect(
			await defaultModelsDir("/d", "win32", { HATCHLIGHT_MODELS_DIR: "/m" }),
		).toBe("/m");
		expect(
			await defaultModelsDir("/d", "win32", {
				[envVariable(LEGACY_NAME, "MODELS_DIR")]: "/old",
			}),
		).toBe("/old");
	});

	test("stay in the folder from before the rename while the new one has none", async () => {
		const local = "C:\\Users\\ana\\AppData\\Local";
		const legacy = `${local}\\${LEGACY_NAME}`;
		const models = (...present: string[]) =>
			defaultModelsDir("C:\\data", "win32", { LOCALAPPDATA: local }, (path) =>
				present.includes(path),
			);
		expect(await models(`${legacy}\\models`)).toBe(`${legacy}\\models`);
		// Moved elsewhere then: the note of where is next to the old folder.
		expect(await models(`${legacy}\\models-location.json`)).toBe(
			`${legacy}\\models`,
		);
		// Something else in the new folder, such as a preview, does not count.
		expect(
			await models(`${local}\\hatchlight\\preview`, `${legacy}\\models`),
		).toBe(`${legacy}\\models`);
		expect(
			await models(`${local}\\hatchlight\\models`, `${legacy}\\models`),
		).toBe(`${local}\\hatchlight\\models`);
		expect(await models()).toBe(`${local}\\hatchlight\\models`);
	});
});

describe("a models folder chosen by hand", () => {
	test("is written next to the default folder", () => {
		expect(
			modelsLocationFile("C:\\Users\\ana\\AppData\\Local\\hatchlight\\models"),
		).toBe("C:\\Users\\ana\\AppData\\Local\\hatchlight\\models-location.json");
		expect(
			modelsLocationFile("/mnt/c/Users/ana/AppData/Local/hatchlight/models"),
		).toBe("/mnt/c/Users/ana/AppData/Local/hatchlight/models-location.json");
	});

	test("is read the same from Windows and from WSL", () => {
		expect(pathHere("D:\\Models\\hatchlight", "linux")).toBe(
			"/mnt/d/Models/hatchlight",
		);
		expect(pathHere("/mnt/d/Models/hatchlight", "win32")).toBe(
			"D:\\Models\\hatchlight",
		);
		expect(pathHere("D:\\", "linux")).toBe("/mnt/d");
		expect(pathHere("D:\\Models", "win32")).toBe("D:\\Models");
		expect(pathHere("/srv/models", "linux")).toBe("/srv/models");
	});

	test("is not used where this system cannot reach it", () => {
		expect(pathHere("D:\\Models", "darwin")).toBeNull();
		expect(pathHere("/srv/models", "win32")).toBeNull();
		expect(pathHere("models", "linux")).toBeNull();
	});

	test("is written as Windows names it, when on a Windows drive", () => {
		expect(portablePath("/mnt/d/Models")).toBe("D:\\Models");
		expect(portablePath("/srv/models")).toBe("/srv/models");
	});

	test("is followed when written down, and the default used otherwise", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hatchlight-paths-"));
		try {
			const defaultDir = join(dir, "models");
			expect(await chosenModelsDir(defaultDir, "linux")).toBe(defaultDir);
			await Bun.write(
				modelsLocationFile(defaultDir),
				JSON.stringify({ path: "D:\\Models" }),
			);
			expect(await chosenModelsDir(defaultDir, "linux")).toBe("/mnt/d/Models");
			await Bun.write(modelsLocationFile(defaultDir), "not json");
			expect(await chosenModelsDir(defaultDir, "linux")).toBe(defaultDir);
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});
