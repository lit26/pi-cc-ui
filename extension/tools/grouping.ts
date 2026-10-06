/**
 * Grouped consecutive tool calls.
 *
 * Port of the grouping layer from npm `pi-claude-code-ui`
 * (github.com/FammasMaz/pi-cc-tools, extensions/index.ts) onto this fork.
 * Mechanism is display-level, not event-driven:
 *
 *   - `Container.prototype.addChild` is patched. When a ToolExecutionComponent
 *     lands next to another groupable tool component (skipping spacers and
 *     empty assistant messages), both are reparented into one
 *     ToolGroupComponent.
 *   - The group renders ONE row when every member is the same tool hitting the
 *     same target (`Read(src/foo.ts) ×3`), otherwise a header row
 *     (`Read: 2 done • 1 failed`) plus `├`/`└` branch rows.
 *   - Ctrl+O, or a click on a group row, expands every member in place.
 *
 * `edit` / `write` / `apply_patch` stay ungrouped (NON_GROUPABLE), as upstream.
 *
 * Also owns the shared pending-dot blink timer (`armBlink` /
 * `currentBlinkPhase`) that builtins.ts uses for standalone rows.
 */
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";

export type ToolStatus = "pending" | "success" | "error";

type AnyTool = InstanceType<typeof ToolExecutionComponent>;
type UiLike = { requestRender?: () => void };

/**
 * Pi declares every ToolExecutionComponent field private in its .d.ts even
 * though they are plain instance properties at runtime (tool-execution.js).
 * The grouping layer is a host-level patch, so it reads them through this
 * structural view rather than fighting the visibility modifiers.
 */
interface ToolInternals {
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	cwd?: string;
	result?: { isError?: boolean };
	isPartial?: boolean;
	executionStarted?: boolean;
	expanded?: boolean;
	ui?: UiLike;
	setExpanded?(expanded: boolean): void;
	render(width: number): string[];
}

function internals(tool: AnyTool): ToolInternals {
	return tool as unknown as ToolInternals;
}

// ---------------------------------------------------------------------------
// Active theme (the group redraws outside any tool renderer, so it cannot take
// a Theme argument; builtins hands it over on every render)
// ---------------------------------------------------------------------------

let activeTheme: Theme | undefined;

/** builtins calls this from each tool render with the live theme. */
export function setGroupTheme(theme: Theme | undefined): void {
	if (theme) activeTheme = theme;
}

// ---------------------------------------------------------------------------
// Shared pending-dot blink
// ---------------------------------------------------------------------------

/** CC useBlink.ts:3 — one fixed 600ms rhythm for every pending dot. */
const BLINK_INTERVAL_MS = 600;
/** Entries not re-armed within this window belong to settled rows — drop them. */
const BLINK_STALE_MS = 5_000;

let blinkPhase = true;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
const blinkers = new Map<string, { invalidate: () => void; at: number }>();

function ensureBlink(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(blinkTick, BLINK_INTERVAL_MS);
	blinkTimer.unref?.();
}

function stopBlink(): void {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = null;
	}
}

function blinkTick(): void {
	const now = Date.now();
	blinkPhase = !blinkPhase;
	for (const [key, entry] of [...blinkers]) {
		if (now - entry.at > BLINK_STALE_MS) {
			blinkers.delete(key);
			continue;
		}
		try {
			entry.invalidate();
		} catch {
			/* noop */
		}
	}
	if (blinkers.size === 0) stopBlink();
}

/** Ensure the blink timer runs while a pending row is on screen, and register
 *  that row's invalidate so the shared tick actually redraws its dot. */
export function armBlink(key: string, invalidate: () => void): void {
	blinkers.set(key, { invalidate, at: Date.now() });
	ensureBlink();
}

/** The current blink phase for a pending status dot. */
export function currentBlinkPhase(_key?: string): boolean {
	return blinkPhase;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_CACHE_TTL_MS = 2_000;
let settingsCache: { value: boolean; timestamp: number } | null = null;

function readGroupToolCalls(): boolean {
	// Default ON; only an explicit `false` disables grouping.
	let enabled = true;
	const paths = [`${process.cwd()}/.pi/settings.json`, `${homedir()}/.pi/settings.json`];
	for (const path of paths) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (typeof raw.groupToolCalls === "boolean") enabled = raw.groupToolCalls;
		} catch {
			/* keep previous value on parse error */
		}
	}
	return enabled;
}

/** Whether grouped tool rows are enabled (reads settings.json, 2s cache). */
export function isGroupingEnabled(): boolean {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) return settingsCache.value;
	const value = readGroupToolCalls();
	settingsCache = { value, timestamp: now };
	return value;
}

