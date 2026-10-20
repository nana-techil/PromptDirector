# Video component / 视频组件

## 免费源码安装 / Free source installation

能直接保存的视频无需安装组件。需要本机处理时，点击现有组件提示中的“让 Agent 安装”，把复制的任务交给有本机执行权限的 Agent；它会按[执行指南](../tools/video-component/INSTALL-AGENT.md)检查现有工具、补齐缺少的免费依赖、安装并验证。完成后插件自动检测并接续待保存的视频；已经暂停时点击“继续”。也可把已解压组件包交给 Agent，说“按包内 INSTALL-AGENT.md 帮我安装并验证视频组件”。

不使用 Agent 时，保留原安装包下载和手动安装入口。具体步骤及官方依赖来源见[中文安装说明](../tools/video-component/INSTALL.zh.md)和 [English installation guide](../tools/video-component/INSTALL.en.md)。不需要付费账号、开发者证书、Agent 配对、填写路径或手写 manifest。基础安装脚本复用已有依赖和可选 `tools/` 文件夹，不联网下载或调整系统保护；Agent 在用户委托范围内完成缺少的工具安装。浏览器授权或系统权限确实需要人工操作时再提示。

Directly available originals need no component. Select **Install with Agent** in the component prompt and paste the copied request into a local Agent. Following the [execution guide](../tools/video-component/INSTALL-AGENT.md), it reuses existing tools, supplies missing free dependencies, installs the component and verifies it. The extension detects readiness and resumes the pending capture; select Continue if checks paused. Manual download and installation remain available. No paid account, developer certificate, Python installation or Agent pairing is required. The base installer itself does not download dependencies or change system protection.

macOS and Windows are supported subject to the chosen dependencies' OS/architecture requirements. The source package does not imply that every old OS, managed device or Smart App Control configuration permits those dependencies. Follow [Apple's security guidance](https://support.apple.com/en-us/102445) and [Microsoft's Smart App Control documentation](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview); do not disable protection or remove security markers. The online-only preference remains off unless the user explicitly enables it.

## 安装范围与隐私 / Installation and privacy

The independent native host is `com.promptdirector.video`. It starts on Chrome's request and exposes only status, video download, merge, probe, temporary-file reads, release and cancellation. It does not create an Agent endpoint, pairing record, persistent service or telemetry. Only the configured extension identity can connect. Video downloads contact the source platforms; the source installation script itself performs no network requests. Temporary media is removed on release or session shutdown; successfully saved originals are managed by the browser library.

Source installation uses the current user's application-data directory and Chrome registration. Dependency paths are recorded locally as absolute paths, so Chrome does not depend on the terminal's PATH. Already installed tools remain external; binaries deliberately placed in the extracted package's `tools/` directory are copied into the component's own directory. A later install updates the component; the Uninstall script removes only its own runtime and matching Chrome registration. Browser data, the Agent connector and separately installed dependencies are preserved.

This source ZIP contains PromptDirector source and attribution, not third-party binaries, private paths or installation state. External dependencies retain their licenses: [Node.js](https://nodejs.org/en/download/), [yt-dlp](https://github.com/yt-dlp/yt-dlp#license), [FFmpeg](https://ffmpeg.org/legal.html). FFmpeg's official download page links third-party executable builds; their license depends on the build. Official standalone yt-dlp includes its YouTube EJS components; Python installations should use `yt-dlp[default]`.

## Build and verify the source package

```sh
node tools/video-component/package-source.mjs
node tools/video-component/verify-source.mjs
```

The output is `dist/video-component/PromptDirector-Video-Source.zip`, with `source-build.json`. The separate source verifier checks the version, archive integrity, exact public file allowlist, current source bytes and executable modes for macOS launch scripts. It does not pretend the ZIP is a signed installer. The package has no npm dependencies or install hooks. Runtime entry points are `node connector/register-video.mjs install` and `node connector/register-video.mjs uninstall`; the double-click scripts call them for users.

Before publication, validate user-level installation, updates, native handshake/status and uninstallation on macOS and Windows, plus capture continuation. Source-package verification is distinct from installed-browser acceptance and does not establish system-policy compatibility on every machine.

The `Video component distributions` workflow builds the native dependencies once on each disposable macOS/Windows runner, then reuses that staged toolchain to test the extracted source ZIP. It checks user-level registration (both Windows HKCU views), the installed launcher with an empty PATH, reinstallation, an actual Chrome native connection, and removal of the component and its registration while external dependencies remain. The source ZIP and build report are uploaded alongside the separate installer build artifacts. CI never publishes or claims unsigned installers have passed signed release verification; `verify-release.mjs` remains the independent gate for that distribution.

## Optional self-contained signed installers

The existing self-contained installer build remains available for maintainers who already have suitable signing identities. It is an alternative distribution, not a prerequisite for the source package. No payment or certificate enrollment is performed by any build script.

Run `node tools/video-component/build.mjs` on macOS or Windows; `--target=win` also supports a macOS cross build with MinGW-w64 and NSIS. Windows builds use `VIDEO_MSYS_BASH` and optionally `VIDEO_MSYS_PREFIX` and `VIDEO_MAKENSIS`. The installers contain Node.js, official standalone yt-dlp, and FFmpeg/FFprobe built from pinned source. Dependency URLs and SHA-256 values are in `tools/video-component/dependencies.json`; each bundled installer carries the exact FFmpeg source, build recipe and third-party notices.

For signed macOS distribution, use existing `VIDEO_MAC_APPLICATION_IDENTITY`, `VIDEO_MAC_INSTALLER_IDENTITY` and `VIDEO_MAC_NOTARY_PROFILE` configuration. For Windows, use existing `VIDEO_WINDOWS_CERTIFICATE_SHA1`, `VIDEO_WINDOWS_TIMESTAMP_URL` and optionally `VIDEO_SIGNTOOL`. Passwords and private material are not command arguments. `node tools/video-component/verify-release.mjs` continues to require signed, verified installer reports; unsigned local installer builds remain development artifacts. It is independent from the source-package verifier.

References: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [FFmpeg downloads](https://ffmpeg.org/download.html).
