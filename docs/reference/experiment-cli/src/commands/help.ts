// help — the whole surface, per resource.

const OVERVIEW = `core-client — drive an Actana Core over its core-link protocol

USAGE
  core-client <resource> <verb> [target] [options]

  Resources group by what they act on; the verbs repeat across them, so
  \`project ls\`, \`session ls\` and \`harness ls\` all behave the same way.

RESOURCES
  core       which Cores this client can talk to
  project    directories on the Core that sessions may run in
  session    harness sessions: launch, drive, read, end
  harness    which agent CLIs the Core can launch
  status     is this Core reachable, and what is on it
  events     the Core's event log

  core-client help <resource>    everything about one resource
  core-client <resource> --help  the same

COMMON
  core-client status
  core-client project ls
  core-client session start <project> "do the thing"
  core-client session logs <session>
  core-client session send <session> "and now this"
  core-client session interrupt <session>

TARGETS
  A project is named by its id, its name, or its path — whichever you have.
  A session is named by its task id (durable) or its pty id (lives only as long
  as the process). Both are accepted everywhere a session is asked for.

OUTPUT
  Data goes to stdout, commentary to stderr, so ids can be captured:
      SID=$(core-client session start scratch "summarise the README")

SELECTING A CORE
  --core <name> picks which Core the command runs against, the way kubectl
  picks a context. It is global: it may go anywhere in the line, and every
  resource honours it.

      core-client --core pr project ls
      core-client project ls --core pr        the same thing
      AC_CORE=pr core-client project ls       the same, for a whole shell

  \`core ls\` lists what is available. Cores are separate machines as far as
  this client is concerned: projects, sessions and harness logins on one are
  invisible to the other.

CREDENTIALS
  The pairing blob is resolved in this order:
      --core <name>  blobs/<name>.txt
      AC_BLOB        the base64 blob itself
      AC_BLOB_FILE   a file holding it
      AC_CORE        blobs/<name>.txt, the ambient default
      ./blob.txt     the unnamed local copy, as before
      docker exec    against $AC_CONTAINER (default: rest-test)

  It carries a client key and a bearer. Treat it as a secret.`;

const CORE = `core-client core — which Cores this client can talk to

  core ls                    list them: name, endpoint, label

  A Core is one blob file in blobs/, named by the file's basename. The name is
  what --core takes:

      core-client --core pr session ls
      core-client --core developer session ls

  Naming them by purpose rather than by container or port is deliberate: a
  rebuild that moves a port leaves \`--core pr\` working, where a memorised
  wss://127.0.0.1:9443 would not.

  Adding one is copying its blob in:
      docker exec <container> cat /home/core/.config/actana/registration-blob.txt \\
        > blobs/<name>.txt

  Selection order is --core, then AC_CORE, then blob.txt as the unnamed
  fallback. \`core ls\` marks the one in effect with an asterisk.

  These are credentials — a client key and a bearer each. The directory is
  mode 700 and the files 600. Do not commit them.

  Aliases: \`cores\` → core ls`;

const PROJECT = `core-client project — directories the Core may run sessions in

  project ls                        list projects
  project create <path> [name]      register a directory as a project
  project rm <project> --yes        unregister a project and its sessions
  project browse [path]             browse the Core's filesystem
  project inspect <project>         full detail as JSON

  The path is a path on the Core, not on your machine, and the Core validates
  it: absolute, resolvable, and a directory. \`project browse\` is how you find
  one worth registering.

  Registration is not bookkeeping. A session may only run inside a registered
  project root — the Core rejects any spawn whose working directory is outside
  one.

  \`rm\` needs --yes because the Core's removal operation cascades: every
  session recorded under the project goes with it. The directory on disk is
  left alone; the project is unregistered, not erased.

  Aliases: \`projects\` → project ls, \`add-project\` → project create,
           \`ls\` → project browse`;

