#!/usr/bin/env node

import fs from "node:fs/promises";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_HOST = "";
const DEFAULT_APP_ID = "";
const DEFAULT_COURSE_ID = "";
const CATALOG_ENDPOINT =
  "/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/3.0.0";
const LOOKBACK_ENDPOINT = "/_alive/v3/get_lookback_list";
const IMAGE_TEXT_DETAIL_ENDPOINT = "/xe.course.business_go.get.detail/2.0.0";
const RICHTEXT_INFO_ENDPOINT = "/xe.richtext.info.get_by_signature.bath";
const RICHTEXT_MATERIAL_ENDPOINT = "/xe.richtext.material.info.get_by_signature.bath";
const LIVE_DIR = "live_replays";
const IMAGE_TEXT_DIR = "image_text";

const HELP = `
Usage:
  node download-replays.mjs [options]

Required login:
  --cookie "ko_token=..."          Cookie string accepted by the H5 backend
  --har path/to/request.har        Or extract ko_token/course/alive IDs from a HAR

Target:
  --course-id course_xxx           E-course/camp id used to enumerate live sessions
  --app-id appXXX                  Shop app id
  --host https://...               H5 origin
  --alive-ids l_1,l_2              Skip enumeration and download these alive ids
  --alive-ids-file file.txt        One alive id per line
  --resources all|live|image-text  Which resource types to download (default: all)

Download:
  --out ./downloads                Output directory
  --concurrency 8                  Segment download concurrency
  --max-segments 0                 Limit segments per replay (0 = all)
  --limit 0                        Limit number of resources (0 = all)
  --format ts|mp4                  Output format (default: mp4)
  --ffmpeg /path/to/ffmpeg         Optional explicit ffmpeg
  --force                          Re-download even when mp4 already exists
  --list-endpoint /path            Override catalog endpoint
  --lookback-endpoint /path        Override lookback endpoint
  --dry-run                        Only list replays
  --verbose
  --help
`;

