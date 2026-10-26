/**
 * Resolve the `dsh` entry point the verify suites spawn.
 *
 * Why this file exists: `pnpm add @deepseek-ai/dsh` links the package as a
 * junction/symlink at `node_modules/@deepseek-ai/dsh`, but Node resolves an
 * *entry point* by the path it was given — it does not follow the link first.
 * So a child spawned on the junction path imports `@deepseek-ai/dsh-app-boot`
 * from the flat root, where only the direct dependency exists, and dies with
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-app-boot'
 *
 * even though the package is perfectly installed. The same `dsh --version`
 * still works (it never imports app-boot), which makes this look like a
 * profile-compose bug rather than a path bug. Realpath-ing the entry point
 * puts module resolution inside pnpm's virtual store, where the dependencies
 * actually are.
 *
 * A hoisted/flat install (`node-linker=hoisted`, or plain npm) resolves fine
 * either way, so realpath is safe there too.
 */
import fs from 'node:fs'
import path from 'node:path'

const USAGE = [
  'tried: $DSH_BIN, then <repo>/node_modules/@deepseek-ai/dsh/lib/bin.js',
  'install one first:',
  '  pnpm add @deepseek-ai/dsh@0.2.1-rc.2',
  '  DSH_BIN=$PWD/node_modules/@deepseek-ai/dsh/lib/bin.js npm run verify',
  'The packaged desktop build (dsh.cmd) does not work: it runs from asar.',
  'See verify/README.md.',
].join('\n  ')

/**
 * @param {string | undefined} value  `DSH_BIN`, if set
 * @param {string[]} fallbacks        paths to try when it is not set
 * @returns {string} a real, spawnable path to `lib/bin.js`
 */
export function resolveDshBin (value, fallbacks = []) {
  // Accept the package directory as well as the bin file: people reasonably
  // try both, and "not found" is not a useful answer.
  const candidates = [...(value ? [value] : []), ...fallbacks]
    .flatMap((candidate) => [candidate, path.join(candidate, 'lib', 'bin.js')])

  const found = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile() } catch (err) { return false }
  })
  if (!found) {
    throw new Error(`${value ? `DSH_BIN does not exist: ${value}` : 'DSH_BIN is not set and no local dsh was found.'}\n  ${USAGE}`)
  }

  // The fix for the junction problem described at the top of this file.
  //
  // `realpathSync.native` and not plain `realpathSync`: pnpm links packages as
  // Windows *junctions*, which the JS implementation leaves untouched (and
  // `lstat().isSymbolicLink()` reports false for), so only the native call
  // actually returns the store path.
  try {
    return fs.realpathSync.native(found)
  } catch (err) {
    return fs.realpathSync(found)
  }
}
