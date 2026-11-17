
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_RESET_PASSWORD;

if (!username || !password || password.length < 14) {
  console.error('Username is required and password must be at least 14 characters.');
  process.exitCode = 1;
} else {
  const db = new DatabaseSync(resolve('data', 'staff.sqlite'));

  try {
    const admin = db.prepare(`
      SELECT u.id, u.username
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE u.username = ?
        AND r.role_name = 'System Administrator'
    `).get(username);

    if (!admin) {
      throw new Error('Administrator account not found.');
    }

    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64).toString('hex');
    const passwordHash =
      `scrypt$${salt.toString('hex')}$${hash}`;

    db.prepare(`
      UPDATE users
      SET password_hash = ?, failed_login_attempts = 0
      WHERE id = ?
    `).run(passwordHash, admin.id);

    console.log(
      `Password reset successfully for ${admin.username}.`
    );
  } finally {
    db.close();
  }
}