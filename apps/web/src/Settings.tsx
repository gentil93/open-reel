import type { ProviderStatus } from "@open-reel/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";

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
