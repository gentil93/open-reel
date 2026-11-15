import type { ProviderAdapter } from "@open-reel/core";
import { FalProvider } from "./fal";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";

export { FalProvider } from "./fal";
export { GoogleProvider } from "./google";
export { OpenAIProvider } from "./openai";

/** Every provider that ships with open-reel. */
export function builtinProviders(): ProviderAdapter[] {
	return [new FalProvider(), new OpenAIProvider(), new GoogleProvider()];
}
