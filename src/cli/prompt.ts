// Prompt editor.
//
// Responsibilities:
//   - text buffer + cursor + selection
//   - undo/redo
//   - word movement
//   - multiline editing and wrapped-row cursor movement
//   - history browsing
//   - clipboard integration
//   - rendering prompt lines + cursor offset

import { clipboard } from './clipboard.ts'
import type { KeyEvent } from './keys.ts'

const MAX_PROMPT_LINES = 12
const MAX_UNDO = 200

// ── Wrapped layout ───────────────────────────────────────────────────────────

interface WrappedLayout {
	lines: string[]
	starts: number[]
}

function wordWrapLines(text: string, width: number): string[] {
	if (width <= 0) return [text]
	const out: string[] = []
	for (const segment of text.split('\n')) {
		let rest = segment
		while (rest.length > width) {
			let breakAt = rest.lastIndexOf(' ', width)
			if (breakAt <= 0) breakAt = width
			out.push(rest.slice(0, breakAt))
			rest = rest[breakAt] === ' ' ? rest.slice(breakAt + 1) : rest.slice(breakAt)
		}
		out.push(rest)
	}
	return out
}

function getLayout(input: string, width: number): WrappedLayout {
	const lines = wordWrapLines(input, width)
	const starts: number[] = []
	let pos = 0
	for (let i = 0; i < lines.length; i++) {
		starts.push(pos)
		const len = lines[i]!.length
		const nextChar = i < lines.length - 1 && pos + len < input.length ? input[pos + len] : ''
		pos += len + (nextChar === ' ' || nextChar === '\n' ? 1 : 0)
	}
	return { lines, starts }
}

function cursorToRowCol(input: string, absPos: number, width: number): { row: number; col: number } {
	const { lines, starts } = getLayout(input, width)
	for (let i = 0; i < lines.length; i++) {
		if (absPos <= starts[i]! + lines[i]!.length) return { row: i, col: absPos - starts[i]! }
	}
	const last = lines.length - 1
	return { row: last, col: lines[last]?.length ?? 0 }
}

function rowColToCursor(input: string, row: number, col: number, width: number): number {
	const { lines, starts } = getLayout(input, width)
	if (lines.length === 0) return 0
	const r = Math.max(0, Math.min(row, lines.length - 1))
	return starts[r]! + Math.max(0, Math.min(col, lines[r]!.length))
}

function verticalMove(
	input: string,
	width: number,
	cur: number,
	goal: number | null,
	dir: -1 | 1,
): { cursor: number; goalCol: number; atBoundary: boolean } {
	const { lines } = getLayout(input, width)
	const { row, col } = cursorToRowCol(input, cur, width)
	const g = goal ?? col
	const target = row + dir
	if (target < 0 || target >= lines.length) return { cursor: cur, goalCol: g, atBoundary: true }
	return { cursor: rowColToCursor(input, target, g, width), goalCol: g, atBoundary: false }
}

function wordLeft(text: string, pos: number): number {
	let i = pos - 1
	while (i > 0 && /\s/.test(text[i]!)) i--
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--
	return Math.max(0, i)
}

function wordRight(text: string, pos: number): number {
	let i = pos
	while (i < text.length && /\s/.test(text[i]!)) i++
	while (i < text.length && !/\s/.test(text[i]!)) i++
	return i
}

// ── State ────────────────────────────────────────────────────────────────────

let buf = ''
let cursor = 0
let goalCol: number | null = null
let selAnchor: number | null = null

interface Snapshot { text: string; cursor: number; selAnchor: number | null }
let undoStack: Snapshot[] = []
let redoStack: Snapshot[] = []
let undoGrouping = false

let history: string[] = []
let historyIndex = -1
let historyDraft = ''

let renderCallback: (() => void) | null = null

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(pos: number): number {
	return Math.max(0, Math.min(pos, buf.length))
}

function selRange(): { start: number; end: number } | null {
	if (selAnchor === null) return null
	const start = Math.min(selAnchor, cursor)
	const end = Math.max(selAnchor, cursor)
	return start === end ? null : { start, end }
}

function pushUndo(): void {
	const prev = undoStack[undoStack.length - 1]
	if (prev && prev.text === buf && prev.cursor === cursor && prev.selAnchor === selAnchor) return
	undoStack.push({ text: buf, cursor, selAnchor })
	if (undoStack.length > MAX_UNDO) undoStack.splice(0, undoStack.length - MAX_UNDO)
	redoStack.length = 0
}

// ── Mutations ────────────────────────────────────────────────────────────────

function replaceSelection(text: string): void {
	pushUndo()
	const sel = selRange()
	if (sel) {
		buf = buf.slice(0, sel.start) + text + buf.slice(sel.end)
		cursor = sel.start + text.length
	} else {
		buf = buf.slice(0, cursor) + text + buf.slice(cursor)
		cursor += text.length
	}
	selAnchor = null
	goalCol = null
}

