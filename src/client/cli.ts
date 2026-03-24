// CLI — terminal input handling. See docs/terminal.md for rules.
//
// This layer is intentionally thin:
//   raw stdin bytes → keys.parseKeys() → KeyEvent[]
//   KeyEvent → prompt editor OR app-level keybinding
//   state change → render.draw()
//
// App keybindings (Ctrl-R, Ctrl-C, Ctrl-T, etc.) are handled here.
// Text editing keybindings live in prompt.ts.

import { client } from '../client.ts'
import { render } from './render.ts'
import { keys } from '../cli/keys.ts'
import { prompt } from '../cli/prompt.ts'
import { clipboard } from '../cli/clipboard.ts'
import type { KeyEvent } from '../cli/keys.ts'
import { perf } from '../perf.ts'

const RESTART_CODE = 100

// ── Kitty keyboard protocol ─────────────────────────────────────────────────
// Ghostty/Kitty/iTerm intercept Cmd+C/X/V at the OS level unless the app
// opts into the Kitty keyboard protocol. Mode 19 = disambiguate(1) +
// report events(2) + report all keys as escapes(16). This tells the
// terminal to send ALL keys to the app.
const KITTY_TERMS = /^(kitty|ghostty|iTerm\.app)$/
const useKitty = KITTY_TERMS.test(process.env.TERM_PROGRAM ?? '')
const KITTY_ON = '\x1b[>19u'
const KITTY_OFF = '\x1b[<u'
const BRACKETED_PASTE_ON = '\x1b[?2004h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

let terminalCleaned = false

function draw(force = false): void {
	render.draw(force)
}

// Restore terminal state before exiting. Must be called on ALL exit paths
// or the terminal will be left in raw/kitty mode.
function cleanupTerminal(): void {
	if (terminalCleaned) return
	terminalCleaned = true
	if (useKitty) process.stdout.write(KITTY_OFF)
	process.stdout.write(BRACKETED_PASTE_OFF)
	if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

function submit(): void {
	const text = prompt.text().trim()
	if (!text) return
	prompt.pushHistory(text)
	client.sendCommand('prompt', text)
	prompt.clear()
}

// Keep client.state in sync with prompt state (for rendering).
function syncPromptToClient(): void {
	client.setPrompt(prompt.text(), prompt.cursorPos())
}

// ── App-level keybindings ────────────────────────────────────────────────────
// These are NOT text editing keys — they control the app itself.

function handleAppKey(k: KeyEvent): boolean {
	// Ctrl-R: restart. Clear the frame so the new process paints fresh.
	if (k.key === 'r' && k.ctrl) {
		render.clearFrame()
		cleanupTerminal()
		process.exit(RESTART_CODE)
	}
	// Ctrl-C: quit
	if (k.key === 'c' && k.ctrl) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	// Ctrl-D: quit if prompt empty, else let prompt handle (delete forward)
	if (k.key === 'd' && k.ctrl && !prompt.text()) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	// Ctrl-L: force redraw
	if (k.key === 'l' && k.ctrl) { draw(true); return true }
	// Ctrl-T: new tab (hard cap at 40)
	if (k.key === 't' && k.ctrl) {
		if (client.state.tabs.length < 40) client.sendCommand('open')
		return true
	}
	// Ctrl-W: close tab
	if (k.key === 'w' && k.ctrl) {
		if (client.state.tabs.length > 1) client.sendCommand('close')
		return true
	}
	// Ctrl-N / Ctrl-P: tab switching
	if (k.key === 'n' && k.ctrl) { client.nextTab(); return true }
	if (k.key === 'p' && k.ctrl) { client.prevTab(); return true }
	// Enter: submit (blocked while image paste is resolving)
	if (k.key === 'enter' && !k.shift) {
		if (clipboard.hasPendingPastes()) return true
		submit()
		syncPromptToClient()
		draw()
		return true
	}
	return false
}

function startCli(signal: AbortSignal): void {
	// Wire client state changes to terminal repaint.
	client.setOnChange((force) => draw(force))

	// Wire prompt to trigger repaint on async paste resolve.
	prompt.setRenderCallback(() => {
		syncPromptToClient()
		draw()
	})

	// Bootstrap client (replays IPC log, starts tailing events).
	client.startClient(signal)

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true)
		process.stdin.resume()
		if (useKitty) process.stdout.write(KITTY_ON)
		process.stdout.write(BRACKETED_PASTE_ON)
	}
	process.on('exit', cleanupTerminal)

	draw()
	perf.mark('First render done')
	process.stdout.on('resize', () => draw(true))

	process.stdin.on('data', (data: Buffer) => {
		const cols = process.stdout.columns || 80
		// Prompt content area = terminal width minus the " " prefix
		const contentWidth = cols - 1

		for (const k of keys.parseKeys(data.toString('utf-8'))) {
			// App keybindings first
			if (handleAppKey(k)) continue
			// Then prompt editing
			if (prompt.handleKey(k, contentWidth)) {
				syncPromptToClient()
				draw()
			}
		}
	})

	perf.mark('Client ready to read input')
}

export const cli = { startCli }
