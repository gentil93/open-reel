import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { installUpdate, onUpdateReady, pendingUpdate } from "./desktop";
import { useI18n } from "./i18n";

/** Offers a downloaded update in the desktop app. Nothing shows in a browser. */
export function UpdateToast() {
	const { t } = useI18n();
	const [version, setVersion] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const install = useMutation({ mutationFn: installUpdate });

	useEffect(() => {
		// Listening first, so an update that lands meanwhile is not missed.
		const stop = onUpdateReady(setVersion);
		pendingUpdate()
			.then((found) => found && setVersion(found))
			.catch(() => {});
		return stop;
	}, []);

	if (!version || dismissed) return null;
	return (
		<div
			role="status"
			className="rise-in fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-3 rounded-xl border border-line-strong bg-panel/95 p-4 shadow-2xl backdrop-blur"
		>
			<p className="text-sm">
				<span className="font-semibold">{t("update.ready", { version })}</span>{" "}
				<span className="text-dim">{t("update.body")}</span>
			</p>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={() => install.mutate()}
					disabled={install.isPending}
					className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink disabled:opacity-60"
				>
					{install.isPending ? t("update.installing") : t("update.restart")}
				</button>
				<button
					type="button"
					onClick={() => setDismissed(true)}
					disabled={install.isPending}
					className="rounded-lg px-3 py-1.5 text-sm text-dim hover:text-ink"
				>
					{t("update.later")}
				</button>
			</div>
			{install.error && (
				<p className="text-sm text-danger">{t("update.failed")}</p>
			)}
		</div>
	);
}
