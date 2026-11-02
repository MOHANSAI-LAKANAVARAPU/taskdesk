// Password hashing off the main thread (Scale). bcrypt at cost 10 takes about 70 ms of CPU. bcryptjs is plain JavaScript, so
// calling it directly blocks the whole server for that time: a morning sign-in rush of 600 people would freeze every other
// request for about 45 seconds. Here the work runs in a few worker threads (PASSWORD_WORKERS, default min(3, CPUs - 1), at
// least 1) while the main thread keeps answering. Same library, same hashes: existing passwords work unchanged.
//   await compare(password, hash) -> boolean        await hash(password, rounds = 10) -> string
// A queue longer than MAX_QUEUE (a flood of sign-in attempts) is refused with code BUSY instead of growing without limit.
const { Worker } = require('worker_threads');
const os = require('os');

const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const bcrypt = require(workerData.bcrypt);
parentPort.on('message', ({ id, op, a, b }) => {
  try { parentPort.postMessage({ id, ok: true, v: op === 'compare' ? bcrypt.compareSync(a, b) : bcrypt.hashSync(a, b) }); }
  catch (e) { parentPort.postMessage({ id, ok: false, e: e.message }); }
});`;
const SIZE = (n => Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 16) : Math.max(1, Math.min(3, os.cpus().length - 1)))(Number(process.env.PASSWORD_WORKERS));
const MAX_QUEUE = 2000;
const BCRYPT_PATH = require.resolve('bcryptjs');

const workers = [], queue = []; let nextId = 1;
function spawn() {
  const w = { worker: new Worker(WORKER_CODE, { eval: true, workerData: { bcrypt: BCRYPT_PATH } }), job: null };
  w.worker.unref(); // an idle pool never keeps the process alive
  w.worker.on('message', m => { const j = w.job; w.job = null; if (j) (m.ok ? j.resolve(m.v) : j.reject(new Error(m.e))); pump(); });
  w.worker.on('error', e => { console.error('[passwords] worker error:', e.message); fail(w, e); });
  w.worker.on('exit', () => fail(w, new Error('password worker stopped')));
  workers.push(w); return w;
}
function fail(w, err) { // a worker died: its job fails, and a fresh worker takes its place
  const i = workers.indexOf(w); if (i < 0) return; workers.splice(i, 1);
  if (w.job) { w.job.reject(err); w.job = null; }
  if (queue.length) { spawn(); pump(); }
}
function pump() {
  while (queue.length) {
    let w = workers.find(x => !x.job);
    if (!w && workers.length < SIZE) w = spawn();
    if (!w) return;
    const j = queue.shift(); w.job = j; w.worker.postMessage({ id: j.id, op: j.op, a: j.a, b: j.b });
  }
}
function submit(op, a, b) {
  if (queue.length >= MAX_QUEUE) return Promise.reject(Object.assign(new Error('The server is busy checking passwords. Try again in a moment.'), { code: 'BUSY' }));
  return new Promise((resolve, reject) => { queue.push({ id: nextId++, op, a, b, resolve, reject }); pump(); });
}
const compare = (password, hash) => submit('compare', String(password), String(hash));
const hash = (password, rounds = 10) => submit('hash', String(password), rounds);

module.exports = { compare, hash, SIZE, status: () => ({ workers: workers.length, size: SIZE, queued: queue.length, busy: workers.filter(w => w.job).length }) };
