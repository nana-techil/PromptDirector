// A single visual indicator follows existing ARIA state, without owning selection.
export function mountSelectionIndicator(group, { selector, attribute, underline = false }) {
  if (!group) return;
  group.classList.add('ui-selection-group');
  function sync() {
    const active = group.querySelector(`${selector}[${attribute}="true"]`);
    if (!active?.offsetWidth) return;
    group.style.setProperty('--indicator-x', `${active.offsetLeft}px`);
    group.style.setProperty('--indicator-y', `${active.offsetTop + (underline ? active.offsetHeight - 2 : 0)}px`);
    group.style.setProperty('--indicator-width', `${active.offsetWidth}px`);
    group.style.setProperty('--indicator-height', `${underline ? 2 : active.offsetHeight}px`);
    group.classList.add('ui-selection-ready');
  }
  new ResizeObserver(sync).observe(group);
  new MutationObserver(sync).observe(group, { subtree: true, attributes: true, attributeFilter: [attribute] });
  sync();
}
