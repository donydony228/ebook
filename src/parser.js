import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Below this average characters-per-page we assume the PDF is scanned
// (image-only, no text layer) and fall back to rendering page images.
const SCANNED_CHAR_THRESHOLD = 25;

/**
 * Parse a PDF ArrayBuffer into our internal book format.
 * @param {ArrayBuffer} buffer
 * @param {(p:{phase:string, ratio:number}) => void} onProgress
 */
export async function parsePdf(buffer, onProgress = () => {}) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const numPages = pdf.numPages;

  // 1. Extract text page by page.
  const pageTexts = []; // array of { paragraphs: string[] }
  let totalChars = 0;
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const paragraphs = itemsToParagraphs(content.items);
    totalChars += paragraphs.join('').length;
    pageTexts.push({ paragraphs });
    onProgress({ phase: 'text', ratio: i / numPages });
  }

  const avgChars = totalChars / numPages;
  const isScanned = avgChars < SCANNED_CHAR_THRESHOLD;

  // 2. Resolve the outline (table of contents) into page indices.
  const outline = await pdf.getOutline();
  const chapterMarks = await resolveOutline(pdf, outline);

  // We keep BOTH representations so the reader can switch per book:
  //  - textChapters: reflowable paragraphs (empty for scanned PDFs)
  //  - pageChapters: page-range table of contents for the faithful page mode
  // The original PDF bytes are stored by the caller so page mode can render
  // any page on demand (no need to pre-rasterise the whole book).
  const textChapters = isScanned ? [] : buildTextChapters(pageTexts, chapterMarks, numPages);
  const pageChapters = buildPageChapters(chapterMarks, numPages);

  return {
    defaultMode: isScanned ? 'page' : 'text',
    canReflow: !isScanned,
    numPages,
    textChapters,
    pageChapters,
  };
}

function buildPageChapters(marks, numPages) {
  if (!marks.length) return [{ title: '全書', startPage: 0, endPage: numPages - 1 }];
  const out = [];
  if (marks[0].page > 0) out.push({ title: '封面・前言', startPage: 0, endPage: marks[0].page - 1 });
  marks.forEach((m, i) => {
    out.push({
      title: m.title || `章節 ${i + 1}`,
      startPage: m.page,
      endPage: (marks[i + 1]?.page ?? numPages) - 1,
    });
  });
  return out;
}

/** Open a PDF from raw bytes (used by the reader for on-demand page rendering). */
export function openPdf(data) {
  return pdfjsLib.getDocument({ data }).promise;
}

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const isCJK = (ch) => !!ch && CJK.test(ch);

/**
 * Reconstruct paragraphs from PDF.js text items.
 *
 * Strategy (works for CJK + Latin):
 *  1. Sort items by reading position (top→bottom, then left→right) so we don't
 *     rely on the PDF's internal storage order, which is often scrambled.
 *  2. Cluster items into lines by y; join glyphs within a line, inserting a
 *     space only between non-CJK runs that have a real horizontal gap.
 *  3. Merge lines into paragraphs using vertical gaps + first-line indent +
 *     short last lines — the cues Chinese typesetting actually uses.
 */
