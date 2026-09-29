#!/usr/bin/env node
/**
 * A stand-in for LM Studio's `lms` for the mock profile: `ps [--json]`, `unload --all | <id>`, `load <key>`.
 * What is loaded is kept in .tmp/fake-lms.json in this repository (it starts with test/fixtures/lms-ps.json).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = process.env.FAKE_LMS_STATE ?? join(ROOT, '.tmp', 'fake-lms.json')
const FIXTURE = join(ROOT, 'test', 'fixtures', 'lms-ps.json')

const load = () => JSON.parse(readFileSync(existsSync(STATE) ? STATE : FIXTURE, 'utf8'))
const save = (models) => {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(models))
}

const [command, ...args] = process.argv.slice(2)
const models = load()
if (command === 'ps') {
  if (args.includes('--json')) console.log(JSON.stringify(models))
  else if (models.length === 0) console.log('No models are currently loaded')
  else for (const m of models) console.log(`${m.identifier}  ${(m.sizeBytes / 1e9).toFixed(2)} GB  ${m.status}`)
} else if (command === 'unload') {
  const kept = args.includes('--all') ? [] : models.filter((m) => !args.includes(m.identifier))
  for (const m of models.filter((m) => !kept.includes(m))) console.log(`Unloaded "${m.identifier}"`)
  save(kept)
} else if (command === 'load') {
  const key = args.find((a) => !a.startsWith('-'))
  if (!key) {
    console.error('Error: no model given')
    process.exit(1)
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))[0]
  save([...models.filter((m) => m.identifier !== key), { ...fixture, identifier: key, modelKey: key, status: 'idle' }])
  console.log(`Model loaded: ${key}`)
} else {
  console.error(`lms: unknown command ${command ?? ''}`)
  process.exit(1)
}
