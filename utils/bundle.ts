// bundle.ts — the Redline export/import file format.
//
// A bundle is a .zip: a `changeset.json` describing every text/image change for
// an origin, plus the replacement images under `assets/` (referenced by name).
// `buildExport` turns a stored session into that bundle; `readBundle` parses a
// dropped/imported file (zip or legacy plain JSON) back into data + assets.

import { zipSync, unzipSync } from '@/utils/zip';
import { diffPreview } from '@/utils/diff';
import type { Session } from '@/utils/types';

// ---- image bytes <-> data URL + filename helpers ----------------------------
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = (dataUrl || '').split(',')[1] || '';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  return `data:${mime || 'image/png'};base64,` + btoa(bin);
}

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' };
function extFor(mime: string, fileName: string): string {
  if (fileName && /\.[a-z0-9]+$/i.test(fileName)) return fileName.split('.').pop()!.toLowerCase();
  return EXT_BY_MIME[mime] || 'png';
}

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
export function mimeFor(file: string, fileType?: string): string {
  if (fileType) return fileType;
  const ext = (file.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'image/png';
}

// ---- export -----------------------------------------------------------------
export interface ExportResult {
  json: string;
  zipped: Uint8Array;
  pageCount: number;
  changeCount: number;
  imageCount: number;
}

/** Build a downloadable bundle for one origin, or null if there's nothing to export. */
export function buildExport(origin: string, session: Session | null): ExportResult | null {
  const pages = session ? session.pages || {} : {};
  const entries = Object.entries(pages).filter(([, pg]) => (pg.changes || []).length);
  if (!entries.length) return null;

  const assets: Record<string, Uint8Array> = {}; // zip path -> bytes
  let imgCount = 0;

  const outPages = entries.map(([path, pg]) => {
    const changes = (pg.changes || []).map((c, i) => {
      if (c.kind === 'image') {
        imgCount++;
        const ext = extFor(c.fileType, c.fileName);
        const file = `assets/img-${imgCount}.${ext}`;
        try { assets[file] = dataUrlToBytes(c.edited); } catch {}
        return {
          index: i + 1, kind: 'image',
          original: c.original, file,
          alt: c.alt || null, fileName: c.fileName || null, fileType: c.fileType || null,
          element: c.element,
        };
      }
      return {
        index: i + 1, kind: 'text',
        original: c.original, edited: c.edited,
        diffPreview: diffPreview(c.original, c.edited),
        element: c.element,
      };
    });
    return { path, title: pg.title || null, url: pg.url || (origin + path), changes };
  });
  const changeCount = outPages.reduce((n, p) => n + p.changes.length, 0);

  const out = {
    format: 'redline-session',
    version: 2,
    readme:
      'Redline bundle — text + image changes a content editor made across one site. ' +
      'Text changes carry the exact `original`/`edited` strings. Image changes carry the ' +
      'original `original` src and a `file` pointing at the replacement image under assets/ ' +
      'in this zip. To locate in source: search the codebase for the `original` text (for ' +
      'images, use `element.selector`/`element.componentHint`/`element.attributes`). ' +
      'Re-import this .zip into Redline to re-apply.',
    origin,
    exportedAt: new Date().toISOString(),
    summary: { pageCount: outPages.length, changeCount, imageCount: imgCount },
    pages: outPages,
  };

  const json = JSON.stringify(out, null, 2);
  assets['changeset.json'] = new TextEncoder().encode(json);
  const zipped = zipSync(assets);
  return { json, zipped, pageCount: outPages.length, changeCount, imageCount: imgCount };
}

// ---- import -----------------------------------------------------------------
export interface ReadBundleResult {
  data: any;
  assets: Record<string, Uint8Array> | null;
}

/** Parse a dropped/imported file into changeset data (+ image assets). Throws on unreadable input. */
export async function readBundle(file: File): Promise<ReadBundleResult> {
  if (await isZipFile(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const files = unzipSync(bytes);
    const name =
      Object.keys(files).find((n) => /(^|\/)changeset\.json$/i.test(n)) ||
      Object.keys(files).find((n) => /\.json$/i.test(n));
    if (!name) throw new Error('Bundle is missing changeset.json.');
    return { data: JSON.parse(new TextDecoder().decode(files[name])), assets: files };
  }
  return { data: JSON.parse(await file.text()), assets: null };
}

// A bundle is a zip; a legacy session is plain JSON. Sniff by extension, then
// by the "PK" magic bytes so a renamed/typeless file still routes correctly.
async function isZipFile(file: File): Promise<boolean> {
  if (/\.zip$/i.test(file.name)) return true;
  if (/\.json$/i.test(file.name)) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b; // "PK"
  } catch {
    return false;
  }
}
