// Codex 0.169.0 value options can precede a subcommand. Their values are not commands.
const VALUE_FLAGS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-m', '--model', '--local-provider', '-p', '--profile',
  '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
])

function firstTuiPositional(args) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') return null
    if (!arg.startsWith('-') || arg === '-') return arg
    if (arg === '--image' || arg.startsWith('--image=') || arg.startsWith('-i')) {
      while (index + 1 < args.length && !args[index + 1].startsWith('-')) index++
      continue
    }
    const flag = arg.split('=', 1)[0]
    if (VALUE_FLAGS.has(flag) && !arg.includes('=')) index++
  }
  return null
}

// Pinned hidden commands and aliases do not appear in the normal CLI help.
const EXTRA_COMMANDS = new Set([
  'cloud-tasks', 'execpolicy', 'git-credential', 'stdio-to-uds',
  'tcp-tunnel', 'responses-api-proxy',
  ...(['darwin', 'win32'].includes(process.platform) ? ['app'] : []),
])

export function hasTuiSubcommand(args, commands) {
  return tuiSubcommand(args, commands) !== null
}

export function tuiSubcommand(args, commands) {
  const command = firstTuiPositional(args)
  return commands.has(command) || EXTRA_COMMANDS.has(command) ? command : null
}
