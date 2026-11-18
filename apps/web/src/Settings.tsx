import type { ProviderStatus } from "@open-reel/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { useModelProgress } from "./live";

function ProviderRow({ provider }: { provider: ProviderStatus }) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const [key, setKey] = useState("");
	const done = () => {
		setKey("");
		return client.invalidateQueries({ queryKey: ["providers"] });
	};
	const save = useMutation({
		mutationFn: () => api.setKey(provider.id, key),
		onSuccess: done,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteKey(provider.id),
		onSuccess: done,
	});
	const error = save.error ?? remove.error;

	return (
		<li className="rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h3 className="font-medium">{provider.name}</h3>
				<span
					className={`font-mono text-xs ${provider.hasKey ? "text-accent" : "text-dim"}`}
				>
					{provider.hasKey
						? t("settings.keyConfigured")
						: provider.requiresKey
							? t("settings.noKey")
							: t("settings.noKeyNeeded")}
				</span>
			</div>
			{provider.requiresKey && (
				<form
					className="mt-3 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={
							provider.hasKey
								? t("settings.replaceKey")
								: t("settings.pasteKey")
						}
						aria-label={t("settings.keyLabel", { provider: provider.name })}
						autoComplete="off"
						className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm"
					/>
					<button
						type="submit"
						disabled={!key.trim() || save.isPending}
						className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
					>
						{t("settings.save")}
					</button>
					{provider.hasKey && (
						<button
							type="button"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
							className="rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
						>
							{t("settings.remove")}
						</button>
					)}
				</form>
			)}
			{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
		</li>
	);
}

/**
 * The small language model that puts prompts into English for the models
 * that read only English: installed here, like any local model.
 */
function Translation() {
	const { t, bytes, explain } = useI18n();
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const model = view.data?.models.find((m) =>
		m.tasks.includes("prompt-translation"),
	);
	const live = useModelProgress(model?.id ?? "");
	const id = model?.id ?? "";
	const install = useMutation({ mutationFn: () => api.installModel(id) });
	const cancel = useMutation({ mutationFn: () => api.cancelModel(id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(id) });
	if (!model) return null;
	const busy = ["queued", "downloading", "verifying"].includes(
		live?.state ?? model.state,
	);
	const received = live?.receivedBytes ?? model.receivedBytes;
	const size = live?.size ?? model.size;
	const percent = Math.round((received / Math.max(size, 1)) * 100);
	const error = install.error ?? remove.error;
	return (
		<section className="mt-10">
			<h2 className="font-medium">{t("settings.translation")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("settings.translationIntro")}
			</p>
			<div className="mt-4 rounded-lg border border-line bg-panel p-4">
				<div className="flex items-baseline justify-between gap-4">
					<h3 className="font-medium">{model.name}</h3>
					<span
						className={`font-mono text-xs ${model.ready ? "text-accent" : "text-dim"}`}
					>
						{model.ready
							? t("settings.translationOn")
							: t("settings.translationOff")}
					</span>
				</div>
				{busy ? (
					<div className="mt-3 flex items-center gap-3">
						<div
							role="progressbar"
							aria-label={t("settings.translation")}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={percent}
							className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"
						>
							<div
								className="h-full rounded-full bg-accent transition-[width] duration-300"
								style={{ width: `${percent}%` }}
							/>
						</div>
						<span className="font-mono text-xs text-dim">
							{bytes(received)} / {bytes(size)}
						</span>
						<button
							type="button"
							onClick={() => cancel.mutate()}
							className="rounded-md border border-line px-3 py-1.5 text-sm text-dim hover:text-ink"
						>
							{t("common.cancel")}
						</button>
					</div>
				) : model.ready ? (
					<button
						type="button"
						onClick={() => remove.mutate()}
						disabled={remove.isPending}
						className="mt-3 rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
					>
						{t("settings.remove")}
					</button>
				) : (
					<button
						type="button"
						onClick={() => install.mutate()}
						disabled={install.isPending}
						className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
					>
						{t("settings.translationInstall", { size: bytes(size) })}
					</button>
				)}
				{model.error && !busy && (
					<p className="mt-2 text-sm text-danger">
						{explain({
							message: model.error,
							code: model.errorCode ?? null,
							params: model.errorParams ?? null,
						})}
					</p>
				)}
				{error && <p className="mt-2 text-sm text-danger">{explain(error)}</p>}
			</div>
		</section>
	);
}

export function Settings() {
	const { t, explain, language, setLanguage, languages } = useI18n();
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	return (
		<div className="mx-auto w-full max-w-2xl overflow-y-auto p-8">
			<h1 className="font-display text-4xl leading-none font-extrabold tracking-tight">
				{t("settings.title")}
			</h1>
			<section className="mt-6">
				<h2 className="font-medium">{t("settings.language")}</h2>
				<select
					value={language}
					onChange={(event) => setLanguage(event.target.value)}
					aria-label={t("settings.language")}
					className="mt-3 rounded-md border border-line bg-panel px-3 py-2 text-sm"
				>
					{languages.map((option) => (
						<option key={option.code} value={option.code} lang={option.code}>
							{option.name}
						</option>
					))}
				</select>
			</section>
			<Translation />
			<h2 className="mt-10 font-medium">{t("settings.providers")}</h2>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				{t("settings.providersIntro")}
			</p>
			{providers.error && (
				<p className="mt-6 text-sm text-danger">{explain(providers.error)}</p>
			)}
			<ul className="mt-6 flex flex-col gap-3">
				{providers.data?.map((provider) => (
					<ProviderRow key={provider.id} provider={provider} />
				))}
			</ul>
		</div>
	);
}
