# 免费安装视频组件

[English](INSTALL.en.md)

此源码包支持 macOS 和 Windows，不需要付费账号、开发者证书或 Agent 配对。它连接本机免费的 Node.js、yt-dlp、FFmpeg 和 FFprobe；不会替你下载软件、接受协议或调整系统保护。

1. 安装下方依赖。已安装的可以直接复用。
2. **完整解压 ZIP**，不要在压缩文件预览里运行。macOS 双击 `Install-macOS.command`；Windows 双击 `Install-Windows.cmd`。
3. 窗口显示安装成功后，返回 PromptDirector，待保存视频会继续；如侧栏已暂停，点“继续”。关闭安装窗口不影响浏览器资料库。

安装脚本会自动定位依赖，不需要填写路径或手写配置。找不到依赖或系统阻止运行时，窗口保留具体错误和下载地址；安装依赖后重新运行同一脚本。若用包管理器刚装好依赖，请先关闭旧终端再打开脚本。

## 安装依赖

- **Node.js**：从 [Node.js 官方下载页](https://nodejs.org/en/download/)安装免费的 LTS 版（至少 22.13）。
- **yt-dlp**：使用 [yt-dlp 官方安装说明](https://github.com/yt-dlp/yt-dlp#installation)。官方 Windows/macOS standalone 包自带完整 YouTube 支持所需的 EJS；Python 安装应选 `yt-dlp[default]`。组件使用 Node.js 执行 YouTube 的 JavaScript challenge。
- **FFmpeg / FFprobe**：从 [FFmpeg 官方下载页](https://ffmpeg.org/download.html)列出的平台构建来源安装，必须同时包含这两个程序。FFmpeg 官方发布源码，页面列出的二进制由第三方维护；不是同名 Python 包。

已使用 Homebrew 的 macOS 用户可在终端执行下面这条命令。Homebrew 是独立的开源包管理器，并非 Apple 或 PromptDirector 的安装器；不要求为此先安装 Homebrew。

```sh
brew install node yt-dlp ffmpeg
```

Windows 已有 WinGet 时，可先查看来源和软件信息，再执行安装：

```powershell
winget show --id OpenJS.NodeJS.LTS --exact --source winget
winget show --id yt-dlp.yt-dlp --exact --source winget
winget show --id Gyan.FFmpeg --exact --source winget
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id yt-dlp.yt-dlp --exact --source winget
winget install --id Gyan.FFmpeg --exact --source winget
```

WinGet 由 Microsoft 维护，但其软件清单包含第三方发行包。命令不自动接受协议；阅读系统显示的来源与开源许可，不选择付费服务。参见 [WinGet 官方安装说明](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)、[Homebrew yt-dlp](https://formulae.brew.sh/formula/yt-dlp)与 [FFmpeg](https://formulae.brew.sh/formula/ffmpeg)。若手动下载二进制，可把 `yt-dlp`（macOS 官方文件名 `yt-dlp_macos` 也支持）、`ffmpeg`、`ffprobe` 放进解压包的 `tools/` 文件夹；Windows 文件带 `.exe` 后缀。脚本会把这些工具复制到组件自己的目录，无需设置 PATH。

## 系统提示、更新和卸载

这是公开源码安装流程，不是签名、公证的一键应用安装器。macOS 可能要求你核对来源后单独确认打开；Windows Smart App Control 或组织策略可能阻止脚本或第三方依赖。包管理器也不保证所有设备放行。遵循 [Apple 官方提示](https://support.apple.com/en-us/102445)和 [Microsoft 说明](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)；不要关闭系统保护、跳过哈希检查或删除安全标记。不能运行时保留待采集内容，联系系统管理员或使用已获信任的依赖发行方式。

更新时解压新源码包，再运行 Install 脚本。通过包管理器安装的依赖由该包管理器更新；更新后若组件提示工具缺失，重新运行 Install。手动工具更新时，用新版替换包内 `tools/` 后再安装。卸载时运行相应 `Uninstall` 脚本；它只移除这个视频组件和属于它的 Chrome 注册，不删除浏览器案例、Agent 连接器或通过其他渠道安装的依赖。

组件只在 Chrome 请求时启动，执行视频下载、音视频合并、探测和临时文件读取；没有常驻服务、Agent 配对或遥测。视频下载会访问作品平台，安装脚本本身不联网。临时视频在释放或会话结束时清理，保存后的原件归浏览器资料库管理。组件安装信息记录在当前用户目录，包括依赖绝对路径，不会上传。

PromptDirector 的许可与署名见包内 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。外部工具保留各自许可；免费不代表没有开源许可条件。此源码 ZIP 不捆绑这些工具的二进制。
