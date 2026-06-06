import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

const INTEGRATION_ROOT = 'tests/integration'
const EXCLUDED_DIRS = new Set(['real-tmux'])

interface PackageJson {
  readonly scripts?: Record<string, string>
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson
}

function listedIntegrationDirs(testIntScript: string): readonly string[] {
  return [
    ...new Set(
      testIntScript
        .split(/\s+/)
        .filter((part) => part.startsWith(`${INTEGRATION_ROOT}/`))
        .map((part) => part.slice(`${INTEGRATION_ROOT}/`.length).split('/')[0])
        .filter((dir) => dir.length > 0),
    ),
  ].sort()
}

function filesystemIntegrationDirs(): readonly string[] {
  if (!existsSync(INTEGRATION_ROOT)) return []
  return readdirSync(INTEGRATION_ROOT)
    .filter((name) => !EXCLUDED_DIRS.has(name))
    .filter((name) => statSync(`${INTEGRATION_ROOT}/${name}`).isDirectory())
    .sort()
}

const testIntScript = readPackageJson().scripts?.['test:int']
if (testIntScript === undefined) {
  console.error('package.json is missing scripts.test:int')
  process.exit(1)
}

const listed = listedIntegrationDirs(testIntScript)
const actual = filesystemIntegrationDirs()

const missing = actual.filter((dir) => !listed.includes(dir))
const stale = listed.filter((dir) => !actual.includes(dir))
const excludedButListed = listed.filter((dir) => EXCLUDED_DIRS.has(dir))

if (missing.length === 0 && stale.length === 0 && excludedButListed.length === 0) {
  process.exit(0)
}

console.error('scripts.test:int does not match tests/integration directories.')
if (missing.length > 0) {
  console.error(`Missing from test:int: ${missing.map((dir) => `${INTEGRATION_ROOT}/${dir}`).join(', ')}`)
}
if (stale.length > 0) {
  console.error(`Listed but not present: ${stale.map((dir) => `${INTEGRATION_ROOT}/${dir}`).join(', ')}`)
}
if (excludedButListed.length > 0) {
  console.error(`Excluded dirs must stay out of test:int: ${excludedButListed.join(', ')}`)
}
console.error(`Excluded dirs: ${[...EXCLUDED_DIRS].sort().join(', ')}`)
process.exit(1)
