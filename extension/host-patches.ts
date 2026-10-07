/**
 * Runtime patches on HOST classes — the extension-side landing of the
 * upstream PR draft (scratchpad/pi-upstream-pr.md). Remove once upstream
 * merges the equivalent fixes.
 *
 * Technique (learned from npm's pi-claude-code-ui / FammasMaz/pi-cc-tools):
 * `AssistantMessageComponent` and `InteractiveMode` are PUBLIC exports of
 * @earendil-works/pi-coding-agent, and pi's extension loader aliases that
 * specifier to the host's own running module (loader.js getAliases /
 * bundledModules) — so wrapping their prototype methods here patches the
 * live classes the host renders with. No host files are modified; the
 * patch ships with the extension.
 *
 * Patch 1 — AssistantMessageComponent.prototype.render:
 *   (a) A message whose entire rendered output is whitespace returns [].
 *   Why: updateContent predicts spacing from RAW message data — a non-empty
 *   thinking block earns a top Spacer(1) even when the thinking renders zero
 *   rows (our transformer collapses it, CC-style). Every thinking+toolCall
 *   message thus left one orphan blank row; with a thinking model and tool
 *   grouping (tools drawn by the group leader) those stacked into 8+
 *   consecutive blank rows after the group line. CC renders such
 *   intermediate messages as nothing at all.
 *   (b) Leading blank rows collapse to one. A thinking+text message renders
 *   [top Spacer, (thinking → 0 rows), trailing Spacer, body] — two blank
 *   rows before the body where CC has one. The first row is kept (it may
 *   carry the OSC133 copy-zone start mark), the redundant blanks after it
 *   are dropped. Legitimate messages never start with two blank rows: the
 *   host emits at most one top Spacer, and Markdown bodies are trimmed.
 *
 * Patch 2 — InteractiveMode.prototype.showStatus:
 *   Drops exactly the "Tool output: expanded|collapsed" notice. showStatus
 *   appends a Spacer+Text pair to chatContainer, so every Ctrl+O press left
 *   a permanent status row scrolling with the transcript. CC's ctrl+o is
 *   traceless — the expansion itself is the feedback. Every other
 *   showStatus message passes through untouched.
 *
 * Patch 3 — AssistantMessageComponent.prototype.updateContent:
 *   Forces the markdown/thinking output pad to at least 2 while the content
 *   is rebuilt. pi's default outputPad is 1, so assistant text started at
 *   column 1 while CC — and this extension's own tool rows and group digest
 *   (builtins.ts toolHeader `● `, grouping.ts digest `  `) — start at column
 *   2. CC draws the assistant body at column 2 too (NoSelect minWidth 2 dot,
 *   AssistantTextMessage.tsx:232), so 2 is the faithful column and 1 was the
 *   misalignment. The pad is restored after the rebuild so the host keeps
 *   the user's configured value for anything that reads it elsewhere.
 *
 * Patch 4 — 2-column alignment for the rest of the transcript:
 *   (a) UserMessageComponent.prototype.rebuild — the user's own prompt was
 *       also drawn at pi's 1-column pad. The child Markdown is then restyled
 *       to CC's user prompt (UserPromptMessage.tsx / HighlightedThinkingText
 *       .tsx): no top/bottom pad row, a flat grey background
 *       (darkTheme rgb(55,55,55) / lightTheme rgb(240,240,240)), and the `❯ `
 *       pointer at column 0 in front of the text. A theme whose
 *       userMessageBg is already grey (the CC themes) keeps its exact shade;
 *       only a coloured background (pi's default `blueBg`) is flattened.
 *   (a-2) UserMessageComponent.prototype.render — paints the `❯` pointer into
 *       the first row's gutter (the Markdown owns the row string, so the
 *       pointer cannot be part of its source text without becoming a
 *       markdown blockquote).
 *   (b) SettingsManager.prototype.getOutputPad — every pad the host reads
 *       while building the transcript reports 2, so fresh message components
 *       and `this.outputPad` readers land on the same column.
 *   (c) ToolExecutionComponent.prototype.render — tools without a custom
 *       `renderShell` (the `question` tool, pi-code's todo/web/subagent/MCP
 *       tools, unknown/fallback tools) render through the host Box/Text with
 *       pad 1; bump it to 2 so their rows align with the CC-style builtins.
 *   (d) Transcript-container child pad — the host hardcodes `1` for many
 *       transcript rows that never consult outputPad (`showWarning` is one:
 *       `new ThemedText(..., 1, 0)`), so no pad-source patch can reach them.
 *       The chat container is registered once it is seen (the first warning /
 *       status / message), and `Container.prototype.addChild` then coerces
 *       any child carrying the host default pad `1` to the CC column. That
 *       covers every warning, notice, error, and status row without listing
 *       each site. Components built at pad `0` keep their own gutter (the
 *       turn footer draws its own leading space).
 *
 * Patch 5 — Loader.prototype.render:
 *   De-indents the live "working" spinner row only. pi-tui builds every Loader
 *   at paddingX 1, so this extension's CC spinner line (`✻ Brewing…`, glyph at
 *   column 0) rendered one column right.
 *
 * All wrappers call the original method and are Symbol-flag guarded
 * (idempotent across reloads and across multiple extension instances).
 */
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	InteractiveMode,
	SettingsManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Loader } from "@earendil-works/pi-tui";

