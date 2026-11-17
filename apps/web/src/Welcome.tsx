import type {
	Fit,
	LocalModelStatus,
	ModelSpec,
	ProviderStatus,
} from "@open-reel/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useState } from "react";
import { api } from "./api";
import { type Draft, rememberModels } from "./Composer";
import { usd } from "./format";
import { useI18n } from "./i18n";
import { useModelProgress } from "./live";
import { fitText } from "./Models";

/** Where each service hands out API keys. */
const KEY_PAGES: Record<string, string> = {
	fal: "https://fal.ai/dashboard/keys",
	openai: "https://platform.openai.com/api-keys",
	google: "https://aistudio.google.com/apikey",
	replicate: "https://replicate.com/account/api-tokens",
	openrouter: "https://openrouter.ai/settings/keys",
};

const FIT_ORDER: Fit[] = ["gpu", "offload", "cpu", "none"];
/** Few-step models, which make a first picture in seconds, fastest first. */
const QUICK_MODELS = ["sdxl-turbo", "z-image-turbo", "flux-schnell"];

/** The local model most likely to give a good first picture here, soonest. */
function firstLocalModel(
	models: LocalModelStatus[],
): LocalModelStatus | undefined {
	const fit = (model: LocalModelStatus) =>
		FIT_ORDER.indexOf(
			model.variants.find((v) => v.id === model.variant)?.fit ?? "none",
		);
	const quick = (model: LocalModelStatus) => {
		const index = QUICK_MODELS.indexOf(model.id);
		return index === -1 ? QUICK_MODELS.length : index;
	};
	return models
		.filter((m) => m.media === "image" && m.variant != null)
		.sort(
			(a, b) =>
				Number(b.ready) - Number(a.ready) ||
				Number(b.state !== "available") - Number(a.state !== "available") ||
				fit(a) - fit(b) ||
				quick(a) - quick(b) ||
				a.size - b.size,
		)[0];
}

const price = (model: ModelSpec) =>
	model.pricing?.usdPerOutput ?? Number.POSITIVE_INFINITY;

/** The model a first picture should use: free first, then the cheapest. */
export function firstModel(
	models: ModelSpec[],
	providers: ProviderStatus[],
): ModelSpec | undefined {
	const ready = new Set(
		providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
	);
	return models
		.filter((m) => m.media === "image" && ready.has(m.providerId))
		.sort((a, b) => price(a) - price(b))[0];
}

function Step(props: {
	number: string;
	title: string;
	active: boolean;
	children: ReactNode;
}) {
	return (
		<section
			className={`rise-in border-t border-line pt-6 transition-opacity duration-500 ${props.active ? "" : "opacity-40"}`}
			style={{ "--i": Number(props.number) + 2 } as CSSProperties}
		>
			<h2 className="flex items-baseline gap-3">
				<span className="font-mono text-xs tracking-wider text-accent">
					{props.number}
				</span>
				<span className="font-display text-2xl font-bold uppercase tracking-wide">
					{props.title}
				</span>
			</h2>
			<div className="mt-4">{props.children}</div>
		</section>
	);
}

