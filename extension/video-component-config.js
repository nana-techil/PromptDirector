// Stable asset names are shared by the installers and the in-context setup UI.
export const VIDEO_PROTOCOL_VERSION = 1;
export const VIDEO_COMPONENT = Object.freeze({
  host: 'com.promptdirector.video', version: '0.1.1', minimumVersion: '0.1.0', tag: 'video-v0.1.1',
  sourceAsset: 'PromptDirector-Video-Source.zip',
  assets: { mac: 'PromptDirector-Video-macOS.pkg', win: 'PromptDirector-Video-Windows.exe' }
});

export function videoComponentDownload(platform, homepage) {
  if (!Object.hasOwn(VIDEO_COMPONENT.assets, platform)) throw new Error('视频组件目前支持 Windows 和 macOS');
  const asset = VIDEO_COMPONENT.sourceAsset;
  return `${videoComponentRepository(homepage)}/releases/download/${VIDEO_COMPONENT.tag}/${asset}`;
}

function videoComponentRepository(homepage) {
  const repository = new URL(homepage);
  if (repository.protocol !== 'https:' || repository.hostname !== 'github.com') throw new Error('视频组件下载地址不可用');
  return repository.href.replace(/\/$/u, '');
}

export function videoComponentInstallRequest(locale, homepage) {
  const guide = `${videoComponentRepository(homepage)}/blob/main/tools/video-component/INSTALL-AGENT.md`;
  return locale === 'en'
    ? `Install the PromptDirector video component on my computer. Follow the official guide: ${guide}\nReuse an extracted package I provided, or obtain the latest official video-component source release. Detect my OS and existing tools, install only missing free dependencies from official or officially recommended sources, then install and verify the component. Do not require Python or change system security settings. Ask me only for unavoidable system authorization. Verify Chrome's connection and save and reopen the video I am trying to capture when browser access is available; clearly report any unverified step.`
    : `帮我在本机安装 PromptDirector 视频组件。请按官方指南完成：${guide}\n优先使用我提供的已解压组件包，否则取得官方最新视频组件源码包；自动识别系统、复用现有工具，仅从官方或官方推荐来源补齐缺少的免费依赖，再完成安装和验证。不要要求安装 Python，不修改系统安全设置，只在确实需要我操作的系统授权处停下。有浏览器操作权限时，验证 Chrome 连接并保存、重开我正在采集的视频；未验证的环节如实说明。`;
}

export function videoComponentRequired(message) {
  return Object.assign(new Error(message || '此视频需要安装视频组件'), { code: 'video_component_required' });
}

export function videoComponentCurrent(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version || '')) return false;
  const current = version.split('.').map(Number), minimum = VIDEO_COMPONENT.minimumVersion.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) if (current[index] !== minimum[index]) return current[index] > minimum[index];
  return true;
}
