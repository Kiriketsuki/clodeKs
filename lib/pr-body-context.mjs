export const PR_BODY_CONTEXT = `clodeKs PR body guidance

If the caller authorizes a GitHub PR write, put the exact intended body in a private per-run file.
Use a fresh private directory from mktemp -d under an authorized writable folder. Never reuse a shared body file path.
Pass that file with --body-file. Pass -R OWNER/REPO on every gh pr edit, create, and view command.
Check the published body after create and before merge with gh pr view NUMBER -R OWNER/REPO --json body.
Compare the full body and closing issue references with the intended file. If they differ, stop and report the mismatch.
Keep the intended file until the required checks finish. If run cleanup would delete it first, give the caller the exact body.
The caller must retain that body in its own private file and check it before merge.
These instructions guide the worker. They do not mechanically enforce PR checks.
This guidance grants no extra permissions or merge authority.`
