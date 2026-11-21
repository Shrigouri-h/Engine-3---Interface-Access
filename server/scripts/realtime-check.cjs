/* Ad-hoc Checkpoint 10 verification: socket auth, change events, case closure. */
const { io } = require('socket.io-client');
const { Client } = require('pg');

const BASE = 'http://127.0.0.1:4000/api';
const DB = 'postgresql://goldenhour:goldenhour@localhost:5432/goldenhour';
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

async function login(username, password) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = response.headers.getSetCookie()[0];
  return raw.split(';')[0];
}

async function call(path, cookie, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const socket = io('http://127.0.0.1:4000', {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    socket.on('realtime:ready', (payload) => {
      clearTimeout(timer);
      resolve({ socket, payload });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

(async () => {
  const db = new Client({ connectionString: DB });
  await db.connect();

  // 1. Unauthenticated handshake is refused.
  try {
    await connect(null);
    check('anonymous socket refused', 'connected', 'rejected');
  } catch (error) {
    check('anonymous socket refused', error.message, 'UNAUTHENTICATED');
  }

  const dispatcherCookie = await login('dispatch.ops', 'GoldenHour@123');
  const hospitalCookie = await login('kims.staff', 'Hospital@123');

  // 2. Authenticated handshake and room assignment.
  const dispatcher = await connect(dispatcherCookie);
  check('dispatcher socket ready', dispatcher.payload.role, 'DISPATCHER');
  const hospitalSocket = await connect(hospitalCookie);
  check('hospital socket ready', hospitalSocket.payload.role, 'HOSPITAL');

  const events = [];
  dispatcher.socket.on('data:changed', (event) => events.push(event));
  hospitalSocket.socket.on('data:changed', (event) => events.push(event));

  // 3. Queueing an emergency emits an event.
  const created = await call('/emergency-requests', dispatcherCookie, {
    method: 'POST',
    body: JSON.stringify({
      patientName: 'Realtime Check Patient',
      patientAge: 41,
      contact: '9000000123',
      lat: 15.3647,
      lon: 75.124,
      severity: 'MEDIUM',
      bloodGroupNeeded: 'A+',
      medicineNeeded: 'Adrenaline',
    }),
  });
  check('emergency created', created.status, 201);

  // 4. Pick a queued request, an AVAILABLE ambulance and a hospital with beds.
  const requestRow = (
    await db.query(
      `SELECT r.request_id FROM emergency_request r
       WHERE r.status = 'QUEUED'
         AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.request_id = r.request_id)
       ORDER BY r.request_id LIMIT 1`,
    )
  ).rows[0];
  const ambulanceRow = (
    await db.query(
      `SELECT ambulance_id FROM ambulance WHERE status = 'AVAILABLE' ORDER BY ambulance_id LIMIT 1`,
    )
  ).rows[0];
  const hospitalRow = (
    await db.query(
      `SELECT hospital_id, free_beds, total_beds FROM hospital WHERE free_beds > 0 ORDER BY hospital_id LIMIT 1`,
    )
  ).rows[0];
  if (!requestRow || !ambulanceRow || !hospitalRow) throw new Error('missing demo rows');
  const beforeBeds = hospitalRow.free_beds;

  // 4. Creating an assignment emits an event to both roles.
  const assigned = await call('/assignments', dispatcherCookie, {
    method: 'POST',
    body: JSON.stringify({
      requestId: requestRow.request_id,
      ambulanceId: ambulanceRow.ambulance_id,
      hospitalId: hospitalRow.hospital_id,
    }),
  });
  check('assign status', assigned.status, 201);
  const assignmentId = assigned.body.assignment.assignmentId;

  // 5. Hospital resource editing emits an event too.
  const edited = await call('/hospital/resources', hospitalCookie, {
    method: 'PATCH',
    body: JSON.stringify({ bloodStock: [{ group: 'A+', units: 1 }] }),
  });
  check('hospital edit status', edited.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 700));
  const entities = Array.from(new Set(events.map((event) => `${event.entity}:${event.action}`))).sort();
  check('events received', entities, ['assignment:created', 'emergency:created', 'hospital:updated']);

  // 6. Closing the case releases the ambulance and the bed.
  const closed = await call(`/assignments/${assignmentId}/close`, dispatcherCookie, {
    method: 'POST',
  });
  check('close status', closed.status, 200);
  check('close response requestStatus', closed.body.assignment.requestStatus, 'CLOSED');
  check('close response ambulance', closed.body.assignment.ambulance.status, 'AVAILABLE');
  check('bed released', closed.body.assignment.hospital.releasedBed, true);

  const afterClose = (
    await db.query(
      `SELECT a.closed_at, r.status AS request_status, am.status AS ambulance_status, h.free_beds
       FROM assignment a
       JOIN emergency_request r ON r.request_id = a.request_id
       JOIN ambulance am ON am.ambulance_id = a.ambulance_id
       JOIN hospital h ON h.hospital_id = a.hospital_id
       WHERE a.assignment_id = $1`,
      [assignmentId],
    )
  ).rows[0];
  check('db closed_at set', Boolean(afterClose.closed_at), true);
  check('db request CLOSED', afterClose.request_status, 'CLOSED');
  check('db ambulance AVAILABLE', afterClose.ambulance_status, 'AVAILABLE');
  check('db bed restored', afterClose.free_beds, beforeBeds);

  // 7. Errors.
  const again = await call(`/assignments/${assignmentId}/close`, dispatcherCookie, { method: 'POST' });
  check('second close', again.status, 409);
  check('second close code', again.body.code, 'ASSIGNMENT_ALREADY_CLOSED');

  const unknown = await call('/assignments/00000000-0000-4000-8000-000000000000/close', dispatcherCookie, { method: 'POST' });
  check('unknown assignment', unknown.status, 404);
  check('unknown code', unknown.body.code, 'ASSIGNMENT_NOT_FOUND');

  const malformed = await call('/assignments/not-a-uuid/close', dispatcherCookie, { method: 'POST' });
  check('malformed id', malformed.status, 400);

  const forbidden = await call(`/assignments/${assignmentId}/close`, hospitalCookie, { method: 'POST' });
  check('hospital staff close', forbidden.status, 403);
  const anonymous = await call(`/assignments/${assignmentId}/close`, null, { method: 'POST' });
  check('anonymous close', anonymous.status, 401);

  // 8. Closed case is no longer assignable.
  const reassign = await call('/assignments', dispatcherCookie, {
    method: 'POST',
    body: JSON.stringify({
      requestId: requestRow.request_id,
      ambulanceId: ambulanceRow.ambulance_id,
      hospitalId: hospitalRow.hospital_id,
    }),
  });
  check('closed request cannot be reassigned', reassign.status, 409);

  dispatcher.socket.close();
  hospitalSocket.socket.close();
  await db.end();
  console.log(failures === 0 ? '\nRESULT: all checks passed' : `\nRESULT: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (error) => {
  console.error('CHECK ERROR', error);
  process.exit(1);
});
