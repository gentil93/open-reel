import { CodedError, type ProviderEvent } from "@hatchlight/core";

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

/** Failures to connect at all: the request never left, so nothing was done. */
const NOT_CONNECTED = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ConnectionRefused",
	"FailedToOpenSocket",
]);

/**
 * Sends a request that starts paid work. A request that never reached the
 * provider may be sent again; any other failure may have been charged, so it
 * is not.
 */
export async function send(
	fetch: Fetch,
	url: string,
	init: RequestInit,
	provider: string,
): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		// Bun puts the code on the error; Node on its cause.
		const failure = error as { code?: unknown; cause?: { code?: unknown } };
		const code = failure.code ?? failure.cause?.code;
		if (
			!init.signal?.aborted &&
			typeof code === "string" &&
			NOT_CONNECTED.has(code)
		) {
			throw new CodedError(
				`Could not reach ${provider}`,
				"noConnection",
				{ provider },
				{},
			);
		}
		throw error;
	}
}

/** Refusals for now: the provider did nothing. */
const BUSY = [429, 503];
/**
 * For requests that do the paid work while the connection waits (OpenAI,
 * Gemini, OpenRouter pictures), a 503 may come from a gateway that gave up
 * after the work was done; only a 429 surely did nothing.
 */
export const BUSY_WHILE_WAITING = [429];

/**
 * Why a provider refused a request. A refusal for now (`busy`) did nothing
 * and may be tried again, after the wait the provider asks for; others are
 * final.
 */
export async function refusal(
	response: Response,
	provider: string,
	busy: number[] = BUSY,
): Promise<CodedError> {
	const message = await errorMessage(response);
	if (busy.includes(response.status)) {
		return new CodedError(
			message,
			"providerBusy",
			{ provider },
			{ afterMs: retryAfter(response) },
		);
	}
	return new CodedError(message);
}

/** A refusal as the event a job's `events` reports. */
export function failedEvent(error: CodedError): ProviderEvent {
	return {
		type: "failed",
		error: error.message,
		...(error.code && { code: error.code, params: error.params }),
		...(error.retry && { retry: error.retry }),
	};
}

/** The wait a `Retry-After` header asks for, in seconds or as a date. */
function retryAfter(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
