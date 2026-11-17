import type {
	Fit,
	LocalEngineStatus,
	LocalModelStatus,
	LocalModelsView,
} from "@open-reel/core/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, demoUrl } from "./api";
import { remaining } from "./format";
import { type I18n, useI18n } from "./i18n";
import { useModelProgress } from "./live";

type Demo = LocalModelStatus["demos"][number] & { src: string };

function DemoViewer({ demo, onClose }: { demo: Demo; onClose(): void }) {
	const { t } = useI18n();
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		ref.current?.showModal();
	}, []);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop closes; Esc already does so natively
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(event) => event.target === ref.current && onClose()}
			className="m-auto max-h-[94vh] max-w-[96vw] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<img
				src={demo.src}
				alt={demo.caption ?? t("models.demo.sample")}
				className="max-h-[86vh] max-w-full object-contain"
			/>
			<div className="flex items-center justify-between gap-4 p-3 text-sm">
				<span className="text-dim">{demo.caption}</span>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-3 py-1 text-dim hover:text-ink"
				>
					{t("common.close")}
				</button>
			</div>
		</dialog>
	);
}

/** What the model's authors show it can do. */
function Demos({ model }: { model: LocalModelStatus }) {
	const { t } = useI18n();
	const [index, setIndex] = useState(0);
	const [open, setOpen] = useState(false);
	const [failed, setFailed] = useState<number[]>([]);
	const demos: Demo[] = model.demos.map((demo, i) => ({
		...demo,
		src: demoUrl(model.id, i),
	}));
	const demo = demos[index];
	if (!demo) {
		return (
			<div className="flex aspect-video items-center justify-center bg-bg text-sm text-dim">
				{t("models.demo.none")}
			</div>
		);
	}
	return (
		<div>
			<div className="relative aspect-video overflow-hidden bg-black">
				{failed.includes(index) ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-sm text-dim">
						{t("models.demo.failed")}
					</div>
				) : demo.media === "video" ? (
					// biome-ignore lint/a11y/useMediaCaption: demo reels come without a transcript
					<video
						key={demo.src}
						src={demo.src}
						controls
						preload="none"
						playsInline
						onError={() => setFailed((current) => [...current, index])}
						className="h-full w-full object-contain"
					/>
				) : (
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-label={t("models.demo.enlarge", {
							caption: demo.caption ?? t("models.demo.sampleShort"),
						})}
						className="developing block h-full w-full cursor-zoom-in"
					>
						<img
							key={demo.src}
							src={demo.src}
							alt={
								demo.caption ??
								t("models.demo.sampleFrom", { model: model.name })
							}
							loading="lazy"
							onError={() => setFailed((current) => [...current, index])}
							className="h-full w-full object-cover"
						/>
					</button>
				)}
				{demos.length > 1 && (
					<div className="absolute right-2 bottom-2 flex gap-1">
						{demos.map((other, i) => (
							<button
								key={other.src}
								type="button"
								onClick={() => setIndex(i)}
								aria-label={t("models.demo.position", {
									index: i + 1,
									total: demos.length,
								})}
								aria-pressed={i === index}
								className={`h-6 min-w-6 rounded bg-black/70 px-1.5 font-mono text-xs ${
									i === index ? "text-white" : "text-white/50 hover:text-white"
								}`}
							>
								{i + 1}
							</button>
						))}
					</div>
				)}
			</div>
			{demo.caption && (
				<p className="px-4 pt-2 text-xs text-dim">
					{demo.media === "video" && `${t("models.demo.video")} · `}
					{demo.caption}
				</p>
			)}
			{open && demo.media === "image" && (
				<DemoViewer demo={demo} onClose={() => setOpen(false)} />
			)}
		</div>
	);
}

