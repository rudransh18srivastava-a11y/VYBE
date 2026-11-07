# VYBE 2.0

Private video player for **Web (GitHub Pages / PWA)** and **Android (native Media3 ExoPlayer engine)**.
One UI (`www/`) is shared; the engine is swapped underneath.

| | Web | Android |
|---|---|---|
| Engine | HTML5 `<video>` (+hls.js for .m3u8) | Media3 ExoPlayer (HW decode + SW fallback, HLS, DASH, MKV/HEVC/AC3 per device) |
| Gestures | swipe brightness/volume/seek, double-tap skip, hold 2x, pinch zoom, lock | same (system volume + window brightness) |
| Subtitles | SRT / VTT / ASS, delay, size, colour, position | same + embedded tracks |
| Audio | 5-band EQ, boost to 300% (local files) | audio track switch, system EQ, LoudnessEnhancer boost |
| Extras | A-B loop, speed 0.25-4x, frame step, sleep timer, aspect modes, resume, screenshot, PiP, media keys | + Open-with, auto-PiP, auto-rotate by video, network cache 256 MB |

## Web deploy
Push to GitHub, enable **Settings > Pages > Source: GitHub Actions**. `pages.yml` publishes `www/`.
Locally: `python3 -m http.server -d www 8000`.

## Android build
- **CI:** push; `android.yml` uploads `vybe-apk` (debug + release APKs).
- **Local:** open `android/` in Android Studio (JDK 17) and Run, or `cd android && ./gradlew assembleDebug`.
- Optional release signing: set env vars `VYBE_KEYSTORE`, `VYBE_KEYSTORE_PASSWORD`, `VYBE_KEY_ALIAS`, `VYBE_KEY_PASSWORD`.

## Layout
```
www/        shared web UI (index.html, css/, js/{engine,app,subs,store}.js, sw.js, manifest)
android/    Kotlin host: MainActivity (PlayerView + transparent WebView), NativePlayer, Bridge
.github/    Pages + APK workflows
```

## Status / known limits
- Web build was tested in Chromium (playback, subs, seek, EQ, A-B, resume, mobile layout).
- **The Android project has NOT been compiled or run on a device** (no Android SDK in my environment). Expect to fix small compile/runtime issues on first build.
- No background-audio notification service yet; playback pauses when leaving the app (PiP keeps playing).
- No folder scanning; videos are added via the system picker.
