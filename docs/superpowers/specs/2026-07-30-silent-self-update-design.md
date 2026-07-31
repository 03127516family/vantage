# Silent Self-Update Design

## Problem

Vantage currently starts an official Claude plugin update from the `SessionStart`
hook, but downloading a new plugin cache does not complete the runtime upgrade:

- the active Claude session keeps the `CLAUDE_PLUGIN_ROOT` selected at session
  start;
- the Windows Codex task runs `~/.vantage/agent/reconcile.cjs`, not the plugin
  cache directly;
- the stable-copy refresh compares only `core.cjs` modification times, so a new
  cache can be installed without replacing an older stable copy;
- the Windows verifier refreshes the marketplace but does not prove that
  `plugin update`, cache activation, stable-copy replacement, and trigger repair
  all succeeded.

The result can be a new version in `installed_plugins.json` while background
collection still executes older code.

## User Experience Requirement

Updating, cache activation, stable-agent synchronization, and trigger repair
must be imperceptible to the user:

- no Command Prompt, PowerShell, Windows Terminal, or console window;
- no VBScript error dialog or Yes/No prompt;
- no blocking or noticeable delay when Claude starts;
- no administrator permission request;
- no interruption of Claude or Codex collection when an update fails;
- diagnostics go only to `~/.vantage/agent.log`.

Small background network and disk activity is acceptable. A newly installed
Claude hook version naturally becomes active in the next Claude session because
Claude fixes `CLAUDE_PLUGIN_ROOT` at session start.

## Chosen Architecture

Use a stable, detached self-update worker and a transactional stable-agent
deployment.

`reconcile.cjs` remains the lightweight trigger. Before starting an update it
ensures the current plugin agent is deployed to `~/.vantage/agent`. It then
launches the stable worker in the background and immediately returns to normal
collection.

The stable worker:

1. acquires an exclusive update lock;
2. runs `claude plugin marketplace update dgcrane`;
3. runs `claude plugin update vantage@dgcrane`;
4. reads the active user-scope record from
   `~/.claude/plugins/installed_plugins.json`;
5. validates that `installPath` exists and its plugin manifest name and version
   match the active record;
6. hashes the complete cached `agent` tree;
7. stages and verifies an exact copy;
8. transactionally replaces `~/.vantage/agent`, retaining the old directory
   until the new directory has been activated;
9. repairs the Codex VBS files and scheduled task using the newly activated
   code;
10. writes the installed version and success/failure details to the agent log.

The worker always executes as the signed-in employee. It uses that employee's
existing Claude marketplace configuration and Git/SSH credentials. It does not
require administrator privileges or a server connection into the employee
machine.

## Trigger Policy

There are two silent triggers:

- Claude `SessionStart`: check at most once every two hours.
- The existing OS Codex scheduled trigger: check at most once every 24 hours
  when Claude has not already performed a more recent check.

Both triggers share the same timestamp and exclusive lock, so concurrent
sessions and the scheduled task cannot start duplicate updates. The scheduled
path provides a daily fallback for users who do not open Claude.

The current `1.4.12` release cannot retroactively gain the post-update worker.
Therefore the first transition to the release containing this design completes
stable-copy activation when that new cache is first loaded by Claude. Once that
release has run once, later releases complete download, activation, stable-copy
synchronization, and trigger repair in one background update without reopening
Claude.

## Process and Window Handling

On Windows, Node launches `wscript.exe` with `windowsHide: true`, detached
stdio, and a UTF-16LE VBS file containing `On Error Resume Next`. The VBS starts
the stable Node worker with window style `0`.

The worker invokes Claude CLI through a hidden child process with:

- a finite timeout for each marketplace/plugin command;
- `GIT_SSH_COMMAND` using `BatchMode=yes` and a connection timeout;
- Git credential prompting disabled;
- stdout and stderr captured and appended to `agent.log`;
- no inherited terminal handles.

macOS and Linux use an equivalent detached process with ignored stdio and log
redirection.

The collection hook never waits for marketplace access, plugin download,
hashing, or synchronization.

## Transactional Synchronization

Modification times are not used to decide whether code is current.

The synchronization unit is the complete `agent` directory:

1. calculate a deterministic SHA-256 tree digest from every relative filename
   and file content;
2. return immediately only when source and stable digests match;
3. copy the source into a sibling staging directory;
4. verify the staging digest equals the source digest;
5. rename the current stable directory to a backup;
6. rename staging to the stable path;
7. verify the activated digest;
8. delete the backup only after successful activation.

If staging, validation, or activation fails, restore the backup and keep the
previous working agent. Temporary and backup directories are cleaned on the
next successful run. The update lock prevents two workers from replacing the
directory simultaneously.

## Installed Plugin Validation

The worker treats `installed_plugins.json` as the activation source of truth,
not the numerically highest cache directory. It selects the newest user-scope
record for `vantage@dgcrane` and requires:

- an absolute existing `installPath`;
- an existing `.claude-plugin/plugin.json`;
- manifest name `vantage`;
- manifest version equal to the installation record;
- an existing `agent/reconcile.cjs`;
- an existing `agent/core.cjs`;
- an existing `agent/installers.cjs`.

Failure at any validation step aborts activation and leaves the stable agent
unchanged.

## Error Handling

All update failures are non-fatal to data collection. The worker:

- records the failed phase, exit code, timeout, and a bounded output tail;
- releases its lock;
- preserves or restores the last working stable agent;
- never changes the active installation record itself;
- never displays an interactive error.

The self-update timestamp prevents failure storms. A failed scheduled check may
retry at the next configured interval; normal Claude and Codex collection
continues with the existing stable agent.

## Verification

Automated tests must cover:

- active-record selection instead of highest cache-directory selection;
- rejection of missing, mismatched, or incomplete cache entries;
- deterministic tree digests independent of directory enumeration order;
- synchronization when timestamps are equal but contents differ;
- no replacement when complete hashes match;
- successful staged activation with exact source/stable hashes;
- rollback when staging or activation fails;
- lock exclusion for concurrent workers;
- the update command order: marketplace first, plugin second, activation last;
- timeouts and non-interactive Git/SSH environment;
- SessionStart two-hour throttling and scheduled 24-hour fallback;
- Windows VBS lexical validity and hidden process options.

`win-verify.cjs` must perform an end-to-end machine check:

- run the official marketplace and plugin update;
- resolve the active record again after updating;
- validate the manifest and required files;
- activate the stable copy through the production worker;
- compare every cached-agent and stable-agent SHA-256 value;
- validate and execute both VBS launchers without a modal dialog;
- run the scheduled task and verify it does not remain running;
- report each layer separately rather than declaring success from a version
  string alone.

## Success Criteria

- A plugin update is not considered complete until the active cache and stable
  agent have identical tree digests.
- Later releases activate automatically after download without requiring a new
  Claude session or a user command.
- A daily scheduled fallback works when Claude is not opened.
- Update and synchronization never create a visible window or prompt.
- Any failure preserves the last working code and does not interrupt
  collection.
- The Windows verifier can distinguish marketplace refresh, plugin download,
  cache activation, stable synchronization, trigger repair, and hidden
  execution as separate pass/fail results.
