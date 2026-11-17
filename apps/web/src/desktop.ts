/**
 * What the desktop app offers this page. In a browser, none of it exists and
 * every call does nothing.
 */

interface TauriGlobal {
	core: {
		invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	};
	event: {
		listen<T>(
			event: string,
			handler: (event: { payload: T }) => void,
		): Promise<() => void>;
	};
}

const tauri = (): TauriGlobal | undefined =>
	(window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

export const isDesktop = () => tauri() != null;

/** The version of a downloaded update waiting to be installed, if any. */
export async function pendingUpdate(): Promise<string | null> {
	return (await tauri()?.core.invoke<string | null>("update_status")) ?? null;
}

/** Calls `handler` when an update has been downloaded. Returns a way to stop. */
export function onUpdateReady(handler: (version: string) => void): () => void {
	const listening = tauri()?.event.listen<string>("update-ready", (event) =>
		handler(event.payload),
	);
	return () => void listening?.then((stop) => stop());
}

/** Installs the waiting update; the app restarts into the new version. */
export async function installUpdate(): Promise<void> {
	await tauri()?.core.invoke("install_update");
}
