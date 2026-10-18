// One preference controls development entry points without changing task errors or logs.
export function bindDiagnosticControls({ controls, toggle, preferences, storage = chrome.storage, save, onError, onDisable }) {
  let enabled = false, saving = false, changed = false;
  function render(value) {
    enabled = value?.diagnosticsEnabled === true;
    for (const control of controls) control.hidden = !enabled;
    if (toggle) { toggle.checked = enabled; toggle.disabled = saving; }
    if (!enabled) onDisable?.();
  }
  render(preferences);
  const listener = (changes, area) => {
    if (area !== 'local' || !changes.uiPreferences) return;
    changed = true;
    render(changes.uiPreferences.newValue);
  };
  storage.onChanged.addListener(listener);
  const ready = preferences ? Promise.resolve() : storage.local.get('uiPreferences').then(result => {
    if (!changed) render(result.uiPreferences);
  }).catch(error => onError?.(error));
  toggle?.addEventListener('change', async () => {
    if (saving) return;
    const next = toggle.checked;
    saving = true;
    toggle.disabled = true;
    try { render(await save({ diagnosticsEnabled: next })); }
    catch (error) { onError?.(error); }
    finally { saving = false; render({ diagnosticsEnabled: enabled }); }
  });
  return { ready, dispose: () => storage.onChanged.removeListener(listener) };
}
