// Arrange existing detail sections without recreating editors, players or drafts.
function restoreWorkspaceFocus(body, focused) {
  // Another control already holds focus inside the re-arranged body: never steal it.
  const active = document.activeElement;
  if (active && active !== document.body && active !== body && body.contains(active)) return;
  if (focused.node?.isConnected) {
    focused.node.focus({ preventScroll: true });
    if (focused.selection && typeof focused.node.setSelectionRange === 'function') focused.node.setSelectionRange(...focused.selection);
    return;
  }
  if (!focused.ariaLabel) return;
  const scopes = focused.promptKey
    ? [...body.querySelectorAll('[data-prompt-key]')].filter(node => node.dataset.promptKey === focused.promptKey)
    : [body];
  for (const scope of scopes) {
    const target = [...scope.querySelectorAll('[aria-label]')]
      .find(node => node.getAttribute('aria-label') === focused.ariaLabel && node.getClientRects().length);
    if (!target) continue;
    target.focus({ preventScroll: true });
    if (focused.selection && typeof target.setSelectionRange === 'function') target.setSelectionRange(...focused.selection);
    return;
  }
}

export function unwrapDetailWorkspace(body) {
  const primary = body?.parentElement;
  if (!primary?.classList.contains('detail-workspace')) return;
  const focused = document.activeElement;
  if (primary.contains(focused)) {
    // Re-arranging detaches every section before re-appending it, so the focused
    // node itself may be replaced while the section is refreshed. Keep a semantic
    // identity as well, and restore focus on the equivalent new control.
    body.workspaceFocus = { node: focused, selection: focused.tagName === 'TEXTAREA' ? [focused.selectionStart, focused.selectionEnd] : null,
      promptKey: focused.closest('[data-prompt-key]')?.dataset.promptKey || '',
      ariaLabel: focused.getAttribute('aria-label') || '' };
  }
  const reading = body.querySelector(':scope > .detail-reading');
  const footer = primary.querySelector('.detail-workspace-footer');
  body.detailReadingTop = reading?.scrollTop || 0;
  reading?.disposeReading?.();
  const prompt = reading?.querySelector(':scope > .prompt-section');
  const actions = footer?.querySelector(':scope > .detail-core-actions');
  if (prompt && actions) prompt.append(actions);
  const header = primary.querySelector(':scope > .detail-header-section');
  header?.querySelector('.entry-editor-body')?.classList.remove('ui-floating-panel');
  const palette = primary.workspacePalette;
  if (palette && header) header.append(palette);
  footer?.remove();
  body.replaceChildren(...(header ? [header] : []), ...(reading?.children || []), ...(footer?.children || []));
  primary.classList.remove('detail-workspace');
}

export function arrangeDetailWorkspace(body) {
  const primary = body?.parentElement;
  if (!primary?.parentElement?.classList.contains('has-primary-media')) return;
  if (primary.classList.contains('detail-workspace')) return;
  const header = body.querySelector(':scope > .detail-header-section');
  if (!header) return;
  const reading = document.createElement('div');
  reading.className = 'detail-reading ui-scrollbar';
  reading.tabIndex = 0;
  const footer = document.createElement('footer');
  footer.className = 'detail-workspace-footer';
  const organization = body.querySelector(':scope > .detail-quick-organization');
  const actions = body.querySelector('.prompt-section > .detail-core-actions');
  const palette = header.querySelector('.detail-palette');
  primary.workspacePalette = palette;
  const mediaTools = primary.querySelector('.detail-media-tools');
  if (palette && mediaTools) {
    const caption = mediaTools.parentElement;
    let context = caption.querySelector('.detail-media-context');
    if (!context) {
      context = document.createElement('div');
      context.className = 'detail-media-context';
      context.append(...[...caption.children].filter(child => child !== mediaTools));
      caption.prepend(context);
    }
    caption.insertBefore(palette, mediaTools);
  }
  else if (palette) footer.prepend(palette);
  if (organization) footer.append(organization);
  if (actions) footer.append(actions);
  header.querySelector('.entry-editor-body')?.classList.add('ui-floating-panel');
  primary.prepend(header);
  reading.append(...body.children);
  body.append(reading, footer);
  body.classList.remove('ui-scrollbar');
  primary.classList.add('detail-workspace');
  reading.scrollTop = body.detailReadingTop || 0;
  const focused = body.workspaceFocus;
  if (focused) restoreWorkspaceFocus(body, focused);
  delete body.workspaceFocus;
  let quiet;
  reading.addEventListener('scroll', () => {
    if (!reading.classList.contains('is-scrolling')) reading.classList.add('is-scrolling');
    clearTimeout(quiet);
    quiet = setTimeout(() => reading.classList.remove('is-scrolling'), 800);
  }, { passive: true });
  // Only the header determines the resizer/popover offset. Never couple pane heights.
  const measureHeader = () => primary.style.setProperty('--workspace-header-size', `${header.getBoundingClientRect().height}px`);
  const resize = new ResizeObserver(measureHeader);
  resize.observe(header);
  reading.disposeReading = () => { clearTimeout(quiet); resize.disconnect(); };
  body.disposeWorkspace = reading.disposeReading;
  measureHeader();
}
