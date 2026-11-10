/** 浏览器下载小工具：全部通过 Blob + <a download>，不拼 HTML。 */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间戳，例如 20261105-142530。 */
export function timestampSuffix(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function bouquetFileName(extension: 'png' | 'json', date = new Date()): string {
  return `bouquet-${timestampSuffix(date)}.${extension}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 给浏览器一点时间开始下载，再释放对象 URL。
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