function typeChar(ch: string): void {
	if (!undoGrouping) pushUndo()
	undoGrouping = true
	const sel = selRange()
	if (sel) {
		buf = buf.slice(0, sel.start) + ch + buf.slice(sel.end)
		cursor = sel.start + ch.length
	} else {
		buf = buf.slice(0, cursor) + ch + buf.slice(cursor)
		cursor += ch.length
	}
	selAnchor = null
	goalCol = null
}

function deleteRange(start: number, end: number): void {
	pushUndo()
	buf = buf.slice(0, start) + buf.slice(end)
	cursor = start
	selAnchor = null
	goalCol = null
}

function deleteSel(): boolean {
	const sel = selRange()
	if (!sel) return false
	deleteRange(sel.start, sel.end)
	return true
}

function move(pos: number, selecting: boolean): void {
	if (selecting) {
		if (selAnchor === null) selAnchor = cursor
	} else {
		selAnchor = null
	}
	cursor = clamp(pos)
	goalCol = null
}

function collapseOrMove(pos: number, edge: 'start' | 'end'): void {
	const sel = selRange()
	if (sel) {
		cursor = edge === 'start' ? sel.start : sel.end
		selAnchor = null
		goalCol = null
	} else {
		move(pos, false)
	}
}

function undo(): boolean {
	undoGrouping = false
	const snap = undoStack.pop()
	if (!snap) return false
	redoStack.push({ text: buf, cursor, selAnchor })
	buf = snap.text
	cursor = clamp(snap.cursor)
	selAnchor = snap.selAnchor
	goalCol = null
	return true
}

function redo(): boolean {
	undoGrouping = false
	const snap = redoStack.pop()
	if (!snap) return false
	undoStack.push({ text: buf, cursor, selAnchor })
	buf = snap.text
	cursor = clamp(snap.cursor)
	selAnchor = snap.selAnchor
	goalCol = null
	return true
}

// ── Clipboard ────────────────────────────────────────────────────────────────

function writeToClipboard(text: string): void {
	if (!text) return
	try {
		const p = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
		p.stdin.write(text)
		p.stdin.end()
	} catch {}
}

function resolvePlaceholder(placeholder: string, replacement: string): void {
	const idx = buf.lastIndexOf(placeholder)
	if (idx < 0) return
	buf = buf.slice(0, idx) + replacement + buf.slice(idx + placeholder.length)
	if (cursor > idx) cursor += replacement.length - placeholder.length
	cursor = clamp(cursor)
	renderCallback?.()
}

function doPaste(): void {
	const text = clipboard.cleanPaste(clipboard.pasteFromClipboard((placeholder, replacement) => {
		resolvePlaceholder(placeholder, replacement)
	}))
	if (text) replaceSelection(text)
}

// ── Public state helpers ─────────────────────────────────────────────────────

function setHistory(h: string[]): void {
	history = h
	historyIndex = -1
	historyDraft = ''
}

function pushHistory(text: string): void {
	history.push(text)
}

function text(): string {
	return buf
}

function cursorPos(): number {
	return cursor
}

function setText(t: string, c?: number): void {
	buf = t
	cursor = c ?? t.length
	goalCol = null
	selAnchor = null
	historyIndex = -1
	historyDraft = ''
}

function clear(): void {
	buf = ''
	cursor = 0
	goalCol = null
	selAnchor = null
	undoStack = []
	redoStack = []
	undoGrouping = false
	historyIndex = -1
	historyDraft = ''
}

function reset(): void {
	clear()
	history = []
}

function setRenderCallback(cb: () => void): void {
	renderCallback = cb
}

// ── Key handling ─────────────────────────────────────────────────────────────

