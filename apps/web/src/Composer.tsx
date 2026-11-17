import type { Media, ModelSpec, ProviderStatus } from "@open-reel/core/types";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, assetUrl } from "./api";
import { useI18n } from "./i18n";
import { PickerDialog } from "./Picker";

export interface Draft {
	prompt: string;
	modelIds: string[];
	aspectRatio?: string;
	count: number;
	durationSeconds?: number;
}

interface Props {
	models: ModelSpec[];
	providers: ProviderStatus[];
	references: string[];
	setReferences(next: string[]): void;
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
}

const STORAGE_KEY = "open-reel.models";

/** Makes `ids` the models the composer starts with next time. */
export function rememberModels(ids: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
	} catch {
		// Storage can be unavailable; the composer then starts with none.
	}
}

function savedModels(): string[] {
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

export function Composer(props: Props) {
	const { models, providers, references, setReferences } = props;
	const { t, explain } = useI18n();
	const [prompt, setPrompt] = useState("");
	const [chosen, setChosen] = useState<string[]>(savedModels);
	const [aspectRatio, setAspectRatio] = useState("");
	const [count, setCount] = useState(1);
	const [media, setMedia] = useState<Media>("image");
	// The picker window, to find and set up another model.
	const [picking, setPicking] = useState(false);
	const [seconds, setSeconds] = useState<number | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const ready = new Set(
		providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
	);
	/** Why a model cannot be used right now, if it cannot. */
	const blocked = (model: ModelSpec): string | null => {
		if (!ready.has(model.providerId)) {
			return t("composer.blocked.needsKey", { model: model.name });
		}
		if (references.length > model.capabilities.maxReferenceImages) {
			return model.capabilities.maxReferenceImages === 0
				? t("composer.blocked.noReferences", { model: model.name })
				: t("composer.blocked.tooManyReferences", {
						model: model.name,
						count: model.capabilities.maxReferenceImages,
					});
		}
		return null;
	};
	// Images and videos are chosen separately: they differ in cost by orders of
	// magnitude, and nobody compares one against the other.
	const offered = models.filter((m) => m.media === media);
	const selected = offered.filter((m) => chosen.includes(m.id) && !blocked(m));
	const ratios = [
		...new Set(selected.flatMap((m) => m.capabilities.aspectRatios)),
	];
	const maxCount = Math.max(1, ...selected.map((m) => m.capabilities.maxCount));
	const durations = [
		...new Set(selected.flatMap((m) => m.capabilities.durations ?? [])),
	].sort((a, b) => a - b);

	// Without storage, the selection lasts for this visit only.
	useEffect(() => rememberModels(chosen), [chosen]);

	const upload = useMutation({
		mutationFn: api.upload,
		onSuccess: (asset) => setReferences([...references, asset.id]),
	});

	const canSend = prompt.trim() !== "" && selected.length > 0 && !props.busy;
	const submit = () => {
		if (!canSend) return;
		props.onSubmit({
			prompt: prompt.trim(),
			modelIds: selected.map((m) => m.id),
			aspectRatio: ratios.includes(aspectRatio) ? aspectRatio : undefined,
			count: Math.min(count, maxCount),
			// Unset, each model uses its shortest length.
			durationSeconds:
				seconds != null && durations.includes(seconds) ? seconds : undefined,
		});
		setPrompt("");
	};

	// Chosen models that have a key but are ruled out by the reference images.
	const overReferenceLimit =
		selected.length === 0 &&
		offered.some((m) => chosen.includes(m.id) && ready.has(m.providerId));
	const error =
		props.error ??
		(upload.error ? explain(upload.error) : null) ??
		(overReferenceLimit ? t("composer.tooManyReferences") : null);
	const control = "rounded-md border border-line bg-bg px-2 py-1.5 text-sm";

	return (
		<div className="border-t border-line bg-panel">
			<div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-4">
				{models.some((m) => m.media === "video") && (
					<div
						className="flex gap-1"
						role="tablist"
						aria-label={t("composer.output")}
					>
						{(["image", "video"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								role="tab"
								aria-selected={media === kind}
								onClick={() => setMedia(kind)}
								className={`rounded-md px-3 py-1 text-sm ${
									media === kind
										? "bg-line text-ink"
										: "text-dim hover:text-ink"
								}`}
							>
								{kind === "image" ? t("composer.images") : t("composer.video")}
							</button>
						))}
					</div>
				)}
				<fieldset className="flex flex-wrap items-center gap-1.5">
					<legend className="sr-only">{t("composer.models")}</legend>
					{offered
						.filter((m) => ready.has(m.providerId) || chosen.includes(m.id))
						.map((model) => {
							const reason = blocked(model);
							const on = chosen.includes(model.id) && !reason;
							return (
								<button
									key={model.id}
									type="button"
									aria-pressed={on}
									disabled={reason !== null}
									title={reason ?? model.id}
									onClick={() =>
										setChosen(
											on
												? chosen.filter((id) => id !== model.id)
												: [...chosen, model.id],
										)
									}
									className={`rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-40 ${
										on
											? "aurora border-transparent shadow-[0_0_14px_rgb(255_61_139/0.35)]"
											: "border-line text-dim hover:border-dim hover:text-ink"
									}`}
								>
									<span className="opacity-60">{model.providerId} · </span>
									{model.name}
								</button>
							);
						})}
					<button
						type="button"
						onClick={() => setPicking(true)}
						className="rounded-full border border-dashed border-line-strong px-3 py-1 text-sm text-dim transition-colors hover:border-accent hover:text-ink"
					>
						+ {t("composer.chooseModel")}
					</button>
				</fieldset>

				{references.length > 0 && (
					<ul
						className="flex flex-wrap gap-2"
						aria-label={t("composer.referenceImages")}
					>
						{references.map((id) => (
							<li key={id} className="relative">
								<img
									src={assetUrl(id)}
									alt={t("common.reference")}
									className="size-16 rounded-md border border-line object-cover"
								/>
								<button
									type="button"
									aria-label={t("composer.removeReference")}
									onClick={() =>
										setReferences(references.filter((r) => r !== id))
									}
									className="absolute -right-1.5 -top-1.5 size-5 rounded-full border border-line bg-panel text-xs leading-none"
								>
									×
								</button>
							</li>
						))}
					</ul>
				)}

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
							submit();
						}
					}}
					rows={2}
					placeholder={
						references.length > 0
							? media === "video"
								? t("composer.placeholder.motion")
								: t("composer.placeholder.change")
							: media === "video"
								? t("composer.placeholder.video")
								: t("composer.placeholder.image")
					}
					aria-label={t("composer.prompt")}
					className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 leading-relaxed"
				/>

				<div className="flex flex-wrap items-center gap-2">
					<label className="flex items-center gap-2 text-sm text-dim">
						{t("composer.ratio")}
						<select
							value={ratios.includes(aspectRatio) ? aspectRatio : ""}
							onChange={(event) => setAspectRatio(event.target.value)}
							disabled={ratios.length === 0}
							className={control}
						>
							<option value="">{t("composer.ratioDefault")}</option>
							{ratios.map((ratio) => (
								<option key={ratio}>{ratio}</option>
							))}
						</select>
					</label>
					{durations.length > 0 && (
						<label className="flex items-center gap-2 text-sm text-dim">
							{t("composer.length")}
							<select
								value={
									seconds != null && durations.includes(seconds) ? seconds : ""
								}
								onChange={(event) =>
									setSeconds(
										event.target.value ? Number(event.target.value) : null,
									)
								}
								className={control}
							>
								<option value="">{t("composer.lengthShortest")}</option>
								{durations.map((d) => (
									<option key={d} value={d}>
										{t("format.seconds", { seconds: d })}
									</option>
								))}
							</select>
						</label>
					)}
					<label
						className="flex items-center gap-2 text-sm text-dim"
						hidden={maxCount === 1 && media === "video"}
					>
						{media === "video"
							? t("composer.videoCount")
							: t("composer.imageCount")}
						<select
							value={Math.min(count, maxCount)}
							onChange={(event) => setCount(Number(event.target.value))}
							className={control}
						>
							{Array.from({ length: maxCount }, (_, i) => i + 1).map((n) => (
								<option key={n}>{n}</option>
							))}
						</select>
					</label>
					<input
						ref={fileInput}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						hidden
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) upload.mutate(file);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						onClick={() => fileInput.current?.click()}
						disabled={upload.isPending}
						className={`${control} text-dim hover:text-ink`}
					>
						{upload.isPending
							? t("composer.uploading")
							: t("composer.addReference")}
					</button>
					<span className="ml-auto text-sm text-danger" role="alert">
						{error}
					</span>
					<button
						type="button"
						onClick={submit}
						disabled={!canSend}
						className="cta rounded-lg px-5 py-2 font-display text-base font-bold"
					>
						{selected.length > 1
							? t("composer.compare", { count: selected.length })
							: t("composer.generate")}
					</button>
				</div>
			</div>
			{picking && (
				<PickerDialog
					media={media}
					onClose={() => setPicking(false)}
					onUse={(modelId, kind) => {
						setMedia(kind);
						setChosen((current) =>
							current.includes(modelId) ? current : [...current, modelId],
						);
						setPicking(false);
					}}
				/>
			)}
		</div>
	);
}
