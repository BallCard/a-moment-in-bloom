/**
 * 首次使用提示：只在本机记录一次，和作品内容分开。
 *
 * 和 EmptyGuide 一样走 localStorage，而不是写进作品 JSON；读不到（隐私模式 / 禁用存储）
 * 就当已经看过，宁可少提示一次，也不要每次打开都弹。
 */
export type FirstUseHintId = 'view-wheel' | 'view-drag';

const PREFIX = 'bouquet-workbench.first-use.';

function key(id: FirstUseHintId): string {
  return `${PREFIX}${id}`;
}

export function hasSeenFirstUse(id: FirstUseHintId): boolean {
  try {
    return localStorage.getItem(key(id)) === '1';
  } catch {
    return true;
  }
}

export function markFirstUseSeen(id: FirstUseHintId): void {
  try {
    localStorage.setItem(key(id), '1');
  } catch {
    /* 记不住就这次先提示，不影响使用 */
  }
}
