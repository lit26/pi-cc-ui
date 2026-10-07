/**
 * CC-style framing for tools this extension does not own.
 *
 * pi renders every tool it has no `renderShell: "self"` definition for inside
 * a padded, background-filled Box. pi-cc-ui wants CC's two-row frame instead:
 * a `● Name(args)` header with the state dot, and a `⎿` result whose
 * continuation lines share a 5-column gutter.
 *
 * Two shapes reach here:
 *   - Custom rows: the tool (an MCP tool, or any extension tool) ships its own
 *     renderCall/renderResult. We render those children, strip their colors
 *     from the call header, and hang the result off `⎿` — the extension keeps
 *     its own renderer, it just moves inside our frame (upstream README:
 *     "An extension that replaces one keeps its own renderer inside the frame").
 *   - Generic rows: no renderer at all. `● Name` plus a preview of the result,
 *     JSON pretty-printed and URLs clickable.
 *
 * The builtins (read/bash/grep/…) use `renderShell: "self"` and render their
 * own full rows, so `renderToolShell` returns undefined for them and the host
 * keeps its native path.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	hyperlink,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { previewLimit, renderTruncatedContent } from "./builtins.js";
import { EXPANDED_LINES } from "./diff.js";
import { armBlink, currentBlinkPhase } from "./grouping.js";

// CC figures.ts: BLACK_CIRCLE = env.platform === 'darwin' ? '⏺' : '●'.
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

// CC MessageResponse: `  ⎿  ` lead, continuation lines in the same 5-column
// gutter the builtins use.
const RESULT_LEAD = "  ⎿  ";
const RESULT_INDENT = " ".repeat(RESULT_LEAD.length);
const RESULT_COLUMN = RESULT_INDENT.length;
const HEADER_GUTTER = "  ";

const TOOL_TAB = "   ";
const MAX_JSON_CHARS = 10_000;
const MAX_URL_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Result text
// ---------------------------------------------------------------------------

const OSC_LINK_RE =
	/(?:\u001B\]|\u009D)8;[^;\u0007]*;(?<url>[^\u0007\u001B\u009C]*)(?:\u0007|\u001B\\|\u009C)(?<label>[\s\S]*?)(?:\u001B\]|\u009D)8;;(?:\u0007|\u001B\\|\u009C)/gu;
const STRING_CONTROL_RE = /(?:\u001B[P_X^\]]|[\u0090\u009D-\u009F])[^\n]*?(?:\u0007|\u001B\\|\u009C)/gu;
const CSI_RE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const UNSAFE_CHAR_RE =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFF9-\uFFFB]/gu;
const SANITIZE_TRIGGER_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFFF9-\uFFFB]/u;
const SGR_RE = /\u001B\[[\d;]*m/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/** Apply carriage returns like a terminal (a later segment overwrites). */
function applyCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text
		.split("\n")
		.map((line) => {
			let shown = "";
			for (const segment of line.split("\r")) shown = segment + shown.slice(segment.length);
			return shown;
		})
		.join("\n");
}

/**
 * Strip terminal control sequences from tool output, commands and paths before
 * display. Embedded OSC-8 hyperlinks keep their URL as text (upstream output.ts).
 */
export function sanitizeToolText(text: string): string {
	if (!SANITIZE_TRIGGER_RE.test(text)) return text;
	const links = text.replaceAll(OSC_LINK_RE, (...args: unknown[]) => {
		const groups = args.at(-1);
		if (!isRecord(groups)) return "";
		const url = typeof groups["url"] === "string" ? groups["url"] : "";
		const label = typeof groups["label"] === "string" ? groups["label"] : "";
		return /^(?:https?:\/\/|file:\/\/)/iu.test(url) && url !== label ? `${label} (${url})` : label;
	});
	return applyCarriageReturns(
		stripTerminalSequences(links.replaceAll(STRING_CONTROL_RE, "").replaceAll(CSI_RE, ""))
			.replaceAll(UNSAFE_CHAR_RE, "")
			.replaceAll("\r\n", "\n"),
	);
}

/** Pretty-print a compact JSON payload; anything else passes through. */
export function formatJson(text: string): string {
	if (text.length >= MAX_JSON_CHARS) return text;
	try {
		const parsed: unknown = JSON.parse(text);
		const compact = text.replaceAll(/"(?:\\.|[^"\\])*"|\s+/gu, (part) =>
			part.startsWith('"') ? part : "",
		);
		return JSON.stringify(parsed) === compact ? JSON.stringify(parsed, null, 2) : text;
	} catch {
		return text;
	}
}

