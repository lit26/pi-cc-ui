/**
 * Pure-function coverage for the diff renderer — the surface that the 0.2.0
 * upstream sync rewrote. No TUI, no host: parse → count → render.
 */
import { describe, expect, test } from "bun:test";
import { resolvePalette } from "../extension/palette.js";
import {
	type DiffLine,
	MAX_PREVIEW_LINES,
	maxLineNumber,
	parseDiff,
	parseUnifiedPatch,
	renderDiffBody,
	renderDiffStatLine,
	snippetDiff,
} from "../extension/tools/diff.js";

const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const plain = (s: string): string => s.replace(ANSI_RE, "");

const palette = resolvePalette("claude-code-dark", () => undefined);

const PATCH = [
	"@@ -1,3 +1,4 @@",
	" keep-one",
	"-old line",
	"+new line",
	"+extra line",
	" keep-two",
	"@@ -10,1 +11,2 @@",
	"-gone",
	"+fresh",
	"+also fresh",
].join("\n");

describe("parseUnifiedPatch", () => {
	test("counts added and removed lines across hunks", () => {
		const diff = parseUnifiedPatch(PATCH);
		expect(diff).toBeDefined();
		expect(diff?.added).toBe(4);
		expect(diff?.removed).toBe(2);
	});

	test("places hunk bodies and numbers them from the header", () => {
		const diff = parseUnifiedPatch(PATCH);
		const lines = diff?.lines ?? [];
		const first = lines.find((line: DiffLine) => line.content === "new line");
		expect(first?.type).toBe("add");
		expect(first?.newNumber).toBe(2);
		const removed = lines.find((line: DiffLine) => line.content === "old line");
		expect(removed?.type).toBe("del");
		expect(removed?.oldNumber).toBe(2);
		expect(removed?.newNumber).toBeUndefined();
	});

	test("separates hunks with a separator row", () => {
		const diff = parseUnifiedPatch(PATCH);
		expect(diff?.lines.some((line: DiffLine) => line.type === "sep")).toBe(true);
	});

	test("returns undefined when the patch carries no hunks", () => {
		expect(parseUnifiedPatch("")).toBeUndefined();
		expect(parseUnifiedPatch("not a patch at all")).toBeUndefined();
	});

	test("rejects a patch past the display size limit", () => {
		const diff = parseUnifiedPatch("x".repeat(2_000_001));
		expect(diff?.notice).toBe("Diff unavailable: persisted patch exceeds display size limit");
		expect(diff?.lines).toEqual([]);
	});
});

describe("parseDiff", () => {
	test("counts a changed line once on each side", () => {
		const diff = parseDiff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
		expect(diff.added).toBe(1);
		expect(diff.removed).toBe(1);
		expect(diff.notice).toBeUndefined();
	});

	test("yields no records for identical content", () => {
		const diff = parseDiff("same\ntext\n", "same\ntext\n");
		expect(diff.added).toBe(0);
		expect(diff.removed).toBe(0);
		expect(diff.lines).toHaveLength(0);
	});

	test("refuses content past the computation size limit", () => {
		const diff = parseDiff("", "y".repeat(2_000_001));
		expect(diff.notice).toBe(
			"Diff unavailable: display computation size limit reached",
		);
	});
});

describe("snippetDiff", () => {
	test("labels each edit block and drops file coordinates", () => {
		const diff = snippetDiff([
			{ oldText: "one\n", newText: "ONE\n" },
			{ oldText: "two\n", newText: "TWO\n" },
		]);
		expect(diff.lines[0]?.content).toBe("Edit 1 (file coordinates unavailable)");
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(2);
		expect(diff.lines.every((line) => line.oldNumber === undefined)).toBe(true);
		expect(diff.notice).toBe("Per-edit snippets; file coordinates unavailable");
	});

	test("handles an empty edit list", () => {
		const diff = snippetDiff([]);
		expect(diff.lines).toEqual([]);
		expect(diff.added).toBe(0);
	});
});

describe("maxLineNumber", () => {
	test("ignores separators and meta rows", () => {
		const lines: DiffLine[] = [
			{ type: "sep", oldNumber: undefined, newNumber: undefined, content: "" },
			{ type: "meta", oldNumber: 900, newNumber: 900, content: "" },
			{ type: "add", oldNumber: undefined, newNumber: 7, content: "x" },
			{ type: "del", oldNumber: 12, newNumber: undefined, content: "y" },
		];
		expect(maxLineNumber(lines)).toBe(12);
	});

	test("is zero for an empty record set", () => {
		expect(maxLineNumber([])).toBe(0);
	});
});

describe("renderDiffStatLine", () => {
	test("renders additions only", () => {
		expect(plain(renderDiffStatLine(2, 0))).toBe("Added 2 lines");
	});
	test("renders removals only, capitalized", () => {
		expect(plain(renderDiffStatLine(0, 1))).toBe("Removed 1 line");
	});
	test("renders both, joining with lowercase removed", () => {
		expect(plain(renderDiffStatLine(3, 2))).toBe("Added 3 lines, removed 2 lines");
	});
	test("is empty when nothing changed", () => {
		expect(renderDiffStatLine(0, 0)).toBe("");
	});
});

describe("renderDiffBody", () => {
	test("renders nothing for a zero-width viewport", () => {
		expect(renderDiffBody(palette, parseDiff("a\n", "b\n"), 0, { maxLines: 10, expandHint: false })).toEqual([]);
	});

	test("emits one row per changed record with a sign gutter", () => {
		const diff = parseDiff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
		const rows = renderDiffBody(palette, diff, 80, { maxLines: 10, expandHint: false });
		const removed = rows.find((row) => plain(row).includes("beta"));
		const added = rows.find((row) => plain(row).includes("BETA"));
		expect(plain(removed ?? "")).toContain("-");
		expect(plain(added ?? "")).toContain("+");
	});

	test("respects the maxLines budget", () => {
		const oldText = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const newText = Array.from({ length: 200 }, (_, i) => `LINE ${i}`).join("\n");
		const rows = renderDiffBody(palette, parseDiff(oldText, newText), 60, {
			maxLines: MAX_PREVIEW_LINES,
			expandHint: false,
		});
		expect(rows.length).toBeLessThanOrEqual(MAX_PREVIEW_LINES + 1);
	});

	test("surfaces the notice as a trailing row", () => {
		const diff = parseDiff("", "z".repeat(2_000_001));
		const rows = renderDiffBody(palette, diff, 120, { maxLines: 10, expandHint: false });
		expect(rows.some((row) => plain(row).includes("display computation size limit"))).toBe(true);
	});
});
