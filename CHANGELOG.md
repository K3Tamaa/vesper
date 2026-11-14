# Changelog

All notable changes to Vesper are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-14

A hardening release. The download behaviour is unchanged; what changes is what
the local server will accept, what counts as a verified download, and where the
app is allowed to act.

### Security

- The local server now refuses requests whose `Host` is not `127.0.0.1` or
  `localhost`, refuses foreign `Origin` headers, and requires `X-Vesper: 1` plus
  `Content-Type: application/json` on every POST. This closes the DNS-rebinding
  and cross-origin paths into the API. `/api/health` stays readable so the native
  shell can find the server.
- *Extra arguments* can no longer carry options that execute commands or write
  outside the output folder (`--exec`, `--exec-before-download`,
  `--config-locations`, `--downloader`, `--batch-file`, `--paths`, `--output`,
  `-o`, `--plugin-dirs`, `--external-downloader`). Refused values are not saved
  and the reason is shown in the interface.
- Custom `binaryPath` and `ffmpegPath` must be absolute paths to existing
  executables; `cookiesBrowser` must be a browser yt-dlp knows about.
- `/api/reveal` only opens files Vesper produced (output folder, archive, queue)
  and the data folder itself; bundles and scripts are never opened.
- `/api/thumb` only proxies an allowlist of image hosts plus hosts seen in real
  metadata, follows redirects manually, and refuses private addresses.
- The embedded interface now declares a Content-Security-Policy, and the native
  shell keeps only the local server in its window — every other link opens in the
  default browser.

### Changed

- Checksums are blocking everywhere. A missing checksum list or a missing entry
  is an error, the download is deleted, and nothing is made executable. The
  update helper re-verifies the DMG digest before mounting it and before
  clearing quarantine.
- `verified` now reflects the real comparison for ffmpeg, and the interface only
  says "checksum verified" when that is true.
- Queued jobs survive a restart and resume; a job that was mid-download becomes
  an error with Retry.
- ffmpeg and ffprobe versions are cached instead of being queried on every status
  update.
- A second install or update download started while one is running is refused
  with 409 instead of racing the first.
- `shoot.mjs` no longer targets a selector that does not exist.

### Fixed

- The queue kept the 80 *oldest* jobs on disk instead of the 80 newest.
- Retrying a job kept the previous file, size, log and progress.
- A custom ffmpeg path did not reach yt-dlp as `--ffmpeg-location`.
- Playlist jobs with an empty selection are refused instead of downloading the
  whole list.
- The output folder is created before yt-dlp starts, not after.
- `--embed-thumbnail` is no longer requested for webm, which yt-dlp cannot
  attach cover art to.
- The settings fields for cookies and folders are no longer rewritten while
  being typed in.

### Notes

- Disk images are still ad-hoc signed; first launch is right-click → Open.
- No telemetry and no log file. The server still binds to loopback only.

## [1.0.0] — 2026-11-13

First public release.

- Self-contained universal macOS app with Node embedded.
- One-click, checksum-verified installs of yt-dlp and ffmpeg.
- In-app updates from GitHub releases, verified against `SHA256SUMS`.
- Inspect before download, format composer, presets, queue, archive.
- No telemetry, no logs, loopback-only server.

[1.1.0]: https://github.com/K3Tamaa/vesper/releases/tag/v1.1.0
[1.0.0]: https://github.com/K3Tamaa/vesper/releases/tag/v1.0.0
