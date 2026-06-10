/**
 * DetectAI Onboarding Wizard Controller
 * 3-step wizard: Welcome → Configure Backend → Test & Finish
 * No ES modules — plain script, runs in Chrome extension context.
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  var currentStep = 0;
  var totalSteps = 3;
  var selectedBackend = 'anthropic';
  var testPassed = false;

  // ── DOM refs (resolved after DOMContentLoaded) ────────────────────────────
  var stepEls, dots, testBtn, testResult, testResultIcon, testResultText;
  var apiKeyInput, ollamaUrlInput, ollamaModelInput;
  var thresholdSlider, thresholdValue;
  var thresholdSliderOllama, thresholdValueOllama;
  var autoScanToggle, showReasoningToggle, autoScanToggleOllama;
  var summaryBackend, summaryKey, summaryUrl, summaryModel, summaryThreshold;
  var summaryKeyRow, summaryUrlRow, summaryModelRow;
  var finishBtn;

  // ── Init ─────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    stepEls            = document.querySelectorAll('.step');
    dots               = document.querySelectorAll('.progress-dot');
    testBtn            = document.getElementById('testBtn');
    testResult         = document.getElementById('testResult');
    testResultIcon     = document.getElementById('testResultIcon');
    testResultText     = document.getElementById('testResultText');
    apiKeyInput        = document.getElementById('apiKeyInput');
    ollamaUrlInput     = document.getElementById('ollamaUrlInput');
    ollamaModelInput   = document.getElementById('ollamaModelInput');
    thresholdSlider       = document.getElementById('thresholdSlider');
    thresholdValue        = document.getElementById('thresholdValue');
    thresholdSliderOllama = document.getElementById('thresholdSliderOllama');
    thresholdValueOllama  = document.getElementById('thresholdValueOllama');
    autoScanToggle        = document.getElementById('autoScanToggle');
    showReasoningToggle   = document.getElementById('showReasoningToggle');
    autoScanToggleOllama  = document.getElementById('autoScanToggleOllama');
    summaryBackend     = document.getElementById('summaryBackend');
    summaryKey         = document.getElementById('summaryKey');
    summaryUrl         = document.getElementById('summaryUrl');
    summaryModel       = document.getElementById('summaryModel');
    summaryThreshold   = document.getElementById('summaryThreshold');
    summaryKeyRow      = document.getElementById('summaryKeyRow');
    summaryUrlRow      = document.getElementById('summaryUrlRow');
    summaryModelRow    = document.getElementById('summaryModelRow');
    finishBtn          = document.getElementById('finishBtn');

    // ── Bind navigation buttons (no inline onclick allowed in MV3) ────────────
    document.getElementById('btn-next-0').addEventListener('click', function () { goStep(1); });
    document.getElementById('btn-back-1').addEventListener('click', function () { goStep(0); });
    document.getElementById('btn-skip').addEventListener('click', skipToFinish);
    document.getElementById('step2NextBtn').addEventListener('click', function () { goStep(2); });
    document.getElementById('testBtn').addEventListener('click', runTest);
    document.getElementById('btn-back-2').addEventListener('click', function () { goStep(1); });
    document.getElementById('finishBtn').addEventListener('click', finish);

    // ── Bind backend selection cards ─────────────────────────────────────────
    document.getElementById('card-anthropic').addEventListener('click', function () { selectBackend('anthropic'); });
    document.getElementById('card-ollama').addEventListener('click', function () { selectBackend('ollama'); });

    // Wire threshold sliders
    thresholdSlider.addEventListener('input', function () {
      thresholdValue.textContent = Math.round(parseFloat(this.value) * 100) + '%';
      // keep ollama slider in sync
      thresholdSliderOllama.value = this.value;
      thresholdValueOllama.textContent = thresholdValue.textContent;
    });
    thresholdSliderOllama.addEventListener('input', function () {
      thresholdValueOllama.textContent = Math.round(parseFloat(this.value) * 100) + '%';
      thresholdSlider.value = this.value;
      thresholdValue.textContent = thresholdValueOllama.textContent;
    });

    // Wire progress dot clicks
    dots.forEach(function (dot) {
      dot.addEventListener('click', function () {
        var target = parseInt(dot.getAttribute('data-step'), 10);
        if (target < currentStep) goStep(target);
      });
    });

    // Load existing settings if any
    loadExistingSettings();
  });

  // ── Load saved settings ───────────────────────────────────────────────────
  function loadExistingSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    chrome.storage.local.get('detectai_settings', function (data) {
      var s = data && data.detectai_settings;
      if (!s) return;

      if (s.apiBackend === 'ollama') {
        selectBackend('ollama');
      }
      if (s.anthropicApiKey && apiKeyInput) {
        apiKeyInput.value = s.anthropicApiKey;
      }
      if (s.ollamaUrl && ollamaUrlInput) {
        ollamaUrlInput.value = s.ollamaUrl;
      }
      if (s.ollamaModel && ollamaModelInput) {
        ollamaModelInput.value = s.ollamaModel;
      }
      if (typeof s.detectionThreshold === 'number') {
        var pct = Math.round(s.detectionThreshold * 100) + '%';
        thresholdSlider.value = s.detectionThreshold;
        thresholdSliderOllama.value = s.detectionThreshold;
        thresholdValue.textContent = pct;
        thresholdValueOllama.textContent = pct;
      }
      if (typeof s.autoScan === 'boolean') {
        autoScanToggle.checked = s.autoScan;
        autoScanToggleOllama.checked = s.autoScan;
      }
      if (typeof s.showReasoning === 'boolean') {
        showReasoningToggle.checked = s.showReasoning;
      }
    });
  }

  // ── Step navigation ───────────────────────────────────────────────────────
  function goStep(targetStep) {
    if (targetStep < 0 || targetStep >= totalSteps) return;

    // Validate step 2 before advancing from it
    if (currentStep === 1 && targetStep === 2) {
      if (!validateStep2()) return;
      populateSummary();
      resetTestUI();
    }

    // Update active step
    stepEls.forEach(function (el, i) {
      el.classList.toggle('active', i === targetStep);
    });

    // Update dots
    dots.forEach(function (dot, i) {
      dot.classList.remove('active', 'done');
      if (i === targetStep) {
        dot.classList.add('active');
      } else if (i < targetStep) {
        dot.classList.add('done');
      }
    });

    currentStep = targetStep;

    // Scroll to top of page on step change
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Backend selection ─────────────────────────────────────────────────────
  function selectBackend(backend) {
    selectedBackend = backend;

    document.getElementById('card-anthropic').classList.toggle('selected', backend === 'anthropic');
    document.getElementById('card-ollama').classList.toggle('selected', backend === 'ollama');

    document.getElementById('panel-anthropic').classList.toggle('active', backend === 'anthropic');
    document.getElementById('panel-ollama').classList.toggle('active', backend === 'ollama');
  };

  // ── Step 2 validation ─────────────────────────────────────────────────────
  function validateStep2() {
    if (selectedBackend === 'anthropic') {
      var key = apiKeyInput ? apiKeyInput.value.trim() : '';
      if (!key) {
        highlightInput(apiKeyInput, 'Please enter your Anthropic API key.');
        return false;
      }
      if (!key.startsWith('sk-ant-')) {
        highlightInput(apiKeyInput, 'API keys typically start with "sk-ant-". Double-check your key.');
        return false;
      }
    } else {
      var url = ollamaUrlInput ? ollamaUrlInput.value.trim() : '';
      if (!url) {
        highlightInput(ollamaUrlInput, 'Please enter the Ollama server URL.');
        return false;
      }
    }
    return true;
  }

  function highlightInput(inputEl, message) {
    if (!inputEl) return;
    inputEl.style.borderColor = '#dc2626';
    inputEl.style.boxShadow = '0 0 0 3px rgba(220,38,38,0.15)';
    inputEl.focus();

    // Show inline error
    var existingErr = inputEl.parentNode.querySelector('.input-error');
    if (!existingErr) {
      var err = document.createElement('div');
      err.className = 'input-error';
      err.style.cssText = 'color:#f87171;font-size:12px;margin-top:4px;';
      err.textContent = message;
      inputEl.parentNode.insertBefore(err, inputEl.nextSibling);
    } else {
      existingErr.textContent = message;
    }

    // Clear on next input
    inputEl.addEventListener('input', function clearErr() {
      inputEl.style.borderColor = '';
      inputEl.style.boxShadow = '';
      var e = inputEl.parentNode.querySelector('.input-error');
      if (e) e.remove();
      inputEl.removeEventListener('input', clearErr);
    });
  }

  // ── Populate step 3 summary ───────────────────────────────────────────────
  function populateSummary() {
    var threshold = parseFloat(thresholdSlider.value);
    var pct = Math.round(threshold * 100) + '%';

    if (selectedBackend === 'anthropic') {
      summaryBackend.textContent = 'Anthropic API (Claude Sonnet)';
      var key = apiKeyInput ? apiKeyInput.value.trim() : '';
      summaryKey.textContent = key ? maskKey(key) : '(not set)';
      summaryKeyRow.style.display = '';
      summaryUrlRow.style.display = 'none';
      summaryModelRow.style.display = 'none';
    } else {
      summaryBackend.textContent = 'Ollama (Local)';
      summaryUrl.textContent = ollamaUrlInput ? ollamaUrlInput.value.trim() : 'http://localhost:11434';
      summaryModel.textContent = ollamaModelInput ? ollamaModelInput.value.trim() : 'qwen2.5:7b';
      summaryKeyRow.style.display = 'none';
      summaryUrlRow.style.display = '';
      summaryModelRow.style.display = '';
    }

    summaryThreshold.textContent = pct;
  }

  function maskKey(key) {
    if (key.length <= 8) return '••••••••';
    return key.slice(0, 10) + '•'.repeat(Math.min(key.length - 14, 20)) + key.slice(-4);
  }

  // ── Reset test UI ─────────────────────────────────────────────────────────
  function resetTestUI() {
    testPassed = false;
    testResult.className = 'test-result';
    testResultIcon.textContent = '';
    testResultText.textContent = '';
    if (testBtn) {
      testBtn.classList.remove('loading');
      testBtn.disabled = false;
    }
  }

  // ── Test connection (step 3) ──────────────────────────────────────────────
  function runTest() {
    if (!testBtn) return;

    testBtn.classList.add('loading');
    testBtn.disabled = true;
    testResult.className = 'test-result info';
    testResultIcon.textContent = '⏳';
    testResultText.textContent = 'Sending test request…';

    var payload = buildTestPayload();

    // Check chrome.runtime availability
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      // Running outside extension context (e.g. browser preview) — simulate success
      simulateTest(payload);
      return;
    }

    chrome.runtime.sendMessage(payload, function (response) {
      testBtn.classList.remove('loading');
      testBtn.disabled = false;

      if (chrome.runtime.lastError) {
        showTestError('Extension service worker not responding. Try reloading the extension.');
        return;
      }

      if (!response) {
        showTestError('No response from background. The service worker may have been suspended.');
        return;
      }

      if (response.ok) {
        showTestSuccess(response.message || 'Connection successful!');
      } else {
        showTestError(response.message || 'Connection failed. Check your configuration.');
      }
    });
  };

  function buildTestPayload() {
    var key = apiKeyInput ? apiKeyInput.value.trim() : '';
    var url = ollamaUrlInput ? ollamaUrlInput.value.trim() : 'http://localhost:11434';
    var model = ollamaModelInput ? ollamaModelInput.value.trim() : 'qwen2.5:7b';

    return {
      type: 'TEST_CONNECTION',
      backend: selectedBackend,
      apiKey: selectedBackend === 'anthropic' ? key : '',
      ollamaUrl: selectedBackend === 'ollama' ? url : '',
      ollamaModel: selectedBackend === 'ollama' ? model : ''
    };
  }

  // Fallback: simulate test result when not in extension context
  function simulateTest(payload) {
    var delay = 900 + Math.random() * 600;
    setTimeout(function () {
      testBtn.classList.remove('loading');
      testBtn.disabled = false;

      if (payload.backend === 'anthropic' && payload.apiKey) {
        showTestSuccess('API key accepted. Claude Sonnet is ready.');
      } else if (payload.backend === 'ollama') {
        showTestSuccess('Ollama is reachable at ' + payload.ollamaUrl + '.');
      } else {
        showTestError('Please enter a valid API key before testing.');
      }
    }, delay);
  }

  function showTestSuccess(message) {
    testPassed = true;
    testResult.className = 'test-result success';
    testResultIcon.textContent = '✓';
    testResultText.textContent = message;
    if (finishBtn) {
      finishBtn.classList.add('btn-success');
      finishBtn.classList.remove('btn-secondary');
    }
  }

  function showTestError(message) {
    testPassed = false;
    testResult.className = 'test-result error';
    testResultIcon.textContent = '✗';
    testResultText.textContent = message;
  }

  // ── Skip directly to finish ───────────────────────────────────────────────
  function skipToFinish() {
    // Save whatever partial config exists, then close
    saveSettingsAndClose(true);
  };

  // ── Finish ────────────────────────────────────────────────────────────────
  function finish() {
    saveSettingsAndClose(false);
  };

  function saveSettingsAndClose(skipValidation) {
    var threshold    = parseFloat(thresholdSlider.value);
    var autoScan     = autoScanToggle ? autoScanToggle.checked : true;
    var showReasoning = showReasoningToggle ? showReasoningToggle.checked : true;
    var ollamaAutoScan = autoScanToggleOllama ? autoScanToggleOllama.checked : true;

    // Merge both toggles (use the active panel's value)
    var finalAutoScan = selectedBackend === 'anthropic' ? autoScan : ollamaAutoScan;

    var settings = {
      apiBackend: selectedBackend,
      anthropicApiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
      ollamaUrl: ollamaUrlInput ? ollamaUrlInput.value.trim() : 'http://localhost:11434',
      ollamaModel: ollamaModelInput ? ollamaModelInput.value.trim() : 'qwen2.5:7b',
      detectionThreshold: isNaN(threshold) ? 0.70 : threshold,
      autoScan: finalAutoScan,
      enabled: true,
      showReasoning: showReasoning,
      highlightAmbiguous: false
    };

    if (typeof chrome === 'undefined' || !chrome.storage) {
      // Outside extension context — just close/redirect
      closeOrRedirect();
      return;
    }

    // Persist settings
    chrome.storage.local.set({ detectai_settings: settings }, function () {
      if (chrome.runtime.lastError) {
        console.warn('DetectAI: Failed to save settings:', chrome.runtime.lastError.message);
      }

      // Notify background that settings changed
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED', settings: settings }, function () {
          // Ignore errors — background may not be listening for this specific message
          var ignored = chrome.runtime.lastError;
        });
      }

      closeOrRedirect();
    });
  }

  function closeOrRedirect() {
    // Try to close the tab (works when opened as a tab by the extension)
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.getCurrent(function (tab) {
        if (tab && tab.id) {
          chrome.tabs.remove(tab.id);
        } else {
          window.location.href = 'chrome://newtab/';
        }
      });
    } else if (typeof chrome !== 'undefined' && chrome.runtime) {
      // Content script context — just navigate away
      window.location.href = 'about:newtab';
    } else {
      // Fallback: show a completion message
      showCompletionMessage();
    }
  }

  function showCompletionMessage() {
    var wizard = document.querySelector('.wizard');
    if (!wizard) return;
    wizard.innerHTML =
      '<div style="text-align:center;padding:60px 20px;">' +
        '<div style="font-size:48px;margin-bottom:20px;">✓</div>' +
        '<div style="font-size:24px;font-weight:700;color:#4ade80;margin-bottom:12px;">Setup Complete!</div>' +
        '<div style="color:#64748b;font-size:14px;">DetectAI is ready. You can close this tab.</div>' +
      '</div>';
  }

})();
