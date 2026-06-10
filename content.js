(function () {
  'use strict';

  // ─── CONSTANTS ────────────────────────────────────────────────────────────────

  const PARA_PREFIX = 'detectai-p-';
  const MIN_TEXT_LEN = 80;
  const MAX_TEXT_LEN = 3500;
  const DEBOUNCE_MS = 400;
  const BATCH_SIZE = 10;
  // After a user interaction (click / key press) we wait this long for the page
  // to finish revealing/loading content, then re-scan for new or now-visible text.
  const INTERACTION_RESCAN_DELAY = 500;
  const AI_CLASS = 'detectai-overlay-ai';
  const AMB_CLASS = 'detectai-overlay-ambiguous';
  const SCAN_CLASS = 'detectai-scanning';
  const TOOLTIP_CLASS = 'detectai-tooltip';
  const TOOLTIP_VIS = 'detectai-tooltip-visible';

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER'
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE',
    'TEXTAREA', 'INPUT', 'SELECT', 'SVG', 'CANVAS',
    'VIDEO', 'AUDIO', 'IFRAME', 'BUTTON', 'NAV'
  ]);

  // ─── STATE ────────────────────────────────────────────────────────────────────

  let settings = null;
  let paragraphCounter = 0;
  let isRunning = false;
  let scanDebounceTimer = null;
  let mutationDebounce = null;
  let interactionRescanTimer = null;

  // paragraph registry: id → { element, text, result, overlayActive, tooltipEl }
  const registry = new Map();

  // Scan queue: ids that are in/near the viewport and ready to be scanned now.
  const scanQueue = [];

  // Off-screen ids being watched by the IntersectionObserver. They are NOT
  // scanned until they approach the viewport (i.e. as the user scrolls), which
  // is what makes scanning progressive/lazy. Tracked so we can show a count and
  // clean up on reset.
  const observedIds = new Set();

  // IDs already sent/completed
  const sentIds = new Set();

  // Counts batches sent this scan, for hybrid sizing (small first, then ramp).
  let batchesSent = 0;

  // ─── FAB STATE ────────────────────────────────────────────────────────────────
  let fab = null;
  let fabCircle = null;
  let fabPanel = null;
  let fabHoverTimer = null;
  let fabCurrentState = 'idle'; // 'idle' | 'scanning' | 'done' | 'error'
  let fabStats = { totalScanned: 0, aiFound: 0, ambiguousFound: 0, model: '', backend: '', errors: [], startTime: null };

  // ─── DEBUG LOG STATE ────────────────────────────────────────────────────────
  const DEBUG_LOG_CAP = 500;
  const debugBuffer = [];        // ring buffer of { t, level, msg, data }
  let debugPanel = null;         // the log panel element (built lazily)
  let debugBody = null;          // scrollable rows container
  let debugPanelOpen = false;
  let debugSeq = 0;

  // ─── TEXT EXTRACTION ──────────────────────────────────────────────────────────

  // Use textContent (NOT innerText): innerText forces a synchronous reflow on
  // every call. textContent is layout-free. Block-level visibility is checked
  // separately, so the small quality cost (hidden inline text) is acceptable
  // for the large performance gain on big pages.
  function getTextContent(el) {
    const raw = el.textContent || '';
    return raw
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isCodeLike(text) {
    const codePatterns = [
      /\{[\s\S]*\}/,
      /function\s*\(/,
      /=>/,
      /<[a-z]+[^>]*>/,
      /import\s+\{/,
      /const\s+\w+\s*=/,
      /var\s+\w+\s*=/,
      /let\s+\w+\s*=/,
      /\(\)\s*=>/,
      /console\.\w+\(/,
      /\bclass\s+\w+/,
      /\bextends\s+\w+/,
      /\bawait\s+\w+/,
      /return\s+[{\[("'`]/,
      /\s{4,}[^\s]/,
    ];
    let count = 0;
    for (const p of codePatterns) {
      if (p.test(text)) count++;
      if (count >= 2) return true;
    }
    return false;
  }

  function hasEnoughWords(text) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    return words.length >= 12;
  }

  // Prefer the article body so we skip nav/header/footer/sidebar/comments — a
  // large reduction in paragraphs (and model calls) on real article pages.
  // Falls back to <body> for feeds (many <article>s) or non-article pages.
  function getScanRoot() {
    const main = document.querySelector('main, [role="main"]');
    if (main && (main.textContent || '').length > 500) return main;
    const articles = document.querySelectorAll('article');
    if (articles.length === 1 && (articles[0].textContent || '').length > 500) return articles[0];
    return document.body;
  }

  function hasBlockChildElement(node) {
    // Cheap O(direct children) leaf-block test — replaces an O(subtree)
    // querySelector. The TreeWalker still descends into containers, so inner
    // blocks are reached and registered; we just decline the container here.
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      if (BLOCK_TAGS.has(kids[i].tagName)) return true;
    }
    return false;
  }

  function extractParagraphs(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];
    const newIds = [];
    // Cache the cleaned text computed during filtering so the consume loop
    // doesn't recompute it (was computed twice per accepted node).
    const textCache = new Map();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const tag = node.tagName;

        // ── Cheapest checks first (string/Set lookups, no layout) ──────────
        // REJECT prunes the whole subtree (skips descendants too).
        if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        // Never scan our own injected overlay/tooltip DOM.
        if (typeof node.className === 'string' && node.className.indexOf('detectai-') !== -1) return NodeFilter.FILTER_REJECT;
        if (node.id && node.id.indexOf('detectai-') === 0) return NodeFilter.FILTER_REJECT;
        if (node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (node.dataset && node.dataset.detectaiId) return NodeFilter.FILTER_SKIP;
        if (!BLOCK_TAGS.has(tag)) return NodeFilter.FILTER_SKIP;

        // Prefer leaf-most blocks (cheap direct-children test).
        if (hasBlockChildElement(node)) return NodeFilter.FILTER_SKIP;

        // ── Text filters via textContent (no reflow) ───────────────────────
        // Long blocks are TRUNCATED for analysis, not skipped — silently
        // dropping >3500-char paragraphs was a false-negative hole (a long AI
        // essay block would never be scanned at all).
        const text = getTextContent(node);
        if (text.length < MIN_TEXT_LEN) return NodeFilter.FILTER_SKIP;
        if (!hasEnoughWords(text)) return NodeFilter.FILTER_SKIP;
        if (isCodeLike(text)) return NodeFilter.FILTER_SKIP;

        // ── Visibility check LAST: the one forced style read, now only on the
        //    handful of surviving leaf-block candidates instead of every node.
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }

        textCache.set(node, text.slice(0, MAX_TEXT_LEN));
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const id = PARA_PREFIX + (paragraphCounter++);
      node.dataset.detectaiId = id;
      registry.set(id, {
        element: node,
        text: textCache.get(node) || getTextContent(node).slice(0, MAX_TEXT_LEN),
        result: null,
        overlayActive: false,
        tooltipEl: null
      });
      newIds.push(id);
    }

    return newIds;
  }

  // ─── INTERSECTION OBSERVER ────────────────────────────────────────────────────

  // Fires as off-screen paragraphs approach the viewport during scrolling.
  // rootMargin gives a 300px head-start so highlights are usually ready by the
  // time the text is actually on screen.
  const visibilityObserver = new IntersectionObserver(
    function (entries) {
      let promoted = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.dataset && e.target.dataset.detectaiId;
        visibilityObserver.unobserve(e.target);
        if (id) observedIds.delete(id);
        if (id && !sentIds.has(id)) {
          scanQueue.push(id);
          promoted++;
        }
      }
      if (promoted > 0) {
        logDebug('info', `scrolled into view: promoting ${promoted} to scan`);
        scheduleDrain();
      }
    },
    { rootMargin: '300px', threshold: 0 }
  );

  // ─── QUEUE MANAGEMENT ─────────────────────────────────────────────────────────

  function scheduleIds(ids) {
    let queuedNow = 0;
    let deferred = 0;
    for (const id of ids) {
      if (sentIds.has(id) || observedIds.has(id)) continue;
      const entry = registry.get(id);
      if (!entry) continue;

      const rect = entry.element.getBoundingClientRect();
      const inView = rect.top < window.innerHeight + 300 && rect.bottom > -300;

      if (inView) {
        scanQueue.push(id);
        queuedNow++;
      } else {
        // Defer: scan it only when the user scrolls it near the viewport.
        observedIds.add(id);
        visibilityObserver.observe(entry.element);
        deferred++;
      }
    }
    if (queuedNow > 0 || deferred > 0) {
      logDebug('info', `queued ${queuedNow} visible, deferred ${deferred} off-screen`,
        { totalRegistry: registry.size });
    }
    if (queuedNow > 0) scheduleDrain();
  }

  function scheduleDrain() {
    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(drainQueues, DEBOUNCE_MS);
  }

  // Hybrid sizing: a tiny first batch makes the first outline appear ASAP, then
  // batches grow for throughput. (3 → 6 → BATCH_SIZE.)
  function nextBatchSize() {
    if (batchesSent === 0) return 3;
    if (batchesSent === 1) return 6;
    return BATCH_SIZE;
  }

  // Pull up to nextBatchSize() ready ids off the scan queue. Off-screen ids are
  // NOT here — they wait in the IntersectionObserver until scrolled near view.
  function takeBatch() {
    const batch = [];
    const cap = nextBatchSize();
    while (batch.length < cap && scanQueue.length > 0) {
      const id = scanQueue.shift();
      if (!sentIds.has(id) && registry.has(id)) {
        sentIds.add(id);
        batch.push(id);
      }
    }
    if (batch.length > 0) batchesSent++;
    return batch;
  }

  // Surface the backend's debug entries (timings, model, raw response) into the
  // on-page log panel.
  function ingestBackendDebug(response) {
    if (!debugEnabled() || !response || !Array.isArray(response.debug)) return;
    for (const e of response.debug) {
      if (e.phase === 'request') {
        logDebug('send', `→ ${e.backend}/${e.model} request (${(e.segmentIds || []).length} segs)`,
          { ids: e.segmentIds, promptChars: e.promptChars, sample: e.sample });
      } else if (e.phase === 'response') {
        logDebug('recv', `← response in ${e.ms}ms` +
          (e.evalCount ? ` (${e.evalCount} out / ${e.promptEvalCount} in tokens)` : ''),
          { verdicts: e.verdicts, rawSnippet: e.rawSnippet });
      } else if (e.phase === 'chunked') {
        logDebug('info', `chunked: ${e.total} segs → ${e.chunks} chunk(s) of ${e.chunkSize} (${e.insufficient} too short)`);
      } else if (e.phase === 'error') {
        logDebug('error', `backend error: ${e.error}`);
      }
    }
  }

  async function scanOneBatch(batch) {
    for (const id of batch) {
      const entry = registry.get(id);
      if (entry) entry.element.classList.add(SCAN_CLASS);
    }

    const paragraphs = batch.map(function (id) {
      return { id: id, text: registry.get(id).text };
    });

    logDebug('send', `sending batch of ${paragraphs.length}`,
      paragraphs.map((p) => ({ id: p.id, preview: p.text.slice(0, 100) })));

    const send = () => chrome.runtime.sendMessage({ type: 'SCAN_PARAGRAPHS', paragraphs });

    try {
      const response = await send();
      ingestBackendDebug(response);
      if (response && response.error) {
        logDebug('error', 'scan error', response.error);
        fabStats.errors.push(response.error);
        if (fab) applyFabState('error');
        for (const id of batch) {
          const entry = registry.get(id);
          if (entry) entry.element.classList.remove(SCAN_CLASS);
        }
        return;
      }
      if (response && response.results) {
        applyResults(response.results);
        logDebug('recv', `applied ${response.results.length} verdicts`,
          response.results.map((r) => ({ id: r.id, label: r.label, conf: +r.confidence.toFixed(2) })));
      }
    } catch (err) {
      // Service worker may be sleeping — retry once after a yield.
      logDebug('warn', 'request failed, retrying once', err.message);
      await yieldToMain();
      try {
        const response = await send();
        ingestBackendDebug(response);
        if (response && response.results) applyResults(response.results);
      } catch (retryErr) {
        for (const id of batch) {
          const entry = registry.get(id);
          if (entry) entry.element.classList.remove(SCAN_CLASS);
        }
        fabStats.errors.push(retryErr.message || 'Scan request failed');
        logDebug('error', 'scan failed after retry', retryErr.message);
        if (fab) applyFabState('error');
      }
    }
  }

  async function drainQueues() {
    if (isRunning || !settings || !settings.enabled) return;
    isRunning = true;

    // Transition FAB to scanning state on first drain with real work.
    // Recover from a prior 'error' too — later successful work should clear it.
    if (fab && scanQueue.length > 0) {
      if (fabCurrentState !== 'scanning') {
        if (!fabStats.startTime) fabStats.startTime = performance.now();
        applyFabState('scanning');
      }
    }

    // Anthropic round-trips are independent and network-bound — run a few in
    // parallel to cut wall-clock. A local Ollama model serializes generation
    // anyway, so keep it to one in-flight request.
    const concurrency = settings.apiBackend === 'ollama' ? 1 : 3;

    async function worker() {
      while (scanQueue.length > 0) {
        const batch = takeBatch();
        if (batch.length === 0) break;
        await scanOneBatch(batch);
        await yieldToMain();
      }
    }

    try {
      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);
    } finally {
      isRunning = false;
      // Done once the ready queue is drained. Off-screen items may still be
      // waiting in the observer — they'll flip us back to 'scanning' on scroll.
      if (fab && fabCurrentState === 'scanning' && scanQueue.length === 0) {
        if (fabStats.startTime) {
          fabStats.elapsed = Math.round((performance.now() - fabStats.startTime) / 1000);
        }
        applyFabState('done');
      }
    }
  }

  function yieldToMain() {
    if (typeof scheduler !== 'undefined' && scheduler.yield) {
      return scheduler.yield();
    }
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // ─── APPLY RESULTS ────────────────────────────────────────────────────────────

  function applyResults(results) {
    for (const result of results) {
      const entry = registry.get(result.id);
      if (!entry) continue;

      entry.result = result;
      const el = entry.element;
      el.classList.remove(SCAN_CLASS, AI_CLASS, AMB_CLASS);

      const threshold = (settings && settings.detectionThreshold != null)
        ? settings.detectionThreshold
        : 0.70;

      // `confidence` is uniformly P(AI) (0..1). The threshold is the single
      // control: outline red at/above it; orange in the ambiguous band below it
      // (opt-in). skip/insufficient never get an overlay.
      const pAI = result.confidence;
      const skip = result.label === 'skip' || result.label === 'insufficient';

      if (!skip && pAI >= threshold) {
        el.classList.add(AI_CLASS);
        entry.overlayActive = true;
        entry.displayKind = 'ai';
        el.dataset.detectaiConfidence = pAI.toFixed(2);
        el.dataset.detectaiLabel = 'ai';
        if (settings && settings.showReasoning) {
          setupTooltip(result.id, entry, result, 'ai');
        }
      } else if (!skip && settings && settings.highlightAmbiguous && pAI >= 0.5) {
        el.classList.add(AMB_CLASS);
        entry.overlayActive = true;
        entry.displayKind = 'ambiguous';
        el.dataset.detectaiConfidence = pAI.toFixed(2);
        el.dataset.detectaiLabel = 'ambiguous';
        if (settings && settings.showReasoning) {
          setupTooltip(result.id, entry, result, 'ambiguous');
        }
      } else {
        entry.overlayActive = false;
        entry.displayKind = null;
        delete el.dataset.detectaiConfidence;
        delete el.dataset.detectaiLabel;
      }
    }
  }

  // Derive FAB counts from the registry. Computed on demand (never incremented)
  // so re-applying results on a settings change can't inflate the totals.
  function recomputeFabCounts() {
    let total = 0, ai = 0, amb = 0;
    for (const [, entry] of registry) {
      const r = entry.result;
      if (!r || r.label === 'skip' || r.label === 'insufficient') continue;
      total++;
      // Count what is actually outlined on the page (displayKind reflects the
      // current threshold + highlightAmbiguous settings).
      if (entry.overlayActive && entry.displayKind === 'ai') ai++;
      else if (entry.overlayActive && entry.displayKind === 'ambiguous') amb++;
    }
    fabStats.totalScanned = total;
    fabStats.aiFound = ai;
    fabStats.ambiguousFound = amb;
  }

  // ─── TOOLTIP SYSTEM ───────────────────────────────────────────────────────────

  // Single shared scroll handler hides whichever tooltip is currently visible —
  // avoids attaching one window scroll listener per tooltip (memory leak).
  let visibleTooltip = null;
  let sharedScrollBound = false;

  function bindSharedScrollHide() {
    if (sharedScrollBound) return;
    sharedScrollBound = true;
    window.addEventListener('scroll', function () {
      if (visibleTooltip) {
        visibleTooltip.classList.remove(TOOLTIP_VIS);
        visibleTooltip = null;
      }
    }, { passive: true });
  }

  function setupTooltip(id, entry, result, kind) {
    // Tear down any previous tooltip + its listeners for this entry first.
    teardownTooltip(entry);

    const tooltip = document.createElement('div');
    tooltip.className = TOOLTIP_CLASS;
    tooltip.innerHTML = buildTooltipHTML(result, kind);
    document.body.appendChild(tooltip);
    entry.tooltipEl = tooltip;

    const el = entry.element;

    function showTooltip() {
      positionTooltip(tooltip, el);
      tooltip.classList.add(TOOLTIP_VIS);
      visibleTooltip = tooltip;
    }

    function hideTooltip() {
      tooltip.classList.remove(TOOLTIP_VIS);
      if (visibleTooltip === tooltip) visibleTooltip = null;
    }

    el.addEventListener('mouseenter', showTooltip);
    el.addEventListener('mouseleave', hideTooltip);
    bindSharedScrollHide();

    // Cleanup closure removes the per-element listeners and DOM node.
    entry.tooltipCleanup = function () {
      el.removeEventListener('mouseenter', showTooltip);
      el.removeEventListener('mouseleave', hideTooltip);
      if (visibleTooltip === tooltip) visibleTooltip = null;
      if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
      entry.tooltipEl = null;
      entry.tooltipCleanup = null;
    };
  }

  function teardownTooltip(entry) {
    if (entry.tooltipCleanup) {
      entry.tooltipCleanup();
    } else if (entry.tooltipEl && entry.tooltipEl.parentNode) {
      entry.tooltipEl.parentNode.removeChild(entry.tooltipEl);
      entry.tooltipEl = null;
    }
  }

  function buildTooltipHTML(result, kind) {
    // confidence is P(AI); show it as the AI-likelihood percentage.
    const pct = Math.round(result.confidence * 100);
    const signalsHtml = (result.signals || [])
      .map(function (s) {
        return '<span class="detectai-signal-tag">' + escHtml(s.replace(/_/g, ' ')) + '</span>';
      })
      .join('');

    const isAi = kind !== 'ambiguous';
    const labelColor = isAi ? '#dc2626' : '#f97316';
    const labelText = isAi ? 'AI DETECTED' : 'AMBIGUOUS';
    const badgeClass = isAi ? 'detectai-badge-ai' : 'detectai-badge-ambiguous';

    return (
      '<div class="detectai-tooltip-header">' +
        '<span class="' + badgeClass + '">' + labelText + '</span>' +
        '<span style="color:#94a3b8;font-size:12px;margin-left:auto;">' + pct + '% AI-likelihood</span>' +
      '</div>' +
      '<div class="detectai-confidence-bar">' +
        '<div class="detectai-confidence-fill" style="width:' + pct + '%;background:' + labelColor + '"></div>' +
      '</div>' +
      (result.reasoning
        ? '<div class="detectai-reasoning">' + escHtml(result.reasoning) + '</div>'
        : '') +
      (signalsHtml ? '<div class="detectai-signals">' + signalsHtml + '</div>' : '')
    );
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── FLOATING STATUS BADGE ───────────────────────────────────────────────────

  const FAB_CSS = [
    // Container — pointer-events auto but transparent bg so page clicks reach the page outside the badge
    '#detectai-fab{position:fixed;bottom:20px;left:20px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',

    // Circle
    '#detectai-fab-circle{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:default;user-select:none;transition:transform .18s ease,box-shadow .18s ease,background .3s ease,border-color .3s ease;flex-shrink:0;box-shadow:0 2px 10px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);}',
    '#detectai-fab-circle:hover{transform:scale(1.08);}',

    // State colours
    '.dfab-idle    {background:#1e293b;border:2px solid rgba(255,255,255,.12);}',
    '.dfab-scanning{background:#1e2a40;border:2px solid rgba(96,165,250,.55);animation:dfab-pulse 2s ease-in-out infinite;}',
    '.dfab-done    {background:#15803d;border:2px solid rgba(255,255,255,.2);}',
    '.dfab-error   {background:#b91c1c;border:2px solid rgba(255,255,255,.2);}',

    // Spinner SVG rotation
    '.dfab-spin{animation:dfab-rotate .75s linear infinite;display:block;transform-origin:center;}',

    '@keyframes dfab-rotate{to{transform:rotate(360deg);}}',
    '@keyframes dfab-pulse{0%,100%{box-shadow:0 2px 10px rgba(0,0,0,.45),0 0 0 0 rgba(96,165,250,0);}50%{box-shadow:0 2px 10px rgba(0,0,0,.45),0 0 0 7px rgba(96,165,250,.15);}}',

    // Info panel — non-interactive (pointer-events:none), slides up from below circle
    '#detectai-fab-panel{pointer-events:none;background:#141927;border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:12px 14px;min-width:210px;max-width:250px;opacity:0;transform:translateY(6px) scale(.97);transition:opacity .2s ease,transform .2s ease;box-shadow:0 6px 24px rgba(0,0,0,.55);color:#e2e8f0;line-height:1.5;order:-1;}',
    '#detectai-fab-panel.dfab-panel-open{opacity:1;transform:translateY(0) scale(1);}',

    // Panel internals
    '.dfp-hd{display:flex;align-items:center;gap:7px;margin-bottom:9px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.07);}',
    '.dfp-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}',
    '.dfp-dot-idle    {background:#475569;}',
    '.dfp-dot-scanning{background:#60a5fa;animation:dfab-blink 1.1s ease-in-out infinite;}',
    '.dfp-dot-done    {background:#4ade80;}',
    '.dfp-dot-error   {background:#f87171;}',
    '@keyframes dfab-blink{0%,100%{opacity:1;}50%{opacity:.3;}}',
    '.dfp-title{font-size:12px;font-weight:600;color:#f1f5f9;}',
    '.dfp-row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 0;}',
    '.dfp-lbl{font-size:11px;color:#475569;white-space:nowrap;}',
    '.dfp-val{font-size:11px;color:#94a3b8;font-weight:500;text-align:right;}',
    '.dfp-val-ai   {color:#f87171;}',
    '.dfp-val-amb  {color:#fb923c;}',
    '.dfp-val-clean{color:#4ade80;}',
    '.dfp-val-mono {font-family:"SF Mono","Fira Code",monospace;font-size:10px;word-break:break-all;text-align:right;}',
    '.dfp-err{margin-top:8px;padding-top:8px;border-top:1px solid rgba(220,38,38,.25);font-size:11px;color:#f87171;line-height:1.4;}',

    // Debug log panel — interactive (scroll + buttons), sits above the circle.
    '#detectai-debug-panel{display:none;flex-direction:column;order:-1;width:460px;max-width:80vw;height:340px;max-height:60vh;background:#0b0e16;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden;}',
    '#detectai-debug-panel.ddl-open{display:flex;}',
    '.ddl-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08);background:#111726;}',
    '.ddl-title{font-size:12px;font-weight:600;color:#e2e8f0;}',
    '.ddl-actions{display:flex;gap:6px;}',
    '.ddl-btn{background:#1e293b;border:1px solid rgba(255,255,255,.12);color:#94a3b8;font-size:11px;padding:3px 8px;border-radius:5px;cursor:pointer;font-family:inherit;}',
    '.ddl-btn:hover{background:#273345;color:#e2e8f0;}',
    '.ddl-body{flex:1;overflow-y:auto;padding:6px 8px;font-family:"SF Mono","Fira Code",Menlo,monospace;font-size:10.5px;line-height:1.45;}',
    '.ddl-row{display:flex;gap:7px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.03);align-items:baseline;}',
    '.ddl-t{color:#475569;flex-shrink:0;}',
    '.ddl-msg{color:#cbd5e1;flex-shrink:0;font-weight:600;}',
    '.ddl-data{color:#64748b;word-break:break-word;overflow-wrap:anywhere;}',
    '.ddl-info .ddl-msg{color:#cbd5e1;}',
    '.ddl-send .ddl-msg{color:#93c5fd;}',
    '.ddl-recv .ddl-msg{color:#86efac;}',
    '.ddl-warn .ddl-msg{color:#fde047;}',
    '.ddl-error .ddl-msg{color:#fca5a5;}',
  ].join('');

  const FAB_ICONS = {
    idle: '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><text x="1" y="11" font-family="monospace" font-size="9.5" font-weight="700" fill="#475569">AI</text></svg>',
    scanning: '<svg class="dfab-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.15)" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" stroke="#93c5fd" stroke-width="2" stroke-linecap="round"/></svg>',
    done: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 8.5l3 3 7-7" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  function createFab() {
    if (fab || document.getElementById('detectai-fab')) return;

    // Inject FAB styles once
    if (!document.getElementById('detectai-fab-style')) {
      const st = document.createElement('style');
      st.id = 'detectai-fab-style';
      st.textContent = FAB_CSS;
      (document.head || document.documentElement).appendChild(st);
    }

    fab = document.createElement('div');
    fab.id = 'detectai-fab';

    // Panel sits ABOVE the circle (flex-direction:column, order:-1 on panel)
    fabPanel = document.createElement('div');
    fabPanel.id = 'detectai-fab-panel';

    fabCircle = document.createElement('div');
    fabCircle.id = 'detectai-fab-circle';
    applyFabState('idle');

    fab.appendChild(fabPanel);
    fab.appendChild(fabCircle);
    document.documentElement.appendChild(fab);

    // 3-second hover delay → expand info panel (skipped while the debug log is open)
    fab.addEventListener('mouseenter', function () {
      if (debugPanelOpen) return;
      clearTimeout(fabHoverTimer);
      fabHoverTimer = setTimeout(openFabPanel, 3000);
    });

    fab.addEventListener('mouseleave', function () {
      clearTimeout(fabHoverTimer);
      closeFabPanel();
    });

    // Click the circle to toggle the debug log panel (only meaningful in debug mode).
    fabCircle.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!debugEnabled()) return;
      clearTimeout(fabHoverTimer);
      closeFabPanel();        // hide the hover info panel if showing
      toggleDebugPanel();
    });
  }

  function applyFabState(state) {
    fabCurrentState = state;
    if (!fabCircle) return;
    fabCircle.className = 'dfab-' + state;
    fabCircle.innerHTML = FAB_ICONS[state] || FAB_ICONS.idle;
  }

  function openFabPanel() {
    if (!fabPanel) return;
    renderFabPanel();
    fabPanel.classList.add('dfab-panel-open');
  }

  function closeFabPanel() {
    if (!fabPanel) return;
    fabPanel.classList.remove('dfab-panel-open');
  }

  function renderFabPanel() {
    if (!fabPanel) return;
    recomputeFabCounts();
    const s = fabStats;
    const st = fabCurrentState;
    const aiPct = s.totalScanned > 0 ? Math.round((s.aiFound / s.totalScanned) * 100) : 0;
    // Use the elapsed value frozen at scan completion (computed with
    // performance.now() in drainQueues). Never mix performance.now() with
    // Date.now() — they use different epochs.
    const elapsed = (typeof s.elapsed === 'number') ? s.elapsed : null;

    const stateLabels = { idle: 'DetectAI', scanning: 'Scanning…', done: 'Scan complete', error: 'Error' };

    let h = '<div class="dfp-hd">' +
      '<span class="dfp-dot dfp-dot-' + st + '"></span>' +
      '<span class="dfp-title">' + (stateLabels[st] || 'DetectAI') + '</span>' +
      '</div>';

    if (s.totalScanned > 0) {
      h += row('Analyzed', s.totalScanned + ' segments');
    }

    if (s.totalScanned > 0) {
      if (s.aiFound > 0) {
        h += row('AI detected', s.aiFound + ' (' + aiPct + '%)', 'dfp-val-ai');
      } else if (st === 'done') {
        h += row('AI detected', 'none', 'dfp-val-clean');
      }
    }

    if (s.ambiguousFound > 0) {
      h += row('Ambiguous', s.ambiguousFound + '', 'dfp-val-amb');
    }

    // Off-screen content waiting to be scanned as the user scrolls (lazy mode).
    const pending = observedIds.size + scanQueue.length;
    if (pending > 0) {
      h += row('Pending', pending + ' (scroll to scan)');
    }

    if (s.model) {
      h += row('Model', escHtml(s.model), 'dfp-val-mono');
    }

    if (s.backend) {
      h += row('Backend', escHtml(s.backend), 'dfp-val-mono');
    }

    if (elapsed !== null && st === 'done') {
      h += row('Duration', elapsed + 's');
    }

    if (s.errors.length > 0) {
      h += '<div class="dfp-err">⚠ ' + escHtml(s.errors[s.errors.length - 1]) + '</div>';
    }

    fabPanel.innerHTML = h;
  }

  function row(label, value, valClass) {
    return '<div class="dfp-row">' +
      '<span class="dfp-lbl">' + label + '</span>' +
      '<span class="dfp-val' + (valClass ? ' ' + valClass : '') + '">' + value + '</span>' +
      '</div>';
  }

  function emptyFabStats() {
    return {
      totalScanned: 0,
      aiFound: 0,
      ambiguousFound: 0,
      model: '',
      backend: '',
      errors: [],
      startTime: null,
      elapsed: null,
    };
  }

  function resetFabStats() {
    fabStats = emptyFabStats();
    if (settings) {
      fabStats.backend = settings.apiBackend || 'anthropic';
      fabStats.model = settings.apiBackend === 'ollama'
        ? (settings.ollamaModel || 'qwen2.5:7b')
        : 'claude-sonnet-4-6';
    }
  }

  function fabResetForNavigation() {
    clearTimeout(fabHoverTimer);
    closeFabPanel();
    applyFabState('idle');
    resetFabStats();
  }

  // ─── DEBUG LOG ─────────────────────────────────────────────────────────────────

  function debugEnabled() {
    return !!(settings && settings.debug);
  }

  // Record a structured log entry. Cheap no-op unless debug mode is on.
  function logDebug(level, msg, data) {
    if (!debugEnabled()) return;
    const entry = { seq: ++debugSeq, t: Date.now(), level: level || 'info', msg: String(msg), data };
    debugBuffer.push(entry);
    if (debugBuffer.length > DEBUG_LOG_CAP) debugBuffer.shift();
    if (debugPanelOpen && debugBody) appendDebugRow(entry);
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function appendDebugRow(entry) {
    if (!debugBody) return;
    const row = document.createElement('div');
    row.className = 'ddl-row ddl-' + entry.level;
    let html = '<span class="ddl-t">' + fmtClock(entry.t) + '</span>' +
               '<span class="ddl-msg">' + escHtml(entry.msg) + '</span>';
    if (entry.data !== undefined) {
      let dataStr;
      try { dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data); }
      catch { dataStr = '[unserializable]'; }
      if (dataStr && dataStr !== '{}' && dataStr !== 'null') {
        html += '<span class="ddl-data">' + escHtml(dataStr) + '</span>';
      }
    }
    row.innerHTML = html;
    debugBody.appendChild(row);
    // Auto-scroll to newest
    debugBody.scrollTop = debugBody.scrollHeight;
  }

  function buildDebugPanel() {
    if (debugPanel) return;
    debugPanel = document.createElement('div');
    debugPanel.id = 'detectai-debug-panel';

    const head = document.createElement('div');
    head.className = 'ddl-head';
    head.innerHTML =
      '<span class="ddl-title">DetectAI · Debug Log</span>' +
      '<span class="ddl-actions">' +
        '<button type="button" class="ddl-btn" id="ddl-copy">Copy</button>' +
        '<button type="button" class="ddl-btn" id="ddl-clear">Clear</button>' +
        '<button type="button" class="ddl-btn" id="ddl-close">✕</button>' +
      '</span>';

    debugBody = document.createElement('div');
    debugBody.className = 'ddl-body';

    debugPanel.appendChild(head);
    debugPanel.appendChild(debugBody);
    fab.appendChild(debugPanel);

    head.querySelector('#ddl-clear').addEventListener('click', function (e) {
      e.stopPropagation();
      debugBuffer.length = 0;
      debugBody.innerHTML = '';
    });
    head.querySelector('#ddl-copy').addEventListener('click', function (e) {
      e.stopPropagation();
      const text = debugBuffer.map(function (en) {
        let d = '';
        try { d = en.data === undefined ? '' : (typeof en.data === 'string' ? en.data : JSON.stringify(en.data)); } catch {}
        return fmtClock(en.t) + ' [' + en.level + '] ' + en.msg + (d ? ' ' + d : '');
      }).join('\n');
      try { navigator.clipboard.writeText(text); } catch {}
      const btn = e.target; const old = btn.textContent;
      btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1200);
    });
    head.querySelector('#ddl-close').addEventListener('click', function (e) {
      e.stopPropagation();
      closeDebugPanel();
    });
  }

  function renderDebugPanel() {
    buildDebugPanel();
    debugBody.innerHTML = '';
    for (const entry of debugBuffer) appendDebugRow(entry);
  }

  function openDebugPanel() {
    buildDebugPanel();
    renderDebugPanel();
    debugPanel.classList.add('ddl-open');
    debugPanelOpen = true;
  }

  function closeDebugPanel() {
    if (debugPanel) debugPanel.classList.remove('ddl-open');
    debugPanelOpen = false;
  }

  function toggleDebugPanel() {
    if (debugPanelOpen) closeDebugPanel();
    else openDebugPanel();
  }

  // ─── END FAB ─────────────────────────────────────────────────────────────────

  function positionTooltip(tooltip, anchor) {
    // The tooltip is `position: fixed` (overlay.css), so coordinates are
    // viewport-relative — use getBoundingClientRect() values directly and do
    // NOT add scrollX/scrollY (that would offset it off-screen when scrolled).
    // The tooltip is already in the DOM at opacity:0, so it has measurable
    // dimensions without a visibility toggle (no layout thrash).
    const rect = anchor.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    const tooltipWidth = Math.max(tRect.width, 320);
    const tooltipHeight = tRect.height;

    let top = rect.bottom + 8;
    let left = rect.left;

    // Flip above if too close to viewport bottom
    if (rect.bottom + tooltipHeight + 8 > window.innerHeight - 20) {
      top = rect.top - tooltipHeight - 8;
    }
    // Clamp vertically so it never spills off the top either.
    if (top < 10) top = 10;

    // Keep within horizontal bounds
    if (left + tooltipWidth > window.innerWidth - 20) {
      left = window.innerWidth - tooltipWidth - 20;
    }
    if (left < 10) left = 10;

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  // ─── CLEAR OVERLAYS ───────────────────────────────────────────────────────────

  function clearAllOverlays() {
    for (const [id, entry] of registry) {
      entry.element.classList.remove(AI_CLASS, AMB_CLASS, SCAN_CLASS);
      entry.overlayActive = false;
      entry.result = null;

      delete entry.element.dataset.detectaiConfidence;
      delete entry.element.dataset.detectaiLabel;

      teardownTooltip(entry);
    }
  }

  function clearRegistryAndState() {
    // Remove the id marker from every element so reused DOM nodes (common in
    // SPAs) can be re-discovered on the next scan instead of being skipped.
    for (const [, entry] of registry) {
      if (entry.element && entry.element.dataset) {
        delete entry.element.dataset.detectaiId;
      }
    }
    clearAllOverlays();
    // Stop watching all off-screen elements so stale intersections can't fire
    // after the registry is wiped.
    visibilityObserver.disconnect();
    observedIds.clear();
    registry.clear();
    sentIds.clear();
    scanQueue.length = 0;
    paragraphCounter = 0;
    batchesSent = 0;
  }

  // ─── MUTATION OBSERVER ────────────────────────────────────────────────────────

  // Accumulate added element nodes across bursts (don't drop earlier ones), and
  // flush on a trailing debounce with a hard max-wait so continuous DOM churn
  // (ads, animations) can never starve extraction indefinitely.
  const MUTATION_MAX_WAIT = 1500;
  let pendingAddedNodes = [];
  let pendingSince = 0;

  function flushPendingMutations() {
    clearTimeout(mutationDebounce);
    mutationDebounce = null;
    pendingSince = 0;
    const nodes = pendingAddedNodes;
    pendingAddedNodes = [];
    if (!settings || !settings.enabled) return;

    const allAdded = [];
    for (const node of nodes) {
      if (!node.isConnected) continue; // node was removed again before flush
      const ids = extractParagraphs(node);
      for (const id of ids) allAdded.push(id);
    }
    if (allAdded.length > 0) scheduleIds(allAdded);
  }

  const mutationObserver = new MutationObserver(function (mutations) {
    if (!settings || !settings.enabled) return;

    let added = false;
    for (const m of mutations) {
      if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Ignore our own injected overlay/tooltip nodes (avoid self-trigger loop).
        if (typeof node.className === 'string' && node.className.indexOf('detectai-') !== -1) continue;
        if (node.id && node.id.indexOf('detectai-') === 0) continue;
        pendingAddedNodes.push(node);
        added = true;
      }
    }
    if (!added) return;

    const now = performance.now();
    if (!pendingSince) pendingSince = now;

    // Hard max-wait: if we've been accumulating too long, flush now.
    if (now - pendingSince >= MUTATION_MAX_WAIT) {
      flushPendingMutations();
      return;
    }
    clearTimeout(mutationDebounce);
    mutationDebounce = setTimeout(flushPendingMutations, DEBOUNCE_MS);
  });

  // ─── SPA NAVIGATION ───────────────────────────────────────────────────────────

  function handleNavigation() {
    // Stop current scan
    isRunning = false;
    clearTimeout(scanDebounceTimer);
    clearTimeout(mutationDebounce);
    clearTimeout(interactionRescanTimer);

    logDebug('info', 'SPA navigation — re-scanning', { url: location.href });
    clearRegistryAndState();
    fabResetForNavigation();

    setTimeout(function () {
      if (!settings || !settings.enabled) return;
      const ids = extractParagraphs(getScanRoot());
      scheduleIds(ids);
    }, 350);
  }

  // Patch history API for SPA navigation detection
  (function patchHistory() {
    const originalPush = history.pushState.bind(history);
    history.pushState = function () {
      originalPush.apply(this, arguments);
      handleNavigation();
    };

    const originalReplace = history.replaceState.bind(history);
    history.replaceState = function () {
      originalReplace.apply(this, arguments);
      handleNavigation();
    };
  })();

  window.addEventListener('popstate', handleNavigation);

  // ─── INTERACTION-DRIVEN RE-SCAN ───────────────────────────────────────────────
  // Clicks and key presses often reveal content that the MutationObserver can't
  // see: accordions/tabs/"show more" that toggle CSS visibility (no DOM nodes
  // added), or lazy widgets that swap text in place. After such an interaction
  // we re-walk the document — extractParagraphs only returns NEW or now-visible
  // blocks (already-registered nodes are skipped), so this is idempotent.

  function rescanForNewContent() {
    if (!settings || !settings.enabled) return;
    const ids = extractParagraphs(getScanRoot());
    if (ids.length > 0) scheduleIds(ids);
  }

  function scheduleInteractionRescan() {
    if (!settings || !settings.enabled) return;
    clearTimeout(interactionRescanTimer);
    interactionRescanTimer = setTimeout(rescanForNewContent, INTERACTION_RESCAN_DELAY);
  }

  function onUserKey(e) {
    // Ignore bare modifier keys — they never reveal content on their own.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    scheduleInteractionRescan();
  }

  // Capture phase + passive so we observe every interaction without interfering
  // with the page's own handlers (and even if they call stopPropagation).
  let interactionListenersBound = false;
  let observerStarted = false;

  function registerInteractionListeners() {
    if (interactionListenersBound) return;
    interactionListenersBound = true;
    document.addEventListener('click', scheduleInteractionRescan, { capture: true, passive: true });
    document.addEventListener('keydown', onUserKey, { capture: true, passive: true });
  }

  // Start watching the page for dynamic content (idempotent — safe to call again
  // when the extension is re-enabled after being turned off).
  function startObservation() {
    if (!observerStarted) {
      observerStarted = true;
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
    registerInteractionListeners();
  }

  // ─── BACKGROUND MESSAGES ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'PARTIAL_RESULTS') {
      // Streamed/cached verdicts arriving mid-batch — paint each immediately.
      if (Array.isArray(msg.results) && msg.results.length) {
        applyResults(msg.results);
        logDebug('recv', `streamed ${msg.results.length} verdict(s)`,
          msg.results.map((r) => ({ id: r.id, label: r.label })));
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'SETTINGS_CHANGED') {
      const oldEnabled = settings && settings.enabled;
      settings = msg.settings;
      // Keep the FAB's model/backend labels in sync with the new settings.
      fabStats.backend = settings.apiBackend || fabStats.backend;
      fabStats.model = settings.apiBackend === 'ollama'
        ? (settings.ollamaModel || 'qwen2.5:7b')
        : 'claude-sonnet-4-6';
      updateFabDebugAffordance();
      logDebug('info', 'settings changed', {
        backend: settings.apiBackend, model: fabStats.model,
        threshold: settings.detectionThreshold, debug: settings.debug, enabled: settings.enabled,
      });

      if (!settings.enabled && oldEnabled) {
        // Extension was disabled — clear everything
        isRunning = false;
        clearTimeout(scanDebounceTimer);
        clearRegistryAndState();
        fabResetForNavigation();
      } else if (settings.enabled && !oldEnabled) {
        // Extension was re-enabled — scan current page and (re)start watching.
        const ids = extractParagraphs(getScanRoot());
        scheduleIds(ids);
        startObservation();
      } else if (settings.enabled) {
        // Re-apply thresholds/overlays to existing results (no re-scan, no
        // double-counting — counts are derived from the registry on render).
        for (const [id, entry] of registry) {
          if (entry.result) {
            applyResults([entry.result]);
          }
        }
        if (fabCurrentState === 'done') renderFabPanel();
      }
      sendResponse({ ok: true });
      return true;

    } else if (msg.type === 'CLEAR_OVERLAYS') {
      isRunning = false;
      clearTimeout(scanDebounceTimer);
      clearRegistryAndState();
      fabResetForNavigation();
      sendResponse({ ok: true });
      return true;

    } else if (msg.type === 'RESCAN') {
      isRunning = false;
      clearTimeout(scanDebounceTimer);
      clearRegistryAndState();
      resetFabStats();
      applyFabState('idle');
      logDebug('info', 'manual rescan requested');

      if (settings && settings.enabled) {
        const ids = extractParagraphs(getScanRoot());
        scheduleIds(ids);
        // Manual scan also wires the observers — needed when auto-scan is off
        // and init() skipped them.
        startObservation();
      }
      sendResponse({ ok: true });
      return true;

    } else if (msg.type === 'GET_STATUS') {
      const total = registry.size;
      let aiCount = 0;
      let scanning = 0;

      for (const [id, entry] of registry) {
        if (entry.overlayActive) aiCount++;
        if (entry.element.classList.contains(SCAN_CLASS)) scanning++;
      }

      const status = scanning > 0
        ? 'scanning'
        : (isRunning ? 'scanning' : 'done');

      sendResponse({
        status: status,
        count: total,
        aiCount: aiCount,
        scanning: scanning
      });
      return true;
    }
  });

  // ─── INITIALIZATION ───────────────────────────────────────────────────────────

  async function init() {
    try {
      settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    } catch (err) {
      // Extension context may not be ready yet, or settings failed
      settings = { enabled: false };
      return;
    }

    if (!settings) {
      settings = { enabled: false };
      return;
    }

    createFab();
    resetFabStats();
    updateFabDebugAffordance();

    logDebug('info', 'DetectAI initialized', {
      backend: settings.apiBackend,
      model: settings.apiBackend === 'ollama' ? settings.ollamaModel : 'claude-sonnet-4-6',
      threshold: settings.detectionThreshold,
      enabled: settings.enabled,
      url: location.href,
    });

    if (!settings.enabled) {
      applyFabState('idle');
      return;
    }

    // Warm the local model immediately (while the user is still reading) so the
    // first batch isn't blocked on the cold load.
    if (settings.apiBackend === 'ollama') {
      chrome.runtime.sendMessage({ type: 'PRELOAD' }).catch(() => {});
      logDebug('info', 'preloading Ollama model…');
    }

    // Honor "Auto-scan on page load": when off, stay idle until the user clicks
    // "Scan Now" in the popup (the RESCAN handler starts everything).
    if (settings.autoScan === false) {
      logDebug('info', 'auto-scan disabled — waiting for manual scan');
      applyFabState('idle');
      return;
    }

    const ids = extractParagraphs(getScanRoot());
    logDebug('info', `initial extraction: ${ids.length} candidate paragraphs`);
    scheduleIds(ids);

    // Watch for dynamic content + re-scan on user interaction (clicks/keys).
    startObservation();
  }

  // Show a pointer cursor + tooltip on the badge when debug mode is available,
  // so the click-to-open-log affordance is discoverable.
  function updateFabDebugAffordance() {
    if (!fabCircle) return;
    if (debugEnabled()) {
      fabCircle.style.cursor = 'pointer';
      fabCircle.title = 'Click for debug log';
    } else {
      fabCircle.style.cursor = 'default';
      fabCircle.title = '';
      closeDebugPanel();
    }
  }

  // ─── ENTRY POINT ─────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
