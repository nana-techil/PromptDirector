// Device-local permission handles stay outside portable library settings.
export async function shareDirectory(value = undefined) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('promptdirector-share-location', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('state', value === undefined ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('state');
      const request = value === undefined ? store.get('directory') : value === null ? store.delete('directory') : store.put(value, 'directory');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function writeShareArchive(directory, blob, filename) {
  if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('分享文件夹尚未授权，请重新选择文件夹');
  const name = filename.split('/').at(-1);
  const stem = name.replace(/\.zip$/iu, '');
  let candidate = name, sequence = 0;
  while (true) {
    try { await directory.getFileHandle(candidate); }
    catch (error) { if (error.name === 'NotFoundError') break; throw error; }
    candidate = `${stem} (${++sequence}).zip`;
  }
  const handle = await directory.getFileHandle(candidate, { create: true });
  try {
    const writable = await handle.createWritable();
    await blob.stream().pipeTo(writable);
    const saved = await handle.getFile();
    if (saved.size !== blob.size) throw new Error('分享包写入不完整，请重试');
  } catch (error) {
    try { await directory.removeEntry(candidate); } catch { /* Report the original write failure. */ }
    throw error;
  }
  return candidate;
}
