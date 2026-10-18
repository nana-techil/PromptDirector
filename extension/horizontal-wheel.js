// A vertical mouse wheel can reach the end of single-row action/media strips.
// At either boundary, normal page scrolling remains available.
export function installHorizontalWheel(root, selector) {
  root.addEventListener('wheel', event => {
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const strip = event.target.closest(selector);
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    const style = getComputedStyle(strip);
    const unit = event.deltaMode === 2 ? strip.clientWidth
      : event.deltaMode === 1 ? (parseFloat(style.lineHeight) || parseFloat(style.fontSize)) : 1;
    const previous = strip.scrollLeft;
    strip.scrollLeft += event.deltaY * unit;
    if (strip.scrollLeft !== previous) event.preventDefault();
  }, { passive: false });
}
