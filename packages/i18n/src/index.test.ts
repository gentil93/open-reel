import { describe, expect, test } from "bun:test";
import {
	checkCatalog,
	createTranslator,
	matchLanguage,
	missingKeys,
	placeholders,
} from "./index";

const en = {
	hello: "Hello, {name}",
	files: { one: "{count} file", other: "{count} files" },
	only: "Only in English",
};

describe("translating", () => {
	test("uses the translation, falling back to the source per key", () => {
		const { t } = createTranslator("pt-BR", en, { hello: "Olá, {name}" });
		expect(t("hello", { name: "Ana" })).toBe("Olá, Ana");
		expect(t("only")).toBe("Only in English");
	});

	test("chooses the plural form the language uses", () => {
		const english = createTranslator("en", en);
		expect(english.t("files", { count: 1 })).toBe("1 file");
		expect(english.t("files", { count: 3 })).toBe("3 files");
		const portuguese = createTranslator("pt-BR", en, {
			files: { one: "{count} arquivo", other: "{count} arquivos" },
		});
		// Portuguese counts zero as singular.
		expect(portuguese.t("files", { count: 0 })).toBe("0 arquivo");
		expect(portuguese.t("files", { count: 2 })).toBe("2 arquivos");
	});

	test("formats numbers in values the local way", () => {
		const { t } = createTranslator("pt-BR", en);
		expect(t("files", { count: 1234 })).toBe("1.234 files");
	});

	test("leaves unknown keys and missing values visible instead of failing", () => {
		const { t } = createTranslator("en", en);
		expect(t("nope" as never)).toBe("nope");
		expect(t("hello")).toBe("Hello, {name}");
	});

	test("formats sizes and numbers for the locale", () => {
		const english = createTranslator("en", en);
		expect(english.bytes(6_938_081_905)).toBe("6.94 GB");
		expect(english.bytes(12_260_000_000)).toBe("12.3 GB");
		expect(english.bytes(975_817_543)).toBe("976 MB");
		expect(english.bytes(4_200)).toBe("4 kB");
		const portuguese = createTranslator("pt-BR", en);
		expect(portuguese.bytes(6_938_081_905)).toBe("6,94 GB");
		// Intl separates the symbol with a no-break space.
		expect(
			portuguese
				.number(0.04, { style: "currency", currency: "USD" })
				.replace(/\s/g, " "),
		).toBe("US$ 0,04");
	});
});

test("matching the user's languages to the available ones", () => {
	const available = ["en", "pt-BR"];
	expect(matchLanguage(["pt-BR", "en"], available, "en")).toBe("pt-BR");
	expect(matchLanguage(["pt-PT"], available, "en")).toBe("pt-BR");
	expect(matchLanguage(["pt"], available, "en")).toBe("pt-BR");
	expect(matchLanguage(["de-DE", "en-GB"], available, "en")).toBe("en");
	expect(matchLanguage(["ja"], available, "en")).toBe("en");
	expect(matchLanguage([], available, "en")).toBe("en");
});

test("checking a translation against the source", () => {
	expect(placeholders(en.files)).toEqual(["count"]);
	expect(
		checkCatalog(en, {
			hello: "Olá",
			files: { one: "{count} arquivo", other: "{n} arquivos" },
			gone: "Não existe",
			only: 3 as never,
		}),
	).toEqual([
		{ key: "hello", problem: "placeholders differ" },
		{ key: "files", problem: "placeholders differ" },
		{ key: "gone", problem: "unknown key" },
		{ key: "only", problem: "not text" },
	]);
	expect(missingKeys(en, { hello: "Olá, {name}" })).toEqual(["files", "only"]);
});
