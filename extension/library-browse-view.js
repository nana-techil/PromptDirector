import { createUiIcon } from './ui-icons.js';
import { LIST_COLUMNS, formatListBytes } from './library-list.js';

export function appendCaseRowDetails(card, entry, { metadata, locale }) {
  if (!card.querySelector('img')) {
    card.classList.add('has-row-placeholder');
    const placeholder = document.createElement('span');
    placeholder.className = 'case-row-placeholder';
    placeholder.append(createUiIcon('file-text'));
    card.append(placeholder);
  }
  const details = document.createElement('div');
  details.className = 'case-row-details';
  for (const [key] of LIST_COLUMNS) {
    const cell = document.createElement(key === 'title' ? 'strong' : key === 'added' ? 'time' : 'span');
    cell.className = `case-row-${key}`;
    cell.dataset.column = key;
    const value = metadata[key];
    if (key === 'added' && value) {
      cell.dateTime = value;
      cell.textContent = new Date(value).toLocaleDateString(locale);
    } else if (key === 'size') {
      cell.textContent = metadata.size == null && metadata.knownBytes ? `≥ ${formatListBytes(metadata.knownBytes, locale)}` : formatListBytes(value, locale);
    } else cell.textContent = value === '' || value == null ? '—' : String(value);
    cell.title = cell.textContent;
    details.append(cell);
  }
  card.append(details);
}
