# Vesper — product

## One line

A quiet macOS client for yt-dlp that treats the nightly build channel as a first-class
citizen and never downloads anything before showing you what it is.

## The scene

Someone at a desk, late, with a link in the clipboard and a folder they already know
they want the file in. They are not browsing a catalogue; they are moving one piece of
media from a web page onto a disk, and they want the tool to disappear. Ambient light is
low, the screen is the brightest object in the room.

## The mechanism

Vesper reads the link (`yt-dlp -J`), normalizes the metadata, and presents a compact
record: title, channel, duration, views, and the resolved format. Only after a format is
chosen does a job enter the queue. The queue is always visible, because a downloader
whose progress is hidden is a downloader you keep checking.

The second mechanism is the binary itself: the app can fetch the current nightly or
stable build from GitHub, verify its SHA-256 against the release checksum list, and pin
it inside its own data folder. The header always states which build is running and where
it came from.

## Users and jobs

- **The single operator.** One person, one machine, files they chose. No multi-user,
  no sharing, no sync.
- **Jobs to be done:** inspect a link; compose a format; queue and monitor; find the
  file; update the extractor when a site breaks. The same few setups repeat, so they
  must be saveable and resumable.
- **Frequency:** bursts. Several links in a sitting, then days of silence. Motion must
  never make the second link of a burst feel slower than the first.

## Product truths

- Local only. The server binds to loopback and talks to GitHub and the sites the user
  points at. No account, no telemetry, no cloud.
- The files are the user's. Removing an archive entry does not delete anything.
- Format setups are user property: named presets, one of them the default for new
  links, stored locally with the rest of the settings.
- The queue is durable across restarts: queued jobs resume, a job interrupted
  mid-download becomes an error with Retry.
- Formats are honest: sizes are estimates from yt-dlp metadata and are labelled with `≈`.

## Non-goals

- A media library, player, or converter.
- Subtitle/thumbnail/playlist-metadata authoring.
- A browser extension or a hosted service.
- Hiding yt-dlp. The app is a considered front end, not a replacement.

## Constraints

- macOS 13+; the server and interface are portable, the shell is AppKit.
- The shipped app is self-contained and universal: Node is embedded, so the recipient
  installs nothing. Running from source still needs Node 20+.
- yt-dlp and ffmpeg are installed from inside the app, SHA-256 verified, into the user's
  data folder. Missing tools are a first-run card, not a blocking gate.
- The app is ad-hoc signed, not notarized; first launch is right-click → Open.
- No telemetry and no log file. The server binds to loopback only.

## States that must exist

Empty stage, first-run setup with either or both tools missing, inspecting (skeleton),
read error with recovery, video ready, playlist ready with selection, queued,
downloading with known and unknown totals, done, canceled, failed with retry, archive
empty and populated, binary missing, binary installed, ffmpeg missing, tool install in
progress with failure, app update available, update downloading, update ready to
install, update failed, offline/rate-limited.
