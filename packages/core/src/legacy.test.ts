import { describe, expect, test } from "bun:test";
import {
	APP_NAME,
	appEnv,
	envVariable,
	LEGACY_NAME,
	legacyName,
	storedValue,
} from "./legacy";

describe("appEnv", () => {
	const legacy = envVariable(LEGACY_NAME, "DATA_DIR");

	test("reads the variable under the new name first", () => {
		expect(
			appEnv({ HATCHLIGHT_DATA_DIR: "/new", [legacy]: "/old" }, "DATA_DIR"),
		).toBe("/new");
	});

	test("falls back to the variable under the old name", () => {
		expect(legacy).not.toBe("HATCHLIGHT_DATA_DIR");
		expect(appEnv({ [legacy]: "/old" }, "DATA_DIR")).toBe("/old");
		expect(appEnv({ HATCHLIGHT_DATA_DIR: "" }, "DATA_DIR")).toBeUndefined();
	});
});

test("names a key or file as it was before the rename", () => {
	expect(legacyName(`${APP_NAME}.sqlite`)).toBe(`${LEGACY_NAME}.sqlite`);
	expect(legacyName("auth.json")).toBe("auth.json");
});

describe("storedValue", () => {
	const storage = (values: Record<string, string>) => ({
		getItem: (key: string) => values[key] ?? null,
	});

	test("reads the key under the old name while the new one is unset", () => {
		const old = storage({ [`${LEGACY_NAME}.welcomed`]: "1" });
		expect(storedValue(old, "hatchlight.welcomed")).toBe("1");
		expect(storedValue(old, "hatchlight.language")).toBeNull();
	});

	test("prefers the key under the new name", () => {
		const both = storage({
			"hatchlight.language": "en",
			[`${LEGACY_NAME}.language`]: "pt-BR",
		});
		expect(storedValue(both, "hatchlight.language")).toBe("en");
	});
});
