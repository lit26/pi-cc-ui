/**
 * shell.ts — the display text behind generic (no-renderer) tool rows.
 *
 * Covers the upstream pi-cc-ui 0.5.0 behavior ported for MCP and other
 * extension tools: control sequences stripped, OSC-8 links kept as text,
 * compact JSON pretty-printed, URLs linkified.
 */
import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatJson, genericToolContent, renderToolShell, sanitizeToolText } from "../extension/tools/shell.js";

const ESC = "\u001B";
const DOT = process.platform === "darwin" ? "⏺" : "●";

/** Identity theme: fg/bold return the text unchanged. */
const theme = {
	name: "test",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

interface FakeHost {
	toolName: string;
	toolCallId: string;
	expanded: boolean;
	isPartial: boolean;
	executionStarted: boolean;
	hideComponent: boolean;
	result: unknown;
	imageComponents: unknown[];
	imageSpacers: unknown[];
	contentBox?: { children: { render(width: number): string[] }[] };
	hasRendererDefinition(): boolean;
	getRenderShell(): unknown;
	invalidate(): void;
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
	return {
		toolName: "mcp__srv__tool",
		toolCallId: "call-1",
		expanded: false,
		isPartial: false,
		executionStarted: true,
		hideComponent: false,
		result: { content: [{ type: "text", text: '{"a":1}' }], isError: false },
		imageComponents: [],
		imageSpacers: [],
		hasRendererDefinition: () => false,
		getRenderShell: () => "default",
		invalidate: () => {},
		...overrides,
	};
}

describe("sanitizeToolText", () => {
	test("strips CSI color and cursor sequences", () => {
		expect(sanitizeToolText(`${ESC}[31mred${ESC}[0m`)).toBe("red");
		expect(sanitizeToolText(`a${ESC}[2Kb`)).toBe("ab");
	});

	test("keeps an OSC-8 hyperlink's URL as text when it differs from the label", () => {
		const linked = `${ESC}]8;;https://example.com/x${ESC}\\click${ESC}]8;;${ESC}\\`;
		expect(sanitizeToolText(linked)).toBe("click (https://example.com/x)");
	});

	test("drops an OSC-8 hyperlink's URL when it duplicates the label", () => {
		const linked = `${ESC}]8;;https://example.com/x${ESC}\\https://example.com/x${ESC}]8;;${ESC}\\`;
		expect(sanitizeToolText(linked)).toBe("https://example.com/x");
	});

	test("applies carriage returns like a terminal", () => {
		expect(sanitizeToolText("progress 10%\rprogress 90%")).toBe("progress 90%");
	});

	test("strips bidi and unsafe control characters", () => {
		expect(sanitizeToolText(`a\u202Eb\u0007c`)).toBe("abc");
	});

	test("returns plain text untouched (fast path)", () => {
		expect(sanitizeToolText("Read 120 lines")).toBe("Read 120 lines");
	});
});

describe("formatJson", () => {
	test("pretty-prints compact JSON", () => {
		expect(formatJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
	});

	test("leaves already-pretty JSON unchanged", () => {
		const pretty = '{\n  "a": 1\n}';
		expect(formatJson(pretty)).toBe(pretty);
	});

	test("leaves non-JSON text alone", () => {
		expect(formatJson("Read 120 lines")).toBe("Read 120 lines");
		expect(formatJson("{not json}")).toBe("{not json}");
	});
});

describe("genericToolContent", () => {
	test("joins text blocks with a blank line", () => {
		expect(genericToolContent({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] })).toBe(
			"one\n\ntwo",
		);
	});

	test("pretty-prints a JSON text block", () => {
		expect(genericToolContent({ content: [{ type: "text", text: '{"a":1}' }] })).toBe('{\n  "a": 1\n}');
	});

	test("renders an empty text block as (No content)", () => {
		expect(genericToolContent({ content: [{ type: "text", text: "   " }] })).toBe("(No content)");
	});

	test("names unsupported content blocks", () => {
		expect(genericToolContent({ content: [{ type: "resource" }] })).toBe("(resource content)");
	});

	test("skips image blocks and reports an image-only result as empty", () => {
		expect(genericToolContent({ content: [{ type: "image", data: "x", mimeType: "image/png" }] })).toBe("");
	});

	test("falls back to (No content) for an empty or missing result", () => {
		expect(genericToolContent({ content: [] })).toBe("(No content)");
		expect(genericToolContent(undefined)).toBe("(No content)");
	});
});

describe("renderToolShell", () => {
	test("leaves the builtins' renderShell self rows to the host", () => {
		expect(renderToolShell(fakeHost({ getRenderShell: () => "self" }), 80, theme)).toBeUndefined();
	});

	test("frames a generic tool with the state dot and a result preview", () => {
		const lines = renderToolShell(fakeHost(), 80, theme);
		expect(lines?.[0]).toBe("");
		expect(lines?.[1]).toBe(`${DOT} mcp__srv__tool`);
		expect(lines?.[2]).toBe("  ⎿  {");
		expect(lines?.[3]).toBe('       "a": 1');
		expect(lines?.[4]).toBe("     }");
	});

	test("keeps an extension's own renderer inside the frame", () => {
		const lines = renderToolShell(
			fakeHost({
				hasRendererDefinition: () => true,
				contentBox: {
					children: [
						{ render: () => ['srv/tool(path: "x")'] },
						{ render: () => ["line one", "line two"] },
					],
				},
			}),
			80,
			theme,
		);
		expect(lines?.[1]).toBe(`${DOT} srv/tool(path: "x")`);
		expect(lines?.[2]).toBe("  ⎿  line one");
		expect(lines?.[3]).toBe("     line two");
	});

	test("uses the error dot when the result is an error", () => {
		const lines = renderToolShell(
			fakeHost({ result: { content: [{ type: "text", text: "boom" }], isError: true } }),
			80,
			theme,
		);
		expect(lines?.[1]).toBe(`${DOT} mcp__srv__tool`);
		expect(lines?.[2]).toBe("  ⎿  boom");
	});

	test("renders only the header while the call is still running", () => {
		const lines = renderToolShell(fakeHost({ isPartial: true, executionStarted: false, result: undefined }), 80, theme);
		expect(lines).toEqual(["", `${DOT} mcp__srv__tool`]);
	});
});
