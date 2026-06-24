import { getBookContent, getBookMeta, updateProgress } from './db.js';
import { openPdf, renderPageToBlob } from './parser.js';

const FONT_SIZES = [16, 18, 20, 22, 26, 30];

export async function mountReader(root, bookId, onExit) {
  const content = await getBookContent(bookId);
  const meta = await getBookMeta(bookId);
  if (!content) {
    root.innerHTML = '<p style="padding:2rem">找不到這本書</p>';
    return;
  }

  const canReflow = content.canReflow !== false;
  let viewMode = meta?.progress?.mode || content.defaultMode || 'text';
  if (viewMode === 'text' && !canReflow) viewMode = 'page';

  const state = {
    chapterIndex: 0, // text mode: which chapter
    col: 0, // text mode: column (page) within chapter
    colCount: 1,
    pageNum: 0, // page mode: absolute 0-based page
    fontIndex: loadFontIndex(),
  };

  // Lazy PDF handle + rendered-page cache for page mode.
  let pdfDoc = null;
  const pageCache = new Map();

  root.innerHTML = `
    <div class="reader">
      <div class="reader-stage">
        <div class="reader-viewport" id="viewport"></div>
        <button class="tap-zone tap-prev" aria-label="上一頁"></button>
        <button class="tap-zone tap-next" aria-label="下一頁"></button>
      </div>
      <div class="reader-topbar" id="topbar">
        <button class="icon-btn" id="backBtn">‹ 書庫</button>
        <span class="reader-title">${escapeHtml(meta?.title || '')}</span>
        <div class="topbar-actions">
          ${canReflow ? '<button class="icon-btn" id="modeBtn"></button>' : ''}
          <button class="icon-btn" id="tocBtn">目錄</button>
          <button class="icon-btn" id="fontDown">A-</button>
          <button class="icon-btn" id="fontUp">A+</button>
        </div>
      </div>
      <div class="reader-bottombar" id="bottombar"><span id="progressLabel"></span></div>
      <div class="toc-drawer" id="tocDrawer" hidden>
        <div class="toc-header">目錄</div>
        <ul id="tocList"></ul>
      </div>
      <div class="toc-backdrop" id="tocBackdrop" hidden></div>
    </div>
  `;

  const viewport = root.querySelector('#viewport');
  const progressLabel = root.querySelector('#progressLabel');
  const fontBtns = [root.querySelector('#fontUp'), root.querySelector('#fontDown')];

  // Restore saved position.
  if (meta?.progress) {
    state.chapterIndex = Math.min(meta.progress.chapterIndex || 0, content.textChapters.length - 1);
    state.pageNum = Math.min(meta.progress.page || 0, content.numPages - 1);
  }

  // ---------- shared helpers ----------
  function sidePadding() {
    return Math.max(20, Math.min(64, Math.round(viewport.clientWidth * 0.07)));
  }

  async function ensurePdf() {
    if (pdfDoc) return pdfDoc;
    const buf = await content.pdfBlob.arrayBuffer();
    pdfDoc = await openPdf(buf);
    return pdfDoc;
  }

  // ---------- TEXT (reflow) mode ----------
  function renderTextChapter(targetRatio) {
    const chapter = content.textChapters[state.chapterIndex];
    const fontSize = FONT_SIZES[state.fontIndex];
    const pad = sidePadding();
    viewport.style.padding = `${Math.round(pad * 0.8)}px ${pad}px`;
    const colWidth = viewport.clientWidth - pad * 2;
    viewport.innerHTML = `<div class="paged text-mode" style="font-size:${fontSize}px; column-width:${colWidth}px; column-gap:${pad * 2}px">
      <h2 class="chapter-head">${escapeHtml(chapter.title)}</h2>
      ${chapter.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    </div>`;
    requestAnimationFrame(() => {
      const paged = viewport.querySelector('.paged');
      state.colCount = Math.max(1, Math.round(paged.scrollWidth / viewport.clientWidth));
      state.col = Math.min(Math.round(targetRatio * (state.colCount - 1)), state.colCount - 1);
      applyTextCol();
    });
  }
  function applyTextCol() {
    const paged = viewport.querySelector('.paged');
    if (!paged) return;
    paged.style.transform = `translateX(${-state.col * viewport.clientWidth}px)`;
    const chapter = content.textChapters[state.chapterIndex];
    progressLabel.textContent = `${chapter.title} · ${state.col + 1}/${state.colCount}　(第 ${state.chapterIndex + 1}/${content.textChapters.length} 章)`;
    saveProgress();
  }

  // ---------- PAGE (faithful) mode ----------
  async function getPageUrl(n) {
    if (pageCache.has(n)) return pageCache.get(n);
    const pdf = await ensurePdf();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetWidth = Math.min(Math.round(viewport.clientWidth * dpr), 2200);
    const blob = await renderPageToBlob(pdf, n + 1, targetWidth);
    const url = URL.createObjectURL(blob);
    pageCache.set(n, url);
    // Keep the cache small to bound memory.
    if (pageCache.size > 12) {
      const oldest = pageCache.keys().next().value;
      URL.revokeObjectURL(pageCache.get(oldest));
      pageCache.delete(oldest);
    }
    return url;
  }
  async function renderPage(n) {
    state.pageNum = Math.max(0, Math.min(n, content.numPages - 1));
    viewport.style.padding = '0';
    viewport.innerHTML = `<div class="paged img-mode"><div class="img-page" id="imgPage"><div class="page-loading">載入第 ${state.pageNum + 1} 頁…</div></div></div>`;
    resetZoom();
    const url = await getPageUrl(state.pageNum);
    const holder = viewport.querySelector('#imgPage');
    if (!holder) return;
    holder.innerHTML = `<img src="${url}" alt="第 ${state.pageNum + 1} 頁">`;
    progressLabel.textContent = `第 ${state.pageNum + 1} / ${content.numPages} 頁　${currentPageChapterTitle()}`;
    saveProgress();
    // Prefetch neighbours for snappy turning.
    [state.pageNum + 1, state.pageNum - 1].forEach((m) => {
      if (m >= 0 && m < content.numPages) getPageUrl(m).catch(() => {});
    });
  }
  function currentPageChapterTitle() {
    const c = content.pageChapters.find((c) => state.pageNum >= c.startPage && state.pageNum <= c.endPage);
    return c ? `· ${c.title}` : '';
  }

  // ---------- unified navigation ----------
  function renderCurrent(ratio = 0) {
    if (viewMode === 'text') renderTextChapter(ratio);
    else renderPage(state.pageNum);
    updateChrome();
  }
  function next() {
    if (zoomed) return;
    if (viewMode === 'text') {
      if (state.col < state.colCount - 1) { state.col++; applyTextCol(); }
      else if (state.chapterIndex < content.textChapters.length - 1) { state.chapterIndex++; renderTextChapter(0); }
    } else if (state.pageNum < content.numPages - 1) {
      renderPage(state.pageNum + 1);
    }
  }
  function prev() {
    if (zoomed) return;
    if (viewMode === 'text') {
      if (state.col > 0) { state.col--; applyTextCol(); }
      else if (state.chapterIndex > 0) { state.chapterIndex--; renderTextChapter(1); }
    } else if (state.pageNum > 0) {
      renderPage(state.pageNum - 1);
    }
  }

  function saveProgress() {
    if (viewMode === 'text') {
      const ratio = state.colCount > 1 ? state.col / (state.colCount - 1) : 0;
      updateProgress(bookId, { mode: 'text', chapterIndex: state.chapterIndex, ratio, page: state.pageNum });
    } else {
      updateProgress(bookId, { mode: 'page', page: state.pageNum, chapterIndex: state.chapterIndex });
    }
  }

  // ---------- mode toggle ----------
  function updateModeButton() {
    const btn = root.querySelector('#modeBtn');
    if (btn) btn.textContent = viewMode === 'text' ? '原頁' : '重排';
  }
  function updateChrome() {
    updateModeButton();
    fontBtns.forEach((b) => (b.style.display = viewMode === 'text' ? '' : 'none'));
  }
  async function toggleMode() {
    if (viewMode === 'text') {
      // text → page: jump to the page where the current chapter begins.
      const startPage = content.textChapters[state.chapterIndex]?.startPage || 0;
      viewMode = 'page';
      state.pageNum = startPage;
      renderCurrent();
    } else {
      // page → text: land on the chapter whose range contains this page.
      let idx = 0;
      for (let i = 0; i < content.textChapters.length; i++) {
        if ((content.textChapters[i].startPage || 0) <= state.pageNum) idx = i;
      }
      viewMode = 'text';
      state.chapterIndex = idx;
      renderCurrent(0);
    }
  }

  // ---------- TOC ----------
  const tocDrawer = root.querySelector('#tocDrawer');
  const tocBackdrop = root.querySelector('#tocBackdrop');
  function buildToc() {
    const list = root.querySelector('#tocList');
    const items = viewMode === 'text' ? content.textChapters : content.pageChapters;
    list.innerHTML = items.map((c, i) => `<li><button data-i="${i}">${escapeHtml(c.title)}</button></li>`).join('');
  }
  root.querySelector('#tocList').onclick = (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (viewMode === 'text') { state.chapterIndex = i; renderTextChapter(0); }
    else { renderPage(content.pageChapters[i].startPage); }
    closeToc();
  };
  root.querySelector('#tocBtn').onclick = () => { buildToc(); tocDrawer.hidden = false; tocBackdrop.hidden = false; };
  function closeToc() { tocDrawer.hidden = true; tocBackdrop.hidden = true; }
  tocBackdrop.onclick = closeToc;

  // ---------- controls ----------
  root.querySelector('#backBtn').onclick = () => onExit();
  root.querySelector('.tap-next').onclick = next;
  root.querySelector('.tap-prev').onclick = prev;
  if (canReflow) root.querySelector('#modeBtn').onclick = toggleMode;
  root.querySelector('#fontUp').onclick = () => changeFont(1);
  root.querySelector('#fontDown').onclick = () => changeFont(-1);
  function changeFont(delta) {
    if (viewMode !== 'text') return;
    const ratio = state.colCount > 1 ? state.col / (state.colCount - 1) : 0;
    state.fontIndex = Math.max(0, Math.min(FONT_SIZES.length - 1, state.fontIndex + delta));
    saveFontIndex(state.fontIndex);
    renderTextChapter(ratio);
  }

  // chrome (bars) toggle
  const topbar = root.querySelector('#topbar');
  const bottombar = root.querySelector('#bottombar');
  let chromeVisible = true;
  function toggleChrome() {
    chromeVisible = !chromeVisible;
    topbar.classList.toggle('hidden', !chromeVisible);
    bottombar.classList.toggle('hidden', !chromeVisible);
  }

  // ---------- double-tap zoom (page mode) ----------
  let zoom = 1, tx = 0, ty = 0;
  let zoomed = false;
  function resetZoom() { zoom = 1; tx = 0; ty = 0; zoomed = false; applyZoom(); }
  function applyZoom() {
    const img = viewport.querySelector('.img-page img');
    if (img) img.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
  }
  function toggleZoom(cx, cy) {
    if (zoomed) { resetZoom(); return; }
    zoom = 2.4; zoomed = true;
    // zoom toward the tapped point
    const rect = viewport.getBoundingClientRect();
    tx = (rect.width / 2 - (cx - rect.left)) * (zoom - 1) / zoom;
    ty = (rect.height / 2 - (cy - rect.top)) * (zoom - 1) / zoom;
    applyZoom();
  }

  // ---------- touch / swipe ----------
  const stage = root.querySelector('.reader-stage');
  let sx = 0, sy = 0, st = 0, panning = false, lastTap = 0;
  stage.addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    panning = zoomed;
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (zoomed && panning) {
      tx += e.touches[0].clientX - sx; ty += e.touches[0].clientY - sy;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      applyZoom();
    }
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const dt = Date.now() - st;
    if (zoomed) return; // panning, not page turn
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      dx < 0 ? next() : prev();
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 300) {
      const now = Date.now();
      const x = e.changedTouches[0].clientX, w = window.innerWidth;
      if (viewMode === 'page' && now - lastTap < 280) {
        toggleZoom(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      } else if (x > w * 0.33 && x < w * 0.67) {
        toggleChrome();
      }
      lastTap = now;
    }
  }, { passive: true });

  // ---------- keyboard / resize ----------
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') next();
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
    else if (e.key === 'Escape') onExit();
  };
  document.addEventListener('keydown', onKey);

  let resizeTimer;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (viewMode === 'text') {
        const ratio = state.colCount > 1 ? state.col / (state.colCount - 1) : 0;
        renderTextChapter(ratio);
      } else {
        pageCache.forEach((url) => URL.revokeObjectURL(url));
        pageCache.clear();
        renderPage(state.pageNum);
      }
    }, 180);
  };
  window.addEventListener('resize', onResize);

  mountReader._cleanup = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    pageCache.forEach((url) => URL.revokeObjectURL(url));
    pageCache.clear();
    pdfDoc?.destroy?.();
  };

  // first paint
  renderCurrent(meta?.progress?.ratio || 0);
}

function loadFontIndex() { return Number(localStorage.getItem('fontIndex') ?? 1); }
function saveFontIndex(i) { localStorage.setItem('fontIndex', String(i)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
