/**
 * Judges "Improve prompt" on this computer: sends a fixed set of ideas to a
 * running open-reel and checks each answer (kept the colors, numbers and
 * quoted text, added no words to show, wrote in the reader's language, a
 * fitting length). It uses whatever Settings > "Improve prompts with" picks.
 *
 *   bun scripts/eval-improve.ts [--url http://127.0.0.1:4096] [--runs 3]
 */
import { parseArgs } from "node:util";
import {
	EVAL_CASES,
	judgeImprovement,
} from "../packages/core/src/improve-eval";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://127.0.0.1:4096" },
		runs: { type: "string", default: "1" },
	},
});
const base = values.url.replace(/\/$/, "");
const runs = Math.max(1, Number(values.runs) || 1);

const models = (await (await fetch(`${base}/api/models`)).json()) as {
	id: string;
	profile?: { family?: string };
}[];
const forFamily = (family: string) =>
	models.find((m) => m.profile?.family === family)?.id;

let passed = 0;
let total = 0;
const seconds: number[] = [];
for (const item of EVAL_CASES) {
	const id = forFamily(item.family);
	for (let run = 0; run < runs; run++) {
		total++;
		const started = performance.now();
		const response = await fetch(`${base}/api/prompts/improve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				prompt: item.idea,
				modelIds: id ? [id] : [],
				language: item.language,
			}),
		});
		const took = (performance.now() - started) / 1000;
		seconds.push(took);
		// A crash page is one failed case, not the end of the run.
		const body = (await response.json().catch(() => ({}))) as {
			prompt?: string;
			error?: string;
		};
		const problems = body.prompt
			? judgeImprovement(item, body.prompt)
			: [`failed: ${body.error ?? response.status}`];
		if (problems.length === 0) passed++;
		console.log(
			`${problems.length === 0 ? "PASS" : "FAIL"} ${took.toFixed(1)}s  ${item.idea}${id ? "" : `  (no ${item.family} model here)`}`,
		);
		if (body.prompt) console.log(`     → ${body.prompt}`);
		for (const problem of problems) console.log(`     ✗ ${problem}`);
	}
}
seconds.sort((a, b) => a - b);
const median = seconds[Math.floor(seconds.length / 2)] ?? 0;
console.log(
	`\n${passed}/${total} passed, median ${median.toFixed(1)}s per prompt`,
);
process.exit(passed === total ? 0 : 1);
