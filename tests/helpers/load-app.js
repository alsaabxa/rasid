'use strict';
// يحمّل الدوال الحقيقية من public/index.html داخل سياق معزول لكل «جهاز»، مع ساعة افتراضية.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = process.env.RASID_INDEX || path.join(__dirname, '..', '..', 'public', 'index.html');
const SOURCE = fs.readFileSync(INDEX, 'utf8');

function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  let b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('marker not found: ' + endMarker);
  return src.slice(a, b);
}
function sectionStartingAt(src, title) { // يرجع بداية تعليق القسم «/* ===== ... title»
  const i = src.indexOf('   ' + title);
  return src.lastIndexOf('/*', i);
}
const R1 = between(SOURCE, 'function emptyCloudStore(){', 'async function persistStoreMutation(');
const authStart = sectionStartingAt(SOURCE, 'المصادقة');
const R2start = SOURCE.indexOf('let messageCountTimer = null;');
const R2 = SOURCE.slice(R2start, authStart);
const R3 = between(SOURCE, 'async function refreshMessageBadge(){', 'function messageDateLabel(');
const navStart = sectionStartingAt(SOURCE, 'التنقل');
const R4 = SOURCE.slice(SOURCE.indexOf('function logout(){'), navStart);

const PREAMBLE = `
let store = {classes:[],students:[],staff:[],attendance:[],teacherNames:[],guardians:[],whatsappContacts:[],schoolType:'girls',reportSignatures:{manager:'',attendance:''}};
let session=null, activeSchoolId=null, STORAGE_KEY='rasid_store_v1', saveTimer=null, db=null, auth={signOut(){}};
const SESSION_KEY='rasid_session';
let renderCount=0; function render(){renderCount++;}
function navigate(){}
function mergePublicAttendanceIntoStore(){}
`;

class Clock {
  constructor() { this.now = 0; this.timers = []; this.seq = 0; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.now + ms, fn, every: 0 }); return id; }
  setInterval(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.now + ms, fn, every: ms }); return id; }
  clear(id) { this.timers = this.timers.filter(t => t.id !== id); }
  get activeIntervals() { return this.timers.filter(t => t.every).length; }
  async flush() { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); }
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every) due.at += due.every; else this.timers = this.timers.filter(t => t !== due);
      try { due.fn(); } catch (e) { /* مثل المتصفح */ }
      await this.flush();
    }
    this.now = target;
    await this.flush();
  }
}

// extraFixture: كود إضافي يُنفَّذ بعد التحميل (مثلاً مزامنة الاستطلاع القديمة للمقارنة)
function createDevice(server, name, schoolId, { extraFixture = '' } = {}) {
  const clock = new Clock();
  const badge = { isConnected: true, textContent: '0' };
  const store = new Map();
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (f, ms) => clock.setTimeout(f, ms), setInterval: (f, ms) => clock.setInterval(f, ms),
    clearTimeout: id => clock.clear(id), clearInterval: id => clock.clear(id),
    navigator: { onLine: true },
    window: { addEventListener() {} },
    document: { activeElement: null, addEventListener() {}, getElementById: id => (id === 'messageCount' ? badge : null), querySelector: () => null },
    localStorage: { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) || null, removeItem: k => store.delete(k) },
    sessionStorage: { setItem() {}, getItem: () => null, removeItem() {} },
    firebase: { firestore: { FieldValue: { increment: n => ({ __op: 'inc', n }), serverTimestamp: () => ({ __op: 'ts' }) } } },
    Promise, JSON, Map, Set, Number, String, Array, Object, Date, Error, encodeURIComponent,
  };
  const ctx = vm.createContext(sandbox);
  const run = code => vm.runInContext(code, ctx);
  run(PREAMBLE);
  sandbox.db = server.device(name, schoolId);   // يُستبدل في login عند الحاجة
  run('db = globalThis.db;');
  run(R1); run(R2); run(R3); run(R4);
  if (extraFixture) run(extraFixture);

  const api = {
    name, clock, ctx, run, badge,
    async login(sid = schoolId, { asAdmin = true } = {}) {
      sandbox.db = server.device(name, sid);
      run('db = globalThis.db;');
      run(`activeSchoolId=${JSON.stringify(sid)};resetCloudSyncState(activeSchoolId);STORAGE_KEY='rasid_store_v1_'+activeSchoolId;store=emptyCloudStore();session={type:'admin',id:'u_'+activeSchoolId,name:'m',approved:true,schoolId:activeSchoolId};`);
      await run('pullFromServer(true)');
      run('startAutoSync()');
      await clock.flush();
    },
    get store() { return JSON.parse(run('JSON.stringify(store)')); },
    get revision() { return run('cloudRevision'); },
    get dirty() { return run('cloudDirty'); },
    get renders() { return run('renderCount'); },
    get indicator() { return run('syncIndicatorState'); },
    // تعديل المخزن ثم حفظه عبر المسار الحقيقي saveStore() وانتظار المؤقت
    async edit(fn) {
      sandbox.__fn = fn;
      run('__fn(store)'); run('saveStore()');
      await clock.advance(500);
      await clock.flush();
    },
    logout() { run('logout()'); },
  };
  return api;
}

module.exports = { createDevice, Clock };