function LocalChoice({ model }: { model: LocalModelStatus }) {
	const i18n = useI18n();
	const { t } = i18n;
	const progress = useModelProgress(model.id);
	const install = useMutation({ mutationFn: () => api.installModel(model.id) });
	const fit = model.variants.find((v) => v.id === model.variant)?.fit;
	const busy = model.state !== "available" && !model.ready;
	const received = progress?.receivedBytes ?? model.receivedBytes;
	const total = progress?.size ?? model.size;

	return (
		<div className="flex h-full flex-col gap-3">
			<p className="text-sm leading-relaxed text-dim">
				{t("welcome.local.body", {
					model: model.name,
					size: i18n.bytes(model.size),
				})}
			</p>
			{fit && (
				<p className="font-mono text-[11px] uppercase tracking-wider text-dim">
					{fitText(t, fit)}
				</p>
			)}
			<div className="mt-auto">
				{busy ? (
					<div className="flex flex-col gap-2" aria-live="polite">
						<div className="h-1 overflow-hidden rounded bg-line">
							<div
								className="h-full bg-accent transition-[width] duration-500"
								style={{
									width: `${total ? Math.round((received / total) * 100) : 0}%`,
								}}
							/>
						</div>
						<p className="font-mono text-xs text-dim">
							{model.state === "queued"
								? t("models.progress.queued")
								: model.state === "verifying"
									? t("models.progress.verifying")
									: t("models.progress.received", {
											received: i18n.bytes(received),
											total: i18n.bytes(total),
										})}
						</p>
					</div>
				) : (
					<button
						type="button"
						onClick={() => install.mutate()}
						disabled={install.isPending}
						className="w-full rounded-md border border-line-strong px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
					>
						{t("welcome.local.install", { size: i18n.bytes(model.size) })}
					</button>
				)}
				{(install.error || model.error) && (
					<p className="mt-2 text-sm text-danger">
						{install.error
							? i18n.explain(install.error)
							: i18n.explain({
									message: model.error ?? "",
									code: model.errorCode,
									params: model.errorParams,
								})}
					</p>
				)}
			</div>
		</div>
	);
}

function KeyChoice({ providers }: { providers: ProviderStatus[] }) {
	const { t, explain } = useI18n();
	const client = useQueryClient();
	const options = providers.filter((p) => p.requiresKey);
	const [chosen, setChosen] = useState(options[0]?.id ?? "");
	const [key, setKey] = useState("");
	// Derived, not stored: the providers may arrive after the first render.
	const provider = options.find((p) => p.id === chosen) ?? options[0];
	const save = useMutation({
		mutationFn: () => api.setKey(provider?.id ?? chosen, key.trim()),
		onSuccess: () => {
			setKey("");
			return client.invalidateQueries({ queryKey: ["providers"] });
		},
	});
	if (!provider) return null;

	return (
		<form
			className="flex h-full flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (key.trim()) save.mutate();
			}}
		>
			<p className="text-sm leading-relaxed text-dim">
				{t("welcome.key.body")}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{options.map((option) => (
					<button
						key={option.id}
						type="button"
						aria-pressed={option.id === provider.id}
						onClick={() => setChosen(option.id)}
						className={`rounded-full border px-3 py-1 text-xs transition-colors ${
							option.id === provider.id
								? "border-accent bg-accent text-accent-ink"
								: "border-line-strong text-dim hover:text-ink"
						}`}
					>
						{option.name}
					</button>
				))}
			</div>
			<div className="mt-auto flex flex-col gap-2">
				<div className="flex gap-2">
					<input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={t("settings.pasteKey")}
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
				</div>
				{KEY_PAGES[provider.id] && (
					<a
						href={KEY_PAGES[provider.id]}
						target="_blank"
						rel="noreferrer"
						className="text-xs text-dim underline decoration-line-strong underline-offset-4 hover:text-accent"
					>
						{t("welcome.key.get", { provider: provider.name })}
					</a>
				)}
				{save.error && (
					<p className="text-sm text-danger">{explain(save.error)}</p>
				)}
			</div>
		</form>
	);
}

/**
 * The first screen a new user sees: pick where pictures are made, then
 * develop a first one. Everything after that happens in a normal session.
 */
