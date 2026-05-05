'use strict';

const grid      = document.getElementById('grid');
const emptyState = document.getElementById('emptyState');
const pageMeta  = document.getElementById('pageMeta');
const template  = document.getElementById('cardTemplate');

// ── Back button goes to guide.html (or closes tab if opened fresh) ─────────

document.getElementById('backBtn').addEventListener('click', (e) => {
  e.preventDefault();
  if (history.length > 1) history.back();
  else window.close();
});

// ── Load guides ────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_GUIDES' }, (res) => {
  if (chrome.runtime.lastError) return;
  const guides = res?.guides ?? [];
  render(guides);
});

function render(guides) {
  const count = guides.length;
  pageMeta.textContent = count === 0 ? 'No guides saved' : `${count} guide${count !== 1 ? 's' : ''}`;

  if (count === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  guides.forEach(g => grid.appendChild(buildCard(g)));
}

// ── Build card ─────────────────────────────────────────────────────────────

function buildCard(guide) {
  const node  = template.content.cloneNode(true);
  const card  = node.querySelector('.guide-card');
  const img   = card.querySelector('.card-thumb-img');
  const empty = card.querySelector('.card-thumb-empty');
  const title = card.querySelector('.card-title');
  const meta  = card.querySelector('.card-meta');
  const openBtn = card.querySelector('.card-open');
  const delBtn  = card.querySelector('.card-delete');

  // Thumbnail
  if (guide.thumbnail) {
    img.src = guide.thumbnail;
    empty.style.display = 'none';
  } else {
    img.style.display = 'none';
  }

  // Title (inline rename)
  title.textContent = guide.name || 'Untitled Guide';
  title.addEventListener('click', e => e.stopPropagation());
  title.addEventListener('blur', () => {
    const newName = title.textContent.trim() || 'Untitled Guide';
    title.textContent = newName;
    chrome.runtime.sendMessage({ type: 'RENAME_GUIDE', id: guide.id, name: newName });
  });
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.textContent = guide.name || 'Untitled Guide'; title.blur(); }
  });

  // Meta
  const date = new Date(guide.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  meta.textContent = `${guide.stepCount} step${guide.stepCount !== 1 ? 's' : ''} · ${date}`;

  // Open
  const openGuide = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`guide.html?id=${guide.id}`) });
  };
  openBtn.addEventListener('click', e => { e.stopPropagation(); openGuide(); });
  card.addEventListener('click', openGuide);

  // Delete
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete "${guide.name || 'Untitled Guide'}"? This cannot be undone.`)) return;
    chrome.runtime.sendMessage({ type: 'DELETE_GUIDE', id: guide.id }, () => {
      card.remove();
      const remaining = grid.querySelectorAll('.guide-card').length;
      pageMeta.textContent = remaining === 0 ? 'No guides saved' : `${remaining} guide${remaining !== 1 ? 's' : ''}`;
      if (remaining === 0) {
        emptyState.classList.remove('hidden');
        grid.classList.add('hidden');
      }
    });
  });

  return node;
}
