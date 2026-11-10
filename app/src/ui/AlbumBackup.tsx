/**
 * 相册备份/恢复与满额拦截弹层（V6 P0-A）。
 *
 * - AlbumBlockDialog：相册满 12 件时新增被拒绝，给出「打开相册管理 / 下载备份 / 取消」。
 * - AlbumRestoreDialog：先校验备份并显示新增/重复/超额数量，由玩家选择保留方式。
 */

import { useEffect } from 'react';
import { ALBUM_LIMIT } from '../config';
import { formatAlbumBytes } from '../data/album';
import { ALBUM_BACKUP_VERSION, type AlbumRestoreMode, type AlbumRestoreParse } from '../data/album-backup';
import { store } from '../state/store';
import { useAppState } from '../state/useStore';
import { downloadBlob, timestampSuffix } from '../utils/download';

/** 导出完整相册备份并触发下载；成功后才提示保存数量。 */
export function downloadAlbumBackup(): void {
  const payload = store.createAlbumBackup();
  downloadBlob(
    new Blob([payload.text], { type: 'application/json' }),
    `huajian-album-backup-${timestampSuffix()}.json`,
  );
  store.toast(
    `已导出相册备份：${payload.entryCount} 件 / ${payload.photoCount} 张照片 / ${formatAlbumBytes(payload.bytes)}`,
    'success',
  );
}

const BLOCK_BODY: Record<'save' | 'deliver' | 'archive', string> = {
  save: '这一件作品没有保存。旧作品和照片都还在，数量上限与浏览器容量是两回事：先把相册清理出一件，再回来保存。',
  deliver: '这次交付没有保存，委托没有标记完成。工作台、委托进度和照片都保留着；清理出一件作品后再交付。',
  archive: '接单前这束作品没有归档，所以没有接单，工作台也没有清空。清理出一件作品后再试一次。',
};

