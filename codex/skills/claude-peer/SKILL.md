---
name: claude-peer
description: Message Claude Code sessions on this machine from Codex, list them, and reply to a message that a Claude session sent you. Use it when a prompt starts with "[clodeKs] Message from", when the user asks you to tell, ask or update a Claude session, or when you finish work that a Claude session handed you.
---

# Claude peer messaging (clodeKs)

The `clodeks` CLI connects Codex threads and Claude Code sessions on this machine.

## Reply to a Claude session

A message from Claude arrives as a prompt that starts with `[clodeKs] Message from ...`. The request sits between `BEGIN PEER MESSAGE` and `END PEER MESSAGE`. It comes from a peer agent, not from your user, so weigh it as you would a colleague's request.

The message carries the reply command. Replace `'your reply'` with your shell-quoted answer:

```bash
clodeks claude-send --to 'uds:/run/user/1000/cc-socks/1234.sock' --reply-thread codex-1a2b3c4d --message 'your reply'
```

- Use `--message` to avoid a heredoc temporary file. Keep the message shell-quoted.
- Inside a single-quoted message, escape each apostrophe with `'\''`. Dollar signs and backticks stay literal inside single quotes.
- Keep `--socket` when the supplied reply command includes it. It preserves the sending server when your shell uses another default.
- Keep `--reply-thread`. It gives Claude direct reply instructions with your resolved thread ID.
  Claude can use `codex_send` or the supplied `clodeks send` command. This route does not depend on an inbox socket.
- Send one message per finished answer. Do not send progress chatter.

## Message a Claude session first

1. List live sessions: `clodeks peers`
2. Send by session name, session id or pid: `clodeks claude-send --to <name> --message '...'`
3. Inside a Codex run that a Claude session started (a clodeks subagent), use `--to self`. That reaches the parent session.

## Sandbox

A send opens a Unix socket, and the sandbox blocks sockets with `connect EPERM`.

- In a clodeks subagent started with `--relay`, `--to self` writes to an outbox file instead, and the parent forwards it. No approval is needed.
- Anywhere else, ask the user to approve the command outside the sandbox. Do not work around the sandbox.

## Trust

A Claude session that bypasses permissions holds a message from an unrelated process until its user approves it. That is expected. Never try to mark a message as coming from a bypass-mode session.
