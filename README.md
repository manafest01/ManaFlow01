# ManaFlow

**One library. One flow.** A DJ music library app by Mana Industries that runs in your web browser.

**Open it:** https://manafest01.github.io/manaflow01/ (Chrome or Edge on a PC works best)

## What it does
- Imports your rekordbox collection (XML): tracks, BPM, key, hot cues, memory cues and playlists, shown CDJ-style.
- Reads your music straight from the folders you pick. Nothing is uploaded; your library is saved in your own browser.
- Deck with a big waveform, Play/Pause, Stop, and hot cues A–H you can set, jump to and clear.
- Fixes half-time BPMs (87 → 174) and sorts keys in Camelot order.
- Detects BPM and key for tracks that don't have them.
- Your own cue layout check ("Ready" = has the hot cues you want).
- Browse by genre and era, tick boxes for bulk edits, a ⋯ menu on every row, cover art.
- Finds exact duplicate files.
- Exports to rekordbox (XML), Serato (crates) and CSV, and converts tracks to WAV or MP3.
- Checks a CDJ USB after a gig for hot cues you changed while playing.
- Backs up and restores the whole ManaFlow library.
- Phone ready: a phone layout (Playlists / Tracks / Track), long-press a pad to clear it, pick music files to play them, and add it to your home screen. Works offline once opened.

## Files
- `index.html`: the screen
- `engine.js`: the library engine (storage, folders, analysis, exports)
