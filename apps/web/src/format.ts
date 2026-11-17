import type { I18n } from "./i18n";

type Formatter = Pick<I18n, "t" | "number">;

export function duration(i18n: Formatter, ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) {
		return i18n.t("format.seconds", {
			seconds: i18n.number(seconds, {
				minimumFractionDigits: 1,
				maximumFractionDigits: 1,
			}),
		});
	}
	return i18n.t("format.minutesSeconds", {
		minutes: Math.floor(seconds / 60),
		seconds: Math.round(seconds % 60),
	});
}

export function usd(i18n: Formatter, value: number): string {
	const digits = value < 0.1 ? 3 : 2;
	return i18n.number(value, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
}

/** A rough time left, for long downloads. */
export function remaining(i18n: Formatter, seconds: number): string {
	if (seconds < 60) return i18n.t("format.remaining.underMinute");
	if (seconds < 3600) {
		return i18n.t("format.remaining.minutes", {
			minutes: Math.round(seconds / 60),
		});
	}
	return i18n.t("format.remaining.hours", {
		hours: Math.floor(seconds / 3600),
		minutes: Math.round((seconds % 3600) / 60),
	});
}
