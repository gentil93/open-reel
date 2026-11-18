import type {
	Asset,
	CreateTurnInput,
	GalleryItem,
	ModelSpec,
	ProviderStatus,
	Session,
	TurnView,
} from "@open-reel/core/types";
import type { Reel, SessionDetail } from "@open-reel/tools";

/** An error the open-reel server answered with. */
export class ServerError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
	) {
		super(message);
	}
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Talks to a running open-reel server, over its HTTP API. */
export class OpenReelClient implements Reel {
	constructor(
		readonly baseUrl: string,
		// The global one: inside these parameters, `fetch` names this one.
		private fetch: Fetch = (url, init) => globalThis.fetch(url, init),
	) {}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.fetch(`${this.baseUrl}${path}`, init);
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: string;
				code?: string;
			} | null;
			throw new ServerError(
				body?.error ?? `open-reel answered ${response.status}`,
				response.status,
				body?.code ?? null,
			);
		}
		return (await response.json()) as T;
	}

	models = () => this.request<ModelSpec[]>("/api/models");
	providers = () => this.request<ProviderStatus[]>("/api/providers");
	session = (id: string) =>
		this.request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);

	createTurn = (input: CreateTurnInput) =>
		this.request<{ session: Session; turn: TurnView }>("/api/turns", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});

	upload = (data: Uint8Array) =>
		this.request<Asset>("/api/assets", { method: "POST", body: data });

	gallery = (options: { query?: string; limit?: number }) => {
		const search = new URLSearchParams();
		if (options.query) search.set("query", options.query);
		search.set("limit", String(options.limit ?? 20));
		return this.request<GalleryItem[]>(`/api/gallery?${search}`);
	};

	/** An asset's bytes and type. */
	async asset(id: string): Promise<{ data: Uint8Array; mime: string }> {
		const response = await this.fetch(
			`${this.baseUrl}/api/assets/${encodeURIComponent(id)}`,
		);
		if (!response.ok) {
			throw new ServerError(
				`No picture or video with id ${id}`,
				response.status,
				"assetNotFound",
			);
		}
		return {
			data: new Uint8Array(await response.arrayBuffer()),
			mime: response.headers.get("content-type") ?? "application/octet-stream",
		};
	}

	/** Where a person can see a session in the app. */
	sessionUrl = (id: string) => `${this.baseUrl}/#/s/${encodeURIComponent(id)}`;
}
