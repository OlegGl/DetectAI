/**
 * DetectAI — background.js (MV3 Service Worker, ES Module)
 * All API calls, settings management, and tab state live here.
 */

import { detectTextBatch, testConnection, preloadOllama } from './lib/api-client.js';
import {
  saveTabState,
  getTabState,
  clearTabState,
  updateStatus,
} from './lib/detection-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  apiBackend: 'ollama',
  anthropicApiKey: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5:7b',
  detectionThreshold: 0.70,
  autoScan: true,
  enabled: true,
  showReasoning: true,
  highlightAmbiguous: false,
  debug: false,
};

const SETTINGS_KEY = 'detectai_settings';
const KEEPALIVE_ALARM = 'keepalive';
const OLLAMA_CORS_RULE_ID = 1001;

// ---------------------------------------------------------------------------
// Ollama CORS workaround
//
// Ollama returns 403 Forbidden for any request whose Origin header isn't in its
// OLLAMA_ORIGINS allowlist — and Chrome always attaches Origin: chrome-extension://<id>.
// Rather than require the user to reconfigure + restart Ollama, we strip the
// Origin header on requests to the Ollama host via declarativeNetRequest. With
// no Origin, Ollama treats the call like curl and allows it.
// ---------------------------------------------------------------------------

let appliedOllamaOrigin = null;

async function ensureOllamaCorsRule(settings) {
  if (!settings || settings.apiBackend !== 'ollama') return;

  let origin;
  try {
    origin = new URL(settings.ollamaUrl || 'http://localhost:11434').origin;
  } catch (_) {
    return; // malformed URL — nothing to do
  }

  if (origin === appliedOllamaOrigin) return; // already applied for this host

  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
    return; // permission missing — fall back to OLLAMA_ORIGINS config
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [OLLAMA_CORS_RULE_ID],
      addRules: [
        {
          id: OLLAMA_CORS_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Origin', operation: 'remove' }],
          },
          condition: {
            urlFilter: origin + '/',
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
    appliedOllamaOrigin = origin;
  } catch (err) {
    console.warn('[DetectAI] Could not install Ollama CORS rule:', err);
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored[SETTINGS_KEY] || {};
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (err) {
    console.error('[DetectAI] getSettings error:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// One-time migration: move existing installs off the prior default models onto
// the current default (qwen2.5:7b — better accuracy than 3b, far faster than the
// 31B). Narrow by design — only prior default values are touched, never a
// genuinely custom user choice. Runs once (V2).
const PRIOR_DEFAULT_MODELS = new Set(['gemma4', 'gemma4:31b-mlx', 'qwen2.5:3b']);

async function migrateSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const s = stored[SETTINGS_KEY];
    if (!s || s.modelMigratedV2) return; // fresh install already uses the new default
    if (s.apiBackend === 'ollama' && (!s.ollamaModel || PRIOR_DEFAULT_MODELS.has(s.ollamaModel))) {
      s.ollamaModel = 'qwen2.5:7b';
    }
    // Nudge the prior default threshold up to the new, more conservative default
    // (only if untouched) — reduces false positives now that confidence is
    // calibrated as a true P(AI).
    if (s.detectionThreshold === 0.65) {
      s.detectionThreshold = 0.70;
    }
    s.modelMigratedV2 = true;
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  } catch (err) {
    console.error('[DetectAI] migrateSettings error:', err);
  }
}

// ---------------------------------------------------------------------------
// Keepalive alarm — prevents the service worker from being killed mid-scan
// ---------------------------------------------------------------------------

function registerKeepaliveAlarm() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.49 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Touch session storage to reset the service-worker idle timer.
    try {
      await chrome.storage.session.set({ _keepalive: Date.now() });
    } catch (_) {
      // session storage may not always be available; swallow safely.
    }
  }
});

// ---------------------------------------------------------------------------
// Install / startup lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  registerKeepaliveAlarm();
  migrateSettings().then(() => getSettings()).then(ensureOllamaCorsRule).catch(() => {});

  if (details.reason === 'install') {
    // First install: open the onboarding page.
    chrome.tabs.create({ url: 'onboarding/welcome.html' });

    // Persist default settings so they are always present.
    saveSettings(DEFAULT_SETTINGS).catch(console.error);
  }
});

// Re-register alarm + CORS rule on every service-worker startup, and run the
// one-time model migration for existing installs.
registerKeepaliveAlarm();
migrateSettings().then(() => getSettings()).then(ensureOllamaCorsRule).catch(() => {});