function Progress({ model }: { model: LocalModelStatus }) {
	const i18n = useI18n();
	const { t, bytes } = i18n;
	const live = useModelProgress(model.id);
	const received = Math.max(live?.receivedBytes ?? 0, model.receivedBytes);
	const state = live?.state ?? model.state;
	const speed = live?.bytesPerSecond ?? 0;
	const percent = Math.min(100, (received / model.size) * 100);
	const detail =
		state === "queued"
			? t("models.progress.queued")
			: state === "verifying"
				? t("models.progress.verifying")
				: [
						t("models.progress.received", {
							received: bytes(received),
							total: bytes(model.size),
						}),
						speed > 0 && t("models.progress.speed", { speed: bytes(speed) }),
						speed > 0 && remaining(i18n, (model.size - received) / speed),
					]
						.filter(Boolean)
						.join(" · ");
	return (
		<div>
			<div
				role="progressbar"
				aria-label={t("models.progress.label", { model: model.name })}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(percent)}
				className="h-1.5 overflow-hidden rounded-full bg-line"
			>
				<div
					className="h-full rounded-full bg-accent transition-[width] duration-300"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="mt-2 font-mono text-xs text-dim">
				{Math.floor(percent)}% · {detail}
			</p>
		</div>
	);
}

export function fitText(t: I18n["t"], fit: Fit): string {
	switch (fit) {
		case "gpu":
			return t("models.fit.gpu");
		case "offload":
			return t("models.fit.offload");
		case "cpu":
			return t("models.fit.cpu");
		case "none":
			return t("models.fit.none");
	}
}

