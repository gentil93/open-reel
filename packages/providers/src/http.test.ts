import { describe, expect, test } from "bun:test";
import { BUSY_WHILE_WAITING, failedEvent, refusal, send } from "./http";

const refused = (status: number, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify({ error: { message: "slow down" } }), {
		status,
		headers,
	});

describe("refusals", () => {
	test("a refusal for now may be tried again, after the wait asked for", async () => {
		const busy = await refusal(refused(429, { "retry-after": "7" }), "fal");
		expect(busy.message).toBe("slow down");
		expect(busy.code).toBe("providerBusy");
		expect(busy.params).toEqual({ provider: "fal" });
		expect(busy.retry).toEqual({ afterMs: 7000 });

		const down = await refusal(refused(503), "fal");
		expect(down.retry).toEqual({ afterMs: undefined });
	});

	test("other refusals are final: the work may have been done and charged", async () => {
		for (const status of [400, 401, 402, 500, 502, 504]) {
			const error = await refusal(refused(status), "OpenAI");
			expect(error.retry).toBeUndefined();
			expect(error.message).toBe("slow down");
		}
	});

	test("work done while the connection waits is retried on 429 only", async () => {
		const gateway = await refusal(refused(503), "OpenAI", BUSY_WHILE_WAITING);
		expect(gateway.retry).toBeUndefined();
		const limited = await refusal(refused(429), "OpenAI", BUSY_WHILE_WAITING);
		expect(limited.retry).toEqual({ afterMs: undefined });
	});

	test("a refusal becomes the job's failed event, keeping the retry", async () => {
		const busy = await refusal(refused(429), "fal");
		expect(failedEvent(busy)).toEqual({
			type: "failed",
			error: "slow down",
			code: "providerBusy",
			params: { provider: "fal" },
			retry: { afterMs: undefined },
		});
		const final = await refusal(refused(400), "fal");
		expect(failedEvent(final)).toEqual({ type: "failed", error: "slow down" });
	});
});

describe("sending paid work", () => {
	const failing = (code: string) => async () => {
		throw Object.assign(new TypeError("fetch failed"), { code });
	};

	test("a request that never left may be sent again", async () => {
		for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
			const sent = send(failing(code), "https://api.example", {}, "fal");
			await expect(sent).rejects.toMatchObject({
				code: "noConnection",
				params: { provider: "fal" },
				retry: {},
			});
		}
	});

	test("Node's way of saying it, on the error's cause, is understood", async () => {
		const node = async () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
			});
		};
		await expect(
			send(node, "https://api.example", {}, "fal"),
		).rejects.toMatchObject({ code: "noConnection" });
	});

	test("a connection lost midway is not, since it may have been charged", async () => {
		const sent = send(failing("ECONNRESET"), "https://api.example", {}, "fal");
		await expect(sent).rejects.toThrow("fetch failed");
		await expect(sent).rejects.not.toHaveProperty("retry");
	});

	test("a canceled request stays canceled", async () => {
		const controller = new AbortController();
		controller.abort();
		const sent = send(
			failing("ECONNREFUSED"),
			"https://api.example",
			{ signal: controller.signal },
			"fal",
		);
		await expect(sent).rejects.toThrow("fetch failed");
	});
});
