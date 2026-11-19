import type {
	ModelSpec,
	ProviderAdapter,
	ProviderEvent,
} from "@hatchlight/core";

export interface Call {
	url: string;
	method: string;
	auth: string | null;
	key?: string;
	body: Record<string, unknown> | null;
}

/** A fetch that answers from a script of responses, in order. */
export function scripted(responses: [status: number, body: unknown][]) {
	const calls: Call[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			auth: new Headers(init?.headers).get("authorization"),
			...(new Headers(init?.headers).has("x-goog-api-key") && {
				key: new Headers(init?.headers).get("x-goog-api-key") as string,
			}),
			body: init?.body ? JSON.parse(init.body as string) : null,
		});
		const next = responses.shift();
		if (!next) throw new Error(`Unexpected request: ${url}`);
		return Response.json(next[1], { status: next[0] });
	};
	return { fetch, calls };
}

export const ctx = () => ({
	apiKey: "k",
	signal: new AbortController().signal,
});
export const modelOf = (provider: ProviderAdapter, id: string) =>
	provider.listModels().find((m) => m.id === id) as ModelSpec;
export const params = (over: object = {}) => ({
	prompt: "a red fox",
	count: 1,
	referenceAssetIds: [],
	extras: {},
	...over,
});

export async function collect(events: AsyncIterable<ProviderEvent>) {
	const all: ProviderEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}
