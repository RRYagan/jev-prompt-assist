#!/usr/bin/env node
// Download the open ASD-STE100 (Issue 9) dataset into the plugin's private
// config dir. The dictionary/rule text is (c) ASD and is NOT redistributable, so
// it is fetched at install time and kept OUTSIDE this MIT-licensed repo.
//
// Source: github.com/sanadaridah/Simplified-Technical-English-for-Agent-Output-ASD-ST100-
//         (its code is MIT; the dictionary/rule text is ASD copyright)
//
// Usage:
//   node scripts/ste100-fetch.mjs [--out <dir>] [--force]
// Default out: ~/.config/opencode/jev/ste100
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const REPO = "sanadaridah/Simplified-Technical-English-for-Agent-Output-ASD-ST100-"
const BRANCH = "main"
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`
const FILES = [
  ["scripts/dictionary.json", "dictionary.json"],
  ["scripts/glossary.example.txt", "glossary.example.txt"],
]

const argv = process.argv.slice(2)
const outIdx = argv.indexOf("--out")
const outDir =
  outIdx >= 0 && argv[outIdx + 1]
    ? argv[outIdx + 1]
    : join(homedir(), ".config", "opencode", "jev", "ste100")
const force = argv.includes("--force")

function human(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

mkdirSync(outDir, { recursive: true })
console.log(`ste100: target ${outDir}`)

let ok = 0
for (const [remote, local] of FILES) {
  const dest = join(outDir, local)
  if (existsSync(dest) && !force) {
    console.log(`ste100: skip ${local} (exists, ${human(statSync(dest).size)}); use --force to refetch`)
    ok++
    continue
  }
  const url = BASE + remote
  try {
    const res = await fetch(url, { redirect: "follow" })
    if (!res.ok) {
      console.error(`ste100: FAILED ${remote} -> HTTP ${res.status}`)
      continue
    }
    const body = Buffer.from(await res.arrayBuffer())
    // Validate JSON before writing so a bad download never becomes the loader's input.
    if (local.endsWith(".json")) JSON.parse(body.toString("utf8"))
    writeFileSync(dest, body, { mode: 0o600 })
    console.log(`ste100: wrote ${local} (${human(body.length)})`)
    ok++
  } catch (cause) {
    console.error(`ste100: FAILED ${remote}: ${String(cause)}`)
  }
}

if (ok === 0) {
  console.error(
    "\nste100: nothing installed. Options:\n" +
      "  - run this again with network access\n" +
      "  - clone the repo and use scripts/ste100-import.mjs <path|file>\n" +
      "  - build from the official PDF with scripts/ste100-extract.mjs <pdf>",
  )
  process.exit(1)
}
console.log(`ste100: done (${ok}/${FILES.length} files). Restart opencode to load.`)
