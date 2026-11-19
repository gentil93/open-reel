import { CodedError } from "./errors";
import { cleanTranslation } from "./translate";
import type { ModelSpec, Settings } from "./types";

/**
 * A language model that answers one message, given instructions: one on this
 * computer or one reached with the person's own key. Translating prompts and
 * improving them are two uses of it.
 */
export interface LanguageModel {
	reply(
		instructions: string,
		text: string,
		signal: AbortSignal,
		options?: ReplyOptions,
	): Promise<string>;
}

export interface ReplyOptions {
	/**
	 * 0 answers the same every time; higher varies the answer. Services
	 * whose newer models refuse the setting leave it out.
	 */
	temperature?: number;
}

/**
 * Families whose text encoder is CLIP alone: they read a short list of
 * phrases best, and nothing past about 75 words.
 */
const PHRASE_FAMILIES = new Set(["sdxl", "sdxl-turbo", "sd-1.5"]);

/** How a prompt is best written for these models. */
export interface PromptStyle {
	/** Short comma-separated phrases, not sentences. */
	phrases: boolean;
	video: boolean;
	/** A model here writes legible words inside pictures. */
	text: boolean;
	/** The person is changing a picture they gave. */
	editing: boolean;
	/**
	 * The language the person reads, as a BCP 47 code such as "pt-BR": the
	 * prompt is written in it so they can read and edit it. Models that read
	 * only English get it translated when it is sent.
	 */
	language?: string;
}

export function promptStyle(
	models: ModelSpec[],
	editing = false,
	language?: string,
): PromptStyle {
	return {
		// Sentences also suit phrase models; phrases only when all read them.
		phrases:
			models.length > 0 &&
			models.every((m) => PHRASE_FAMILIES.has(m.profile?.family ?? "")),
		video: models.some((m) => m.media === "video"),
		text: models.some((m) => m.profile?.text === true),
		editing,
		...(language && { language }),
	};
}

/**
 * Text in quotes: words meant to appear in the picture. A pair, so an inch
 * mark (a 12" record) is not taken for one; single quotes only around whole
 * words, so an apostrophe (it's, the dogs' toys) is not either.
 */
