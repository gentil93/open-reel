import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
