'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let steps = [];
let dragSrcIndex = null;
let currentGuideId = null;

const guideIdParam = new URLSearchParams(location.search).get('id');

// ── DOM refs ───────────────────────────────────────────────────────────────

const stepsList    = document.getElementById('stepsList');
const guideMeta    = document.getElementById('guideMeta');
const guideTitle   = document.getElementById('guideTitle');
const emptyState   = document.getElementById('emptyState');
const mainContent  = document.getElementById('mainContent');
const editToolbar  = document.getElementById('editToolbar');
const toast        = document.getElementById('toast');
const template     = document.getElementById('stepTemplate');
const saveBtn      = document.getElementById('saveBtn');
const saveBtnLabel = document.getElementById('saveBtnLabel');

// ── Init ───────────────────────────────────────────────────────────────────

if (guideIdParam) {
  // Load a saved guide from the library
  chrome.runtime.sendMessage({ type: 'GET_GUIDE', id: guideIdParam }, (res) => {
    if (chrome.runtime.lastError || !res?.guide) return;
    const guide = res.guide;
    currentGuideId = guide.id;
    guideTitle.textContent = guide.name || 'My Guide';
    steps = guide.steps || [];
    saveBtnLabel.textContent = 'Save';
    render();
  });
} else {
  // Load the current recording session
  chrome.runtime.sendMessage({ type: 'GET_STEPS' }, (res) => {
    if (chrome.runtime.lastError) return;
    steps = res?.steps ?? [];
    render();
  });
}

// ── Save to library ────────────────────────────────────────────────────────

saveBtn.addEventListener('click', saveGuide);

function saveGuide() {
  const name = guideTitle.textContent.trim() || 'My Guide';
  saveBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: 'SAVE_GUIDE', id: currentGuideId, name, steps },
    (res) => {
      if (res?.success) {
        currentGuideId = res.guide.id;
        saveBtnLabel.textContent = 'Saved ✓';
        history.replaceState(null, '', `?id=${currentGuideId}`);
        setTimeout(() => { saveBtnLabel.textContent = 'Save'; saveBtn.disabled = false; }, 2000);
        showToast('Guide saved to library');
      } else {
        saveBtn.disabled = false;
      }
    }
  );
}

// ── Library button ─────────────────────────────────────────────────────────

document.getElementById('libraryBtn').addEventListener('click', () => {
  location.href = chrome.runtime.getURL('library.html');
});

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const count = steps.length;
  guideMeta.textContent = count === 0
    ? 'No steps yet'
    : `${count} step${count !== 1 ? 's' : ''} · Click a description to edit`;

  if (count === 0) {
    emptyState.classList.remove('hidden');
    mainContent.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  mainContent.classList.remove('hidden');
  stepsList.innerHTML = '';
  steps.forEach((step, i) => stepsList.appendChild(buildStepCard(step, i)));
}

function buildStepCard(step, index) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.step-card');

  card.querySelector('.step-number').textContent = index + 1;

  const pageTitle = card.querySelector('.step-page-title');
  const urlEl     = card.querySelector('.step-url');
  if (step.pageTitle) pageTitle.textContent = step.pageTitle;
  if (step.url) {
    try {
      urlEl.textContent = new URL(step.url).hostname + new URL(step.url).pathname;
      urlEl.title = step.url;
    } catch { urlEl.textContent = step.url; }
  }

  const img       = card.querySelector('.step-screenshot');
  const noShot    = card.querySelector('.step-no-screenshot');
  const container = card.querySelector('.step-screenshot-container');

  if (step.screenshot) {
    img.src = step.screenshot;
    noShot.style.display = 'none';
    container.appendChild(buildAnnotation(step));
    container.addEventListener('click', () => openLightbox(step.screenshot));
  } else {
    img.style.display = 'none';
    noShot.style.display = 'block';
  }

  const desc = card.querySelector('.step-desc');
  desc.textContent = step.description || '(no description)';
  desc.addEventListener('click', () => startEdit(desc, index));
  desc.addEventListener('blur',  () => finishEdit(desc, index));
  desc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); desc.blur(); }
    if (e.key === 'Escape') { desc.textContent = steps[index]?.description || ''; desc.blur(); }
  });

  card.querySelector('.ctrl-up').addEventListener('click',     () => moveStep(index, index - 1));
  card.querySelector('.ctrl-down').addEventListener('click',   () => moveStep(index, index + 1));
  card.querySelector('.ctrl-edit').addEventListener('click',   () => startEdit(desc, index));
  card.querySelector('.ctrl-delete').addEventListener('click', () => deleteStep(index));

  card.setAttribute('data-index', index);
  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragover',  onDragOver);
  card.addEventListener('dragleave', onDragLeave);
  card.addEventListener('drop',      onDrop);
  card.addEventListener('dragend',   onDragEnd);

  return node;
}

