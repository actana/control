// Read back the message a `fail`-taking helper reports.
//
// The script libraries take their exit path as a `fail`/`die` argument, which
// in production either exits the process or throws. Tests need a third
// behaviour — record the message and unwind — so this supplies one and hands
// the message back. Shared because asserting on *what* a helper says when it
// refuses is most of the value of having it say anything.

/**
 * Run `body(fail)` and return the message `fail` was called with, or `null` if
 * it never was.
 */
export function captureFailure(body) {
  let reported = null;
  const fail = (message) => {
    reported = message;
    throw new Error("failed");
  };
  try {
    body(fail);
  } catch {
    /* the throw above, or a genuine one — `reported` tells them apart */
  }
  return reported;
}