const QUOTED =
	/["“«„][^"“”«»„]+["”»“]|‘[^‘’]+’|「[^「」]+」|『[^『』]+』|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/u;

/** Whether `text` has words in quotes, meant to be shown in the picture. */
export const hasQuotedText = (text: string) => QUOTED.test(text);

/**
 * What a language model is told, to make a short idea into a good prompt.
 * `quoted` says whether the idea has text in quotes to show: small models
 * told only "unless" add words to pictures anyway.
 */
export function improveInstructions(
	style: PromptStyle,
	quoted = false,
): string {
	const output = style.video ? "a video" : "a picture";
	return [
		`You write prompts for ${style.video ? "a video" : "an image"} generator.`,
		"Turn the person's idea into one richer prompt that keeps everything they asked for: the subject, every color, number and name, and any text in quotes, exactly as given.",
		`Where the idea leaves it open, add what makes ${output} good: the setting, the light, the style or camera, the composition and the mood.`,
		"Do not change what the idea says and do not add a second subject. Give the subject the look people usually picture, unless the idea says otherwise.",
		quoted
			? "Keep the text in quotes exactly as written, in quotes, and add no other words to the picture."
			: "The idea has no text to show: put no words, letters, captions or quotes in the prompt.",
		style.phrases
			? "This model reads short phrases best: write 15 to 40 words as phrases separated by commas, the most important first, no full sentences."
			: "This model reads plain language best: write two to four sentences, 40 to 90 words in all.",
		...(style.video
			? [
					"Describe what moves and how the camera moves, as one continuous shot of a few seconds. Describe only what is seen: no sounds.",
				]
			: []),
		...(style.text && quoted
			? [
					"This model can write words inside pictures: say where the text appears and how it looks.",
				]
			: []),
		...(style.editing
			? [
					"The person is changing a picture they gave, which you cannot see: keep their request at the heart of the prompt and add only style and light; do not describe what the picture shows.",
				]
			: []),
		languageName(style.language)
			? `Write the prompt in ${languageName(style.language)}, whatever language the idea is in.`
			: "Write in the same language as the idea.",
		"Reply with the prompt only: no title, no notes, no quotes around it.",
	].join(" ");
}

/** A language's English name, e.g. "Brazilian Portuguese" for "pt-BR". */
function languageName(code: string | undefined): string | undefined {
	if (!code) return undefined;
	try {
		const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
		// An unknown code comes back as itself.
		return name && name !== code ? name : undefined;
	} catch {
		return undefined;
	}
}

/** Some variety, so asking again gives another suggestion. */
const IMPROVE_TEMPERATURE = 0.7;

/**
 * A richer prompt for `prompt`, written for `models`. Rejects when the
 * language model fails or answers nothing.
 */
export async function improvePrompt(
	model: LanguageModel,
	prompt: string,
	style: PromptStyle,
	signal: AbortSignal,
): Promise<string> {
	const idea = prompt.trim();
	const quoted = QUOTED.test(idea);
	const ask = () =>
		model.reply(improveInstructions(style, quoted), idea, signal, {
			temperature: IMPROVE_TEMPERATURE,
		});
	let reply: string;
	try {
		reply = await ask();
	} catch (error) {
		// Given up on, or a service's refusal (no key, busy) that says it
		// better than we could.
		if (signal.aborted || (error instanceof CodedError && error.code)) {
			throw error;
		}
		throw new CodedError(
			`Could not improve the prompt: ${error instanceof Error ? error.message : String(error)}`,
			"improveFailed",
		);
	}
	// Words the person never asked for would be drawn into the picture:
	// asked once more. When that fails, the first answer is still usable.
	if (!quoted && QUOTED.test(cleanTranslation(reply))) {
		try {
			reply = await ask();
		} catch (error) {
			if (signal.aborted) throw error;
		}
	}
	const text = cleanTranslation(reply);
	if (!text) {
		throw new CodedError(
			"Could not improve the prompt: no answer",
			"improveFailed",
		);
	}
	return text;
}

/**
 * Which language model writes a fuller prompt: the one on this computer, a
 * service with the person's key, or none that can be used now. Automatic
 * takes the one on this computer when it is installed (free, and good at
 * it), else the service chosen for translation.
 */
export function writerChoice(
	settings: Pick<Settings, "improveWith" | "translateWith">,
	localReady: boolean,
	/** Whether a service has a key to be reached with. */
	usable: (service: "openai" | "google" | "openrouter") => boolean = () => true,
): "local" | "openai" | "google" | "openrouter" | null {
	const { improveWith, translateWith } = settings;
	if (improveWith === "local") return localReady ? "local" : null;
	if (improveWith !== "auto" && usable(improveWith)) return improveWith;
	// Automatic, or a chosen service whose key is gone: what is free first.
	if (localReady) return "local";
	if (translateWith === "off" || translateWith === "local") return null;
	return usable(translateWith) ? translateWith : null;
}

/**
 * The language model the assistant thinks with. Automatic picks a service
 * with a key first, the one that translates if it has one: the model on
 * this computer is weak at planning and calling tools, so it is the
 * fallback.
 */
export function assistantChoice(
	settings: Pick<Settings, "assistantWith" | "translateWith">,
	localReady: boolean,
	usable: (service: "openai" | "google" | "openrouter") => boolean,
): "local" | "openai" | "google" | "openrouter" | null {
	const { assistantWith, translateWith } = settings;
	if (assistantWith === "local") return localReady ? "local" : null;
	if (assistantWith !== "auto" && usable(assistantWith)) return assistantWith;
	const services = ["openai", "google", "openrouter"] as const;
	const preferred = services.find((s) => s === translateWith && usable(s));
	const cloud = preferred ?? services.find(usable);
	if (cloud) return cloud;
	return localReady ? "local" : null;
}
