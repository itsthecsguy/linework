// Cut a release: bump the version, commit "Release x.y.z", tag vx.y.z, push.
// The tag starts .github/workflows/release.yml, which tests and publishes to npm.
//   npm run release            a patch release
//   npm run release -- minor   or major, or an exact version like 1.0.0
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const bump = process.argv[2] ?? 'patch'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const fail = (msg) => {
  console.error(`release: ${msg}`)
  process.exit(1)
}
const updateFile = (file, re, replacement) => {
  const before = fs.readFileSync(file, 'utf8')
  if (!re.test(before)) fail(`could not find version reference to update in ${file}`)
  fs.writeFileSync(file, before.replace(re, replacement))
}

if (!/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump)) fail(`"${bump}" is not patch, minor, major or a version`)
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to main first')
if (git('status', '--porcelain')) fail('commit or stash your changes first')
git('fetch', 'origin', 'main')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('main is behind origin/main; pull first')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Node won't start a .cmd file without a shell.
const tag = execFileSync(npm, ['version', bump, '--no-git-tag-version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
const version = tag.replace(/^v/, '')

updateFile('action.yml', /(^\s*version:\n(?:\s+description:.*\n)?\s+default:\s*)\S+/m, `$1${version}`)
updateFile('README.md', /uses: itsthecsguy\/linework@v\d+\.\d+\.\d+(?:-[\w.]+)?/g, `uses: itsthecsguy/linework@${tag}`)

const files = ['package.json', 'action.yml', 'README.md']
if (fs.existsSync('package-lock.json')) files.push('package-lock.json')
git('add', ...files)
git('commit', '-m', `Release ${version}`)
git('tag', '-a', tag, '-m', `Release ${version}`)
execFileSync('git', ['push', 'origin', 'main', tag], { stdio: 'inherit' })
console.log(`pushed ${tag}; GitHub Actions publishes it to npm once the tests pass`)
