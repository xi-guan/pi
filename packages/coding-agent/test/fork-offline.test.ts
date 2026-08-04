import { describe, expect, test } from "vitest";
import { applyOfflineDefault } from "../src/cli/fork-offline.ts";

describe("applyOfflineDefault", () => {
	test("is offline when PI_OFFLINE is unset", () => {
		const env: NodeJS.ProcessEnv = {};
		expect(applyOfflineDefault([], env)).toBe(true);
	});

	test("is offline for values that are not an explicit opt-out", () => {
		for (const value of ["1", "true", "yes", "", "anything"]) {
			const env: NodeJS.ProcessEnv = { PI_OFFLINE: value };
			expect(applyOfflineDefault([], env)).toBe(true);
			expect(env.PI_OFFLINE).toBe(value);
		}
	});

	test("opts out on 0/false/no in any case and clears PI_OFFLINE", () => {
		for (const value of ["0", "false", "FALSE", "no", "No"]) {
			const env: NodeJS.ProcessEnv = { PI_OFFLINE: value };
			expect(applyOfflineDefault([], env)).toBe(false);
			expect("PI_OFFLINE" in env).toBe(false);
		}
	});

	test("--offline wins over an explicit opt-out", () => {
		const env: NodeJS.ProcessEnv = { PI_OFFLINE: "0" };
		expect(applyOfflineDefault(["--offline"], env)).toBe(true);
		expect(env.PI_OFFLINE).toBe("0");
	});
});
