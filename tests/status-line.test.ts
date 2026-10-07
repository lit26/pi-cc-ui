/**
 * tildeHome boundary rules — a bare `cwd.replace(HOME, "~")` corrupts paths
 * that only share a *prefix* with home (AUDIT §5 status-line.ts:66).
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { tildeHome } from "../extension/status-line.js";

const home = homedir();

describe("tildeHome", () => {
	test("collapses the home directory itself", () => {
		expect(tildeHome(home)).toBe("~");
	});

	test("collapses paths under home, keeping the remainder absolute", () => {
		expect(tildeHome(`${home}/projects/pi-cc-ui`)).toBe("~/projects/pi-cc-ui");
	});

	test("leaves paths outside home untouched", () => {
		expect(tildeHome("/tmp/work")).toBe("/tmp/work");
		expect(tildeHome("/opt/pi")).toBe("/opt/pi");
	});

	test("requires a separator after home so siblings are not rewritten", () => {
		expect(tildeHome(`${home}-backup`)).toBe(`${home}-backup`);
	});

	test("leaves an already-tilde path untouched", () => {
		expect(tildeHome("~/relative")).toBe("~/relative");
	});

	test("returns the empty path unchanged", () => {
		expect(tildeHome("")).toBe("");
	});
});
