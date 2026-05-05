'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let isRecording = false;
let isPaused = false;
let stepCount = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────

const recordBtn      = document.getElementById('recordBtn');
const recordBtnLabel = document.getElementById('recordBtnLabel');
const pauseBtn       = document.getElementById('pauseBtn');
const closeBtn       = document.getElementById('closeBtn');
const stepsList      = document.getElementById('stepsList');
const emptyState     = document.getElementById('emptyState');
const openGuideBtn   = document.getElementById('openGuideBtn');
const clearBtn       = document.getElementById('clearBtn');

// ── Init ───────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STEPS' }, (res) => {
  if (chrome.runtime.lastError) return;
  isRecording = res?.recording ?? false;
  isPaused = res?.paused ?? false;
  const steps = res?.steps ?? [];
  stepCount = steps.length;

  steps.forEach((step, i) => appendStepCard(step, i));
  renderHeader();
});

// ── Live updates from background ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STEP_ADDED') {
    stepCount = msg.stepCount;
    appendStepCard(msg.step, stepCount - 1);
    renderHeader();
  } else if (msg.type === 'RECORDING_STARTED') {
    isRecording = true;
    isPaused = false;
    stepCount = 0;
    stepsList.innerHTML = '';
    renderHeader();
  } else if (msg.type === 'RECORDING_STOPPED') {
    isRecording = false;
    isPaused = false;
    stepCount = msg.stepCount;
    renderHeader();
  } else if (msg.type === 'RECORDING_PAUSED') {
    isPaused = true;
    renderHeader();
  } else if (msg.type === 'RECORDING_RESUMED') {
    isPaused = false;
    renderHeader();
  }
});

// ── Render header state ────────────────────────────────────────────────────

function renderHeader() {
  if (isRecording) {
    recordBtn.classList.add('recording');
    recordBtnLabel.textContent = 'Stop Recording';
    pauseBtn.hidden = false;
    if (isPaused) {
      pauseBtn.textContent = 'Resume';
      pauseBtn.classList.add('paused');
    } else {
      pauseBtn.textContent = 'Pause';
      pauseBtn.classList.remove('paused');
    }
  } else {
    recordBtn.classList.remove('recording');
    recordBtnLabel.textContent = 'Start Recording';
    pauseBtn.hidden = true;
    pauseBtn.classList.remove('paused');
  }

  const hasSteps = stepCount > 0;
  openGuideBtn.disabled = !hasSteps;
  emptyState.classList.toggle('hidden', hasSteps);
}

// ── Build step card ────────────────────────────────────────────────────────

function appendStepCard(step, index) {
  const li = document.createElement('li');
  li.className = 'step-card';
  li.dataset.index = index;

  // ── Top row: number + description + delete ──
  const top = document.createElement('div');
  top.className = 'step-card-top';

  const num = document.createElement('span');
  num.className = 'step-num';
  num.textContent = index + 1;

  const desc = document.createElement('p');
  desc.className = 'step-desc';
  desc.contentEditable = 'false';
  desc.spellcheck = true;
  desc.textContent = step.description || '(no description)';

  desc.addEventListener('click', () => startEdit(desc));
  desc.addEventListener('blur',  () => finishEdit(desc, index));
  desc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); desc.blur(); }
    if (e.key === 'Escape') { desc.textContent = step.description || ''; desc.blur(); }
  });

  const del = document.createElement('button');
  del.className = 'step-delete';
  del.title = 'Delete step';
  del.textContent = '×';
  del.addEventListener('click', () => deleteStep(li, index));

  top.appendChild(num);
  top.appendChild(desc);
  top.appendChild(del);

  // ── Screenshot ──
  if (step.screenshot) {
    const wrap = document.createElement('div');
    wrap.className = 'step-screenshot-wrap';

    const img = document.createElement('img');
    img.className = 'step-screenshot';
    img.src = step.screenshot;
    img.alt = `Step ${index + 1} screenshot`;
    img.loading = 'lazy';
    wrap.appendChild(img);

    wrap.appendChild(buildAnnotation(step));

    wrap.addEventListener('click', () => openLightbox(step.screenshot));

    li.appendChild(top);
    li.appendChild(wrap);
  } else {
    li.appendChild(top);
  }

  stepsList.appendChild(li);
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ── Edit description ───────────────────────────────────────────────────────

function startEdit(desc) {
  desc.contentEditable = 'true';
  desc.focus();
  const range = document.createRange();
  range.selectNodeContents(desc);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function finishEdit(desc, index) {
  desc.contentEditable = 'false';
  const newText = desc.textContent.trim();
  chrome.runtime.sendMessage({ type: 'UPDATE_STEP', index, updates: { description: newText } });
}

// ── Delete step ────────────────────────────────────────────────────────────

function deleteStep(li, index) {
  chrome.runtime.sendMessage({ type: 'DELETE_STEP', index }, () => {
    li.remove();
    stepCount = Math.max(0, stepCount - 1);
    // Re-number remaining cards
    document.querySelectorAll('.step-card').forEach((card, i) => {
      card.dataset.index = i;
      card.querySelector('.step-num').textContent = i + 1;
    });
    renderHeader();
  });
}

// ── Record / stop ──────────────────────────────────────────────────────────

closeBtn.addEventListener('click', () => {
  chrome.windows.getCurrent(w => {
    chrome.sidePanel.close({ windowId: w.id });
  });
});

pauseBtn.addEventListener('click', async () => {
  const msgType = isPaused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING';
  chrome.runtime.sendMessage({ type: msgType });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: msgType }).catch(() => {});
  isPaused = !isPaused;
  renderHeader();
});

recordBtn.addEventListener('click', async () => {
  if (isRecording) {
    // Stop — tell background, then notify the active tab's content script
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECORDING' }).catch(() => {});
    isRecording = false;
    renderHeader();
  } else {
    // Start — tell background, then notify the active tab's content script
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING' }).catch(() => {});
    isRecording = true;
    stepCount = 0;
    stepsList.innerHTML = '';
    renderHeader();
  }
});

// ── Open full guide ────────────────────────────────────────────────────────

openGuideBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('guide.html') });
});

document.getElementById('libraryBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
});

// ── Clear ──────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  if (stepCount === 0) return;
  if (!confirm(`Clear all ${stepCount} step${stepCount !== 1 ? 's' : ''}?`)) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_STEPS' }, () => {
    stepsList.innerHTML = '';
    stepCount = 0;
    isRecording = false;
    renderHeader();
  });
});

// ── Lightbox ───────────────────────────────────────────────────────────────

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

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}
