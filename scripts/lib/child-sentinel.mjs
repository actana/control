// Waiting on a spawned process to say it is ready.
//
// Every process-spawning test in `scripts/` asks the same question of its
// child: did it print its readiness marker before it died or ran out of time,
// and what did it say on the way? The Core smokes want that for
// `@@AC_CORE_LISTENING@@`, the Panel e2e for `@@AC_CORE_LISTENING@@`, and the
// difference between them is a string and what else they pick off each line.
//
// Keeping one waiter means the failure behaviour is one behaviour: the child's
// output is always mirrored into `observer.logLines` for triage, an early exit
// always rejects with the code and signal, and a timeout always names the
// marker that never came.

import * as readline from "node:readline";

/**
 * Resolve when `child` prints `sentinel`; reject if it exits, errors, or runs
 * out of time first.
 *
 * `observer.logLines` collects every line, tagged with the stream it came from.
 * `onLine(raw)` is called for each line before the sentinel check, which is how
 * a caller picks other things out of the output (the Core's registration
 * blob, its bad-log tags) without a second reader on the same stream.
 * `subject` names the child in error messages.
 */
export function waitForSentinel(child, { sentinel, timeoutMs, observer, onLine, subject = "child" }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const deadline = setTimeout(() => {
      settle(() => reject(new Error(`did not emit ${sentinel} within ${timeoutMs}ms`)));
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      settle(() =>
        reject(new Error(`${subject} exited (code=${code} signal=${signal}) before ${sentinel}`)),
      );
    });
    child.on("error", (err) => {
      settle(() => reject(new Error(`${subject} spawn error: ${err.message}`)));
    });

    const handleLine = (source, raw) => {
      observer.logLines.push(`[${source}] ${raw}`);
      onLine?.(raw);
      if (raw.includes(sentinel)) settle(() => resolve());
    };
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on("line", (l) => handleLine("stdout", l));
    }
    if (child.stderr) {
      readline.createInterface({ input: child.stderr }).on("line", (l) => handleLine("stderr", l));
    }
  });
}
