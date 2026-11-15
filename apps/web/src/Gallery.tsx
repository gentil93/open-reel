import type { GalleryItem } from "@open-reel/core/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, assetUrl, GALLERY_PAGE } from "./api";
import { Lightbox, type LightboxItem } from "./Lightbox";

export function Gallery({
	addReference,
}: {
	addReference(assetId: string): void;
}) {
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
					<h1 className="text-xl font-semibold">Gallery</h1>
					<input
						type="search"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						placeholder="Search prompts"
						aria-label="Search prompts"
						className="w-72 max-w-full rounded-md border border-line bg-panel px-3 py-2 text-sm"
					/>
				</div>
				{pages.error && (
					<p className="mt-6 text-sm text-danger">{pages.error.message}</p>
				)}
				{pages.isSuccess && items.length === 0 && (
					<p className="mt-16 text-center text-dim">
						{query
							? `No image has a prompt matching “${query}”.`
							: "Images you generate will appear here."}
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
										prompt: item.prompt,
										modelName: modelName(item.modelId),
										params: item.params,
										costUsd: null,
									})
								}
								className="block w-full"
							>
								<img
									src={assetUrl(item.id)}
									alt={item.prompt ?? "Generated image"}
									loading="lazy"
									className="aspect-square w-full rounded-md border border-line object-cover"
								/>
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
							{pages.isFetchingNextPage ? "Loading…" : "Load more"}
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