export function Welcome(props: {
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
	onSkip(): void;
}) {
	const i18n = useI18n();
	const { t } = i18n;
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const local = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	// Prompts that work on any model, with the short label each chip shows.
	const suggestions = [
		{
			prompt: t("welcome.suggestion.lighthouse"),
			label: t("welcome.suggestion.lighthouse.short"),
		},
		{
			prompt: t("welcome.suggestion.ramen"),
			label: t("welcome.suggestion.ramen.short"),
		},
		{
			prompt: t("welcome.suggestion.fox"),
			label: t("welcome.suggestion.fox.short"),
		},
		{
			prompt: t("welcome.suggestion.city"),
			label: t("welcome.suggestion.city.short"),
		},
	];
	const [prompt, setPrompt] = useState(
		() =>
			suggestions[Math.floor(Math.random() * suggestions.length)]?.prompt ?? "",
	);

	const model = firstModel(models.data ?? [], providers.data ?? []);
	const localModel = firstLocalModel(local.data?.models ?? []);
	const canSend = model != null && prompt.trim() !== "" && !props.busy;
	const send = () => {
		if (!model || !canSend) return;
		// The composer carries on with the same model afterwards.
		rememberModels([model.id]);
		props.onSubmit({ prompt: prompt.trim(), modelIds: [model.id], count: 1 });
	};

	return (
		<div className="flex flex-col gap-8 py-10">
			<header className="rise-in flex flex-col gap-4">
				<p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-dim">
					<i
						aria-hidden="true"
						className="inline-block size-2 animate-pulse rounded-full bg-accent shadow-[0_0_12px_var(--accent)]"
					/>
					{t("welcome.eyebrow")}
				</p>
				<h1 className="font-display text-5xl leading-[0.9] font-black uppercase tracking-wide sm:text-7xl">
					{t("welcome.title")}{" "}
					<span className="text-accent">{t("welcome.titleAccent")}</span>
				</h1>
				<p className="max-w-xl leading-relaxed text-dim">{t("welcome.lede")}</p>
			</header>

			<Step number="01" title={t("welcome.step.source")} active={!model}>
				{model ? (
					<p className="text-sm text-dim">
						{t("welcome.ready", { model: model.name })}
						{model.pricing?.usdPerOutput != null &&
							` · ${
								model.pricing.usdPerOutput === 0
									? t("welcome.free")
									: t("welcome.perPicture", {
											price: usd(i18n, model.pricing.usdPerOutput),
										})
							}`}
					</p>
				) : (
					<div className="grid gap-3 md:grid-cols-2">
						<div className="flex flex-col rounded-lg border border-line bg-panel p-5 transition-colors hover:border-line-strong">
							<h3 className="font-medium">{t("welcome.local.title")}</h3>
							<p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-accent">
								{t("welcome.local.tag")}
							</p>
							{localModel ? (
								<LocalChoice model={localModel} />
							) : (
								<p className="text-sm leading-relaxed text-dim">
									{local.isPending
										? t("gallery.loading")
										: t("welcome.local.none")}
								</p>
							)}
						</div>
						<div className="flex flex-col rounded-lg border border-line bg-panel p-5 transition-colors hover:border-line-strong">
							<h3 className="font-medium">{t("welcome.key.title")}</h3>
							<p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-accent">
								{t("welcome.key.tag")}
							</p>
							<KeyChoice providers={providers.data ?? []} />
						</div>
					</div>
				)}
			</Step>

			<Step number="02" title={t("welcome.step.prompt")} active={model != null}>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						send();
					}}
				>
					<textarea
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing
							) {
								event.preventDefault();
								send();
							}
						}}
						rows={2}
						aria-label={t("composer.prompt")}
						disabled={!model}
						className="w-full resize-none rounded-lg border border-line bg-panel px-4 py-3 text-lg leading-snug disabled:opacity-60"
					/>
					<div className="flex flex-wrap items-center gap-2">
						{suggestions.map((suggestion) => (
							<button
								key={suggestion.prompt}
								type="button"
								disabled={!model}
								onClick={() => setPrompt(suggestion.prompt)}
								className="rounded-full border border-line px-3 py-1 text-xs text-dim transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
							>
								{suggestion.label}
							</button>
						))}
						<button
							type="submit"
							disabled={!canSend}
							className="ml-auto rounded-md bg-accent px-5 py-2.5 font-display text-lg font-bold uppercase tracking-wider text-accent-ink shadow-[0_0_24px_rgb(240_166_58/0.35)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_0_36px_rgb(240_166_58/0.5)] disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
						>
							{t("welcome.develop")}
						</button>
					</div>
					{props.error && <p className="text-sm text-danger">{props.error}</p>}
				</form>
			</Step>

			<button
				type="button"
				onClick={props.onSkip}
				className="rise-in self-start text-sm text-dim underline decoration-line-strong underline-offset-4 hover:text-ink"
				style={{ "--i": 6 } as CSSProperties}
			>
				{t("welcome.skip")}
			</button>
		</div>
	);
}
