import { verifyNamedPermissions } from './permission-check.mjs'

export function temporaryFilesystem(opts) {
  return opts.sandbox === 'read-only' && opts.tempDir
    ? `,filesystem={${JSON.stringify(opts.tempDir)}="write"}` : ''
}

export function readonlyTempSettings(opts) {
  const profile = opts.permissionProfile
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9_]+$/.test(profile)) {
    throw new Error('Private temporary folder requires a unique profile name')
  }
  return [
    `default_permissions=${JSON.stringify(profile)}`,
    `permissions.${profile}={extends=":read-only"${temporaryFilesystem(opts)},network={enabled=false}}`,
    'features.use_legacy_landlock=false',
  ]
}

export async function verifyReadonlyTemp(codex, cwd, settings, env) {
  await verifyNamedPermissions(codex, cwd, settings, env, 'Private temporary folder')
}
