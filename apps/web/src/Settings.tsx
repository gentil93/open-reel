import type { ProviderStatus } from "@open-reel/core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";

function ProviderRow({ provider }: { provider: ProviderStatus }) {
	const client = useQueryClient();
	const [key, setKey] = useState("");
	const done = () => {
		setKey("");
		return client.invalidateQueries({ queryKey: ["providers"] });
	};
	const save = useMutation({
		mutationFn: () => api.setKey(provider.id, key),
		onSuccess: done,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteKey(provider.id),
		onSuccess: done,
	});
	const error = save.error ?? remove.error;

	return (
		<li className="rounded-lg border border-line bg-panel p-4">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="font-medium">{provider.name}</h2>
				<span
					className={`font-mono text-xs ${provider.hasKey ? "text-accent" : "text-dim"}`}
				>
					{provider.hasKey
						? "key configured"
						: provider.requiresKey
							? "no key"
							: "no key needed"}
				</span>
			</div>
			{provider.requiresKey && (
				<form
					className="mt-3 flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(event) => setKey(event.target.value)}
						placeholder={
							provider.hasKey ? "Replace the key" : "Paste your API key"
						}
						aria-label={`${provider.name} API key`}
						autoComplete="off"
						className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-sm"
					/>
					<button
						type="submit"
						disabled={!key.trim() || save.isPending}
						className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40"
					>
						Save
					</button>
					{provider.hasKey && (
						<button
							type="button"
							onClick={() => remove.mutate()}
							disabled={remove.isPending}
							className="rounded-md border border-line px-3 py-2 text-sm text-dim hover:text-danger"
						>
							Remove
						</button>
					)}
				</form>
			)}
			{error && <p className="mt-2 text-sm text-danger">{error.message}</p>}
		</li>
	);
}

export function Settings() {
	const providers = useQuery({
		queryKey: ["providers"],
		queryFn: api.providers,
	});
	return (
		<div className="mx-auto w-full max-w-2xl overflow-y-auto p-8">
			<h1 className="text-xl font-semibold">Providers</h1>
			<p className="mt-2 text-sm leading-relaxed text-dim">
				Keys are stored on this computer and sent only to the provider they
				belong to. They are never shown again after saving.
			</p>
			{providers.error && (
				<p className="mt-6 text-sm text-danger">{providers.error.message}</p>
			)}
			<ul className="mt-6 flex flex-col gap-3">
				{providers.data?.map((provider) => (
					<ProviderRow key={provider.id} provider={provider} />
				))}
			</ul>
		</div>
	);
}
