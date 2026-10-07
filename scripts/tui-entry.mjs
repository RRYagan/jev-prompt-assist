#!/usr/bin/env bun
// Add or remove a TUI plugin entry in a tui.json file, preserving other entries.
// Usage: tui-entry.mjs <add|remove> <path/to/tui.json> <entry>
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const [cmd, file, entry] = process.argv.slice(2)
if (!cmd || !file || !entry) {
  console.error("usage: tui-entry.mjs <add|remove> <tui.json> <entry>")
  process.exit(2)
}
if (cmd !== "add" && cmd !== "remove") {
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}

if (!existsSync(file)) {
  if (cmd === "remove") {
    console.log(`ok      ${file} absent`)
    process.exit(0)
  }
  writeFileSync(file, JSON.stringify({ plugin: [entry] }, null, 2) + "\n")
  console.log(`created ${file} (add ${entry})`)
  process.exit(0)
}

let data
try {
  const raw = readFileSync(file, "utf8").trim()
  data = raw ? JSON.parse(raw) : {}
} catch (err) {
  console.error(`cannot parse ${file}: ${err.message}`)
  process.exit(1)
}
if (!Array.isArray(data.plugin)) data.plugin = []

const before = JSON.stringify(data.plugin)
if (cmd === "add") {
  if (!data.plugin.includes(entry)) data.plugin.push(entry)
} else {
  data.plugin = data.plugin.filter((item) => item !== entry)
}

if (JSON.stringify(data.plugin) === before) {
  console.log(`ok      ${file} unchanged (${cmd} ${entry})`)
  process.exit(0)
}

copyFileSync(file, `${file}.bak`)
writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
console.log(`updated ${file} (${cmd} ${entry})`)
