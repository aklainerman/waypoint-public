// js/auth/admin.js
//
// Renders the Admin tab when an admin user activates it: lists users
// with role-edit dropdowns, lists the email allowlist with add/remove
// controls. Bootstrapped via _v135BootAuth -> role lookup; only the
// admin role sees this tab.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v182. Pattern matches v181 WASHOPS (classic-script split, top-level
// declarations stay module-scoped, only the externally-called function
// is re-exposed on window).
//
// Exposes on window:
//   window._v136RenderAdminTab  -- called from the tab click listener
//                                  (line 21246) and the hash-route boot
//                                  IIFE (line 21258), both behind typeof
//                                  guards. Original exposure on line
//                                  21074 is preserved.
//
// Consumes from window (provided by the still-inline monolith):
//   _sb               -- Supabase client
//   window._v135Auth  -- session state object (role check at top of fn)

// =================================================================
// =================================================================
async function _v136RenderAdminTab() {
  if (window._v135Auth.role !== 'admin') {
    const wrap = document.getElementById('tab-admin');
    if (wrap) {
      wrap.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-size:13px;">Admin role required.</div>';
    }
    return;
  }
  await Promise.all([_loadUsers(), _loadAllowlist()]);
}
window._v136RenderAdminTab = _v136RenderAdminTab;

async function _loadUsers() {
  const tbody = document.querySelector('#adminUsersTable tbody');
  const msg = document.getElementById('adminUsersMsg');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.2rem;">Loading...</td></tr>';
  if (msg) msg.textContent = '';
  try {
    const { data, error } = await _sb.rpc('admin_list_users');
    if (error) throw error;
    if (!data || !data.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:1.2rem;">No users.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(function (u) {
      const created = u.created_at ? new Date(u.created_at).toLocaleDateString() : '-';
      const lastIn  = u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : '-';
      const isSelf = (window._v135Auth.user && u.user_id === window._v135Auth.user.id);
      const roleSel = '<select class="v136-allow" data-v136-user-role="' + escAttr(u.email) + '">'
        + ['admin','editor','viewer'].map(function (r) {
          return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
        }).join('') + '</select>';
      const removeBtn = isSelf
        ? '<span style="color:var(--text-muted);font-size:11px;">(you)</span>'
        : '<button class="btn-icon danger" data-v136-user-remove="' + escAttr(u.email) + '">Remove</button>';
      return '<tr>'
        + '<td>' + escHtml(u.email) + '</td>'
        + '<td>' + roleSel + '</td>'
        + '<td>' + escHtml(created) + '</td>'
        + '<td>' + escHtml(lastIn) + '</td>'
        + '<td class="td-actions">' + removeBtn + '</td>'
        + '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-v136-user-role]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        const email = sel.getAttribute('data-v136-user-role');
        const newRole = sel.value;
        if (msg) { msg.textContent = 'Saving ' + email + ' -> ' + newRole + '...'; msg.style.color = ''; }
        try {
          const { error } = await _sb.rpc('admin_set_user_role', { p_email: email, p_role: newRole });
          if (error) throw error;
          if (msg) { msg.textContent = 'Saved.'; msg.style.color = '#5DAA48'; }
        } catch (e) {
          if (msg) { msg.textContent = 'Failed: ' + (e.message || String(e)); msg.style.color = '#E24B4A'; }
          _loadUsers();
        }
      });
    });
    tbody.querySelectorAll('[data-v136-user-remove]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const email = b.getAttribute('data-v136-user-remove');
        if (!window.confirm('Remove user ' + email + '? Their account is deleted from auth.users (cascades to user_roles).')) return;
        try {
          const { error } = await _sb.rpc('admin_remove_user', { p_email: email });
          if (error) throw error;
          _loadUsers();
        } catch (e) {
          if (msg) { msg.textContent = 'Failed: ' + (e.message || String(e)); msg.style.color = '#E24B4A'; }
        }
      });
    });
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#E24B4A;padding:1.2rem;">' + escHtml((e && e.message) || String(e)) + '</td></tr>';
  }
}

