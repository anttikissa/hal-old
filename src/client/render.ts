// Terminal renderer — frame building + differential repaint engine.
// See docs/terminal.md for the full contract.
//
// Architecture:
//   buildFrame() produces a flat string[] — one entry per terminal row.
//   draw() diffs it against prevLines[] and emits minimal escape sequences.
//   cursorRow always reflects the physical terminal row the cursor is on.
//
// The prompt can be multiline (shift-enter). The cursor can be on any
// prompt line, not just the last one. All cursor positioning goes through
// positionCursor() which updates cursorRow atomically.

import { visLen, wordWrap, clipVisual } from '../utils/strings.ts'
import { client } from '../client.ts'
import { prompt } from '../cli/prompt.ts'
import type { Entry, Tab } from '../client.ts'

const CSI = '\x1b['

let prevLines: string[] = []
let cursorRow = 0
let cursorCol = 1
let fullscreen = false
let peak = 0

const lineCountCache = new WeakMap<Tab, { entryCount: number; lineCount: number }>()

function resetRenderer(): void {
	prevLines = []
	cursorRow = 0
	cursorCol = 1
	fullscreen = false
	peak = 0
}

function formatTimestamp(ts?: number): string {
	if (ts === undefined) return ''
	const d = new Date(ts)
	const hh = String(d.getHours()).padStart(2, '0')
	const mm = String(d.getMinutes()).padStart(2, '0')
	const ss = String(d.getSeconds()).padStart(2, '0')
	const ms = String(d.getMilliseconds()).padStart(3, '0')
	return `\x1b[90m${hh}:${mm}:${ss}.${ms}\x1b[0m `
}

function renderEntry(entry: Entry, cols: number): string[] {
	const ts = formatTimestamp(entry.ts)
	let prefix: string
	switch (entry.type) {
		case 'input': prefix = `${ts}\x1b[36mYou:\x1b[0m `; break
		case 'assistant': prefix = `${ts}\x1b[33mAssistant:\x1b[0m `; break
		case 'info': prefix = ts ? `${ts}\x1b[90m` : '\x1b[90m'; break
	}
	const suffix = entry.type === 'info' ? '\x1b[0m' : ''
	const out: string[] = []
	for (const raw of (entry.text || '').split('\n')) {
		for (const wrapped of wordWrap(`${prefix}${raw}${suffix}`, cols)) out.push(wrapped)
		prefix = ts ? '                  ' : '  '
	}
	return out
}

function historyLineCount(tab: Tab): number {
	const cached = lineCountCache.get(tab)
	if (cached && cached.entryCount === tab.history.length) return cached.lineCount
	const cols = process.stdout.columns || 80
	let count = 0
	for (const entry of tab.history) count += renderEntry(entry, cols).length
	lineCountCache.set(tab, { entryCount: tab.history.length, lineCount: count })
	return count
}

function renderHistory(lines: string[], tab: Tab): void {
	const cols = process.stdout.columns || 80
	for (const entry of tab.history) {
		for (const line of renderEntry(entry, cols)) lines.push(line)
	}
}

function renderTabBar(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const tabs = client.state.tabs
	const active = client.state.activeTab
	const named = tabs.map((tab, i) =>
		i === active ? `\x1b[1m[${i + 1} ${tab.name}]\x1b[0m` : `\x1b[90m ${i + 1} ${tab.name} \x1b[0m`
	)
	if (visLen(named.join('')) <= cols) { lines.push(named.join('')); return }
	const padded = tabs.map((_, i) =>
		i === active ? `\x1b[1m[${i + 1}]\x1b[0m` : `\x1b[90m ${i + 1} \x1b[0m`
	)
	if (visLen(padded.join('')) <= cols) { lines.push(padded.join('')); return }
	const terse = tabs.map((_, i) =>
		i === active ? `\x1b[1m[${i + 1}]\x1b[0m` : `\x1b[90m${i + 1}\x1b[0m`
	)
	const terseStr = terse.join(' ')
	lines.push(visLen(terseStr) > cols ? clipVisual(terseStr, cols) : terseStr)
}

function renderStatusLine(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const mode = fullscreen ? 'full' : 'grow'
	const info = ` ${client.state.role} · pid ${process.pid} · ${mode} `
	const dashes = Math.max(0, cols - visLen(info) - 1)
	const left = Math.floor(dashes / 2)
	const right = dashes - left
	lines.push(`\x1b[90m${'─'.repeat(left)}${info}${'─'.repeat(right)}\x1b[0m`)
}

