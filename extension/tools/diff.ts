/**
 * CC diff display — ported from pi-cc-ui 0.5.0 (extension/tools/diff-model.ts,
 * diff-palette.ts, diff-render.ts), adapted to this fork's resolved-palette
 * layer instead of a live pi Theme.
 *
 * What changed vs. the previous local renderer: the dashed frame, the `▌`
 * gutter border, the side-by-side split layout and shiki syntax highlighting
 * are gone. Rows are now upstream's plain `number + sign + content` with a
 * full-width changed-line background and word-level highlighting where a line
 * only partly changed. Parse guards (2 MB char cap, 5 s timeout, edit-distance
 * limit) and their "Diff unavailable" notices are now rendered too.
 */
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { diffWordsWithSpace, structuredPatch } from "diff";
import {
	bgAnsi,
	bold,
	fgAnsi,
	RESET,
	rgbToHex,
	resolvePalette,
	semanticFlag,
	semanticOverride,
	type ColorValue,
	type ResolvedPalette,
	type SemanticColor,
} from "../palette.js";

export const MAX_PREVIEW_LINES = 60;
/** Upstream EXPANDED_LINES — ctrl+o budget. */
export const EXPANDED_LINES = 2000;
const CONTEXT_LINES = 3;
const MAX_DIFF_CHARS = 2_000_000;
const MAX_LINE_CHARS = 2000;
const TAB_STOP = 8;
const MIN_NUMBERED_WIDTH = 3;
const CHANGE_RATIO = 0.4;
const DISPLAY_LIMIT_NOTE = " (display limit)";
const HUNK_HEADER_RE = /^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@/u;
const CSI_SPLIT_RE = new RegExp(`(\x1b\\[[0-?]*[ -/]*[@-~])`, "u");

const ESC = "\x1b";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

export type DiffLineType = "add" | "del" | "ctx" | "sep" | "meta";

export interface DiffLine {
	readonly type: DiffLineType;
	readonly oldNumber: number | undefined;
	readonly newNumber: number | undefined;
	readonly content: string;
}

export interface DiffEdit {
	readonly oldText: string;
	readonly newText: string;
}

export interface ParsedDiff {
	readonly lines: readonly DiffLine[];
	readonly added: number;
	readonly removed: number;
	readonly chars: number;
	readonly notice?: string;
}

interface PatchHunk {
	readonly oldStart: number;
	readonly newStart: number;
	readonly lines: readonly string[];
}

export interface DiffRenderOptions {
	readonly maxLines: number;
	readonly expandHint: boolean;
}

export interface ListingRenderOptions {
	readonly hiddenLines: number;
	readonly expandHint: boolean;
	readonly maxRows: number;
}

export function maxLineNumber(lines: readonly DiffLine[]): number {
	return lines.reduce(
		(max, line) =>
			line.type === "sep" || line.type === "meta"
				? max
				: Math.max(max, line.oldNumber ?? 0, line.newNumber ?? 0),
		0,
	);
}

function unavailable(chars: number, notice: string): ParsedDiff {
	return { lines: [], added: 0, removed: 0, chars, notice };
}

function separator(content = ""): DiffLine {
	return { type: "sep", oldNumber: undefined, newNumber: undefined, content };
}

/**
 * Drop unchanged context more than CONTEXT_LINES away from a change and
 * collapse every gap into one separator row.
 */
function normalizeContext(lines: readonly DiffLine[]): DiffLine[] {
	const keep = new Set<number>();
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.type !== "ctx" && lines[index]?.type !== "sep") {
			for (
				let around = Math.max(0, index - CONTEXT_LINES);
				around <= Math.min(lines.length - 1, index + CONTEXT_LINES);
				around += 1
			) {
				keep.add(around);
			}
		}
	}
	const out: DiffLine[] = [];
	let gap = false;
	for (const [index, line] of lines.entries()) {
		if (line.type === "sep" || !keep.has(index)) {
			gap = out.length > 0;
		} else {
			if (gap) {
				out.push(separator());
				gap = false;
			}
			out.push(line);
		}
	}
	return out;
}

