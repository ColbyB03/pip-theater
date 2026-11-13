// Builds out/pip-theater.zip in the layout Decky Loader expects:
//   pip-theater/
//     dist/index.js, main.py, plugin.json, package.json, LICENSE, README.md
//     backend/*.py, assets/player.html
//     bin/uxplay-steamos/...   (the AirPlay receiver, when it has been built: see receiver/)
// No dependencies: a tiny ZIP writer on top of Node's zlib.
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const folder = "pip-theater";
const files = [
  "dist/index.js",
  "main.py",
  "plugin.json",
  "package.json",
  "LICENSE",
  "README.md",
  "backend/overlay_helper.py",
  "backend/mirror.py",
  "backend/h264.py",
  "assets/player.html",
];

for (const f of files) {
  if (!existsSync(join(root, f))) {
    console.error(`Missing ${f}. Run "npm run build" first.`);
    process.exit(1);
  }
}

// The AirPlay receiver is built separately (receiver/build-uxplay.sh, or the release workflow).
const receiver = "bin/uxplay-steamos";
function walk(rel) {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const child = `${rel}/${name}`;
    if (statSync(join(root, child)).isDirectory()) walk(child);
    else files.push(child);
  }
}
if (existsSync(join(root, receiver, "uxplay")) && existsSync(join(root, receiver, "VERSION"))) {
  walk(receiver);
} else {
  console.warn(`WARNING: ${receiver} is missing. This ZIP will have no AirPlay receiver: phone mirroring`);
  console.warn("         will not work with it (streaming sites will). See receiver/build-uxplay.sh.");
}

const executable = (rel) => /(^|\/)(uxplay|run\.sh)$/.test(rel) || /\.so(\.|$)/.test(rel);

const entries = [];
const chunks = [];
let offset = 0;

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

for (const rel of files) {
  const data = readFileSync(join(root, rel));
  const name = Buffer.from(`${folder}/${rel}`, "utf8"); // always forward slashes
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const { time, date } = dosDateTime(statSync(join(root, rel)).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, name, compressed);
  entries.push({ name, crc, csize: compressed.length, size: data.length, time, date, offset, mode: executable(rel) ? 0o100755 : 0o100644 });
  offset += local.length + name.length + compressed.length;
}

const central = [];
let centralSize = 0;
for (const e of entries) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.csize, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt32LE((e.mode << 16) >>> 0, 38); // Unix permissions
  h.writeUInt32LE(e.offset, 42);
  central.push(h, e.name);
  centralSize += h.length + e.name.length;
}

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "out"), { recursive: true });
const outPath = join(root, "out", `${folder}.zip`);
writeFileSync(outPath, Buffer.concat([...chunks, ...central, end]));
console.log(`Wrote ${outPath} (${entries.length} files)`);
