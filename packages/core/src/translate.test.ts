import { describe, expect, test } from "bun:test";
import { cleanTranslation, sameWords } from "./translate";

describe("a translation that says the same as its prompt", () => {
	test("differs only in case, spaces or punctuation", () => {
		expect(
			sameWords(
				"a red fox curled up in fresh snow",
				"A red fox curled up in fresh snow.",
			),
		).toBe(true);
		expect(sameWords("uma raposa", "a fox")).toBe(false);
		expect(sameWords("café, à noite", "Café à noite")).toBe(true);
	});
});

describe("a translation as a language model replies it", () => {
	test("is taken without what models add around it", () => {
		expect(cleanTranslation("a red fox in the snow")).toBe(
			"a red fox in the snow",
		);
		expect(cleanTranslation("  Translation: a red fox \n")).toBe("a red fox");
		expect(cleanTranslation('"a red fox"')).toBe("a red fox");
		expect(cleanTranslation("«une renarde rousse»")).toBe("une renarde rousse");
		expect(
			cleanTranslation("<think>\nThe user wants…\n</think>\n\na fox"),
		).toBe("a fox");
	});

	test("keeps quotes that belong to the prompt", () => {
		expect(cleanTranslation('a sign that says "OPEN"')).toBe(
			'a sign that says "OPEN"',
		);
		expect(cleanTranslation('"OPEN" written on "the door"')).toBe(
			'"OPEN" written on "the door"',
		);
	});
});