// CSI + OSC (BEL or ST terminated) + charset selects. OSC matters: the host
// render wraps a message's first/last row in OSC133 zone marks, which the
// all-blank check must see through.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;

function isBlankRow(line: unknown): boolean {
	return typeof line === "string" && line.replace(ANSI_RE, "").trim() === "";
}

const BLANK_RENDER_FLAG = Symbol.for("better-cc-ui:assistant-blank-render");
const TEXT_PAD_FLAG = Symbol.for("better-cc-ui:assistant-text-pad");
const USER_PAD_FLAG = Symbol.for("better-cc-ui:user-text-pad");
const USER_BG_FLAG = Symbol.for("better-cc-ui:user-message-gray-bg");
const USER_ARROW_FLAG = Symbol.for("better-cc-ui:user-message-arrow");
const SETTINGS_PAD_FLAG = Symbol.for("better-cc-ui:settings-output-pad");
const SHELL_PAD_FLAG = Symbol.for("better-cc-ui:tool-shell-pad");
const CHILD_PAD_FLAG = Symbol.for("better-cc-ui:transcript-child-pad");
const REGISTER_PAD_FLAG = Symbol.for("better-cc-ui:transcript-register");
const WORKING_PAD_FLAG = Symbol.for("better-cc-ui:working-indicator-pad");
const STATUS_FLAG = Symbol.for("better-cc-ui:tool-output-status");

/** CC column for transcript rows = the tool-name column (`● ` = 2). */
const CC_OUTPUT_PAD = 2;

/** Coerce a pad value to the CC column, tolerating a missing value. */
function ccPad(value: unknown): number {
	return Math.max(CC_OUTPUT_PAD, typeof value === "number" ? value : CC_OUTPUT_PAD);
}

/**
 * InteractiveMode methods that add transcript rows. Each registers its
 * `chatContainer` in TRANSCRIPT_CONTAINERS before the original runs, so the
 * addChild hook can pad rows even on a cold start (first warning before any
 * message exists). Methods reading `this.outputPad` are covered by the
 * getOutputPad patch; the rest hardcode pad 1 and are covered by the hook.
 */
const CHAT_REGISTER_METHODS = [
	"showStatus",
	"showWarning",
	"showError",
	"showExtensionError",
	"showManagedToolStatus",
	"showNewVersionNotification",
	"showPackageUpdateNotification",
	"renderProjectTrustWarningIfNeeded",
	"addCacheWarmingUsage",
	"addCompactionCostNotice",
	"maybeShowThinkingDropNotice",
	"addCacheMissNotice",
	"addCustomEntryToChat",
	"applyRuntimeSettings",
	"suggestBugReport",
] as const;

/** The chat containers we have identified, so addChild can pad their rows. */
const TRANSCRIPT_CONTAINERS = new WeakSet<object>();

/** Remember `owner.chatContainer` (an InteractiveMode) as a transcript root. */
function registerTranscriptContainer(owner: unknown): void {
	const chat = (owner as { chatContainer?: unknown } | undefined)?.chatContainer;
	if (chat && typeof chat === "object") TRANSCRIPT_CONTAINERS.add(chat);
}

/** A message component marks its parent container as a transcript root. */
function isTranscriptChild(value: unknown): boolean {
	return (
		value instanceof AssistantMessageComponent ||
		value instanceof UserMessageComponent ||
		value instanceof CustomMessageComponent ||
		value instanceof ToolExecutionComponent
	);
}

/**
 * Raise a text-like child's left pad to the CC column. Only the host's
 * default `1` is corrected: an explicit `0` means the component owns its own
 * gutter (turn-footer.ts builds ` ✻ Worked for Ns` at pad 0), and coercing it
 * would add blank space in front of the label.
 */
function ensureChildPad(component: unknown): void {
	if (!component || typeof component !== "object") return;
	const child = component as { paddingX?: unknown; invalidate?: () => void };
	if (child.paddingX !== 1) return;
	child.paddingX = CC_OUTPUT_PAD;
	child.invalidate?.();
}

/** The exact host notice dropped by patch 2 (interactive-mode.js setToolsExpanded). */
const TOOL_OUTPUT_STATUS_RE = /^Tool output: (?:expanded|collapsed)$/;

