import {
	MAX_LORAS,
	type Media,
	type ModelSpec,
	type ProviderStatus,
} from "@hatchlight/core/types";
import { useMutation } from "@tanstack/react-query";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { Adjust } from "./Adjust";
import { api, assetUrl } from "./api";
import { Extend } from "./Extend";
import { useI18n } from "./i18n";
import { type ChosenLora, LoraPicker, useLoras } from "./Loras";
import { MaskPainter } from "./MaskPainter";
import { PickerDialog } from "./Picker";

export interface Draft {
	prompt: string;
	modelIds: string[];
	aspectRatio?: string;
	count: number;
	durationSeconds?: number;
	/** How much a model that redraws the reference changes it. */
	strength?: number;
	/** The area of the reference to redraw; the rest is kept. */
	maskAssetId?: string;
	/** LoRAs for the models that take them. */
	loras?: ChosenLora[];
}

interface Props {
	models: ModelSpec[];
	providers: ProviderStatus[];
	references: string[];
	setReferences: Dispatch<SetStateAction<string[]>>;
	busy: boolean;
	error: string | null;
	onSubmit(draft: Draft): void;
	/** Shown under the prompt: the session's results. */
	children?: ReactNode;
}

const STORAGE_KEY = "hatchlight.models";

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
	const { t, explain, number, language } = useI18n();
	const [prompt, setPrompt] = useState("");
	const [chosen, setChosen] = useState<string[]>(savedModels);
	const [aspectRatio, setAspectRatio] = useState("");
	const [count, setCount] = useState(1);
	const [media, setMedia] = useState<Media>("image");
	// The picker window, to find and set up another model.
	const [picking, setPicking] = useState(false);
	const [seconds, setSeconds] = useState<number | null>(null);
	// Unset, the slider shows the chosen models' own strength.
	const [moved, setStrength] = useState<number | null>(null);
	const [loras, setLoras] = useState<ChosenLora[]>([]);
	const known = useLoras();
	const fileInput = useRef<HTMLInputElement>(null);
	// The area of the reference to redraw, for the reference it was marked on.
	const [mask, setMask] = useState<{
		reference: string;
		id: string;
		/** The marks as painted, to show over the picture. */
		marks: string;
	} | null>(null);
	const [painting, setPainting] = useState(false);
	const [extending, setExtending] = useState(false);
	// The reference being turned or cropped.
	const [adjusting, setAdjusting] = useState<string | null>(null);
	// A richer prompt offered for the one written; nothing changes until used.
	const [suggestion, setSuggestion] = useState<string | null>(null);
	const [improving, setImproving] = useState<AbortController | null>(null);
	const [improveError, setImproveError] = useState<unknown>(null);
	const [only] = references.length === 1 ? references : [];
	const marked = only != null && mask?.reference === only ? mask : null;
	const maskId = marked?.id ?? null;
	// Marking an area is offered when a picture model here can use it.
	const canMask = models.some(
		(m) => m.media === "image" && m.capabilities.mask != null,
	);

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
		if (maskId && model.capabilities.mask == null) {
			return t("composer.blocked.noMask", { model: model.name });
		}
		return null;
	};
	// Images and videos are chosen separately: they differ in cost by orders of
	// magnitude, and nobody compares one against the other.
	// An upscaler is offered on pictures made, not here.
	const offered = models.filter(
		(m) => m.media === media && m.capabilities.upscale == null,
	);
	const selected = offered.filter((m) => chosen.includes(m.id) && !blocked(m));
	const offeredRatios = [
		...new Set(selected.flatMap((m) => m.capabilities.aspectRatios)),
	];
	const maxCount = Math.max(1, ...selected.map((m) => m.capabilities.maxCount));
	const durations = [
		...new Set(selected.flatMap((m) => m.capabilities.durations ?? [])),
	].sort((a, b) => a - b);
	// Some models redraw the reference picture: how much is up to the person.
	const redrawer = selected.find((m) => m.capabilities.strength != null);
	const redrawing = references.length > 0 && redrawer != null;
	// A marked part is redrawn more than a whole picture, unless moved.
	const strength =
		moved ??
		(maskId
			? (redrawer?.capabilities.mask ?? redrawer?.capabilities.strength)
			: redrawer?.capabilities.strength);
	// LoRAs are offered for the families the chosen models take.
	const loraBases = [
		...new Set(selected.flatMap((m) => m.capabilities.loraBase ?? [])),
	];
	// At most MAX_LORAS for each family: each model gets its own family's.
	const sentLoras = loraBases.flatMap((base) =>
		loras
			.filter((chosen) =>
				known.data?.some((lora) => lora.id === chosen.id && lora.base === base),
			)
			.slice(0, MAX_LORAS),
	);
	// A redrawn picture keeps the reference's shape: no ratio to choose.
	const ratios =
		redrawing && selected.every((m) => m.capabilities.strength != null)
			? []
			: offeredRatios;

	// Without storage, the selection lasts for this visit only.
	useEffect(() => rememberModels(chosen), [chosen]);

	// Open on the kind of output the remembered models make, e.g. after a
	// first video chosen in the welcome.
	const settled = useRef(false);
	useEffect(() => {
		if (settled.current || models.length === 0) return;
		settled.current = true;
		const kinds = models
			.filter((m) => chosen.includes(m.id))
			.map((m) => m.media);
		if (kinds.length > 0 && !kinds.includes("image")) setMedia("video");
	}, [models, chosen]);

	const upload = useMutation({
		mutationFn: api.upload,
		onSuccess: (asset) => setReferences([...references, asset.id]),
	});

	// Kept in a ref too, so a second click before the next render is ignored
	// and the request stops when the composer goes away.
	const improvingRef = useRef<AbortController | null>(null);
	useEffect(() => () => improvingRef.current?.abort(), []);
	// The prompt as typed now, to drop a suggestion for one since changed.
	const promptRef = useRef(prompt);
	promptRef.current = prompt;

	const stopImproving = () => {
		improvingRef.current?.abort();
		improvingRef.current = null;
		setImproving(null);
	};

	const improve = async () => {
		const idea = prompt.trim();
		if (idea === "" || improvingRef.current) return;
		const controller = new AbortController();
		improvingRef.current = controller;
		setImproving(controller);
		setImproveError(null);
		try {
			const { prompt: better } = await api.improvePrompt(
				{
					prompt: idea,
					modelIds: selected.map((m) => m.id),
					editing: references.length > 0,
					language,
				},
				controller.signal,
			);
			// Written for a prompt that is no longer there: using it would
			// overwrite what was typed since.
			if (!controller.signal.aborted && promptRef.current.trim() === idea) {
				setSuggestion(better);
			}
		} catch (problem) {
			if (!controller.signal.aborted) setImproveError(problem);
		} finally {
			if (improvingRef.current === controller) {
				improvingRef.current = null;
				setImproving(null);
			}
		}
	};

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
			// Unmoved, each model redraws by its own.
			strength: redrawing && moved != null ? moved : undefined,
			maskAssetId: maskId ?? undefined,
			loras: sentLoras.length > 0 ? sentLoras : undefined,
		});
		setPrompt("");
		// Whatever was offered was for the prompt just sent.
		stopImproving();
		setSuggestion(null);
		setImproveError(null);
	};

	// Chosen models that have a key but are ruled out by the reference images.
	const overReferenceLimit =
		selected.length === 0 &&
		offered.some((m) => chosen.includes(m.id) && ready.has(m.providerId));
	const error =
		props.error ??
		(upload.error ? explain(upload.error) : null) ??
		(improveError ? explain(improveError) : null) ??
		(overReferenceLimit ? t("composer.tooManyReferences") : null);
	const control = "rounded-md border border-line bg-bg px-2 py-1.5 text-sm";

	return (
		<>
			<aside
				aria-label={t("composer.parameters")}
				className="flex min-h-0 flex-col gap-5 overflow-y-auto border-line bg-panel p-4 lg:border-r"
			>
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
					<legend className="mb-2 font-mono text-[11px] uppercase tracking-wider text-dim">
						{t("composer.models")}
					</legend>

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

				<div className="flex flex-col gap-2.5">
					<label className="flex items-center justify-between gap-2 text-sm text-dim">
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
					<LoraPicker bases={loraBases} value={loras} onChange={setLoras} />
					{redrawing && strength != null && (
						<label className="flex items-center justify-between gap-2 text-sm text-dim">
							{t("composer.strength")}
							<input
								type="range"
								min={0.1}
								max={1}
								step={0.05}
								value={strength}
								onChange={(event) => setStrength(Number(event.target.value))}
								aria-valuetext={t("composer.strengthValue", {
									amount: number(strength, { style: "percent" }),
								})}
								className="w-28 accent-accent"
							/>
							<span className="w-10 font-mono text-xs">
								{number(strength, { style: "percent" })}
							</span>
						</label>
					)}
					{durations.length > 0 && (
						<label className="flex items-center justify-between gap-2 text-sm text-dim">
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
						className="flex items-center justify-between gap-2 text-sm text-dim"
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
				</div>
				<div className="flex flex-col gap-2">
					<span className="font-mono text-[11px] uppercase tracking-wider text-dim">
						{t("common.reference")}
					</span>
					{references.length > 0 && (
						<ul
							className="flex flex-wrap gap-2"
							aria-label={t("composer.referenceImages")}
						>
							{references.map((id) => (
								<li key={id} className="relative">
									<button
										type="button"
										onClick={() => setAdjusting(id)}
										aria-label={t("composer.adjust")}
										title={t("composer.adjust")}
										className="block rounded-md"
									>
										<img
											src={assetUrl(id)}
											alt={t("common.reference")}
											className="size-16 rounded-md border border-line object-cover transition-opacity hover:opacity-80"
										/>
									</button>
									{id === only && marked && (
										// The marked area, as it was painted.
										<img
											src={marked.marks}
											alt=""
											className="pointer-events-none absolute inset-0 size-16 rounded-md object-cover opacity-55"
										/>
									)}
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
							{only != null && canMask && (
								<li className="flex flex-col items-start justify-center gap-1 text-sm">
									<div className="flex gap-1.5">
										<button
											type="button"
											onClick={() => setPainting(true)}
											className="rounded-md border border-line px-2.5 py-1 text-dim hover:border-dim hover:text-ink"
										>
											{maskId ? t("composer.editArea") : t("composer.markArea")}
										</button>
										<button
											type="button"
											onClick={() => setExtending(true)}
											className="rounded-md border border-line px-2.5 py-1 text-dim hover:border-dim hover:text-ink"
										>
											{t("composer.extend")}
										</button>
									</div>
									{maskId && (
										<button
											type="button"
											onClick={() => setMask(null)}
											className="px-1 text-xs text-dim underline hover:text-ink"
										>
											{t("composer.removeMask")}
										</button>
									)}
								</li>
							)}
						</ul>
					)}

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
				</div>
			</aside>
			<section
				aria-label={t("composer.promptAndResults")}
				className="flex min-h-0 flex-col overflow-y-auto"
			>
				<div className="flex flex-col gap-3 border-b border-line p-4">
					{suggestion != null && (
						<section
							aria-label={t("composer.suggestion")}
							className="rounded-md border border-line bg-bg px-3 py-2"
						>
							<h3 className="font-mono text-xs uppercase tracking-wide text-dim">
								{t("composer.suggestion")}
							</h3>
							<p className="mt-1 leading-relaxed">{suggestion}</p>
							<div className="mt-2 flex flex-wrap gap-1.5 text-sm">
								<button
									type="button"
									onClick={() => {
										setPrompt(suggestion);
										setSuggestion(null);
									}}
									className="aurora rounded-md px-3 py-1"
								>
									{t("composer.suggestionUse")}
								</button>
								<button
									type="button"
									onClick={improve}
									disabled={improving != null}
									className="rounded-md border border-line px-3 py-1 text-dim hover:border-dim hover:text-ink disabled:opacity-40"
								>
									{t("composer.suggestionAnother")}
								</button>
								<button
									type="button"
									onClick={() => setSuggestion(null)}
									className="rounded-md px-3 py-1 text-dim hover:text-ink"
								>
									{t("composer.suggestionDiscard")}
								</button>
							</div>
						</section>
					)}

					<textarea
						value={prompt}
						onChange={(event) => {
							setPrompt(event.target.value);
							setImproveError(null);
						}}
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
						{improving ? (
							<button
								type="button"
								onClick={stopImproving}
								className={`${control} text-dim hover:text-ink`}
							>
								<span className="animate-pulse">{t("composer.improving")}</span>{" "}
								· {t("composer.improveStop")}
							</button>
						) : (
							<button
								type="button"
								onClick={improve}
								disabled={prompt.trim() === ""}
								className={`${control} text-dim hover:text-ink disabled:opacity-40`}
							>
								✦ {t("composer.improve")}
							</button>
						)}
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
				{props.children}
			</section>
			{adjusting != null && (
				<Adjust
					src={assetUrl(adjusting)}
					onDone={async (picture) => {
						const asset = await api.upload(
							new File([picture], "adjusted", { type: picture.type }),
						);
						// Takes the old one's place; a mask drawn on it no longer fits.
						setReferences((current) =>
							current.map((id) => (id === adjusting ? asset.id : id)),
						);
						setAdjusting(null);
					}}
					onClose={() => setAdjusting(null)}
				/>
			)}
			{extending && only != null && (
				<Extend
					src={assetUrl(only)}
					onDone={async (picture, area, marks) => {
						const [larger, mask] = await Promise.all([
							api.upload(
								new File([picture], "extended", { type: picture.type }),
							),
							api.upload(new File([area], "mask.png", { type: area.type })),
						]);
						// The larger picture takes the old one's place, its new part
						// marked to be drawn.
						setReferences((current) =>
							current.map((id) => (id === only ? larger.id : id)),
						);
						setMask({ reference: larger.id, id: mask.id, marks });
						setExtending(false);
					}}
					onClose={() => setExtending(false)}
				/>
			)}
			{painting && only != null && (
				<MaskPainter
					src={assetUrl(only)}
					mask={maskId ? assetUrl(maskId) : null}
					onDone={async (blob, marks) => {
						const asset = await api.upload(
							new File([blob], "mask.png", { type: "image/png" }),
						);
						setMask({ reference: only, id: asset.id, marks });
						setPainting(false);
					}}
					onClose={() => setPainting(false)}
				/>
			)}
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
		</>
	);
}
