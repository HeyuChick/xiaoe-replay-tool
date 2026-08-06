#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const HELP = `
Usage:
  node rename-downloads.mjs --manifest path/to/manifest.json --out path/to/downloads

Renames downloaded folders to "<NN>-<title>-<alive_id>" using the order in manifest.json.
`;

function parseArgs(argv) {
  const opts = { manifest: "manifest.json", out: ".", help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest": opts.manifest = argv[++i]; break;
      case "--out": opts.out = argv[++i]; break;
      case "--help": opts.help = true; break;
      default:
        if (argv[i].startsWith("-")) throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return opts;
}

function sanitizeName(value) {
  return String(value || "replay")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function rewriteOutputPath(oldDir, newDir, outputPath) {
  if (!outputPath) return outputPath;
  const normalizedOld = path.resolve(oldDir);
  const normalizedNew = path.resolve(newDir);
  const absoluteOutput = path.resolve(outputPath);
  if (absoluteOutput === normalizedOld || absoluteOutput.startsWith(normalizedOld + path.sep)) {
    const suffix = absoluteOutput.slice(normalizedOld.length);
    return normalizedNew + suffix;
  }
  return outputPath;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const manifestRaw = await fs.readFile(opts.manifest, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const width = Math.max(2, String(Math.max(0, manifest.length - 1)).length);
  const renamed = [];
  const missing = [];

  for (let index = 0; index < manifest.length; index++) {
    const entry = manifest[index];
    const prefix = String(index).padStart(width, "0");
    const title = sanitizeName(entry.title || entry.alive_id);
    const resourceId = entry.alive_id || entry.resource_id;
    const newDir = path.join(opts.out, `${prefix}-${title}-${resourceId}`);

    const candidates = [];
    if (entry.dir) candidates.push(entry.dir);
    candidates.push(path.join(opts.out, `${title}-${resourceId}`));

    let oldDir = null;
    for (const candidate of candidates) {
      if (candidate === newDir) continue;
      if (await pathExists(candidate)) {
        oldDir = candidate;
        break;
      }
    }

    if (!oldDir) {
      const entries = await fs.readdir(opts.out, { withFileTypes: true });
      for (const item of entries) {
        if (!item.isDirectory()) continue;
        const full = path.join(opts.out, item.name);
        if (full === newDir) continue;
        if (item.name.endsWith(`-${resourceId}`)) {
          oldDir = full;
          break;
        }
      }
    }

    entry.index = index;
    entry.prefix = prefix;
    entry.dir = newDir;

    if (oldDir && oldDir !== newDir) {
      if (await pathExists(newDir)) {
        console.log(`SKIP ${index}: target exists ${newDir}`);
        entry.dir = newDir;
        continue;
      }
      await fs.rename(oldDir, newDir);
      entry.output_ts = rewriteOutputPath(oldDir, newDir, entry.output_ts);
      entry.output_mp4 = rewriteOutputPath(oldDir, newDir, entry.output_mp4);
      entry.output_html = rewriteOutputPath(oldDir, newDir, entry.output_html);
      renamed.push({ index, oldDir, newDir });
    } else if (!(await pathExists(newDir))) {
      missing.push({ index, newDir });
    }
  }

  await fs.writeFile(opts.manifest, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Renamed ${renamed.length} folder(s), missing ${missing.length}`);
  for (const item of renamed) {
    console.log(`${item.index}: ${item.oldDir} -> ${item.newDir}`);
  }
  for (const item of missing) {
    console.log(`MISSING ${item.index}: ${item.newDir}`);
  }
  console.log(`Manifest updated: ${opts.manifest}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
