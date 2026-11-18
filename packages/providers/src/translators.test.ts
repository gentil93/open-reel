import { describe, expect, test } from "bun:test";
import { TRANSLATE_INSTRUCTIONS } from "@open-reel/core";
import { CloudTranslator } from "./translators";

/** A service that knows only `known` models, answering in its format. */
function service(known: string[], reply = "a red fox") {
	const asked: { url: string; body: Record<string, unknown> }[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		asked.push({ url, body });
		const model =
			(body.model as string | undefined) ??
			url.match(/models\/([^:]+):/)?.[1] ??
			"";
		if (!known.includes(model)) {
			return Response.json(
				{ error: { message: "no such model" } },
				{ status: 404 },
			);
		}
		return url.includes("googleapis")
			? Response.json({
					candidates: [{ content: { parts: [{ text: ` ${reply} ` }] } }],
				})
			: Response.json({ choices: [{ message: { content: reply } }] });
	};
	return { fetch, asked };
}

const signal = () => new AbortController().signal;

describe("translating with the person's key", () => {
	test("OpenAI is asked in its chat format, without settings newer models refuse", async () => {
		const openai = service(["gpt-5-nano"]);
		const translator = new CloudTranslator("openai", "sk-test", openai.fetch);
		expect(await translator.toEnglish("uma raposa", signal())).toBe(
			"a red fox",
		);
		expect(openai.asked[0]?.url).toBe(
			"https://api.openai.com/v1/chat/completions",
		);
		expect(openai.asked[0]?.body).toEqual({
			model: "gpt-5-nano",
			messages: [
				{ role: "system", content: TRANSLATE_INSTRUCTIONS },
				{ role: "user", content: "uma raposa" },
			],
		});
	});

	test("Gemini is asked in its own format", async () => {
		const google = service(["gemini-3.5-flash-lite"]);
		const translator = new CloudTranslator("google", "key", google.fetch);
		expect(await translator.toEnglish("uma raposa", signal())).toBe(
			"a red fox",
		);
		expect(google.asked[0]?.url).toContain(
			"/models/gemini-3.5-flash-lite:generateContent",
		);
		expect(google.asked[0]?.body).toMatchObject({
			systemInstruction: { parts: [{ text: TRANSLATE_INSTRUCTIONS }] },
			contents: [{ role: "user", parts: [{ text: "uma raposa" }] }],
		});
	});

	test("a model the service no longer has moves on to the next, which is kept", async () => {
		const openrouter = service(["openai/gpt-5-nano"]);
		const translator = new CloudTranslator(
			"openrouter",
			"key",
			openrouter.fetch,
		);
		await translator.toEnglish("uma raposa", signal());
		const tried = openrouter.asked.map((a) => a.body.model);
		expect(tried).toEqual([
			"google/gemini-3.5-flash-lite",
			"google/gemini-2.5-flash-lite",
			"openai/gpt-5-nano",
		]);
		await translator.toEnglish("outra raposa", signal());
		// Straight to the one that answered.
		expect(openrouter.asked.at(-1)?.body.model).toBe("openai/gpt-5-nano");
		expect(openrouter.asked).toHaveLength(4);
	});

	test("a refusal says why, and a service with none of the models says so", async () => {
		const refusing = async () =>
			Response.json({ error: { message: "invalid key" } }, { status: 401 });
		await expect(
			new CloudTranslator("openai", "bad", refusing).toEnglish("x", signal()),
		).rejects.toThrow("invalid key");
		await expect(
			new CloudTranslator("google", "key", service([]).fetch).toEnglish(
				"x",
				signal(),
			),
		).rejects.toThrow("none of the models");
	});
});
