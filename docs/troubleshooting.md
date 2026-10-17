# Troubleshooting

## Codex sandbox unavailable on this host

Ordewell shows **Codex sandbox unavailable on this host: read-only and Guarded
modes are off**, and Codex tasks in a read-only or Guarded mode are refused.

### Cause

Codex's Linux sandbox is bubblewrap (`bwrap`), which needs unprivileged user
namespaces. On Ubuntu 23.10 and later, AppArmor can restrict them
(`kernel.apparmor_restrict_unprivileged_userns=1`, on by default from Ubuntu
24.04), and a stock install has no profile that lets `bwrap` use them. Many
containers restrict them as well. Codex's older Landlock backend did not start
on codex-cli 0.162 either.

On such a host, Ordewell probes the sandbox once per daemon. While it cannot
start:

- Codex's sandboxed modes, read-only (`plan`) and Guarded (`agent`), are off.
  Its Full access mode is not sandboxed and stays available.
- The planner is not offered a read-only task on Codex, and a plan or an edit
  that puts a task in one of those modes is refused with the reason. A task
  already in one fails at start with the same reason. Ordewell never swaps the
  mode for another.
- A Codex planner still plans: its own shell is off and it reads through
  Ordewell's `run_command` ([ADR-0033](adr/0033-codex-planner-without-its-sandbox.md)).

### Check it

```bash
bwrap --ro-bind / / true          # no output means bubblewrap can start
codex sandbox -- /bin/true        # the check Ordewell runs; exit status 0 means it works
sysctl kernel.apparmor_restrict_unprivileged_userns
```

`bwrap` printing `loopback: Failed RTM_NEWADDR` or `Operation not permitted`
confirms the cause. A `sysctl` value of `1` points at AppArmor.

### Fix: the narrow one (an AppArmor profile for `bwrap`)

On Ubuntu 24.04 the `apparmor` package carries a profile that lets `bwrap`
create user namespaces, but does not install it:

```bash
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Later Ubuntu releases may ship it already loaded; check before installing it.
A profile applies to one binary path. If Codex runs a `bwrap` of its own rather
than `/usr/bin/bwrap`, the profile has to name that path instead.

### Fix: the wide one (the system-wide sysctl)

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This lifts the restriction for every program on the machine, which is why the
profile above is the better choice. It lasts until reboot; to keep it, put the
setting in a file under `/etc/sysctl.d/`.

### After the fix

Check again with the commands above, then restart the Ordewell daemon, or run
`ordewell runners` (or refresh the runner list in VS Code). Ordewell asks the
host again when the runner list is refreshed, and always on a daemon restart.
Tasks planned while the modes were off keep the mode the plan gave them.

### Without a fix

Give the task Full access, or assign it to another runner. Full access means
Codex runs with no sandbox at all.

## Merge all refused: not on the base branch

Ordewell shows **Merged nothing, so every tree is as it was: … is on `<branch>`;
this run started on `<base>`**, and the handoff stays.

### Cause

Merge all lands each repository's integration branch into whatever that
repository has checked out, so it insists every repository of the run, with work
or not, is on the branch the run started on
([ADR-0042](adr/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)).
The handoff, `ordewell status` and the Merge confirmation name that branch (as
`main @ a1b2c3d`). In a group of repositories, one on the wrong branch keeps all
of them from merging.

### Fix

```bash
git -C <repo> branch --show-current   # empty means a detached HEAD
git -C <repo> switch <base>           # the branch the notice names
```

Then press Merge all again. Your uncommitted work stays where it is; if it
blocks the switch, commit or stash it first.

### Mid-rebase

If the notice says **in the middle of a rebase**, the rebase detached HEAD.
Finish it (`git rebase --continue`) or abort it (`git rebase --abort`) in the
repository named, check out the base branch, and merge again. A run that
started on a detached HEAD names no branch and is not checked.

## A runner shows as switched off, and tasks are flagged

A task row reads **codex is switched off** or **Opus 4 is not in the allowlist**,
and the planner mentions a `runners_changed` note.

The runner is off in your enabled runners, or the model is off its runner's
allowlist. The task is only flagged: it still runs as assigned, and Ordewell
moves nothing. Switch the runner back on (`/runners`, or **Ordewell: Toggle
Runner**), add the model to the allowlist, or move the task to another runner
or model yourself or ask the planner to
([ADR-0043](adr/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md)).

### Runner toggles are now shared between VS Code and the terminal UI

The enabled runners are saved in Ordewell's settings file, so a toggle in VS
Code is the list the terminal UI and the daemon plan with, and the reverse. A
list found in VS Code's old `ordewell.enabledRunners` setting is copied there
once, unless the file already holds a choice, and then cleared; an empty list
there is not copied. If a window shows an older list, refresh the runner list.

## The planner hit its usage limit

The transcript shows a failure line with the limit's reset time, and VS Code
shows **Resending at …** above the composer.

What you sent, and any supervisor wake-up, is kept and goes again as one turn a
minute after the reset
([ADR-0044](adr/0044-the-planners-usage-limit-waits-and-resends.md)). Anything
you send meanwhile is saved and goes with it. To stop the resend, use `/resend
cancel` in the terminal UI, `ordewell resend cancel`, or **Don't resend** in VS
Code: what waits then goes with your next message. If the planner did not say
when the limit resets, or hit it again right after a resend, or you moved the
planner to another runner, nothing is resent on its own: send a message once
the limit has reset.

## A task waits for your approval

A row reads **waits for your approval** and the scheduler skips it.

The planner added the task after you approved the plan, and autorun was off, so
nothing may start it until you approve it
([ADR-0035](adr/0035-effects-are-consented-and-recorded.md)). Approve it with
`f` in the terminal UI, `ordewell force-start <id>`, or its card in VS Code;
approve every waiting task with `/run` (or **Approve all** in VS Code). Neither
starts a task before its dependencies finish: it starts once they do, and the
answer says what it waits for. With nothing running, run the plan to start them.
With autorun on, tasks the planner adds in your turn need no approval.

## Continue is not offered after moving a task to another runner

A saved session belongs to the runner that made it and cannot be opened by
another. Use Retry: it starts a fresh session on the new runner with the earlier
runner's files restored
([ADR-0041](adr/0041-a-tasks-model-follows-the-runners-own-switch.md)).

## A task's model cannot be changed while it runs

Model and effort are locked while a task's runner is up. Stop the task, edit,
and continue, or use the runner's own `/model` in the task's chat: the plan then
follows it. A model the runner changed by itself is stated in the task log and
is not written to the plan.
