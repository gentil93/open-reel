import { useSyncExternalStore } from "react";

export type Route =
	/** A session; `talk` shows the conversation with the assistant. */
	| { view: "chat"; sessionId?: string; talk: boolean }
	| { view: "gallery" }
	| { view: "models" }
	| { view: "settings" };

function parse(hash: string): Route {
	const [, first, second, third] = hash.replace(/^#/, "").split("/");
	if (first === "gallery") return { view: "gallery" };
	if (first === "models") return { view: "models" };
	if (first === "settings") return { view: "settings" };
	if (first === "talk") return { view: "chat", talk: true };
	if (first === "s" && second) {
		return { view: "chat", sessionId: second, talk: third === "talk" };
	}
	return { view: "chat", talk: false };
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
	newTalk: "#/talk",
	talk: (id: string) => `#/s/${id}/talk`,
	gallery: "#/gallery",
	models: "#/models",
	settings: "#/settings",
};

export function navigate(to: string): void {
	window.location.hash = to;
}
