import './styles.css';
import { listBooks, saveBook, deleteBook } from './db.js';
import { parsePdf } from './parser.js';
import { mountReader } from './reader.js';

const app = document.getElementById('app');

// Object URLs for the visible cover thumbnails; revoked on each re-render.
let coverUrls = [];

async function showLibrary() {
  if (mountReader._cleanup) {
    mountReader._cleanup();
    mountReader._cleanup = null;
  }
  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];
  const books = await listBooks();
  app.innerHTML = `
    <div class="library">
      <header class="lib-header">
        <h1>我的書庫</h1>
        <label class="upload-btn">
          ＋ 上傳 PDF
          <input type="file" accept="application/pdf" id="fileInput" hidden />
        </label>
      </header>
      <div class="hint">上傳後即解析並存在本機,之後可完全離線閱讀。</div>
      <div class="book-grid" id="bookGrid">
        ${
          books.length
            ? books.map(bookCard).join('')
            : '<div class="empty">還沒有書,點右上角上傳一份 PDF 開始。</div>'
        }
      </div>
    </div>
    <div class="progress-overlay" id="progressOverlay" hidden>
      <div class="progress-box">
        <div class="spinner"></div>
        <div id="progressText">解析中…</div>
        <div class="bar"><div class="bar-fill" id="barFill"></div></div>
      </div>
    </div>
  `;

  app.querySelector('#fileInput').addEventListener('change', handleUpload);
  app.querySelector('#bookGrid').addEventListener('click', async (e) => {
    const del = e.target.closest('.del-btn');
    if (del) {
      e.stopPropagation();
      if (confirm('刪除這本書?')) {
        await deleteBook(del.dataset.id);
        showLibrary();
      }
      return;
    }
    const card = e.target.closest('.book-card');
    if (card) openBook(card.dataset.id);
  });
}

function bookCard(b) {
  const modeTag = b.canReflow === false ? '掃描版' : '可重排';
  let coverInner = `<span>${escapeHtml(initials(b.title))}</span>`;
  if (b.cover) {
    const url = URL.createObjectURL(b.cover);
    coverUrls.push(url);
    coverInner = `<img src="${url}" alt="" loading="lazy">`;
  }
  return `
    <div class="book-card" data-id="${b.id}">
      <button class="del-btn" data-id="${b.id}" aria-label="刪除">×</button>
      <div class="book-cover">${coverInner}</div>
      <div class="book-meta">
        <div class="book-title">${escapeHtml(b.title)}</div>
        <div class="book-sub">${b.numPages} 頁 · ${modeTag}</div>
      </div>
    </div>
  `;
}

async function handleUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const overlay = document.getElementById('progressOverlay');
  const text = document.getElementById('progressText');
  const fill = document.getElementById('barFill');
  overlay.hidden = false;

  try {
    const buffer = await file.arrayBuffer();
    const parsed = await parsePdf(buffer, ({ ratio }) => {
      text.textContent = '抽取文字與章節中…';
      fill.style.width = `${Math.round(ratio * 100)}%`;
    });
    const id = crypto.randomUUID();
    const meta = {
      id,
      title: file.name.replace(/\.pdf$/i, ''),
      numPages: parsed.numPages,
      defaultMode: parsed.defaultMode,
      canReflow: parsed.canReflow,
      cover: parsed.cover, // small first-page thumbnail blob
      addedAt: Date.now(),
      progress: null,
    };
    await saveBook(meta, {
      defaultMode: parsed.defaultMode,
      canReflow: parsed.canReflow,
      numPages: parsed.numPages,
      textChapters: parsed.textChapters,
      pageChapters: parsed.pageChapters,
      // Keep the original PDF so page mode can render any page offline.
      pdfBlob: file,
    });
    overlay.hidden = true;
    openBook(id);
  } catch (err) {
    console.error(err);
    overlay.hidden = true;
    alert('解析失敗:' + err.message);
  } finally {
    e.target.value = '';
  }
}

async function openBook(id) {
  await mountReader(app, id, showLibrary);
}

function initials(title) {
  return (title || '?').trim().slice(0, 2);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Register the PWA service worker (injected by vite-plugin-pwa).
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

// Ask the browser to keep our stored books from being evicted (esp. on iOS,
// where non-persistent storage can be cleared after periods of inactivity).
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

showLibrary();
