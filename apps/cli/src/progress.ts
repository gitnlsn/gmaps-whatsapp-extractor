import type { Progress } from "@leads/core";

/**
 * Two ways to report the same run.
 *
 * The core used to print directly, which meant the only progress signal a
 * parent process could get was a terminal redraw stream it had to un-mangle
 * (`collapseCarriageReturns` in the dashboard's job runner exists purely for
 * that). Now the core emits events and the front end decides what they look
 * like: carriage returns for a human, one JSON object per line for a machine.
 */

/** Reproduces the output the CLI has always had, `\r` redraws included. */
export function consoleProgress(): Progress {
  let total: number | undefined;
  let dirty = false; // a `\r` line is pending and needs a newline before anything else

  const clear = () => {
    if (dirty) {
      process.stdout.write("\n");
      dirty = false;
    }
  };

  return {
    stage(_key, label, t) {
      clear();
      total = t;
      console.log(`\n${label}${t ? ` (${t.toLocaleString("pt-BR")})` : ""}`);
    },
    tick(done, note) {
      const of = total ? `/${total.toLocaleString("pt-BR")}` : "";
      process.stdout.write(
        `\r  ${done.toLocaleString("pt-BR")}${of}${note ? `  ${note}` : ""}   `
      );
      dirty = true;
    },
    info(message) {
      clear();
      console.log(message);
    },
    warn(message) {
      clear();
      console.warn(`  ${message}`);
    },
    finish(_key, note) {
      clear();
      total = undefined;
      if (note) console.log(`  ${note}`);
    },
  };
}

/**
 * One JSON object per line on stdout. Written for a parent process that wants
 * structured stage transitions rather than a screen recording.
 */
export function ndjsonProgress(): Progress {
  const emit = (event: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  };

  return {
    stage: (key, label, total) => emit({ t: "stage", key, label, total }),
    tick: (done, note) => emit({ t: "tick", done, note }),
    info: (message) => emit({ t: "info", message }),
    warn: (message) => emit({ t: "warn", message }),
    finish: (key, note) => emit({ t: "finish", key, note }),
  };
}

/** `--json` anywhere in argv switches the reporter. */
export function pickProgress(argv: string[] = process.argv): Progress {
  return argv.includes("--json") ? ndjsonProgress() : consoleProgress();
}
