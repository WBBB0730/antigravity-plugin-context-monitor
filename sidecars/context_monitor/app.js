(() => {
  const POLL_MS = 1500;
  const OVERRIDES_KEY = 'context-monitor:model-limits:v1';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  const state = {
    conv: '',
    etag: '',
    ctx: null,
  };

  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const theme = (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function saveOverride(model, limit) {
    if (!model) return;
    const map = loadOverrides();
    if (limit == null) delete map[model];
    else map[model] = limit;
    try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(map)); } catch {}
  }

  function resolveLimit(ctx) {
    const overrides = loadOverrides();
    if (ctx?.model && Number.isFinite(overrides[ctx.model]) && overrides[ctx.model] > 0) {
      return overrides[ctx.model];
    }
    if (Number.isFinite(ctx?.contextLimit) && ctx.contextLimit > 0) {
      return ctx.contextLimit;
    }
    return 1_000_000;
  }

  const BINARY_LABELS = {
    131072: '128k',
    262144: '256k',
    524288: '512k',
    1048576: '1M',
    2097152: '2M',
  };

  function fmtTokens(n, isLimit = false) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (isLimit && BINARY_LABELS[v]) return BINARY_LABELS[v];
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    if (v >= 1_000) {
      const k = v / 1_000;
      return `${k.toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(v);
  }

  function fmtPct(ratio) {
    const pct = Math.max(0, Math.min(100, ratio * 100));
    if (pct === 0 || pct >= 1) return `${Math.round(pct)}%`;
    return '<1%';
  }

  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  function render() {
    const ctx = state.ctx;
    if (!ctx || !ctx.found) {
      $('panel').classList.add('hidden');
      $('empty').classList.remove('hidden');
      return;
    }

    $('empty').classList.add('hidden');
    $('panel').classList.remove('hidden');

    const limit = resolveLimit(ctx);
    const used = ctx.usedTokens || 0;
    const ratio = limit > 0 ? Math.min(1, used / limit) : 0;

    $('used-pct').textContent = fmtPct(ratio);
    $('used-tokens').textContent = fmtTokens(used);
    $('limit-tokens').textContent = fmtTokens(limit, true);

    const fill = $('fill');
    fill.style.width = `${Math.min(100, Math.max(used > 0 ? 1.5 : 0, ratio * 100)).toFixed(1)}%`;
    fill.className = `fill${ratio >= 0.9 ? ' danger' : ratio >= 0.75 ? ' warn' : ''}`;
    $('track').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

    document.querySelectorAll('.preset').forEach((btn) => {
      const p = Number(btn.dataset.limit);
      btn.classList.toggle('active', p === limit || (p === 1_000_000 && limit === 1_048_576));
    });

    $('cache-hit').textContent = ctx.cacheHitRate != null
      ? `缓存命中 ${Math.round(ctx.cacheHitRate * 100)}%`
      : '';

    const right = $('meta-right');
    right.className = 'num';
    if (ctx.justCompacted) {
      right.textContent = '刚刚已压缩';
    } else if (ratio >= 0.85) {
      right.className = 'num meta-danger';
      right.textContent = '建议 /compact';
    } else if (ctx.compactions > 0) {
      right.textContent = `已压缩 ${ctx.compactions} 次`;
    } else {
      right.textContent = ctx.model || '';
    }
  }

  async function poll() {
    const conv = currentConv();
    if (conv !== state.conv) {
      state.conv = conv;
      state.etag = '';
    }
    try {
      const qs = new URLSearchParams();
      if (conv) qs.set('conversationId', conv);
      if (state.etag) qs.set('etag', state.etag);
      const data = await getJson(`/api/context?${qs.toString()}`);
      if (!data.unchanged) {
        state.ctx = data;
        state.etag = data.etag || '';
        render();
      }
    } catch {}
  }

  $('limit-trigger').addEventListener('click', () => {
    const ed = $('limit-editor');
    const open = ed.classList.contains('hidden');
    ed.classList.toggle('hidden', !open);
    if (open && state.ctx) {
      $('limit-input').value = String(resolveLimit(state.ctx));
    }
  });

  document.querySelectorAll('.preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.ctx?.model) return;
      saveOverride(state.ctx.model, Number(btn.dataset.limit));
      $('limit-editor').classList.add('hidden');
      render();
    });
  });

  $('limit-apply').addEventListener('click', () => {
    if (!state.ctx?.model) return;
    const val = Number($('limit-input').value);
    if (!Number.isFinite(val) || val < 16000) return;
    saveOverride(state.ctx.model, Math.round(val));
    $('limit-editor').classList.add('hidden');
    render();
  });

  $('limit-reset').addEventListener('click', () => {
    if (!state.ctx?.model) return;
    saveOverride(state.ctx.model, null);
    $('limit-editor').classList.add('hidden');
    render();
  });

  poll();
  setInterval(poll, POLL_MS);
})();
