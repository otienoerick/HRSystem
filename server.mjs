import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || (process.env.VERCEL ? '/tmp' : resolve(root, 'data')));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(resolve(dataDir, 'staff.sqlite'));
db.exec(readFileSync(resolve(root, 'database/schema.sql'), 'utf8'));
db.exec("INSERT OR IGNORE INTO roles(role_name,description) VALUES ('System Administrator','Full system administration'),('HR Officer','Staff and leave administration'),('Supervisor','First-stage leave review'),('Final Approver','Final leave decision'),('Employee','Own profile and leave requests'),('Auditor','Read-only audit access');");
db.exec("INSERT OR IGNORE INTO leave_types(leave_code,leave_name,default_annual_entitlement,allow_half_day) VALUES ('ANNUAL','Annual Leave',0,1),('SICK','Sick Leave',0,0),('COMP','Compassionate Leave',0,0)");

const sessions = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const stmt = (sql) => db.prepare(sql);
const rolesFor = (userId) => stmt("SELECT r.role_name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=? AND ur.status='active' AND (ur.expires_at IS NULL OR ur.expires_at>CURRENT_TIMESTAMP)").all(userId).map(x=>x.role_name);
const audit = (userId, action, entity, id, before=null, after=null) => stmt('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,old_values,new_values) VALUES(?,?,?,?,?,?)').run(userId,action,entity,String(id),before?JSON.stringify(before):null,after?JSON.stringify(after):null);
const safeUser = (u) => ({id:u.id,username:u.username,email:u.email,employee_id:u.employee_id,roles:rolesFor(u.id)});
function send(res, code, data) { res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req) { let raw=''; for await (const c of req) { raw+=c; if(raw.length>1_000_000) throw Error('Request too large'); } return raw?JSON.parse(raw):{}; }
function pwHash(password) { const salt=randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(password,salt,64).toString('hex')}`; }
function pwOk(password, stored) { try { const [,s,h]=stored.split('$'); const actual=scryptSync(password,Buffer.from(s,'hex'),64); return timingSafeEqual(actual,Buffer.from(h,'hex')); } catch { return false; } }

async function handler(req,res) {
  const url=new URL(req.url,'http://localhost'); const path=url.pathname;
  if(req.method==='GET' && path!=='/api/me' && !path.startsWith('/api/')) {
    const file=path==='/'?'index.html':path.slice(1); const full=resolve(root,'public',file);
    if(!full.startsWith(resolve(root,'public'))) return send(res,404,{error:'Not found'});
    if(existsSync(full)) { res.writeHead(200,{'content-type':mime[extname(full)]||'application/octet-stream'}); return res.end(readFileSync(full)); }
  }
  const sid=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('sid='))?.slice(4);
  const userId=sessions.get(sid); const user=userId?stmt('SELECT * FROM users WHERE id=? AND is_active=1').get(userId):null;
  const roles=user?safeUser(user).roles:[];
  const requireAuth=()=> { if(!user) { send(res,401,{error:'Sign in required'}); return false; } return true; };
  const requireRole=(...allowed)=> { if(!requireAuth()) return false; if(!roles.some(r=>allowed.includes(r))) { send(res,403,{error:'Permission denied'}); return false; } return true; };
  try {
    if(req.method==='POST' && path==='/api/setup') {
      const b=await body(req); const secret=process.env.SETUP_TOKEN;
      if(!secret || b.setup_token!==secret) return send(res,403,{error:'Initial setup is disabled or token is invalid'});
      if(stmt('SELECT count(*) n FROM users').get().n>0) return send(res,409,{error:'An account already exists'});
      if(!b.username || !b.password || b.password.length<14) return send(res,400,{error:'Username and a password of at least 14 characters are required'});
      const created=stmt('INSERT INTO users(username,email,password_hash,is_staff) VALUES(?,?,?,1)').run(b.username,b.email||null,pwHash(b.password));
      const rid=stmt("SELECT id FROM roles WHERE role_name='System Administrator'").get().id;
      stmt('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)').run(created.lastInsertRowid,rid); audit(created.lastInsertRowid,'initial_admin_created','users',created.lastInsertRowid);
      return send(res,201,{created:true});
    }
    if(req.method==='POST' && path==='/api/login') {
      const b=await body(req); const u=stmt('SELECT * FROM users WHERE username=?').get(b.username||'');
      if(!u || !u.is_active || !pwOk(b.password||'',u.password_hash)) return send(res,401,{error:'Invalid username or password'});
      const token=randomBytes(32).toString('hex'); sessions.set(token,u.id); stmt('UPDATE users SET last_login=CURRENT_TIMESTAMP,failed_login_attempts=0 WHERE id=?').run(u.id);
      res.writeHead(200,{'content-type':'application/json','set-cookie':`sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.VERCEL ? '; Secure' : ''}`,'cache-control':'no-store'}); return res.end(JSON.stringify({user:safeUser(u)}));
    }
    if(req.method==='POST' && path==='/api/logout') { if(sid) sessions.delete(sid); res.writeHead(200,{'content-type':'application/json','set-cookie':`sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`}); return res.end('{"ok":true}'); }
    if(req.method==='GET' && path==='/api/me') { if(!requireAuth()) return; return send(res,200,{user:safeUser(user)}); }
    if(req.method==='GET' && path==='/api/summary') { if(!requireAuth()) return; return send(res,200,{employees:stmt("SELECT count(*) n FROM employees WHERE employment_status='active'").get().n,requests:stmt("SELECT count(*) n FROM leave_requests WHERE request_status NOT IN ('Approved','Rejected','Cancelled')").get().n,departments:stmt("SELECT count(*) n FROM departments WHERE status='active'").get().n}); }
    if(req.method==='GET' && path==='/api/employees') { if(!requireAuth()) return; const q=`%${url.searchParams.get('q')||''}%`; const rows=stmt('SELECT e.*,d.department_name,g.designation_name FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations g ON g.id=e.designation_id WHERE e.employee_number LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ? ORDER BY e.last_name,e.first_name LIMIT 200').all(q,q,q); return send(res,200,rows); }
    if(req.method==='POST' && path==='/api/employees') { if(!requireRole('System Administrator','HR Officer')) return; const b=await body(req); if(!b.employee_number||!b.first_name||!b.last_name) return send(res,400,{error:'Employee number, first name and last name are required'}); try { const r=stmt('INSERT INTO employees(employee_number,first_name,middle_name,last_name,institutional_email,phone_number,department_id,designation_id,employment_type,date_joined,employment_status,supervisor_employee_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(b.employee_number,b.first_name,b.middle_name||null,b.last_name,b.institutional_email||null,b.phone_number||null,b.department_id||null,b.designation_id||null,b.employment_type||'permanent',b.date_joined||null,b.employment_status||'active',b.supervisor_employee_id||null,user.id); audit(user.id,'created','employees',r.lastInsertRowid,null,b); return send(res,201,{id:r.lastInsertRowid}); } catch(e) { return send(res,400,{error:e.message.includes('UNIQUE')?'Employee number already exists':e.message}); } }
  if (req.method === 'GET' && path === '/api/users') {
  if (!requireRole('System Administrator')) return;

  const users = stmt(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.employee_id,
      u.is_staff,
      GROUP_CONCAT(r.role_name, ', ') AS roles
    FROM users u
    LEFT JOIN user_roles ur
      ON ur.user_id = u.id
      AND ur.status = 'active'
      AND (ur.expires_at IS NULL OR ur.expires_at > CURRENT_TIMESTAMP)
    LEFT JOIN roles r ON r.id = ur.role_id
    GROUP BY u.id
    ORDER BY u.username
  `).all();

  return send(res, 200, users);
}  if(req.method==='POST' && path==='/api/users') { if(!requireRole('System Administrator')) return; const b=await body(req); if(!b.username||!b.password||b.password.length<14) return send(res,400,{error:'Username and password of at least 14 characters are required'}); if(!b.role_name||!stmt('SELECT id FROM roles WHERE role_name=?').get(b.role_name)) return send(res,400,{error:'Unknown role'}); try { const emp=b.employee_id?stmt('SELECT id FROM employees WHERE id=?').get(b.employee_id):null; if(b.employee_id&&!emp) return send(res,400,{error:'Employee not found'}); const u=stmt('INSERT INTO users(username,email,employee_id,password_hash,is_staff) VALUES(?,?,?,?,?)').run(b.username,b.email||null,b.employee_id||null,pwHash(b.password),['System Administrator','HR Officer'].includes(b.role_name)?1:0); const role=stmt('SELECT id FROM roles WHERE role_name=?').get(b.role_name); stmt('INSERT INTO user_roles(user_id,role_id,assigned_by) VALUES(?,?,?)').run(u.lastInsertRowid,role.id,user.id); audit(user.id,'created','users',u.lastInsertRowid,null,{username:b.username,role_name:b.role_name,employee_id:b.employee_id||null}); return send(res,201,{id:u.lastInsertRowid}); } catch(e) { return send(res,400,{error:e.message.includes('UNIQUE')?'Username, email, employee, or role assignment already exists':e.message}); } }
    if(req.method==='POST' && path==='/api/leave-balances') { if(!requireRole('System Administrator','HR Officer')) return; const b=await body(req); const emp=stmt('SELECT id FROM employees WHERE id=?').get(b.employee_id), type=stmt('SELECT id FROM leave_types WHERE id=?').get(b.leave_type_id); const amount=Number(b.days); if(!emp||!type||!Number.isFinite(amount)||amount<=0) return send(res,400,{error:'Valid employee, leave type and positive credit required'}); db.exec('BEGIN IMMEDIATE'); try { const balance=stmt('SELECT COALESCE(sum(days_credited-days_debited),0) n FROM leave_transactions WHERE employee_id=? AND leave_type_id=?').get(b.employee_id,b.leave_type_id).n; const reference=b.reference_number||`OPEN-${b.employee_id}-${b.leave_type_id}-${new Date().getFullYear()}`; const tx=stmt("INSERT INTO leave_transactions(employee_id,leave_type_id,transaction_type,days_credited,balance_after,reference_number,description,created_by) VALUES(?,?,'opening_balance',?,?,?,?,?)").run(b.employee_id,b.leave_type_id,amount,balance+amount,reference,b.description||'Opening leave balance',user.id); audit(user.id,'credited','leave_transactions',tx.lastInsertRowid,null,b); db.exec('COMMIT'); return send(res,201,{id:tx.lastInsertRowid,balance_after:balance+amount}); } catch(e) { db.exec('ROLLBACK'); return send(res,400,{error:e.message}); } }
    if(req.method==='GET' && path==='/api/departments') { if(!requireAuth()) return; return send(res,200,stmt('SELECT * FROM departments ORDER BY department_name').all()); }
    if(req.method==='POST' && path==='/api/departments') { if(!requireRole('System Administrator','HR Officer')) return; const b=await body(req); try { const r=stmt('INSERT INTO departments(department_code,department_name,description) VALUES(?,?,?)').run(b.department_code,b.department_name,b.description||null); audit(user.id,'created','departments',r.lastInsertRowid,null,b); return send(res,201,{id:r.lastInsertRowid}); } catch(e) { return send(res,400,{error:e.message}); } }
    if(req.method==='GET' && path==='/api/leave-types') { if(!requireAuth()) return; return send(res,200,stmt("SELECT * FROM leave_types WHERE status='active' ORDER BY leave_name").all()); }
    if(req.method==='GET' && path==='/api/leave-requests') { if(!requireAuth()) return; let rows; if(roles.some(r=>['System Administrator','HR Officer','Final Approver','Auditor'].includes(r))) rows=stmt('SELECT lr.*,e.employee_number,e.first_name,e.last_name,lt.leave_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN leave_types lt ON lt.id=lr.leave_type_id ORDER BY lr.submitted_at DESC LIMIT 300').all(); else if(roles.includes('Supervisor')&&user.employee_id) rows=stmt('SELECT lr.*,e.employee_number,e.first_name,e.last_name,lt.leave_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE e.supervisor_employee_id=? OR lr.employee_id=? ORDER BY lr.submitted_at DESC LIMIT 300').all(user.employee_id,user.employee_id); else rows=stmt('SELECT lr.*,e.employee_number,e.first_name,e.last_name,lt.leave_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.employee_id=? ORDER BY lr.submitted_at DESC LIMIT 300').all(user.employee_id||-1); return send(res,200,rows); }
    if(req.method==='POST' && path==='/api/leave-requests') { if(!requireAuth()) return; const b=await body(req); const emp=user.employee_id?stmt('SELECT * FROM employees WHERE id=?').get(user.employee_id):null; if(!emp) return send(res,400,{error:'Link this account to an employee record before applying for leave'}); if(!b.leave_type_id||!b.start_date||!b.end_date||!b.reason||!Number.isFinite(Number(b.requested_working_days))||Number(b.requested_working_days)<=0) return send(res,400,{error:'Provide leave type, valid dates, reason and positive working days'}); if(b.end_date<b.start_date) return send(res,400,{error:'End date cannot precede start date'}); if(!emp.supervisor_employee_id) return send(res,400,{error:'Employee has no designated supervisor'}); if(stmt("SELECT 1 FROM leave_requests WHERE employee_id=? AND request_status IN ('Submitted','Supervisor Review','HR Review','Final Approval','Approved') AND start_date<=? AND end_date>=?").get(emp.id,b.end_date,b.start_date)) return send(res,409,{error:'Leave dates overlap an existing request'}); const ref=`LR-${Date.now()}-${randomBytes(2).toString('hex').toUpperCase()}`; const tx=db.prepare('INSERT INTO leave_requests(request_reference,employee_id,leave_type_id,start_date,end_date,half_day_indicator,requested_working_days,reason,current_approval_stage) VALUES(?,?,?,?,?,?,?,?,?)'); const r=tx.run(ref,emp.id,b.leave_type_id,b.start_date,b.end_date,b.half_day_indicator?1:0,Number(b.requested_working_days),b.reason,'Supervisor'); audit(user.id,'submitted','leave_requests',r.lastInsertRowid,null,b); return send(res,201,{id:r.lastInsertRowid,request_reference:ref}); }
    const approvalMatch=path.match(/^\/api\/leave-requests\/(\d+)\/decision$/);
    if(req.method==='POST'&&approvalMatch) { if(!requireRole('Supervisor','HR Officer','Final Approver','System Administrator')) return; const id=Number(approvalMatch[1]),b=await body(req),request=stmt('SELECT * FROM leave_requests WHERE id=?').get(id); if(!request) return send(res,404,{error:'Request not found'}); const stage=request.current_approval_stage; const need={'Supervisor':'Supervisor','HR':'HR Officer','Final Approver':'Final Approver'}[stage]; if(!need||(!roles.includes(need)&&!roles.includes('System Administrator'))) return send(res,403,{error:'This request is not at a stage assigned to your role'}); if(user.employee_id===request.employee_id) return send(res,403,{error:'You cannot approve your own leave'}); if(stage==='Supervisor'&&!roles.includes('System Administrator')) { const emp=stmt('SELECT supervisor_employee_id FROM employees WHERE id=?').get(request.employee_id); if(!user.employee_id||emp.supervisor_employee_id!==user.employee_id) return send(res,403,{error:'Only the employee’s designated supervisor may act at this stage'}); } if(stmt('SELECT 1 FROM leave_approvals WHERE leave_request_id=? AND approver_user_id=? AND decision=\'approved\'').get(id,user.id)) return send(res,403,{error:'The same user cannot approve this request at multiple stages'}); if(!['approved','rejected','returned'].includes(b.decision)) return send(res,400,{error:'Decision must be approved, rejected, or returned'}); if((b.decision==='rejected'||b.decision==='returned')&&!b.comments?.trim()) return send(res,400,{error:'A comment is required for rejection or return'});
      db.exec('BEGIN IMMEDIATE'); try { const current=stmt('SELECT * FROM leave_requests WHERE id=?').get(id); if(current.current_approval_stage!==stage||!['Submitted','Supervisor Review','HR Review','Final Approval'].includes(current.request_status)) throw Error('Request was already actioned'); stmt('INSERT INTO leave_approvals(leave_request_id,approval_stage,approver_user_id,decision,comments,action_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').run(id,stage,user.id,b.decision,b.comments||null); const next={'Supervisor':['HR','HR Review'],'HR':['Final Approver','Final Approval']}[stage]; if(b.decision==='approved'&&next) stmt('UPDATE leave_requests SET current_approval_stage=?,request_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next[0],next[1],id); else if(b.decision==='approved') { const available=stmt('SELECT COALESCE(sum(days_credited-days_debited),0) n FROM leave_transactions WHERE employee_id=? AND leave_type_id=?').get(request.employee_id,request.leave_type_id).n; if(available<request.requested_working_days) throw Error('Insufficient available balance at final approval'); const balance=Number((available-request.requested_working_days).toFixed(2)); stmt('INSERT INTO leave_transactions(employee_id,leave_type_id,leave_request_id,transaction_type,days_debited,balance_after,reference_number,description,created_by) VALUES(?,?,? ,\'approved_leave_debit\',?,?,?, ?,?)').run(request.employee_id,request.leave_type_id,id,request.requested_working_days,balance,request.request_reference,'Final approval debit',user.id); stmt('UPDATE leave_requests SET request_status=\'Approved\',updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id); }
      else stmt('UPDATE leave_requests SET request_status=?,current_approval_stage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.decision==='rejected'?'Rejected':'Returned for correction',b.decision==='returned'?stage:'Complete',id); audit(user.id,b.decision,'leave_requests',id,request,{decision:b.decision,comments:b.comments}); db.exec('COMMIT'); return send(res,200,{ok:true}); } catch(e) { db.exec('ROLLBACK'); return send(res,409,{error:e.message}); } }
    if(req.method==='GET' && path==='/api/audit') { if(!requireRole('System Administrator','Auditor')) return; return send(res,200,stmt('SELECT a.id,a.user_id,u.username,a.action,a.entity_type,a.entity_id,a.created_at FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500').all()); }
    if(path.startsWith('/api/')) return send(res,404,{error:'API route not found'});
  } catch(e) { return send(res,400,{error:e.message||'Invalid request'}); }
  return send(res,404,{error:'Not found'});
}
export { handler };

// Local development server. Vercel imports the handler from api/index.mjs.
if (!process.env.VERCEL) {
  const port=Number(process.env.PORT||8080);
  createServer((req,res)=>handler(req,res)).listen(port,'127.0.0.1',()=>console.log(`Staff management app listening on http://127.0.0.1:${port}`));
}
