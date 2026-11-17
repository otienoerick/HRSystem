
const $ = s => document.querySelector(s);
const content = $('#content');

let me = null;

const availableRoles = [
  'System Administrator',
  'HR Officer',
  'Supervisor',
  'Final Approver',
  'Employee',
  'Auditor'
];

async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw Error(data.error || 'Request failed');
  }

  return data;
}

function notice(message) {
  const element = $('#notice');
  element.textContent = message;
  element.classList.add('show');

  setTimeout(() => element.classList.remove('show'), 3500);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function isAdmin() {
  return Array.isArray(me?.roles) &&
    me.roles.includes('System Administrator');
}

function show() {
  $('#login').hidden = !!me;
  $('#app').hidden = !me;

  $('#account').innerHTML = me
    ? `${esc(me.username)} <button id="logout" class="secondary">Sign out</button>`
    : '';

  const usersNav = $('#usersNav');
  if (usersNav) usersNav.hidden = !isAdmin();

  $('#logout')?.addEventListener('click', async () => {
    try {
      await api('/logout', { method: 'POST' });
    } finally {
      me = null;
      show();
    }
  });

  if (me) page('overview');
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();

  const values = Object.fromEntries(new FormData(event.target));

  try {
    me = (await api('/login', {
      method: 'POST',
      body: JSON.stringify(values)
    })).user;

    show();
  } catch (error) {
    notice(error.message);
  }
});

document.querySelectorAll('nav button[data-page]').forEach(button => {
  button.addEventListener('click', () => page(button.dataset.page));
});