// ── Edit ───────────────────────────────────────────────────────────────────

function startEdit(descEl, index) {
  descEl.contentEditable = 'true';
  descEl.focus();
  const range = document.createRange();
  const sel   = window.getSelection();
  range.selectNodeContents(descEl);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  editToolbar.classList.remove('hidden');
}

function finishEdit(descEl, index) {
  descEl.contentEditable = 'false';
  editToolbar.classList.add('hidden');
  const newText = descEl.textContent.trim();
  if (newText === (steps[index]?.description || '').trim()) return;
  steps[index] = { ...steps[index], description: newText };
  if (currentGuideId) {
    // Editing a saved guide — persist inline
    chrome.runtime.sendMessage({ type: 'SAVE_GUIDE', id: currentGuideId, name: guideTitle.textContent.trim(), steps });
  } else {
    chrome.runtime.sendMessage({ type: 'UPDATE_STEP', index, updates: { description: newText } });
  }
  showToast('Description saved');
}

// ── Move / delete ──────────────────────────────────────────────────────────

function moveStep(from, to) {
  if (to < 0 || to >= steps.length) return;
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved);
  if (currentGuideId) {
    chrome.runtime.sendMessage({ type: 'SAVE_GUIDE', id: currentGuideId, name: guideTitle.textContent.trim(), steps });
  } else {
    chrome.runtime.sendMessage({ type: 'REORDER_STEPS', from, to });
  }
  render();
}

function deleteStep(index) {
  steps.splice(index, 1);
  if (currentGuideId) {
    chrome.runtime.sendMessage({ type: 'SAVE_GUIDE', id: currentGuideId, name: guideTitle.textContent.trim(), steps });
  } else {
    chrome.runtime.sendMessage({ type: 'DELETE_STEP', index });
  }
  render();
  showToast('Step deleted');
}

// ── Drag-and-drop ──────────────────────────────────────────────────────────

function onDragStart(e) {
  dragSrcIndex = parseInt(e.currentTarget.dataset.index);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  const targetIndex = parseInt(e.currentTarget.dataset.index);
  e.currentTarget.classList.remove('drag-over');
  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
  moveStep(dragSrcIndex, targetIndex);
  dragSrcIndex = null;
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging', 'drag-over');
  dragSrcIndex = null;
}

// ── Add manual step ────────────────────────────────────────────────────────