// ---------------------------------------------------------------------------
// Tab lifecycle — clean up state when tabs close or navigate away
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  tabWriteLocks.delete(tabId);
  clearTabState(tabId).catch((err) =>
    console.error('[DetectAI] clearTabState error on remove:', err)
  );
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // New page navigation: clear previous scan data and overlays.
    clearTabState(tabId).catch((err) =>
      console.error('[DetectAI] clearTabState error on loading:', err)
    );

    // Tell the old content script (if still alive) to remove overlays.
    chrome.tabs
      .sendMessage(tabId, { type: 'CLEAR_OVERLAYS' })
      .catch(() => {
        // Content script may not be ready yet — that is fine.
      });
  }
});

// ---------------------------------------------------------------------------
// Message handler helpers
// ---------------------------------------------------------------------------

// Per-tab write serialization. Multiple SCAN_PARAGRAPHS batches for one tab
// each do a read-modify-write on chrome.storage.session; without a lock, two
// overlapping handlers can both read the old state and the second clobbers the
// first (lost results). This promise chain serializes writes per tab.
const tabWriteLocks = new Map();

function withTabLock(tabId, fn) {
  const prev = tabWriteLocks.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next writer.
  tabWriteLocks.set(tabId, next.then(() => {}, () => {}));
  return next;
}

/**
 * Append newly detected results to the existing tab state and return the
 * updated aiCount. Serialized per tab to avoid lost updates.
 *
 * Definitions (kept consistent with the on-page overlays):
 *   totalScanned = segments actually analyzed (excludes skip / insufficient)
 *   aiCount      = segments whose P(AI) confidence is at or above the threshold
 */
async function appendResults(tabId, url, newResults, settings) {
  return withTabLock(tabId, async () => {
    const existing = (await getTabState(tabId)) || {
      status: 'scanning',
      url,
      results: [],
      aiCount: 0,
      totalScanned: 0,
    };

    // Merge keyed by id so a re-sent batch (content-script retry after a lost
    // response, interaction rescan) overwrites rather than double-counts.
    const byId = new Map((existing.results || []).map((r) => [r.id, r]));
    for (const r of newResults) byId.set(r.id, r);
    const merged = [...byId.values()];
    const threshold = settings.detectionThreshold != null ? settings.detectionThreshold : 0.70;

    const totalScanned = merged.filter(
      (r) => r.label !== 'skip' && r.label !== 'insufficient'
    ).length;

    const aiCount = merged.filter(
      (r) => r.label !== 'skip' && r.label !== 'insufficient' && r.confidence >= threshold
    ).length;

    const nextState = {
      status: 'done',
      url: url || existing.url || '',
      results: merged,
      aiCount,
      totalScanned,
    };

    await saveTabState(tabId, nextState);
    return aiCount;
  });
}

