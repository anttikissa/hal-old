// CLI -- terminal input handling. See docs/terminal.md for rules.
//
// This layer is intentionally thin:
//   raw stdin bytes -> keys.parseKeys() -> KeyEvent[]
//   KeyEvent -> prompt editor OR app-level keybinding
//   state change -> render.draw()

import { client } from '../client.ts'
import { render } from './render.ts'
import { keys } from '../cli/keys.ts'
import { prompt } from '../cli/prompt.ts'
import { clipboard } from '../cli/clipboard.ts'
import type { KeyEvent } from '../cli/keys.ts'
import { perf } from '../perf.ts'

const RESTART_CODE = 100
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

function syncPromptToClient(): void {
	client.setPrompt(prompt.text(), prompt.cursorPos())
}

function handleAppKey(k: KeyEvent): boolean {
	if (k.key === 'r' && k.ctrl) {
		render.clearFrame()
		cleanupTerminal()
		process.exit(RESTART_CODE)
	}
	if (k.key === 'c' && k.ctrl) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	if (k.key === 'd' && k.ctrl && !prompt.text()) {
		cleanupTerminal()
		process.stdout.write('\r\n')
		process.exit(0)
	}
	if (k.key === 'l' && k.ctrl) { draw(true); return true }
	if (k.key === 't' && k.ctrl) {
		if (client.state.tabs.length < 40) client.sendCommand('open')
		return true
	}
	if (k.key === 'w' && k.ctrl) {
		if (client.state.tabs.length > 1) client.sendCommand('close')
		return true
	}
	if (k.key === 'n' && k.ctrl) { client.nextTab(); return true }
	if (k.key === 'p' && k.ctrl) { client.prevTab(); return true }
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
	client.setOnChange((force) => draw(force))
	prompt.setRenderCallback(() => {
		syncPromptToClient()
		draw()
	})
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
		const contentWidth = cols - 1
		for (const k of keys.parseKeys(data.toString('utf-8'))) {
			if (handleAppKey(k)) continue
			if (prompt.handleKey(k, contentWidth)) {
				syncPromptToClient()
				draw()
			}
		}
	})

	perf.mark('Client ready to read input')
}

export const cli = { startCli }
