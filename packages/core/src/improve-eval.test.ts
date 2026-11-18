import { describe, expect, test } from "bun:test";
import { EVAL_CASES, judgeImprovement } from "./improve-eval";

const fox = EVAL_CASES[0];
if (!fox) throw new Error("no cases");

describe("judging an improved prompt", () => {
	test("passes one that keeps the idea, in the reader's language", () => {
		expect(
			judgeImprovement(
				fox,
				"Uma raposa laranja de pelagem espessa caminha sobre a neve fresca de uma floresta de pinheiros ao amanhecer, com a luz dourada e suave atravessando a névoa, em uma fotografia de natureza com lente teleobjetiva e fundo desfocado.",
			),
		).toEqual([]);
	});

	test("names each thing wrong", () => {
		const problems = judgeImprovement(
			fox,
			'A grey fox in the snow under a sign saying "Winter"',
		);
		expect(problems).toContain('lost "raposa"');
		expect(problems).toContain('lost "laranja"');
		expect(problems).toContain("added text in quotes");
		expect(problems).toContain("not written in pt-BR");
		expect(problems.some((p) => p.endsWith("expected 25 to 120"))).toBe(true);
	});

	test("phrases without small words still read as their language", () => {
		const robot = EVAL_CASES.find((c) => c.idea.startsWith("um robô"));
		const bike = EVAL_CASES.find((c) => c.idea.startsWith("a red bicycle"));
		if (!robot || !bike) throw new Error("cases changed");
		expect(
			judgeImprovement(
				robot,
				"robô azul, regando plantas, jardim verde, luz suave, gotas brilhando, estilo realista, manhã calma",
			),
		).toEqual([]);
		expect(
			judgeImprovement(
				bike,
				"red bicycle, blue wooden door, sunlit street, soft shadows, sharp focus, warm tones, quiet morning",
			),
		).toEqual([]);
	});

	test("a word must be whole at its start", () => {
		const bike = EVAL_CASES.find((c) => c.idea.startsWith("a red bicycle"));
		if (!bike) throw new Error("cases changed");
		expect(
			judgeImprovement(
				bike,
				"colored bicycle, blue wooden door, sunlit street, soft shadows, sharp focus, warm tones, quiet morning",
			),
		).toContain('lost "red"');
	});

	test("every case can be passed: what it must keep is in the idea", () => {
		for (const item of EVAL_CASES) {
			for (const spellings of item.keep) {
				expect(
					spellings.some((s) =>
						item.idea.toLowerCase().includes(s.toLowerCase()),
					),
				).toBe(true);
			}
		}
	});
});
