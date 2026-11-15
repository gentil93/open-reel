import type { ModelSpec, ProviderStatus } from "@open-reel/core/types";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, assetUrl } from "./api";
import { href } from "./route";

export interface Draft {
	prompt: string;
	modelIds: string[];
	aspectRatio?: string;
	count: number;
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
	const [prompt, setPrompt] = useState("");
	const [chosen, setChosen] = useState<string[]>(savedModels);
	const [aspectRatio, setAspectRatio] = useState("");
	const [count, setCount] = useState(1);
	const fileInput = useRef<HTMLInputElement>(null);

	const ready = new Set(
		providers.filter((p) => p.hasKey || !p.requiresKey).map((p) => p.id),
	);
	/** Why a model cannot be used right now, if it cannot. */
	const blocked = (model: ModelSpec): string | null => {
		if (!ready.has(model.providerId)) return "needs an API key";
		if (references.length > model.capabilities.maxReferenceImages) {
			return model.capabilities.maxReferenceImages === 0
				? "cannot use reference images"
				: `takes at most ${model.capabilities.maxReferenceImages} references`;
		}
		return null;
	};
	const selected = models.filter((m) => chosen.includes(m.id) && !blocked(m));
	const ratios = [
		...new Set(selected.flatMap((m) => m.capabilities.aspectRatios)),
	];
	const maxCount = Math.max(1, ...selected.map((m) => m.capabilities.maxCount));

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(chosen));
		} catch {
			// Storage can be unavailable; the selection then lasts for this visit only.
		}
	}, [chosen]);

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
		});
		setPrompt("");
	};

	// Chosen models that have a key but are ruled out by the reference images.
	const overReferenceLimit =
		selected.length === 0 &&
		models.some((m) => chosen.includes(m.id) && ready.has(m.providerId));
	const error =
		props.error ??
		upload.error?.message ??
		(overReferenceLimit
			? "No selected model accepts this many reference images. Remove some or pick another model."
			: null);
	const control = "rounded-md border border-line bg-bg px-2 py-1.5 text-sm";

	return (
		<div className="border-t border-line bg-panel">
			<div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-4">
				<fieldset className="flex flex-wrap items-center gap-1.5">
					<legend className="sr-only">Models</legend>
					{models.map((model) => {
						const reason = blocked(model);
						const on = chosen.includes(model.id) && !reason;
						return (
							<button
								key={model.id}
								type="button"
								aria-pressed={on}
								disabled={reason !== null}
								title={reason ? `${model.name} ${reason}` : model.id}
								onClick={() =>
									setChosen(
										on
											? chosen.filter((id) => id !== model.id)
											: [...chosen, model.id],
									)
								}
								className={`rounded-full border px-3 py-1 text-sm disabled:opacity-40 ${
									on
										? "border-accent bg-accent text-accent-ink"
										: "border-line text-dim hover:border-dim hover:text-ink"
								}`}
							>
								<span className="opacity-60">{model.providerId} · </span>
								{model.name}
							</button>
						);
					})}
					{models.some((m) => !ready.has(m.providerId)) && (
						<a
							href={href.settings}
							className="px-2 text-sm text-accent underline"
						>
							Add API keys
						</a>
					)}
				</fieldset>

				{references.length > 0 && (
					<ul className="flex flex-wrap gap-2" aria-label="Reference images">
						{references.map((id) => (
							<li key={id} className="relative">
								<img
									src={assetUrl(id)}
									alt="Reference"
									className="size-16 rounded-md border border-line object-cover"
								/>
								<button
									type="button"
									aria-label="Remove reference"
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
							? "Describe the change you want…"
							: "Describe the image you want…"
					}
					aria-label="Prompt"
					className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 leading-relaxed"
				/>

				<div className="flex flex-wrap items-center gap-2">
					<label className="flex items-center gap-2 text-sm text-dim">
						Ratio
						<select
							value={ratios.includes(aspectRatio) ? aspectRatio : ""}
							onChange={(event) => setAspectRatio(event.target.value)}
							disabled={ratios.length === 0}
							className={control}
						>
							<option value="">Default</option>
							{ratios.map((ratio) => (
								<option key={ratio}>{ratio}</option>
							))}
						</select>
					</label>
					<label className="flex items-center gap-2 text-sm text-dim">
						Images
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
						{upload.isPending ? "Uploading…" : "Add reference image"}
					</button>
					<span className="ml-auto text-sm text-danger" role="alert">
						{error}
					</span>
					<button
						type="button"
						onClick={submit}
						disabled={!canSend}
						className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
					>
						{selected.length > 1
							? `Compare ${selected.length} models`
							: "Generate"}
					</button>
				</div>
			</div>
		</div>
	);
}
