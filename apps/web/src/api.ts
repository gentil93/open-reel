import type {
	Asset,
	CreateTurnInput,
	GalleryItem,
	ModelSpec,
	ProviderStatus,
	Session,
	TurnView,
} from "@open-reel/core/types";

export type SessionDetail = Session & { turns: TurnView[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
	}
	return response.status === 204 ? (undefined as T) : response.json();
}

const send = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

export const api = {
	models: () => request<ModelSpec[]>("/api/models"),
	providers: () => request<ProviderStatus[]>("/api/providers"),
	setKey: (id: string, key: string) =>
		request<void>(`/api/providers/${id}/key`, send("PUT", { key })),
	deleteKey: (id: string) =>
		request<void>(`/api/providers/${id}/key`, { method: "DELETE" }),
	sessions: () => request<Session[]>("/api/sessions"),
	session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
	deleteSession: (id: string) =>
		request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
	createTurn: (input: CreateTurnInput) =>
		request<{ session: Session; turn: TurnView }>(
			"/api/turns",
			send("POST", input),
		),
	cancelJob: (id: string) =>
		request<void>(`/api/jobs/${id}/cancel`, { method: "POST" }),
	upload: (file: File) =>
		request<Asset>("/api/assets", {
			method: "POST",
			headers: { "content-type": file.type },
			body: file,
		}),
	gallery: (query: string, before?: GalleryItem) => {
		const search = new URLSearchParams({ limit: String(GALLERY_PAGE) });
		if (query) search.set("query", query);
		if (before) {
			search.set("before", String(before.createdAt));
			search.set("beforeId", before.id);
		}
		return request<GalleryItem[]>(`/api/gallery?${search}`);
	},
};

export const GALLERY_PAGE = 60;
export const assetUrl = (id: string) => `/api/assets/${id}`;
