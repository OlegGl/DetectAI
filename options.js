/* DetectAI — Options Page Controller */

'use strict';

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

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load persisted settings
  const stored = await chrome.storage.local.get('detectai_settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.detectai_settings || {}) };

  populateForm(settings);
  wireSlider();
  wireBackendCards();
  wireTestButtons();
  wireActionButtons();
});

// ── Form population ───────────────────────────────────────────────────────────

function populateForm(settings) {
  // Backend card selection
  document.querySelectorAll('.backend-card').forEach(c => c.classList.remove('selected'));
  const activeCard = document.getElementById('card-' + settings.apiBackend);
  if (activeCard) activeCard.classList.add('selected');

  document.getElementById('anthropic-config').style.display =
    settings.apiBackend === 'anthropic' ? 'block' : 'none';
  document.getElementById('ollama-config').style.display =
    settings.apiBackend === 'ollama' ? 'block' : 'none';

  // Credential inputs
  document.getElementById('api-key').value = settings.anthropicApiKey || '';
  document.getElementById('ollama-url').value = settings.ollamaUrl || 'http://localhost:11434';
  document.getElementById('ollama-model').value = settings.ollamaModel || 'qwen2.5:7b';

  // Threshold slider
  const thresholdPct = Math.round((settings.detectionThreshold ?? 0.70) * 100);
  const slider = document.getElementById('threshold');
  slider.value = thresholdPct;
  document.getElementById('threshold-display').textContent = thresholdPct + '%';
  updateSliderFill(slider);

  // Toggles
  document.getElementById('auto-scan').checked = settings.autoScan !== false;
  document.getElementById('show-reasoning').checked = settings.showReasoning !== false;
  document.getElementById('highlight-ambiguous').checked = !!settings.highlightAmbiguous;
  document.getElementById('debug-mode').checked = !!settings.debug;

  // Clear any stale test results
  document.querySelectorAll('.test-result').forEach(el => {
    el.textContent = '';
    el.className = 'test-result';
  });
}

// ── Slider ────────────────────────────────────────────────────────────────────

function wireSlider() {
  const slider = document.getElementById('threshold');
  const display = document.getElementById('threshold-display');

  slider.addEventListener('input', () => {
    display.textContent = slider.value + '%';
    updateSliderFill(slider);
  });
}

/** Update the CSS custom property used to tint the filled portion of the track. */
function updateSliderFill(slider) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const val = Number(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.setProperty('--pct', pct + '%');
  // Also update the webkit gradient directly for browsers that support it
  slider.style.background = `linear-gradient(
    to right,
    #dc2626 0%,
    #dc2626 ${pct}%,
    rgba(255,255,255,0.1) ${pct}%,
    rgba(255,255,255,0.1) 100%
  )`;
}

// ── Backend card switching ────────────────────────────────────────────────────

function wireBackendCards() {
  document.querySelectorAll('.backend-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.backend-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');

      const backend = card.dataset.backend;
      document.getElementById('anthropic-config').style.display =
        backend === 'anthropic' ? 'block' : 'none';
      document.getElementById('ollama-config').style.display =
        backend === 'ollama' ? 'block' : 'none';

      // Clear test results when switching
      document.querySelectorAll('.test-result').forEach(el => {
        el.textContent = '';
        el.className = 'test-result';
      });
    });
  });
}

// ── Connection test ───────────────────────────────────────────────────────────

function wireTestButtons() {
  document.getElementById('test-anthropic').addEventListener('click', () => testConnection('anthropic'));
  document.getElementById('test-ollama').addEventListener('click', () => testConnection('ollama'));
}

