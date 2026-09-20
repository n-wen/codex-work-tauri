// Injected into the Preview window: top chrome (URL + nav) + element picker.
// Talks back via navigation intercept (cw-preview://).
(function () {
  if (window.__cwPickerInstalled) {
    if (window.__cwPicker && window.__cwPicker.ensureMounted) {
      window.__cwPicker.ensureMounted();
    }
    return;
  }
  window.__cwPickerInstalled = true;

  var STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'padding', 'margin',
    'fontSize', 'fontWeight', 'color', 'backgroundColor',
    'borderRadius', 'border', 'gap', 'flexDirection', 'alignItems',
    'justifyContent', 'opacity', 'overflow', 'zIndex'
  ];

  var active = false;
  var overlay = null;
  var labelEl = null;
  var pendingData = null;
  var bottomBar = null;
  var chromeBar = null;
  var rafPending = false;

  var BTN = 'padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font:500 12px/1 system-ui,sans-serif;flex-shrink:0;';
  var ICON_BTN = 'width:30px;height:30px;padding:0;border:none;border-radius:6px;cursor:pointer;' +
    'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
    'background:#313244;color:#cdd6f4;';

  // Host must resist page-wide rules like `div { min-height: 100vh }`.
  var HOST_TOP =
    'all:initial;position:fixed!important;top:0!important;left:0!important;right:0!important;' +
    'width:100%!important;height:48px!important;min-height:0!important;max-height:48px!important;' +
    'margin:0!important;padding:0!important;border:none!important;overflow:hidden!important;' +
    'z-index:2147483646!important;box-sizing:border-box!important;display:block!important;' +
    'pointer-events:auto!important;transform:none!important;inset:0 0 auto 0!important;';
  var HOST_BOTTOM =
    'all:initial;position:fixed!important;bottom:0!important;left:0!important;right:0!important;' +
    'width:100%!important;height:44px!important;min-height:0!important;max-height:44px!important;' +
    'margin:0!important;padding:0!important;border:none!important;overflow:hidden!important;' +
    'z-index:2147483646!important;box-sizing:border-box!important;display:block!important;' +
    'pointer-events:auto!important;transform:none!important;';

  var ICON_BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>';
  var ICON_FWD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  var ICON_RELOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';

  function normalizeUrl(raw) {
    var t = (raw || '').trim();
    if (!t) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return t;
    var host = t.split('/')[0].split(':')[0].toLowerCase();
    var loopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    return (loopback ? 'http' : 'https') + '://' + t;
  }

  function clearLayoutPollution() {
    try {
      if (document.body) {
        document.body.style.paddingTop = '';
        document.body.style.paddingBottom = '';
        document.body.style.marginTop = '';
      }
      if (document.documentElement) {
        document.documentElement.style.paddingTop = '';
      }
    } catch (_) {}
  }

  function ensureRoot() {
    if (!document.documentElement) return null;
    if (!document.body) {
      document.documentElement.appendChild(document.createElement('body'));
    }
    return document.documentElement;
  }

  function createChrome() {
    if (document.getElementById('__cw_chrome_host')) {
      chromeBar = document.getElementById('__cw_chrome_host');
      var shadow = chromeBar.shadowRoot;
      var input = shadow && shadow.getElementById('__cw_url');
      if (input && document.activeElement !== input) input.value = location.href;
      return;
    }
    var root = ensureRoot();
    if (!root) return;

    var host = document.createElement('div');
    host.id = '__cw_chrome_host';
    host.setAttribute('data-cw-ui', '1');
    host.style.cssText = HOST_TOP;
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
        ':host{all:initial;display:block;}' +
        '*{box-sizing:border-box;}' +
        '#bar{height:48px;display:flex;align-items:center;gap:6px;padding:0 10px;' +
          'background:#1e1e2e;border-bottom:1px solid #45475a;' +
          'font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#cdd6f4;}' +
        'button{width:30px;height:30px;padding:0;border:none;border-radius:6px;cursor:pointer;' +
          'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
          'background:#313244;color:#cdd6f4;}' +
        'button:hover{background:#45475a;}' +
        'form{flex:1;min-width:0;margin:0;display:flex;}' +
        'input{flex:1;min-width:0;height:30px;border:1px solid #45475a;border-radius:8px;' +
          'background:#11111b;color:#cdd6f4;padding:0 12px;outline:none;' +
          'font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;}' +
        'input:focus{border-color:#3b82f6;}' +
      '</style>' +
      '<div id="bar">' +
        '<button id="__cw_back" title="后退" type="button">' + ICON_BACK + '</button>' +
        '<button id="__cw_fwd" title="前进" type="button">' + ICON_FWD + '</button>' +
        '<button id="__cw_reload" title="刷新" type="button">' + ICON_RELOAD + '</button>' +
        '<form id="__cw_url_form"><input id="__cw_url" type="text" spellcheck="false" autocomplete="off" /></form>' +
      '</div>';

    root.appendChild(host);
    chromeBar = host;

    var input = shadow.getElementById('__cw_url');
    input.value = location.href;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.stopPropagation();
      }
    });

    shadow.getElementById('__cw_back').onclick = function () { history.back(); };
    shadow.getElementById('__cw_fwd').onclick = function () { history.forward(); };
    shadow.getElementById('__cw_reload').onclick = function () { location.reload(); };
    shadow.getElementById('__cw_url_form').onsubmit = function (e) {
      e.preventDefault();
      var next = normalizeUrl(input.value);
      if (!next) return;
      location.href = next;
    };
  }

  function createBottomBar() {
    if (document.getElementById('__cw_toolbar_host')) {
      bottomBar = document.getElementById('__cw_toolbar_host');
      return;
    }
    var root = ensureRoot();
    if (!root) return;

    var host = document.createElement('div');
    host.id = '__cw_toolbar_host';
    host.setAttribute('data-cw-ui', '1');
    host.style.cssText = HOST_BOTTOM;
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
        ':host{all:initial;display:block;}' +
        '*{box-sizing:border-box;}' +
        '#bar{height:44px;display:flex;align-items:center;gap:10px;padding:0 16px;' +
          'background:#1e1e2e;border-top:1px solid #45475a;' +
          'font:12px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;}' +
        'span{color:#a6adc8;flex:1;font-size:11px;}' +
        'button{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;' +
          'font:500 12px/1 system-ui,sans-serif;flex-shrink:0;background:#3b82f6;color:#fff;}' +
      '</style>' +
      '<div id="bar"><span>Codex Work Preview</span><button id="__cw_btn_pick" type="button">Pick Element</button></div>';

    root.appendChild(host);
    bottomBar = host;
    shadow.getElementById('__cw_btn_pick').onclick = function () { activate(); };
  }

  function setToolbarPicking(isPicking) {
    var host = document.getElementById('__cw_toolbar_host');
    var btn = host && host.shadowRoot && host.shadowRoot.getElementById('__cw_btn_pick');
    if (!btn) return;
    if (isPicking) {
      btn.textContent = 'Cancel';
      btn.style.background = '#45475a';
      btn.style.color = '#cdd6f4';
      btn.onclick = function () { deactivate(); setToolbarPicking(false); };
    } else {
      btn.textContent = 'Pick Element';
      btn.style.background = '#3b82f6';
      btn.style.color = '#fff';
      btn.onclick = function () { activate(); };
    }
  }

  function createOverlay() {
    var existing = document.getElementById('__cw_overlay');
    if (existing) existing.remove();
    var existingLb = document.getElementById('__cw_label');
    if (existingLb) existingLb.remove();

    var el = document.createElement('div');
    el.id = '__cw_overlay';
    el.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #3b82f6;' +
      'background:rgba(59,130,246,0.08);z-index:2147483645;transition:all 0.1s ease;display:none;';
    document.body.appendChild(el);

    var lb = document.createElement('div');
    lb.id = '__cw_label';
    lb.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;' +
      'background:#3b82f6;color:#fff;font:11px/1.4 monospace;padding:2px 6px;' +
      'border-radius:3px;display:none;white-space:nowrap;';
    document.body.appendChild(lb);
    return { overlay: el, label: lb };
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (labelEl) labelEl.style.display = 'none';
  }

  function highlight(el) {
    if (!overlay || !labelEl || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    labelEl.style.display = 'block';
    labelEl.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    var top = r.top > 24 ? r.top - 20 : r.bottom + 4;
    labelEl.style.left = Math.max(4, r.left) + 'px';
    labelEl.style.top = top + 'px';
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      var part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + cur.id;
        parts.unshift(part);
        break;
      }
      var cls = (cur.className && typeof cur.className === 'string')
        ? cur.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      if (cls) part += '.' + cls;
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function extract(el) {
    var attrs = {
      id: el.id || null,
      class: el.getAttribute('class'),
      role: el.getAttribute('role'),
      name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label')
    };
    var styles = {};
    try {
      var cs = window.getComputedStyle(el);
      STYLE_KEYS.forEach(function (k) { styles[k] = cs[k]; });
    } catch (_) {}
    var text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    var html = '';
    try { html = el.outerHTML || ''; } catch (_) {}
    return {
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      domPath: cssPath(el),
      tagName: el.tagName.toLowerCase(),
      textContent: text.slice(0, 500),
      attributes: attrs,
      outerHtmlSnippet: html.slice(0, 2000),
      styleSummary: styles
    };
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function dismissResult() {
    pendingData = null;
    removeResult();
    if (bottomBar) bottomBar.style.display = 'block';
  }

  function showResult(data) {
    removeResult();
    pendingData = data;
    if (bottomBar) bottomBar.style.display = 'none';

    var tag = esc(data.tagName);
    var cls = data.attributes.class ? '.' + esc(data.attributes.class.split(' ')[0]) : '';
    var text = data.textContent ? esc(data.textContent.slice(0, 80)) : '';

    var p = document.createElement('div');
    p.id = '__cw_result';
    p.setAttribute('data-cw-ui', '1');
    p.style.cssText =
      'all:initial;position:fixed!important;bottom:0!important;left:0!important;right:0!important;' +
      'z-index:2147483646!important;background:#1e1e2e!important;border-top:1px solid #45475a!important;' +
      'padding:10px 16px!important;font:12px/1.5 system-ui,sans-serif!important;color:#cdd6f4!important;' +
      'min-height:0!important;max-height:none!important;box-sizing:border-box!important;';
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font:12px/1.5 system-ui,sans-serif;color:#cdd6f4;">' +
        '<span style="font:600 13px monospace;color:#89b4fa;">' + tag + cls + '</span>' +
        (text ? '<span style="color:#a6adc8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">"' + text + '"</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button id="__cw_r_pick" style="' + BTN + 'background:#45475a;color:#cdd6f4;">Pick Again</button>' +
        '<button id="__cw_r_dismiss" style="' + BTN + 'background:#45475a;color:#cdd6f4;">Dismiss</button>' +
        '<button id="__cw_r_insert" style="' + BTN + 'background:#3b82f6;color:#fff;">Insert to Chat</button>' +
      '</div>';
    (document.documentElement || document.body).appendChild(p);

    document.getElementById('__cw_r_insert').onclick = function () {
      if (!pendingData) return;
      var json = encodeURIComponent(JSON.stringify(pendingData));
      dismissResult();
      window.location.href = 'cw-preview://element-selected#' + json;
    };
    document.getElementById('__cw_r_pick').onclick = function () {
      dismissResult();
      activate();
    };
    document.getElementById('__cw_r_dismiss').onclick = dismissResult;
  }

  function removeResult() {
    var el = document.getElementById('__cw_result');
    if (el) el.remove();
  }

  function isCwEl(el) {
    if (!el) return false;
    return !!(
      el.closest('[data-cw-ui]') ||
      el.closest('#__cw_chrome_host') ||
      el.closest('#__cw_toolbar_host') ||
      el.closest('#__cw_result') ||
      el.id === '__cw_overlay' ||
      el.id === '__cw_label'
    );
  }

  function onMove(e) {
    if (!active || rafPending) return;
    rafPending = true;
    var x = e.clientX, y = e.clientY;
    requestAnimationFrame(function () {
      rafPending = false;
      if (!active) return;
      var el = document.elementFromPoint(x, y);
      if (el && !isCwEl(el)) highlight(el);
    });
  }

  function onClick(e) {
    if (!active) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isCwEl(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    deactivate();
    showResult(extract(el));
  }

  function activate() {
    if (active) return;
    removeResult();
    pendingData = null;
    active = true;
    var els = createOverlay();
    overlay = els.overlay;
    labelEl = els.label;
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    setToolbarPicking(true);
  }

  function deactivate() {
    active = false;
    rafPending = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    hideOverlay();
    var ov = document.getElementById('__cw_overlay');
    if (ov) ov.remove();
    var lb = document.getElementById('__cw_label');
    if (lb) lb.remove();
    overlay = null;
    labelEl = null;
    setToolbarPicking(false);
  }

  function mount() {
    clearLayoutPollution();
    // Remove legacy non-shadow chrome from older builds.
    ['__cw_chrome', '__cw_toolbar'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    createChrome();
    createBottomBar();
  }

  function ensureMounted() {
    chromeBar = null;
    bottomBar = null;
    clearLayoutPollution();
    mount();
  }

  function init() {
    clearLayoutPollution();
    mount();
    try {
      var obs = new MutationObserver(function () {
        if (!document.getElementById('__cw_chrome_host') || !document.getElementById('__cw_toolbar_host')) {
          ensureMounted();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    window.addEventListener('pageshow', ensureMounted);
  }
  init();

  window.__cwPicker = { activate: activate, deactivate: deactivate, ensureMounted: ensureMounted };
})();
