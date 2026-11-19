import type { GenerationParams } from "@hatchlight/core/types";
import { useEffect, useRef } from "react";
import { assetUrl } from "./api";
import { usd } from "./format";
import { type I18n, useI18n } from "./i18n";

export interface LightboxItem {
	assetId: string;
	mime: string;
	prompt: string | null;
	modelName: string | null;
	params: GenerationParams | null;
	costUsd: number | null;
}

/** What is known about a picture or video made, as label and value. */
export function itemFacts(i18n: I18n, item: LightboxItem): [string, unknown][] {
	const { t } = i18n;
	return (
		[
			[t("lightbox.model"), item.modelName],
			[t("lightbox.ratio"), item.params?.aspectRatio],
			[
				t("lightbox.length"),
				item.params?.durationSeconds &&
					t("format.seconds", { seconds: item.params.durationSeconds }),
			],
			[t("lightbox.seed"), item.params?.seed],
			[
				t("lightbox.cost"),
				item.costUsd == null
					? null
					: item.costUsd === 0
						? t("picker.free")
						: usd(i18n, item.costUsd),
			],
		] as [string, unknown][]
	).filter(([, value]) => value != null);
}

interface Props {
	item: LightboxItem;
	onClose(): void;
	onUseAsReference(assetId: string): void;
}

export function Lightbox({ item, onClose, onUseAsReference }: Props) {
	const i18n = useI18n();
	const { t } = i18n;
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		ref.current?.showModal();
	}, []);

	const video = item.mime.startsWith("video/");
	const facts = itemFacts(i18n, item);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop closes; Esc already does so natively
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(event) => event.target === ref.current && onClose()}
			className="m-auto max-h-[92vh] w-[min(1100px,94vw)] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<div className="flex max-h-[92vh] flex-col md:flex-row">
				{video ? (
					// biome-ignore lint/a11y/useMediaCaption: generated clips have no transcript
					<video
						src={assetUrl(item.assetId)}
						controls
						autoPlay
						loop
						playsInline
						className="min-h-0 min-w-0 flex-1 bg-black object-contain"
					/>
				) : (
					<img
						src={assetUrl(item.assetId)}
						alt={item.prompt ?? t("common.generatedImage")}
						className="min-h-0 min-w-0 flex-1 bg-black object-contain"
					/>
				)}
				<div className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto p-5 md:w-72">
					{item.prompt && (
						<p className="whitespace-pre-wrap text-sm leading-relaxed">
							{item.prompt}
						</p>
					)}
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
						{facts.map(([label, value]) => (
							<div key={label} className="contents">
								<dt className="text-dim">{label}</dt>
								<dd>{String(value)}</dd>
							</div>
						))}
					</dl>
					<div className="mt-auto flex flex-col gap-2 text-sm">
						{!video && (
							<button
								type="button"
								onClick={() => onUseAsReference(item.assetId)}
								className="rounded-md bg-accent px-3 py-2 font-medium text-accent-ink"
							>
								{t("common.useAsReference")}
							</button>
						)}
						<a
							href={assetUrl(item.assetId)}
							download={`hatchlight-${item.assetId}`}
							className="rounded-md border border-line px-3 py-2 text-center hover:border-dim"
						>
							{t("lightbox.download")}
						</a>
						<button
							type="button"
							onClick={onClose}
							className="rounded-md px-3 py-2 text-dim hover:text-ink"
						>
							{t("common.close")}
						</button>
					</div>
				</div>
			</div>
		</dialog>
	);
}
