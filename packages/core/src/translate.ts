/**
 * Some models read prompts well only in English (their text encoder is CLIP
 * or T5). A prompt written in another language is put into English for them
 * first, by a small language model: one running on this computer, or one
 * reached with the person's own key.
 */
export interface Translator {
	/**
	 * The prompt in English, or the same text when it already is. Rejects
	 * when it cannot translate now; the prompt is then sent as written.
	 */
	toEnglish(prompt: string, signal: AbortSignal): Promise<string>;
}

/** What a language model is told, to translate a prompt and nothing more. */
export const TRANSLATE_INSTRUCTIONS = [
	"You translate prompts for an image and video generator into English.",
	"Reply with the English prompt only: no notes, no quotes around it, no explanations.",
	"Keep the meaning, the details and the order of the description.",
	"Keep names, brands and any text in quotes exactly as written: the quoted text is meant to appear in the picture.",
	"If the prompt is already in English, reply with it unchanged.",
].join(" ");

/**
 * The translation from a language model's reply: without the reasoning some
 * models write first, a label such as "Translation:", or quotes around it.
 */
export function cleanTranslation(reply: string): string {
	let text = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	text = text.replace(/^(english|translation|prompt)\s*:\s*/i, "").trim();
	const quoted = text.match(/^["“'](.*)["”']$/s);
	if (quoted?.[1] && !/["“”]/.test(quoted[1])) text = quoted[1].trim();
	return text;
}
