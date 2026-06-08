/* popup.js — DetectAI popup controller */

document.addEventListener('DOMContentLoaded', async () => {

  // 1. Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 2. Load settings
  let settings = {};
  try {
    settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  } catch (e) {
    settings = {};
  }

  // 3. Load tab state
  let tabState = null;
  try {
    tabState = await chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab.id });
  } catch (e) {
    tabState = null;
  }

  // 4. Check if configured
  const isConfigured = (settings.apiBackend === 'anthropic' && settings.anthropicApiKey) ||
                       settings.apiBackend === 'ollama';

  // 5. Render initial state
  renderState(settings, tabState, isConfigured);

  // ── Enable/Disable toggle ──────────────────────────────────
  const toggle = document.getElementById('toggle-enabled');
  toggle.checked = !!settings.enabled;

  toggle.addEventListener('change', async () => {
    settings.enabled = toggle.checked;
    try {
      await chrome.storage.local.set({ detectai_settings: settings });
      // Notify all content scripts
      const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_CHANGED', settings }).catch(() => {});
      }
    } catch (e) {
      // Extension context may be unavailable on restricted pages; ignore
    }
    // Re-render the popup: when disabled, clear the stale results/ratio UI.
    if (!toggle.checked) {
      renderState(settings, null, isConfigured);
    } else {
      try {
        const fresh = await chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab.id });
        renderState(settings, fresh, isConfigured);
      } catch (e) { /* ignore */ }
    }
  });

  // ── Options button ─────────────────────────────────────────
  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ── Setup CTA button ───────────────────────────────────────
  document.getElementById('btn-setup').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // ── Scan Now button ────────────────────────────────────────
  document.getElementById('btn-scan').addEventListener('click', async () => {
    if (!tab || !tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' });
    } catch (e) {
      // Content script may not be injected on restricted pages
    }
    window.close();
  });

  // ── Clear button ───────────────────────────────────────────
  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!tab || !tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_OVERLAYS' });
    } catch (e) {
      // Ignore
    }
    renderState(settings, null, isConfigured);
  });

  // ── Live update when scan finishes ────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCAN_COMPLETE' && tab && msg.tabId === tab.id) {
      chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tab.id })
        .then(state => renderState(settings, state, isConfigured))
        .catch(() => {});
    }
  });

});

/* ── renderState ──────────────────────────────────────────────
   Drives all visible UI based on current settings + tab state.
─────────────────────────────────────────────────────────────── */
function renderState(settings, tabState, isConfigured) {

  const setupCta    = document.getElementById('setup-cta');
  const mainContent = document.getElementById('main-content');
  const elIdle      = document.getElementById('status-idle');
  const elScanning  = document.getElementById('status-scanning');
  const elDone      = document.getElementById('status-done');
  const elResults   = document.getElementById('results-section');

  // Show / hide top-level sections
  setupCta.style.display    = isConfigured ? 'none'  : 'block';
  mainContent.style.display = isConfigured ? 'block' : 'none';

  if (!isConfigured) return;

  // ── No state or idle ────────────────────────────────────
  if (!tabState || tabState.status === 'idle') {
    elIdle.style.display     = 'block';
    elScanning.style.display = 'none';
    elDone.style.display     = 'none';
    elResults.style.display  = 'none';
    return;
  }

  elIdle.style.display = 'none';

  // ── Scanning ─────────────────────────────────────────────
  if (tabState.status === 'scanning') {
    elScanning.style.display = 'flex';
    elDone.style.display     = 'none';
    elResults.style.display  = 'none';
    return;
  }

  // ── Done or error ─────────────────────────────────────────
  if (tabState.status === 'done' || tabState.status === 'error') {
    elScanning.style.display = 'none';
    elDone.style.display     = 'block';

    const total   = tabState.totalScanned || 0;
    const aiCount = tabState.aiCount      || 0;

    document.getElementById('status-text').textContent =
      total + ' segment' + (total !== 1 ? 's' : '') + ' analyzed — ' +
      aiCount + ' AI-detected';

    if (total > 0) {
      const aiPct    = Math.round(aiCount / total * 100);
      const humanPct = 100 - aiPct;

      document.getElementById('ratio-human').style.width = humanPct + '%';
      document.getElementById('ratio-ai').style.width    = aiPct    + '%';
      document.getElementById('label-human').textContent = humanPct + '% Human';
      document.getElementById('label-ai').textContent    = aiPct    + '% AI';

      elResults.style.display = 'block';
      renderResultsList(tabState.results || []);
    } else {
      elResults.style.display = 'none';
    }
  }
}

/* ── renderResultsList ────────────────────────────────────────
   Shows top-5 AI-detected paragraphs sorted by confidence desc.
─────────────────────────────────────────────────────────────── */
function renderResultsList(results) {
  const list = document.getElementById('results-list');

  const aiResults = results
    .filter(r => r.label === 'ai')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  if (aiResults.length === 0) {
    list.innerHTML = '<div class="empty-message">No AI-generated paragraphs detected.</div>';
    return;
  }

  list.innerHTML = aiResults.map(r => {
    const pct     = Math.round(r.confidence * 100);
    const rawText = r.text || r.reasoning || '';
    const preview = rawText.length > 90
      ? escHtml(rawText.slice(0, 90)) + '&hellip;'
      : escHtml(rawText);

    return (
      '<div class="result-item">' +
        '<span class="confidence-badge-ai">' + pct + '%</span>' +
        '<span class="paragraph-preview">' + preview + '</span>' +
      '</div>'
    );
  }).join('');
}

/* ── escHtml ──────────────────────────────────────────────────
   Minimal HTML escaping for untrusted page text.
─────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return (s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}