async function page(name) {
  try {
    if (name === 'overview') {
      const summary = await api('/summary');

      content.innerHTML = `
        <h1>Overview</h1>
        <p>Welcome, ${esc(me.username)}. Access follows your assigned role.</p>
        <div class="grid">
          <div class="card">Active staff<strong>${esc(summary.employees)}</strong></div>
          <div class="card">Open leave requests<strong>${esc(summary.requests)}</strong></div>
          <div class="card">Departments<strong>${esc(summary.departments)}</strong></div>
        </div>`;
    }

    if (name === 'employees') {
      const rows = await api('/employees');

      content.innerHTML = `
        <h1>Staff directory</h1>
        <p>Search results show up to 200 staff records.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Staff number</th><th>Name</th>
                <th>Department</th><th>Designation</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(employee => `
                <tr>
                  <td>${esc(employee.employee_number)}</td>
                  <td>${esc(employee.first_name)} ${esc(employee.last_name)}</td>
                  <td>${esc(employee.department_name || '—')}</td>
                  <td>${esc(employee.designation_name || '—')}</td>
                  <td><span class="tag">${esc(employee.employment_status)}</span></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    if (name === 'leave') {
      const rows = await api('/leave-requests');

      content.innerHTML = `
        <h1>Leave requests</h1>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th><th>Employee</th><th>Leave type</th>
                <th>Dates</th><th>Stage / status</th><th>Decision</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(request => `
                <tr>
                  <td>${esc(request.request_reference)}</td>
                  <td>${esc(request.first_name)} ${esc(request.last_name)}</td>
                  <td>${esc(request.leave_name)}</td>
                  <td>${esc(request.start_date)} – ${esc(request.end_date)}
                    (${esc(request.requested_working_days)} days)</td>
                  <td>${esc(request.current_approval_stage)} / ${esc(request.request_status)}</td>
                  <td>
                    ${['Submitted', 'Supervisor Review', 'HR Review', 'Final Approval']
                      .includes(request.request_status)
                      ? `<div class="actions">
                           <button data-decision="approved" data-id="${request.id}">Approve</button>
                           <button class="reject" data-decision="rejected"
                             data-id="${request.id}">Reject</button>
                         </div>`
                      : '—'}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      content.querySelectorAll('[data-decision]').forEach(button => {
        button.addEventListener('click', async () => {
          const decision = button.dataset.decision;
          const comments = decision === 'rejected'
            ? prompt('Reason for rejection:')
            : '';

          if (decision === 'rejected' && !comments?.trim()) return;

          try {
            await api(`/leave-requests/${button.dataset.id}/decision`, {
              method: 'POST',
              body: JSON.stringify({ decision, comments })
            });

            notice('Decision saved');
            page('leave');
          } catch (error) {
            notice(error.message);
          }
        });
      });
    }

    if (name === 'apply') {
      const types = await api('/leave-types');

      content.innerHTML = `
        <h1>Apply for leave</h1>
        <article>
          <form id="leaveForm">
            <label>Leave type
              <select name="leave_type_id" required>
                ${types.map(type => `<option value="${type.id}">${esc(type.leave_name)}</option>`).join('')}
              </select>
            </label>
            <label>Start date<input name="start_date" type="date" required></label>
            <label>End date<input name="end_date" type="date" required></label>
            <label>Working days requested
              <input name="requested_working_days" type="number" min="0.5" step="0.5" required>
            </label>
            <label>Reason<textarea name="reason" required></textarea></label>
            <button>Submit request</button>
          </form>
          <p class="muted">Working days are entered by the applicant in this starter version.
          Verify institutional calendar rules before production use.</p>
        </article>`;

      $('#leaveForm').addEventListener('submit', async event => {
        event.preventDefault();

        const values = Object.fromEntries(new FormData(event.target));
        values.leave_type_id = Number(values.leave_type_id);
        values.requested_working_days = Number(values.requested_working_days);

        try {
          const result = await api('/leave-requests', {
            method: 'POST',
            body: JSON.stringify(values)
          });

          notice(`Submitted ${result.request_reference}`);
          page('leave');
        } catch (error) {
          notice(error.message);
        }
      });
    }

    if (name === 'users') {
      if (!isAdmin()) {
        notice('Only System Administrators can manage users.');
        return;
      }

      const [users, employees] = await Promise.all([
        api('/users'),
        api('/employees')
      ]);

      content.innerHTML = `
        <h1>Manage Users</h1>
        <p>Create institutional accounts and assign system roles.</p>

        <article>
          <h2>Create user account</h2>
          <form id="userForm">
            <label>Username
              <input name="username" autocomplete="off" required>
            </label>

            <label>Email address
              <input name="email" type="email">
            </label>

            <label>Link to staff record
              <select name="employee_id">
                <option value="">No staff record linked</option>
                ${employees.map(employee => `
                  <option value="${employee.id}">
                    ${esc(employee.employee_number)} —
                    ${esc(employee.first_name)} ${esc(employee.last_name)}
                  </option>`).join('')}
              </select>
            </label>

            <label>System role
              <select name="role_name" required>
                ${availableRoles.map(role =>
                  `<option value="${esc(role)}">${esc(role)}</option>`
                ).join('')}
              </select>
            </label>

            <label>Temporary password
              <input name="password" type="password"
                minlength="14" autocomplete="new-password" required>
            </label>

            <p class="muted">
              The password must contain at least 14 characters.
              Provide the initial password securely to the account holder.
            </p>

            <button type="submit">Create account</button>
          </form>
        </article>

        <article>
          <h2>Existing user accounts</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th><th>Username</th><th>Email</th>
                  <th>Employee ID</th><th>Role(s)</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(user => `
                  <tr>
                    <td>${esc(user.id)}</td>
                    <td>${esc(user.username)}</td>
                    <td>${esc(user.email || '—')}</td>
                    <td>${esc(user.employee_id ?? '—')}</td>
                    <td>${esc(user.roles || 'No active role')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </article>`;

      $('#userForm').addEventListener('submit', async event => {
        event.preventDefault();

        const values = Object.fromEntries(new FormData(event.target));

        if (values.employee_id) {
          values.employee_id = Number(values.employee_id);
        } else {
          delete values.employee_id;
        }

        try {
          await api('/users', {
            method: 'POST',
            body: JSON.stringify(values)
          });

          notice('User account created successfully.');
          page('users');
        } catch (error) {
          notice(error.message);
        }
      });
    }
  } catch (error) {
    notice(error.message);
  }
}

try {
  me = (await api('/me')).user;
} catch {
  me = null;
}

show();