function collectDiffLines(hunks: readonly PatchHunk[]): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let chars = 0;
	for (const hunk of hunks) {
		if (lines.length > 0) {
			lines.push(separator());
		}
		let oldNumber = hunk.oldStart;
		let newNumber = hunk.newStart;
		for (const line of hunk.lines) {
			const content = line.slice(1);
			chars += content.length;
			if (line.startsWith("\\")) {
				lines.push({ type: "meta", oldNumber: undefined, newNumber: undefined, content: line });
			} else if (line.startsWith("+")) {
				lines.push({ type: "add", oldNumber: undefined, newNumber, content });
				newNumber += 1;
				added += 1;
			} else if (line.startsWith("-")) {
				lines.push({ type: "del", oldNumber, newNumber: undefined, content });
				oldNumber += 1;
				removed += 1;
			} else if (line.startsWith(" ")) {
				lines.push({ type: "ctx", oldNumber, newNumber, content });
				oldNumber += 1;
				newNumber += 1;
			}
		}
	}
	return { lines: normalizeContext(lines), added, removed, chars };
}

/**
 * Diff two file contents. Guarded like upstream: above 2 MB of combined input
 * the render is refused, and structuredPatch itself gets a 5 s / 20 000-edit
 * budget so a pathological pair cannot hang the TUI.
 */
export function parseDiff(oldContent: string, newContent: string): ParsedDiff {
	const chars = oldContent.length + newContent.length;
	if (chars > MAX_DIFF_CHARS) {
		return unavailable(chars, "Diff unavailable: display computation size limit reached");
	}
	const patch = structuredPatch("", "", oldContent, newContent, "", "", {
		context: CONTEXT_LINES,
		timeout: 5000,
		maxEditLength: 20_000,
	});
	return patch === undefined
		? unavailable(chars, "Diff unavailable: 5s computation or edit-distance limit reached")
		: { ...collectDiffLines(patch.hunks), chars };
}

/** Parse pi's persisted unified patch (result.details.patch) into a diff. */
export function parseUnifiedPatch(patch: string): ParsedDiff | undefined {
	if (patch.length > MAX_DIFF_CHARS) {
		return unavailable(patch.length, "Diff unavailable: persisted patch exceeds display size limit");
	}
	const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
	for (const line of patch.split("\n")) {
		const header = HUNK_HEADER_RE.exec(line)?.groups;
		if (header === undefined) {
			hunks.at(-1)?.lines.push(line);
		} else {
			hunks.push({
				oldStart: Number(header["oldStart"]),
				newStart: Number(header["newStart"]),
				lines: [],
			});
		}
	}
	const parsed = collectDiffLines(hunks);
	return parsed.lines.length > 0 ? parsed : undefined;
}

/**
 * Fallback when pi's patch is unavailable (history predating details): diff
 * each edit's own old/new text and label the blocks, since no file coordinates
 * exist to place them at.
 */
