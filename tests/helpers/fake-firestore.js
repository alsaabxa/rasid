'use strict';
// Firestore مُحاكى في الذاكرة: يحسب القراءات (كل مستند يصل = قراءة)، ويطبّق حدود العزل بين المدارس،
// ويُرسل docChanges مثل SDK الحقيقي، بما فيها صدى الكتابة المحلية قبل تأكيد الخادم.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class FakeServer {
  constructor() {
    this.docs = new Map();      // 'schools/S1/private/appMeta' -> data
    this.listeners = new Set();
    this.denied = [];           // محاولات وصول مرفوضة {device, op, path}
    this.reads = {};            // device -> عدد المستندات المقروءة
    this.queries = {};          // device -> عدد الاستعلامات
    this.writes = {};           // device -> عدد عمليات الكتابة
    this.log = [];              // {device, op, path}
  }
  device(name, schoolId) { return new FakeDb(this, name, schoolId); }
  addRead(dev, n) { this.reads[dev] = (this.reads[dev] || 0) + n; }
  addQuery(dev) { this.queries[dev] = (this.queries[dev] || 0) + 1; }
  resetCounters() { this.reads = {}; this.queries = {}; this.writes = {}; this.log = []; }
  listCollection(path) {
    const out = [];
    const prefix = path + '/';
    for (const [p, data] of this.docs) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ id: p.slice(prefix.length), data });
    }
    return out;
  }
  // تهيئة مدرسة بحجم معيّن (للاختبارات)
  seedSchool(schoolId, { students = 0, classes = 0, attendance = 0 } = {}) {
    const base = `schools/${schoolId}/private/`;
    const put = (kind, i, record) => this.docs.set(base + `v2_${kind}_${encodeURIComponent(record.id)}`,
      { kind: 'record', recordType: kind, record, order: i, schemaVersion: 2, updatedAt: { __ts: 'server' } });
    for (let i = 0; i < classes; i++) put('classes', i, { id: 'c' + i, name: 'فصل ' + i });
    for (let i = 0; i < students; i++) put('students', i, { id: 's' + i, name: 'طالبة ' + i, classId: 'c' + (i % Math.max(classes, 1)) });
    for (let i = 0; i < attendance; i++) put('attendance', i, { id: `c${i % Math.max(classes, 1)}_d${i}`, classId: 'c' + (i % Math.max(classes, 1)), date: 'd' + i, records: [] });
    this.docs.set(base + 'appMeta', { kind: 'meta', schemaVersion: 2, schoolType: 'girls', teacherNames: [], reportSignatures: { manager: '', attendance: '' }, revision: 1, updatedAt: { __ts: 'server' } });
  }
  _view(listener, phase) { // phase: 'local' يُظهر كتابة الجهاز نفسه قبل التأكيد
    const prefix = listener.path + '/';
    const cur = new Map();
    for (const [p, data] of (phase === 'local' ? this._localDocs : this.docs)) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) cur.set(p.slice(prefix.length), data);
    }
    return cur;
  }
  _deliver(listener, phase, pendingIds) {
    const cur = this._view(listener, phase);
    const changes = [];
    for (const [id, data] of cur) {
      const j = JSON.stringify(data);
      if (!listener.prev.has(id)) changes.push({ type: 'added', id, data });
      else if (listener.prev.get(id) !== j) changes.push({ type: 'modified', id, data });
    }
    for (const id of listener.prev.keys()) if (!cur.has(id)) changes.push({ type: 'removed', id, data: {} });
    if (!changes.length) return;
    listener.prev = new Map([...cur].map(([id, d]) => [id, JSON.stringify(d)]));
    this.addRead(listener.device, changes.length);
    const mk = c => ({ type: c.type, doc: { id: c.id, data: () => clone(c.data), metadata: { hasPendingWrites: !!(pendingIds && pendingIds.has(c.id)) } } });
    const snap = {
      docChanges: () => changes.map(mk),
      docs: [...cur].map(([id, d]) => ({ id, data: () => clone(d), metadata: { hasPendingWrites: false } })),
      size: cur.size, metadata: { fromCache: false, hasPendingWrites: !!(pendingIds && pendingIds.size) },
    };
    listener.next(snap);
  }
}

