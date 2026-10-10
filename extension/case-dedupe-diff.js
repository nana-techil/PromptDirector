// Bounded-memory character ranges, split at ordered unique word anchors.
export function textDifference(left, right) {
  left = String(left ?? ''); right = String(right ?? '');
  let start = 0, end = 0;
  while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
  while (end < Math.min(left.length, right.length) - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return { before: left.slice(0, start), left: left.slice(start, left.length - end),
    right: right.slice(start, right.length - end), after: end ? left.slice(-end) : '' };
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
function uniqueWords(text) {
  const words = new Map();
  for (const part of segmenter.segment(text)) if (part.isWordLike) words.set(part.segment, words.has(part.segment) ? null : part.index);
  return words;
}
export function textDifferenceParts(left, right) {
  left = String(left ?? ''); right = String(right ?? '');
  const common = textDifference(left, right), a = uniqueWords(common.left), b = uniqueWords(common.right);
  const pairs = [...a].filter(([word, pos]) => pos !== null && b.get(word) != null)
    .map(([word, pos]) => ({ word, a: pos, b: b.get(word) }));
  const tails = [], parent = [];
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]].b < pairs[i].b) lo = mid + 1; else hi = mid; }
    parent[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
  }
  const anchors = []; for (let i = tails.at(-1) ?? -1; i >= 0; i = parent[i]) anchors.unshift(pairs[i]);
  const parts = [{ same: common.before }]; let x = 0, y = 0;
  for (const anchor of [...anchors, { word: '', a: common.left.length, b: common.right.length }]) {
    const gap = textDifference(common.left.slice(x, anchor.a), common.right.slice(y, anchor.b));
    parts.push({ same: gap.before }, { left: gap.left, right: gap.right }, { same: gap.after + anchor.word });
    x = anchor.a + anchor.word.length; y = anchor.b + anchor.word.length;
  }
  parts.push({ same: common.after }); return parts;
}
export function appendTextDifference(container, left, right, side) {
  for (const part of textDifferenceParts(left, right)) {
    if (part.same) container.append(document.createTextNode(part.same));
    else if (part[side]) { const mark = document.createElement('mark'); mark.textContent = part[side]; container.append(mark); }
  }
}
