'use strict';

// In-memory state — persisted to storage.local for cross-navigation durability
let state = {
  recording: false,
  paused: false,
  steps: [],
  recordingTabId: null,
  stepCounter: 0,
};

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function loadState() {
  const saved = await chrome.storage.local.get(['monkey_state']);
  if (saved.monkey_state) {
    state = { ...state, ...saved.monkey_state };
  }
}

async function saveState() {
  await chrome.storage.local.set({ monkey_state: state });
}

loadState();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Also set on startup in case the service worker was freshly started
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Message router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const tab = sender.tab;
      switch (msg.type) {
        case 'IS_RECORDING':
          sendResponse({ recording: state.recording, paused: state.paused, stepCount: state.steps.length });
          break;

        case 'START_RECORDING': {
          state.recording = true;
          state.paused = false;
          state.steps = [];
          state.stepCounter = 0;
          state.recordingTabId = tab?.id ?? null;
          await saveState();
          updateBadge('recording');
          broadcast({ type: 'RECORDING_STARTED' });
          sendResponse({ success: true });
          break;
        }

        case 'STOP_RECORDING': {
          state.recording = false;
          state.paused = false;
          await saveState();
          updateBadge('stopped');
          broadcast({ type: 'RECORDING_STOPPED', stepCount: state.steps.length });
          sendResponse({ success: true, stepCount: state.steps.length });
          break;
        }

        case 'PAUSE_RECORDING': {
          state.paused = true;
          await saveState();
          updateBadge('paused');
          broadcast({ type: 'RECORDING_PAUSED' });
          sendResponse({ success: true });
          break;
        }

        case 'RESUME_RECORDING': {
          state.paused = false;
          await saveState();
          updateBadge('recording');
          broadcast({ type: 'RECORDING_RESUMED' });
          sendResponse({ success: true });
          break;
        }

        case 'CAPTURE_STEP': {
          if (!state.recording || state.paused) {
            sendResponse({ success: false, reason: 'not recording' });
            break;
          }
          const step = await captureStep(tab, msg.data);
          state.steps.push(step);
          state.stepCounter = state.steps.length;
          await saveState();
          setBadgeCount(state.steps.length);
          broadcast({ type: 'STEP_ADDED', step, stepCount: state.steps.length });
          sendResponse({ success: true, stepIndex: state.steps.length - 1 });
          break;
        }

        case 'GET_STEPS':
          sendResponse({ steps: state.steps, recording: state.recording, paused: state.paused });
          break;

        case 'UPDATE_STEP': {
          if (state.steps[msg.index] !== undefined) {
            state.steps[msg.index] = { ...state.steps[msg.index], ...msg.updates };
            await saveState();
          }
          sendResponse({ success: true });
          break;
        }

        case 'DELETE_STEP': {
          state.steps.splice(msg.index, 1);
          await saveState();
          sendResponse({ success: true });
          break;
        }

        case 'REORDER_STEPS': {
          // msg.from, msg.to
          const [moved] = state.steps.splice(msg.from, 1);
          state.steps.splice(msg.to, 0, moved);
          await saveState();
          sendResponse({ success: true });
          break;
        }

        case 'CLEAR_STEPS': {
          state.steps = [];
          state.stepCounter = 0;
          await saveState();
          updateBadge('stopped');
          sendResponse({ success: true });
          break;
        }

        // ── Guide library ──────────────────────────────────────────────────

        case 'SAVE_GUIDE': {
          const guides = await getGuides();
          const id = msg.id || `guide_${Date.now()}`;
          const existing = guides.findIndex(g => g.id === id);
          const guide = {
            id,
            name: msg.name || 'Untitled Guide',
            steps: msg.steps,
            stepCount: msg.steps.length,
            thumbnail: msg.steps.find(s => s.screenshot)?.screenshot ?? null,
            createdAt: existing >= 0 ? guides[existing].createdAt : Date.now(),
            updatedAt: Date.now(),
          };
          if (existing >= 0) guides[existing] = guide;
          else guides.unshift(guide);
          await saveGuides(guides);
          sendResponse({ success: true, guide });
          break;
        }

        case 'GET_GUIDES': {
          const guides = await getGuides();
          // Return without full step data for listing (thumbnails only)
          const summaries = guides.map(({ id, name, stepCount, thumbnail, createdAt, updatedAt }) =>
            ({ id, name, stepCount, thumbnail, createdAt, updatedAt }));
          sendResponse({ guides: summaries });
          break;
        }

        case 'GET_GUIDE': {
          const guides = await getGuides();
          const guide = guides.find(g => g.id === msg.id) ?? null;
          sendResponse({ guide });
          break;
        }

        case 'DELETE_GUIDE': {
          const guides = await getGuides();
          await saveGuides(guides.filter(g => g.id !== msg.id));
          sendResponse({ success: true });
          break;
        }

        case 'RENAME_GUIDE': {
          const guides = await getGuides();
          const g = guides.find(g => g.id === msg.id);
          if (g) { g.name = msg.name; g.updatedAt = Date.now(); }
          await saveGuides(guides);
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, reason: 'unknown message type' });
      }
    } catch (err) {
      console.error('[Monkey background]', err);
      sendResponse({ success: false, reason: err.message });
    }
  })();
  return true; // keep port open for async response
});

// ── Screenshot + step assembly ─────────────────────────────────────────────

async function captureStep(tab, data) {
  await sleep(80);

  let screenshot = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      break;
    } catch (e) {
      if (attempt === 4) {
        console.warn('[Monkey] screenshot failed after 4 attempts:', e.message);
      } else {
        await sleep(attempt * 150);
      }
    }
  }

  return {
    id: Date.now(),
    index: state.steps.length,
    type: data.type,           // 'click' | 'input' | 'select' | 'navigate'
    description: data.description,
    element: data.element,     // { tag, text, type, role, ariaLabel }
    url: data.url,
    pageTitle: data.pageTitle,
    clickX: data.clickX,
    clickY: data.clickY,
    elementRect: data.elementRect,
    annotationType: data.annotationType ?? 'rect',
    scrollY: data.scrollY,
    screenshot,
    timestamp: Date.now(),
  };
}

// ── Badge helpers ──────────────────────────────────────────────────────────

function updateBadge(status) {
  if (status === 'recording') {
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: 'REC' });
  } else if (status === 'paused') {
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    chrome.action.setBadgeText({ text: 'PAU' });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    chrome.action.setBadgeText({ text: '' });
  }
}

function setBadgeCount(n) {
  chrome.action.setBadgeText({ text: String(n) });
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function getGuides() {
  const saved = await chrome.storage.local.get(['monkey_guides']);
  return saved.monkey_guides || [];
}

async function saveGuides(guides) {
  await chrome.storage.local.set({ monkey_guides: guides });
}
