import type {
	Asset,
	TrainerInstallStep,
	TrainerStatus,
	TrainingStage,
	TrainingView,
} from "@hatchlight/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, assetUrl } from "./api";
import { remaining } from "./format";
import { type I18n, useI18n } from "./i18n";

// The server's limits (packages/core/src/local/trainer.ts), to guide the form.
const MIN_PICTURES = 3;
const MAX_PICTURES = 200;
const DEFAULT_STEPS = 800;

function stepText(t: I18n["t"], step: TrainerInstallStep): string {
	switch (step) {
		case "uv":
			return t("training.install.uv");
		case "scripts":
			return t("training.install.scripts");
		case "python":
			return t("training.install.python");
		case "packages":
			return t("training.install.packages");
		case "checking":
			return t("training.install.checking");
	}
}

function stageText(t: I18n["t"], stage: TrainingStage): string {
	switch (stage) {
		case "waitingGpu":
			return t("training.stage.waitingGpu");
		case "loading":
			return t("training.stage.loading");
		case "caching":
			return t("training.stage.caching");
		case "training":
			return t("training.stage.training");
		case "saving":
			return t("training.stage.saving");
	}
}

function Bar({ value, label }: { value: number; label: string }) {
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(value * 100)}
			className="h-1.5 overflow-hidden rounded-full bg-line"
		>
			<div
				className="aurora h-full rounded-full transition-[width] duration-500"
				style={{ width: `${Math.max(2, value * 100)}%` }}
			/>
		</div>
	);
}

/** Installing the trainer, before anything can be trained. */
function Install({ status }: { status: TrainerStatus }) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const install = useMutation({ mutationFn: api.installTrainer });
	const cancel = useMutation({ mutationFn: api.cancelTrainerInstall });
	const step = status.install;
	if (step) {
		const fraction =
			step.totalBytes && step.receivedBytes != null
				? step.receivedBytes / step.totalBytes
				: null;
		return (
			<div className="flex flex-col gap-2" role="status">
				<p className="text-sm">{stepText(t, step.step)}</p>
				{fraction != null && (
					<>
						<Bar value={fraction} label={stepText(t, step.step)} />
						<p className="font-mono text-xs text-dim">
							{t("training.install.received", {
								received: bytes(step.receivedBytes ?? 0),
								total: bytes(step.totalBytes ?? 0),
							})}
						</p>
					</>
				)}
				{step.step === "packages" && (
					<p className="text-xs leading-relaxed text-dim">
						{t("training.install.packagesHint")}
					</p>
				)}
				<div>
					<button
						type="button"
						onClick={() => cancel.mutate()}
						className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm leading-relaxed text-dim">
				{t("training.install.intro", { size: bytes(status.downloadBytes) })}
			</p>
			{status.error && (
				<p className="text-sm text-danger">{explain(status.error)}</p>
			)}
			{/* A failed install may leave gigabytes behind. */}
			{status.error && <Remove />}
			{install.error && (
				<p className="text-sm text-danger">{explain(install.error)}</p>
			)}
			<div>
				<button
					type="button"
					onClick={() => install.mutate()}
					disabled={install.isPending}
					className="aurora rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
				>
					{t("training.install.start")}
				</button>
			</div>
		</div>
	);
}

