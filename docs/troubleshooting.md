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
  Ordewell's `run_command` ([ADR-0033](adr/planner-envelope/0033-codex-planner-without-its-sandbox.md)).

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