function itemsToParagraphs(items) {
  const toks = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const h = it.height || Math.abs(it.transform[3]) || 12;
    toks.push({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h, str: it.str });
  }
  if (!toks.length) return [];

  // Cluster into lines. Sort by y descending (PDF y grows upward), break a new
  // line when y shifts more than ~60% of the glyph height.
  toks.sort((a, b) => b.y - a.y);
  const lineHeight = median(toks.map((t) => t.h)) || 12;
  const lines = [];
  let cur = null;
  for (const t of toks) {
    if (!cur || Math.abs(cur.y - t.y) > lineHeight * 0.6) {
      cur = { y: t.y, toks: [t] };
      lines.push(cur);
    } else {
      cur.toks.push(t);
    }
  }

  // Build each line's text (tokens sorted left→right) and geometry.
  const built = lines.map((line) => {
    line.toks.sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < line.toks.length; i++) {
      const t = line.toks[i];
      if (i > 0) {
        const prev = line.toks[i - 1];
        const gap = t.x - (prev.x + prev.w);
        const last = text.slice(-1);
        const first = t.str[0];
        // Only insert a space for genuine gaps between Latin/number runs;
        // never between CJK glyphs (PDF emits them as separate items).
        if (gap > t.h * 0.28 && !isCJK(last) && !isCJK(first)) text += ' ';
      }
      text += t.str;
    }
    const startX = line.toks[0].x;
    const endX = line.toks[line.toks.length - 1].x + line.toks[line.toks.length - 1].w;
    return { text: text.replace(/\s+/g, ' ').trim(), y: line.y, startX, endX };
  }).filter((l) => l.text);

  if (!built.length) return [];

  // Page geometry for indent / short-line detection.
  const leftMargin = Math.min(...built.map((l) => l.startX));
  const rightEdge = Math.max(...built.map((l) => l.endX));
  const gaps = [];
  for (let i = 1; i < built.length; i++) gaps.push(built[i - 1].y - built[i].y);
  const medianGap = median(gaps) || lineHeight * 1.5;
  const charW = lineHeight; // ~one CJK char width

  const paragraphs = [];
  let buf = '';
  let prev = null;
  for (const line of built) {
    let breakBefore = false;
    if (prev) {
      const vGap = prev.y - line.y;
      const indented = line.startX > leftMargin + charW * 0.8;
      const prevShort = prev.endX < rightEdge - charW * 1.5;
      breakBefore = vGap > medianGap * 1.5 || indented || prevShort;
    }
    if (breakBefore && buf) {
      paragraphs.push(buf);
      buf = '';
    }
    buf = joinLine(buf, line.text);
    prev = line;
  }
  if (buf) paragraphs.push(buf);
  return paragraphs.map((p) => p.trim()).filter(Boolean);
}

/** Append a line to the paragraph buffer with language-aware spacing. */
function joinLine(buf, line) {
  if (!buf) return line;
  const last = buf.slice(-1);
  const first = line[0];
  // CJK on either side of the break → join with no space.
  if (isCJK(last) || isCJK(first)) return buf + line;
  // Western hyphenation across a line break → splice the word back together.
  if (last === '-') return buf.slice(0, -1) + line;
  return buf + ' ' + line;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Resolve outline entries into [{ title, page }] sorted by page.
 * Flattens nested outline items.
 */
async function resolveOutline(pdf, outline) {
  if (!outline || !outline.length) return [];
  const marks = [];
  async function walk(items, depth) {
    for (const item of items) {
      try {
        const page = await destToPageIndex(pdf, item.dest);
        if (page != null) marks.push({ title: item.title.trim(), page, depth });
      } catch {
        /* ignore unresolvable destinations */
      }
      if (item.items && item.items.length) await walk(item.items, depth + 1);
    }
  }
  await walk(outline, 0);
  marks.sort((a, b) => a.page - b.page);
  return marks;
}

async function destToPageIndex(pdf, dest) {
  if (!dest) return null;
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!explicit || !explicit.length) return null;
  const ref = explicit[0];
  return pdf.getPageIndex(ref); // 0-based
}

function buildTextChapters(pageTexts, marks, numPages) {
  // No usable outline → split into chapter-sized chunks for navigation,
  // but keep it simple: one chapter holds everything, paginated by the reader.
  if (!marks.length) {
    const paragraphs = pageTexts.flatMap((p) => p.paragraphs);
    return [{ title: '全書', paragraphs, startPage: 0 }];
  }
  const chapters = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].page;
    const end = (marks[i + 1]?.page ?? numPages) - 1;
    const paragraphs = [];
    for (let p = start; p <= end && p < pageTexts.length; p++) {
      paragraphs.push(...pageTexts[p].paragraphs);
    }
    chapters.push({ title: marks[i].title || `章節 ${i + 1}`, paragraphs, startPage: start });
  }
  // Capture any front matter before the first outline entry.
  if (marks[0].page > 0) {
    const pre = [];
    for (let p = 0; p < marks[0].page; p++) pre.push(...pageTexts[p].paragraphs);
    if (pre.join('').trim()) chapters.unshift({ title: '前言', paragraphs: pre, startPage: 0 });
  }
  return chapters;
}

export async function renderPageToBlob(pdf, pageNum, targetWidth = 1240) {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}
