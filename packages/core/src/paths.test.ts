import { describe, expect, test } from "bun:test";
import { defaultDataDir } from "./paths";

describe("defaultDataDir", () => {
	test("follows each system's convention", () => {
		expect(defaultDataDir("linux", {}, "/home/ana")).toBe(
			"/home/ana/.local/share/open-reel",
		);
		expect(
			defaultDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/ana"),
		).toBe("/data/open-reel");
		expect(defaultDataDir("darwin", {}, "/Users/ana")).toBe(
			"/Users/ana/Library/Application Support/open-reel",
		);
		expect(
			defaultDataDir(
				"win32",
				{ APPDATA: "C:\\Users\\ana\\AppData\\Roaming" },
				"",
			),
		).toBe("C:\\Users\\ana\\AppData\\Roaming\\open-reel");
	});

	test("an explicit directory wins", () => {
		expect(defaultDataDir("win32", { OPEN_REEL_DATA_DIR: "/x" }, "")).toBe(
			"/x",
		);
	});
});