async function testConnection(backend) {
  const btn = document.getElementById('test-' + backend);
  const resultEl = document.getElementById('test-' + backend + '-result');

  // Validate inputs before sending
  if (backend === 'anthropic') {
    const key = document.getElementById('api-key').value.trim();
    if (!key) {
      resultEl.textContent = '✗ Please enter an API key first';
      resultEl.className = 'test-result error';
      return;
    }
  }

  // Disable button and show loading state
  btn.disabled = true;
  btn.textContent = 'Testing…';
  resultEl.textContent = '';
  resultEl.className = 'test-result';

  const payload =
    backend === 'anthropic'
      ? {
          type: 'TEST_CONNECTION',
          backend: 'anthropic',
          apiKey: document.getElementById('api-key').value.trim(),
        }
      : {
          type: 'TEST_CONNECTION',
          backend: 'ollama',
          ollamaUrl: document.getElementById('ollama-url').value.trim() || 'http://localhost:11434',
          ollamaModel: document.getElementById('ollama-model').value.trim() || 'qwen2.5:7b',
        };

  try {
    const result = await chrome.runtime.sendMessage(payload);
    if (result && result.ok) {
      resultEl.textContent = '✓ ' + (result.message || 'Connected');
      resultEl.className = 'test-result success';
    } else {
      resultEl.textContent = '✗ ' + (result?.message || 'Connection failed');
      resultEl.className = 'test-result error';
    }
  } catch (e) {
    resultEl.textContent = '✗ ' + (e?.message || 'Extension error — try reloading');
    resultEl.className = 'test-result error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

// ── Save / Reset ──────────────────────────────────────────────────────────────

function wireActionButtons() {
  document.getElementById('btn-save').addEventListener('click', saveSettings);
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Reset all settings to defaults?')) {
      populateForm(DEFAULT_SETTINGS);
    }
  });
}

async function saveSettings() {
  const saveBtn = document.getElementById('btn-save');
  const selectedBackend =
    document.querySelector('.backend-card.selected')?.dataset?.backend || 'anthropic';

  // Validate required fields
  if (selectedBackend === 'anthropic') {
    const key = document.getElementById('api-key').value.trim();
    if (!key) {
      alert('Please enter your Anthropic API key before saving.');
      document.getElementById('api-key').focus();
      return;
    }
  }

  if (selectedBackend === 'ollama') {
    const url = document.getElementById('ollama-url').value.trim();
    if (!url) {
      alert('Please enter the Ollama URL before saving.');
      document.getElementById('ollama-url').focus();
      return;
    }
  }

  // Preserve the existing enabled state (the master on/off lives in the popup);
  // saving options should not silently re-enable a user who turned it off.
  let priorEnabled = true;
  try {
    const stored = await chrome.storage.local.get('detectai_settings');
    if (stored.detectai_settings && typeof stored.detectai_settings.enabled === 'boolean') {
      priorEnabled = stored.detectai_settings.enabled;
    }
  } catch (e) { /* default to enabled */ }

  // Build settings object
  const settings = {
    apiBackend: selectedBackend,
    anthropicApiKey: document.getElementById('api-key').value.trim(),
    ollamaUrl: document.getElementById('ollama-url').value.trim() || 'http://localhost:11434',
    ollamaModel: document.getElementById('ollama-model').value.trim() || 'qwen2.5:7b',
    detectionThreshold: parseInt(document.getElementById('threshold').value, 10) / 100,
    autoScan: document.getElementById('auto-scan').checked,
    enabled: priorEnabled,
    showReasoning: document.getElementById('show-reasoning').checked,
    highlightAmbiguous: document.getElementById('highlight-ambiguous').checked,
    debug: document.getElementById('debug-mode').checked,
  };

  // Persist
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    await chrome.storage.local.set({ detectai_settings: settings });

    // Route through the background: it refreshes the Ollama CORS rule for a
    // possibly-changed host and re-broadcasts to every tab's content script.
    await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED', settings }).catch(() => {});

    showToast('Settings saved!');
  } catch (e) {
    showToast('Error saving settings', true);
    console.error('[DetectAI] saveSettings error:', e);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message = 'Settings saved!', isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;

  if (isError) {
    toast.style.background = '#2a1a1a';
    toast.style.borderColor = 'rgba(248,113,113,0.3)';
    toast.style.color = '#f87171';
  } else {
    toast.style.background = '#1a2a1a';
    toast.style.borderColor = 'rgba(74,222,128,0.3)';
    toast.style.color = '#4ade80';
  }

  toast.classList.remove('hiding');
  toast.style.display = 'block';

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toastTimer = setTimeout(() => {
    toast.classList.add('hiding');
    // Remove from DOM after animation completes
    setTimeout(() => {
      toast.style.display = 'none';
      toast.classList.remove('hiding');
    }, 300);
    toastTimer = null;
  }, 2200);
}