const SESSION = `core-client session — launch, drive, read and end sessions

  session ls [--all]                sessions with a live PTY
  session start <project> [prompt]  launch one; prints its id and exits
  session logs <session>            what it has said so far
  session attach <session>          stream it live
  session send <session> <text>     type into it and submit (--no-enter to hold)
  session enter <session>           press Enter only
  session interrupt <session>       press Escape — stop the turn, keep the session
  session resume <task>             relaunch a finished session, conversation intact
  session kill <session>            end it for good
  session inspect <task>            full detail as JSON

LAUNCHING
  \`start\` is fire and forget: it prints the task id to stdout as soon as the
  session exists, and the session keeps running on the Core after it exits.

  Two steps beat one when it matters:

      ID=\$(core-client session start myproject)
      core-client session logs \$ID          # see it is at the prompt
      core-client session send \$ID "do the thing"

  \`start <project> "prompt"\` still works and does the same thing in one go,
  but the split is what to reach for when a prompt is not landing: each half
  reports separately, and \`logs\` in between shows exactly which one failed.

  Either way the text is typed by this client once the screen holds still. The
  Core's own initial-input path fires 450ms after spawn, before Claude accepts
  input, and loses the prompt.

  Auto mode is the default: sessions launch with
  --dangerously-skip-permissions, so Claude does not ask for tool approvals.
  Use --ask-permissions to opt out.

  Claude's blocking startup dialogs are answered automatically — the bypass
  permissions warning and the folder-trust prompt. Both appear once per project
  per Core, and a session parked on one accepts no input at all; the bypass one
  is worse, since its highlighted default is "No, exit", so any Enter sent at
  it quits Claude. Answering them is what makes auto mode actually unattended.

READING
  \`logs\` replays the session's output through a terminal emulator, because a
  TUI paints with cursor moves rather than plain text — stripping escape codes
  produces unreadable soup. It only works while the session is alive: the
  scrollback belongs to the PTY and goes when the process does.

STOPPING
  \`interrupt\` sends Escape: the turn stops, the session lives on and can be
  given something else. \`kill\` ends the process group. They are not the same
  and the difference matters.

SENDING
  \`send\` waits for the screen to hold still before it types, then sends the
  Enter as a separate write after a pause that scales with length. Both halves
  matter: text typed into a still-painting TUI is dropped, and an Enter in the
  same frame as a long paste is absorbed into it.

      --enter     press Enter after the text (the default; spell it if you like)
      --no-enter  type it and stop, leaving it unsubmitted
      --now       skip the settle wait, for a session known to be idle

  \`session enter\` submits whatever is already sitting there.

OPTIONS
  --follow          start/logs stream instead of returning
  --all             ls includes finished sessions
  --lines N         logs: how many lines (40)
  --raw             logs: untouched bytes, no emulation
  --cols N --rows N logs: replay geometry, must match the spawn (120x32)
  --harness <id>    claude-code (default), codex, cursor-cli, opencode
  --model <id>      model to launch with
  --title <text>    task title instead of one derived from the prompt
  --ask-permissions launch without auto mode

  Aliases: \`sessions\` → session ls, \`start\`, \`send\`, \`enter\`, \`attach\`,
           \`resume\`, \`kill\` and \`tail\` (→ session logs) all work bare.
           \`stop\` is a deprecated alias for \`session interrupt\`.`;

const HARNESS = `core-client harness — the agent CLIs the Core can launch

  harness ls                 availability, version and install path
  harness install <id>       start installing one on the Core

  Harnesses are not baked into the Core image. They install at runtime into the
  Core's home directory, which is the persistent volume, so they survive image
  upgrades and self-update in place.

  \`install\` is fire and forget: it starts the install and returns. The work
  runs on the Core and takes minutes, and the protocol only ever acknowledges
  the start, never the outcome. Run \`harness ls\` to see whether it landed —
  the Core re-probes when the install finishes, and success means "the probe
  now finds it".

  Installing gets you the binary, not a login. Harness credentials live in the
  Core's home directory too, and each Core authenticates separately.

  Known ids: claude-code, codex, cursor-cli, opencode

  Aliases: \`harnesses\` → harness ls, \`install\` → harness install`;

const STATUS = `core-client status — is this Core reachable, and what is on it

  status

  Prints the endpoint being dialled, the Core's label, the protocol version
  this client speaks, how many projects exist, how many sessions are running
  against how many total, and each harness's availability.

  It is also the cheapest proof that the credentials still work: it opens a
  real mTLS connection and authenticates before printing anything.`;

const EVENTS = `core-client events — the Core's event log

  events [--since N] [--kind prefix]

  Streams task and session lifecycle, project changes, and harness install
  outcomes. Replays from the beginning by default; --since resumes from an
  event id, --kind filters by prefix (\`task:\`, \`session:\`, \`pty:\`,
  \`project:\`, \`agents:\`, \`harness:\`).

  Some outcomes exist only here. A harness install reports success and failure
  as events, never as a reply to the request that started it.`;

const TOPICS: Record<string, string> = {
  core: CORE,
  project: PROJECT,
  session: SESSION,
  harness: HARNESS,
  status: STATUS,
  events: EVENTS,
};

export function printHelp(topic?: string): void {
  if (!topic) {
    console.log(OVERVIEW);
    return;
  }
  const text = TOPICS[topic];
  if (!text) {
    console.log(OVERVIEW);
    console.log(`\n(no help topic "${topic}" — the resources are: ${Object.keys(TOPICS).join(", ")})`);
    return;
  }
  console.log(text);
}