export function snippetDiff(edits: readonly DiffEdit[]): ParsedDiff {
	const parts = edits.map((edit) => parseDiff(edit.oldText, edit.newText));
	return {
		lines: parts.flatMap((part, index) => [
			separator(`Edit ${index + 1} (file coordinates unavailable)`),
			...part.lines.map((line) => ({ ...line, oldNumber: undefined, newNumber: undefined })),
		]),
		added: parts.reduce((count, part) => count + part.added, 0),
		removed: parts.reduce((count, part) => count + part.removed, 0),
		chars: parts.reduce((count, part) => count + part.chars, 0),
		notice:
			parts.find((part) => part.notice !== undefined)?.notice ??
			"Per-edit snippets; file coordinates unavailable",
	};
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

interface DiffSgr {
	readonly addedBg: string;
	readonly removedBg: string;
	readonly addedWordBg: string;
	readonly removedWordBg: string;
	readonly lineNumberFg: string;
	readonly contextFg: string;
	readonly addedFg: string;
	readonly removedFg: string;
	readonly mutedFg: string;
	readonly warningFg: string;
}

const ANSI_WHITE = 15;
const ANSI_BLACK = 0;

/** Daltonized line washes, as upstream's DIMMED table. */
const DIMMED_LINES: Readonly<Record<string, readonly [ColorValue, ColorValue]>> = {
	dark: ["#47584A", "#69484D"],
	light: ["#C7E1CB", "#FDD2D8"],
	"dark-daltonized": ["#3E515B", "#3E2C2C"],
	"light-daltonized": ["#D1E7FD", "#FFE9E9"],
};

/**
 * A semantic override, preferring the `Dim`-suffixed key while diffDimmed is on
 * (upstream: `semanticOverride(dimmed ? `${role}Dim` : role) ?? semanticOverride(role)`).
 */
function overrideColor(dimmed: boolean, role: string): SemanticColor | undefined {
	if (dimmed) {
		const dim = semanticOverride(`${role}Dim`);
		if (dim !== undefined) return dim;
	}
	return semanticOverride(role);
}

function variantName(p: ResolvedPalette): string {
	return p.variant;
}

function diffSgr(p: ResolvedPalette): DiffSgr {
	const dimmed = semanticFlag("diffDimmed");
	const dimLines = dimmed ? DIMMED_LINES[variantName(p)] : undefined;
	const light = p.scheme === "light";
	// Word fills are the vivid color; line fills the muted wash. For a CC theme
	// both come from the table; for a foreign theme resolvePalette already
	// derived them from that theme's toolDiffAdded / toolDiffRemoved tokens.
	const addedLine = overrideColor(dimmed, "diffAddedLine") ?? dimLines?.[0] ?? p.cc.diffAddedBg;
	const removedLine = overrideColor(dimmed, "diffRemovedLine") ?? dimLines?.[1] ?? p.cc.diffRemovedBg;
	const addedWord = overrideColor(dimmed, "diffAddedWord") ?? p.cc.diffAddedWord;
	const removedWord = overrideColor(dimmed, "diffRemovedWord") ?? p.cc.diffRemovedWord;
	const lineNumber = overrideColor(dimmed, "diffLineNumber");
	const decoration = light ? ANSI_BLACK : ANSI_WHITE;
	return {
		addedBg: bgAnsi(addedLine),
		removedBg: bgAnsi(removedLine),
		addedWordBg: bgAnsi(addedWord),
		removedWordBg: bgAnsi(removedWord),
		lineNumberFg: lineNumber === undefined ? fgAnsi(rgbToHex(p.chrome.diffLineNumber)) : fgAnsi(lineNumber),
		contextFg: fgAnsi(p.cc.inactive),
		addedFg: fgAnsi(overrideColor(dimmed, "diffAddedDecoration") ?? decoration),
		removedFg: fgAnsi(overrideColor(dimmed, "diffRemovedDecoration") ?? decoration),
		mutedFg: fgAnsi(p.cc.inactive),
		warningFg: fgAnsi(p.cc.warning),
	};
}

/** The palette the render layer is currently painting with. */
let activeSgrPalette: ResolvedPalette = resolvePalette("claude-code-dark", () => undefined);

export function setDiffPalette(p: ResolvedPalette): void {
	activeSgrPalette = p;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface SgrState {
	fg: string;
	bg: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
}

interface WordBodies {
	readonly old: string;
	readonly new: string;
}

function graphemes(text: string): Intl.Segments {
	return graphemeSegmenter.segment(text);
}
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function pluralize(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function graphemePrefix(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let end = 0;
	for (const part of graphemes(text)) {
		const next = part.index + part.segment.length;
		if (next > maxChars) break;
		end = next;
	}
	return text.slice(0, end);
}

function expandHintSuffix(): string {
	return " (ctrl+o to expand)";
}

function truncationFooter(sgr: DiffSgr, detail: string, expandHint: boolean, limitNote: string): string {
	return `${sgr.mutedFg}… ${detail}${expandHint ? expandHintSuffix() : limitNote}${RESET}`;
}

function boundedLine(text: string): { text: string; omitted: number } {
	const head = graphemePrefix(text, MAX_LINE_CHARS);
	return { text: head, omitted: text.length - head.length };
}

function omittedSuffix(omitted: number): string {
	return ` … [+${omitted} chars]`;
}

function fitRows(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => (visibleWidth(line) <= width ? [line] : wrapCode(line, width)));
}

function displayText(text: string): string {
	return stripTerminalSequences(text.replaceAll("\r", "␍"));
}

function applySgr(state: SgrState, sequence: string): void {
	const params = sequence.slice(2, -1);
	if (params === "" || params === "0") {
		state.fg = "";
		state.bg = "";
		state.bold = false;
		state.dim = false;
		state.italic = false;
	} else if (params === "39") {
		state.fg = "";
	} else if (params === "49") {
		state.bg = "";
	} else if (params === "1") {
		state.bold = true;
	} else if (params === "2") {
		state.dim = true;
	} else if (params === "22") {
		state.bold = false;
		state.dim = false;
	} else if (params === "3") {
		state.italic = true;
	} else if (params === "23") {
		state.italic = false;
	} else if (params.startsWith("38;") || /^3[0-9]$/u.test(params)) {
		state.fg = sequence;
	} else if (params.startsWith("48;") || /^4[0-9]$/u.test(params)) {
		state.bg = sequence;
	}
}

function sgrPrefix(state: SgrState): string {
	return (
		state.bg +
		state.fg +
		(state.bold ? BOLD : "") +
		(state.dim ? DIM : "") +
		(state.italic ? ITALIC : "")
	);
}

function expandTabs(text: string): string {
	if (!text.includes("\t")) {
		return text;
	}
	let column = 0;
	return text
		.split(CSI_SPLIT_RE)
		.map((part) => {
			if (part.startsWith(ESC)) {
				return part;
			}
			let out = "";
			for (const entry of graphemes(part)) {
				if (entry.segment === "\t") {
					const spaces = TAB_STOP - (column % TAB_STOP);
					out += " ".repeat(spaces);
					column += spaces;
				} else {
					out += entry.segment;
					column += visibleWidth(entry.segment);
				}
			}
			return out;
		})
		.join("");
}

function wrapCode(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const state: SgrState = { fg: "", bg: "", bold: false, dim: false, italic: false };
	const rows: string[] = [];
	let row = "";
	let visible = 0;
	for (const part of expandTabs(text).split(CSI_SPLIT_RE)) {
		if (part.startsWith(ESC)) {
			row += part;
			if (part.endsWith("m")) {
				applySgr(state, part);
			}
			continue;
		}
		for (const { segment } of graphemes(part)) {
			const segmentWidth = visibleWidth(segment);
			const cell = segmentWidth > safeWidth ? "\ufffd" : segment;
			const cellWidth = cell === segment ? segmentWidth : visibleWidth(cell);
			if (cellWidth > 0 && visible + cellWidth > safeWidth) {
				rows.push(row);
				row = sgrPrefix(state);
				visible = 0;
			}
			row += cell;
			visible += cellWidth;
		}
	}
	if (rows.length === 0 || visible > 0) {
		rows.push(row);
	}
	return rows;
}

function wordBodies(sgr: DiffSgr, oldText: string, newText: string): WordBodies | undefined {
	const parts = diffWordsWithSpace(oldText, newText, { timeout: 30, maxEditLength: 2000 });
	if (parts === undefined) {
		return undefined;
	}
	let changed = 0;
	let oldOut = "";
	let newOut = "";
	for (const part of parts) {
		const safe = displayText(part.value);
		if (part.removed) {
			changed += part.value.length;
			oldOut += `${sgr.removedWordBg}${safe}${sgr.removedBg}`;
		} else if (part.added) {
			changed += part.value.length;
			newOut += `${sgr.addedWordBg}${safe}${sgr.addedBg}`;
		} else {
			oldOut += safe;
			newOut += safe;
		}
	}
	return changed / Math.max(1, oldText.length + newText.length) > CHANGE_RATIO
		? undefined
		: { old: oldOut, new: newOut };
}

function pairRun(
	diff: ParsedDiff,
	start: number,
	sgr: DiffSgr,
	limit: number,
): Map<number, string> {
	const paired = new Map<number, string>();
	let end = start;
	while (diff.lines[end]?.type === "del") {
		end += 1;
	}
	for (let offset = 0; offset < Math.min(end - start, limit); offset += 1) {
		const oldLine = diff.lines[start + offset];
		const newLine = diff.lines[end + offset];
		if (oldLine === undefined || newLine?.type !== "add") {
			continue;
		}
		const words = wordBodies(
			sgr,
			boundedLine(oldLine.content).text,
			boundedLine(newLine.content).text,
		);
		if (words !== undefined) {
			paired.set(start + offset, words.old);
			paired.set(end + offset, words.new);
		}
	}
	return paired;
}

/** CC FileEditToolUpdatedMessage: "Added N lines, removed M lines". */
export function renderDiffStatLine(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0) {
		parts.push(`Added ${bold(String(added))} ${pluralize(added, "line")}`);
	}
	if (removed > 0) {
		parts.push(
			`${added > 0 ? ", r" : "R"}emoved ${bold(String(removed))} ${pluralize(removed, "line")}`,
		);
	}
	return parts.join("");
}

/**
 * Upstream renderDiffBody — one column, `number + sign` gutter, full-width
 * changed-line backgrounds, word fills on partially changed pairs.
 */
export function renderDiffBody(
	p: ResolvedPalette,
	diff: ParsedDiff,
	width: number,
	options: DiffRenderOptions,
): string[] {
	if (width <= 0) {
		return [];
	}
	const out: string[] = [];
	const sgr = diffSgr(p);
	const numberWidth = Math.min(
		Math.max(1, String(maxLineNumber(diff.lines)).length),
		Math.max(0, width - MIN_NUMBERED_WIDTH),
	);
	const gutterWidth = Math.min(numberWidth + 2, Math.max(0, width - 1));
	const codeWidth = Math.max(1, width - gutterWidth);
	const budget = Math.max(1, options.maxLines);
	let consumed = 0;
	let clippedRecord = false;
	let paired = new Map<number, string>();
	for (let index = 0; index < diff.lines.length && out.length < budget; index += 1) {
		const line = diff.lines[index];
		if (line === undefined) {
			break;
		}
		if (line.type === "sep" || line.type === "meta") {
			const rows = wrapCode(`${sgr.mutedFg}${line.content || "..."}${RESET}`, width);
			out.push(...rows.slice(0, budget - out.length));
			consumed = index + 1;
			continue;
		}
		if (line.type === "del" && diff.lines[index - 1]?.type !== "del") {
			paired = pairRun(diff, index, sgr, budget);
		}
		const bounded = boundedLine(line.content);
		const suffix = bounded.omitted > 0 ? omittedSuffix(bounded.omitted) : "";
		const body = (paired.get(index) ?? displayText(bounded.text)) + suffix;
		const deletion = line.type === "del";
		const changed = deletion || line.type === "add";
		let sign = " ";
		let bg = "";
		let fg = sgr.contextFg;
		if (deletion) {
			sign = "-";
			bg = sgr.removedBg;
			fg = sgr.removedFg;
		} else if (changed) {
			sign = "+";
			bg = sgr.addedBg;
			fg = sgr.addedFg;
		}
		const number = deletion ? line.oldNumber : line.newNumber;
		const digits =
			number === undefined ? " ".repeat(numberWidth) : String(number).padStart(numberWidth);
		const first =
			gutterWidth >= 2 ? `${digits} ${sign}`.slice(-gutterWidth) : sign.slice(0, gutterWidth);
		const continuation = gutterWidth >= 1 ? `${" ".repeat(gutterWidth - 1)}${sign}` : "";
		const rows = wrapCode(bg + fg + body, codeWidth);
		const available = budget - out.length;
		rows.slice(0, available).forEach((row, rowIndex) => {
			const gutter = rowIndex === 0 ? first : continuation;
			out.push(
				`${bg}${changed ? fg : sgr.lineNumberFg}${gutter}${RESET}${bg}${fg}${row}${bg}${" ".repeat(Math.max(0, codeWidth - visibleWidth(row)))}${RESET}`,
			);
		});
		clippedRecord = rows.length > available;
		consumed = index + 1;
	}
	const remaining = diff.lines.length - consumed;
	if (remaining > 0 || clippedRecord) {
		const detail = `${clippedRecord ? "Current diff line continues; " : ""}${remaining} more diff ${pluralize(remaining, "record")}`;
		out.push(truncationFooter(sgr, detail, options.expandHint, DISPLAY_LIMIT_NOTE));
	}
	if (diff.notice !== undefined) {
		out.push(`${sgr.warningFg}${diff.notice}${RESET}`);
	}
	return fitRows(out, width);
}

/** Numbered source listing (new files) — upstream renderNumberedListing. */
export function renderNumberedListing(
	p: ResolvedPalette,
	lines: readonly string[],
	width: number,
	options: ListingRenderOptions,
): string[] {
	if (width <= 0) {
		return [];
	}
	const out: string[] = [];
	const sgr = diffSgr(p);
	const numberWidth = Math.min(String(lines.length).length, Math.max(0, width - 2));
	const gutterWidth = Math.min(numberWidth + 1, Math.max(0, width - 1));
	const budget = options.maxRows;
	let consumed = 0;
	let clipped = false;
	for (const [index, text] of lines.entries()) {
		if (out.length >= budget) {
			break;
		}
		const bounded =
			text.length > MAX_LINE_CHARS ? boundedLine(stripTerminalSequences(text)) : undefined;
		const safe =
			bounded !== undefined && bounded.omitted > 0
				? displayText(bounded.text) + omittedSuffix(bounded.omitted)
				: text;
		const rows = wrapCode(safe, Math.max(1, width - gutterWidth));
		const remaining = budget - out.length;
		rows.slice(0, remaining).forEach((row, rowIndex) => {
			const number =
				rowIndex === 0 ? `${String(index + 1).padStart(numberWidth)} ` : " ".repeat(gutterWidth);
			out.push(`${sgr.mutedFg}${number.slice(0, gutterWidth)}${RESET}${row}`);
		});
		clipped = rows.length > remaining;
		consumed += 1;
	}
	const hidden = lines.length - consumed + options.hiddenLines;
	if (hidden > 0 || clipped) {
		const detail = `${clipped ? "current line continues; " : ""}${hidden} more source ${pluralize(hidden, "line")}`;
		out.push(truncationFooter(sgr, detail, options.expandHint, DISPLAY_LIMIT_NOTE));
	}
	return fitRows(out, width);
}

/**
 * A pi-tui Component that renders a diff card at the viewport width pi passes
 * to Component.render() — the width the renderCall/renderResult context does
 * not carry. The build closure runs once per distinct width and the result is
 * cached, so terminal resize re-renders the card at the new width for free;
 * invalidate() (called by pi on theme change) drops the cache.
 */
export class DiffCardComponent implements Component {
	/** Stable key the caller uses to decide whether to reuse the card. */
	diffKey: string | undefined;
	private readonly cache = new Map<number, string[]>();
	/** Palette the cached rows were built with — a theme switch must not reuse them. */
	private cachePalette: ResolvedPalette | undefined;
	constructor(private buildFn: (width: number, palette: ResolvedPalette) => string[]) {}
	/** Replace the render closure (args/header changed) and drop cached lines. */
	setBuild(build: (width: number, palette: ResolvedPalette) => string[]): void {
		this.buildFn = build;
		this.cache.clear();
	}
	render(width: number): string[] {
		const w = Math.max(0, Math.floor(width));
		// A theme switch swaps the active palette without necessarily re-running
		// renderResult (which would setBuild a fresh closure) — key the cache on
		// the palette identity and hand the live palette to the build closure.
		if (this.cachePalette !== activeSgrPalette) {
			this.cache.clear();
			this.cachePalette = activeSgrPalette;
		}
		const hit = this.cache.get(w);
		if (hit !== undefined) return hit;
		const lines = this.buildFn(w, activeSgrPalette);
		this.cache.set(w, lines);
		// Width is part of the key, so a resize while the card is visible
		// accumulates one render copy per distinct width; cap the variants.
		if (this.cache.size > 6) this.cache.clear();
		return lines;
	}
	invalidate(): void {
		this.cache.clear();
	}
}