/** A training under way, or how the last one ended. */
function Progress({ training }: { training: TrainingView }) {
	const i18n = useI18n();
	const { t, bytes, explain } = i18n;
	const cancel = useMutation({ mutationFn: api.cancelTraining });
	if (training.state === "done") {
		return (
			<p className="text-sm text-good" role="status">
				{t("training.done", { name: training.name, trigger: training.trigger })}
			</p>
		);
	}
	if (training.state === "canceled") {
		return (
			<p className="text-sm text-dim" role="status">
				{t("training.canceled", { name: training.name })}
			</p>
		);
	}
	if (training.state === "failed") {
		return (
			<p className="text-sm text-danger" role="alert">
				{training.error
					? explain(training.error)
					: t("training.failed", { name: training.name })}
			</p>
		);
	}
	const fraction = training.steps > 0 ? training.step / training.steps : 0;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<p className="font-medium">{training.name}</p>
				<p className="text-sm text-dim" role="status">
					{stageText(t, training.stage)}
				</p>
			</div>
			<Bar value={fraction} label={stageText(t, training.stage)} />
			<p className="font-mono text-xs text-dim">
				{t("training.steps", { step: training.step, steps: training.steps })}
				{training.secondsLeft != null &&
					` · ${remaining(i18n, training.secondsLeft)}`}
				{training.freeMemoryBytes != null &&
					` · ${t("training.freeMemory", { free: bytes(training.freeMemoryBytes) })}`}
			</p>
			<p className="text-xs leading-relaxed text-dim">
				{t("training.runningHint")}
			</p>
			<div>
				<button
					type="button"
					onClick={() => cancel.mutate()}
					className="rounded-md border border-line px-3 py-1 text-sm text-dim hover:border-dim hover:text-ink"
				>
					{t("training.cancel")}
				</button>
			</div>
		</div>
	);
}

