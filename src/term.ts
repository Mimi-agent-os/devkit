/** Plain terminal output: one line at a time, colour only on a TTY without NO_COLOR. */

const colour = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const ansi =
    (open: number, close: number) =>
    (s: string): string =>
        colour ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const paint = {
    bold: ansi(1, 22),
    dim: ansi(2, 22),
    red: ansi(31, 39),
    green: ansi(32, 39),
    yellow: ansi(33, 39),
};

export function out(line: string): void {
    process.stdout.write(`${line}\n`);
}

/** A labelled line, as every command prints its summary: `model    Qwen3-32B: ...`. */
export function row(label: string, text: string): void {
    out(`${paint.dim(label.padEnd(8))} ${text}`);
}

/** A command's failure: cli.ts prints the message and exits with the code (1 failed, 2 usage, 3 environment). */
export class DevError extends Error {
    readonly code: 1 | 2 | 3;

    constructor(message: string, code: 1 | 2 | 3) {
        super(message);
        this.code = code;
    }
}
