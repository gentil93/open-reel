import { describe, expect, test } from "bun:test";
import { CodedError } from "./errors";
import {
	improveInstructions,
	improvePrompt,
	type LanguageModel,
	promptStyle,
} from "./improve";
import type { ModelSpec } from "./types";

function model(family: string, extra: Partial<ModelSpec> = {}): ModelSpec {
	return {
		id: `x/${family}`,
		media: "image",
		profile: { family, text: false },
		...extra,
	} as ModelSpec;
}

const signal = () => new AbortController().signal;

describe("how a prompt is best written", () => {
	test("in phrases only when every model reads phrases best", () => {
		expect(promptStyle([model("sdxl"), model("sdxl-turbo")]).phrases).toBe(
			true,
		);
		expect(promptStyle([model("sdxl"), model("flux-schnell")]).phrases).toBe(
			false,
		);
		// Nothing chosen: plain sentences suit most models.
		expect(promptStyle([]).phrases).toBe(false);
	});

	test("notes video, words in pictures and a picture being changed", () => {
		const style = promptStyle(
			[
				model("wan", { media: "video" }),
				model("z-image-turbo", {
					profile: { family: "z-image-turbo", text: true } as never,
				}),
			],
			true,
		);
		expect(style).toEqual({
			phrases: false,
			video: true,
			text: true,
			editing: true,
		});
	});

	test("each choice changes what the language model is told", () => {
		const plain = improveInstructions(promptStyle([]));
		expect(plain).toContain("image generator");
		expect(plain).toContain("sentences");
		expect(plain).toContain("same language as the idea");
		const phrases = improveInstructions(promptStyle([model("sdxl")]));
		expect(phrases).toContain("phrases separated by commas");
		const video = improveInstructions(
			promptStyle([model("wan", { media: "video" })]),
		);
		expect(video).toContain("video generator");
		expect(video).toContain("camera moves");
		expect(improveInstructions(promptStyle([], true))).toContain(
			"which you cannot see",
		);
		expect(improveInstructions(promptStyle([], false, "pt-BR"))).toContain(
			"Write the prompt in Brazilian Portuguese",
		);
		// An unknown code: the idea's own language.
		expect(improveInstructions(promptStyle([], false, "zz"))).toContain(
			"same language as the idea",
		);
	});
});

describe("improving a prompt", () => {
	test("asks with some variety and takes the answer without what models add", async () => {
		const asked: unknown[] = [];
		const writer: LanguageModel = {
			reply: async (instructions, text, _signal, options) => {
				asked.push({ instructions, text, options });
				return '"Uma raposa vermelha enrolada na neve, luz suave da manhã"';
			},
		};
		const style = promptStyle([]);
		expect(
			await improvePrompt(writer, "  uma raposa na neve ", style, signal()),
		).toBe("Uma raposa vermelha enrolada na neve, luz suave da manhã");
		expect(asked[0]).toEqual({
			instructions: improveInstructions(style, false),
			text: "uma raposa na neve",
			options: { temperature: 0.7 },
		});
	});

	test("asks once more when it adds words the idea did not ask for", async () => {
		const replies = ['a fox under a sign saying "Snow"', "a fox in the snow"];
		let calls = 0;
		const writer: LanguageModel = {
			reply: async () => replies[calls++] as string,
		};
		expect(
			await improvePrompt(writer, "a fox", promptStyle([]), signal()),
		).toBe("a fox in the snow");
		expect(calls).toBe(2);

		// Text the idea asked for is kept, at the first answer.
		calls = 0;
		const quoted = await improvePrompt(
			{
				reply: async () => {
					calls++;
					return 'a bakery sign saying "Hot Bread"';
				},
			},
			'a bakery sign saying "Hot Bread"',
			promptStyle([]),
			signal(),
		);
		expect(quoted).toBe('a bakery sign saying "Hot Bread"');
		expect(calls).toBe(1);
	});

	test("an inch mark is not text to show", async () => {
		let calls = 0;
		const writer: LanguageModel = {
			reply: async () => {
				calls++;
				return 'a 12" vinyl record on a wooden table';
			},
		};
		await improvePrompt(writer, "a vinyl record", promptStyle([]), signal());
		expect(calls).toBe(1);
	});

	test("finds text in single quotes and corner brackets, not apostrophes", async () => {
		const shown = [
			"a shop sign that says 'OPEN'",
			"a shop sign that says ‘OPEN’",
			"「営業中」と書かれた看板",
			"『ようこそ』の看板",
		];
		for (const idea of shown) {
			let told = "";
			await improvePrompt(
				{
					reply: async (instructions) => {
						told = instructions;
						return idea;
					},
				},
				idea,
				promptStyle([]),
				signal(),
			);
			expect(told).toContain("Keep the text in quotes");
		}

		let calls = 0;
		const writer: LanguageModel = {
			reply: async () => {
				calls++;
				return "it's the dogs' favourite park at dawn";
			},
		};
		await improvePrompt(writer, "the dog's park", promptStyle([]), signal());
		expect(calls).toBe(1);
	});

	test("keeps the first answer when asking once more fails", async () => {
		let calls = 0;
		const writer: LanguageModel = {
			reply: async () => {
				calls++;
				if (calls === 2) throw new Error("engine crashed");
				return 'a fox under a sign saying "Snow"';
			},
		};
		expect(
			await improvePrompt(writer, "a fox", promptStyle([]), signal()),
		).toBe('a fox under a sign saying "Snow"');
		expect(calls).toBe(2);
	});

	test("stops when given up on, even while asking once more", async () => {
		const controller = new AbortController();
		let calls = 0;
		const writer: LanguageModel = {
			reply: async () => {
				calls++;
				if (calls === 2) {
					controller.abort();
					throw new Error("aborted");
				}
				return 'a fox under a sign saying "Snow"';
			},
		};
		const error = await improvePrompt(
			writer,
			"a fox",
			promptStyle([]),
			controller.signal,
		).catch((e) => e);
		expect(error.message).toBe("aborted");
	});

	test("tells the model about words in pictures only when the idea has some", () => {
		const style = promptStyle([
			model("z-image-turbo", {
				profile: { family: "z-image-turbo", text: true } as never,
			}),
		]);
		expect(improveInstructions(style, false)).toContain("no text to show");
		expect(improveInstructions(style, false)).not.toContain(
			"can write words inside pictures",
		);
		expect(improveInstructions(style, true)).toContain(
			"can write words inside pictures",
		);
	});

	test("says it could not when the model fails or answers nothing", async () => {
		const failing: LanguageModel = {
			reply: async () => {
				throw new Error("engine crashed");
			},
		};
		const empty: LanguageModel = { reply: async () => "  " };
		for (const writer of [failing, empty]) {
			const error = await improvePrompt(
				writer,
				"a fox",
				promptStyle([]),
				signal(),
			).catch((e) => e);
			expect(error).toBeInstanceOf(CodedError);
			expect(error.code).toBe("improveFailed");
		}
	});

	test("passes on a service's own reason, such as a missing key", async () => {
		const refusing: LanguageModel = {
			reply: async () => {
				throw new CodedError("No key", "noApiKey", { provider: "OpenAI" });
			},
		};
		const error = await improvePrompt(
			refusing,
			"a fox",
			promptStyle([]),
			signal(),
		).catch((e) => e);
		expect(error.code).toBe("noApiKey");
	});
});
