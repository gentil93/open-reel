/**
 * A small translation layer shared by the app and the site.
 *
 * Messages live in one JSON file per language. English is the source: every
 * key exists there, and any key missing from another language falls back to
 * it, so a partial translation is always usable. A message can name values
 * in braces (`"Saved {count} files"`), and a message whose wording depends on
 * a number is an object of plural forms (`{ "one": "...", "other": "..." }`).
 */

/** A message: plain text, or plural forms keyed by `Intl.PluralRules` category. */
export type Message = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalog = Record<string, Message>;
export type Params = Record<string, string | number>;

export interface Language {
	/** A BCP 47 tag, e.g. "pt-BR". */
	code: string;
	/** The language's name in itself, e.g. "Português (Brasil)". */
	name: string;
}

export interface Translator<K extends string = string> {
	locale: string;
	t(key: K, params?: Params): string;
	number(value: number, options?: Intl.NumberFormatOptions): string;
	/** Sizes in the decimal units disks and download pages use. */
	bytes(value: number): string;
	date(value: number | Date, options?: Intl.DateTimeFormatOptions): string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** The names a message expects in braces, in every plural form. */
export function placeholders(message: Message): string[] {
	const texts =
		typeof message === "string" ? [message] : Object.values(message);
	const names = new Set<string>();
	for (const text of texts) {
		for (const match of (text ?? "").matchAll(PLACEHOLDER))
			names.add(match[1] as string);
	}
	return [...names].sort();
}

/**
 * Builds a translator for `locale`. `source` is the English catalog, used for
 * any key the translation lacks.
 */
export function createTranslator<C extends Catalog>(
	locale: string,
	source: C,
	translation: Partial<Record<keyof C, Message>> = {},
): Translator<Extract<keyof C, string>> {
	const plurals = new Intl.PluralRules(locale);
	const numbers = new Map<string, Intl.NumberFormat>();
	const numberFormat = (options: Intl.NumberFormatOptions = {}) => {
		const key = JSON.stringify(options);
		let format = numbers.get(key);
		if (!format) {
			format = new Intl.NumberFormat(locale, options);
			numbers.set(key, format);
		}
		return format;
	};

	const t = (key: Extract<keyof C, string>, params: Params = {}) => {
		const message = translation[key] ?? source[key];
		if (message == null) return key;
		let text: string | undefined;
		if (typeof message === "string") {
			text = message;
		} else {
			const count = Number(params.count);
			text = message[plurals.select(count)] ?? message.other;
		}
		return (text ?? key).replace(PLACEHOLDER, (whole, name: string) => {
			const value = params[name];
			if (value == null) return whole;
			return typeof value === "number" ? numberFormat().format(value) : value;
		});
	};

	return {
		locale,
		t,
		number: (value, options) => numberFormat(options).format(value),
		bytes: (value) => {
			const [unit, divisor] =
				value < 1e6
					? (["kilobyte", 1e3] as const)
					: value < 1e9
						? (["megabyte", 1e6] as const)
						: (["gigabyte", 1e9] as const);
			const amount = value / divisor;
			return numberFormat({
				style: "unit",
				unit,
				maximumFractionDigits:
					unit === "gigabyte" && amount < 10 ? 2 : unit === "gigabyte" ? 1 : 0,
			}).format(amount);
		},
		date: (value, options) =>
			new Intl.DateTimeFormat(locale, options).format(value),
	};
}

/**
 * Picks the best available language for the user's preferences: an exact
 * match first, then one with the same base language ("pt" for "pt-PT").
 */
export function matchLanguage(
	wanted: readonly string[],
	available: readonly string[],
	fallback: string,
): string {
	const lower = available.map((code) => code.toLowerCase());
	for (const want of wanted) {
		const exact = lower.indexOf(want.toLowerCase());
		if (exact !== -1) return available[exact] as string;
		const base = want.toLowerCase().split("-")[0];
		const sameBase = lower.findIndex((code) => code.split("-")[0] === base);
		if (sameBase !== -1) return available[sameBase] as string;
	}
	return fallback;
}

export interface CatalogProblem {
	key: string;
	problem: "unknown key" | "placeholders differ" | "not text";
}

/**
 * What is wrong with a translation compared with the source. Missing keys are
 * not problems: they fall back to the source language.
 */
export function checkCatalog(
	source: Catalog,
	translation: Catalog,
): CatalogProblem[] {
	const problems: CatalogProblem[] = [];
	for (const [key, message] of Object.entries(translation)) {
		const original = source[key];
		if (original == null) {
			problems.push({ key, problem: "unknown key" });
			continue;
		}
		const valid =
			typeof message === "string" ||
			(typeof message === "object" &&
				message !== null &&
				Object.values(message).every((form) => typeof form === "string"));
		if (!valid) {
			problems.push({ key, problem: "not text" });
			continue;
		}
		if (placeholders(message).join() !== placeholders(original).join()) {
			problems.push({ key, problem: "placeholders differ" });
		}
	}
	return problems;
}

/** Keys the source has and the translation lacks, for translators to fill in. */
export function missingKeys(source: Catalog, translation: Catalog): string[] {
	return Object.keys(source).filter((key) => !(key in translation));
}