/** Drop the settings cache so a `/cc-tools group` toggle applies immediately. */
export function bustGroupingSettingsCache(): void {
	settingsCache = null;
}

// ---------------------------------------------------------------------------
// Text + status helpers
// ---------------------------------------------------------------------------

// CSI + OSC (BEL or ST terminated) + charset selects.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;
// A single-cell status marker at the start of a row (incl. CC's ⏺ on darwin).
const LEADING_STATUS_RE = /^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[●○✗■⬤•·⏺]| )(?:\x1b\[[0-9;]*m)*\s+/;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function trimAnsiLeft(text: string): string {
	let current = text;
	for (;;) {
		const next = current.replace(/^((?:\x1b\[[0-9;]*m)*)[ \t]+/, "$1");
		if (next === current) return current;
		current = next;
	}
}

function isBlankLine(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

function isChromeOnlyLine(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.length === 0 || /^[─━╭╮╰╯┌┐└┘│├┤┬┴┼\s]+$/.test(plain);
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length - 1;
	while (start <= end && isBlankLine(lines[start]!)) start++;
	while (end >= start && isBlankLine(lines[end]!)) end--;
	return lines.slice(start, end + 1);
}

/** A tool's own rendered rows minus the blank pad and pure border chrome
 *  (renderShell "self" emits one blank row before the content). */
function stripToolChrome(lines: string[]): string[] {
	return trimBlankEdges(lines).filter((line) => !isChromeOnlyLine(line));
}

function removeLeadingStatus(line: string): string {
	return trimAnsiLeft(line.replace(LEADING_STATUS_RE, "$1"));
}

function clampLine(line: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "", false) : line;
}

function toolName(tool: unknown): string {
	const name = (tool as { toolName?: unknown } | undefined)?.toolName;
	return typeof name === "string" && name ? name : "tool";
}
function humanizeToolName(name: string): string {
	if (name === "mcp" || name.startsWith("mcp__")) return "MCP";
	const spaced = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortPath(cwd: string, filePath: unknown): string {
	if (typeof filePath !== "string" || !filePath) return "";
	const rel = relative(cwd, filePath);
	if (!rel.startsWith("..") && !rel.startsWith("/")) return rel || ".";
	const home = homedir();
	return home && filePath.startsWith(home) ? filePath.replace(home, "~") : filePath;
}

function summarizeText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function toolStatus(tool: AnyTool): ToolStatus {
	const view = internals(tool);
	if (view.result?.isError) return "error";
	if (view.result && view.isPartial !== true) return "success";
	return view.isPartial === true && view.executionStarted === true ? "pending" : "success";
}

function countStatuses(tools: AnyTool[]): Record<ToolStatus, number> {
	const counts: Record<ToolStatus, number> = { pending: 0, success: 0, error: 0 };
	for (const tool of tools) counts[toolStatus(tool)]++;
	return counts;
}

function overallStatus(tools: AnyTool[]): ToolStatus {
	const counts = countStatuses(tools);
	if (counts.error > 0) return "error";
	if (counts.pending > 0) return "pending";
	return "success";
}

function countsText(tools: AnyTool[], theme: Theme): string {
	const counts = countStatuses(tools);
	const parts: string[] = [];
	if (counts.pending) parts.push(theme.fg("muted", `${counts.pending} running`));
	if (counts.success) parts.push(theme.fg("success", `${counts.success} done`));
	if (counts.error) parts.push(theme.fg("error", `${counts.error} failed`));
	return parts.join(theme.fg("muted", " • "));
}

/** The group light: a filled dot, blinking while any member is pending. */
function groupLight(status: ToolStatus, theme: Theme): string {
	if (status === "error") return theme.fg("error", "●");
	if (status === "pending") return blinkPhase ? theme.fg("dim", "●") : " ";
	return theme.fg("success", "●");
}

/** The argument subject that decides "same target" (upstream getToolArgSummary). */
function toolSubject(tool: AnyTool): string {
	const view = internals(tool);
	const args = ((view.args ?? {}) as Record<string, unknown>) ?? {};
	const cwd = view.cwd ?? process.cwd();
	switch (toolName(tool)) {
		case "read": {
			let value = shortPath(cwd, args.path ?? args.file_path);
			const parts: string[] = [];
			if (args.offset) parts.push(`offset=${String(args.offset)}`);
			if (args.limit) parts.push(`limit=${String(args.limit)}`);
			if (parts.length > 0) value += ` (${parts.join(", ")})`;
			return value;
		}
		case "bash":
			return summarizeText(args.command, 72);
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? `"${summarizeText(args.pattern, 40)}"` : "";
			const path = shortPath(cwd, args.path);
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "ls":
			return shortPath(cwd, args.path ?? ".");
		default: {
			for (const key of ["path", "file_path", "url", "query", "name", "subject", "tool", "description", "prompt"]) {
				const value = args[key];
				if (typeof value === "string" && value) return summarizeText(value, 72);
			}
			return "";
		}
	}
}

/** Non-empty only when every member has the same name AND the same subject. */
function repeatedSubject(tools: AnyTool[], name: string | undefined): string {
	if (!name || tools.length === 0) return "";
	const subjects = tools.map(toolSubject);
	return subjects[0] && subjects.every((subject) => subject === subjects[0]) ? subjects[0]! : "";
}

// ---------------------------------------------------------------------------
// Group row rendering
// ---------------------------------------------------------------------------

interface GroupEntry {
	tools: AnyTool[];
	name: string;
	subject: string;
}

/** Merge consecutive members that name the same target into one row. */
function collapseEntries(tools: AnyTool[]): GroupEntry[] {
	const entries: GroupEntry[] = [];
	for (const tool of tools) {
		const name = toolName(tool);
		const subject = toolSubject(tool);
		const previous = entries[entries.length - 1];
		if (subject && previous?.name === name && previous.subject === subject) {
			previous.tools.push(tool);
		} else {
			entries.push({ tools: [tool], name, subject });
		}
	}
	return entries;
}

/** First rendered row of a tool with the status marker removed, so the group
 *  can prefix its own light. */
function compactToolLine(tool: AnyTool, width: number): string {
	const first = stripToolChrome(tool.render(width))[0];
	if (!first) return clampLine(toolName(tool), width);
	return clampLine(removeLeadingStatus(first), width);
}

function entryLine(entry: GroupEntry, width: number): string {
	if (entry.tools.length === 1) return compactToolLine(entry.tools[0]!, width);
	const suffix = ` ×${entry.tools.length}`;
	const body = compactToolLine(entry.tools[0]!, Math.max(1, width - visibleWidth(suffix)));
	return clampLine(`${body}${suffix}`, width);
}

/** Full expanded rows for one member, status marker stripped from the first. */
function expandedToolLines(tool: AnyTool, width: number): string[] {
	const lines = stripToolChrome(tool.render(width));
	if (lines.length === 0) return [clampLine(toolName(tool), width)];
	return lines.map((line, index) => clampLine(index === 0 ? removeLeadingStatus(line) : line, width));
}

function branchLine(lines: string[], index: number, total: number, width: number, light: string, theme: Theme): string[] {
	const content = lines.length > 0 ? lines : [""];
	return content.map((line, lineIndex) => {
		const prefix = lineIndex === 0
			? ` ${theme.fg("dim", index === total - 1 ? "└" : "├")} ${light} `
			: index === total - 1
				? "   "
				: ` ${theme.fg("dim", "│")}   `;
		return clampLine(`${prefix}${line}`, width);
	});
}

function groupTheme(): Theme {
	return activeTheme ?? ({ fg: (_key: string, text: string) => text, bold: (text: string) => text } as unknown as Theme);
}

class ToolGroupComponent extends Container {
	private tools: AnyTool[] = [];
	expanded = false;
	private lastHeight = 0;

	addTool(tool: AnyTool): void {
		this.tools.push(tool);
	}

	releaseTools(): AnyTool[] {
		const tools = this.tools;
		this.tools = [];
		return tools;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded && this.tools.every((tool) => internals(tool).expanded === expanded)) return;
		this.expanded = expanded;
		for (const tool of this.tools) internals(tool).setExpanded?.(expanded);
	}

	invalidate(): void {
		// Deliberately not cascading: children keep their own render caches and
		// recompute only when their content actually changes.
	}

	requestRender(): void {
		for (const tool of this.tools) {
			const ui = internals(tool).ui;
			if (ui?.requestRender) {
				ui.requestRender();
				return;
			}
		}
	}

	handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y < 0 || event.y >= this.lastHeight) return undefined;
		const expanded = !this.tools.every((tool) => internals(tool).expanded === true);
		this.expanded = expanded;
		for (const tool of this.tools) internals(tool).setExpanded?.(expanded);
		this.requestRender();
		return {
			handled: true,
			target: { component: this, originX: 0, originY: 0, width: event.width, height: this.lastHeight },
		};
	}

	render(width: number): string[] {
		if (this.tools.length === 0) {
			this.lastHeight = 0;
			return [];
		}
		const theme = groupTheme();
		const safeWidth = Math.max(1, Math.floor(width));
		const status = overallStatus(this.tools);
		const light = groupLight(status, theme);
		if (status === "pending") armBlink(`group:${internals(this.tools[0]!).toolCallId ?? "?"}`, () => this.requestRender());

		const firstName = toolName(this.tools[0]!);
		const sameName = this.tools.every((tool) => toolName(tool) === firstName);
		const label = sameName ? humanizeToolName(firstName) : "Multiple Tools";
		const subject = sameName && !this.expanded ? repeatedSubject(this.tools, firstName) : "";
		const lines: string[] = [];

		if (subject && this.tools.length > 1) {
			// Every member is the same tool hitting the same target — one row.
			const counts = countStatuses(this.tools);
			const attention = counts.pending || counts.error ? ` • ${countsText(this.tools, theme)}` : "";
			const suffix = `${theme.fg("muted", ` ×${this.tools.length}`)}${attention}`;
			const body = compactToolLine(this.tools[0]!, Math.max(1, safeWidth - visibleWidth(suffix) - 2));
			lines.push(clampLine(`${light} ${body}${suffix}`, safeWidth));
		} else {
			lines.push(clampLine(` ${light} ${theme.bold(`${label}:`)} ${countsText(this.tools, theme)}`, safeWidth));
			const childWidth = Math.max(1, safeWidth - 4);
			if (this.expanded) {
				for (let index = 0; index < this.tools.length; index++) {
					const tool = this.tools[index]!;
					lines.push(...branchLine(expandedToolLines(tool, childWidth), index, this.tools.length, safeWidth, groupLight(toolStatus(tool), theme), theme));
				}
			} else {
				const entries = collapseEntries(this.tools);
				for (let index = 0; index < entries.length; index++) {
					const entry = entries[index]!;
					const entryStatus = overallStatus(entry.tools);
					lines.push(...branchLine([entryLine(entry, childWidth)], index, entries.length, safeWidth, groupLight(entryStatus, theme), theme));
					// Running bash keeps its latest visible output row (upstream: grouped
					// Bash rows show live progress instead of hiding it behind the group).
					if (entryStatus === "pending" && entry.name === "bash") {
						const tail = stripToolChrome(entry.tools[0]!.render(childWidth)).slice(-1)[0];
						if (tail) lines.push(clampLine(` ${theme.fg("dim", "│")}   ${tail}`, safeWidth));
					}
				}
			}
		}

		this.lastHeight = lines.length;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Container patch
// ---------------------------------------------------------------------------

const COMPONENT_PARENT = Symbol.for("pi-cc-ui:component-parent");
const GROUPING_PATCH = Symbol.for("pi-cc-ui:container-grouping");
const NON_GROUPABLE_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);
const ACTIVE_TOOL_GROUPS = new Set<ToolGroupComponent>();
/** Parents whose addChild we have seen, for re-grouping after a toggle-on. */
const seenParents: object[] = [];
const MAX_SEEN_PARENTS = 50;

function setComponentParent(component: unknown, parent: unknown): void {
	if (component && typeof component === "object") {
		(component as Record<symbol, unknown>)[COMPONENT_PARENT] = parent;
	}
}

function isGroupableTool(value: unknown): value is AnyTool {
	return value instanceof ToolExecutionComponent && !NON_GROUPABLE_TOOL_NAMES.has(toolName(value));
}

function isToolGroupComponent(value: unknown): value is ToolGroupComponent {
	return value instanceof ToolGroupComponent;
}

function isIgnorableSeparator(value: unknown): boolean {
	if (value instanceof Spacer) return true;
	const isAssistant =
		value instanceof AssistantMessageComponent ||
		(value as { constructor?: { name?: string } })?.constructor?.name === "AssistantMessageComponent";
	if (!isAssistant) return false;
	const children = (value as { contentContainer?: { children?: unknown[] } }).contentContainer?.children;
	if (!Array.isArray(children) || children.length === 0) return true;
	return children.every((child) => child instanceof Spacer);
}

function findPreviousToolSibling(children: unknown[], startIndex: number): { child: unknown; index: number } | undefined {
	for (let index = startIndex; index >= 0; index--) {
		const child = children[index];
		if (isIgnorableSeparator(child)) continue;
		return { child, index };
	}
	return undefined;
}

function maybeGroupToolComponent(parent: unknown, component: unknown): void {
	if (!isGroupingEnabled() || !isGroupableTool(component) || isToolGroupComponent(parent)) return;
	const children = (parent as { children?: unknown[] } | undefined)?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index <= 0) return;
	const previousEntry = findPreviousToolSibling(children, index - 1);
	if (!previousEntry) return;
	const previous = previousEntry.child;
	if (isToolGroupComponent(previous)) {
		children.splice(index, 1);
		previous.addTool(component);
		setComponentParent(component, previous);
		ACTIVE_TOOL_GROUPS.add(previous);
		return;
	}
	if (isGroupableTool(previous)) {
		const group = new ToolGroupComponent();
		group.expanded = internals(previous).expanded === true || internals(component).expanded === true;
		group.addTool(previous);
		group.addTool(component);
		setComponentParent(group, parent);
		setComponentParent(previous, group);
		setComponentParent(component, group);
		children[previousEntry.index] = group;
		children.splice(index, 1);
		ACTIVE_TOOL_GROUPS.add(group);
	}
}