/** Turn bare http(s) URLs into OSC-8 hyperlinks when the terminal supports them. */
export function formatUrls(text: string): string {
	if (text.length > MAX_URL_CHARS || !getCapabilities().hyperlinks) return text;
	return text.replaceAll(/https?:\/\/[^\s<>"'()]+/gu, (url) => {
		try {
			return hyperlink(url, new URL(url).href);
		} catch {
			return url;
		}
	});
}

function resultBlocks(result: unknown): readonly unknown[] {
	if (!isRecord(result)) return [];
	return isUnknownArray(result["content"]) ? result["content"] : [];
}

function toolResultHasImage(result: unknown): boolean {
	return resultBlocks(result).some((block) => isRecord(block) && block["type"] === "image");
}

const genericTextCache = new WeakMap<object, string>();

/**
 * Display text of a result that has no renderer: text blocks sanitized,
 * pretty-printed and linkified, unsupported blocks named, images left to the
 * caller (they render as terminal images after the row).
 */
export function genericToolContent(result: unknown): string {
	if (isRecord(result)) {
		const cached = genericTextCache.get(result);
		if (cached !== undefined) return cached;
	}
	const blocks = resultBlocks(result).flatMap((block) => {
		if (!isRecord(block)) return ["(Unsupported content block)"];
		if (block["type"] === "image") return [];
		if (block["type"] === "text" && typeof block["text"] === "string") {
			const text = sanitizeToolText(block["text"]).replaceAll("\t", TOOL_TAB);
			return [text.trim() === "" ? "(No content)" : formatUrls(formatJson(text))];
		}
		const type = typeof block["type"] === "string" ? block["type"] : "Unknown";
		return [`(${sanitizeToolText(type)} content)`];
	});
	const value = blocks.length > 0 ? blocks.join("\n\n") : toolResultHasImage(result) ? "" : "(No content)";
	if (isRecord(result)) genericTextCache.set(result, value);
	return value;
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function stripSgr(text: string): string {
	return text.replace(SGR_RE, "");
}

function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** Trim blank rows at both edges, like upstream's trimmedRows. */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length - 1;
	while (start <= end && isBlankRow(lines[start]!)) start++;
	while (end >= start && isBlankRow(lines[end]!)) end--;
	return lines.slice(start, end + 1);
}

/**
 * Wrap to `width` with a hanging indent. The first `indent` columns are a fixed
 * gutter (the `● ` lead); wrap continuations re-indent to the same column.
 */
function wrapHanging(text: string, width: number, indent: number): string[] {
	const maxWidth = Math.max(1, Math.floor(width));
	const gutterWidth = Math.min(indent, Math.max(0, maxWidth - 1));
	const continuation = " ".repeat(gutterWidth);
	const out: string[] = [];
	for (const logical of wrapTextWithAnsi(text, Number.MAX_SAFE_INTEGER)) {
		if (visibleWidth(logical) <= maxWidth) {
			out.push(logical);
			continue;
		}
		const gutter = sliceByColumn(logical, 0, gutterWidth);
		const content = sliceByColumn(logical, gutterWidth, Number.MAX_SAFE_INTEGER);
		const rows = wrapTextWithAnsi(content, maxWidth - gutterWidth);
		out.push(gutter + (rows[0] ?? ""), ...rows.slice(1).map((line) => continuation + line));
	}
	return out.map((line) =>
		visibleWidth(line) <= maxWidth ? line : truncateToWidth(line, maxWidth, ""),
	);
}

// ---------------------------------------------------------------------------
// Host shape
// ---------------------------------------------------------------------------

