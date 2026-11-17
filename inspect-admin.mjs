
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const db = new DatabaseSync(resolve('data', 'staff.sqlite'));

try {
  const accounts = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.is_active,
      r.role_name,
      ur.status AS role_status,
      ur.expires_at
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    ORDER BY u.id
  `).all();

  if (accounts.length === 0) {
    console.log('No user accounts found in this database.');
  } else {
    console.table(accounts);
  }
} finally {
  db.close();
}