function renderPrompt(lines: string[]): void {
	const cols = process.stdout.columns || 80
	const built = prompt.buildPrompt(cols - 1)
	for (const line of built.lines) lines.push(line)
}

function chromeLines(): number {
	const cols = process.stdout.columns || 80
	return 2 + prompt.lineCount(cols - 1)
}

function buildFrame(): string[] {
	const rows = process.stdout.rows || 24
	const chrome = chromeLines()
	const tab = client.currentTab()
	const lines: string[] = []
	if (tab) renderHistory(lines, tab)
	if (tab) {
		const c = historyLineCount(tab)
		if (c > peak) peak = c
	}
	const contentHeight = Math.min(peak, Math.max(0, rows - chrome))
	const padding = Math.max(0, contentHeight - lines.length)
	for (let i = 0; i < padding; i++) lines.push('')
	if (lines.length + chrome > rows) fullscreen = true
	renderTabBar(lines)
	renderStatusLine(lines)
	renderPrompt(lines)
	return lines
}

function cursorTarget(frameLen: number): { row: number; col: number } {
	const cols = process.stdout.columns || 80
	const built = prompt.buildPrompt(cols - 1)
	const row = frameLen - built.lines.length + built.cursor.rowOffset
	return { row, col: built.cursor.col + 1 }
}

function moveCursor(from: number, to: number): string {
	const d = to - from
	if (d > 0) return `${CSI}${d}B`
	if (d < 0) return `${CSI}${-d}A`
	return ''
}

function positionCursor(from: number, target: { row: number; col: number }): string {
	cursorRow = target.row
	cursorCol = target.col
	return moveCursor(from, target.row) + `\r${CSI}${target.col}G${CSI}?25h`
}

function draw(force = false): void {
	const rows = process.stdout.rows || 24
	const lines = buildFrame()
	const cursor = cursorTarget(lines.length)

	if (force) {
		const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
		if (!fullscreen) {
			const up = Math.min(cursorRow, rows - 1)
			out.push('\r')
			if (up > 0) out.push(`${CSI}${up}A`)
			out.push(`${CSI}J`)
		} else {
			out.push(`${CSI}2J${CSI}H${CSI}3J`)
		}
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) out.push('\r\n')
			out.push(lines[i]!)
		}
		out.push(positionCursor(lines.length - 1, cursor))
		out.push(`${CSI}?2026l`)
		prevLines = lines
		process.stdout.write(out.join(''))
		return
	}

	if (fullscreen && lines.length < prevLines.length) return draw(true)

	let first = -1
	const max = Math.max(lines.length, prevLines.length)
	for (let i = 0; i < max; i++) {
		if ((lines[i] ?? '') !== (prevLines[i] ?? '')) { first = i; break }
	}
	if (first === -1) {
		if (cursorRow === cursor.row && cursorCol === cursor.col && prevLines.length > 0) return
		process.stdout.write(positionCursor(cursorRow, cursor))
		return
	}

	const out: string[] = [`${CSI}?2026h`, `${CSI}?25l`]
	const isAppend = first >= prevLines.length && prevLines.length > 0
	if (isAppend) {
		out.push(moveCursor(cursorRow, prevLines.length - 1))
		for (let i = first; i < lines.length; i++) out.push(`\r\n${CSI}2K${lines[i]!}`)
	} else {
		out.push(moveCursor(cursorRow, first))
		out.push('\r')
		for (let i = first; i < lines.length; i++) {
			if (i > first) out.push('\r\n')
			out.push(`${CSI}2K${lines[i]!}`)
		}
	}
	let lastWrittenRow = lines.length - 1
	if (lines.length < prevLines.length) {
		out.push(`\r\n${CSI}J`)
		lastWrittenRow = lines.length
	}
	out.push(positionCursor(lastWrittenRow, cursor))
	out.push(`${CSI}?2026l`)
	prevLines = lines
	process.stdout.write(out.join(''))
}

function clearFrame(): void {
	if (prevLines.length === 0) return
	const rows = process.stdout.rows || 24
	if (!fullscreen) {
		const up = Math.min(cursorRow, rows - 1)
		const out = ['\r']
		if (up > 0) out.push(`${CSI}${up}A`)
		out.push(`${CSI}J`)
		process.stdout.write(out.join(''))
	} else {
		process.stdout.write(`${CSI}2J${CSI}H${CSI}3J`)
	}
	prevLines = []
	cursorRow = 0
	cursorCol = 1
}

export const render = { draw, resetRenderer, clearFrame }
