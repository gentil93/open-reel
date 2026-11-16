import type { ProviderAdapter } from "@open-reel/core";
import { FalProvider } from "./fal";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";
import { OpenRouterProvider } from "./openrouter";
import { ReplicateProvider } from "./replicate";

export { FalProvider } from "./fal";
export { GoogleProvider } from "./google";
export { builtinLocalModels } from "./local-models";
export { OpenAIProvider } from "./openai";
export { OpenRouterProvider } from "./openrouter";
export { ReplicateProvider } from "./replicate";

/** Every provider that ships with open-reel. */
export function builtinProviders(): ProviderAdapter[] {
	return [
		new FalProvider(),
		new OpenAIProvider(),
		new GoogleProvider(),
		new ReplicateProvider(),
		new OpenRouterProvider(),
	];
}
