# Prompt delivery is a Core responsibility

A Session can be started with text already in hand. The Panel's Ship, Sync and Create-PR gestures do it today; [#129](https://github.com/actana/control/issues/129)'s SDK and CLI will do it as `session start --prompt`, and an automation that has to type its own first message into a terminal is not an SDK. So the question this record settles is narrow and old: **between spawning a harness and that harness having the operator's first sentence, who is responsible for the gap, and what do they actually do in it?**

Until now the answer was a timer. `pty-manager.ts` armed `450 ms` on the first byte of output, wrote the prompt, waited another `150 ms`, and wrote `\r`. It is the obvious first implementation and it was wrong in three separate ways at once, each of them *observed* on a real harness rather than reasoned about:

1. **Claude Code's folder-trust dialog highlights `No, exit`.** A carriage return arriving into it does not fall through — it ends the harness, before the session has done anything at all. Auto mode on its own survives, because nothing types into the dialog. A starting prompt on its own survives, because on a folder the harness already trusts there is no dialog in the way. The two together died in under three seconds, every time, and the operator saw a Session that had "finished" without a single line of output.
2. **Long text is a paste, and a paste absorbs the `\r`.** Past a certain length the harness stops treating the write as typing and renders `[Pasted text #1 +N lines]` instead — with the prompt sitting in the composer, unsent, and the `150 ms` carriage return consumed by the paste it rode in behind. The prompt was not lost so much as never submitted, which looks identical from the grid.
3. **`450 ms` is not "the TUI has finished painting"** on any machine that is busy, and it is far longer than necessary on one that is not. It was a guess about a distribution, applied as if it were a fact about one process.

The fix is not a fourth number. It is that **the Core watches the harness and reacts to it**, and that this happens in the Core rather than in whoever asked for the session.

## The decisions

**D1 — Prompt delivery belongs to the Core, and a client sends text and no timing.** A Core client — the Panel, the `actana` CLI, an SDK automation — puts a string in `initialInput` and is finished. It does not know which harness is on the other end, what that harness paints while it boots, whether it opens a dialog first, or how long any of it takes, and *it must not be given a way to express an opinion about those things*. This is [CONTEXT.md](../../CONTEXT.md)'s existing rule about harnesses applied to the one place that was quietly breaking it: differences between harnesses live inside the Core process, never in a client. The practical test is that three clients written by three people behave identically on the same machine, and the only way that is true is if none of them is doing the timing.

**D2 — Delivery is a sequence driven by the harness's own output, not a schedule.** `packages/core/src/harness-prompt-delivery.ts` is fed every chunk the PTY produces and decides what to do from what it sees: wait for the painting to stop, answer whatever is in the way, write the prompt, then submit it. Nothing in it is a delay chosen in advance and hoped over. Every number it holds is either a *gap* being measured or a *floor* being enforced, and the distinction is the point of the module.

**D3 — Quiet is a gap between substantive redraws, not silence.** Silence never arrives: a harness spinner redraws forever, so "wait until output stops" is a wait that never ends and any deadline attached to it is the old 450 ms with more steps. What settles instead is the *screen*, and the signal for that is a gap between redraws that say something new. `redrawSignature` normalises each chunk — escape sequences dropped, spinner glyph dropped, every run of digits flattened to one `0` — and a chunk whose signature has been seen recently is a **tick**: proof the harness is alive, and no evidence at all that it is still working. Only a chunk that says something new is a **paint**, and only a paint restarts the quiet window. The digit rule is what makes this hold: an elapsed timer, a token meter and a percentage all move on their own, and a detector that counted them as painting would be a detector that never fired. A harness that boots in 200 ms waits 200 ms; one that boots in eight seconds gets eight seconds; neither number is written down anywhere.