// ---------------------------------------------------------------------------
// Main message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;
  const tabUrl = sender.tab ? sender.tab.url : '';

  // Wrap everything in an IIFE so we can use async/await while still
  // returning `true` synchronously to keep the message channel open.
  (async () => {
    try {
      switch (message.type) {
        // ------------------------------------------------------------------
        case 'SCAN_PARAGRAPHS': {
          const settings = await getSettings();

          if (!settings.enabled) {
            sendResponse({ results: [] });
            return;
          }

          if (
            settings.apiBackend === 'anthropic' &&
            !settings.anthropicApiKey
          ) {
            sendResponse({
              error: 'No Anthropic API key configured. Open Options to set one.',
              results: [],
            });
            return;
          }

          // Make sure the Ollama CORS rule is in place for the current host.
          await ensureOllamaCorsRule(settings);

          // Update status to scanning before starting.
          if (tabId !== null) {
            await updateStatus(tabId, 'scanning', tabUrl);
          }

          const { paragraphs } = message;
          let results = [];

          // Collect backend-side debug events (timings, model, raw response) when
          // debug mode is on, and return them to the content script's log panel.
          const debugEntries = [];
          const onDebug = settings.debug
            ? (entry) => { debugEntries.push({ ...entry, at: Date.now() }); }
            : null;

          // Stream per-segment verdicts to the page so outlines appear as soon as
          // each is known (cache hits + streamed Ollama lines), not at batch end.
          const onPartial = tabId !== null
            ? (partials) => {
                chrome.tabs
                  .sendMessage(tabId, { type: 'PARTIAL_RESULTS', results: partials })
                  .catch(() => {});
              }
            : null;

          try {
            results = await detectTextBatch(paragraphs, settings, { onDebug, onPartial });
          } catch (apiErr) {
            console.error('[DetectAI] detectTextBatch error:', apiErr);
            if (tabId !== null) {
              await updateStatus(tabId, 'error', tabUrl);
            }
            if (settings.debug) {
              debugEntries.push({ phase: 'error', error: apiErr.message, at: Date.now() });
            }
            sendResponse({ error: apiErr.message, results: [], debug: debugEntries });
            return;
          }

          // Attach source text to each result so the popup can render previews
          // (detectTextBatch returns id/label/confidence/reasoning/signals only).
          const textById = new Map((paragraphs || []).map((p) => [p.id, p.text]));
          const enriched = results.map((r) => ({
            ...r,
            text: textById.get(r.id) || '',
          }));

          // Persist results and notify the tab.
          if (tabId !== null) {
            const aiCount = await appendResults(tabId, tabUrl, enriched, settings);

            chrome.tabs
              .sendMessage(tabId, {
                type: 'SCAN_COMPLETE',
                tabId,
                aiCount,
              })
              .catch(() => {
                // Content script may be gone (SPA navigation) — ignore.
              });
          }

          sendResponse({ results, debug: debugEntries });
          break;
        }

        // ------------------------------------------------------------------
        case 'GET_SETTINGS': {
          const settings = await getSettings();
          sendResponse(settings);
          break;
        }

        // ------------------------------------------------------------------
        case 'GET_STATUS': {
          const queryTabId =
            message.tabId !== undefined ? message.tabId : tabId;
          if (queryTabId === null) {
            sendResponse({ status: 'idle', count: 0, aiCount: 0 });
            return;
          }
          const state = await getTabState(queryTabId);
          if (!state) {
            sendResponse({ status: 'idle', count: 0, aiCount: 0, totalScanned: 0, results: [] });
          } else {
            sendResponse({
              status: state.status,
              count: state.totalScanned || 0,
              aiCount: state.aiCount || 0,
              totalScanned: state.totalScanned || 0,
              results: state.results || [],
            });
          }
          break;
        }

        // ------------------------------------------------------------------
        case 'PRELOAD': {
          // Warm the local model while the user is still reading, so the first
          // real batch isn't blocked on the cold load.
          const settings = await getSettings();
          if (settings.enabled && settings.apiBackend === 'ollama') {
            await ensureOllamaCorsRule(settings);
            preloadOllama(settings); // fire-and-forget
          }
          sendResponse({ ok: true });
          break;
        }

        // ------------------------------------------------------------------
        case 'OPEN_OPTIONS': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }

        // ------------------------------------------------------------------
        case 'TEST_CONNECTION': {
          const { backend, apiKey, ollamaUrl, ollamaModel } = message;
          const testSettings = {
            ...DEFAULT_SETTINGS,
            apiBackend: backend || 'anthropic',
            anthropicApiKey: apiKey || '',
            ollamaUrl: ollamaUrl || DEFAULT_SETTINGS.ollamaUrl,
            ollamaModel: ollamaModel || DEFAULT_SETTINGS.ollamaModel,
          };

          // Strip Origin for the Ollama host before testing, or the test 403s too.
          await ensureOllamaCorsRule(testSettings);

          try {
            const result = await testConnection(testSettings);
            sendResponse(result);
          } catch (err) {
            sendResponse({ ok: false, message: err.message });
          }
          break;
        }

        // ------------------------------------------------------------------
        case 'RESCAN': {
          if (tabId !== null) {
            await clearTabState(tabId);

            chrome.tabs
              .sendMessage(tabId, { type: 'CLEAR_OVERLAYS' })
              .catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        // ------------------------------------------------------------------
        case 'SETTINGS_CHANGED': {
          // Refresh the CORS rule for a possibly-changed Ollama host before the
          // next scan, then broadcast to all tabs so content scripts re-evaluate
          // overlays without a full page reload.
          await ensureOllamaCorsRule(message.settings);

          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.id !== undefined) {
              chrome.tabs
                .sendMessage(tab.id, {
                  type: 'SETTINGS_CHANGED',
                  settings: message.settings,
                })
                .catch(() => {});
            }
          }
          sendResponse({ ok: true });
          break;
        }

        // ------------------------------------------------------------------
        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error('[DetectAI] Unhandled error in onMessage:', err);
      sendResponse({ error: err.message });
    }
  })();

  // Return true to signal that sendResponse will be called asynchronously.
  return true;
});

// ---------------------------------------------------------------------------
// Export helpers for potential use by other modules (e.g. tests)
// ---------------------------------------------------------------------------

export { getSettings, saveSettings, DEFAULT_SETTINGS };
