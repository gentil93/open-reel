import { hasQuotedText } from "./improve";

/**
 * A fixed set of ideas to improve, and how to tell a good answer, so a
 * language model can be judged for this task on the computer it runs on.
 */
export interface EvalCase {
	idea: string;
	/** The language the person reads, as a BCP 47 code. */
	language: "en" | "pt-BR";
	/** The family of the model the prompt is for, as in a model's profile. */
	family: string;
	/** Words the answer must keep: each entry is met by any of its spellings. */
	keep: string[][];
	/** The model reads short phrases, not sentences. */
	phrases?: boolean;
}

export const EVAL_CASES: EvalCase[] = [
	{
		idea: "uma raposa laranja na neve",
		language: "pt-BR",
		family: "flux-schnell",
		keep: [["raposa"], ["laranja"]],
	},
	{
		idea: "três gatos pretos num telhado ao pôr do sol",
		language: "pt-BR",
		family: "flux-schnell",
		keep: [["três", "3"], ["gatos"], ["pretos"]],
	},
	{
		idea: 'uma placa de padaria escrito "Pão Quente"',
		language: "pt-BR",
		family: "z-image-turbo",
		keep: [["Pão Quente"]],
	},
	{
		idea: "a cafe sign that says 'OPEN'",
		language: "en",
		family: "z-image-turbo",
		keep: [["OPEN"]],
	},
	{
		idea: "a red bicycle leaning on a blue door",
		language: "en",
		family: "sdxl-turbo",
		keep: [["red"], ["blue"], ["bicycle", "bike"]],
		phrases: true,
	},
	{
		idea: "um robô azul regando plantas",
		language: "pt-BR",
		family: "sdxl-turbo",
		keep: [["robô"], ["azul"], ["planta"]],
		phrases: true,
	},
	{
		idea: "a lighthouse in a storm",
		language: "en",
		family: "flux-schnell",
		keep: [["lighthouse"], ["storm"]],
	},
	{
		idea: "a street full of neon signs at night",
		language: "en",
		family: "flux-schnell",
		keep: [["neon"], ["night"]],
	},
];

/**
 * Signs of each language: common short words, and for Portuguese the
 * letters English never uses.
 */
const SIGNS: Record<EvalCase["language"], RegExp> = {
	en: /(?<![\p{L}])(the|with|and|of|in|on|an|is|at)(?![\p{L}])/giu,
	"pt-BR":
		/(?<![\p{L}])(de|com|um|uma|em|na|ao|da|do|e|é)(?![\p{L}])|[ãõçêâáéíóú]/giu,
};

/** Whether `text` has `word` as a whole word, ignoring case. */
function hasWord(text: string, word: string): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "iu").test(text);
}

function words(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/** What is wrong with `answer` for `item`: empty when it passes. */
export function judgeImprovement(item: EvalCase, answer: string): string[] {
	const problems: string[] = [];
	for (const spellings of item.keep) {
		// The start of a word, so "planta" is kept by "plantas" but "red" is
		// not by "colored".
		if (!spellings.some((s) => hasWord(answer, s))) {
			problems.push(`lost "${spellings[0]}"`);
		}
	}
	if (!hasQuotedText(item.idea) && hasQuotedText(answer)) {
		problems.push("added text in quotes");
	}
	const other = item.language === "en" ? "pt-BR" : "en";
	const mine = answer.match(SIGNS[item.language])?.length ?? 0;
	const theirs = answer.match(SIGNS[other])?.length ?? 0;
	// Short phrases may have no sign of either: only a clear other wins.
	if (theirs > mine) problems.push(`not written in ${item.language}`);
	const count = words(answer);
	// A little slack around what the model is asked for.
	const [least, most] = item.phrases ? [10, 55] : [25, 120];
	if (count < least || count > most) {
		problems.push(`${count} words, expected ${least} to ${most}`);
	}
	return problems;
}
