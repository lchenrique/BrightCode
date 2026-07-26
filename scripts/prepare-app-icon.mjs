import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'

const sourcePath = process.argv[2]
if (!sourcePath) {
  throw new Error('Usage: node scripts/prepare-app-icon.mjs <source.png>')
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const buildDir = path.join(projectDir, 'build')
const publicDir = path.join(projectDir, 'public')
const appPng = path.join(buildDir, 'icon.png')

await Promise.all([
  mkdir(buildDir, { recursive: true }),
  mkdir(publicDir, { recursive: true }),
])

await Promise.all([
  copyFile(sourcePath, appPng),
  copyFile(sourcePath, path.join(publicDir, 'favicon.png')),
])

const ico = await pngToIco(appPng)
await writeFile(path.join(buildDir, 'icon.ico'), ico)

console.log(`Prepared application icons from ${sourcePath}`)
