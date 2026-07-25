// Vanilla JS frontend for the newsletter digest. No build step, no framework.
//
// Instapaper save is 100% client-side: this template is filled in and opened via
// window.open, riding the browser's existing Instapaper session cookie. No credentials
// are ever sent to or stored by this app's own server. See AGENTS.md — this exact URL
// mechanism (instapaper.com/edit?url=&title=) is unverified against the live site as of
// writing; treat it as needing a real smoke test, not an assumption.
const INSTAPAPER_URL_TEMPLATE = 'https://www.instapaper.com/edit?url={url}&title={title}';

const state = {
  groupBy: 'topic',
  search: '',
  hideRead: false,
  selectedIds: new Set(),
};

const el = {
  counts: document.getElementById('counts'),
  searchInput: document.getElementById('search-input'),
  groupSeg: document.getElementById('group-seg'),
  hideReadCheckbox: document.getElementById('hide-read-checkbox'),
  statusMessage: document.getElementById('status-message'),
  groups: document.getElementById('groups'),
  bulkBar: document.getElementById('bulk-bar'),
  bulkCount: document.getElementById('bulk-count'),
};

function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function buildInstapaperUrl(item) {
  return INSTAPAPER_URL_TEMPLATE
    .replace('{url}', encodeURIComponent(item.url))
    .replace('{title}', encodeURIComponent(item.headline || ''));
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function fetchLinks() {
  const params = new URLSearchParams();
  if (state.search) params.set('search', state.search);
  params.set('group', state.groupBy);
  if (state.hideRead) params.set('hideRead', 'true');
  return api(`/api/links?${params.toString()}`);
}

async function refresh() {
  let data;
  try {
    data = await fetchLinks();
  } catch (err) {
    el.groups.innerHTML = '';
    el.statusMessage.textContent = `Couldn't load the digest: ${err.message}`;
    el.statusMessage.style.display = '';
    return;
  }
  render(data);
}

function render(data) {
  el.counts.textContent = `${data.unreadCount} unread · ${data.totalCount} total`;

  // Dropping selections for ids that no longer exist in this result set (e.g. dismissed).
  const visibleIds = new Set(data.groups.flatMap((g) => g.items.map((i) => i.id)));
  for (const id of [...state.selectedIds]) {
    if (!visibleIds.has(id)) state.selectedIds.delete(id);
  }

  if (data.groups.length === 0) {
    el.groups.innerHTML = '';
    el.statusMessage.textContent = 'Nothing here. Try a different search, or clear filters.';
    el.statusMessage.style.display = '';
  } else {
    el.statusMessage.style.display = 'none';
    el.groups.innerHTML = data.groups.map(renderGroup).join('');
  }

  renderBulkBar();
}

function renderGroup(group) {
  return `
    <div style="margin-bottom: var(--space-8);">
      <h6 style="margin-bottom: var(--space-3); display:flex; align-items:center; gap:8px;">
        ${escapeHtml(group.name)}
        <span class="text-muted" style="text-transform:none; letter-spacing:normal;">${group.count}</span>
      </h6>
      <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: var(--space-4);">
        ${group.items.map(renderCard).join('')}
      </div>
    </div>
  `;
}

function renderCard(item) {
  const selected = state.selectedIds.has(item.id);
  const cardStyle = `opacity:${item.read ? 0.55 : 1}; box-shadow:${selected ? '0 0 0 1px var(--color-accent)' : 'var(--shadow-sm)'}; transition: opacity 0.15s, box-shadow 0.15s;`;
  const titleStyle = `text-decoration: ${item.read ? 'line-through' : 'none'}; text-decoration-color: var(--color-neutral-600); text-decoration-thickness:1px;`;
  const readBtnLabel = item.read ? 'Read ✓' : 'Mark read';
  const readBtnStyle = item.read ? 'background: var(--color-neutral-800); border-color: transparent; color: var(--color-neutral-100);' : '';
  const instapaperBtnLabel = item.savedInstapaper ? 'Saved ✓' : 'Instapaper';
  const instapaperBtnStyle = item.savedInstapaper ? 'background: var(--color-accent-800); border-color: transparent; color: var(--color-accent-100);' : '';
  const topicTags = item.topics.length
    ? item.topics.map((t) => `<span class="tag tag-accent">${escapeHtml(t)}</span>`).join('')
    : '<span class="tag tag-neutral">Uncategorized</span>';
  const summaryText = item.summary || (item.gaveUp ? '(summary unavailable)' : '(summarizing…)');
  const readTimeText = item.readTime != null ? `${item.readTime} min read` : '– min read';

  return `
    <div class="card elev-sm" style="${cardStyle}" data-id="${item.id}">
      <div style="display:flex; align-items:flex-start; gap: var(--space-3);">
        <input type="checkbox" class="js-select" data-id="${item.id}" ${selected ? 'checked' : ''} style="width:16px; height:16px; margin-top:3px; flex-shrink:0; cursor:pointer; accent-color: var(--color-accent);" />
        <div style="flex:1; min-width:0;">
          <div style="display:flex; align-items:flex-start; justify-content:space-between; gap: var(--space-2);">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="card-title" style="${titleStyle}">${escapeHtml(item.headline)}</a>
            <button type="button" class="btn btn-icon js-dismiss" data-id="${item.id}" title="Dismiss" style="flex-shrink:0; width:28px; height:28px;">✕</button>
          </div>
          <p class="card-body" style="margin-top: var(--space-1); opacity:0.8;">${escapeHtml(summaryText)}</p>
          <div class="card-meta" style="margin-top: var(--space-2); flex-wrap:wrap;">
            ${topicTags}
            <span>${escapeHtml(item.sources.join(', '))}</span>
            <span>·</span>
            <span>${readTimeText}</span>
          </div>
          <div style="display:flex; align-items:center; gap: var(--space-2); margin-top: var(--space-3); flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary js-toggle-read" data-id="${item.id}" style="${readBtnStyle}">${readBtnLabel}</button>
            <button type="button" class="btn btn-secondary js-save-instapaper" data-id="${item.id}" data-url="${escapeHtml(item.url)}" data-headline="${escapeHtml(item.headline)}" style="${instapaperBtnStyle}">${instapaperBtnLabel}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderBulkBar() {
  const count = state.selectedIds.size;
  el.bulkBar.style.display = count > 0 ? 'flex' : 'none';
  el.bulkCount.textContent = `${count} selected`;
}

function openInstapaper(item) {
  window.open(buildInstapaperUrl(item), '_blank', 'noopener');
}

function showTransientError(message) {
  const prevDisplay = el.statusMessage.style.display;
  const prevText = el.statusMessage.textContent;
  const hadGroups = el.groups.innerHTML.trim().length > 0;
  el.statusMessage.textContent = message;
  el.statusMessage.style.display = '';
  setTimeout(() => {
    if (el.statusMessage.textContent !== message) return; // a newer message/refresh already replaced it
    if (hadGroups) {
      el.statusMessage.style.display = prevDisplay;
      el.statusMessage.textContent = prevText;
    }
  }, 4000);
}

// Serializes actions that call the API so a rapid double-click on a toggle
// (read/mark-saved) can't fire two overlapping requests and flip the value back
// to its original state before the UI re-renders.
let actionInFlight = false;

function runAction(fn) {
  return async (...args) => {
    if (actionInFlight) return;
    actionInFlight = true;
    try {
      await fn(...args);
    } catch (err) {
      showTransientError(`Action failed: ${err.message}`);
    } finally {
      actionInFlight = false;
    }
  };
}

el.searchInput.addEventListener('input', debounce((e) => {
  state.search = e.target.value;
  refresh();
}, 250));

el.groupSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-group]');
  if (!btn) return;
  state.groupBy = btn.dataset.group;
  updateGroupSegStyles();
  refresh();
});

function updateGroupSegStyles() {
  el.groupSeg.querySelectorAll('[data-group]').forEach((btn) => {
    const active = btn.dataset.group === state.groupBy;
    btn.setAttribute('aria-pressed', String(active));
    btn.style.cssText = active ? 'color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent);' : '';
  });
}

el.hideReadCheckbox.addEventListener('change', (e) => {
  state.hideRead = e.target.checked;
  refresh();
});

el.groups.addEventListener('click', runAction(async (e) => {
  const dismissBtn = e.target.closest('.js-dismiss');
  if (dismissBtn) {
    await api(`/api/links/${dismissBtn.dataset.id}/dismiss`, { method: 'POST' });
    await refresh();
    return;
  }

  const readBtn = e.target.closest('.js-toggle-read');
  if (readBtn) {
    await api(`/api/links/${readBtn.dataset.id}/read`, { method: 'POST' });
    await refresh();
    return;
  }

  const saveBtn = e.target.closest('.js-save-instapaper');
  if (saveBtn) {
    const result = await api(`/api/links/${saveBtn.dataset.id}/mark-saved`, { method: 'POST' });
    if (result.savedInstapaper) {
      openInstapaper({ url: saveBtn.dataset.url, headline: saveBtn.dataset.headline });
    }
    await refresh();
    return;
  }

  const checkbox = e.target.closest('.js-select');
  if (checkbox) {
    const id = Number(checkbox.dataset.id);
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
    renderBulkBar();
  }
}));

document.getElementById('bulk-instapaper').addEventListener('click', runAction(async () => {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  const cardsById = new Map(
    [...document.querySelectorAll('[data-id]')]
      .filter((elm) => elm.classList.contains('js-save-instapaper'))
      .map((elm) => [Number(elm.dataset.id), elm])
  );
  for (const id of ids) {
    const card = cardsById.get(id);
    if (card) openInstapaper({ url: card.dataset.url, headline: card.dataset.headline });
  }
  await api('/api/links/mark-saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refresh();
}));

document.getElementById('bulk-read').addEventListener('click', runAction(async () => {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  await api('/api/links/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refresh();
}));

document.getElementById('bulk-dismiss').addEventListener('click', runAction(async () => {
  const ids = [...state.selectedIds];
  if (ids.length === 0) return;
  await api('/api/links/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refresh();
}));

document.getElementById('bulk-clear').addEventListener('click', () => {
  state.selectedIds.clear();
  renderBulkBar();
  refresh();
});

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

updateGroupSegStyles();
refresh();