function parseArgs(argv) {
  const opts = {
    host: DEFAULT_HOST,
    appId: DEFAULT_APP_ID,
    courseId: DEFAULT_COURSE_ID,
    cookie: "",
    har: "",
    aliveIds: [],
    aliveIdsFile: "",
    out: "downloads",
    concurrency: 8,
    maxSegments: 0,
    limit: 0,
    format: "mp4",
    ffmpeg: "",
    force: false,
    listEndpoint: CATALOG_ENDPOINT,
    lookbackEndpoint: LOOKBACK_ENDPOINT,
    resources: "all",
    dryRun: false,
    verbose: false,
    help: false,
    courseIdExplicit: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--host": opts.host = next(); break;
      case "--app-id": opts.appId = next(); break;
      case "--course-id":
        opts.courseId = next();
        opts.courseIdExplicit = true;
        break;
      case "--cookie": opts.cookie = next(); break;
      case "--har": opts.har = next(); break;
      case "--alive-ids":
        opts.aliveIds = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--alive-ids-file": opts.aliveIdsFile = next(); break;
      case "--out": opts.out = next(); break;
      case "--concurrency": opts.concurrency = Number(next()); break;
      case "--max-segments": opts.maxSegments = Number(next()); break;
      case "--limit": opts.limit = Number(next()); break;
      case "--format": opts.format = next().toLowerCase(); break;
      case "--ffmpeg": opts.ffmpeg = next(); break;
      case "--force": opts.force = true; break;
      case "--list-endpoint": opts.listEndpoint = next(); break;
      case "--lookback-endpoint": opts.lookbackEndpoint = next(); break;
      case "--resources": opts.resources = next().toLowerCase(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--help": opts.help = true; break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  if (opts.help) return opts;
  if (!opts.cookie && !opts.har && !process.env.XIAOE_COOKIE) {
    throw new Error("Missing login. Pass --cookie or --har, or set XIAOE_COOKIE.");
  }
  if (!opts.cookie && process.env.XIAOE_COOKIE) {
    opts.cookie = process.env.XIAOE_COOKIE;
  }
  if (opts.format !== "ts" && opts.format !== "mp4") {
    throw new Error("--format must be ts or mp4");
  }
  if (!["all", "live", "image-text"].includes(opts.resources)) {
    throw new Error("--resources must be all, live or image-text");
  }
  if (!opts.concurrency || opts.concurrency < 1) opts.concurrency = 1;
  return opts;
}

function log(opts, ...args) {
  if (opts.verbose) console.log(...args);
}

function sanitizeName(value) {
  return String(value || "replay")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractFromHar(harPath) {
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  const entries = har?.log?.entries || [];
  let koToken = "";
  let appId = "";
  let host = "";
  const courseIds = [];
  const aliveIds = [];

  for (const entry of entries) {
    const req = entry?.request || {};
    const url = String(req.url || "");
    if (!host) {
      const originMatch = url.match(/^https?:\/\/[^/]+/);
      if (originMatch) host = originMatch[0];
    }

    for (const header of req.headers || []) {
      const name = String(header.name || "").toLowerCase();
      const value = String(header.value || "");
      if (name === "ko-token" && value && !koToken) koToken = value;
      if (name === "cookie") {
        const m = value.match(/(?:^|;\s*)ko_token=([^;]+)/);
        if (m && !koToken) koToken = m[1];
      }
    }

    const koInUrl = url.match(/[?&]ko_token=([^&]+)/);
    if (koInUrl && !koToken) koToken = decodeURIComponent(koInUrl[1]);

    const appInUrl = url.match(/[?&]app_id=([^&]+)/);
    if (appInUrl && !appId) appId = decodeURIComponent(appInUrl[1]);

    const aliveInUrl = url.match(/\/v4\/course\/alive\/(l_[A-Za-z0-9]+)/);
    if (aliveInUrl) aliveIds.push(aliveInUrl[1]);
    const aliveQuery = url.match(/[?&]alive_id=(l_[A-Za-z0-9]+)/);
    if (aliveQuery) aliveIds.push(aliveQuery[1]);

    const courseInUrl =
      url.match(/\/p\/course\/ecourse\/(course_[A-Za-z0-9]{16,})/) ||
      url.match(/course_id["']?\s*[:=]\s*["']?(course_[A-Za-z0-9]{16,})/) ||
      url.match(/course_[A-Za-z0-9]{16,}/);
    if (courseInUrl) courseIds.push(courseInUrl[1] || courseInUrl[0]);

    const postText = String(req.postData?.text || "");
    const appInPost = postText.match(/app_id["']?\s*[:=]\s*["']?([A-Za-z0-9]+)/);
    if (appInPost && !appId) appId = appInPost[1];
    for (const m of postText.matchAll(/course_id["']?\s*[:=]\s*["']?(course_[A-Za-z0-9]{16,})/g)) {
      courseIds.push(m[1]);
    }
    for (const m of postText.matchAll(/alive_id["']?\s*[:=]\s*["']?(l_[A-Za-z0-9]+)/g)) {
      aliveIds.push(m[1]);
    }
    for (const m of postText.matchAll(/l_[A-Za-z0-9]{20,}/g)) aliveIds.push(m[0]);

    const respText = String(entry.response?.content?.text || "");
    const appInResp = respText.match(/app_id["']?\s*[:=]\s*["']?([A-Za-z0-9]+)/);
    if (appInResp && !appId) appId = appInResp[1];
    for (const m of respText.matchAll(/course_id["']?\s*[:=]\s*["']?(course_[A-Za-z0-9]{16,})/g)) {
      courseIds.push(m[1]);
    }
    for (const m of respText.matchAll(/course_[A-Za-z0-9]{16,}/g)) courseIds.push(m[0]);
    for (const m of respText.matchAll(/alive_id["']?\s*[:=]\s*["']?(l_[A-Za-z0-9]+)/g)) {
      aliveIds.push(m[1]);
    }
    for (const m of respText.matchAll(/l_[A-Za-z0-9]{20,}/g)) aliveIds.push(m[0]);
  }

  return {
    koToken,
    appId,
    host,
    courseIds: unique(courseIds),
    aliveIds: unique(aliveIds),
  };
}

function buildHeaders(opts) {
  const headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
    referer: opts.host,
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  return headers;
}

async function requestText(url, opts, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...buildHeaders(opts),
      ...(init.headers || {}),
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

async function requestBuffer(url, opts, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...buildHeaders(opts),
      ...(init.headers || {}),
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function apiForm(endpoint, params, opts) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    body.set(`bizData[${key}]`, String(value));
  }
  const url = new URL(endpoint, opts.host).toString();
  const text = await requestText(url, opts, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${endpoint}: ${text.slice(0, 200)}`);
  }
  if (json.code && json.code !== 0 && json.code !== "0") {
    throw new Error(`API error ${json.code} from ${endpoint}: ${json.msg || json.message || ""}`);
  }
  return json;
}

async function getCatalog(opts) {
  log(opts, "Enumerating catalog for", opts.courseId);
  const json = await apiForm(
    opts.listEndpoint,
    { course_id: opts.courseId, app_id: opts.appId },
    opts,
  );
  const resources = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      const resourceType = Number(node.resource_type);
      if (resourceType === 4 && String(node.is_lookback) === "1") {
        resources.push({
          resourceType,
          aliveId: node.resource_id,
          title: node.resource_title || node.chapter_title || node.resource_id,
          jumpUrl: node.jump_url || "",
        });
      } else if (resourceType === 1) {
        resources.push({
          resourceType,
          aliveId: node.resource_id,
          title: node.resource_title || node.chapter_title || node.resource_id,
          jumpUrl: node.jump_url || "",
        });
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(json.data?.list || []);
  return resources;
}

async function getLookbackUrl(aliveId, opts) {
  const url = new URL(opts.lookbackEndpoint, opts.host);
  url.searchParams.set("app_id", opts.appId);
  url.searchParams.set("alive_id", aliveId);
  url.searchParams.set("protection", "0");
  const text = await requestText(url.toString(), opts);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON lookback response for ${aliveId}`);
  }
  if (json.code && json.code !== 0 && json.code !== "0") {
    throw new Error(`Lookback API error ${json.code} for ${aliveId}: ${json.msg || json.message || ""}`);
  }

  const candidates = [];
  for (const line of json.data || []) {
    for (const sharp of line.line_sharpness || []) {
      if (sharp.url && (String(sharp.type || "lookBack") === "lookBack")) {
        candidates.push(sharp);
      }
    }
  }
  candidates.sort((a, b) => (Number(b.default) || 0) - (Number(a.default) || 0));
  if (!candidates.length) {
    return null;
  }
  return candidates[0].url;
}

async function apiJson(endpoint, body, opts) {
  const url = new URL(endpoint, opts.host).toString();
  const text = await requestText(url, opts, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${endpoint}: ${text.slice(0, 200)}`);
  }
  if (json.code && json.code !== 0 && json.code !== "0") {
    throw new Error(`API error ${json.code} from ${endpoint}: ${json.msg || json.message || ""}`);
  }
  return json;
}

function extractAssetUrls(html) {
  const urls = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return;
    if (!seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
  };
  for (const match of html.matchAll(/(?:src|data-src|poster)=["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  for (const match of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    add(match[1]);
  }
  for (const match of html.matchAll(/data-href=["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  return urls;
}

function localAssetName(url, used) {
  const parsed = new URL(url);
  let base = path.basename(parsed.pathname);
  if (!base || !base.includes(".")) {
    const digest = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    base = `asset-${digest}.bin`;
  }
  base = sanitizeName(base);
  let candidate = base;
  let counter = 1;
  while (used.has(candidate)) {
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
      candidate = `${base.slice(0, dot)}-${counter}${base.slice(dot)}`;
    } else {
      candidate = `${base}-${counter}`;
    }
    counter++;
  }
  used.add(candidate);
  return candidate;
}

function rewriteHtmlAssets(html, mapping) {
  return html.replace(/((?:src|data-src|poster)=["'])([^"']+)(["'])/gi, (whole, prefix, url, suffix) => {
    const local = mapping.get(url);
    return local ? `${prefix}${local}${suffix}` : whole;
  });
}

async function fetchRichTextContent(signature, opts) {
  const info = await apiJson(RICHTEXT_INFO_ENDPOINT, { signatures: [signature] }, opts);
  const signItem = info.data?.sign_list?.[0];
  if (!signItem?.urls?.length) {
    throw new Error("Rich text signature returned no content URL");
  }
  let html = "";
  for (const url of signItem.urls) {
    try {
      html = await requestText(url, opts);
      break;
    } catch {
      continue;
    }
  }
  if (!html) throw new Error("Failed to fetch rich text content");

  const materialIds = [];
  for (const match of html.matchAll(/img[^>]+data-cos="1"[^>]+src=["']([^"']+)/gi)) {
    materialIds.push(match[1]);
  }
  for (const match of html.matchAll(/a[^>]+data-file[^>]+data-cos="1"[^>]+href=["']([^"']+)/gi)) {
    materialIds.push(match[1]);
  }
  for (const match of html.matchAll(/iframe[^>]+src=["'][^"']*material_id=([^"&']+)/gi)) {
    materialIds.push(match[1]);
  }
  const uniqueMaterialIds = [...new Set(materialIds)];
  if (uniqueMaterialIds.length) {
    const material = await apiJson(
      RICHTEXT_MATERIAL_ENDPOINT,
      { signature, material_ids: uniqueMaterialIds },
      opts,
    );
    const materialUrls = new Map();
    for (const item of material.data?.material_list || []) {
      const target = item?.url || item?.src || item?.href;
      if (target) materialUrls.set(item.material_id, target);
    }
    for (const id of uniqueMaterialIds) {
      const target = materialUrls.get(id);
      if (target) {
        html = html.replace(new RegExp(`["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g"), `"${target}"`);
      }
    }
  }
  return html;
}

async function downloadImageText(resource, opts) {
  const safeTitle = sanitizeName(resource.title);
  const index = Number.isInteger(resource.index) ? resource.index : 0;
  const prefix = resource.prefix || String(index).padStart(2, "0");
  const category = "image-text";
  const dir = path.join(
    opts.out,
    IMAGE_TEXT_DIR,
    `${prefix}-${safeTitle || resource.aliveId}-${resource.aliveId}`,
  );
  const imagesDir = path.join(dir, "images");

  const result = {
    index,
    prefix,
    category,
    resource_type: 1,
    resource_id: resource.aliveId,
    title: resource.title,
    dir,
    status: "ok",
    error: null,
    output_html: null,
    images: 0,
  };

  if (!opts.force) {
    const htmlPath = path.join(dir, "index.html");
    try {
      await fs.access(htmlPath);
      result.status = "skipped";
      result.output_html = htmlPath;
      console.log(`[SKIP] ${resource.aliveId} ${resource.title}: index.html already exists`);
      return result;
    } catch {
      // index.html does not exist, continue downloading
    }
  }

  try {
    const detail = await apiForm(
      IMAGE_TEXT_DETAIL_ENDPOINT,
      { resource_id: resource.aliveId, product_id: opts.courseId, app_id: opts.appId },
      opts,
    );
    const data = detail.data || {};
    let html = data.org_content || "";
    if (!html && data.content_url) {
      html = await requestText(data.content_url, opts);
    }
    if (!html && data.signature) {
      html = await fetchRichTextContent(data.signature, opts);
    }
    if (!html) {
      result.status = "no_content";
      result.error = "Empty image-text content";
      return result;
    }
    await fs.mkdir(imagesDir, { recursive: true });

    const assetUrls = extractAssetUrls(html);
    const used = new Set();
    const mapping = new Map();
    const downloaded = [];

    await mapLimit(assetUrls, opts.concurrency, async (rawUrl, index) => {
      const url = new URL(rawUrl, opts.host).toString();
      const name = localAssetName(url, used);
      const output = path.join(imagesDir, name);
      try {
        const buffer = await requestBuffer(url, opts);
        await fs.writeFile(output, buffer);
        downloaded.push({ url, file: output });
        mapping.set(rawUrl, `images/${name}`);
      } catch (error) {
        console.error(`[IMAGE FAIL] ${resource.aliveId} ${url}: ${error.message}`);
      }
    });

    const htmlPath = path.join(dir, "index.html");
    await fs.writeFile(htmlPath, rewriteHtmlAssets(html, mapping), "utf8");
    result.output_html = htmlPath;
    result.images = downloaded.length;
  } catch (error) {
    result.status = "error";
    result.error = error.message;
    console.error(`[FAIL] ${resource.aliveId} ${resource.title}: ${error.message}`);
  }
  return result;
}

function parseM3U8(text, baseUrl) {
  const segments = [];
  let key = null;
  let pendingSegment = false;
  let masterVariant = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-KEY:")) {
      const method = /METHOD=([^,]+)/.exec(line)?.[1]?.trim();
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      const iv = /IV=(0x[0-9A-Fa-f]+)/.exec(line)?.[1];
      key = {
        method,
        uri: uri ? new URL(uri, baseUrl).toString() : null,
        iv: iv ? Buffer.from(iv.replace(/^0x/, ""), "hex") : Buffer.alloc(16, 0),
      };
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      masterVariant = lines[i + 1]?.trim();
    } else if (line.startsWith("#EXTINF:")) {
      pendingSegment = true;
    } else if (pendingSegment && !line.startsWith("#")) {
      segments.push(new URL(line, baseUrl).toString());
      pendingSegment = false;
    }
  }

  return { segments, key, masterVariant };
}

async function fetchKey(keyInfo, opts) {
  if (!keyInfo?.uri) return null;
  const buf = await requestBuffer(keyInfo.uri, opts);
  if (buf.length === 16) return buf;
  const text = buf.toString("utf8").trim();
  if (/^[0-9A-Fa-f]{32}$/.test(text)) return Buffer.from(text, "hex");
  if (text.length === 16) return Buffer.from(text, "utf8");
  throw new Error(`Unexpected AES key length ${buf.length} bytes`);
}

function decryptSegment(buf, key, iv) {
  if (!key) return buf;
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

async function writeSegmentFiles(segments, tmpDir, key, iv, opts) {
  await mapLimit(segments, opts.concurrency, async (url, index) => {
    const buf = await requestBuffer(url, opts);
    const out = decryptSegment(buf, key, iv);
    await fs.writeFile(path.join(tmpDir, `seg-${String(index).padStart(6, "0")}.ts`), out);
  });
}

async function concatSegments(tmpDir, count, outputFile) {
  const writer = createWriteStream(outputFile);
  for (let i = 0; i < count; i++) {
    const file = path.join(tmpDir, `seg-${String(i).padStart(6, "0")}.ts`);
    await new Promise((resolve, reject) => {
      const reader = createReadStream(file);
      reader.on("error", reject);
      reader.on("end", resolve);
      reader.pipe(writer, { end: false });
    });
  }
  await new Promise((resolve, reject) => {
    writer.end((err) => (err ? reject(err) : resolve()));
  });
}

async function findFfmpeg(opts) {
  if (opts.ffmpeg) {
    try {
      await execFileAsync(opts.ffmpeg, ["-version"]);
      return opts.ffmpeg;
    } catch {
      throw new Error(`ffmpeg not executable: ${opts.ffmpeg}`);
    }
  }
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    return "ffmpeg";
  } catch {
    try {
      const mod = await import("ffmpeg-static");
      return mod.default;
    } catch {
      return null;
    }
  }
}

async function remuxToMp4(tsPath, mp4Path, ffmpegPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-y", "-i", tsPath, "-c", "copy", "-movflags", "+faststart", mp4Path],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

async function downloadReplay(alive, opts) {
  const safeTitle = sanitizeName(alive.title);
  const index = Number.isInteger(alive.index) ? alive.index : 0;
  const prefix = alive.prefix || String(index).padStart(2, "0");
  const category = "live";
  const replayDir = path.join(
    opts.out,
    LIVE_DIR,
    `${prefix}-${safeTitle || alive.aliveId}-${alive.aliveId}`,
  );
  const tmpDir = path.join(replayDir, ".segments");

  const result = {
    index,
    prefix,
    category,
    alive_id: alive.aliveId,
    title: alive.title,
    dir: replayDir,
    status: "ok",
    error: null,
    m3u8_url: null,
    output_ts: null,
    output_mp4: null,
    segments: 0,
  };

  if (!opts.force) {
    const mp4Path = path.join(replayDir, `${safeTitle || alive.aliveId}.mp4`);
    try {
      await fs.access(mp4Path);
      result.status = "skipped";
      result.output_mp4 = mp4Path;
      console.log(`[SKIP] ${alive.aliveId} ${alive.title}: mp4 already exists`);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return result;
    } catch {
      // mp4 does not exist, continue downloading
    }
  }

  try {
    const m3u8Url = await getLookbackUrl(alive.aliveId, opts);
    if (!m3u8Url) {
      result.status = "no_replay";
      result.error = "No replay available yet";
      console.log(`[SKIP] ${alive.aliveId} ${alive.title}: no replay yet`);
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return result;
    }
    await fs.mkdir(tmpDir, { recursive: true });
    result.m3u8_url = m3u8Url;
    log(opts, "  m3u8:", m3u8Url);

    const m3u8Text = await requestText(m3u8Url, opts);
    let parsed = parseM3U8(m3u8Text, m3u8Url);
    if (!parsed.segments.length && parsed.masterVariant) {
      const variantUrl = new URL(parsed.masterVariant, m3u8Url).toString();
      log(opts, "  master playlist ->", variantUrl);
      parsed = parseM3U8(await requestText(variantUrl, opts), variantUrl);
    }
    let segments = parsed.segments;
    if (opts.maxSegments > 0) segments = segments.slice(0, opts.maxSegments);

    let key = null;
    if (parsed.key && parsed.key.method === "AES-128") {
      key = await fetchKey(parsed.key, opts);
      log(opts, "  AES-128 key:", key.length, "bytes");
    }

    result.segments = segments.length;
    log(opts, `  downloading ${segments.length} segments`);
    await writeSegmentFiles(segments, tmpDir, key, parsed.key?.iv || null, opts);

    const tsPath = path.join(replayDir, `${safeTitle || alive.aliveId}.ts`);
    await concatSegments(tmpDir, segments.length, tsPath);
    result.output_ts = tsPath;

    if (opts.format === "mp4") {
      const ffmpegPath = await findFfmpeg(opts);
      if (!ffmpegPath) {
        throw new Error("mp4 requested but ffmpeg was not found; output kept as .ts");
      }
      const mp4Path = path.join(replayDir, `${safeTitle || alive.aliveId}.mp4`);
      await remuxToMp4(tsPath, mp4Path, ffmpegPath);
      result.output_mp4 = mp4Path;
      await fs.unlink(tsPath).catch(() => {});
      result.output_ts = null;
    }
  } catch (error) {
    result.status = "error";
    result.error = error.message;
    console.error(`[FAIL] ${alive.aliveId} ${alive.title}: ${error.message}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (opts.har) {
    const harData = extractFromHar(opts.har);
    if (!opts.cookie && harData.koToken) opts.cookie = `ko_token=${harData.koToken}`;
    if (!opts.host && harData.host) opts.host = harData.host;
    if (!opts.appId && harData.appId) opts.appId = harData.appId;
    if (!opts.courseIdExplicit && harData.courseIds.length) {
      opts.courseId = harData.courseIds[0];
    }
    if (!opts.aliveIds.length && !opts.courseIdExplicit && !harData.courseIds.length && harData.aliveIds.length) {
      opts.aliveIds = harData.aliveIds;
    }
    log(opts, "HAR token:", opts.cookie);
  }

  if (!opts.host) {
    throw new Error("Missing --host. Pass the H5 origin, or use --har to infer it.");
  }
  if (!opts.appId) {
    throw new Error("Missing --app-id. Pass the shop app id, or use --har to infer it.");
  }
  if (!opts.aliveIds.length && !opts.courseId) {
    throw new Error("No course id provided. Pass --course-id or --har.");
  }

  if (opts.aliveIdsFile) {
    const text = await fs.readFile(opts.aliveIdsFile, "utf8");
    opts.aliveIds = unique([...opts.aliveIds, ...text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)]);
  }

  let replays;
  if (opts.aliveIds.length) {
    replays = opts.aliveIds.map((aliveId) => ({
      resourceType: 4,
      aliveId,
      title: aliveId,
      jumpUrl: "",
    }));
  } else {
    const resources = await getCatalog(opts);
    const live = resources.filter((item) => item.resourceType === 4);
    const imageText = resources.filter((item) => item.resourceType === 1);
    replays = [];
    if (opts.resources === "all" || opts.resources === "live") replays.push(...live);
    if (opts.resources === "all" || opts.resources === "image-text") replays.push(...imageText);
  }
  if (opts.limit > 0) replays = replays.slice(0, opts.limit);

  console.log(`Found ${replays.length} resources`);
  if (opts.dryRun) {
    let okCount = 0;
    let skipCount = 0;
    for (const replay of replays) {
      try {
        if (replay.resourceType === 1) {
          okCount++;
          console.log(`[OK]   ${replay.aliveId}\t${replay.title}\timage-text`);
        } else {
          const url = await getLookbackUrl(replay.aliveId, opts);
          if (!url) {
            skipCount++;
            console.log(`[SKIP] ${replay.aliveId}\t${replay.title}\tno replay yet`);
            continue;
          }
          okCount++;
          console.log(`[OK]   ${replay.aliveId}\t${replay.title}\t${url}`);
        }
      } catch (error) {
        console.error(`[FAIL] ${replay.aliveId}\t${replay.title}\t${error.message}`);
      }
    }
    console.log(`Lookback URL check: ${okCount} OK, ${skipCount} not ready, ${replays.length - okCount - skipCount} failed`);
    if (okCount + skipCount !== replays.length) process.exitCode = 1;
    return;
  }

  await fs.mkdir(opts.out, { recursive: true });
  const results = [];
  const counters = { live: 0, "image-text": 0 };
  for (let index = 0; index < replays.length; index++) {
    const category = replays[index].resourceType === 1 ? "image-text" : "live";
    const prefix = String(counters[category]++).padStart(2, "0");
    const replay = { ...replays[index], index, category, prefix };
    console.log(`[START] ${index} ${replay.aliveId} ${replay.title}`);
    const result =
      replay.resourceType === 1
        ? await downloadImageText(replay, opts)
        : await downloadReplay(replay, opts);
    results.push(result);
    console.log(
      `[DONE]  ${result.status} ${result.output_html || result.output_mp4 || result.output_ts || result.error}`,
    );
  }

  const manifestPath = path.join(opts.out, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`Manifest: ${manifestPath}`);

  const failed = results.filter((r) => r.status === "error");
  if (failed.length) {
    console.error(`${failed.length} resource(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
