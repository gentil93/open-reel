export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Sleeps, rejecting as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function toDataUri(data: Uint8Array, mime: string): string {
	return `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
}

/** Pulls a human-readable message out of a provider's error body. */
export async function errorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	try {
		const body = JSON.parse(text);
		const detail =
			body.detail ?? body.error?.message ?? body.error ?? body.message;
		if (typeof detail === "string") return detail;
		if (detail) return JSON.stringify(detail);
	} catch {}
	return text.slice(0, 300) || `HTTP ${response.status}`;
}
