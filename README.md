# Xiaoe Replay Downloader

从小鹅通/XET 课程的课程目录中枚举所有已结束直播，下载 HLS 回放，并解密为可直接播放的视频文件。

## 原理

1. 调用课程目录接口 `resource_catalog_list.get/3.0.0`，找出 `resource_type=4` 且 `is_lookback=1` 的直播资源。
2. 对每个 `alive_id` 调用 `_alive/v3/get_lookback_list` 获取带签名的 `main.m3u8`。
3. 解析 `#EXT-X-KEY`，下载 AES-128 key 和 TS 分片，用 Node 内置 `crypto` 解密。
4. 按顺序合并为 `.ts`；若本机有 `ffmpeg`，`--format mp4` 会无损 remux 为 `.mp4`。
5. 图文资源通过 `get.detail/2.0.0` 获取 `org_content`，保存 HTML 并下载其中的图片。

直播回放和图文素材分开存储：

- `live_replays/00-示例章节一-l_xxx`
- `image_text/00-示例素材-i_xxx`

两类目录各自独立从 `00` 开始编号，方便按文件名排序。

课程目录里 `is_lookback=1` 的直播如果尚未结束，`get_lookback_list` 会返回空，工具会标记
`no_replay` 并跳过；只有真正已生成回放的场次才会下载。用 `--dry-run` 可以提前确认哪些可用。

## 登录态

后端用 Cookie 里的 `ko_token` 鉴权。可以显式传，也可以从已有的 HAR 自动提取：

```bash
node download-replays.mjs --har your-capture.har --out ./downloads
```

不使用 HAR 时，需要显式提供：

```bash
node download-replays.mjs `
  --host https://your-shop.example.com `
  --app-id appXXX `
  --course-id course_xxx `
  --cookie "ko_token=YOUR_TOKEN" `
  --out ./downloads
```

显式传 Cookie：

```bash
node download-replays.mjs --cookie "ko_token=YOUR_TOKEN" --course-id course_xxx --out ./downloads
```

## 常用参数

```bash
# 枚举整个课程并下载全部回放
node download-replays.mjs --har your-capture.har --out ./downloads

# 只下载指定直播
node download-replays.mjs --har your-capture.har --alive-ids l_xxx --max-segments 50

# 合并为 MP4（需要 ffmpeg）
node download-replays.mjs --har your-capture.har --format mp4 --ffmpeg C:/tools/ffmpeg.exe

# 完整下载当前课程所有可用回放
node download-replays.mjs --har your-capture.har --format mp4 --out ./downloads

# 同时下载直播回放和图文素材（默认行为）
node download-replays.mjs --har your-capture.har --resources all --out ./downloads

# 只下载图文素材
node download-replays.mjs --har your-capture.har --resources image-text --out ./downloads

# 已存在 mp4 的直播会跳过；需要重下时加 --force
node download-replays.mjs --har your-capture.har --resources live --out ./downloads
node download-replays.mjs --har your-capture.har --resources live --force --out ./downloads

# 只列出回放，不下载
node download-replays.mjs --har your-capture.har --dry-run
```

完整参数见 `node download-replays.mjs --help`。

## 重命名已有下载

如果之前下载的目录还是旧平铺结构，可以按现有 manifest 顺序批量迁移：

```bash
node rename-downloads.mjs --manifest ./downloads/manifest.json --out ./downloads
```

脚本会把目录迁移到 `live_replays/` 或 `image_text/`，重置每类独立序号，并更新
根 `manifest.json`、子目录 `manifest.json` 以及媒体文件路径。

## 输出

直播输出到 `--out/live_replays/<序号>-<标题>-<alive_id>/`，文件名默认为 `.ts`
（VLC/ffplay 可直接播放）；`--format mp4` 成功时输出 `.mp4`。图文输出到
`--out/image_text/<序号>-<标题>-<resource_id>/` 下的 `index.html` 和 `images/`。

根目录 `manifest.json` 包含全部资源；每个分类子目录下也有独立的 `manifest.json`。

直播下载前会检查对应目录中是否已有同名 `.mp4`；存在则标记为 `skipped` 并跳过，
避免重复下载。`--force` 可强制重新下载。
