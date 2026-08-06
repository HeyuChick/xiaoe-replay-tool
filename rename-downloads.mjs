#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const HELP = `
Usage:
  node rename-downloads.mjs --manifest path/to/manifest.json --out path/to/downloads

Moves downloaded folders into:
  <out>/live_replays/<NN>-<title>-<alive_id>
  <out>/image_text/<NN>-<title>-<resource_id>

Each category has its own 00/01/02... numbering.
`;

const CATEGORY_DIRS = {
  live: "live_replays",
  "image-text": "image_text",
};

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
  return String(value || "resource")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function categoryOf(entry) {
  if (entry.category === "live" || entry.category === "image-text") return entry.category;
  return Number(entry.resource_type) === 1 ? "image-text" : "live";
}

function resourceIdOf(entry) {
  return entry.alive_id || entry.resource_id;
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

async function findDirectoryByResourceId(out, categoryDir, resourceId) {
  const roots = [out, path.join(out, categoryDir)];
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of entries) {
      if (!item.isDirectory()) continue;
      if (item.name.endsWith(`-${resourceId}`)) {
        return path.join(root, item.name);
      }
    }
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const manifestRaw = await fs.readFile(opts.manifest, "utf8");
  const manifest = JSON.parse(manifestRaw);
  const counters = { live: 0, "image-text": 0 };

  for (const entry of manifest) {
    entry.category = categoryOf(entry);
    entry.prefix = String(counters[entry.category]++).padStart(2, "0");
  }

  const renamed = [];
  const missing = [];
  for (let index = 0; index < manifest.length; index++) {
    const entry = manifest[index];
    const category = entry.category;
    const prefix = entry.prefix;
    const resourceId = resourceIdOf(entry);
    const title = sanitizeName(entry.title || resourceId);
    const categoryDir = CATEGORY_DIRS[category];
    const newDir = path.join(opts.out, categoryDir, `${prefix}-${title}-${resourceId}`);

    const candidates = [];
    if (entry.dir) candidates.push(entry.dir);
    candidates.push(newDir);
    candidates.push(path.join(opts.out, `${prefix}-${title}-${resourceId}`));
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
      oldDir = await findDirectoryByResourceId(opts.out, categoryDir, resourceId);
    }

    entry.index = index;
    entry.prefix = prefix;
    entry.dir = newDir;

    if (oldDir && oldDir !== newDir) {
      if (await pathExists(newDir)) {
        console.log(`SKIP ${index}: target exists ${newDir}`);
        continue;
      }
      await fs.mkdir(path.dirname(newDir), { recursive: true });
      await fs.rename(oldDir, newDir);
      entry.output_ts = rewriteOutputPath(oldDir, newDir, entry.output_ts);
      entry.output_mp4 = rewriteOutputPath(oldDir, newDir, entry.output_mp4);
      entry.output_html = rewriteOutputPath(oldDir, newDir, entry.output_html);
      renamed.push({ index, oldDir, newDir });
    } else if (!(await pathExists(newDir))) {
      missing.push({ index, newDir });
    }
  }

  await fs.mkdir(path.join(opts.out, CATEGORY_DIRS.live), { recursive: true });
  await fs.mkdir(path.join(opts.out, CATEGORY_DIRS["image-text"]), { recursive: true });
  await fs.writeFile(opts.manifest, JSON.stringify(manifest, null, 2), "utf8");

  for (const category of ["live", "image-text"]) {
    const entries = manifest.filter((entry) => entry.category === category);
    await fs.writeFile(
      path.join(opts.out, CATEGORY_DIRS[category], "manifest.json"),
      JSON.stringify(entries, null, 2),
      "utf8",
    );
  }

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
