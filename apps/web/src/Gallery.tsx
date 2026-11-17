import type { GalleryItem } from "@open-reel/core/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, assetUrl, GALLERY_PAGE } from "./api";
import { useI18n } from "./i18n";
import { Lightbox, type LightboxItem } from "./Lightbox";

export function Gallery({
	addReference,
}: {
	addReference(assetId: string): void;
}) {
	const { t, explain } = useI18n();
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<LightboxItem | null>(null);
	const models = useQuery({ queryKey: ["models"], queryFn: api.models });

	useEffect(() => {
		const timer = setTimeout(() => setQuery(input.trim()), 250);
		return () => clearTimeout(timer);
	}, [input]);

	const pages = useInfiniteQuery({
		queryKey: ["gallery", query],
		queryFn: ({ pageParam }) => api.gallery(query, pageParam),
		initialPageParam: undefined as GalleryItem | undefined,
		getNextPageParam: (last) =>
			last.length < GALLERY_PAGE ? undefined : last.at(-1),
	});
	const items = pages.data?.pages.flat() ?? [];
	const modelName = (id: string | null) =>
		id ? (models.data?.find((m) => m.id === id)?.name ?? id) : null;

	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-6">
			<div className="mx-auto max-w-6xl">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<h1 className="font-display text-4xl leading-none font-black uppercase tracking-wide">
						{t("gallery.title")}
					</h1>
					<input
						type="search"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						placeholder={t("gallery.search")}
						aria-label={t("gallery.search")}
						className="w-72 max-w-full rounded-md border border-line bg-panel px-3 py-2 text-sm"
					/>
				</div>
				{pages.error && (
					<p className="mt-6 text-sm text-danger">{explain(pages.error)}</p>
				)}
				{pages.isSuccess && items.length === 0 && (
					<p className="mt-16 text-center text-dim">
						{query ? t("gallery.noMatches", { query }) : t("gallery.empty")}
					</p>
				)}
				<ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
					{items.map((item) => (
						<li key={item.id}>
							<button
								type="button"
								title={item.prompt ?? undefined}
								onClick={() =>
									setOpen({
										assetId: item.id,
										mime: item.mime,
										prompt: item.prompt,
										modelName: modelName(item.modelId),
										params: item.params,
										costUsd: null,
									})
								}
								className="relative block w-full"
							>
								{item.mime.startsWith("video/") ? (
									<>
										<video
											src={assetUrl(item.id)}
											aria-label={item.prompt ?? t("gallery.generatedVideo")}
											muted
											playsInline
											preload="metadata"
											className="aspect-square w-full rounded-md border border-line object-cover"
										/>
										<span className="absolute bottom-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] uppercase text-white">
											{t("gallery.videoBadge")}
										</span>
									</>
								) : (
									<img
										src={assetUrl(item.id)}
										alt={item.prompt ?? t("common.generatedImage")}
										loading="lazy"
										className="aspect-square w-full rounded-md border border-line object-cover"
									/>
								)}
							</button>
						</li>
					))}
				</ul>
				{pages.hasNextPage && (
					<div className="mt-6 text-center">
						<button
							type="button"
							onClick={() => pages.fetchNextPage()}
							disabled={pages.isFetchingNextPage}
							className="rounded-md border border-line px-4 py-2 text-sm hover:border-dim"
						>
							{pages.isFetchingNextPage
								? t("gallery.loading")
								: t("gallery.loadMore")}
						</button>
					</div>
				)}
			</div>
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
		</div>
	);
}