document.getElementById('addStepBtn').addEventListener('click', () => {
  const step = {
    id: Date.now(), type: 'manual',
    description: 'Describe this step',
    url: '', pageTitle: 'Manual step',
    screenshot: null, clickX: null, clickY: null,
    timestamp: Date.now(),
  };
  steps.push(step);
  if (!currentGuideId) chrome.runtime.sendMessage({ type: 'CAPTURE_STEP', data: step });
  render();
  setTimeout(() => {
    const cards = stepsList.querySelectorAll('.step-card');
    const lastCard = cards[cards.length - 1];
    if (lastCard) {
      startEdit(lastCard.querySelector('.step-desc'), steps.length - 1);
      lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 50);
});

// ── Lightbox ───────────────────────────────────────────────────────────────

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src; img.alt = 'Step screenshot (full size)';
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

// ── Export: HTML ───────────────────────────────────────────────────────────

document.getElementById('exportHtmlBtn').addEventListener('click', () => {
  const title = guideTitle.textContent.trim() || 'My Guide';
  const blob  = new Blob([buildExportHtml(title, steps)], { type: 'text/html' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = `${slugify(title)}.html`; a.click();
  URL.revokeObjectURL(url);
  showToast('HTML guide downloaded');
});

function buildExportHtml(title, stepsData) {
  const stepsHtml = stepsData.map((s, i) => {
    const shotHtml = s.screenshot
      ? `<div class="ss-wrap"><img src="${s.screenshot}" alt="Step ${i+1}" />${
          s.elementRect
            ? `<div class="annotation" style="left:${s.elementRect.x*100}%;top:${s.elementRect.y*100}%;width:${s.elementRect.w*100}%;height:${s.elementRect.h*100}%"></div>`
            : (s.clickX != null ? `<div class="annotation annotation--dot" style="left:${s.clickX*100}%;top:${s.clickY*100}%"></div>` : '')
        }</div>` : '';
    return `<div class="step"><div class="step-num">${i+1}</div><div class="step-content">${s.url ? `<p class="meta">${escHtml(s.url)}</p>` : ''}${shotHtml}<p class="desc">${escHtml(s.description||'')}</p></div></div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${escHtml(title)}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;color:#111827;padding:40px 24px}.guide{max-width:800px;margin:0 auto}h1{font-size:28px;font-weight:800;margin-bottom:8px;letter-spacing:-0.5px}.subtitle{color:#6b7280;font-size:14px;margin-bottom:40px}.step{display:flex;gap:20px;margin-bottom:40px}.step-num{width:36px;height:36px;border-radius:50%;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:4px}.step-content{flex:1;min-width:0}.meta{font-size:11px;color:#9ca3af;margin-bottom:10px;font-style:italic}.ss-wrap{position:relative;display:inline-block;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 4px 16px rgba(0,0,0,.1);margin-bottom:12px;max-width:100%}.ss-wrap img{display:block;max-width:100%;height:auto}.annotation{position:absolute;border-radius:6px;border:2.5px solid #ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.2);pointer-events:none}.annotation--dot{width:32px;height:32px;border-radius:50%;transform:translate(-50%,-50%)}.desc{font-size:15px;font-weight:500;line-height:1.6;color:#374151}@media print{body{background:#fff;padding:20px}.step{page-break-inside:avoid}}</style></head><body><div class="guide"><h1>${escHtml(title)}</h1><p class="subtitle">Generated by Monkey · ${stepsData.length} step${stepsData.length!==1?'s':''}</p>${stepsHtml}</div></body></html>`;
}

// ── Export: Markdown ───────────────────────────────────────────────────────

document.getElementById('exportMdBtn').addEventListener('click', async () => {
  const title = guideTitle.textContent.trim() || 'My Guide';
  const lines = [`# ${title}`, '', `*${steps.length} steps · Generated by Monkey*`, ''];
  steps.forEach((s, i) => {
    lines.push(`## Step ${i + 1}: ${s.description || ''}`, '');
    if (s.url) lines.push(`**Page:** ${s.url}`, '');
    lines.push('');
  });
  const md = lines.join('\n');
  try {
    await navigator.clipboard.writeText(md);
    showToast('Markdown copied to clipboard');
  } catch {
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${slugify(title)}.md`; a.click();
    URL.revokeObjectURL(url);
    showToast('Markdown downloaded');
  }
});

// ── Print ──────────────────────────────────────────────────────────────────

document.getElementById('printBtn').addEventListener('click', () => window.print());
document.getElementById('openExtBtn')?.addEventListener('click', () => window.close());

// ── Toast ──────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2400);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function buildAnnotation(step) {
  const div = document.createElement('div');
  if (step.annotationType === 'circle' || (!step.elementRect && step.clickX != null)) {
    div.className = 'step-annotation step-annotation--circle';
    div.style.left = `${step.clickX * 100}%`;
    div.style.top  = `${step.clickY * 100}%`;
  } else if (step.elementRect) {
    div.className = 'step-annotation';
    div.style.left   = `${step.elementRect.x * 100}%`;
    div.style.top    = `${step.elementRect.y * 100}%`;
    div.style.width  = `${step.elementRect.w * 100}%`;
    div.style.height = `${step.elementRect.h * 100}%`;
  }
  return div;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'guide';
}