/** Split every live group back into its member components (group off). */
function ungroupAllToolGroups(): AnyTool[] {
	const released: AnyTool[] = [];
	for (const group of [...ACTIVE_TOOL_GROUPS]) {
		const parent = (group as unknown as Record<symbol, unknown>)[COMPONENT_PARENT] as { children?: unknown[] } | undefined;
		const children = parent?.children;
		if (!Array.isArray(children)) {
			ACTIVE_TOOL_GROUPS.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index === -1) {
			ACTIVE_TOOL_GROUPS.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) setComponentParent(tool, parent);
		children.splice(index, 1, ...tools);
		ACTIVE_TOOL_GROUPS.delete(group);
		released.push(...tools);
	}
	return released;
}

/** Re-scan every container we have seen and group any consecutive siblings. */
function regroupExisting(): void {
	for (const parent of seenParents) {
		const children = (parent as { children?: unknown[] }).children;
		if (!Array.isArray(children)) continue;
		for (const child of [...children]) {
			void child;
			// Re-run the same pass addChild uses, one sibling at a time.
			maybeGroupToolComponent(parent, child);
		}
	}
}

function requestRenderFor(components: AnyTool[]): void {
	const seen = new Set<UiLike>();
	for (const component of components) {
		const ui = internals(component).ui;
		if (ui?.requestRender && !seen.has(ui)) seen.add(ui);
	}
	for (const ui of seen) ui.requestRender?.();
}

