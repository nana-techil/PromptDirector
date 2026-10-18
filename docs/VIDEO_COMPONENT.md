# Video component / 视频组件

## 免费源码安装 / Free source installation

能直接保存的视频无需安装组件。需要本机处理时，在采集侧栏下载 `PromptDirector-Video-Source.zip`，完整解压，按包内 `INSTALL.zh.md` / `INSTALL.en.md` 安装免费的 Node.js、yt-dlp、FFmpeg/FFprobe，然后双击 `Install-macOS.command` 或 `Install-Windows.cmd`。成功后返回插件，原采集自动继续；若检查已暂停，点“继续”。关闭侧栏后重新打开仍可接续；取消的保存不会因安装完成自动提交。

不需要付费账号、开发者证书、Agent 配对、填写路径或手写 manifest。安装脚本只自动查找已安装依赖和包内可选 `tools/` 文件夹，不下载依赖、不代替用户接受协议、不改变系统保护。工具缺失或被系统拦截时给出具体来源，保留待保存内容。完整步骤及官方来源见[中文安装说明](../tools/video-component/INSTALL.zh.md)和 [English installation guide](../tools/video-component/INSTALL.en.md)。

Directly available originals need no component. When prompted, download and fully extract `PromptDirector-Video-Source.zip`, install the free dependencies listed in its guide, then double-click the platform's Install script. Return to the extension to resume the pending capture, or select Continue if checks paused. No paid account, developer certificate, Agent pairing or manual path editing is required. The installer does not download dependencies, accept agreements or weaken system protection.

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
