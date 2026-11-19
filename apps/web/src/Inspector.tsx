import { assetUrl } from "./api";
import { useI18n } from "./i18n";
import { itemFacts, type LightboxItem } from "./Lightbox";

interface Props {
	item: LightboxItem | null;
	onOpen(item: LightboxItem): void;
	onUseAsReference(assetId: string): void;
	/** Makes the picture larger, when an upscaler is installed. */
	upscale?: { factor: number; busy: boolean; run(assetId: string): void };
	/** Goes to the conversation about this session, when there is one. */
	talkHref?: string;
}

/** The picture chosen in the advanced view: what it is, and what to do next. */
export function Inspector({
	item,
	onOpen,
	onUseAsReference,
	upscale,
	talkHref,
}: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const action =
		"rounded-md border border-line px-3 py-2 text-left text-sm hover:border-dim disabled:opacity-40";
	return (
		<aside
			aria-label={t("inspector.label")}
			className="flex min-h-0 flex-col gap-4 overflow-y-auto border-line bg-panel p-4 lg:border-l"
		>
			{!item ? (
				<p className="text-sm leading-relaxed text-dim">
					{t("inspector.empty")}
				</p>
			) : (
				<>
					<button
						type="button"
						onClick={() => onOpen(item)}
						aria-label={t("inspector.openLarge")}
						className="block overflow-hidden rounded-lg border border-line"
					>
						{item.mime.startsWith("video/") ? (
							<video
								src={assetUrl(item.assetId)}
								muted
								loop
								autoPlay
								playsInline
								className="w-full bg-black"
							/>
						) : (
							<img
								src={assetUrl(item.assetId)}
								alt={item.prompt ?? t("common.generatedImage")}
								className="w-full bg-black object-contain"
							/>
						)}
					</button>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
						{itemFacts(i18n, item).map(([label, value]) => (
							<div key={label} className="contents">
								<dt className="text-dim">{label}</dt>
								<dd className="min-w-0 truncate">{String(value)}</dd>
							</div>
						))}
					</dl>
					<div className="flex flex-col gap-2">
						{!item.mime.startsWith("video/") && (
							<button
								type="button"
								onClick={() => onUseAsReference(item.assetId)}
								className="rounded-md bg-accent px-3 py-2 text-left text-sm font-medium text-accent-ink"
							>
								{t("common.useAsReference")}
							</button>
						)}
						{upscale && item.mime.startsWith("image/") && (
							<button
								type="button"
								disabled={upscale.busy}
								onClick={() => upscale.run(item.assetId)}
								className={action}
							>
								{t("job.upscale", { factor: i18n.number(upscale.factor) })}
							</button>
						)}
						<button
							type="button"
							onClick={() => onOpen(item)}
							className={action}
						>
							{t("inspector.openLarge")}
						</button>
						{talkHref && (
							<a href={talkHref} className={action}>
								{t("inspector.talk")}
							</a>
						)}
					</div>
					{item.prompt && (
						<details className="text-xs leading-relaxed text-dim">
							<summary className="w-fit cursor-pointer hover:text-ink">
								{t("job.details")}
							</summary>
							<p className="mt-1 whitespace-pre-wrap text-ink">{item.prompt}</p>
							{item.params?.translatedPrompt && (
								<p className="mt-2">
									{t("job.translated")}{" "}
									<span className="text-ink">
										{item.params.translatedPrompt}
									</span>
								</p>
							)}
						</details>
					)}
				</>
			)}
		</aside>
	);
}
