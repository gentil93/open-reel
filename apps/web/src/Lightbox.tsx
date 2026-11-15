import type { GenerationParams } from "@open-reel/core/types";
import { useEffect, useRef } from "react";
import { assetUrl } from "./api";
import { usd } from "./format";

export interface LightboxItem {
	assetId: string;
	prompt: string | null;
	modelName: string | null;
	params: GenerationParams | null;
	costUsd: number | null;
}

interface Props {
	item: LightboxItem;
	onClose(): void;
	onUseAsReference(assetId: string): void;
}

export function Lightbox({ item, onClose, onUseAsReference }: Props) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		ref.current?.showModal();
	}, []);

	const facts = [
		["Model", item.modelName],
		["Ratio", item.params?.aspectRatio],
		["Seed", item.params?.seed],
		["Cost", item.costUsd == null ? null : usd(item.costUsd)],
	].filter(([, value]) => value != null);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop closes; Esc already does so natively
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(event) => event.target === ref.current && onClose()}
			className="m-auto max-h-[92vh] w-[min(1100px,94vw)] rounded-lg border border-line bg-panel p-0 text-ink"
		>
			<div className="flex max-h-[92vh] flex-col md:flex-row">
				<img
					src={assetUrl(item.assetId)}
					alt={item.prompt ?? "Generated image"}
					className="min-h-0 flex-1 bg-black object-contain"
				/>
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
								<dd>{value}</dd>
							</div>
						))}
					</dl>
					<div className="mt-auto flex flex-col gap-2 text-sm">
						<button
							type="button"
							onClick={() => onUseAsReference(item.assetId)}
							className="rounded-md bg-accent px-3 py-2 font-medium text-accent-ink"
						>
							Use as reference
						</button>
						<a
							href={assetUrl(item.assetId)}
							download={`open-reel-${item.assetId}`}
							className="rounded-md border border-line px-3 py-2 text-center hover:border-dim"
						>
							Download
						</a>
						<button
							type="button"
							onClick={onClose}
							className="rounded-md px-3 py-2 text-dim hover:text-ink"
						>
							Close
						</button>
					</div>
				</div>
			</div>
		</dialog>
	);
}
