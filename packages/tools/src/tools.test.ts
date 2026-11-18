import { describe, expect, test } from "bun:test";
import type { JobView, ModelSpec, TurnView } from "@open-reel/core/types";
import type { Reel } from "./reel";
import { SpendGuard } from "./spend";
import { createTools, type ToolContext } from "./tools";

const local = {
	id: "local/z",
	providerId: "local",
	name: "Z",
	media: "image",
	operations: ["generate"],
	capabilities: { aspectRatios: [], maxReferenceImages: 1, maxCount: 1 },
} as unknown as ModelSpec;
const paid = {
	...local,
	id: "fal/x",
	providerId: "fal",
	name: "X",
	pricing: { usdPerOutput: 0.04 },
} as unknown as ModelSpec;

/** A Reel that only knows its models and refuses everything else. */
function reel(): Reel & { turns: number } {
	const self = {
		turns: 0,
		models: async () => [local, paid],
		providers: async () =>
			[
				{ id: "local", hasKey: false, requiresKey: false },
				{ id: "fal", hasKey: true, requiresKey: true },
			] as never,
		session: async () => {
			throw new Error("no sessions");
		},
		createTurn: async () => {
			self.turns++;
			throw new Error("not in this test");
		},
		upload: async () => {
			throw new Error("no uploads");
		},
		gallery: async () => [],
		asset: async () => {
			throw new Error("no assets");
		},
		sessionUrl: (id: string) => `#/s/${id}`,
	};
	return self;
}

const context: ToolContext = {
	signal: new AbortController().signal,
	progress: async () => {},
};

describe("the tools for the assistant inside the app", () => {
	test("never touch files on this computer", async () => {
		const openReel = reel();
		const tools = createTools(openReel, {
			allowPaid: false,
			spend: new SpendGuard(null),
			files: false,
		});
		expect(tools.map((t) => t.name)).not.toContain("save_image");
		const generate = tools.find((t) => t.name === "generate");
		const result = await generate?.run(
			{ prompt: "a fox", reference_images: ["/etc/passwd"] },
			context,
		);
		expect(result?.isError).toBe(true);
		expect(result?.text).toContain("given by id");
		// Refused before anything was made.
		expect(openReel.turns).toBe(0);
	});

	test("a call whose arguments do not fit is refused, not thrown", async () => {
		const tools = createTools(reel(), {
			allowPaid: false,
			spend: new SpendGuard(null),
			files: false,
		});
		const generate = tools.find((t) => t.name === "generate");
		const result = await generate?.run(
			{ prompt: "a fox", reference_images: "ast_1" } as never,
			context,
		);
		expect(result?.isError).toBe(true);
		expect(result?.text).toContain("do not fit generate");
	});

	test("an agent the person runs may save files", () => {
		const tools = createTools(reel(), {
			allowPaid: false,
			spend: new SpendGuard(null),
			files: true,
		});
		expect(tools.map((t) => t.name)).toContain("save_image");
	});
});

describe("the spending guard", () => {
	const turn = (jobs: Partial<JobView>[]): TurnView =>
		({ id: "trn_1", jobs }) as unknown as TurnView;

	test("holds what a turn may cost, and refuses past the limit", () => {
		const spend = new SpendGuard(0.1);
		expect(spend.hold("a", [paid], 2, undefined)).toEqual({
			ok: true,
			usd: 0.08,
		});
		const refused = spend.hold("b", [paid], 1, undefined);
		expect(refused.ok).toBe(false);
		// Free models always fit.
		expect(spend.hold("c", [local], 4, undefined).ok).toBe(true);
		expect(spend.left()).toBeCloseTo(0.02);
	});

	test("counts what an ended turn really cost, once", () => {
		const spend = new SpendGuard(1);
		spend.hold("pending", [paid], 1, undefined);
		spend.rename("pending", "trn_1");
		const ended = turn([
			{
				providerId: "fal",
				modelId: "fal/x",
				status: "succeeded",
				costUsd: 0.03,
			},
		]);
		spend.settle(ended);
		spend.settle(ended);
		expect(spend.committed()).toBeCloseTo(0.03);
	});

	test("a released hold costs nothing", () => {
		const spend = new SpendGuard(1);
		spend.hold("pending", [paid], 1, undefined);
		spend.release("pending");
		expect(spend.committed()).toBe(0);
	});
});
