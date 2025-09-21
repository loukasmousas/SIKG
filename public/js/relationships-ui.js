// shared minimal relationships popup UI for both pages
export function attachRelationshipsUI({
  sock,
  fetchRelationships,
  onToggle,
  onMetaSave,
  containerId = 'resultsPopup',
  bodyId = 'relPopupBody',
}) {
  const box = document.getElementById(containerId);
  const body = document.getElementById(bodyId);
  const closeBtn =
    document.getElementById('relPopClose') ||
    document.getElementById('resPopClose');
  let hideReadonly = false; // toggle to hide inherited read-only rows
  let lastOpenUri = null; // remember which subject is showing

  async function render(
    uri,
    rows,
    showDeleted = false,
    page = 1,
    pageSize = 20,
  ) {
    let filtered = showDeleted ? rows : rows.filter((r) => !r.deleted);
    if (hideReadonly) filtered = filtered.filter((r) => !r.readonly);
    const start = (page - 1) * pageSize;
    const chunk = filtered.slice(start, start + pageSize);
    const esc = (s) =>
      String(s ?? '').replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c],
      );
    const tr = (r, i) => {
      const ck = r.deleted ? '' : 'checked';
      const dis = r.readonly ? 'disabled' : '';
      return `<tr data-i="${i}"><td>${esc(r.predicate)}</td><td title="${esc(r.other)}">${esc(r.other)}</td><td>${r.incoming ? 'incoming' : 'outgoing'}</td><td><input type="checkbox" class="rel-en" ${ck} ${dis}></td><td><input class="rel-name" placeholder="name" value="${esc(r.name || '')}" ${dis}></td><td><input class="rel-desc" placeholder="description" value="${esc(r.description || '')}" ${dis}></td><td style="white-space:nowrap"><button class="rel-save btn-sm" ${dis}>Save</button> <button class="rel-hist btn-ghost btn-sm" title="Show history">⏱</button></td></tr>
      <tr class="rel-hist-row" style="display:none"><td colspan="7" class="rel-hist-cell"></td></tr>`;
    };
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <label class="switch"><input type="checkbox" id="relShowDeleted" ${showDeleted ? 'checked' : ''}><span class="slider"></span><span class="switch-label">show deleted</span></label>
        <label class="switch" title="Hide inherited/read-only relations"><input type="checkbox" id="relHideRO" ${hideReadonly ? 'checked' : ''}><span class="slider"></span><span class="switch-label">hide read-only</span></label>
        <span style="margin-left:auto;font-size:12px;color:#8895a7">${filtered.length} relations</span>
      </div>
      <table><thead><tr><th>Predicate</th><th>Other</th><th>Dir</th><th>Enabled</th><th>Name</th><th>Description</th><th></th></tr></thead><tbody>${chunk.map(tr).join('')}</tbody></table>`;

    body
      .querySelector('#relShowDeleted')
      ?.addEventListener('change', async (e) => {
        const rows2 = await fetchRelationships(uri);
        render(uri, rows2, !!e.target.checked, 1, pageSize);
      });

    body.querySelector('#relHideRO')?.addEventListener('change', async (e) => {
      hideReadonly = !!e.target.checked;
      const rows2 = await fetchRelationships(uri);
      render(uri, rows2, showDeleted, 1, pageSize);
    });

    body.querySelectorAll('.rel-en').forEach((el, idx) => {
      el.addEventListener('change', async (e) => {
        const r = chunk[idx];
        onToggle({
          subject: uri,
          predicate: r.predicate,
          object: r.other,
          enabled: e.target.checked,
        });
      });
    });
    body.querySelectorAll('.rel-save').forEach((el, idx) => {
      el.addEventListener('click', async () => {
        const trEl = el.closest('tr');
        const r = chunk[idx];
        const name = trEl.querySelector('.rel-name').value;
        const description = trEl.querySelector('.rel-desc').value;
        try {
          await Promise.resolve(
            onMetaSave({
              subject: uri,
              predicate: r.predicate,
              object: r.other,
              name,
              description,
            }),
          );
        } catch (_e) {
          /* ignore */
        }
        // Re-fetch and re-render to reflect latest history
        try {
          const fresh = await fetchRelationships(uri);
          await render(
            uri,
            fresh,
            body.querySelector('#relShowDeleted')?.checked || false,
            page,
            pageSize,
          );
        } catch (_e) {
          /* ignore */
        }
      });
    });
    // History toggles
    body.querySelectorAll('.rel-hist').forEach((el, idx) => {
      el.addEventListener('click', () => {
        const r = chunk[idx];
        const row = el.closest('tr');
        const detail = row.nextElementSibling;
        if (!detail || !detail.classList.contains('rel-hist-row')) return;
        const wrap = detail.querySelector('.rel-hist-cell');
        if (detail.style.display === 'none') {
          const nh = Array.isArray(r.nameHistory) ? r.nameHistory : [];
          const dh = Array.isArray(r.descriptionHistory)
            ? r.descriptionHistory
            : [];
          const fmt = (arr) =>
            arr.map((e) => `<div>${esc(e)}</div>`).join('') || '<em>none</em>';
          wrap.innerHTML = `
            <div style="font-size:12px;color:#4b5563">
              <div><strong>Current</strong></div>
              <div>Name: "${esc(r.name || '')}"</div>
              <div>Description: ${esc(r.description || '')}</div>
              <div style="margin-top:6px"><strong>Name history:</strong></div>
              ${fmt(nh)}
              <div style="margin-top:6px"><strong>Description history:</strong></div>
              ${fmt(dh)}
            </div>`;
          detail.style.display = '';
        } else {
          detail.style.display = 'none';
        }
      });
    });
  }

  async function openFor(uri) {
    lastOpenUri = uri;
    const rows = await fetchRelationships(uri);
    await render(uri, rows, false, 1, 20);
    if (!box) return;
    box.style.display = 'block';
    box.style.top = '56px';
    box.style.right = '12px';
    box.style.left = 'auto';
    box.style.bottom = 'auto';
    makeDraggable();
  }

  closeBtn && (closeBtn.onclick = () => (box.style.display = 'none'));

  if (sock)
    sock.on('relationshipsUpdated', async ({ subject }) => {
      // Refresh only when popup is visible for the same subject
      if (!box || box.style.display === 'none') return;
      if (!lastOpenUri || subject !== lastOpenUri) return;
      try {
        const rows2 = await fetchRelationships(lastOpenUri);
        await render(
          lastOpenUri,
          rows2,
          !!body.querySelector('#relShowDeleted')?.checked,
          1,
          20,
        );
      } catch (_) {
        /* ignore */
      }
    });

  function makeDraggable() {
    if (!box) return;
    const header = box.querySelector('h3');
    if (!header) return;
    let dragging = false;
    let ox = 0,
      oy = 0;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', (e) => {
      // Ignore clicks on header buttons (e.g., the ✕ close) so they remain clickable
      if (
        e.target &&
        (e.target.closest('button') || e.target.id === 'relPopClose')
      )
        return;
      dragging = true;
      const rect = box.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      // Freeze current visual position before switching anchors to avoid jump
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.position = 'absolute';
      box.style.right = 'auto';
      e.preventDefault();
    });
    const root =
      (box.ownerDocument && box.ownerDocument.defaultView) ||
      (typeof globalThis !== 'undefined' ? globalThis : undefined);
    if (!root || !root.addEventListener) return;
    root.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.max(0, e.clientX - ox);
      const y = Math.max(0, e.clientY - oy);
      box.style.left = x + 'px';
      box.style.top = y + 'px';
    });
    root.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  return { openFor };
}
/* eslint-env browser */
/* global document */
