/**
 * pi-cc-ui preferences — `~/.pi/agent/pi-cc-ui.json`.
 *
 * Upstream reads the same file; the `palette` key holds user color overrides
 * (diffAddedLine, diffRemovedWord, diffLineNumber, diffDimmed, …), each a
 * `#RRGGBB` string or a 0-255 color index. We keep the file shape identical so
 * a config written by upstream's /cc screen still applies here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { setDiffOverrides } from "./palette.js";

const PREFERENCES_FILE = "pi-cc-ui.json";
const JSON_INDENT = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prefsPath(): string {
	return join(getAgentDir(), PREFERENCES_FILE);
}

export function readPrefs(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(prefsPath(), "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function palettePrefs(): Record<string, unknown> {
	const value = readPrefs()["palette"];
	return isRecord(value) ? value : {};
}

/** Push the persisted color overrides into the palette layer. */
export function loadPaletteOverrides(): void {
	setDiffOverrides(palettePrefs());
}

/** Set (or clear, with a nullish value) one palette override and persist it. */
export function setPalettePref(key: string, value: unknown): void {
	const palette = { ...palettePrefs() };
	if (value === undefined || value === null) {
		delete palette[key];
	} else {
		palette[key] = value;
	}
	const updated = { ...readPrefs(), palette };
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(prefsPath(), `${JSON.stringify(updated, null, JSON_INDENT)}\n`);
	loadPaletteOverrides();
}

export const DIFF_COLOR_ROLES = [
	"diffAddedLine",
	"diffRemovedLine",
	"diffAddedWord",
	"diffRemovedWord",
	"diffLineNumber",
	"diffAddedDecoration",
	"diffRemovedDecoration",
] as const;
