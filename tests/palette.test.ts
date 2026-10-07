/**
 * Palette coverage: theme-name resolution gates, memo identity (the diff card's
 * width cache keys on it), color-depth encoding, and override plumbing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	fgAnsi,
	getActiveColorMode,
	isLightThemeName,
	paletteKeyForThemeName,
	parseAnsiRgb,
	resolvePalette,
	semanticOverride,
	setActiveColorMode,
	setDiffOverrides,
} from "../extension/palette.js";

afterEach(() => {
	setActiveColorMode("truecolor");
	setDiffOverrides({});
});

describe("paletteKeyForThemeName", () => {
	test("resolves shipped CC themes", () => {
		expect(paletteKeyForThemeName("claude-code-dark")).toBe("dark");
		expect(paletteKeyForThemeName("claude-code-dark-ansi")).toBe("dark-ansi");
		expect(paletteKeyForThemeName("claude-code-light-daltonized")).toBe("light-daltonized");
	});

	test("rejects pi's built-in names and unknown themes", () => {
		expect(paletteKeyForThemeName("dark")).toBeUndefined();
		expect(paletteKeyForThemeName("light")).toBeUndefined();
		expect(paletteKeyForThemeName(undefined)).toBeUndefined();
	});

	test("rejects inherited object members", () => {
		expect(paletteKeyForThemeName("claude-code-toString")).toBeUndefined();
		expect(paletteKeyForThemeName("claude-code-constructor")).toBeUndefined();
	});
});

describe("isLightThemeName", () => {
	test("follows the CC key family", () => {
		expect(isLightThemeName("claude-code-light")).toBe(true);
		expect(isLightThemeName("claude-code-dark")).toBe(false);
	});

	test("matches a whole light segment only", () => {
		expect(isLightThemeName("light")).toBe(true);
		expect(isLightThemeName("my-light-theme")).toBe(true);
		expect(isLightThemeName("moonlight")).toBe(false);
		expect(isLightThemeName("highlight")).toBe(false);
		expect(isLightThemeName(undefined)).toBe(false);
	});
});

describe("resolvePalette", () => {
	test("marks a CC theme as such", () => {
		const p = resolvePalette("claude-code-dark", () => undefined);
		expect(p.isCcTheme).toBe(true);
		expect(p.scheme).toBe("dark");
		expect(p.variant).toBe("dark");
	});

	test("falls back to pi tokens for a foreign theme", () => {
		const p = resolvePalette("some-other-theme", (token) =>
			token === "success" ? "\x1b[38;2;1;2;3m" : undefined,
		);
		expect(p.isCcTheme).toBe(false);
		expect(p.scheme).toBe("dark");
		expect(p.variant).toBe("dark");
		expect(p.cc.success).toBe("#010203");
	});

	test("returns the same instance for the same theme name and depth", () => {
		const a = resolvePalette("claude-code-dark", () => undefined);
		const b = resolvePalette("claude-code-dark", () => undefined);
		expect(a).toBe(b);
	});

	test("keeps a 256color palette distinct from the truecolor one", () => {
		const truecolor = resolvePalette("claude-code-dark", () => undefined);
		const down = resolvePalette("claude-code-dark", () => "\x1b[38;5;250m");
		expect(down).not.toBe(truecolor);
		expect(truecolor.colorMode).toBe("truecolor");
		expect(down.colorMode).toBe("256color");
	});

	test("treats an ANSI-index probe as no evidence", () => {
		const p = resolvePalette("claude-code-dark", () => "\x1b[38;5;3m");
		expect(p.colorMode).toBe("truecolor");
	});
});

describe("fgAnsi", () => {
	test("encodes hex as 24-bit in truecolor mode", () => {
		setActiveColorMode("truecolor");
		expect(fgAnsi("#ff8000")).toBe("\x1b[38;2;255;128;0m");
	});

	test("downconverts hex to the 256 cube in 256color mode", () => {
		setActiveColorMode("256color");
		expect(fgAnsi("#ff0000")).toMatch(/^\x1b\[38;5;\d{1,3}m$/u);
		expect(getActiveColorMode()).toBe("256color");
	});

	test("passes an ANSI index through regardless of depth", () => {
		setActiveColorMode("256color");
		expect(fgAnsi(1)).toBe("\x1b[31m");
		expect(fgAnsi(9)).toBe("\x1b[91m");
		setActiveColorMode("truecolor");
		expect(fgAnsi(1)).toBe("\x1b[31m");
	});
});

describe("parseAnsiRgb", () => {
	test("round-trips a truecolor escape", () => {
		expect(parseAnsiRgb("\x1b[38;2;10;20;30m")).toEqual({ r: 10, g: 20, b: 30 });
		expect(parseAnsiRgb("\x1b[48;2;1;2;3m")).toEqual({ r: 1, g: 2, b: 3 });
	});

	test("rejects non-truecolor escapes", () => {
		expect(parseAnsiRgb("\x1b[38;5;12m")).toBeUndefined();
		expect(parseAnsiRgb("plain")).toBeUndefined();
	});
});

describe("diff overrides", () => {
	test("records known roles and ignores unknown ones on read", () => {
		setDiffOverrides({ diffAddedLine: "#123456", diffRemovedWord: 42 });
		expect(semanticOverride("diffAddedLine")).toBe("#123456");
		expect(semanticOverride("diffRemovedWord")).toBe(42);
		expect(semanticOverride("nope")).toBeUndefined();
	});

	test("clears the override map when handed an empty record", () => {
		setDiffOverrides({ diffAddedLine: "#123456" });
		setDiffOverrides({});
		expect(semanticOverride("diffAddedLine")).toBeUndefined();
	});
});
