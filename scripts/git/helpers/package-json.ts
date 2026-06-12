#!/usr/bin/env bun
//
// package-json.ts — read and write the top-level package.json version. The
// write rewrites ONLY the version string via a targeted replace so the file's
// formatting (indentation, key order, trailing newline) is preserved — a full
// JSON.parse/stringify round-trip would reflow the whole file.

const PACKAGE_JSON = 'package.json'
const VERSION_FIELD = /("version":\s*")([^"]*)(")/

export async function readPackageVersion(): Promise<string | undefined> {
  const pkg = (await Bun.file(PACKAGE_JSON).json()) as { version?: string }
  return pkg.version
}

/**
 * Set the top-level version. Returns true when the file changed, false when it
 * was already at `version`. Throws if package.json has no version field.
 */
export async function writePackageVersion(version: string): Promise<boolean> {
  const text = await Bun.file(PACKAGE_JSON).text()
  const match = VERSION_FIELD.exec(text)
  if (match === null) {
    throw new Error('package.json has no top-level "version" field to bump')
  }
  if (match[2] === version) return false
  await Bun.write(PACKAGE_JSON, text.replace(VERSION_FIELD, `$1${version}$3`))
  return true
}
