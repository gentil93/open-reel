import type { ProviderAdapter } from "@open-reel/core";
import { FalProvider } from "./fal";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";
import { OpenRouterProvider } from "./openrouter";
import { withProfiles } from "./profiles";
import { ReplicateProvider } from "./replicate";

export { builtinEngines } from "./engines";
export { FalProvider } from "./fal";
export { GoogleProvider } from "./google";
export { builtinLocalModels } from "./local-models";
export { OpenAIProvider } from "./openai";
export { OpenRouterProvider } from "./openrouter";
export { PROFILES, profileFor, withProfiles } from "./profiles";
export { ReplicateProvider } from "./replicate";
export { CloudTranslator, type CloudTranslatorId } from "./translators";

/** Every provider that ships with open-reel, with their models' profiles. */
export function builtinProviders(): ProviderAdapter[] {
	return [
		new FalProvider(),
		new OpenAIProvider(),
		new GoogleProvider(),
		new ReplicateProvider(),
		new OpenRouterProvider(),
	].map(withProfiles);
}