**D3a — A settled screen is not a listening harness; the composer has to be visible.** Added by [#229](https://github.com/actana/control/issues/229). D3 measures when the harness stopped *painting*, and treats that as permission to type. On opencode 1.18.18 it is not: the TUI opens the alternate screen and paints two four-kilobyte frames of pure whitespace inside the first 1.5 s, then says **nothing at all for four and a half seconds** while the opencode server behind it starts, and only then paints its composer and attaches the reader that will accept a keystroke. The quiet gap elapses squarely inside that hole; the write goes into a terminal still in cooked mode and is discarded when the TUI enters raw mode. Captured live: text written at 1.85 s never appeared and no turn started, while the same text written after the composer frame echoed and ran. So a harness may declare what its composer looks like, and until one of those markers is on screen the Core types nothing. `HARNESS_READINESS` is that declaration — a per-harness table with an **empty default**, exactly like `BLOCKING_DIALOGS` and for exactly D7's reason. The only entry is opencode's `Ask anything`, which is its composer's own placeholder in both the TUI's rendering and its localised string table. `claude-code`, `codex` and `cursor-cli` have no entry and are therefore unchanged, which matters because a cursor-cli start prompt was verified working on the very build #229 was filed against. A harness that reworded its placeholder falls through to D8 and gets its prompt late rather than never.


**D4 — A blocking dialog is answered by its own option number, never by Enter.** The Core reads the numbered menu off the settled screen, finds the option whose *label* means "go ahead", and presses that option's number. Nothing infers the answer from position, and nothing presses Enter to "get past" a dialog, because on the dialog this ADR exists for, Enter *is* the failure. Selecting by label rather than by digit also means the record does not have to hard-code which number is which: the observed default is `1. No, exit`, a vendor is free to reorder its own menu in the next release, and a change that would silently invert a hard-coded `2` merely moves which key this module presses.

**D4a — The one Enter this module sends is a confirm, and it is justified by the highlight or it is not sent.** Some harnesses act on the digit; others move a selection and wait to be confirmed. Both look identical from the outside — the same dialog is still on screen after the digit went out — and so does a third case that must never be confirmed: *the harness did not take the digit at all*. The evidence that separates them is on screen. If the highlight has moved onto the affirmative option, and onto nothing else, then Enter means "confirm that option" and it goes out. If the highlight is still on `No, exit`, if nothing is highlighted, or if several rows are, the Core sends nothing and holds — the dialog stays visible, the operator is one keystroke away, and the backstop abandons delivery. An Enter that cannot be justified from the screen is exactly the keystroke this record exists to prevent, and "the selection must be on the safe option by now" is an assumption, not a justification.

**D4b — The screen the Core matches against is the screen the harness is showing.** The buffer that dialogs are read from is an approximation of a terminal, and the property it must have is that it stops believing in a dialog that is no longer displayed. It is therefore reset by a full-screen clear (`ESC[2J`/`ESC[3J`, the alternate-screen switches, or a cursor-home followed by an erase-below) and not only by the Core's own keystrokes. Without that, the only actor who can retire a dialog is the Core itself, and the two cases that matters for are the two most likely in practice: an operator who answers the dialog by hand — D5's promised recovery, which otherwise never recovers — and a harness that dismisses its own dialog inside the quiet gap, after which a stale menu parses and a menu digit is typed into a healthy composer. A bare erase-below is deliberately *not* treated as a clear: forgetting a dialog that is still up is the worse error of the two, and this module's whole asymmetry is that it would rather not deliver than type into a menu.

**D5 — A dialog the Core cannot read is not answered, and delivery is abandoned rather than guessed.** A menu qualifies for D4 only if it offers exactly one affirmative option *and* at least one that refuses; anything else — an unparseable layout, two plausible yeses, a paragraph that merely contains the word "trust" — yields no answer. In that case the Core types **nothing at all**, holds until its backstop, and gives up on delivering the prompt with the dialog still on screen. This is the deliberate asymmetry: a session parked on a visible dialog is one keystroke from an operator being fine, and a session that answered a dialog wrongly is gone. Abandoning is loud (`pty.prompt-delivery.abandoned`) and it never kills the PTY.

**D6 — The carriage return is a separate keystroke, sent after a pause that scales with the length of the prompt.** Two conditions, both required: the pause floor, `150 ms + 2 ms per character` capped at three seconds, and the echo having gone quiet by D3's rule. The floor exists because the length of the text is what decides whether the harness treats the write as typing or as a paste, and the quiet condition exists because what actually has to finish is the harness rendering `[Pasted text #1 …]`. Either alone is a guess; together they are a measurement with a lower bound.

**D6a — The carriage return is justified by the prompt being on screen, or the prompt is typed again.** The other half of #229, and the same shape of argument as D4a: the evidence that a keystroke is worth sending is on the screen or it does not exist. A harness in `HARNESS_READINESS` with `confirmEcho` must show the prompt back before its `\r` goes out; if the composer is empty when the submit pause and the quiet gap have both elapsed, the write was swallowed and submitting would send a carriage return into nothing and log a `delivered` that did not happen. Delivery returns to `settling` instead — which re-imposes the whole gate, a fresh paint and D3a's composer marker included, rather than hammering the same write at a TUI that is demonstrably not listening — and types the prompt again, up to `maxPromptWrites`. Two things keep this from becoming its own bug. The echo test is deliberately generous: a short leading probe compared with whitespace *and the composer's own box-drawing glyphs* removed, so a wrapped or bordered echo still counts, and a `[Pasted text #1 …]` placeholder counts as the prompt having landed — because a false "it arrived" costs exactly what today already costs, while a false "it did not" types the prompt twice. And past the backstop, or past the write budget, the `\r` goes out regardless (D8): text typed and never submitted is its own failure.


**D7 — Harness differences live in one table with a default, not in a switch.** `BLOCKING_DIALOGS` is a list of dialog specifications, each optionally scoped to named harnesses and applying to all of them when it is not. **Both of today's entries are scoped to `claude-code`**, because both are transcriptions of that harness's screens: the wording, the labels, and the fact that the highlighted default exits were all read off Claude Code. Leaving them unscoped would have applied Claude Code's answers to `codex`, `cursor-cli` and `opencode` — pressing a digit into another vendor's menu on the strength of the word "trust" appearing above a numbered list, which is the guess D5 refuses. The unscoped default stays available for a dialog genuinely observed across harnesses; what a harness with no entry gets is D3, D6 and D8, and no keystrokes it did not earn. `HARNESS_READINESS` (D3a, D6a) and `HARNESS_PROMPT_DELIVERY_PROFILES` are the matching tables for readiness and for timing; the timing one is **deliberately empty**: no harness observed so far needs different numbers, and a profile table pre-populated with guesses is worse than no table. Both are keyed by harness id with a working default for ids that are not in them, which is what CONTEXT.md's "the family is open" requires — a harness nobody has written yet gets D3 and D6 and simply has no dialogs the Core knows about.

**D8 — There is a backstop, it is a ceiling and not a schedule, and one thing overrides it.** If quiet never arrives, the prompt is still delivered after `15 s`, because a prompt delivered a beat early is recoverable and a prompt never delivered is the bug this ADR is about. The exception is D5's: if a blocking dialog is on screen when the backstop fires, delivery is abandoned instead, because typing a paragraph into a menu whose highlighted default exits the harness is the one outcome worse than not delivering. If the prompt has already been written when the backstop fires, the carriage return goes out regardless of what the screen is doing — leaving text typed-but-unsent is its own failure.

**D9 — The delivered prompt stays input data and never becomes argv.** Unchanged from before this record and restated because it is load-bearing: `initialInput` is written to the PTY exactly as a human typing would, and does not pass through `pty-spawn-policy`'s argv allow-list. The allow-list exists to keep a briefly-compromised client from putting arbitrary tokens on a harness command line; routing free text through it to save this module would dismantle the reason it exists.

## Considered Options

- **Tune the 450 ms (rejected).** The cheapest change and the one the issue explicitly forbids, correctly. No constant answers the trust dialog, and no constant makes a paste-absorbed `\r` arrive; two of the three observed failures are not timing bugs at all, and the third is not a bug about *which* number.
- **Put the sequence in the SDK, and let each client drive it (rejected, D1).** Superficially attractive because the SDK is the new home for client-side session logic ([#129](https://github.com/actana/control/issues/129) D2) and a `session.deliverPrompt()` would sit naturally beside `session.send()`. Rejected because it puts harness knowledge in the client, which CONTEXT.md forbids and for a concrete reason: the Panel, the CLI and an automation would each be free to get it slightly differently wrong, and the operator's bug report would name the client rather than the harness. It also puts the decision on the wrong side of the wire — the client is watching a stream that has already crossed a network with its own buffering, and the Core is reading the PTY directly.
- **Pass the prompt on the harness command line instead of typing it (rejected, D9).** `claude "…"`, `codex exec "…"`. Genuinely tempting: no dialog race, no paste, no `\r`. Rejected on two counts. It is not uniform — the flag, the quoting and whether the harness stays interactive afterwards differ per harness, which is exactly the per-harness knowledge this ADR is centralising rather than spreading into `pty-spawn-policy` — and it would require free operator text through the argv allow-list, which is a security boundary this repository has deliberately kept narrow.
- **Write the harness's own trust configuration before spawning (rejected for now).** Pre-marking the project folder as trusted in the vendor's config would remove the folder-trust dialog rather than answering it. Rejected because it is a larger act than it looks — editing a vendor's config file on the operator's behalf, in a format that is theirs to change, granting a standing permission the operator never gave in a place they will not think to look — and because it does not cover the second dialog: the bypass-permissions warning behind `--dangerously-skip-permissions` is a per-launch confirmation and no config file dismisses it. Worth revisiting for the trust dialog alone if the vendors document the setting; it does not replace D4.
- **Drive delivery from the harness's lifecycle hooks (rejected).** The Core already installs hooks and receives events from them ([issue 84](https://github.com/actana/control/issues/84)), so a "harness is ready" event would be a cleaner signal than reading the screen. Rejected because the hooks do not fire early enough or uniformly enough: they report a *turn*, and the moment being waited for here is before any turn exists, on a screen that may be a modal dialog belonging to the harness's own startup. It is also the wrong dependency direction for a boot problem — hooks are installed into the workspace and a harness that will not start is a harness whose hooks have not run.
- **Have the Panel show the dialog to the operator and answer nothing automatically (rejected).** Honest, and it is what D5 falls back to. Rejected as the *default* because it makes every unattended session — the CLI's `session start`, an SDK automation, a scheduled run — require a human at exactly the moment nobody is watching, which is the property a Core exists to have.

## Consequences

- **`packages/core/src/harness-prompt-delivery.ts` is where a lost prompt is debugged**, and it emits one log line per phase (`settled`, `dialog`, `dialog-unreadable`, `delivered`, `abandoned`) carrying the task id, the harness, and how long it waited. A report of "my prompt vanished" is now answerable from the Core's log rather than from a guess.
- **`pty-manager.ts` no longer contains any prompt timing.** The three constants are gone rather than tuned, and the spawn path's only remaining involvement is constructing the delivery, feeding it `onData`, and disposing it on exit.
- **No client changed, and that is the result.** The Panel already sent `initialInput` as data with no timing of its own, so the Panel is behaviourally identical and its diff in this change is empty. The SDK and CLI built in [#129](https://github.com/actana/control/issues/129) inherit the behaviour by doing nothing.
- **A harness that changes its dialog wording will stop being recognised, and will fail safely.** Delivery is abandoned with the dialog on screen and a log line naming it, rather than the prompt being typed into a menu. The repair is a line in `BLOCKING_DIALOGS`, in the Core, shipped to every client at once.
- **Delivery is now testable without sleeping.** The sequence takes an injected clock, so `harness-prompt-delivery.test.ts` asserts *when* each keystroke goes out relative to what the harness printed — including the two failures that motivated this record: an Enter into the trust dialog, and a `\r` written before a paste settled.
- **A dialog the Core answered but cannot see confirmed is a new held state**, logged as `pty.prompt-delivery.dialog-unconfirmed` (D4a). It is the same trade as D5 one step later: the digit went out, the screen does not justify the Enter behind it, and the session is left on a visible dialog rather than on a guess.
- **A prompt that a harness swallowed is now re-typed rather than reported delivered** (D3a, D6a), and the two new log lines say which is happening: `pty.prompt-delivery.waiting-for-composer` while the Core holds, `pty.prompt-delivery.prompt-swallowed` when a write left no echo. A Session that used to start empty and silent now starts late and correct.
- **The opencode boot is in the suite as bytes, not as a description.** `packages/core/src/__tests__/fixtures/opencode-1.18.18-{boot,composer}.txt` are a live PTY capture, and the delivery test replays them at their captured timings — the 4.4 s hole included. Its boot was measured at between 3.4 s and 6.9 s across runs on one machine, which is the clearest possible argument that no constant was ever going to answer this.
- **A prompt can now be deliberately not delivered** (D5, D8). That is a new outcome with a new failure mode: a Session that starts, shows a dialog, and sits there. It is the intended trade, it is logged, and it leaves a running harness rather than an exited one.

## Amendment — issue 177 (2026-08-19)

Two changes, both within this record rather than against it.

**D7's folder-trust entry now also covers `cursor-cli`.** D7's argument for
scoping was that a dialog spec is a transcription of a named harness's screen,
and applying one vendor's transcription to another means pressing a digit into a
layout nobody has looked at. That argument holds for the bypass-permissions
entry, which is scoped to `claude-code` still: `Bypass Permissions mode` is
Claude Code's phrase and the screen behind it is Claude Code's screen.

It does not hold for folder-trust, because that entry contains no transcription
to carry across. What it asserts is that "trust" plus a workspace noun plus a
question mark means a trust prompt is up, that an option meaning yes is the one
to take, and that an option meaning no is the one to refuse. The number of
options, their labels and **which digit the affirmative one carries** are read
off the screen in front of it by `readDialogOptions` — this module has never
hard-coded a key, which is precisely what [issue
177](https://github.com/actana/control/issues/177) warns a careless partial
match would do. The nouns were widened (`workspace`, `project`, `repo`) for the
same reason: they make the entry less dependent on one vendor's wording, not
more. D5 is unchanged and is what makes the widening safe — a screen whose menu
does not parse yields no answer, and no answer means no keystroke.

**What the entry achieves, precisely: recognition, not an answer.**
cursor-agent's trust screen has since been observed on a machine that has the
harness installed, and is committed as bytes at
`packages/core/src/__tests__/fixtures/cursor-agent-2026.08.11-folder-trust.txt`.
The nouns catch it. The menu is **letter-keyed** — `[a] Trust this workspace` /
`[q] Quit` — and `readDialogOptions` reads digits, so it returns an empty list,
`chooseDialogOption` returns null, and a cursor-cli delivery that meets this
screen always abandons. The row makes the dialog *recognised*; answering it
needs a menu reader this module does not have, which is
[issue 273](https://github.com/actana/control/issues/273). The win is real and
it is the change below: before the row, the prompt and a carriage return were
typed into the trust dialog and the delivery reported `delivered`.

**Recognition is not a net under a harness the table has never heard of, and
this record previously said it was.** An *unrecognised* dialog does not abandon:
`onQuiet` finds no dialog, emits `settled`, calls `writePrompt`, and the prompt
goes into whatever is on screen. The `needs-input` outcome exists **only because
a pattern matched**. D7 stands on the matching, not on a downstream backstop —
whoever adds the fifth harness must not read this amendment as "matching is
optional, the net catches it either way."

**Abandoned delivery now moves the Session to `needs-input`.** D5 and D8 are
deliberate that the Core types nothing into a dialog it cannot read and gives
up with the dialog still on screen. The last Consequence above named the cost of
that — *"a Session that starts, shows a dialog, and sits there"* — and until now
the giving-up was a `pty.prompt-delivery.abandoned` log line on the Core and
nothing else. No client reads that log, so every client saw a Session at its
pre-turn status and no way to tell it from a hang.

The Core now reports it as an output signal (`dialog-unanswered`,
`pty-manager.ts` → `CoreHarnessStatus.outputSignal`), which maps to
`needs-input` — the same route Codex's `hooks-need-review` already takes, and
for the same reason: a harness waiting on a human is what `needs-input` means.
Nothing about the decision changed, only whether anybody is told. `needs-input`
is a settled status, so an SDK `waitForIdle` on an abandoned Session now returns
instead of waiting for a report that was never going to come.
