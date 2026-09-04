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

## Amendment — issue 232 (2026-08-19)

**D3a's readiness table now covers `cursor-cli` and `claude-code`, and this
record's claim that they were unaffected was wrong.** D3a ends by saying that
`claude-code`, `codex` and `cursor-cli` have no entry "and are therefore
unchanged, which matters because a cursor-cli start prompt was verified working
on the very build #229 was filed against". One working start is not a rate.
[Issue 232](https://github.com/actana/control/issues/232) timed three cursor-cli
Sessions back to back on one Core — settles at 3.1 s, 1.6 s and 2.5 s — and the
1.6 s one lost its prompt: Cursor Agent on its idle screen, the Session parked
in `ready`, `--wait` timing out unreported. The field evidence attached to the
issue puts claude-code at the same rate, 8–10 losses in about 25 `session
start` runs across three Cores, with the identical signature and the identical
proof that nothing but timing was wrong — the same bytes re-sent into the same
Session land immediately and run the turn.

**Nothing about D3a's design changed; two rows were added to its table.** The
readiness table is still per-harness with an empty default, still populated only
from screens somebody has looked at, and still degrades to D8 rather than to a
lost prompt when a marker stops matching. The markers are the composers' own
placeholders: `Plan, search, build` for cursor-agent, `Try "` for claude-code.
Both rows have a screen behind them: claude-code's is a live PTY capture taken
here, and cursor-agent's idle composer (`→ Plan, search, build anything`) is the
screen quoted off a signed-in install of build 2026.08.11-e8db854 in the review
of PR #275, since cursor-agent stops at sign-in on the machine this was written
on. Both are committed under `packages/core/src/__tests__/fixtures/`.

**Why no constant was ever the alternative.** claude-code 2.1.235 was captured
live on the machine this was written on, with `script --log-timing`: the
answered trust dialog repaints at 5 051 ms and the composer arrives at 5 623 ms,
so D3's 350 ms quiet gap expires at 5 401 ms — 222 ms early — while the dialog
that preceded both was on screen in 435 ms. A gap wide enough for the hole is a
tax on every fast boot, and the observed spread across harnesses (opencode 3.4–
6.9 s, cursor-cli 1.6–3.1 s) is wider than any single number can straddle. The
fixtures are committed as
`packages/core/src/__tests__/fixtures/claude-code-2.1.235-{trust-ack,composer}.txt`
and the suite replays them at their measured timings.

**A marker was rejected on a measurement, which is the discipline worth
recording.** claude-code's `⏵⏵ … (shift+tab to cycle)` footer sits on the
composer screen and reads like an obvious marker. It was observed at 15 635 ms
in one capture — ten seconds behind that run's composer and past D8's 15 s
backstop. It does not always land there: on a second 2.1.235 capture, taken on
the reviewer's machine for PR #275, the footer arrived in the same frame as the
composer. The rejection stands on the variance rather than on the one number. A
marker that is *sometimes* ten seconds late cannot be gated on, because the run
it is late on is exactly the run that gets delayed. A marker has to be timed
against the composer it stands for, not just found on the same screen.

**`codex` still has no entry, and that is a gap rather than a clearance.**
Nothing in issue 232's sample exercised it and no codex screen has been read, so
it keeps D3, D6 and D8 unchanged — which is precisely the path claude-code and
cursor-cli were on while they were losing prompts. The honest reading of this
amendment is that codex is *unverified*, not that it is safe, and a codex row is
owed as soon as somebody captures its composer. That is filed as
[issue 277](https://github.com/actana/control/issues/277), so the gap has an
address rather than a note in three files. *Superseded by the issue 277
amendment below: the screen has been read and codex has a row.*

**This is also why the mitigation belongs here and not in a client.** The
workaround in use while this was open — start the Session, wait ~12 s, ask the
Core whether it is `running` or `ready`, re-send the prompt if it is still
`ready` — works, and takes about 24 s to recover. It is D6a implemented one
layer too far out: only the Core sees the harness's screen, which is this
record's founding argument. With `confirmEcho` on both harnesses, a write that
left no echo returns to `settling` and is typed again inside the same delivery,
and the client has nothing to poll for.

## Amendment — issue 483 (2026-09-03)

**D8's backstop no longer authorises a blind type into a harness that has a
composer marker, and a marker that never arrives ends the delivery as
`abandoned`.** D3a made the marker the condition for typing and D8 made the
clock an override of it, and the override is the bug. Read together, the two
said: wait for evidence that the harness is listening, and if that evidence has
not come in fifteen seconds, type anyway and report `delivered`. The second half
undoes the first exactly on the runs the first exists for — the absent marker is
not the Core failing to notice a ready harness, it is the Core correctly
noticing an unready one.

Measured on a developer Core on beta/0.4.5, five opencode Sessions started on
one project inside half an hour: **three** sat at `ready` with an empty composer,
the prompt typed before opencode was listening and discarded by the terminal;
**two** reached `finished` with the prompt visibly retyped two or three times in
the transcript before one submission took. Same inputs, minutes apart, opposite
outcomes — a race against opencode's boot, which lands on either side of the
backstop rather than reliably inside it. Every one of the three losses was
reported to the caller as a successful delivery.

**What changes.** For a harness with a row in `HARNESS_READINESS`, `maxWaitMs` is
no longer a licence to type. The wait stays keyed on the marker up to a
per-harness ceiling, `PromptDeliveryProfile.composerWaitMs`, and a marker that
never appears within it abandons the delivery — which by the issue 177 amendment
above already puts the Session in `needs-input`. A marker that appears *after*
the generic backstop but inside the ceiling delivers normally: the quiet gap, the
composer gate, `confirmEcho` and the retype budget all apply exactly as they do
at one second. The three paths — marker before the deadline, marker after it and
inside the ceiling, marker never — are each covered by a unit test.

**What does not change.** A harness with **no** marker keeps D8 whole:
`composerOnScreen` is `true` for it from the first byte, the ceiling is never
consulted, and the prompt still goes out at `maxWaitMs` and is submitted. This
is not a longer global timeout, and it must not become one — a bigger number
makes every other harness slower and still types blind at the end of it. D5's
rule also keeps its precedence: a dialog on screen at the deadline abandons as
`blocked by <dialog>`, because the dialog is the thing an operator can act on.

**The ceiling lives in `HARNESS_PROMPT_DELIVERY_PROFILES`, which D7 described as
"deliberately empty".** It is no longer empty, and the reason is the reason D7
gave for having the table at all: a harness that genuinely needs a different
number now exists. `opencode: { composerWaitMs: 90_000 }` is the operator's own
stopgap value, and it is a ceiling on waiting rather than a schedule — a boot
that paints its composer at six seconds is delivered at six seconds. `cursor-cli`
and `claude-code` name no number, so their ceiling defaults to `maxWaitMs`: the
timing they already had, with an honest outcome at the end of it instead of a
blind keystroke.

**The failure is now legible to a client, and not only as a status.** Abandoning
already produces `needs-input`, but `needs-input` is also what a harness that
stopped to ask a permission question produces, and the two call for opposite next
steps: one is answered with `session send`, and the other has no question, no
turn, and a prompt that has to go again. So the Core also appends
`session:promptAbandoned` to its event log — Task, PTY and the Core's own words
for why, never the prompt text — and `session start --wait` / `session wait`
read it off the connection they already have. They print what stopped the
delivery, exit non-zero, and set `promptDelivered: false` on the `--json` object.
A `session send` never goes through this path at all: a send is a raw write by
design (#404), so no delivery of one can be abandoned.

**Two orderings make that report trustworthy, and neither is optional** (review
of PR #487). First, on the Core: the reason row is appended *before* the status
signal, because the status is what ends a client's wait. `dialog-unanswered`
writes the row through `CoreHarnessStatus` to `needs-input`, whose `task:updated`
event resolves `waitForTurnEnd` synchronously on the client — so a reason
appended after it is a reason nobody reads, and the caller sees a clean settle
for a prompt that never landed. That is this issue's own defect moved one layer
out. Second, on the client: the latch that reads the row is opened *before* the
session exists — before `subscribeEvents`, before `createTask`/`spawn`, before
`findByTask`/`ptySubscribe`/`replay`/`seedStatus` — and holds what it hears until
it knows which Task it is holding it for, the same shape as `CoreSession.start`'s
`heldEvents`. A latch installed after those round trips is deaf for exactly the
window a fast abandon lands in.

**And a row from a previous life is not a report about this command.** The event
log is durable and `subscribe` replays it from the beginning, so a Session whose
first start was abandoned carries that row for as long as the log does. Read
without a floor it would fail a later `session send … --wait` that landed
perfectly — on the very command this feature's own error message recommends as
the recovery, which makes it the same false report pointed the other way. So the
latch takes a floor: a stamped delivery counts from its own stamp, everything
else counts from the `eventsReplayed` marker, and until a floor is known nothing
is accepted. Regression tests cover both the stale-and-cursored and the
stale-and-uncursored case.

**A PTY that dies mid-delivery says so too.** `HarnessPromptDelivery.dispose()`
sets `abandoned` without emitting — it is also the ordinary teardown of a
delivery that finished — so the fact is read off the phase in `pty-manager`'s
exit handler instead, and only the *reason* row is appended there: the status
that Session settles on belongs to the exit, and a `needs-input` raised against a
harness that is already gone would fight it for the row. This window used to be
15 s and is now up to 90 s on opencode, which is why leaving it silent stopped
being good enough.

**Why this could not wait for the next train.**
[#387](https://github.com/actana/control/issues/387), merged in 0.4.5, settles a
stranded `ready` Session. Before it, a lost prompt presented as a Session
visibly parked at `ready` — wrong, but findable. After it, the same loss presents
as a **settled Session that produced no report**, which is the shape of a
Session that ran and had nothing to say.

**Related, and not fixed here.**
[#395](https://github.com/actana/control/issues/395) is the same race from the
client end: `session start` returns before the harness can take a `send`. This
amendment deliberately leaves the start return path alone, so #395 still has to
decide what a `start` promises about readiness. What it gains is a Core that no
longer claims a prompt was delivered when it was not, which is the fact any
client-side answer has to be built on.

## Amendment — issue 277 (2026-09-03)

**`codex` has a readiness row, and the hole it closes is not the one it was
suspected of.** [Issue 277](https://github.com/actana/control/issues/277) asked
for two things before a row: codex's boot and idle composer captured off a live
PTY, and the gap between them timed rather than guessed. Both were done on
codex-cli 0.153.0, twenty-four live boots on one Core at the Core's own 100×30
and `TERM=xterm-256color`, and the measurement decided the shape of the row.

**There is no boot race on this build.** `› Ask Codex to do anything` — the
composer's own placeholder — is in the *first* frame codex paints, 160–198 ms
after spawn on 8 of 8 timed cold boots (five `codex --enable hooks`, three
plain). D3's 350 ms quiet gap does not expire until 564–955 ms in those same
runs, so the marker leads the settle by 366–782 ms every time. Nor is the
marker merely early: a prompt written at 0, 60, 120, 170, 200, 400, 700 and
1200 ms — eight further boots — echoed into the composer on every attempt,
including the writes that went in before codex had painted anything at all. If
the row had to rest on the boot race it would not be justified, and this record
would say codex needs no row.

**The hole is the directory-trust dialog, and it is a D3a hole rather than a D5
one.** In a directory codex does not trust, it paints that same composer
placeholder at 198 ms, clears the screen at 633 ms, and replaces it with `Do you
trust the contents of this directory?` at 638 ms. The quiet gap expires at
634 ms — **one millisecond after that clear** — so what D3 hands D3a is the
dialog and not the composer that was on screen a moment before. And codex has
**no `BLOCKING_DIALOGS` entry**, so D5 is not watching for that screen either.
Measured on a further boot: a 22-character prompt written at 990 ms, with the
dialog up, produced no echo and no change to the screen at all. The dialog
swallows it, and the `\r` D8 sends after the submit pause lands on a menu whose
highlighted row is `1. Yes, continue` — the directory is trusted, a session
starts, and the prompt is gone with the Session parked in `ready`. That is issue
277's stated signature, reached by a different route than #229's.

**One millisecond is a measurement, not a safety margin, and the record should
say which.** It is one millisecond because D3 restarts the quiet window only on
a *novel* `redrawSignature` — the last one in that boot is at 284 ms — and the
figure comes from replaying the capture's own chunks at the capture's own
offsets rather than from concatenating them, which merges signatures and moves
the settle. (The same correction applies to the numbers above: an earlier
revision of this amendment said 602–1810 ms for the same eight boots, from a
coarser rule that counted every changed frame as a paint; the two disagree by
38 ms on one boot and by 855 ms on another.) The other untrusted boot in the sample cleared
at 555 ms against a gap at 908 ms, so 1 ms is the tight end of the range. And
the other ordering costs nothing silent: had the gap opened first, delivery
would have typed into a composer the dialog was about to wipe, D6a's
`confirmEcho` would have seen no echo, and the `\r` would have been withheld
rather than pressed into the menu. Both orderings are replayed in the suite.

**So the marker earns the row on the dialog, not on the boot**, and the row is
the ordinary D3a/D6a pair: the placeholder as the composer marker, `confirmEcho`
on, `maxPromptWrites: 3`. What it buys is that the module holds instead of
typing into a screen that is provably not a composer, and the prompt is still in
hand when a human answers the dialog.

**What the caller is actually told, stated exactly.** Delivery ends `abandoned`
with `codex composer never appeared within 15000 ms` — the marker, not the
dialog. D5's rule that "the reason a client is given is the dialog and not the
marker" cannot apply here, because that branch is reachable only for a harness
with a `BLOCKING_DIALOGS` entry and codex has none. So the Session is
`needs-input` and the prompt is intact, which is the win, but the words name the
marker and it is still the screen that tells an operator what is in the way.

**Teaching D5 to answer that dialog is not taken here, and this capture sharpened
what it will cost.** The obstacle is not only that `readDialogOptions` needs a
digit followed by `.` or `)` while the menu strips to `1. Yes, continue2.No,quit`.
It is that codex lays the dialog out with absolute `ESC[row;colH` moves, which
`stripAnsi` deletes outright rather than spacing the way it spaces `ESC[nG` and
`ESC[nC` — so the screen collapses to
`…apiDoyoutrustthecontentsofthisdirectory?Working…` and not even the word `trust`
survives on it. Adding codex to the existing `folder-trust` row would match
nothing at all; the *reading* has to change before the answering can. That is
[issue 469](https://github.com/actana/control/issues/469)'s, and it should
inherit this finding rather than only the menu-key half.

**Two candidate markers on the same frame were timed and rejected**, which is
the discipline the issue 232 amendment recorded and this one keeps. `? for
shortcuts` arrives with the composer on 8 of 8 boots and is **gone from the
settled screen** 927 ms later, so it would read "no composer" on every delivery
that begins after boot rather than during it. The `>_ OpenAI Codex (v0.153.0)`
wordmark does survive to the settled screen, and it is still the wrong thing to
gate on: a painted box is exactly what D3a exists to stop reading as readiness,
and it lands in the same frame as the placeholder on every boot measured, so it
buys nothing even where it is right.

The screens are committed under `packages/core/src/__tests__/fixtures/` as
`codex-0.153.0-{boot,composer,boot-settling,idle,untrusted-boot,directory-trust}.txt`,
with `codex-0.153.0-frames.txt` carrying each PTY chunk's offset so the suite can
replay a capture the way it arrived. The marker is asserted against those files
rather than against a literal beside it.

**D6a's `confirmEcho` is the one field in the row that can lose a delivery that
works today, so it carries its own evidence.** The other two cannot: a marker
that stops matching makes a prompt late, and a write budget only bounds retyping.
An unsatisfiable `confirmEcho` is different — no echo means `retypePrompt`, which
clears the screen and re-imposes D3a's gate, so a harness that *had* taken the
prompt gets typed at again and then abandoned. The shape that would do it is a
long prompt rendered as a collapsed paste chip, because `PASTE_PLACEHOLDER`
transcribes Claude Code's `[Pasted text #1 …]` and would not match codex's
wording. Issue 277's own field comment records exactly that workload — Studio
codex Sessions started with a multi-line sub-agent contract — so `"say hello"`
was not evidence for it.

Measured, on the two shapes such a prompt can arrive in. `sanitizeInitialInput`
collapses every run of C0 whitespace to one space before delivery sees the text,
so an 800-character contract reaches `writePrompt` as one 796-character line; one
write of it comes back echoed verbatim and wrapped, with no chip. The same text
delivered as a real bracketed paste — `ESC[200~ … ESC[201~`, which codex
advertises with `ESC[?2004h` in its first bytes — also echoes in full, its line
breaks preserved as composer lines. Both composers are committed beside the
prompt as `codex-0.153.0-{long-prompt,long-prompt-echo,pasted-prompt-echo}.txt`
and the suite runs `promptEchoed` against them. The field is earned; had either
collapsed to a chip, the honest answer would have been to ship the row without
it.

**codex needs no `HARNESS_PROMPT_DELIVERY_PROFILES` entry**, so its
`composerWaitMs` is the default and equals D8's 15 s backstop. A marker that
arrives at 200 ms is two orders of magnitude inside that, and the one screen
where it never arrives is a dialog — which no amount of extra waiting turns into
a composer. The timing table stays a place for a harness that has been measured
to need a different number, which codex has now been measured not to be.

**How this composes with the issue 483 amendment above**, which landed on the
same day and on the same branch. That amendment removed the backstop's licence to
type blind at a harness with a marker, so giving codex a marker changes what
happens to the untrusted-directory case at 15 s: instead of typing the prompt
into the trust dialog and reporting `delivered`, the delivery ends `abandoned`
and the Session becomes `needs-input` with a `session:promptAbandoned` row saying
the prompt did not land. That is the report an operator staring at an unanswered
dialog actually needs, and it is why the ceiling stays at the default — opencode's
90 s buys time for a boot that straddles the deadline, and codex has no such
boot, so a longer ceiling here would only postpone the report by 75 s.

## Amendment — issue 395 (2026-09-03)

**A Session that is *running* is not yet a Session that can take a `send`, and
`session start` now has a way to say which one it is returning.** The two facts
were never distinguished. `start` returns when the Core has spawned the harness
(#129 D6), which is before the composer is painted, often before the trust
dialog is drawn, and always before the Core has begun typing. The operator's
next line is the one that pays:

    SID=$(actana session start web "fix it")
    actana session send $SID continue --enter

The keystrokes land on a dialog or in a terminal that is not reading yet, and
the harness discards them — together with the starting prompt sitting in the
same buffer, which is how one command loses two messages and reports success
for both.

**What changes.** Nothing about when a bare `start` returns: hanging up before
delivery is right, because delivery runs on the harness's clock and the
amendment above gives opencode ninety seconds of it. What changes is that the
silence stops reading as readiness.

- The Core appends **`session:promptDelivered`** — Task, PTY, character count
  and how long it waited, never the prompt — from inside
  `HarnessPromptDelivery.submit`. It is the positive twin of
  `session:promptAbandoned`, and it had to exist for the reason issue 483 did
  not need it to: 483 read a *loss* off a row, and could treat the absence of
  one as delivery because it had already waited for a turn to end. A start has
  not. There, "no abandon row" and "the composer is still not up" are the same
  silence, so a command that read the first as delivery would be claiming a
  readiness nobody established.
- **`session start --await-prompt`** and `session resume --await-prompt` block
  until the Core says which of the two it was, print the Session id as usual,
  and exit zero **only** on a delivery the Core can vouch for. That is the
  "documented wait" the issue asks for.

  *What "vouch for" means, and why the first draft of this paragraph was wrong.*
  It said a delivered prompt "is a composer that was seen on screen". That is
  true of a harness with a row in `HARNESS_READINESS` and false of one without,
  and D3a of this record says as much: a harness with no entry gets D3, D6 and
  D8 — the quiet gap — and `composerOnScreen` returns `true` for it from the
  first byte without looking at anything. So the row carries `composerObserved`,
  the Core sets it from the same predicate that gates the write, and a delivery
  that cannot claim it is reported as `unverified`: non-zero, `promptDelivered:
  null`, and a sentence saying the Core typed but saw nothing.

  *And as of the issue 277 amendment above, no shipped harness is in that
  state.* `opencode`, `cursor-cli`, `claude-code` and now `codex` all have rows,
  so `composerObserved` is `true` on every delivery this build can make and
  `unverified` is unreachable for all four. The draft of this paragraph written
  before #277 landed used codex as the live example of a marker-less harness,
  and that is no longer what codex is: it has `Ask Codex to do anything`, and
  the directory-trust screen that used to swallow its prompt now ends the
  delivery `abandoned` rather than reaching a client as a delivery at all.

  The outcome is kept because the table is open, not because a harness needs it
  today. `HARNESS_READINESS` has a default for ids that are not in it (D7), so
  the next harness added arrives marker-less, and without `composerObserved` a
  `--await-prompt` against it would report a readiness nobody established on the
  day it shipped. A harness joins the vouched-for set the moment it gets a row,
  with no client change — which is exactly what happened to codex between this
  amendment's first draft and its merge.
- Without the flag, `start` **says so** rather than implying otherwise: a line
  on stderr naming the gap and the flag, and `promptDelivered: null` on the
  `--json` object. `null` and not `false` — the prompt is not lost, it is
  unadjudicated, and a `false` would be a verdict nobody reached.

**Delivery is the readiness signal, and there is no second one.** #191 deleted
the last client-side timer that guessed at a harness being ready, and D3 above
is why: only the Core sees the screen, and a client inferring readiness from
quietness or from bytes is the 450 ms nudge with a new name. So the gate is the
Core's own verdict on a prompt it actually typed, not a Core-side "composer
ready" broadcast — a marker-less harness has no such moment to broadcast, and
inventing one for it would be a claim rather than a report. It follows that a
start with **no** prompt cannot use the flag, and it is refused rather than
answered with an instant, meaningless success.

**No clock is added on the client, and none is needed — but the bounds have to
be facts, and the first draft was short of them.** `packages/cli` ships no
scheduler on any path that reaches a harness's stdin
(`no-prompt-timing.test.ts`), and this wait does not want one. It ends on one of
the Core's answers — delivered, abandoned at that harness's own `composerWaitMs`
ceiling, or the row `pty-manager` appends when the PTY dies mid-delivery — or on
one of three facts about the world, each of which means no answer is coming:

- **the link went down** (`onDisconnected`);
- **the harness exited** (`onExit` for this Session's own PTY). An exit frame is
  not a log row, so it arrives even from a Core whose appends are failing, and a
  harness that is gone will never take a prompt;
- **the Core says it has no event log to report from** — see the floor below.
  A Core older than the row, or one running with no event-log port, answers the
  subscribe with no tip; that absence is read as "this Core cannot tell me", one
  frame after the subscribe, instead of waiting for a row that is never coming.

And a prompt that would not be delivered at all is refused before any of it: the
empty string, and a string of nothing but spaces and control characters, are
both dropped on the way to the harness (`sanitizeInitialInput`), so a wait for
their delivery is a wait for nothing. `--wait-timeout` stays refused with
`--await-prompt`, because with those bounds in place a second deadline could
only end the wait early, with nothing to report except that it had.

**The event-ordering discipline the 483 amendment recorded applies unchanged,
and one clause of it is new.** The latch is still opened before the session
exists and still takes a floor, because the delivered row is as durable and as
replayable as the abandoned one — a resume of a Session that once lost its
prompt must not read that old row as this start's verdict. What the positive row
adds is a *third* ordering: it is appended in the same synchronous tick as the
carriage return that submits the prompt, so it is in the log before the event
loop can carry a byte of the harness's reply, and therefore strictly before any
status the turn it starts eventually produces. A delivery row behind the status
would be as unreadable as the reason row behind it was.

**And the floor has to be the log's actual end, which the `eventsReplayed`
marker never was.** The 483 amendment's floor was that marker, on the reading
that "everything up to here was already history when you asked". It is not:
`handleSubscribe` caps its replay at `EVENT_TAIL_LIMIT` — a thousand rows — and
reports the last row it *sent*, then delivers the remaining history behind the
marker through `pushLiveEvents` as ordinary events. Nothing prunes the log. So
on any Core past a few days of use the floor sat around a thousand and every
historical delivery row above it was read as the current command's verdict: an
instant exit 0 on a start the Core had not typed a character of, and the mirror
case failing a start whose prompt landed. The Core therefore reports
`tipEventId` on the marker — read *before* the tail, so every row that existed
when the client asked is at or below it — and the latch floors on that. It is
carried beside `lastEventId` and no cursor consumes it: a cursor advanced to a
tip would skip history the client was never sent, which is the trade
`packages/cli/src/event-tip.ts` refuses and still refuses.

This is #487's own reasoning made true rather than a new rule — that review
argued "every replayed row is necessarily below the marker", which holds exactly
when the marker is the tip. It repairs the same hole in the report path #483
already shipped, where it made `promptAbandoned()` answer from a stale row on a
`session wait`; that is why the repair lands here rather than waiting for a
ticket of its own. What it does not do is make a bare `session wait` report an
abandon that happened *before* it attached — that remains #483's deliberate
semantic (a bare wait reports what happens during it) rather than, as it was
until now, an accident of where the replay stopped.

**A latch with no floor now says so instead of answering.** The observation left
by the review of PR #487 — that `openPromptDeliveryLatch` depends on having
caused the `subscribe`, and would hold every row for ever on a client that
arrived already subscribed — was survivable while the answer was a silent
`null`. It is not survivable for a wait, which would simply never end. The latch
records that it cannot judge and reports `unavailable`; `openSessionGateway`,
which builds one fresh client per gateway, is where the invariant is kept.

**`session send` is not gated, and the contract is still the same on both
sides.** The issue offers the choice — gate the start, or gate the send — and
gating the start is the one that can be honest: a send is a raw write by design
(#404), the Core adds no delivery machinery to it, and there is nothing there to
report. A caller that wants to know its send will be read waits on the start
that precedes it.
