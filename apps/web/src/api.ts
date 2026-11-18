import type {
	Asset,
	CreateTurnInput,
	GalleryItem,
	LocalModelsView,
	ModelSpec,
	ProviderStatus,
	Session,
	Settings,
	TurnView,
} from "@open-reel/core/types";

export type SessionDetail = Session & { turns: TurnView[] };

/** An error from the server, with the code that lets the interface translate it. */
export class ApiError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly params?: Record<string, string | number>,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		throw new ApiError(
			body?.error ?? `Request failed (HTTP ${response.status})`,
			typeof body?.code === "string" ? body.code : undefined,
			body?.params ?? undefined,
		);
	}
	// 202 and 204 carry no body.
	return response.status === 200 || response.status === 201
		? response.json()
		: (undefined as T);
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
	retryJob: (id: string) =>
		request<void>(`/api/jobs/${id}/retry`, { method: "POST" }),
	upload: (file: File) =>
		request<Asset>("/api/assets", {
			method: "POST",
			headers: { "content-type": file.type },
			body: file,
		}),
	localModels: () => request<LocalModelsView>("/api/local-models"),
	installModel: (id: string, variant?: string) =>
		request<void>(
			`/api/local-models/${id}/install`,
			send("POST", variant ? { variant } : {}),
		),
	cancelModel: (id: string) =>
		request<void>(`/api/local-models/${id}/cancel`, { method: "POST" }),
	deleteModel: (id: string) =>
		request<void>(`/api/local-models/${id}`, { method: "DELETE" }),
	settings: () => request<Settings>("/api/settings"),
	saveSettings: (change: Partial<Settings>) =>
		request<Settings>("/api/settings", send("PUT", change)),
	moveModels: (path: string) =>
		request<void>("/api/local-models/location", send("POST", { path })),
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
/** A running job's latest picture; `version` changes the address per picture. */
export const previewUrl = (jobId: string, version: number) =>
	`/api/jobs/${jobId}/preview?v=${version}`;
/**
 * A model's demo. Pictures come smaller than their authors made them: a card
 * asks for "card", an enlarged view for "large". Videos ignore the size.
 */
export const demoUrl = (
	modelId: string,
	index: number,
	size: "card" | "large" = "card",
) => `/api/local-models/${modelId}/demos/${index}?size=${size}`;
