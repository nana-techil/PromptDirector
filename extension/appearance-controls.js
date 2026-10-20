// Presentation adapter: preference values and persistence remain owned by the caller.
export function bindAppearanceControls({ theme, motion, getPreferences, save, onError }) {
  let saving = false;
  function sync() {
    const preferences = getPreferences();
    theme.value = preferences.theme;
    motion.checked = preferences.motion === 'reduced';
    theme.disabled = motion.disabled = saving;
  }
  async function commit(change) {
    if (saving) return;
    saving = true;
    theme.disabled = motion.disabled = true;
    try { await save(change); }
    catch (error) { onError(error); }
    finally { saving = false; sync(); }
  }
  theme.addEventListener('change', () => commit({ theme: theme.value }));
  motion.addEventListener('change', () => commit({ motion: motion.checked ? 'reduced' : 'system' }));
  sync();
  return { sync };
}