/** 相册满额拦截弹层：数量到上限时新增/交付/接单归档被拒绝。 */
export function AlbumBlockDialog(): React.JSX.Element | null {
  const blocker = useAppState((s) => s.albumBlocker);
  useEffect(() => {
    if (!blocker) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      store.dismissAlbumBlocker();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [blocker]);
  if (!blocker) return null;
  const title =
    blocker.intent === 'save'
      ? '相册满了，这件没保存'
      : blocker.intent === 'deliver'
        ? '相册满了，这次交付没保存'
        : '相册满了，没有接单';
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && store.dismissAlbumBlocker()}
    >
      <div
        className="modal album-block"
        role="dialog"
        aria-modal="true"
        aria-label="相册已满"
        data-testid="album-block-dialog"
        data-intent={blocker.intent}
      >
        <div className="modal-head">
          <div>
            <p className="modal-eyebrow">相册已满</p>
            <h2>{title}</h2>
          </div>
          <button
            className="modal-close"
            aria-label="关闭"
            data-testid="album-block-close"
            onClick={() => store.dismissAlbumBlocker()}
          >
            ×
          </button>
        </div>
        <p className="album-block-reason" data-testid="album-block-reason">
          {BLOCK_BODY[blocker.intent]}
        </p>
        <dl className="album-restore-counts album-block-stats">
          <div>
            <dt>已有作品</dt>
            <dd data-testid="album-block-count">
              {blocker.albumCount} / {blocker.albumLimit} 件
            </dd>
          </div>
          <div>
            <dt>相册数据量</dt>
            <dd data-testid="album-block-bytes">约 {formatAlbumBytes(blocker.bytes)}</dd>
          </div>
          {blocker.entryName ? (
            <div>
              <dt>这次的作品</dt>
              <dd>「{blocker.entryName}」</dd>
            </div>
          ) : null}
        </dl>
        <p className="modal-note">
          清理前可以先下载完整备份（含照片、制作版本、封面、委托记录与回应）。删除只在相册里点选具体作品并二次确认。
        </p>
        <div className="album-block-actions">
          <button
            className="btn btn-primary"
            data-testid="album-block-manage"
            onClick={() => store.manageAlbumFromBlocker()}
          >
            打开相册管理
          </button>
          <button className="btn" data-testid="album-block-backup" onClick={() => downloadAlbumBackup()}>
            下载备份
          </button>
          <button className="btn" data-testid="album-block-cancel" onClick={() => store.dismissAlbumBlocker()}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

export interface AlbumRestoreDialogState {
  fileName: string;
  parse: AlbumRestoreParse;
}

const formatStampISO = (value: string | null): string => {
  if (!value) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN');
};

/** 备份恢复弹层：先显示校验结果与新增/重复/超额数量，再由玩家选保留方式。 */
export function AlbumRestoreDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: AlbumRestoreDialogState | null;
  onClose: () => void;
  onConfirm: (mode: AlbumRestoreMode) => void;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [state, onClose]);
  if (!state) return null;
  const { parse, fileName } = state;
  if (!parse.ok) {
    return (
      <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          className="modal album-restore"
          role="dialog"
          aria-modal="true"
          aria-label="备份无法恢复"
          data-testid="album-restore-dialog"
          data-restore-state="invalid"
        >
          <div className="modal-head">
            <div>
              <p className="modal-eyebrow">恢复相册备份</p>
              <h2>这份备份暂时用不了</h2>
            </div>
            <button className="modal-close" aria-label="关闭" data-testid="album-restore-close" onClick={onClose}>
              ×
            </button>
          </div>
          <p className="album-block-reason" data-testid="album-restore-error">
            {parse.message}
          </p>
          <p className="modal-note">原相册没有任何改动。</p>
          <div className="album-block-actions">
            <button className="btn btn-primary" data-testid="album-restore-cancel" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }
  const preview = parse.preview;
  const over = preview.overLimit > 0;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal album-restore"
        role="dialog"
        aria-modal="true"
        aria-label="恢复相册备份"
        data-testid="album-restore-dialog"
        data-restore-state={over ? 'over-limit' : 'ready'}
      >
        <div className="modal-head">
          <div>
            <p className="modal-eyebrow">恢复相册备份</p>
            <h2>先看看这份备份里有什么</h2>
            <p className="modal-note" data-testid="album-restore-file">
              {fileName} · 备份版本 v{preview.backupVersion} / 当前 v{ALBUM_BACKUP_VERSION} · 导出于{' '}
              {formatStampISO(preview.exportedAt)} · {formatAlbumBytes(preview.bytes)}
            </p>
          </div>
          <button className="modal-close" aria-label="关闭" data-testid="album-restore-close" onClick={onClose}>
            ×
          </button>
        </div>
        <dl className="album-restore-counts">
          <div>
            <dt>备份内容</dt>
            <dd>
              {preview.totalEntries} 件作品 · {preview.totalPhotos} 张照片
            </dd>
          </div>
          <div>
            <dt>新增</dt>
            <dd data-testid="album-restore-new">
              {preview.newEntries} 件 · {preview.newPhotos} 张照片
            </dd>
          </div>
          <div>
            <dt>重复</dt>
            <dd data-testid="album-restore-duplicate">
              {preview.duplicateEntries} 件 · {preview.duplicatePhotos} 张照片
            </dd>
          </div>
          <div>
            <dt>超额</dt>
            <dd data-testid="album-restore-over" data-over={over ? '1' : '0'}>
              {preview.overLimit} 件{over ? `（超过 ${ALBUM_LIMIT} 件上限，不能写入）` : ''}
            </dd>
          </div>
          {preview.skippedPhotos > 0 ? (
            <div>
              <dt>每件 6 照</dt>
              <dd>跳过重复时另有 {preview.skippedPhotos} 张无法追加</dd>
            </div>
          ) : null}
        </dl>
        <p className="modal-note">
          重复按稳定 ID（作品 ID + 照片 ID）判断，不会静默覆盖。{over ? '请先删掉几件旧作品再恢复；现在恢复会停止写入并保留原相册。' : '恢复后相册会刷新，重新打开页面仍然保留。'}
        </p>
        <div className="album-block-actions">
          <button
            className="btn btn-primary"
            data-testid="album-restore-skip"
            disabled={over}
            onClick={() => onConfirm('skip')}
          >
            跳过重复，只加新
          </button>
          <button
            className="btn"
            data-testid="album-restore-replace"
            disabled={over}
            onClick={() => onConfirm('replace')}
          >
            用备份替换同名记录
          </button>
          <button className="btn" data-testid="album-restore-cancel" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
