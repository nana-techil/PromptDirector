// Presentation adapter: preference values and persistence remain owned by the caller.
export function bindAppearanceControls({ dark, system, motion, getPreferences, save, onError, systemDark }) {
  let saving = false;
  function sync() {
    const preferences = getPreferences();
    system.checked = preferences.theme === 'system';
    dark.checked = system.checked ? systemDark.matches : preferences.theme === 'dark';
    motion.checked = preferences.motion === 'reduced';
    dark.disabled = saving || system.checked;
    system.disabled = motion.disabled = saving;
  }
  async function commit(change) {
    if (saving) return;
    saving = true;
    dark.disabled = system.disabled = motion.disabled = true;
    try { await save(change); }
    catch (error) { onError(error); }
    finally { saving = false; sync(); }
  }
  dark.addEventListener('change', () => commit({ theme: dark.checked ? 'dark' : 'light' }));
  system.addEventListener('change', () => commit({ theme: system.checked ? 'system' : systemDark.matches ? 'dark' : 'light' }));
  motion.addEventListener('change', () => commit({ motion: motion.checked ? 'reduced' : 'system' }));
  systemDark.addEventListener('change', sync);
  sync();
  return { sync };
}
