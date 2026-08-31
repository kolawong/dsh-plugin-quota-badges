#!/usr/bin/env node
/**
 * dsh-plugin-quota-badges — one-shot settings migration.
 *
 * The plugin was renamed from `opencode-quota` to `quota-badges`; the settings
 * document may still carry a user section under the legacy key. The settings
 * seam only reads *registered* namespaces, so the legacy section is not
 * reachable through the service API — this script migrates it at the document
 * level instead. It is idempotent: re-running after a successful migration is
 * a no-op (the legacy key is gone), and it never touches the new key when one
 * already exists.
 *
 * Usage:
 *   node scripts/migrate-legacy-settings.mjs [path-to-settings.yaml]
 *
 * Default path: $DSH_HOME/settings.yaml ($DSH_HOME falls back to ~/.dsh),
 * matching the dsh-settings-file default.
 *
 * The document is edited with the `yaml` library's Document API (parse +
 * setIn/deleteIn on the raw AST), the same approach dsh-settings-file itself
 * uses, so comments and formatting are preserved. The running web server's
 * settings-file watcher hot-publishes the change without a restart.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * The `yaml` library is a peer of the harness (dsh-settings-file uses it), not
 * of this plugin. Resolve it from DSH_YAML_PATH, the harness checkout, or the
 * running web profile's node_modules, in that order.
 */
const YAML_CANDIDATES = [
  process.env.DSH_YAML_PATH,
  '/root/deepseek-harness/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml',
  '/root/deepseek-harness/node_modules/yaml',
  '/root/.dsh/profiles/web/node_modules/yaml',
].filter(Boolean)

async function resolveYaml() {
  for (const candidate of YAML_CANDIDATES) {
    if (existsSync(join(candidate, 'package.json'))) {
      return import(candidate + '/dist/index.js')
    }
  }
  // Last resort: let Node resolve from the current directory.
  return import('yaml')
}

const LEGACY_NS = 'opencode-quota'
const NEW_NS = 'quota-badges'

function defaultPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'settings.yaml')
}

async function main() {
  const { parseDocument } = await resolveYaml()
  const path = resolve(process.argv[2] ?? defaultPath())
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[migrate] settings document not found (${path}); nothing to migrate.`)
      return
    }
    throw error
  }

  const doc = parseDocument(text)
  const root = doc.get('') // the document root map
  if (root === null) {
    console.log(`[migrate] settings document at ${path} is empty; nothing to migrate.`)
    return
  }

  const legacy = doc.getIn([LEGACY_NS])
  const existingNew = doc.getIn([NEW_NS])

  if (legacy === undefined || legacy === null) {
    console.log(`[migrate] no legacy "${LEGACY_NS}" section; nothing to migrate (idempotent no-op).`)
    return
  }

  if (existingNew !== undefined) {
    console.error(
      `[migrate] ABORT: both "${LEGACY_NS}" and "${NEW_NS}" sections exist. ` +
      `Refusing to overwrite; merge manually, then remove "${LEGACY_NS}".`,
    )
    process.exitCode = 1
    return
  }

  if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) {
    console.error(`[migrate] ABORT: legacy "${LEGACY_NS}" section is not an object; refusing to migrate a malformed value.`)
    process.exitCode = 1
    return
  }

  // Move the whole section: set the new key from the legacy AST node, then
  // delete the legacy key. Operating on the AST keeps comments and anchors.
  const legacyNode = doc.getIn([LEGACY_NS], true)
  doc.setIn([NEW_NS], legacyNode)
  doc.deleteIn([LEGACY_NS])

  await writeFile(path, doc.toString())
  console.log(`[migrate] migrated "${LEGACY_NS}" -> "${NEW_NS}" in ${path}`)
  console.log('[migrate] the settings-file watcher hot-publishes this; no restart needed.')
}

main().catch((error) => {
  console.error('[migrate] failed:', error)
  process.exitCode = 1
})