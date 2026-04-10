/**
 * Interactive terminal prompts — arrow-key selectable lists and confirmations.
 */

// ANSI escape codes
const ESC = "\x1B";
const CLEAR_LINE = `${ESC}[2K`;
const MOVE_UP = (n: number) => `${ESC}[${n}A`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;
const BOLD = `${ESC}[1m`;

export interface SelectOption<T> {
  label: string;
  value: T;
  description?: string;
}

/**
 * Render a selectable list. Arrow keys to navigate, Enter to confirm.
 *
 * ```
 *   Which LLM CLI would you like to install?
 *
 *   ❯ Claude Code  (Anthropic)
 *     Codex CLI    (OpenAI)
 *     Both
 *     Skip for now
 * ```
 */
export function select<T>(title: string, options: SelectOption<T>[]): Promise<T> {
  return new Promise((resolve) => {
    let cursor = 0;
    const { stdin, stdout } = process;

    if (!stdin.isTTY) {
      // Non-interactive fallback: pick first option
      resolve(options[0]!.value);
      return;
    }

    function render() {
      // Move up to overwrite previous render (skip on first paint)
      if (rendered) {
        stdout.write(MOVE_UP(options.length));
      }

      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const active = i === cursor;
        const pointer = active ? `${CYAN}${BOLD}❯${RESET}` : " ";
        const label = active ? `${BOLD}${opt.label}${RESET}` : `${DIM}${opt.label}${RESET}`;
        const desc = opt.description ? `  ${DIM}${opt.description}${RESET}` : "";
        stdout.write(`${CLEAR_LINE}  ${pointer} ${label}${desc}\n`);
      }
    }

    let rendered = false;

    // Print title
    stdout.write(`\n  ${title}\n\n`);
    stdout.write(HIDE_CURSOR);

    render();
    rendered = true;

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function onData(key: string) {
      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        stdout.write(SHOW_CURSOR);
        process.exit(0);
      }

      // Up arrow or k
      if (key === `${ESC}[A` || key === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
        return;
      }

      // Down arrow or j
      if (key === `${ESC}[B` || key === "j") {
        cursor = (cursor + 1) % options.length;
        render();
        return;
      }

      // Enter or Space
      if (key === "\r" || key === " ") {
        cleanup();
        stdout.write(SHOW_CURSOR);
        // Show what was selected
        const selected = options[cursor]!;
        stdout.write(`\n  ${DIM}Selected:${RESET} ${BOLD}${selected.label}${RESET}\n`);
        resolve(selected.value);
        return;
      }
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    }

    stdin.on("data", onData);
  });
}

/**
 * Yes/No confirmation with arrow-key selection.
 *
 * ```
 *   gh CLI is required. Install it now?
 *
 *   ❯ Yes
 *     No
 * ```
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const options: SelectOption<boolean>[] = defaultYes
    ? [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ]
    : [
        { label: "No", value: false },
        { label: "Yes", value: true },
      ];

  return select(question, options);
}