function handleKey(k: KeyEvent, contentWidth: number): boolean {
	if (!(k.char && k.char.length === 1 && !k.ctrl && !k.alt && !k.cmd)) undoGrouping = false

	if (k.cmd) {
		if (k.key === 'c') { const s = selRange(); if (s) writeToClipboard(buf.slice(s.start, s.end)); return true }
		if (k.key === 'x') { const s = selRange(); if (s) { writeToClipboard(buf.slice(s.start, s.end)); deleteRange(s.start, s.end) }; return true }
		if (k.key === 'v') { doPaste(); return true }
		if (k.key === 'a') { selAnchor = 0; cursor = buf.length; return true }
		if (k.key === 'u' && k.shift) { redo(); return true }
		if (k.key === 'u') { undo(); return true }
		return false
	}

	if (k.key === 'enter' && k.shift && !k.alt) { replaceSelection('\n'); return true }
	if (k.key === 'enter') return false

	if (k.key === 'backspace') {
		if (k.alt) {
			if (!deleteSel() && cursor > 0) deleteRange(wordLeft(buf, cursor), cursor)
		} else {
			if (!deleteSel() && cursor > 0) deleteRange(cursor - 1, cursor)
		}
		return true
	}
	if (k.key === 'delete') {
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}
	if (k.key === 'd' && k.ctrl) {
		if (buf.length === 0) return false
		if (!deleteSel() && cursor < buf.length) deleteRange(cursor, cursor + 1)
		return true
	}

	if (k.key === 'u' && k.ctrl) { if (cursor > 0) deleteRange(0, cursor); return true }
	if (k.key === 'k' && k.ctrl) { if (cursor < buf.length) deleteRange(cursor, buf.length); return true }
	if (k.key === 'a' && k.ctrl) { move(0, k.shift); return true }
	if (k.key === 'e' && k.ctrl) { move(buf.length, k.shift); return true }
	if ((k.key === 'v' || k.key === 'y') && k.ctrl) { doPaste(); return true }
	if (k.key === '/' && k.ctrl && k.shift) { redo(); return true }
	if (k.key === '/' && k.ctrl) { undo(); return true }

	if (k.key === 'left') {
		if (k.alt) { move(wordLeft(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor - 1, true); return true }
		collapseOrMove(cursor - 1, 'start')
		return true
	}
	if (k.key === 'right') {
		if (k.alt) { move(wordRight(buf, cursor), k.shift); return true }
		if (k.shift) { move(cursor + 1, true); return true }
		collapseOrMove(cursor + 1, 'end')
		return true
	}

	if (k.key === 'up' || k.key === 'down') {
		const dir = k.key === 'up' ? -1 : 1
		if (k.alt) { move(dir === -1 ? 0 : buf.length, k.shift); return true }

		if (!k.shift) {
			const moved = verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!moved.atBoundary) {
				selAnchor = null
				cursor = moved.cursor
				goalCol = moved.goalCol
				return true
			}

			if (history.length > 0) {
				if (dir === -1) {
					if (historyIndex < 0) {
						historyDraft = buf
						historyIndex = history.length - 1
					} else if (historyIndex > 0) {
						historyIndex--
					} else {
						cursor = 0
						goalCol = null
						selAnchor = null
						return true
					}
					buf = history[historyIndex]!
					cursor = buf.length
					goalCol = null
					selAnchor = null
				} else {
					if (historyIndex < 0) {
						cursor = buf.length
						goalCol = null
						selAnchor = null
						return true
					}
					if (historyIndex < history.length - 1) {
						historyIndex++
						buf = history[historyIndex]!
					} else {
						historyIndex = -1
						buf = historyDraft
						historyDraft = ''
					}
					cursor = buf.length
					goalCol = null
					selAnchor = null
				}
				return true
			}

			cursor = dir === -1 ? 0 : buf.length
			goalCol = null
			selAnchor = null
		} else {
			if (selAnchor === null) selAnchor = cursor
			const moved = verticalMove(buf, contentWidth, cursor, goalCol, dir)
			if (!moved.atBoundary) {
				cursor = moved.cursor
				goalCol = moved.goalCol
			} else {
				cursor = dir === -1 ? 0 : buf.length
				goalCol = null
			}
		}
		return true
	}

	if (k.key === 'home') { move(0, k.shift); return true }
	if (k.key === 'end') { move(buf.length, k.shift); return true }

	if (k.char) {
		if (k.char.length === 1 && !selRange()) {
			typeChar(k.char)
		} else {
			const text = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char
			if (text) replaceSelection(text)
		}
		return true
	}

	return false
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface PromptRender {
	lines: string[]
	cursor: { rowOffset: number; col: number }
}

function buildPrompt(contentWidth: number): PromptRender {
	const layout = getLayout(buf, contentWidth)
	const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES)
	const { row: curRow, col: curCol } = cursorToRowCol(buf, cursor, contentWidth)
	const sel = selRange()

	let scrollTop = 0
	if (layout.lines.length > promptLines) {
		scrollTop = Math.min(curRow, layout.lines.length - promptLines)
		scrollTop = Math.max(scrollTop, curRow - promptLines + 1)
	}

	const lines: string[] = []
	for (let i = scrollTop; i < scrollTop + promptLines; i++) {
		const lineText = layout.lines[i] ?? ''
		const lineStart = layout.starts[i] ?? 0
		if (sel) {
			const lo = Math.max(0, sel.start - lineStart)
			const hi = Math.min(lineText.length, sel.end - lineStart)
			if (lo < hi && lo < lineText.length && hi > 0) {
				lines.push(` ${lineText.slice(0, lo)}\x1b[7m${lineText.slice(lo, hi)}\x1b[0m${lineText.slice(hi)}`)
			} else {
				lines.push(` ${lineText}`)
			}
		} else {
			lines.push(` ${lineText}`)
		}
	}

	// +1 because each rendered prompt line has a leading space prefix.
	return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol + 1 } }
}

function lineCount(width: number): number {
	return Math.min(getLayout(buf, width).lines.length, MAX_PROMPT_LINES)
}

export const prompt = {
	setHistory,
	pushHistory,
	text,
	cursorPos,
	setText,
	clear,
	reset,
	setRenderCallback,
	handleKey,
	buildPrompt,
	lineCount,
}
