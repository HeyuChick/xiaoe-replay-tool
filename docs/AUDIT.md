# Audit Notes

This document describes the non-sensitive project materials and verification results.

## Scope

The tool targets Xiaoe/XET H5 e-course pages. It enumerates live sessions from the
course catalog, requests replay HLS playlists, downloads encrypted TS segments,
decrypts them, and produces a playable file.

## API Surface

- Catalog enumeration:
  `POST /xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/3.0.0`
  with `course_id` and `app_id`.
- Replay URL:
  `GET /_alive/v3/get_lookback_list?app_id=...&alive_id=...&protection=0`

Live sessions are identified by `resource_type=4` and `is_lookback=1`. A session
whose replay has not been generated yet returns no lookback URL; the tool marks it
as `no_replay` and skips it.

## Processing Flow

1. Read login state from `--cookie` or extract `ko_token` from a user-provided HAR.
2. Enumerate the catalog and collect live replay resources.
3. Fetch the lookback playlist for each available live session.
4. Parse `#EXT-X-KEY` and download the AES-128 key.
5. Download TS segments with bounded concurrency.
6. Decrypt each segment and concatenate them into a `.ts` file.
7. Optionally remux to `.mp4` with ffmpeg when `--format mp4` is used.
8. Image-text resources are fetched through `get.detail/2.0.0`; the returned
   `org_content` HTML is saved and referenced images are downloaded locally.
9. Live replays are skipped when their target `.mp4` already exists unless
   `--force` is passed.
10. The default output format is `.mp4`; `.ts` is kept only when ffmpeg is
    unavailable or `--format ts` is requested.
11. Temporary `.segments` directories are removed after download, skip, or
    `no_replay` handling.
12. Image-text resources are skipped when `index.html` already exists unless
    `--force` is passed.

## Folder Naming

Downloaded folders are split by category:

- `live_replays/<NN>-<title>-<alive_id>`
- `image_text/<NN>-<title>-<resource_id>`

Each category has its own zero-padded `00/01/02...` numbering. Root
`manifest.json` lists all resources, and each category folder contains its own
`manifest.json`.

`rename-downloads.mjs` can be used to rename an existing downloads directory to
this convention from its current `manifest.json`.

## Verification

- Catalog dry-run found 25 live resources.
- 12 resources had an available replay; 13 were not ended yet and were skipped.
- Two replays were downloaded as a sample and decrypted; every 188-byte MPEG-TS
  sync check passed.
- A sample MP4 was produced and inspected with ffprobe: H.264 video, AAC audio.

## Sensitive Data Handling

The repository intentionally excludes:

- HAR captures and cookies
- Signed replay URLs
- AES keys and encrypted/decrypted media
- Local test outputs

Users must provide their own authenticated HAR or cookie at runtime.