interface ShellResult {
	readonly content: readonly unknown[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

/** The subset of ToolExecutionComponent this module reads. All private in pi. */
export interface ToolShellHost {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly executionStarted: boolean;
	readonly hideComponent: boolean;
	readonly result: ShellResult | undefined;
	readonly imageComponents: readonly { render(width: number): string[] }[];
	readonly imageSpacers: readonly { render(width: number): string[] }[];
	readonly contentBox?: { children?: readonly { render(width: number): string[] }[] };
	hasRendererDefinition(): boolean;
	getRenderShell(): unknown;
	invalidate(): void;
}

function isShellHost(value: unknown): value is ToolShellHost {
	if (!isRecord(value)) return false;
	return (
		typeof value["toolName"] === "string" &&
		typeof value["toolCallId"] === "string" &&
		typeof value["hasRendererDefinition"] === "function" &&
		typeof value["getRenderShell"] === "function" &&
		typeof value["invalidate"] === "function" &&
		typeof value["expanded"] === "boolean" &&
		typeof value["isPartial"] === "boolean"
	);
}

/**
 * State dot, matching the builtins: error red, success green, running dim
 * (blinking once execution has started), unresolved yellow.
 */
function dotFor(host: ToolShellHost, theme: Theme): string {
	if (host.result?.isError === true) return theme.fg("error", BLACK_CIRCLE);
	if (host.result !== undefined) return theme.fg("success", BLACK_CIRCLE);
	if (host.isPartial) {
		if (host.executionStarted) {
			armBlink(host.toolCallId, host.invalidate);
			return currentBlinkPhase(host.toolCallId) ? theme.fg("dim", BLACK_CIRCLE) : " ";
		}
		return theme.fg("dim", BLACK_CIRCLE);
	}
	return theme.fg("warning", BLACK_CIRCLE);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Frame around a tool that ships its own renderer (MCP and other extensions). */
function renderCustomRow(host: ToolShellHost, width: number, theme: Theme): string[] | undefined {
	const children = Array.isArray(host.contentBox?.children) ? host.contentBox.children : undefined;
	if (children === undefined || children.length === 0) return undefined;
	const call = children[0];
	const result = children[1];

	const callLines = call
		? trimBlankEdges(call.render(Math.max(1, width - HEADER_GUTTER.length))).map(stripSgr)
		: [];
	const title = callLines[0] ?? theme.bold(sanitizeToolText(host.toolName));
	const lines = [
		...wrapHanging(`${dotFor(host, theme)} ${title}`, width, HEADER_GUTTER.length),
		...callLines.slice(1).map((line) => `${HEADER_GUTTER}${line}`),
	];

	if (result) {
		const rows = trimBlankEdges(result.render(Math.max(1, width - RESULT_COLUMN)));
		const [lead, ...body] = rows;
		if (lead !== undefined) {
			lines.push(`${theme.fg("dim", RESULT_LEAD)}${lead}`, ...body.map((line) => `${RESULT_INDENT}${line}`));
		}
	}
	return lines;
}

/** Frame for a tool with no renderer at all: name + result preview. */
function renderGenericRow(host: ToolShellHost, width: number, theme: Theme): string[] {
	const lines = wrapHanging(
		`${dotFor(host, theme)} ${theme.bold(sanitizeToolText(host.toolName))}`,
		width,
		HEADER_GUTTER.length,
	);
	if (host.result === undefined) return lines;

	const text = genericToolContent(host.result);
	const contentWidth = Math.max(10, Math.floor(width) - RESULT_COLUMN);
	const body = host.expanded
		? renderTruncatedContent(text, contentWidth, EXPANDED_LINES, theme, (line) => line, { expandHint: false })
		: renderTruncatedContent(text, contentWidth, previewLimit(), theme, (line) => theme.fg("muted", line));
	if (body === "") return lines;
	const rows = body.split("\n");
	lines.push(`${theme.fg("dim", RESULT_LEAD)}${rows[0] ?? ""}`);
	for (const line of rows.slice(1)) lines.push(`${RESULT_INDENT}${line}`);
	return lines;
}

/** Mirror the host's post-render image append (we bypass Container.render). */
function appendImages(host: ToolShellHost, lines: string[], width: number): string[] {
	const images = Array.isArray(host.imageComponents) ? host.imageComponents : [];
	const spacers = Array.isArray(host.imageSpacers) ? host.imageSpacers : [];
	for (let index = 0; index < images.length; index++) {
		const spacer = spacers[index];
		if (spacer) lines.push(...spacer.render(width));
		const image = images[index];
		if (image) lines.push(...image.render(width));
	}
	return lines;
}

/**
 * CC-frame any tool the host would otherwise draw in its padded Box. Returns
 * undefined for the extension's own `renderShell: "self"` builtins (and for any
 * shape we do not recognize), leaving those on the native path.
 */
export function renderToolShell(host: object, width: number, theme: Theme): string[] | undefined {
	if (width <= 0) return [];
	if (!isShellHost(host)) return undefined;
	if (host.hideComponent) return [];
	if (host.getRenderShell() === "self") return undefined;
	try {
		const body = host.hasRendererDefinition()
			? (renderCustomRow(host, width, theme) ?? renderGenericRow(host, width, theme))
			: renderGenericRow(host, width, theme);
		// CC separates every tool row from the previous block with one blank row;
		// the host emits it via a Spacer child we bypass by rendering ourselves.
		return appendImages(host, ["", ...body], width);
	} catch {
		return undefined;
	}
}