function ModelCard({
	model,
	engine,
	freeBytes,
}: {
	model: LocalModelStatus;
	engine: LocalEngineStatus | undefined;
	freeBytes: number;
}) {
	const { t, bytes, explain } = useI18n();
	const install = useMutation({
		mutationFn: (variant?: string) => api.installModel(model.id, variant),
	});
	const cancel = useMutation({ mutationFn: () => api.cancelModel(model.id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(model.id) });
	const error = install.error ?? cancel.error ?? remove.error;

	const installed = model.state === "installed";
	const active = !installed && model.state !== "available";
	const variant = model.variants.find((v) => v.id === model.variant);
	const engineToFetch =
		engine && !engine.installed && !installed ? engine.size : 0;
	const toDownload = model.size - model.receivedBytes;
	const shared = (variant?.files ?? [])
		.filter((file) => file.present)
		.reduce((sum, file) => sum + file.size, 0);
	const partial = model.receivedBytes - shared;
	const fits = toDownload <= freeBytes;
	const others = model.variants.filter(
		(v) => v.id !== model.variant && v.fit !== "none",
	);

	const note = installed
		? model.reclaimableBytes < model.size
			? t("models.note.installedShared", {
					size: bytes(model.reclaimableBytes),
				})
			: t("models.note.installed")
		: [
				shared > 0
					? t("models.note.sharedDownload", {
							size: bytes(toDownload),
							shared: bytes(shared),
						})
					: partial > 0
						? t("models.note.leftToDownload", { size: bytes(toDownload) })
						: t("models.note.toDownload"),
				engineToFetch > 0 &&
					t("models.note.withEngine", { size: bytes(engineToFetch) }),
			]
				.filter(Boolean)
				.join(" · ");

	return (
		<li className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
			<Demos model={model} />
			<div className="flex flex-1 flex-col gap-3 p-4">
				<div>
					<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
						<h2 className="font-medium">{model.name}</h2>
						<span
							className={`font-mono text-xs ${installed ? "text-accent" : "text-dim"}`}
						>
							{installed
								? t("models.installed")
								: model.media === "video"
									? t("models.media.video")
									: t("models.media.image")}
						</span>
					</div>
					<p className="mt-0.5 text-xs text-dim">
						{model.author} · {model.license} ·{" "}
						<a
							href={model.homepage}
							target="_blank"
							rel="noreferrer"
							className="underline hover:text-ink"
						>
							{t("models.page")}
						</a>
					</p>
				</div>
				<p className="text-sm leading-relaxed">{model.summary}</p>

				{variant ? (
					<div>
						<p>
							<span className="font-mono text-lg">{bytes(model.size)}</span>{" "}
							<span className="text-sm text-dim">{note}</span>
						</p>
						<p className="mt-1 text-sm">
							<span className="font-medium">{variant.label}</span>{" "}
							<span
								className={variant.fit === "gpu" ? "text-dim" : "text-danger"}
							>
								· {fitText(t, variant.fit)}
							</span>
						</p>
						<details className="mt-1 text-xs text-dim">
							<summary className="cursor-pointer hover:text-ink">
								{t("models.files", { count: variant.files.length })}
								{model.variants.length > 1 &&
									` · ${t("models.versions", { count: model.variants.length })}`}
							</summary>
							<ul className="mt-2 flex flex-col gap-1 font-mono">
								{variant.files.map((file) => (
									<li key={file.name} className="flex justify-between gap-4">
										<span className="min-w-0 truncate" title={file.name}>
											{file.name}
										</span>
										<span className="shrink-0">
											{bytes(file.size)}
											{file.present && ` · ${t("models.onDisk")}`}
										</span>
									</li>
								))}
							</ul>
							{model.variants.length > 1 && (
								<ul className="mt-3 flex flex-col gap-2">
									{model.variants.map((other) => (
										<li
											key={other.id}
											className="flex flex-wrap items-center justify-between gap-2"
										>
											<span>
												<span className="text-ink">{other.label}</span> ·{" "}
												{bytes(other.size)} · {fitText(t, other.fit)}
												{other.id === model.variant &&
													` · ${installed ? t("models.variantInstalled") : t("models.recommended")}`}
											</span>
											{!installed && !active && others.includes(other) && (
												<button
													type="button"
													onClick={() => install.mutate(other.id)}
													disabled={install.isPending}
													className="rounded border border-line px-2 py-0.5 hover:border-dim hover:text-ink"
												>
													{t("models.installVersion")}
												</button>
											)}
										</li>
									))}
								</ul>
							)}
						</details>
					</div>
				) : (
					<p className="text-sm text-danger">{t("models.noVersion")}</p>
				)}

				{installed && !model.ready && !active && (
					<p className="text-sm text-danger">{t("models.engineMissing")}</p>
				)}
				{active && <Progress model={model} />}
				{model.error && !active && (
					<p className="text-sm text-danger">
						{t("models.installStopped", {
							error: explain({
								message: model.error,
								code: model.errorCode,
								params: model.errorParams,
							}),
						})}
					</p>
				)}
				{error && <p className="text-sm text-danger">{explain(error)}</p>}
				{variant && !installed && !active && !fits && (
					<p className="text-sm text-danger">
						{t("models.notEnoughSpace", {
							needed: bytes(toDownload),
							free: bytes(freeBytes),
						})}
					</p>
				)}

				<div className="mt-auto flex flex-wrap gap-2 pt-1 text-sm">
					{installed && !model.ready && !active && (
						<button
							type="button"
							onClick={() => install.mutate(undefined)}
							disabled={install.isPending}
							className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
						>
							{t("models.installEngine")}
						</button>
					)}
					{variant && !installed && !active && (
						<button
							type="button"
							onClick={() => install.mutate(undefined)}
							disabled={!fits || install.isPending}
							className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
						>
							{partial > 0 ? t("models.resume") : t("models.install")}
						</button>
					)}
					{active && (
						<button
							type="button"
							onClick={() => cancel.mutate()}
							disabled={cancel.isPending}
							className="rounded-md border border-line px-4 py-2 hover:border-dim"
						>
							{model.state === "queued"
								? t("common.cancel")
								: t("models.pause")}
						</button>
					)}
					{(installed || partial > 0) && !active && (
						<button
							type="button"
							disabled={remove.isPending}
							onClick={() => {
								const question = installed
									? t("models.deleteConfirm", {
											model: model.name,
											size: bytes(model.reclaimableBytes),
										})
									: t("models.discardConfirm", {
											model: model.name,
											size: bytes(partial),
										});
								if (window.confirm(question)) remove.mutate();
							}}
							className="rounded-md border border-line px-4 py-2 text-dim hover:text-danger"
						>
							{installed ? t("models.delete") : t("models.discard")}
						</button>
					)}
				</div>
			</div>
		</li>
	);
}

const BACKEND_NAMES: Record<
	Exclude<LocalEngineStatus["backend"], "cpu">,
	string
> = {
	cuda: "CUDA",
	rocm: "ROCm",
	metal: "Metal",
	vulkan: "Vulkan",
};

/** What open-reel found on this computer, and what it will run models with. */
function Machine({ view }: { view: LocalModelsView }) {
	const { t, bytes } = useI18n();
	const { hardware, engines } = view;
	const gpu = hardware.gpus.toSorted(
		(a, b) => b.memoryBytes - a.memoryBytes,
	)[0];
	const label = "font-mono text-[11px] uppercase tracking-wider text-dim";
	return (
		<dl className="mt-6 grid gap-x-10 gap-y-4 sm:grid-cols-2">
			<div>
				<dt className={label}>{t("models.machine.computer")}</dt>
				<dd className="mt-1 text-sm">
					{gpu
						? `${gpu.name} · ${bytes(gpu.memoryBytes)}`
						: t("models.machine.noGpu")}
					<span className="text-dim">
						{" "}
						·{" "}
						{t("models.machine.memory", { size: bytes(hardware.memoryBytes) })}
						{hardware.wsl && " · WSL"}
					</span>
				</dd>
			</div>
			<div>
				<dt className={label}>{t("models.machine.engine")}</dt>
				<dd className="mt-1 text-sm">
					{engines.length === 0 ? (
						<span className="text-danger">{t("models.machine.noEngine")}</span>
					) : (
						engines.map((engine) => (
							<span key={engine.engine}>
								{engine.name} ·{" "}
								{engine.backend === "cpu"
									? t("models.machine.cpu")
									: BACKEND_NAMES[engine.backend]}
								{engine.throughWindows && ` ${t("models.machine.windows")}`}
								<span className="text-dim">
									{" "}
									·{" "}
									{engine.installed
										? t("models.machine.engineInstalled", {
												size: bytes(engine.size),
											})
										: t("models.machine.engineLater", {
												size: bytes(engine.size),
											})}
								</span>
							</span>
						))
					)}
				</dd>
			</div>
		</dl>
	);
}

export function Models() {
	const { t, bytes, explain } = useI18n();
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const disk = view.data?.disk;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl">
				<h1 className="font-display text-4xl leading-none font-black uppercase tracking-wide">
					{t("models.title")}
				</h1>
				<p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
					{t("models.intro")}
				</p>
				{view.error && (
					<p className="mt-6 text-sm text-danger">{explain(view.error)}</p>
				)}
				{view.data && <Machine view={view.data} />}
				{disk && (
					<dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								{t("models.disk.used")}
							</dt>
							<dd className="font-mono text-lg">
								{disk.usedBytes > 0
									? bytes(disk.usedBytes)
									: t("models.disk.nothing")}
							</dd>
						</div>
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								{t("models.disk.free")}
							</dt>
							<dd className="font-mono text-lg">{bytes(disk.freeBytes)}</dd>
						</div>
						<div className="min-w-0">
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								{t("models.disk.path")}
							</dt>
							<dd className="truncate pt-1 font-mono text-sm" title={disk.path}>
								{disk.path}
							</dd>
						</div>
					</dl>
				)}
				<ul className="mt-6 grid gap-4 lg:grid-cols-2">
					{view.data?.models.map((model) => (
						<ModelCard
							key={model.id}
							model={model}
							engine={view.data?.engines.find((engine) =>
								model.variants.some(
									(v) => v.id === model.variant && v.engine === engine.engine,
								),
							)}
							freeBytes={disk?.freeBytes ?? 0}
						/>
					))}
				</ul>
			</div>
		</div>
	);
}