/**
 * CC user-prompt decoration. UserPromptMessage.tsx paints its Box with
 * backgroundColor 'userMessageBackground' and no vertical padding;
 * HighlightedThinkingText.tsx puts `figures.pointer + " "` (`❯ `) in `subtle`
 * at column 0 ahead of the text, so the text lands on CC's column 2.
 */
const USER_ARROW = "\u276F";
/** The leading ANSI/OSC run of a rendered row (OSC133 marks included). */
const LEADING_ESCAPE_RE = /^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*/;
const BG_TRUECOLOR_RE = /\x1b\[48;2;(\d{1,3});(\d{1,3});(\d{1,3})m/;
/** Above this channel spread a background is coloured, below it is already grey. */
const GREY_CHROMA = 8;
/** CC darkTheme / lightTheme userMessageBackground (rgb(55,55,55) / rgb(240,240,240)). */
const CC_USER_BG_DARK = 55;
const CC_USER_BG_LIGHT = 240;

/**
 * Flatten a coloured theme background to CC's grey. A background that is
 * already grey (every CC theme) passes through untouched so the theme keeps
 * its exact shade; only a real hue (pi's default `blueBg`) is replaced,
 * dark or light following the colour's perceptual luminance.
 */
function greyOutBackground(wrapped: string, content: string): string {
	const match = BG_TRUECOLOR_RE.exec(wrapped);
	if (!match) return wrapped;
	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	if (Math.max(r, g, b) - Math.min(r, g, b) < GREY_CHROMA) return wrapped;
	const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const v = lum < 128 ? CC_USER_BG_DARK : CC_USER_BG_LIGHT;
	return `\x1b[48;2;${v};${v};${v}m${content}\x1b[49m`;
}

/**
 * Restyle the user prompt's Markdown child: drop the pad row the host bakes in
 * (rebuild builds it at paddingY 1 — user-message.js), then grey the background.
 */
function styleUserMessage(component: unknown): void {
	const child = (component as { children?: unknown[] } | undefined)?.children?.[0] as
		| { paddingY?: number; defaultTextStyle?: object; invalidate?: () => void }
		| undefined;
	if (!child) return;
	if (child.paddingY !== 0) {
		child.paddingY = 0;
		child.invalidate?.();
	}
	const style = child.defaultTextStyle as Record<string | symbol, unknown> | undefined;
	if (style && typeof style.bgColor === "function" && !style[USER_BG_FLAG]) {
		const originalBg = style.bgColor as (content: string) => string;
		style.bgColor = (content: string) => greyOutBackground(originalBg(content), content);
		style[USER_BG_FLAG] = true;
	}
}

/**
 * Put the CC `❯ ` pointer in the prompt's opening row. The row starts with the
 * OSC133 zone mark and a background escape, then the Markdown's left pad; the
 * pointer replaces one pad space, so the text still lands on the CC column.
 */
function prependUserArrow(line: unknown): unknown {
	if (typeof line !== "string") return line;
	const prefix = LEADING_ESCAPE_RE.exec(line)?.[0] ?? "";
	const rest = line.slice(prefix.length);
	if (!rest.startsWith(" ")) return line;
	return `${prefix}\x1b[2m${USER_ARROW}\x1b[22m${rest.slice(1)}`;
}

export function installHostPatches(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const amProto = AssistantMessageComponent.prototype as any;
	if (!amProto[BLANK_RENDER_FLAG] && typeof amProto.render === "function") {
		const originalRender = amProto.render;
		amProto.render = function ccUiBlankMessageRender(width: number): string[] {
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			let blank = 0;
			while (blank < lines.length && isBlankRow(lines[blank])) blank++;
			if (blank === lines.length) return [];
			// (b) collapse a run of leading blank rows to one; keep lines[0] — it
			// may carry the OSC133 zone-start mark.
			if (blank > 1) lines.splice(1, blank - 1);
			return lines;
		};
		amProto[BLANK_RENDER_FLAG] = true;
	}

	if (!amProto[TEXT_PAD_FLAG] && typeof amProto.updateContent === "function") {
		const originalUpdateContent = amProto.updateContent;
		amProto.updateContent = function ccUiAlignedUpdateContent(message: unknown, isStreaming?: boolean): unknown {
			const saved = this.outputPad;
			this.outputPad = ccPad(saved);
			try {
				return originalUpdateContent.call(this, message, isStreaming);
			} finally {
				this.outputPad = saved;
			}
		};
		amProto[TEXT_PAD_FLAG] = true;
	}

	// Patch 4a — user messages (same coercion as the assistant body), plus the
	// CC prompt restyle (no vertical pad, grey background, `❯` pointer).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const umProto = UserMessageComponent.prototype as any;
	if (!umProto[USER_PAD_FLAG] && typeof umProto.rebuild === "function") {
		const originalUserRebuild = umProto.rebuild;
		umProto.rebuild = function ccUiAlignedUserRebuild(): unknown {
			const saved = this.outputPad;
			this.outputPad = ccPad(saved);
			try {
				const result = originalUserRebuild.call(this);
				styleUserMessage(this);
				return result;
			} finally {
				this.outputPad = saved;
			}
		};
		umProto[USER_PAD_FLAG] = true;
	}

	// Patch 4a-2 — the `❯` pointer in the prompt's opening row.
	if (!umProto[USER_ARROW_FLAG] && typeof umProto.render === "function") {
		const originalUserRender = umProto.render;
		umProto.render = function ccUiUserPointerRender(width: number): string[] {
			const lines = originalUserRender.call(this, width);
			if (Array.isArray(lines) && lines.length > 0) lines[0] = prependUserArrow(lines[0]);
			return lines;
		};
		umProto[USER_ARROW_FLAG] = true;
	}

	// Patch 4b — the single pad source the host reads while building rows.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const smProto = SettingsManager.prototype as any;
	if (!smProto[SETTINGS_PAD_FLAG] && typeof smProto.getOutputPad === "function") {
		const originalGetOutputPad = smProto.getOutputPad;
		smProto.getOutputPad = function ccUiAlignedOutputPad(): number {
			return ccPad(originalGetOutputPad.call(this));
		};
		smProto[SETTINGS_PAD_FLAG] = true;
	}

	// Patch 4d — pad every row added to a transcript container, whatever its
	// hardcoded pad. Runs before grouping.ts wraps the same method (index.ts
	// installs host patches first), so the two wrappers chain.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const containerProto = Container.prototype as any;
	if (!containerProto[CHILD_PAD_FLAG] && typeof containerProto.addChild === "function") {
		const originalAddChild = containerProto.addChild;
		containerProto.addChild = function ccUiAlignedChatChild(this: object, component: unknown): unknown {
			if (isTranscriptChild(component)) TRANSCRIPT_CONTAINERS.add(this);
			if (TRANSCRIPT_CONTAINERS.has(this)) ensureChildPad(component);
			return originalAddChild.call(this, component);
		};
		containerProto[CHILD_PAD_FLAG] = true;
	}

	// Register the chat container from the methods that first touch it.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const imProto = InteractiveMode.prototype as any;
	if (!imProto[REGISTER_PAD_FLAG]) {
		for (const method of CHAT_REGISTER_METHODS) {
			const original = imProto[method];
			if (typeof original !== "function") continue;
			imProto[method] = function ccUiRegisterTranscript(...args: unknown[]): unknown {
				registerTranscriptContainer(this);
				return original.apply(this, args);
			};
		}
		imProto[REGISTER_PAD_FLAG] = true;
	}

	// Patch 4c — default-shell tool rows (question, todo, mcp, fallback).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tProto = ToolExecutionComponent.prototype as any;
	if (!tProto[SHELL_PAD_FLAG] && typeof tProto.render === "function") {
		const originalToolRender = tProto.render;
		tProto.render = function ccUiAlignedToolShellRender(width: number): string[] {
			if (this.contentBox) this.contentBox.paddingX = ccPad(this.contentBox.paddingX ?? 1);
			if (this.contentText) this.contentText.paddingX = ccPad(this.contentText.paddingX ?? 1);
			return originalToolRender.call(this, width);
		};
		tProto[SHELL_PAD_FLAG] = true;
	}

	// Patch 5 — the working spinner row. pi-tui Loader extends Text at
	// paddingX 1 (loader.js:18), so the CC spinner line (`✻ Brewing…`, glyph at
	// column 0 — SpinnerAnimationRow.tsx) rendered as ` ✻ Brewing…`. Only the
	// live "working" indicator is de-indented; retry/compaction rows keep the
	// host indent.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const loaderProto = Loader.prototype as any;
	if (!loaderProto[WORKING_PAD_FLAG] && typeof loaderProto.render === "function") {
		const originalLoaderRender = loaderProto.render;
		loaderProto.render = function ccUiAlignedWorkingRow(this: { kind?: string; paddingX?: number }, width: number): string[] {
			if (this.kind === "working" && this.paddingX === 1) this.paddingX = 0;
			return originalLoaderRender.call(this, width);
		};
		loaderProto[WORKING_PAD_FLAG] = true;
	}

	if (!imProto[STATUS_FLAG] && typeof imProto.showStatus === "function") {
		const originalShowStatus = imProto.showStatus;
		imProto.showStatus = function ccUiFilteredShowStatus(message: unknown): unknown {
			if (typeof message === "string" && TOOL_OUTPUT_STATUS_RE.test(message)) return undefined;
			return originalShowStatus.call(this, message);
		};
		imProto[STATUS_FLAG] = true;
	}
}