function checkAccess(db, op, path) {
  const segs = path.split('/');
  const bad = segs[0] === 'schools' && (segs.length === 1 || segs[1] !== db.schoolId);
  db.server.log.push({ device: db.name, op, path });
  if (bad) {
    db.server.denied.push({ device: db.name, op, path });
    const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
  }
}

class FakeDb {
  constructor(server, name, schoolId) { this.server = server; this.name = name; this.schoolId = schoolId; }
  collection(n) { return new Col(this, n); }
  batch() {
    const ops = []; const db = this;
    return {
      set(ref, data, opts) { ops.push({ type: 'set', ref, data, merge: !!(opts && opts.merge) }); },
      delete(ref) { ops.push({ type: 'delete', ref }); },
      async commit() {
        const s = db.server;
        ops.forEach(o => checkAccess(db, 'write', o.ref.path));
        const local = new Map(s.docs), served = new Map(s.docs);
        const resolve = (existing, data, stamp) => {
          const out = Object.assign({}, existing);
          for (const [k, v] of Object.entries(data)) {
            if (v && v.__op === 'inc') out[k] = (Number(existing && existing[k]) || 0) + v.n;
            else if (v && v.__op === 'ts') out[k] = { __ts: stamp };
            else out[k] = clone(v);
          }
          return out;
        };
        const pending = new Set();
        for (const o of ops) {
          s.writes[db.name] = (s.writes[db.name] || 0) + 1;
          const id = o.ref.path.split('/').pop(); pending.add(id);
          if (o.type === 'delete') { local.delete(o.ref.path); served.delete(o.ref.path); continue; }
          const ex = o.merge ? (served.get(o.ref.path) || {}) : {};
          local.set(o.ref.path, resolve(ex, o.data, 'local'));
          served.set(o.ref.path, resolve(ex, o.data, 'server'));
        }
        // 1) صدى محلي للجهاز الكاتب (hasPendingWrites=true)
        s._localDocs = local;
        for (const l of [...s.listeners]) if (l.device === db.name) s._deliver(l, 'local', pending);
        await Promise.resolve();
        // 2) تأكيد الخادم ثم وصول التغيير لبقية الأجهزة
        s.docs = served;
        for (const l of [...s.listeners]) s._deliver(l, 'server', null);
      },
    };
  }
}

class Col {
  constructor(db, path, filters) { this.db = db; this.path = path; this.filters = filters || []; }
  doc(id) { return new DocRef(this.db, this.path + '/' + id); }
  where(f, op, v) { return new Col(this.db, this.path, this.filters.concat([[f, op, v]])); }
  _rows() {
    return this.db.server.listCollection(this.path).filter(r => this.filters.every(([f, , v]) => (r.data[f] === undefined ? null : r.data[f]) === v));
  }
  async get() {
    checkAccess(this.db, 'list', this.path);
    const rows = this._rows();
    this.db.server.addQuery(this.db.name);
    this.db.server.addRead(this.db.name, Math.max(1, rows.length));
    const docs = rows.map(r => ({ id: r.id, exists: true, data: () => clone(r.data) }));
    return { docs, size: docs.length, empty: !docs.length };
  }
  onSnapshot(next, error) {
    const s = this.db.server;
    try { checkAccess(this.db, 'listen', this.path); }
    catch (e) { Promise.resolve().then(() => error && error(e)); return () => {}; }
    const listener = { device: this.db.name, path: this.path, next, prev: new Map() };
    s.listeners.add(listener); s.addQuery(this.db.name);
    s.addRead(this.db.name, 0);
    Promise.resolve().then(() => { if (s.listeners.has(listener)) { s._localDocs = s.docs; s._deliver(listener, 'server', null); if (!listener.prev.size) s.addRead(this.db.name, 1); } });
    return () => s.listeners.delete(listener);
  }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  collection(n) { return new Col(this.db, this.path + '/' + n); }
  async get() {
    checkAccess(this.db, 'get', this.path);
    this.db.server.addRead(this.db.name, 1);
    const data = this.db.server.docs.get(this.path);
    return { id: this.id, exists: data !== undefined, data: () => clone(data) };
  }
}

module.exports = { FakeServer };
