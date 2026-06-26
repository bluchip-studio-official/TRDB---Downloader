# TRDB Downloader

A Chrome extension (Manifest V3) that notices video streams while they play and saves them to your disk as MP4. It watches the network in the background for DASH (`.mpd`) and HLS (`.m3u8`) manifests, and for plain video files like `.mp4`, then lets you grab whatever it found from a side panel.

If you've used Video DownloadHelper before, the idea is the same. This one is built for MPEG-DASH, HLS, and direct files.

## What it does

It runs quietly and keeps an eye on requests going past. When it sees a manifest or a media file it adds a card to the **Detected** tab, grouped by the tab it came from. Each card shows a small badge so you can tell at a glance whether it's DASH, HLS, or a plain file.

From there you pick a quality (and an audio or language track if there's more than one), give the file a name, and hit Download. The extension pulls the segments down over several connections at once, stitches the video and audio back together into a single MP4, and writes it out. No re-encoding happens, so it's quick and the quality is whatever the stream gave you.

A few things worth calling out:

- **Direct files.** A normal `.mp4` (or `.mov`, `.webm`, `.mkv`, `.m4v`) playing in a `<video>` tag, or opened on its own, shows up as a one-click download. The bytes get saved exactly as they are, no muxing involved. If the server allows range requests and the file is big enough, it's pulled in parallel chunks. Otherwise it streams straight to disk so even large files never sit whole in memory. Segments that an adaptive player is fetching over XHR are filtered out, so the list doesn't fill up with junk. And if a tab already has a DASH or HLS stream, a direct file in the same tab gets hidden as a likely duplicate of it.

- **HLS, the messy parts included.** It handles multivariant playlists with separate audio and video, and single streams that already have audio baked in. MPEG-TS segments get converted to fragmented MP4 with [mux.js](https://github.com/videojs/mux.js); fMP4 and CMAF go through untouched. AES-128 clear-key encryption is decrypted on the fly using WebCrypto. For a master playlist you only see one card, not one per child playlist.

- **It survives the panel closing.** The actual downloading and muxing happen in an offscreen document, not in the side panel, so closing the panel won't kill a download in progress.

- **History and re-download.** Finished downloads land in a History tab where you can re-run any of them, or open the folder they went to.

## Installing it

There's no build step. Load the folder as it is.

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Click the toolbar icon to open the side panel.

Play a DASH or HLS video after that and a card should turn up under **Detected**.

You'll need Chrome 116 or newer. That's the version where the side panel and the offscreen document APIs it relies on are available.

## Using it

1. Play a video that streams over a `.mpd` or `.m3u8` manifest, or open a direct `.mp4`.
2. Open the side panel and go to **Detected**. Rename the file if you want, pick a quality and an audio track, then click **Download**.
3. The first time, it asks you to choose a folder to save into. It remembers the choice. If you'd rather just use the browser's Downloads folder, you can switch to that in Settings.
4. Watch it run under **Downloads**. When it's done it moves to **History**.

## Settings

- **Save location.** Pick any folder and files stream straight into it, which keeps memory use low on big videos. Or switch to the browser's Downloads folder.
- **Parallel connections** (1 to 16). How many segments to pull at the same time.
- **Retries.** How many times to retry a segment that fails before giving up on it.
- **Filename template.** Build the name from `{title}`, `{height}`, `{width}`, `{bandwidth}`, and `{quality}`.
- **Auto-detect**, **Hide DRM streams**, and **Notify when done.** These apply to DASH and HLS the same way.

## What it can't do

I'd rather be upfront about the limits than have you find them the hard way:

- **DRM is off the table.** Widevine, PlayReady, and FairPlay (DASH `ContentProtection`, HLS `SAMPLE-AES`, `EXT-X-SESSION-KEY`) get detected, badged DRM, and the Download button is disabled. There's no decryption here and there won't be. HLS AES-128 clear-key is a different thing and that one does work.
- **Live streams aren't supported.** A DASH `type="dynamic"` manifest, or an HLS playlist with no `#EXT-X-ENDLIST`, gets flagged and left alone.
- A single-quality source that already has audio muxed in is passed through as it is. For HLS that can mean you get a valid fragmented MP4 rather than a progressive one.
- Odd codecs and containers go through a fallback path. The common stuff (H.264, H.265, AV1 video with AAC, AC-3, or Opus audio) is fine. Genuinely exotic inputs might not combine.
- Subtitles and closed captions aren't downloaded. Neither are discontinuities or multi-period concatenation. For a multi-period DASH manifest, only the first period comes down.
- Files saved through the folder picker can't be revealed in your file manager from inside the extension, that's a browser restriction. Files saved through the Downloads fallback can.
- Only download things you own or have the right to. Respect the site's terms and whoever made the content.