/** What to train: pictures with captions, a name, a trigger word and steps. */
function Form({ hidden }: { hidden: boolean }) {
	const client = useQueryClient();
	const { t, explain } = useI18n();
	const input = useRef<HTMLInputElement>(null);
	const [pictures, setPictures] = useState<{ asset: Asset; caption: string }[]>(
		[],
	);
	const [name, setName] = useState("");
	const [trigger, setTrigger] = useState("");
	const [steps, setSteps] = useState(String(DEFAULT_STEPS));
	const upload = useMutation({
		mutationFn: async (files: File[]) => {
			for (const file of files) {
				const asset = await api.upload(file);
				setPictures((current) =>
					current.length >= MAX_PICTURES
						? current
						: [...current, { asset, caption: "" }],
				);
			}
		},
	});
	const train = useMutation({
		mutationFn: () =>
			api.train({
				name: name.trim(),
				trigger: trigger.trim(),
				steps: Number(steps),
				pictures: pictures.map((p) => ({
					assetId: p.asset.id,
					caption: p.caption,
				})),
			}),
		// Shown as running at once, not when the next event arrives.
		onSuccess: (training) =>
			client.setQueryData<TrainerStatus>(["trainer"], (status) =>
				status ? { ...status, training } : status,
			),
	});
	const ready =
		pictures.length >= MIN_PICTURES &&
		name.trim() !== "" &&
		/^[\p{L}\p{N}_-]{2,40}$/u.test(trigger.trim()) &&
		Number(steps) >= 100 &&
		Number(steps) <= 4000;
	const field = "rounded-md border border-line bg-bg px-3 py-2 text-sm";
	return (
		<form
			hidden={hidden}
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) train.mutate();
			}}
		>
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-sm">
						{t("training.pictures", {
							count: pictures.length,
							min: MIN_PICTURES,
						})}
					</p>
					<button
						type="button"
						onClick={() => input.current?.click()}
						disabled={upload.isPending}
						className="rounded-md border border-line px-3 py-1 text-sm hover:border-dim disabled:opacity-40"
					>
						{upload.isPending
							? t("training.adding")
							: t("training.addPictures")}
					</button>
					<input
						ref={input}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						multiple
						hidden
						onChange={(event) => {
							const files = [...(event.target.files ?? [])];
							event.target.value = "";
							if (files.length) upload.mutate(files);
						}}
					/>
				</div>
				<p className="text-xs leading-relaxed text-dim">
					{t("training.picturesHint")}
				</p>
				{upload.error && (
					<p className="text-sm text-danger">{explain(upload.error)}</p>
				)}
				{pictures.length > 0 && (
					<ul className="grid gap-2 sm:grid-cols-2">
						{pictures.map((picture, index) => (
							<li
								key={picture.asset.id}
								className="flex items-center gap-2 rounded-md border border-line bg-bg p-1.5"
							>
								<img
									src={assetUrl(picture.asset.id)}
									alt=""
									className="h-14 w-14 shrink-0 rounded object-cover"
								/>
								<input
									value={picture.caption}
									onChange={(event) =>
										setPictures((current) =>
											current.map((p, i) =>
												i === index ? { ...p, caption: event.target.value } : p,
											),
										)
									}
									placeholder={t("training.captionPlaceholder")}
									aria-label={t("training.captionOf", { n: index + 1 })}
									maxLength={500}
									className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-sm"
								/>
								<button
									type="button"
									onClick={() =>
										setPictures((current) =>
											current.filter((_, i) => i !== index),
										)
									}
									aria-label={t("training.removePicture", { n: index + 1 })}
									className="rounded px-1.5 text-dim hover:text-ink"
								>
									×
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="flex flex-wrap gap-3">
				<label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-dim">
					{t("training.name")}
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
						placeholder={t("training.namePlaceholder")}
						className={field}
					/>
				</label>
				<label className="flex min-w-48 flex-1 flex-col gap-1 text-sm text-dim">
					{t("training.trigger")}
					<input
						value={trigger}
						onChange={(event) => setTrigger(event.target.value)}
						maxLength={40}
						placeholder={t("training.triggerPlaceholder")}
						spellCheck={false}
						className={`${field} font-mono`}
					/>
				</label>
				<label className="flex w-32 flex-col gap-1 text-sm text-dim">
					{t("training.stepsLabel")}
					<input
						type="number"
						min={100}
						max={4000}
						step={50}
						value={steps}
						onChange={(event) => setSteps(event.target.value)}
						className={`${field} font-mono`}
					/>
				</label>
			</div>
			<p className="text-xs leading-relaxed text-dim">
				{t("training.triggerHint")}
			</p>
			{train.error && (
				<p className="text-sm text-danger">{explain(train.error)}</p>
			)}
			<div>
				<button
					type="submit"
					disabled={!ready || train.isPending}
					className="aurora rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
				>
					{t("training.start")}
				</button>
			</div>
		</form>
	);
}

/** Deletes the trainer, to give its gigabytes back. */
function Remove() {
	const { t, explain } = useI18n();
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({ mutationFn: api.removeTrainer });
	return (
		<div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
			{confirming ? (
				<>
					<span className="text-dim">{t("training.removeAsk")}</span>
					<button
						type="button"
						onClick={() => remove.mutate()}
						disabled={remove.isPending}
						className="rounded-md bg-danger px-3 py-1 font-medium text-bg disabled:opacity-40"
					>
						{t("training.removeConfirm")}
					</button>
					<button
						type="button"
						onClick={() => setConfirming(false)}
						className="rounded-md px-3 py-1 text-dim hover:text-ink"
					>
						{t("common.cancel")}
					</button>
				</>
			) : (
				<button
					type="button"
					onClick={() => setConfirming(true)}
					className="rounded-md px-2 py-1 text-dim hover:text-ink"
				>
					{t("training.remove")}
				</button>
			)}
			{remove.error && <p className="text-danger">{explain(remove.error)}</p>}
		</div>
	);
}

/** Training a LoRA from the person's own pictures. */
export function TrainPanel() {
	const { t, explain } = useI18n();
	const status = useQuery({ queryKey: ["trainer"], queryFn: api.trainer });
	const data = status.data;
	return (
		<section className="mt-4 flex flex-col gap-4 rounded-lg border border-line bg-panel p-4">
			<div>
				<h3 className="font-display text-lg font-bold tracking-tight">
					{t("training.title")}
				</h3>
				<p className="mt-1 text-sm leading-relaxed text-dim">
					{t("training.intro")}
				</p>
			</div>
			{status.error && (
				<p className="text-sm text-danger">{explain(status.error)}</p>
			)}
			{data && data.state !== "ready" && <Install status={data} />}
			{data?.state === "ready" && (
				<>
					{data.training && <Progress training={data.training} />}
					{/* Kept while it trains: after a failure the pictures are still here. */}
					<Form hidden={data.training?.state === "running"} />
					{data.training?.state !== "running" && <Remove />}
				</>
			)}
		</section>
	);
}