async function _loadAllowlist() {
  const tbody = document.querySelector('#adminAllowlistTable tbody');
  const msg = document.getElementById('adminAllowMsg');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.2rem;">Loading...</td></tr>';
  if (msg) msg.textContent = '';
  try {
    const { data, error } = await _sb.rpc('admin_list_allowlist');
    if (error) throw error;
    if (!data || !data.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.2rem;">Allowlist is empty. Anyone signing up will be rejected (except the bootstrap first user).</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(function (a) {
      const added = a.added_at ? new Date(a.added_at).toLocaleDateString() : '-';
      const roleSel = '<select class="v136-allow" data-v136-allow-role="' + escAttr(a.email) + '">'
        + ['admin','editor','viewer'].map(function (r) {
          return '<option value="' + r + '"' + (a.default_role === r ? ' selected' : '') + '>' + r + '</option>';
        }).join('') + '</select>';
      return '<tr>'
        + '<td>' + escHtml(a.email) + '</td>'
        + '<td>' + roleSel + '</td>'
        + '<td>' + escHtml(a.added_by_email || '-') + '</td>'
        + '<td>' + escHtml(added) + '</td>'
        + '<td>' + escHtml(a.note || '') + '</td>'
        + '<td class="td-actions"><button class="btn-icon danger" data-v136-allow-remove="' + escAttr(a.email) + '">Remove</button></td>'
        + '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-v136-allow-role]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        const email = sel.getAttribute('data-v136-allow-role');
        const newRole = sel.value;
        try {
          const { error } = await _sb.rpc('admin_add_to_allowlist', { p_email: email, p_role: newRole, p_note: null });
          if (error) throw error;
          if (msg) { msg.textContent = 'Updated ' + email + ' -> ' + newRole + '.'; msg.style.color = '#5DAA48'; }
        } catch (e) {
          if (msg) { msg.textContent = 'Failed: ' + (e.message || String(e)); msg.style.color = '#E24B4A'; }
          _loadAllowlist();
        }
      });
    });
    tbody.querySelectorAll('[data-v136-allow-remove]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const email = b.getAttribute('data-v136-allow-remove');
        if (!window.confirm('Remove ' + email + ' from the allowlist?')) return;
        try {
          const { error } = await _sb.rpc('admin_remove_from_allowlist', { p_email: email });
          if (error) throw error;
          _loadAllowlist();
        } catch (e) {
          if (msg) { msg.textContent = 'Failed: ' + (e.message || String(e)); msg.style.color = '#E24B4A'; }
        }
      });
    });
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#E24B4A;padding:1.2rem;">' + escHtml((e && e.message) || String(e)) + '</td></tr>';
  }
}

// Wire the Add-to-Allowlist form (idempotent guard).
document.addEventListener('click', async function (ev) {
  if (!ev.target || ev.target.id !== 'adminAllowAdd') return;
  if (window._v135Auth.role !== 'admin') return;
  const emailEl = document.getElementById('adminAllowEmail');
  const roleEl  = document.getElementById('adminAllowRole');
  const noteEl  = document.getElementById('adminAllowNote');
  const msg = document.getElementById('adminAllowMsg');
  if (!emailEl || !roleEl) return;
  const email = (emailEl.value || '').trim();
  if (!email || email.indexOf('@') < 0) {
    if (msg) { msg.textContent = 'Enter a valid email.'; msg.style.color = '#E24B4A'; }
    return;
  }
  try {
    const { error } = await _sb.rpc('admin_add_to_allowlist', {
      p_email: email,
      p_role: roleEl.value,
      p_note: (noteEl && noteEl.value) || null,
    });
    if (error) throw error;
    emailEl.value = ''; if (noteEl) noteEl.value = '';
    if (msg) { msg.textContent = 'Added.'; msg.style.color = '#5DAA48'; }
    _loadAllowlist();
  } catch (e) {
    if (msg) { msg.textContent = 'Failed: ' + (e.message || String(e)); msg.style.color = '#E24B4A'; }
  }
});
// Refresh buttons.
document.addEventListener('click', function (ev) {
  if (ev.target && ev.target.id === 'adminRefreshUsers') _loadUsers();
  if (ev.target && ev.target.id === 'adminRefreshAllowlist') _loadAllowlist();
});

// hook landed in the SUBTAB activation chain by mistake, where 'admin'
// never matches, so the page-refresh path didn't load the allowlist.
// This delegated handler fires on click of either the rail link or the
// topnav button, regardless of where activateTab is defined.
document.addEventListener('click', function (ev) {
  if (!ev || !ev.target || !ev.target.closest) return;
  var btn = ev.target.closest('[data-v98-tab="admin"], [data-tab="admin"]');
  if (!btn) return;
  if (typeof _v136RenderAdminTab !== 'function') return;
  // Defer slightly so the tab panel is visible before we render into it.
  setTimeout(function () { _v136RenderAdminTab(); }, 60);
});
// Also fire on initial boot if the URL hash routes straight to admin.
(function () {
  function _maybeBootAdmin() {
    if (window.location.hash !== '#admin') return;
    if (typeof _v136RenderAdminTab !== 'function') return;
    setTimeout(function () { _v136RenderAdminTab(); }, 200);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _maybeBootAdmin);
  } else {
    _maybeBootAdmin();
  }
})();
