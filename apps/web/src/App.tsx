import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import { Chat } from "./Chat";
import { Gallery } from "./Gallery";
import { useLiveJobs } from "./live";
import { href, navigate, useRoute } from "./route";
import { Settings } from "./Settings";

const MAX_REFERENCES = 4;

export function App() {
	useLiveJobs();
	const route = useRoute();
	const client = useQueryClient();
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
	// Reference images for the next prompt. Lives here so the gallery can add to it.
	const [references, setReferences] = useState<string[]>([]);

	const addReference = (assetId: string) => {
		setReferences((current) =>
			current.includes(assetId)
				? current
				: [...current, assetId].slice(-MAX_REFERENCES),
		);
		if (route.view !== "chat") navigate(href.newChat);
	};

	const remove = useMutation({
		mutationFn: api.deleteSession,
		onSuccess: (_, id) => {
			if (route.view === "chat" && route.sessionId === id)
				navigate(href.newChat);
			return client.invalidateQueries({ queryKey: ["sessions"] });
		},
	});

	const active = route.view === "chat" ? route.sessionId : undefined;
	const navLink = (current: boolean) =>
		`rounded-md px-3 py-2 text-sm ${current ? "bg-line text-ink" : "text-dim hover:text-ink"}`;

	return (
		<div className="flex h-full">
			<nav className="flex w-60 shrink-0 flex-col border-r border-line bg-panel max-md:hidden">
				<div className="p-4">
					<a
						href={href.newChat}
						className="font-mono text-sm font-semibold tracking-tight"
					>
						open<span className="text-accent">·</span>reel
					</a>
				</div>
				<div className="flex flex-col gap-1 px-2">
					<a
						href={href.newChat}
						className={navLink(route.view === "chat" && !active)}
					>
						New session
					</a>
					<a href={href.gallery} className={navLink(route.view === "gallery")}>
						Gallery
					</a>
				</div>
				<div className="mt-4 px-5 font-mono text-[11px] uppercase tracking-wider text-dim">
					Sessions
				</div>
				<ul className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
					{sessions.data?.map((session) => (
						<li key={session.id} className="group flex items-center">
							<a
								href={href.session(session.id)}
								title={session.title}
								className={`min-w-0 flex-1 truncate ${navLink(session.id === active)}`}
							>
								{session.title}
							</a>
							<button
								type="button"
								aria-label={`Delete session: ${session.title}`}
								onClick={() => {
									if (
										window.confirm(
											"Delete this session? Its images stay in the gallery.",
										)
									) {
										remove.mutate(session.id);
									}
								}}
								className="px-2 text-dim opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
							>
								×
							</button>
						</li>
					))}
					{sessions.data?.length === 0 && (
						<li className="px-3 py-2 text-sm text-dim">Nothing yet.</li>
					)}
				</ul>
				<div className="border-t border-line p-2">
					<a
						href={href.settings}
						className={`block ${navLink(route.view === "settings")}`}
					>
						Providers
					</a>
				</div>
			</nav>

			<main className="flex min-w-0 flex-1 flex-col">
				<div className="flex gap-1 border-b border-line bg-panel p-2 md:hidden">
					<a href={href.newChat} className={navLink(route.view === "chat")}>
						Session
					</a>
					<a href={href.gallery} className={navLink(route.view === "gallery")}>
						Gallery
					</a>
					<a
						href={href.settings}
						className={navLink(route.view === "settings")}
					>
						Providers
					</a>
				</div>
				{route.view === "chat" && (
					<Chat
						key={route.sessionId ?? "new"}
						sessionId={route.sessionId}
						references={references}
						setReferences={setReferences}
						addReference={addReference}
					/>
				)}
				{route.view === "gallery" && <Gallery addReference={addReference} />}
				{route.view === "settings" && <Settings />}
			</main>
		</div>
	);
}
