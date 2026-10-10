export function bindTransientMenus(root = document, selector = "") {
  const cleanSelector = String(selector).trim();
  if (!cleanSelector) throw new Error("临时菜单选择器不能为空");

  const menus = () => [...root.querySelectorAll(cleanSelector)];
  const closestMenu = (target) => target instanceof Element ? target.closest(cleanSelector) : null;
  const closeMenus = (except = null) => {
    for (const menu of menus()) {
      if (menu !== except) menu.open = false;
    }
  };

  const onPointerDown = (event) => closeMenus(closestMenu(event.target));
  const onClick = (event) => {
    const current = closestMenu(event.target);
    if (!current) {
      closeMenus();
      return;
    }
    const action = event.target instanceof Element ? event.target.closest("button, a[href]") : null;
    if (action && !action.closest(".package-preferences") && !action.closest('[data-menu-interactive]')) current.open = false;
  };
  const onToggle = (event) => {
    const current = closestMenu(event.target);
    if (current?.open) closeMenus(current);
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    const open = menus().filter((menu) => menu.open);
    if (!open.length) return;
    event.preventDefault();
    closeMenus();
    open.at(-1)?.querySelector(":scope > summary")?.focus();
  };

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("click", onClick, true);
  root.addEventListener("toggle", onToggle, true);
  root.addEventListener("keydown", onKeyDown, true);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("toggle", onToggle, true);
    root.removeEventListener("keydown", onKeyDown, true);
  };
}

// Keep disclosure menus out of toolbar layout and above scrolling dialog bodies.
// Uses the same top-layer pattern as the tag palette and shared popover spacing.
export function bindPopoverMenu(details, panel) {
  const anchor = details.querySelector(':scope > summary');
  panel.popover = 'manual';
  panel.classList.add('ui-floating-panel', 'ui-action-menu', 'ui-popover-menu');
  panel.id ||= `menu-${crypto.randomUUID()}`;
  anchor.setAttribute('aria-controls', panel.id);
  let events;
  const close = () => { details.open = false; };
  const sync = () => {
    events?.abort();
    anchor.setAttribute('aria-expanded', String(details.open));
    if (!details.open) { if (panel.matches(':popover-open')) panel.hidePopover(); return; }
    panel.showPopover();
    const style = getComputedStyle(panel);
    const inset = parseFloat(style.getPropertyValue('--ui-popover-viewport-inset'));
    const gap = parseFloat(style.getPropertyValue('--ui-popover-gap'));
    const bounds = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(inset, Math.min(bounds.left, innerWidth - panel.offsetWidth - inset))}px`;
    panel.style.top = `${Math.max(inset, Math.min(bounds.bottom + gap, innerHeight - panel.offsetHeight - inset))}px`;
    events = new AbortController();
    window.addEventListener('resize', close, { signal: events.signal });
    document.addEventListener('scroll', event => { if (!panel.contains(event.target)) close(); }, { signal: events.signal, capture: true });
  };
  details.addEventListener('toggle', sync);
  return () => {
    events?.abort(); details.removeEventListener('toggle', sync);
    if (panel.matches(':popover-open')) panel.hidePopover();
  };
}
