// js/demo/demo-mode.js
//
// 5976-6299 of post-v223 source.
//
// When WAYPOINT_ENV === 'demo', _initSupabase calls this once during
// boot to:
//   1. Add `body.demo-mode` class -- triggers a big inline <style>
//      block (also injected here) hiding Scout, new/add buttons, etc.
//   2. Override the Supabase JS SDK at the proxy layer so every
//      .insert/.update/.delete/.upsert short-circuits with a toast,
//      regardless of which UI path triggered it. Server-side RLS deny-
//      write is authoritative; this is the UX layer.
//
// External refs consumed (classic-script GLE / window):
//   _sb              -- Supabase client (will move into a module later)
//   supabase         -- UMD global (Supabase JS v2)
//
// Exposes on window:
//   _applyDemoMode   -- called from _initSupabase

function _applyDemoMode() {
  document.body.classList.add('demo-mode');

  // CSS strategy (v179 "view mode"):
  //   1. Hide Scout entirely (no LLM in demo).
  //   2. Hide "new/add/upload" actions (no creating entities in demo).
  //   3. Show Edit buttons — visitors CAN open modals to inspect rows.
  //   4. Show Save/Delete/Commit buttons but gray them and disable pointer.
  //   5. Inside any modal: gray out + disable every input/select/textarea
  //      EXCEPT #f-show_on_dashboard (the office dashboard toggle) and
  //      anything tagged data-demo-allow. The exception is what makes the
  //      Tier View / Mission Control toggle live for demo viewers.
  const style = document.createElement('style');
  style.id = '__demo_mode_css';
  style.textContent = [
    // Scout: gone.
    'body.demo-mode #scoutShell,',
    'body.demo-mode #scoutFindingsExpandTab,',
    'body.demo-mode #tab-scout,',
    'body.demo-mode [data-tab="scout"],',
    'body.demo-mode [data-v98-tab="scout"],',
    'body.demo-mode .scout-launch-btn,',
    'body.demo-mode [data-action="scout"],',
    // Add / new / upload: hidden (no creating new entities in demo).
    'body.demo-mode [data-action="add"],',
    'body.demo-mode [data-action="new"],',
    'body.demo-mode .btn-add, body.demo-mode .add-btn,',
    'body.demo-mode .btn-new, body.demo-mode .new-btn,',
    'body.demo-mode .new-office-btn,',
    'body.demo-mode .new-contact-btn,',
    'body.demo-mode .new-solicitation-btn,',
    'body.demo-mode .new-letter-btn,',
    'body.demo-mode .new-meeting-btn,',
    'body.demo-mode .new-request-btn,',
    'body.demo-mode #btnAddOffice,',
    'body.demo-mode .upload-btn',
    ' { display: none !important; }',

    // File-pickers always hidden.
    'body.demo-mode input[type="file"] { display: none !important; }',

    // Save / Delete / Commit: visible, grayed, inert.
    'body.demo-mode [data-action="save"]:not(.demo-allow),',
    'body.demo-mode [data-action="delete"]:not(.demo-allow),',
    'body.demo-mode [data-action="commit"]:not(.demo-allow),',
    'body.demo-mode .btn-save:not(.demo-allow), body.demo-mode .save-btn:not(.demo-allow),',
    'body.demo-mode .btn-delete:not(.demo-allow), body.demo-mode .delete-btn:not(.demo-allow),',
    'body.demo-mode .modal-footer .btn.primary:not(.demo-allow),',
    'body.demo-mode .modal-footer .btn.danger:not(.demo-allow)',
    ' { opacity: 0.4 !important; pointer-events: none !important; cursor: not-allowed !important; }',

    // Form inputs inside any modal: grayed + non-interactive.
    // Exceptions: #f-show_on_dashboard, #f-priority (the two office-modal
    // toggles whose values ARE persisted to the demo DB), anything marked
    // data-demo-allow, and the modal close/cancel control.
    'body.demo-mode .modal-body input:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow]),',
    'body.demo-mode .modal-body select:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow]),',
    'body.demo-mode .modal-body textarea:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow]),',
    'body.demo-mode .modal-body button:not(.demo-allow):not(.modal-close):not([data-demo-cancel])',
    ' { pointer-events: none !important; opacity: 0.65 !important; cursor: not-allowed !important; }',
    'body.demo-mode .modal-body input:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow]),',
    'body.demo-mode .modal-body select:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow]),',
    'body.demo-mode .modal-body textarea:not(#f-show_on_dashboard):not(#f-priority):not([data-demo-allow])',
    ' { background-color: var(--surface-alt, #f1f1f3) !important; color: var(--text-muted, #888) !important; }',

    // The two office-modal toggles stay visibly interactive (full opacity).
    // Their values write to the real DEMO Supabase via the SDK update path
    // below — column-level GRANT on offices restricts anon writes to just
    // these two columns.
    'body.demo-mode #f-show_on_dashboard, body.demo-mode #f-priority { opacity: 1 !important; pointer-events: auto !important; cursor: pointer !important; }',
    'body.demo-mode label:has(#f-show_on_dashboard), body.demo-mode label:has(#f-priority) { opacity: 1 !important; cursor: pointer !important; }',

    // CRITICAL: override v135 role-viewer CSS that hides .btn.primary
    // and [data-edit] site-wide for the viewer role. Demo visitors get
    // role='viewer' so they can read but not write. The role-viewer rules
    //   body.role-viewer .btn.primary    { display: none !important; }
    //   body.role-viewer [data-edit]     { display: none !important; }
    //   body.role-viewer [data-del]      { display: none !important; }
    // would hide both the office-modal Save button AND every Kanban /
    // list-view row that uses data-edit as the click-to-edit handle.
    // The two-class selector below has higher specificity AND uses the
    // role-viewer prefix to win the cascade decisively.
    'body.demo-mode.role-viewer .btn.primary.demo-allow,',
    'body.demo-mode.role-viewer .btn.danger.demo-allow,',
    'body.demo-mode.role-viewer [data-action="save"].demo-allow,',
    'body.demo-mode.role-viewer [data-action="commit"].demo-allow,',
    'body.demo-mode.role-viewer .btn-save.demo-allow,',
    'body.demo-mode.role-viewer .save-btn.demo-allow',
    ' { display: inline-flex !important; opacity: 1 !important; pointer-events: auto !important; cursor: pointer !important; visibility: visible !important; }',

    // data-edit elements are the click-to-edit affordances on Kanban
    // cards, list rows, mini-cards, etc. v135 hides them all under
    // role-viewer; we need them visible so demo users can browse the
    // data. The display:revert lets the element fall back to its
    // natural display (block for div, inline-block for button, etc.)
    // instead of forcing one value. Clicks open the existing modal,
    // which is locked down to read-only via the SDK write blocker.
    'body.demo-mode.role-viewer [data-edit]',
    ' { display: revert !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; }',
  ].join('\n');
  document.head.appendChild(style);

  // Toast helper for when a blocked write happens behind the scenes.
  window.__demoToast = function(msg) {
    let toast = document.getElementById('__demoToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = '__demoToast';
      toast.style.cssText = 'position:fixed;top:20px;right:20px;background:#fff3cd;color:#856404;border:1px solid #ffeeba;padding:10px 16px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100000;font-size:13px;max-width:320px;font-family:system-ui,sans-serif;';
      document.body.appendChild(toast);
    }
    toast.textContent = msg || 'This is a read-only demo. Writes are disabled.';
    clearTimeout(window.__demoToastTimer);
    window.__demoToastTimer = setTimeout(function() { try { toast.remove(); } catch (e) {} }, 2400);
  };

  // Footer rebrand.
  try {
    const footer = document.querySelector('footer');
    if (footer && footer.childNodes && footer.childNodes[0] && footer.childNodes[0].nodeType === 3) {
      footer.childNodes[0].textContent = ' Waypoint Demo (read-only) ';
    }
  } catch (e) {}

  // SDK-layer write blocker. Wraps _sb.from() so every .insert / .update /
  // .delete / .upsert returns a chainable stub that resolves to
  // { data: null, error: { code: 'DEMO_RO', ... } }. Callers that check
  // `error` see the rejection cleanly; callers that don't simply no-op.
  const DEMO_ERR = { message: 'Demo mode: writes are disabled.', code: 'DEMO_RO', details: '', hint: '' };
  const _origFrom = _sb.from.bind(_sb);
  _sb.from = function(table) {
    const q = _origFrom(table);
    const stub = {
      _table: table,
      eq()         { return this; }, neq()        { return this; },
      gt()         { return this; }, gte()        { return this; },
      lt()         { return this; }, lte()        { return this; },
      like()       { return this; }, ilike()      { return this; },
      in()         { return this; }, is()         { return this; },
      contains()   { return this; }, containedBy(){ return this; },
      match()      { return this; }, select()     { return this; },
      single()     { return this; }, maybeSingle(){ return this; },
      throwOnError(){ return this; }, returns()    { return this; },
      order()      { return this; }, limit()      { return this; },
      range()      { return this; },
      then(resolve) {
        try { window.__demoToast && window.__demoToast(); } catch (e) {}
        const out = { data: null, error: DEMO_ERR };
        if (typeof resolve === 'function') resolve(out);
        return Promise.resolve(out);
      },
      catch()   { return Promise.resolve({ data: null, error: DEMO_ERR }); },
      finally(fn) { try { fn && fn(); } catch (e) {} return Promise.resolve({ data: null, error: DEMO_ERR }); },
    };
    ['insert','delete','upsert'].forEach(function(method) {
      q[method] = function() { return stub; };
    });

    // Special: offices writes are allowed for priority + show_on_dashboard
    // only. We intercept both .update() AND .upsert() because the office
    // save path actually calls DB.upsert → _supaUpsert → _sb.from(t).upsert
    // (not .update). The filter strips the payload to just the two
    // whitelisted columns. For .upsert(), we rewrite the operation as
    // .update(filtered).eq('id', payload.id), because the DEMO project's
    // column-level GRANT does NOT allow anon INSERT on offices — only
    // UPDATE on those two columns. RLS + column-level GRANT are the
    // authoritative server-side enforcement; this client filter is just
    // good hygiene and makes the office save flow actually succeed.
    const ALLOWED_OFFICE_COLS = ['priority', 'show_on_dashboard'];
    function filterOfficePayload(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const filtered = {};
      for (const k of Object.keys(payload)) {
        if (ALLOWED_OFFICE_COLS.includes(k)) filtered[k] = payload[k];
      }
      return Object.keys(filtered).length > 0 ? filtered : null;
    }

    const _origUpdate = q.update.bind(q);
    q.update = function(payload) {
      if (table === 'offices') {
        const filtered = filterOfficePayload(payload);
        if (filtered) {
          try { window.__demoToast && window.__demoToast('Saved: dashboard toggles updated.'); } catch (e) {}
          return _origUpdate(filtered);
        }
      }
      return stub;
    };

    // .upsert() interceptor — rewrites to .update() on offices for the
    // whitelisted columns. The office save path uses this entry point.
    q.upsert = function(payload) {
      if (table === 'offices' && payload && typeof payload === 'object') {
        const id = payload.id;
        const filtered = filterOfficePayload(payload);
        if (id && filtered) {
          try { window.__demoToast && window.__demoToast('Saved: dashboard toggles updated.'); } catch (e) {}
          // Use the unwrapped from() so we don't recurse through our own
          // override. .update + .eq is the canonical way to update a
          // specific row by id.
          return _origFrom('offices').update(filtered).eq('id', id);
        }
      }
      return stub;
    };

    return q;
  };

  // Storage uploads (letters bucket, office media) blocked too.
  if (_sb.storage && _sb.storage.from) {
    const _origStorageFrom = _sb.storage.from.bind(_sb.storage);
    _sb.storage.from = function(bucket) {
      const b = _origStorageFrom(bucket);
      ['upload','remove','update','move','copy'].forEach(function(method) {
        b[method] = function() {
          try { window.__demoToast && window.__demoToast('Demo: uploads are disabled.'); } catch (e) {}
          return Promise.resolve({ data: null, error: { message: 'Demo mode: uploads are disabled.', code: 'DEMO_RO' } });
        };
      });
      return b;
    };
  }

  // ------------------------------------------------------------------
  // v179b: offices.priority and offices.show_on_dashboard are server-side
  // editable on demo. RLS + column-level GRANT on the DEMO project restrict
  // anon UPDATEs on `offices` to exactly those two columns. The SDK write
  // blocker above special-cases _sb.from('offices').update(...) so the
  // existing _saveOffice path passes through with a payload filtered to
  // just those columns. No localStorage overlay needed — the DB is the
  // source of truth and every demo visitor sees the same state.
  // ------------------------------------------------------------------

  // openModal monkey-patch: race-free demo-mode hook. The MutationObserver
  // below is a secondary safety net, but the canonical signal is "openModal
  // just appended the body and added .open to the backdrop." Patching the
  // function lets us run disableInputs SYNCHRONOUSLY right after the body
  // is populated — no timing race with MutationObserver delivery.
  (function _patchOpenModal() {
    function tryPatch() {
      if (typeof window.openModal !== 'function' || window.openModal._demoPatched) return false;
      const orig = window.openModal;
      window.openModal = function(opts) {
        const ret = orig.apply(this, arguments);
        // Body is now populated; tag everything before the user can interact.
        try { _demoApplyToVisibleModal(); } catch (e) { console.warn('[demo] patch openModal failed', e); }
        return ret;
      };
      window.openModal._demoPatched = true;
      return true;
    }
    if (!tryPatch()) {
      // openModal may not be defined yet if _applyDemoMode runs early.
      let tries = 0;
      const iv = setInterval(function() {
        if (tryPatch() || ++tries > 50) clearInterval(iv);
      }, 100);
    }
  })();

  // Single source of truth for "configure the visible modal for demo".
  // Used by both the openModal patch (synchronous) and the MutationObserver
  // safety net.
  function _demoApplyToVisibleModal() {
    const backdrop = document.getElementById('modalBackdrop');
    if (!backdrop) return;
    const body = backdrop.querySelector('.modal-body');
    if (!body) return;
    const isOfficeModal = !!body.querySelector('#f-show_on_dashboard');

    body.querySelectorAll('input, select, textarea').forEach(function(el) {
      const exempt =
        el.id === 'f-show_on_dashboard' ||
        (isOfficeModal && el.id === 'f-priority') ||
        el.dataset.demoAllow === '1';
      if (exempt) {
        el.removeAttribute('disabled');
        el.removeAttribute('readonly');
      } else {
        if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number' || el.type === 'email' || el.type === 'tel' || el.type === 'url' || el.type === '' || !el.type)) {
          el.setAttribute('readonly', 'readonly');
        } else {
          el.setAttribute('disabled', 'disabled');
        }
      }
    });

    const footer = backdrop.querySelector('.modal-footer');
    if (footer) {
      // Save button: clickable in office modal only.
      footer.querySelectorAll('.btn.primary, [data-action="save"], .btn-save, .save-btn').forEach(function(b) {
        if (isOfficeModal) b.classList.add('demo-allow');
        else b.classList.remove('demo-allow');
      });
      // Delete button: stays grayed everywhere.
      footer.querySelectorAll('.btn.danger, [data-action="delete"], .btn-delete, .delete-btn').forEach(function(b) {
        b.classList.remove('demo-allow');
      });
    }
  }
  window.__demoApplyToVisibleModal = _demoApplyToVisibleModal;

  // MutationObserver safety net: catches modals opened by code paths that
  // don't go through openModal (if any exist).
  (function _setupModalObserver() {
    const backdrop = document.getElementById('modalBackdrop');
    if (!backdrop) return;
    const obs = new MutationObserver(function() {
      const cs = getComputedStyle(backdrop);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') {
        setTimeout(_demoApplyToVisibleModal, 0);
      }
    });
    obs.observe(backdrop, { attributes: true, attributeFilter: ['style', 'class'] });
    obs.observe(backdrop, { childList: true, subtree: true });
    _demoApplyToVisibleModal();
  })();

  console.info('[waypoint] DEMO_MODE v179l active — Kanban cards visible (role-viewer [data-edit] override).');
}

window._applyDemoMode = _applyDemoMode;
