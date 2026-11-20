import type { Runner } from '@workerdeck/core'

// A person answered, by a message or on a card, so the agent no longer waits on one: the label keeps its text and
// loses the flag.
export function answerWaiting(runner: Runner): void {
  const label = runner.info().statusLabel
  if (label?.waitingOn !== 'human' || !runner.setStatusLabel) {
    return
  }
  runner.setStatusLabel({ text: label.text, ...(label.emoji ? { emoji: label.emoji } : {}) })
}
