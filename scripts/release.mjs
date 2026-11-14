// Cut a release: bump the version, commit "Release x.y.z", tag vx.y.z, push.
// The tag starts .github/workflows/release.yml, which tests and publishes to npm.
//   npm run release            a patch release
//   npm run release -- minor   or major, or an exact version like 1.0.0
import { execFileSync } from 'node:child_process'

const bump = process.argv[2] ?? 'patch'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const fail = (msg) => {
  console.error(`release: ${msg}`)
  process.exit(1)
}

if (!/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump)) fail(`"${bump}" is not patch, minor, major or a version`)
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to main first')
if (git('status', '--porcelain')) fail('commit or stash your changes first')
git('fetch', 'origin', 'main')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('main is behind origin/main; pull first')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tag = execFileSync(npm, ['version', bump, '-m', 'Release %s'], { encoding: 'utf8' }).trim()
execFileSync('git', ['push', 'origin', 'main', tag], { stdio: 'inherit' })
console.log(`pushed ${tag}; GitHub Actions publishes it to npm once the tests pass`)
