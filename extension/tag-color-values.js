export const tagColorKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
export function normalizeTagColors(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([key, color]) => tagColorKey(key) && /^#[a-f0-9]{6}$/iu.test(color))
    .map(([key, color]) => [tagColorKey(key), color.toLowerCase()]));
}
