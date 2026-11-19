import type { Media } from "@hatchlight/core/types";
import { type CSSProperties, useState } from "react";
import { type Draft, rememberModels } from "./Composer";
import { useI18n } from "./i18n";
import { Picker } from "./Picker";

/** Writes the first prompt, once a model is ready. */
function FirstPrompt(props: {
	modelId: string;
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
}) {
	const { t } = useI18n();
	// Prompts that work on any model, with the short label each chip shows.
	const suggestions = [
		{
			prompt: t("welcome.suggestion.fox"),
			label: t("welcome.suggestion.fox.short"),
		},
		{
			prompt: t("welcome.suggestion.lighthouse"),
			label: t("welcome.suggestion.lighthouse.short"),
		},
		{
			prompt: t("welcome.suggestion.ramen"),
			label: t("welcome.suggestion.ramen.short"),
		},
		{
			prompt: t("welcome.suggestion.city"),
			label: t("welcome.suggestion.city.short"),
		},
	];
	const [prompt, setPrompt] = useState(() => suggestions[0]?.prompt ?? "");
	const canSend = prompt.trim() !== "" && !props.busy;
	const send = () => {
		if (!canSend) return;
		// The composer carries on with the same model afterwards.
		rememberModels([props.modelId]);
		props.onSubmit({
			prompt: prompt.trim(),
			modelIds: [props.modelId],
			count: 1,
		});
	};

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<div className="flex flex-wrap gap-2">
				<input
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					aria-label={t("welcome.prompt")}
					placeholder={t("welcome.prompt")}
					className="min-w-0 flex-[1_1_18rem] rounded-xl border border-line-strong bg-bg px-4 py-3 text-base"
				/>
				<button
					type="submit"
					disabled={!canSend}
					className="cta rounded-xl px-6 py-3 font-display text-base font-bold"
				>
					{props.busy ? t("welcome.generating") : t("welcome.generate")}
				</button>
			</div>
			<div className="flex flex-wrap gap-1.5">
				{suggestions.map((suggestion) => (
					<button
						key={suggestion.prompt}
						type="button"
						onClick={() => setPrompt(suggestion.prompt)}
						className="rounded-full border border-line px-3 py-1 text-xs text-dim transition-colors hover:border-line-strong hover:text-ink"
					>
						{suggestion.label}
					</button>
				))}
			</div>
			{props.error && <p className="text-sm text-danger">{props.error}</p>}
		</form>
	);
}

/**
 * The first screen a new user sees: choose a model, seeing how they differ
 * and which runs best here, then generate a first picture. Everything after
 * that happens in a normal session.
 */
export function Welcome(props: {
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
	onSkip(): void;
}) {
	const { t } = useI18n();
	const [media, setMedia] = useState<Media>("image");

	return (
		<div className="relative flex flex-col gap-8 py-8">
			<div className="sky" aria-hidden="true" />
			<header className="rise-in relative flex flex-col gap-3">
				<h1 className="font-display text-4xl leading-[0.98] font-extrabold tracking-tight text-balance sm:text-6xl">
					{t("welcome.title")}{" "}
					<span className="aurora-text">{t("welcome.titleAccent")}</span>
				</h1>
				<p className="max-w-[58ch] text-base leading-relaxed text-dim">
					{t("welcome.lede")}
				</p>
			</header>

			<div className="relative">
				<Picker
					media={media}
					setMedia={setMedia}
					ready={(modelId) => (
						<FirstPrompt
							modelId={modelId}
							busy={props.busy}
							error={props.error}
							onSubmit={props.onSubmit}
						/>
					)}
				/>
			</div>

			<button
				type="button"
				onClick={props.onSkip}
				className="rise-in relative self-start text-sm text-dim underline decoration-line-strong underline-offset-4 hover:text-ink"
				style={{ "--i": 8 } as CSSProperties}
			>
				{t("welcome.skip")}
			</button>
		</div>
	);
}
