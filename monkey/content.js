'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let isRecording = false;
let isPaused = false;
let pendingCapture = false;
let inputDebounceTimer = null;
let lastInputEl = null;

// ── Init ───────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'IS_RECORDING' }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.recording) {
    startRecordingUI();
    if (res?.paused) isPaused = true;
  }
});

// ── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    isPaused = false;
    startRecordingUI();
    sendResponse({ success: true });
  } else if (msg.type === 'STOP_RECORDING') {
    isPaused = false;
    stopRecordingUI();
    sendResponse({ success: true });
  } else if (msg.type === 'PAUSE_RECORDING') {
    isPaused = true;
    sendResponse({ success: true });
  } else if (msg.type === 'RESUME_RECORDING') {
    isPaused = false;
    sendResponse({ success: true });
  }
});

// ── Recording UI ───────────────────────────────────────────────────────────

function startRecordingUI() {
  isRecording = true;
  attachListeners();
}

function stopRecordingUI() {
  isRecording = false;
  detachListeners();
  clearTimeout(inputDebounceTimer);
}

// ── Listeners ──────────────────────────────────────────────────────────────

function attachListeners() {
  document.addEventListener('click', onClickCapture, { capture: true, passive: true });
  document.addEventListener('change', onChangeCapture, { capture: true, passive: true });
  document.addEventListener('focusin', onFocusIn, { capture: true, passive: true });
}

function detachListeners() {
  document.removeEventListener('click', onClickCapture, { capture: true });
  document.removeEventListener('change', onChangeCapture, { capture: true });
  document.removeEventListener('focusin', onFocusIn, { capture: true });
}

// ── Event handlers ─────────────────────────────────────────────────────────

const INTERACTIVE_SEL = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], label';

function onClickCapture(e) {
  if (!isRecording || isPaused || pendingCapture) return;

  // Real pixel coordinates of the actual click
  const rawClickX = e.clientX / window.innerWidth;
  const rawClickY = e.clientY / window.innerHeight;

  const matched = e.target.closest(INTERACTIVE_SEL);
  const el = matched || e.target;

  // Skip clicks inside our own overlay
  if (el.closest('#__monkey_overlay__')) return;

  // Don't double-capture select/checkbox — handled by 'change'
  const tag = el.tagName?.toLowerCase();
  if ((tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) || tag === 'select') return;

  // If we hit a real interactive element use its center; otherwise use raw click point
  const annotationType = matched ? 'rect' : 'circle';
  const rect = el.getBoundingClientRect();
  const clickX = matched
    ? (rect.left + rect.width  / 2) / window.innerWidth
    : rawClickX;
  const clickY = matched
    ? (rect.top  + rect.height / 2) / window.innerHeight
    : rawClickY;

  captureInteraction('click', el, clickX, clickY, annotationType);
}

function onChangeCapture(e) {
  if (!isRecording || isPaused || pendingCapture) return;
  const el = e.target;
  const tag = el.tagName?.toLowerCase();
  if (!['input', 'select', 'textarea'].includes(tag)) return;
  if (el.closest('#__monkey_overlay__')) return;

  const rect = el.getBoundingClientRect();
  const cx = (rect.left + rect.width / 2) / window.innerWidth;
  const cy = (rect.top + rect.height / 2) / window.innerHeight;

  const type = (tag === 'select' || el.type === 'checkbox' || el.type === 'radio') ? 'select' : 'input';
  captureInteraction(type, el, cx, cy);
}

function onFocusIn(e) {
  // Track text input focus — debounced, capture on blur
  const el = e.target;
  const tag = el.tagName?.toLowerCase();
  if (!['input', 'textarea'].includes(tag)) return;
  if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'submit' || el.type === 'button') return;
  lastInputEl = el;
}

// ── Capture helpers ────────────────────────────────────────────────────────

function captureInteraction(type, el, clickX, clickY, annotationType = 'rect') {
  if (!isRecording) return;
  pendingCapture = true;

  const elRect = el.getBoundingClientRect();
  const elementRect = annotationType === 'rect' ? {
    x: elRect.left / window.innerWidth,
    y: elRect.top  / window.innerHeight,
    w: elRect.width  / window.innerWidth,
    h: elRect.height / window.innerHeight,
  } : null;

  const data = {
    type,
    description: describeElement(el, type),
    element: extractElementInfo(el),
    url: location.href,
    pageTitle: document.title,
    clickX,
    clickY,
    elementRect,
    annotationType,
    scrollY: window.scrollY,
  };

  chrome.runtime.sendMessage({ type: 'CAPTURE_STEP', data }, (res) => {
    if (chrome.runtime.lastError) {
      console.warn('[Monkey] capture failed:', chrome.runtime.lastError.message);
    }
    pendingCapture = false;
  });
}

function describeElement(el, type) {
  const tag = el.tagName?.toLowerCase() || '';
  const ariaLabel = el.getAttribute('aria-label') || '';
  const placeholder = el.getAttribute('placeholder') || '';
  const title = el.getAttribute('title') || '';
  const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const value = el.value || '';
  const inputType = el.getAttribute('type') || '';
  const name = el.getAttribute('name') || '';

  const label = ariaLabel || rawText || placeholder || title || name;

  if (type === 'click') {
    if (tag === 'a') return label ? `Click the "${label}" link` : 'Click a link';
    if (tag === 'button' || inputType === 'submit' || el.getAttribute('role') === 'button') {
      return label ? `Click the "${label}" button` : 'Click a button';
    }
    if (tag === 'input') return label ? `Click the "${label}" field` : `Click the ${inputType || 'text'} field`;
    if (tag === 'label') return label ? `Click the "${label}" label` : 'Click a label';
    if (el.getAttribute('role') === 'tab') return label ? `Click the "${label}" tab` : 'Click a tab';
    if (el.getAttribute('role') === 'menuitem') return label ? `Select "${label}"` : 'Select a menu item';
    return label ? `Click "${label}"` : `Click on ${tag}`;
  }

  if (type === 'input') {
    const fieldName = ariaLabel || placeholder || name || rawText;
    return fieldName ? `Type in the "${fieldName}" field` : 'Type in a text field';
  }

  if (type === 'select') {
    if (inputType === 'checkbox') {
      const checked = el.checked;
      return label ? `${checked ? 'Check' : 'Uncheck'} "${label}"` : `${checked ? 'Check' : 'Uncheck'} a checkbox`;
    }
    if (inputType === 'radio') return label ? `Select the "${label}" option` : 'Select a radio option';
    const selectedText = el.options?.[el.selectedIndex]?.text || value;
    const fieldName = ariaLabel || name || placeholder;
    return fieldName
      ? `Select "${selectedText}" from the "${fieldName}" dropdown`
      : `Select "${selectedText}" from dropdown`;
  }

  return 'Interact with element';
}

function extractElementInfo(el) {
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName?.toLowerCase(),
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    placeholder: el.getAttribute('placeholder') || '',
    name: el.getAttribute('name') || '',
    id: el.id || '',
    href: el.href || '',
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  };
}

