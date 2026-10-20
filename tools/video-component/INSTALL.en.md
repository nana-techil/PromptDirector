# Install the free video component

[中文](INSTALL.zh.md)

This source package supports macOS and Windows. No paid account, developer certificate or Agent pairing is required. It connects free local Node.js, yt-dlp, FFmpeg and FFprobe installations. It does not download dependencies, accept agreements or change system security settings for you.

## Install with a local Agent (recommended)

Give this package to an Agent with permission to run on your computer, such as Codex, and send:

> Install the PromptDirector video component using INSTALL-AGENT.md in this package. Reuse or install the missing free dependencies, then install and verify it. Do not install Python or change system security settings; involve me only for required system authorization.

The Agent handles extraction, dependency checks, installation and verification. **Install with Agent** in the extension copies the complete request. Older extensions without that button can use the sentence above. See the [Agent installation guide](INSTALL-AGENT.md).

## Manual installation (alternative)

1. Install the dependencies below, or reuse existing installations.
2. **Extract the entire ZIP**. Do not run scripts inside the archive preview. Double-click `Install-macOS.command` on macOS or `Install-Windows.cmd` on Windows.
3. After the window confirms installation, return to PromptDirector. The pending capture resumes; select **Continue** if installation checks have paused.

The script finds tools automatically: no paths or manifest editing are required. Missing or blocked programs produce a visible error and download links. Install the dependency and run the same script again. After a package-manager installation, close old terminals before reopening the script.

## Dependencies

- **Node.js:** install free LTS from the [official download page](https://nodejs.org/en/download/), version 22.13 or newer.
- **yt-dlp:** follow the [official installation guide](https://github.com/yt-dlp/yt-dlp#installation). Official Windows/macOS standalone downloads include EJS for full YouTube support. Python installations should use `yt-dlp[default]`. The component uses Node.js to execute YouTube JavaScript challenges.
- **FFmpeg and FFprobe:** use the platform builds linked by the [FFmpeg download page](https://ffmpeg.org/download.html), including both programs. FFmpeg itself publishes source; the linked binaries are maintained by third parties. The similarly named Python package is not a substitute.

If you already use Homebrew on macOS:

```sh
brew install node yt-dlp ffmpeg
```

Homebrew is an independent open-source package manager, not an Apple or PromptDirector installer. Installing Homebrew is optional. See its [yt-dlp](https://formulae.brew.sh/formula/yt-dlp) and [FFmpeg](https://formulae.brew.sh/formula/ffmpeg) formulae.

If WinGet is available on Windows, inspect the packages and sources before installing:

```powershell
winget show --id OpenJS.NodeJS.LTS --exact --source winget
winget show --id yt-dlp.yt-dlp --exact --source winget
winget show --id Gyan.FFmpeg --exact --source winget
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id yt-dlp.yt-dlp --exact --source winget
winget install --id Gyan.FFmpeg --exact --source winget
```

WinGet is maintained by Microsoft; its catalog includes third-party distributions. These commands do not automatically accept agreements. Read the displayed source and open-source license terms; no paid service is needed. See [Microsoft's install documentation](https://learn.microsoft.com/en-us/windows/package-manager/winget/install). For manual downloads, put `yt-dlp` (the official macOS filename `yt-dlp_macos` also works), `ffmpeg` and `ffprobe` in a `tools/` folder inside the extracted package; Windows names end in `.exe`. The installer copies these tools into its own directory, without requiring PATH edits.

## System prompts, updates and removal

This is a reviewable source installation, not a signed/notarized application installer. macOS may ask you to review the source and explicitly allow opening it; Windows Smart App Control or organizational policy may block scripts or third-party dependencies. Package managers cannot guarantee that every device permits their packages. Follow [Apple's guidance](https://support.apple.com/en-us/102445) and [Microsoft's documentation](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview). Do not disable protection, skip integrity checks or remove security markers. If policy blocks installation, keep the pending capture and use an approved dependency distribution or contact your administrator.

To update, extract a newer source package and run Install again. Use the original package manager to update external dependencies; rerun Install if a dependency path changes. For manually downloaded tools, replace `tools/` with the updated files before reinstalling. Run the corresponding Uninstall script to remove only this component and its own Chrome registration. Browser cases, the Agent connector and separately installed dependencies remain intact.

Chrome starts the component on demand for video download, stream merging, probing and temporary-file reads. It has no persistent service, Agent pairing or telemetry. Video downloads access the source platform; the installation script itself makes no network requests. Temporary videos are removed on release or session shutdown; saved originals belong to the browser library. Installation metadata, including absolute dependency paths, stays in the current user's directory and is not uploaded.

PromptDirector attribution and licensing are in `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`. External programs retain their own licenses; free use still has license conditions. This source ZIP does not bundle their binaries.
