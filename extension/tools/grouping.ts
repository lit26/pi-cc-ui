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
import { formatElapsed } from "../spinner.js";
import { isThinkingExpanded } from "../thinking.js";

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
// Thinking attribution
//
// The collapsed summary reuses CC's phrasing ("Thought for 1m 30s, ran 3 shell
// commands"), so grouped tools need the thinking time that preceded them. The
// old event-driven tracker did this; it is rebuilt here as a tiny span clock
// that the container-level grouping drains per group.
// ---------------------------------------------------------------------------

let pendingThinkingMs = 0;
let thinkingOpenSince: number | undefined;

function settleThinking(): void {
	if (thinkingOpenSince === undefined) return;
	pendingThinkingMs += Date.now() - thinkingOpenSince;
	thinkingOpenSince = undefined;
}

/** Hand the accumulated thinking time to the group being formed. */
function takeThinkingMs(): number {
	settleThinking();
	const ms = pendingThinkingMs;
	pendingThinkingMs = 0;
	return ms;
}

function resetThinking(): void {
	pendingThinkingMs = 0;
	thinkingOpenSince = undefined;
}

/** MessageUpdateEvent shapes differ across pi versions: prefer the explicit
 *  assistant message event, fall back to watching the last streamed block. */
function trackThinkingEvent(event: { assistantMessageEvent?: { type?: string }; message?: { content?: unknown } }): void {
	const type = event.assistantMessageEvent?.type;
	if (type === "thinking_start") {
		if (thinkingOpenSince === undefined) thinkingOpenSince = Date.now();
		return;
	}
	if (type === "thinking_end") {
		settleThinking();
		return;
	}
	const content = event.message?.content;
	if (!Array.isArray(content) || content.length === 0) return;
	const last = content[content.length - 1] as { type?: string } | undefined;
	if (last?.type === "thinking") {
		if (thinkingOpenSince === undefined) thinkingOpenSince = Date.now();
	} else {
		settleThinking();
	}
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

/** The member light for an expanded branch row (the summary line has no dot). */
function groupLight(status: ToolStatus, theme: Theme): string {
	if (status === "error") return theme.fg("error", "●");
	if (status === "pending") return blinkPhase ? theme.fg("dim", "●") : " ";
	return theme.fg("success", "●");
}

/** CC digest bucket for a tool name. */
function kindOf(name: string): "search" | "read" | "list" | "bash" | "mcp" | "other" {
	if (name === "read") return "read";
	if (name === "grep" || name === "find") return "search";
	if (name === "ls") return "list";
	if (name === "bash") return "bash";
	if (name === "mcp" || name.startsWith("mcp__")) return "mcp";
	return "other";
}

/** "a file" for one, "3 files" beyond. */
function amount(count: number, one: string, many: string): string {
	return count === 1 ? `a ${one}` : `${count} ${many}`;
}

/**
 * CC's collapsed-group digest, e.g. "Read a file, ran 6 shell commands", with
 * the thinking duration folded in first when it is worth reporting. Fragment
 * order matches CC (thinking, search, read, list, MCP, other, bash) and stays in
 * the present tense while any member is still running.
 */
function groupSummary(tools: AnyTool[], thinkingMs: number, status: ToolStatus): string {
	const active = status === "pending";
	const counts = { search: 0, read: 0, list: 0, bash: 0, mcp: 0, other: 0 };
	for (const tool of tools) counts[kindOf(toolName(tool))]++;
	const parts: string[] = [];
	if (thinkingMs >= 1_000) parts.push(`${active ? "thinking for" : "thought for"} ${formatElapsed(thinkingMs)}`);
	if (counts.search) parts.push(`${active ? "searching for" : "searched for"} ${amount(counts.search, "pattern", "patterns")}`);
	if (counts.read) parts.push(`${active ? "reading" : "read"} ${amount(counts.read, "file", "files")}`);
	if (counts.list) parts.push(`${active ? "listing" : "listed"} ${amount(counts.list, "directory", "directories")}`);
	if (counts.mcp) parts.push(`${active ? "querying" : "queried"} ${amount(counts.mcp, "MCP tool", "MCP tools")}`);
	if (counts.other) parts.push(`${active ? "calling" : "called"} ${amount(counts.other, "tool", "tools")}`);
	if (counts.bash) parts.push(`${active ? "running" : "ran"} ${amount(counts.bash, "shell command", "shell commands")}`);
	const text = parts.join(", ");
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
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
	/** Thinking time attributed to this group's tool batch. */
	thinkingMs = 0;
	/** Pointer is over the digest line — the label renders in the accent color. */
	hovered = false;
	private lastHeight = 0;

	addTool(tool: AnyTool): void {
		this.tools.push(tool);
	}

	addThinking(ms: number): void {
		if (ms > 0) this.thinkingMs += ms;
	}

	/** Row index of the digest line: 0 is the blank separator row. */
	private labelRow(): number {
		return 1;
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

	setHovered(hovered: boolean): void {
		if (this.hovered === hovered) return;
		this.hovered = hovered;
		this.requestRender();
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
		if (event.type === "move") {
			if (event.y !== this.labelRow()) return undefined;
			this.setHovered(true);
			return {
				handled: true,
				target: { component: this, originX: 0, originY: 0, width: event.width, height: this.lastHeight },
			};
		}
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
		if (status === "pending") armBlink(`group:${internals(this.tools[0]!).toolCallId ?? "?"}`, () => this.requestRender());

		// Blank separator row, then the CC digest. Deliberately no status dot:
		// a group is not one tool and the digest already carries the tense.
		const summary = groupSummary(this.tools, this.thinkingMs, status);
		const lines: string[] = ["", clampLine(`  ${theme.fg(this.hovered ? "accent" : "muted", summary)}`, safeWidth)];
		if (this.expanded) {
			const childWidth = Math.max(1, safeWidth - 4);
			for (let index = 0; index < this.tools.length; index++) {
				const tool = this.tools[index]!;
				lines.push(
					...branchLine(expandedToolLines(tool, childWidth), index, this.tools.length, safeWidth, groupLight(toolStatus(tool), theme), theme),
				);
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
	if (children.every((child) => child instanceof Spacer)) return true;
	// A thinking-only message renders ZERO rows while thinking is CC-collapsed
	// (thinking.ts transformer returns ""), so it is not a visual boundary and
	// grouped tools span iterations. The message's own toolCall blocks are NOT a
	// boundary: its tool components are added as the message's following
	// siblings, which is exactly the batch being grouped. Assistant body text and
	// images stay boundaries; expanded thinking stays a boundary.
	if (isThinkingExpanded()) return false;
	const content = (value as { lastMessage?: { content?: unknown } }).lastMessage?.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		const type = (block as { type?: string }).type;
		if (type === "image") return false;
		if (type === "text" && String((block as { text?: unknown }).text ?? "").trim() !== "") return false;
	}
	return true;
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
		previous.addThinking(takeThinkingMs());
		setComponentParent(component, previous);
		ACTIVE_TOOL_GROUPS.add(previous);
		return;
	}
	if (isGroupableTool(previous)) {
		const group = new ToolGroupComponent();
		group.expanded = internals(previous).expanded === true || internals(component).expanded === true;
		group.addTool(previous);
		group.addTool(component);
		group.addThinking(takeThinkingMs());
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
	const originalHandleMouse = proto.handleMouse;
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
	// Hover exit has no event: pi only dispatches to whatever sits under the
	// pointer, so the group that was hovered never hears about the pointer
	// leaving. Wrap the outermost mouse dispatch and read the resolved target
	// out of its result — if it is not inside a group, every group unhovers.
	proto.handleMouse = function patchedHandleMouse(this: object, event: { type?: string }) {
		if (event?.type !== "move" || mouseDispatchDepth > 0 || typeof originalHandleMouse !== "function") {
			return originalHandleMouse.call(this, event);
		}
		mouseDispatchDepth += 1;
		try {
			const result = originalHandleMouse.call(this, event);
			applyHoverFromTarget((result as { target?: { component?: unknown } } | undefined)?.target?.component);
			return result;
		} finally {
			mouseDispatchDepth -= 1;
		}
	};
	proto[GROUPING_PATCH] = true;
}

let mouseDispatchDepth = 0;

/** Walk up from the leaf the mouse dispatch resolved to and hover its group,
 *  clearing every other group. */
function applyHoverFromTarget(target: unknown): void {
	let current = target;
	let hovered: ToolGroupComponent | undefined;
	let guard = 0;
	while (current && typeof current === "object" && guard++ < 64) {
		if (current instanceof ToolGroupComponent) {
			hovered = current;
			break;
		}
		current = (current as Record<symbol, unknown>)[COMPONENT_PARENT];
	}
	for (const group of ACTIVE_TOOL_GROUPS) {
		if (group !== hovered) group.setHovered(false);
	}
}

export function installToolGroups(pi: ExtensionAPI): void {
	patchContainerGrouping();
	pi.on("session_start", async () => resetThinking());
	pi.on("message_update", async (event) => trackThinkingEvent(event as never));
	pi.on("message_end", async (event) => {
		if (event.message?.role === "assistant") settleThinking();
	});
	pi.on("session_shutdown", async () => {
		ungroupAllToolGroups();
		blinkers.clear();
		resetThinking();
		stopBlink();
	});
}

/** Cached Text component shared by builtins' call/result renderers. */
export function makeText(last: unknown, text: string): Text {
	const cached = last instanceof Text ? last : new Text("", 0, 0);
	cached.setText(text);
	return cached;
}
