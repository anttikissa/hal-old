// Terminal renderer — full repaint of our frame only.
// See docs/terminal.md for rules. Keep that file in sync with this one.
//
// After each render, the cursor sits on the last line (prompt).
// Next render: move up to the top of the frame, repaint downward.
// If the frame grows, extra \r\n at the bottom will scroll the terminal.
// We track how far we moved up so we always return to the right place.

const ESC = "\x1b"
const SYNC_START = `${ESC}[?2026h`
const SYNC_END = `${ESC}[?2026l`
const CLEAR_LINE = `${ESC}[2K`
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
function moveUp(n: number): string {
	return n > 0 ? `${ESC}[${n}A` : ""
}

let prevLineCount = 0
let maxContentHeight = 0

export interface RenderMetrics {
	contentLines: number
	padding: number
	totalLines: number
	maxContentHeight: number
}

export let debugRender: RenderMetrics = {
	contentLines: 0,
	padding: 0,
	totalLines: 0,
	maxContentHeight: 0,
}

export interface RenderState {
	blocks: string[]
	allTabBlockCounts: number[]
	tabs: string
	separator: string
	prompt: string
	cursorCol: number
}

function countLines(text: string): number {
	return text.split('\n').length
}

function getActualContentLines(blocks: string[]): string[] {
	const lines: string[] = []
	for (const block of blocks) {
		for (const line of block.split("\n")) {
			lines.push(line)
		}
	}
	return lines
}

export function getRenderMetrics(
	state: Pick<RenderState, 'blocks' | 'allTabBlockCounts' | 'tabs' | 'prompt'>,
	separatorLineCount: number,
): RenderMetrics {
	maxContentHeight = 0
	for (const count of state.allTabBlockCounts) {
		if (count > maxContentHeight) maxContentHeight = count
	}

	const contentLines = getActualContentLines(state.blocks).length
	const padding = Math.max(0, maxContentHeight - contentLines)
	return {
		contentLines,
		padding,
		totalLines:
			contentLines +
			padding +
			countLines(state.tabs) +
			separatorLineCount +
			countLines(state.prompt),
		maxContentHeight,
	}
}

function computeLines(state: RenderState): string[] {
	const actualContentLines = getActualContentLines(state.blocks)
	const metrics = getRenderMetrics(state, countLines(state.separator))
	const contentLines = [
		...Array.from({ length: metrics.padding }, () => ''),
		...actualContentLines,
	]

	debugRender = metrics

	// Keep blank space above short tabs so the visible lines stay near the prompt
	// when another tab has made the shared frame taller than this terminal.
	contentLines.push(...state.tabs.split('\n'))
	contentLines.push(...state.separator.split('\n'))
	contentLines.push(...state.prompt.split('\n'))
	return contentLines
}

export function render(state: RenderState): void {
	const lines = computeLines(state)
	const out: string[] = []
	const screenRows = process.stdout.rows ?? lines.length

	// Only render the bottom `screenRows` lines (the visible viewport).
	// Writing more than the viewport height pushes duplicates into scrollback.
	const visibleStart = Math.max(0, lines.length - screenRows)
	const visible = lines.slice(visibleStart)
	const prevVisible = Math.min(prevLineCount, screenRows)

	out.push(SYNC_START)
	out.push(HIDE_CURSOR)

	if (prevLineCount === 0) {
		for (let i = 0; i < visible.length; i++) {
			out.push(CLEAR_LINE + visible[i]!)
			if (i < visible.length - 1) out.push("\r\n")
		}
	} else {
		// Move up to top of visible area (not full frame — that's in scrollback)
		out.push("\r" + moveUp(prevVisible - 1))

		for (let i = 0; i < visible.length; i++) {
			out.push(CLEAR_LINE + visible[i]!)
			if (i < visible.length - 1) out.push("\r\n")
		}

		// Clear leftover lines if visible area shrank
		if (prevVisible > visible.length) {
			for (let i = visible.length; i < prevVisible; i++) {
				out.push("\r\n" + CLEAR_LINE)
			}
			out.push(moveUp(prevVisible - visible.length))
		}
	}

	prevLineCount = lines.length

	// Cursor on prompt line at the right column
	out.push(`\r${ESC}[${state.cursorCol}C`)
	out.push(SHOW_CURSOR)
	out.push(SYNC_END)

	process.stdout.write(out.join(""))
}

export function clearFrame(): void {
	if (prevLineCount === 0) return
	// Move up to the top of the visible area (not full frame), then clear down.
	const rows = process.stdout.rows ?? prevLineCount
	const visibleLines = Math.min(prevLineCount, rows)
	process.stdout.write(`\r${moveUp(visibleLines - 1)}${ESC}[J`)
	prevLineCount = 0
	maxContentHeight = 0
	debugRender = {
		contentLines: 0,
		padding: 0,
		totalLines: 0,
		maxContentHeight: 0,
	}
}
