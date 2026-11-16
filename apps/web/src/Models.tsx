import type { LocalModelStatus } from "@open-reel/core/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, demoUrl } from "./api";
import { bytes, remaining } from "./format";
import { useModelProgress } from "./live";

type Demo = LocalModelStatus["demos"][number] & { src: string };

function DemoViewer({ demo, onClose }: { demo: Demo; onClose(): void }) {
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
				alt={demo.caption ?? "A sample from the model"}
				className="max-h-[86vh] max-w-full object-contain"
			/>
			<div className="flex items-center justify-between gap-4 p-3 text-sm">
				<span className="text-dim">{demo.caption}</span>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md px-3 py-1 text-dim hover:text-ink"
				>
					Close
				</button>
			</div>
		</dialog>
	);
}

/** What the model's authors show it can do. */
function Demos({ model }: { model: LocalModelStatus }) {
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
				No demo available
			</div>
		);
	}
	return (
		<div>
			<div className="relative aspect-video overflow-hidden bg-black">
				{failed.includes(index) ? (
					<div className="flex h-full items-center justify-center px-6 text-center text-sm text-dim">
						The demo could not be loaded. It is downloaded from the model's
						page, so it needs a connection the first time.
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
						aria-label={`Enlarge: ${demo.caption ?? "sample"}`}
						className="developing block h-full w-full cursor-zoom-in"
					>
						<img
							key={demo.src}
							src={demo.src}
							alt={demo.caption ?? `A sample from ${model.name}`}
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
								aria-label={`Demo ${i + 1} of ${demos.length}`}
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
					{demo.media === "video" && "Video · "}
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
	const live = useModelProgress(model.id);
	const received = Math.max(live?.receivedBytes ?? 0, model.receivedBytes);
	const state = live?.state ?? model.state;
	const speed = live?.bytesPerSecond ?? 0;
	const percent = Math.min(100, (received / model.size) * 100);
	const detail =
		state === "queued"
			? "Waiting for another download to finish"
			: state === "verifying"
				? "Checking the downloaded file"
				: [
						`${bytes(received)} of ${bytes(model.size)}`,
						speed > 0 && `${bytes(speed)}/s`,
						speed > 0 && remaining((model.size - received) / speed),
					]
						.filter(Boolean)
						.join(" · ");
	return (
		<div>
			<div
				role="progressbar"
				aria-label={`Downloading ${model.name}`}
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

function ModelCard({
	model,
	freeBytes,
}: {
	model: LocalModelStatus;
	freeBytes: number;
}) {
	const install = useMutation({ mutationFn: () => api.installModel(model.id) });
	const cancel = useMutation({ mutationFn: () => api.cancelModel(model.id) });
	const remove = useMutation({ mutationFn: () => api.deleteModel(model.id) });
	const error = install.error ?? cancel.error ?? remove.error;

	const installed = model.state === "installed";
	const active = !installed && model.state !== "available";
	const toDownload = model.size - model.receivedBytes;
	const shared = model.files
		.filter((file) => file.present)
		.reduce((sum, file) => sum + file.size, 0);
	const partial = model.receivedBytes - shared;
	const fits = toDownload <= freeBytes;

	const note = installed
		? model.reclaimableBytes < model.size
			? `on disk · deleting frees ${bytes(model.reclaimableBytes)}, the rest is shared with other models`
			: "on disk"
		: shared > 0
			? `${bytes(toDownload)} to download · ${bytes(shared)} is already on disk, shared with another model`
			: partial > 0
				? `${bytes(toDownload)} left to download`
				: "to download";

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
							{installed ? "installed" : model.media}
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
							model page
						</a>
					</p>
				</div>
				<p className="text-sm leading-relaxed">{model.summary}</p>

				<div>
					<p>
						<span className="font-mono text-lg">{bytes(model.size)}</span>{" "}
						<span className="text-sm text-dim">{note}</span>
					</p>
					<details className="mt-1 text-xs text-dim">
						<summary className="cursor-pointer hover:text-ink">
							{model.files.length === 1
								? "1 file"
								: `${model.files.length} files`}
						</summary>
						<ul className="mt-2 flex flex-col gap-1 font-mono">
							{model.files.map((file) => (
								<li key={file.name} className="flex justify-between gap-4">
									<span className="min-w-0 truncate" title={file.name}>
										{file.name}
									</span>
									<span className="shrink-0">
										{bytes(file.size)}
										{file.present && " · on disk"}
									</span>
								</li>
							))}
						</ul>
					</details>
				</div>

				{active && <Progress model={model} />}
				{model.error && !active && (
					<p className="text-sm text-danger">
						The download stopped: {model.error}
					</p>
				)}
				{error && <p className="text-sm text-danger">{error.message}</p>}
				{!installed && !active && !fits && (
					<p className="text-sm text-danger">
						Not enough free space: {bytes(toDownload)} needed,{" "}
						{bytes(freeBytes)} free.
					</p>
				)}

				<div className="mt-auto flex flex-wrap gap-2 pt-1 text-sm">
					{!installed && !active && (
						<button
							type="button"
							onClick={() => install.mutate()}
							disabled={!fits || install.isPending}
							className="rounded-md bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-40"
						>
							{partial > 0 ? "Resume download" : "Install"}
						</button>
					)}
					{active && (
						<button
							type="button"
							onClick={() => cancel.mutate()}
							disabled={cancel.isPending}
							className="rounded-md border border-line px-4 py-2 hover:border-dim"
						>
							{model.state === "queued" ? "Cancel" : "Pause"}
						</button>
					)}
					{(installed || partial > 0) && !active && (
						<button
							type="button"
							disabled={remove.isPending}
							onClick={() => {
								const question = installed
									? `Delete ${model.name}? This frees ${bytes(model.reclaimableBytes)}.`
									: `Discard the ${bytes(partial)} downloaded for ${model.name}?`;
								if (window.confirm(question)) remove.mutate();
							}}
							className="rounded-md border border-line px-4 py-2 text-dim hover:text-danger"
						>
							{installed ? "Delete" : "Discard"}
						</button>
					)}
				</div>
			</div>
		</li>
	);
}

export function Models() {
	const view = useQuery({
		queryKey: ["local-models"],
		queryFn: api.localModels,
	});
	const disk = view.data?.disk;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl">
				<h1 className="text-xl font-semibold">Local models</h1>
				<p className="mt-2 max-w-2xl text-sm leading-relaxed text-dim">
					Models you download are kept on this computer. Each file is checked
					after downloading, and a file two models share is stored once.
				</p>
				<p className="mt-4 max-w-2xl rounded-md border border-line bg-panel px-4 py-3 text-sm leading-relaxed">
					Generating with installed models is not available yet. For now you can
					download them and manage the space they take.
				</p>
				{view.error && (
					<p className="mt-6 text-sm text-danger">{view.error.message}</p>
				)}
				{disk && (
					<dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								Used by models
							</dt>
							<dd className="font-mono text-lg">
								{disk.usedBytes > 0 ? bytes(disk.usedBytes) : "Nothing yet"}
							</dd>
						</div>
						<div>
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								Free on disk
							</dt>
							<dd className="font-mono text-lg">{bytes(disk.freeBytes)}</dd>
						</div>
						<div className="min-w-0">
							<dt className="font-mono text-[11px] uppercase tracking-wider text-dim">
								Stored in
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
							freeBytes={disk?.freeBytes ?? 0}
						/>
					))}
				</ul>
			</div>
		</div>
	);
}
