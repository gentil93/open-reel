import { useSyncExternalStore } from "react";

export type Route =
	| { view: "chat"; sessionId?: string }
	| { view: "gallery" }
	| { view: "models" }
	| { view: "settings" };

function parse(hash: string): Route {
	const [, first, second] = hash.replace(/^#/, "").split("/");
	if (first === "gallery") return { view: "gallery" };
	if (first === "models") return { view: "models" };
	if (first === "settings") return { view: "settings" };
	if (first === "s" && second) return { view: "chat", sessionId: second };
	return { view: "chat" };
}

const subscribe = (notify: () => void) => {
	window.addEventListener("hashchange", notify);
	return () => window.removeEventListener("hashchange", notify);
};

export function useRoute(): Route {
	const hash = useSyncExternalStore(subscribe, () => window.location.hash);
	return parse(hash);
}

export const href = {
	newChat: "#/",
	session: (id: string) => `#/s/${id}`,
	gallery: "#/gallery",
	models: "#/models",
	settings: "#/settings",
};

export function navigate(to: string): void {
	window.location.hash = to;
}
