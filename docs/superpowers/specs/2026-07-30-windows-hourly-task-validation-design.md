# Windows Hourly Task Validation Design

## Problem

`VantageCodexHourly` can be created through two Windows paths:

- the preferred task XML uses `<ScheduleByHour>`;
- the `schtasks /SC HOURLY` fallback is exported as `<Repetition><Interval>PT1H</Interval></Repetition>`.

The current self-check only accepts `<ScheduleByHour>`. A valid fallback task is therefore deleted and recreated every time it runs. Re-creation resets Task Scheduler history, producing `Last Run Time` 1999-11-30 and `Last Result` `0x41303` even though `reconcile.cjs` ran.

## Scope

Fix only Windows hourly-task validation and its regression coverage. Do not change the VBS launcher, update mechanism, collection cadence, or non-Windows schedulers in this change.

## Design

Extract a pure `isValidHourlyTaskXml(xml, runVbs)` function from `installWindowsCodexTrigger`.

The task is valid only when all of these conditions hold:

1. The schedule is hourly, represented by either:
   - `<ScheduleByHour>`, or
   - `<Repetition>` containing `<Interval>PT1H</Interval>`.
2. `<StartWhenAvailable>true</StartWhenAvailable>` is present.
3. The action executes `wscript.exe`.
4. The action references the expected `run-reconcile.vbs` path.

XML matching will tolerate namespace prefixes, whitespace, and case differences that Windows may introduce when exporting a task. It will not accept arbitrary repetition intervals such as `PT30M` or `PT2H`.

`installWindowsCodexTrigger` will use this function before deciding to delete and recreate the task. A valid CLI-exported hourly task will be left unchanged.

## Error Handling

If querying or decoding the task XML fails, preserve the existing behavior: treat the task as missing or invalid and recreate it. If XML is readable but does not meet every validation condition, recreate it.

## Testing

Add regression tests for:

- preferred `<ScheduleByHour>` XML;
- real Windows-style `<Repetition><Interval>PT1H</Interval></Repetition>` XML;
- namespace-prefixed and whitespace-varied Windows XML;
- rejection of `PT30M` and `PT2H`;
- rejection when `StartWhenAvailable` is absent or false;
- rejection when `wscript.exe` or the expected VBS path is absent;
- source-level verification that `installWindowsCodexTrigger` calls the shared validator rather than checking only for `<ScheduleByHour>`.

Run the full agent suite after the focused red-green cycle. On Windows, verify two consecutive task runs no longer log task reconstruction and that Task Scheduler retains `Last Run Time` with `Last Result` `0`.

## Success Criteria

- A Windows-exported `PT1H` task is accepted as valid.
- Repeated self-checks do not delete and recreate a valid hourly task.
- Invalid schedules and incorrect actions are still repaired.
- Existing tests remain green.
