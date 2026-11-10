import { useRef, useState } from 'react';
import { serializeDocument, parseImportedDocument } from '../data/importExport';
import { store } from '../state/store';
import { bouquetFileName, downloadBlob, formatBytes } from '../utils/download';

interface Props {
  onExportPng: () => Promise<{ blob: Blob; width: number; height: number }>;
  onImported: () => void;
}

/**
 * 作品文件（导出 PNG / JSON、导入 JSON）收在顶栏「更多」里：
 * 不常驻占画面，但任何阶段都能用；导入失败不会覆盖手头的作品。
 */
export function FileTools({ onExportPng, onImported }: Props): React.JSX.Element {
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportPng = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await onExportPng();
      const filename = bouquetFileName('png');
      downloadBlob(result.blob, filename);
      setLastExport(`上次导出：${result.width}×${result.height} · ${formatBytes(result.blob.size)}`);
      store.toast(`PNG 已导出（${result.width}×${result.height}）`, 'success');
    } catch {
      store.toast('导出 PNG 失败了，再试一次吧', 'warn');
    } finally {
      setExporting(false);
    }
  };

  const exportJson = (): void => {
    const doc = store.getDocumentForExport();
    downloadBlob(
      new Blob([serializeDocument(doc)], { type: 'application/json' }),
      bouquetFileName('json'),
    );
    store.toast('作品 JSON 已导出', 'success');
  };

  const importJson = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const preview = parseImportedDocument(text, store.getState().catalog);
      store.replaceDocument(preview.doc);
      const versionHint =
        preview.sourceVersion < 3 ? `旧版 v${preview.sourceVersion}` : `v${preview.sourceVersion}`;
      store.toast(`已导入 ${versionHint} 作品，共 ${preview.doc.stems.length} 枝`, 'success');
      for (const warning of preview.warnings.slice(0, 2)) store.toast(warning, 'info');
      onImported();
    } catch (error) {
      store.toast(error instanceof Error ? error.message : '导入失败，当前作品没动', 'warn');
    }
  };

  return (
    <div className="file-tools">
      <button
        type="button"
        className="menu-row"
        data-testid="export-png"
        disabled={exporting}
        onClick={() => void exportPng()}
      >
        {exporting ? '正在导出…' : '导出 PNG'}
      </button>
      <button type="button" className="menu-row" data-testid="export-json" onClick={exportJson}>
        导出 JSON
      </button>
      <button
        type="button"
        className="menu-row"
        data-testid="import-json"
        onClick={() => fileInputRef.current?.click()}
      >
        导入作品 JSON…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        data-testid="import-file"
        onChange={(event) => void importJson(event)}
      />
      <p className="menu-note">
        {lastExport || '导出只留 3D 画面；导入前先校验，失败不覆盖当前作品。'}
      </p>
    </div>
  );
}
