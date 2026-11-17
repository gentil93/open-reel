import type { JobView, ModelSpec, TurnView } from "@open-reel/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { api, assetUrl, type SessionDetail } from "./api";
import { Composer, type Draft } from "./Composer";
import { duration, usd } from "./format";
import { type I18n, useI18n } from "./i18n";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { type JobProgress, useProgress } from "./live";
import { href, navigate } from "./route";

interface Props {
	sessionId?: string;
	references: string[];
	setReferences: Dispatch<SetStateAction<string[]>>;
	addReference(assetId: string): void;
}

function Elapsed({ since }: { since: number }) {
	const i18n = useI18n();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 100);
		return () => clearInterval(timer);
	}, []);
	return <>{duration(i18n, now - since)}</>;
}

function JobCard(props: {
	job: JobView;
	prompt: string;
	model: ModelSpec | undefined;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const { job, model } = props;
	const i18n = useI18n();
	const { t } = i18n;
	const progress = useProgress(job.id);
	const cancel = useMutation({ mutationFn: () => api.cancelJob(job.id) });
	const name = model?.name ?? job.modelId;
	const pending = job.status === "queued" || job.status === "running";
	const [width, height] = (
		job.params.aspectRatio ?? (model?.media === "video" ? "16:9" : "1:1")
	)
		.split(":")
		.map(Number);

	return (
		<section className="flex min-w-0 flex-col rounded-lg border border-line bg-panel">
			<header className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2">
				<h3 className="truncate text-sm font-medium">
					{name}
					<span className="ml-2 font-mono text-xs font-normal text-dim">
						{job.providerId}
					</span>
				</h3>
				<p className="shrink-0 font-mono text-xs text-dim">
					{job.status === "queued" && t("job.queued")}
					{job.status === "running" && job.startedAt && (
						<Elapsed since={job.startedAt} />
					)}
					{job.status === "succeeded" && job.startedAt && job.finishedAt && (
						<>
							{duration(i18n, job.finishedAt - job.startedAt)}
							{job.costUsd != null && ` · ${usd(i18n, job.costUsd)}`}
						</>
					)}
					{job.status === "failed" && (
						<span className="text-danger">{t("job.failed")}</span>
					)}
					{job.status === "canceled" && t("job.canceled")}
				</p>
			</header>

			<div className="flex flex-1 flex-col gap-2 p-2">
				{pending && (
					<div
						className="developing flex flex-col items-center justify-center gap-3 rounded-md"
						style={{ aspectRatio: `${width} / ${height}` }}
					>
						<p className="font-mono text-xs text-dim" aria-live="polite">
							{job.status === "queued"
								? t("job.waiting")
								: describeProgress(i18n, progress)}
						</p>
						<button
							type="button"
							onClick={() => cancel.mutate()}
							disabled={cancel.isPending}
							className="rounded-md border border-line bg-panel px-3 py-1 text-xs hover:border-dim"
						>
							{t("common.cancel")}
						</button>
					</div>
				)}
				{job.status === "failed" && (
					<p className="p-2 text-sm leading-relaxed text-danger">
						{i18n.explain({
							message: job.error ?? "",
							code: job.errorCode,
							params: job.errorParams,
						})}
					</p>
				)}
				{job.status === "canceled" && (
					<p className="p-2 text-sm text-dim">{t("job.canceledEarly")}</p>
				)}
				<div
					className={
						job.assets.length > 1 ? "grid grid-cols-2 gap-2" : "contents"
					}
				>
					{job.assets.map((asset) => {
						const open = () =>
							props.onOpen({
								assetId: asset.id,
								mime: asset.mime,
								prompt: props.prompt,
								modelName: name,
								params: job.params,
								costUsd:
									job.costUsd == null ? null : job.costUsd / job.assets.length,
							});
						const overlay =
							"absolute rounded-md bg-black/75 px-2 py-1 text-xs text-white opacity-0 focus-visible:opacity-100 group-hover:opacity-100";
						return asset.mime.startsWith("video/") ? (
							<div key={asset.id} className="group relative">
								{/* biome-ignore lint/a11y/useMediaCaption: generated clips have no transcript */}
								<video
									src={assetUrl(asset.id)}
									aria-label={`${name}: ${props.prompt}`}
									controls
									loop
									playsInline
									preload="metadata"
									className="w-full rounded-md bg-black"
								/>
								<button
									type="button"
									onClick={open}
									className={`${overlay} right-2 top-2`}
								>
									{t("job.details")}
								</button>
							</div>
						) : (
							<div key={asset.id} className="group relative">
								<button
									type="button"
									aria-label={t("job.openImage", { model: name })}
									onClick={open}
									className="block w-full"
								>
									<img
										src={assetUrl(asset.id)}
										alt={`${name}: ${props.prompt}`}
										loading="lazy"
										className="w-full rounded-md"
									/>
								</button>
								<button
									type="button"
									onClick={() => props.onUseAsReference(asset.id)}
									className={`${overlay} bottom-2 left-2`}
								>
									{t("common.useAsReference")}
								</button>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}

function TurnBlock(props: {
	turn: TurnView;
	models: Map<string, ModelSpec>;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
}) {
	const { turn } = props;
	const { t } = useI18n();
	const columns = Math.min(turn.jobs.length, 3);
	return (
		<article className="flex flex-col gap-3">
			<div className="flex items-start gap-3">
				{turn.referenceAssetIds.map((id) => (
					<img
						key={id}
						src={assetUrl(id)}
						alt={t("common.reference")}
						className="size-12 shrink-0 rounded-md border border-line object-cover"
					/>
				))}
				<p className="whitespace-pre-wrap text-lg leading-snug">
					{turn.prompt}
				</p>
			</div>
			<div
				className="grid gap-3 max-md:!grid-cols-1"
				style={{
					gridTemplateColumns: `repeat(${columns}, minmax(0, ${columns === 1 ? "28rem" : "1fr"}))`,
				}}
			>
				{turn.jobs.map((job) => (
					<JobCard
						key={job.id}
						job={job}
						prompt={turn.prompt}
						model={props.models.get(job.modelId)}
						onOpen={props.onOpen}
						onUseAsReference={props.onUseAsReference}
					/>
				))}
			</div>
		</article>
	);
}

/** What a running job is doing, in the reader's language. */
function describeProgress(
	i18n: I18n,
	progress: JobProgress | undefined,
): string {
	if (!progress) return i18n.t("job.starting");
	const percent =
		progress.fraction == null
			? null
			: i18n.number(progress.fraction, { style: "percent" });
	const stage =
		progress.stage === "queued"
			? progress.position != null
				? i18n.t("progress.queuedAt", { position: progress.position })
				: i18n.t("progress.queued")
			: progress.stage === "starting"
				? i18n.t("progress.starting")
				: progress.stage === "loading"
					? i18n.t("progress.loading")
					: progress.stage === "generating"
						? i18n.t("progress.generating")
						: progress.message;
	return [stage, percent].filter(Boolean).join(" · ") || i18n.t("job.starting");
}

export function Chat({
	sessionId,
	references,
	setReferences,
	addReference,
}: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const client = useQueryClient();
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	const session = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => api.session(sessionId as string),
		enabled: sessionId != null,
	});
	const [open, setOpen] = useState<LightboxItem | null>(null);
	const end = useRef<HTMLDivElement>(null);
	const turnCount = session.data?.turns.length ?? 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a turn is added
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [turnCount]);

	const create = useMutation({
		mutationFn: (draft: Draft) =>
			api.createTurn({ ...draft, sessionId, referenceAssetIds: references }),
		onSuccess: ({ session: created, turn }) => {
			// Drop only what was sent; more may have been added meanwhile.
			setReferences((current) =>
				current.filter((id) => !turn.referenceAssetIds.includes(id)),
			);
			client.setQueryData<SessionDetail>(["session", created.id], (current) =>
				current?.turns.some((t) => t.id === turn.id)
					? current
					: {
							...(current ?? created),
							turns: [...(current?.turns ?? []), turn],
						},
			);
			void client.invalidateQueries({ queryKey: ["session", created.id] });
			void client.invalidateQueries({ queryKey: ["sessions"] });
			// Follow the new session unless the user has already gone elsewhere.
			if (
				!sessionId &&
				["", "#", href.newChat].includes(window.location.hash)
			) {
				navigate(href.session(created.id));
			}
		},
	});

	const byId = new Map(models.data?.map((m) => [m.id, m]));
	const loadError = session.error ?? models.error ?? providers.error;

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
					{loadError && (
						<p className="text-sm text-danger">{i18n.explain(loadError)}</p>
					)}
					{!sessionId && (
						<div className="py-16">
							<h1 className="text-3xl font-semibold tracking-tight">
								{t("chat.heading")}
							</h1>
							<p className="mt-3 max-w-xl leading-relaxed text-dim">
								{t("chat.intro")}
							</p>
						</div>
					)}
					{session.data?.turns.map((turn) => (
						<TurnBlock
							key={turn.id}
							turn={turn}
							models={byId}
							onOpen={setOpen}
							onUseAsReference={addReference}
						/>
					))}
					<div ref={end} />
				</div>
			</div>
			<Composer
				models={models.data ?? []}
				providers={providers.data ?? []}
				references={references}
				setReferences={setReferences}
				busy={create.isPending}
				error={create.error ? i18n.explain(create.error) : null}
				onSubmit={(draft) => create.mutate(draft)}
			/>
			{open && (
				<Lightbox
					item={open}
					onClose={() => setOpen(null)}
					onUseAsReference={(id) => {
						addReference(id);
						setOpen(null);
					}}
				/>
			)}
		</>
	);
}