/** Re-apply the current grouping setting to rows already on screen. Called by
 *  `/cc-tools group on|off` so the toggle is immediate. */
export function repaintGroupedRows(): void {
	if (isGroupingEnabled()) {
		regroupExisting();
		for (const group of ACTIVE_TOOL_GROUPS) group.requestRender();
		return;
	}
	requestRenderFor(ungroupAllToolGroups());
}

function patchContainerGrouping(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const proto = Container.prototype as any;
	if (proto[GROUPING_PATCH]) return;
	const originalAddChild = proto.addChild;
	const originalRemoveChild = proto.removeChild;
	const originalClear = proto.clear;
	proto.addChild = function patchedAddChild(this: object, component: unknown) {
		const result = originalAddChild.call(this, component);
		setComponentParent(component, this);
		if (!seenParents.includes(this)) {
			seenParents.push(this);
			if (seenParents.length > MAX_SEEN_PARENTS) seenParents.shift();
		}
		maybeGroupToolComponent(this, component);
		return result;
	};
	proto.removeChild = function patchedRemoveChild(this: object, component: unknown) {
		const result = originalRemoveChild.call(this, component);
		const record = component as Record<symbol, unknown> | undefined;
		if (record && record[COMPONENT_PARENT] === this) delete record[COMPONENT_PARENT];
		return result;
	};
	proto.clear = function patchedClear(this: object) {
		for (const child of (this as { children?: unknown[] }).children ?? []) {
			const record = child as Record<symbol, unknown> | undefined;
			if (record && record[COMPONENT_PARENT] === this) delete record[COMPONENT_PARENT];
		}
		return originalClear.call(this);
	};
	proto[GROUPING_PATCH] = true;
}

export function installToolGroups(pi: ExtensionAPI): void {
	patchContainerGrouping();
	pi.on("session_shutdown", async () => {
		ungroupAllToolGroups();
		blinkers.clear();
		stopBlink();
	});
}

/** Cached Text component shared by builtins' call/result renderers. */
export function makeText(last: unknown, text: string): Text {
	const cached = last instanceof Text ? last : new Text("", 0, 0);
	cached.setText(text);
	return cached;
}
