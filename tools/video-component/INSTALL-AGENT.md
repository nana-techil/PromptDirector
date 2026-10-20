# Install PromptDirector Video for the user

Use this guide when the user asks you to install or update the video component. Carry out the work on their computer; do not turn these steps into a checklist for them. No Agent connector pairing, paid service, developer certificate, Python installation or system-security changes are required.

## Find the package and local tools

1. Confirm that your tools execute on the user's computer. A remote sandbox cannot install a Chrome native host on their desktop; report that limit before making unrelated changes.
2. Prefer the extracted component package supplied by the user. Otherwise read this repository's Releases and choose the newest published, non-prerelease **video component** release containing `PromptDirector-Video-Source.zip`. Do not use the repository-wide latest release, which may be the Chrome extension or Agent connector. Download the asset and its `SHA256SUMS`, check the archive once against that release, and extract it completely. Do not overwrite the user's unrelated files.
3. Read `component.json` and `package.json` in that extracted package. Use their version, extension identity and Node requirement; do not invent or replace them. Read its [Chinese](INSTALL.zh.md) or [English](INSTALL.en.md) dependency sources.
4. Detect Windows/macOS, architecture and usable existing Node.js, yt-dlp, FFmpeg and FFprobe. Execute their version commands to confirm they run. Reuse working dependencies; do not replace another project's runtime or require edits to the user's global PATH.

## Supply only missing dependencies

The user has asked for installation. Resolve ordinary download, extraction and per-user installation steps yourself. Ask only when a real system prompt or a new permission, payment or broader change requires the user's action; do not ask them to type routine commands.

- Node.js: obtain a compatible LTS build from [Node.js](https://nodejs.org/en/download/). An existing compatible installation is sufficient. If you use a portable runtime, keep it in a durable user-owned location outside the temporary download/extraction directory: the component records the Node executable's absolute path.
- yt-dlp: use the matching official standalone executable from its [release files](https://github.com/yt-dlp/yt-dlp#release-files). The generic `yt-dlp` zipimport file requires Python; use `yt-dlp.exe` on Windows or `yt-dlp_macos` on macOS. Official standalone distributions include EJS. If an existing package-managed version reports missing EJS, follow its upstream installation guidance rather than installing a new Python environment.
- FFmpeg and FFprobe: use the [build sources linked by FFmpeg](https://ffmpeg.org/download.html), including both programs and any adjacent files the selected build needs. These binaries are maintained by the linked distributors; preserve their license notices. Do not install a similarly named Python package.
- Reuse an already available package manager when appropriate; inspect its package identity and source. Do not install a new package manager just to install this component. Preserve upstream integrity checks and existing platform security controls.
- For standalone media tools, the package's `tools/` directory accepts `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe` on Windows, or `yt-dlp_macos`/`yt-dlp`, `ffmpeg`, `ffprobe` on macOS. This path supports self-contained executables; do not copy only the launcher from a directory build that needs adjacent runtime files. For such builds, keep the entire distribution at a durable location and use the environment overrides below.
- The install process accepts absolute paths in `PROMPTDIRECTOR_YTDLP`, `PROMPTDIRECTOR_FFMPEG` and `PROMPTDIRECTOR_FFPROBE`. Set them only for the installer process when automatic discovery cannot find a verified tool. The installed host records these paths and does not depend on Chrome inheriting the terminal PATH. Do not persist unrelated global configuration.

## Install and verify

From the extracted package directory, invoke the verified Node executable with arguments `connector/register-video.mjs` and `install`. Use an argument array with your process API and a working directory; preserve Chinese, spaces and shell characters in paths. This is the same implementation used by the double-click installers, without their final interactive pause. No npm install is needed.

The installer validates dependencies, copies the component, writes the native manifest and checks registration. Windows uses `reg.exe` for both HKCU views; it does not require PowerShell .NET methods or a less restrictive language mode. A second install updates the same component. If installation fails, retain the exact error and reported rollback status; do not manually replace registrations, change security policies, delete unrelated installations or describe a failed readback as success.

Verify in layers:

1. **Files and registration:** the command must exit successfully. Read the installed `component.json`, `video-tools.json` and `com.promptdirector.video.json` under the installer-reported root. Check the launcher and dependencies still exist. Do not print unrelated environment variables or credentials.
2. **Native handshake:** when using a local process tool, launch the installed `native-host`/`native-host.cmd` with a test environment whose PATH is empty. The stdin/stdout protocol is a four-byte unsigned little-endian byte length followed by UTF-8 JSON, implemented in `connector/framing.mjs`. Send `video_hello` with the package's extensionId and `VIDEO_PROTOCOL_VERSION` from its config; require `video_ready`. Then send `video_request` with a unique id and `operation: "status"`; require the matching successful `video_response` with `result.available: true`. Close the process when finished. Do not count the installer's exit alone as a handshake.
3. **Chrome:** when browser access is available, open the installed PromptDirector extension and verify its video component is ready. Ask for native-messaging authorization only if Chrome requires it. Refresh the extension after manual installation; older extension builds may require their existing Retry/Continue button. Do not uninstall the Chrome extension or clear its data.
4. **Capture:** if the user has a pending or explicitly selected video and you can operate their browser, let that same capture finish; reopen its saved case and confirm the video plays. Do not pick an unrelated video or create duplicate cases to claim success. If browser access or a selected video is unavailable, state exactly which checks remain unverified.

Give a short result: installed version, verified stages, and any remaining user action. Do not expose the internal procedure as a new manual tutorial.

## Updates and removal

For an update, use the new extracted source package and the same `install` entry point. Keep existing working tools unless the new package actually requires a change. Uninstall only when the user requests it: invoke the verified Node executable with `connector/register-video.mjs uninstall`. It removes this component and its matching registration, preserving browser cases and external dependencies. Do not uninstall after a successful installation merely as a test on the user's computer.
