'use strict';
// عزل المدارس على مستوى العميل: كل جهاز يلمس مسار مدرسته فقط، والاشتراكات تُنظَّف.
// (قواعد Firestore نفسها تُختبر في tests/rules بمُحاكي Firebase)
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeServer } = require('./helpers/fake-firestore');
const { createDevice } = require('./helpers/load-app');

function listenersOn(server, device) { return [...server.listeners].filter(l => l.device === device); }

test('مدرستان: كتابة S1 لا تصل إلى S2 ولا تظهر في مخزنها', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 2, classes: 1 });
  server.seedSchool('S2', { students: 2, classes: 1 });
  const a = createDevice(server, 'A', 'S1'), c = createDevice(server, 'C', 'S2');
  await a.login(); await c.login();
  await a.edit(st => { st.students.push({ id: 'secret', name: 'طالبة المدرسة الأولى', classId: 'c0' }); });
  assert.ok(!JSON.stringify(c.store).includes('secret'), 'S2 لا ترى سجل S1');
  assert.ok(!JSON.stringify(c.store).includes('طالبة المدرسة الأولى'));
  assert.equal(c.store.students.length, 2);
  // وكذلك العكس
  await c.edit(st => { st.students.push({ id: 'secret2', name: 'مدرسة ثانية', classId: 'c0' }); });
  assert.ok(!JSON.stringify(a.store).includes('secret2'));
});

test('العميل لا يحاول الوصول إلى مسار مدرسة أخرى أبدًا (لا رفض صلاحيات)', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 2, classes: 1 });
  server.seedSchool('S2', { students: 2, classes: 1 });
  const a = createDevice(server, 'A', 'S1'), c = createDevice(server, 'C', 'S2');
  await a.login(); await c.login();
  await a.edit(st => { st.students[0].name = 'x'; });
  await c.edit(st => { st.students[0].name = 'y'; });
  await a.clock.advance(10 * 60 * 1000); await c.clock.advance(10 * 60 * 1000);
  assert.deepEqual(server.denied, [], 'لا محاولات وصول مرفوضة');
  const foreign = (dev, sid) => server.log.filter(x => x.device === dev && x.path.startsWith('schools/') && !x.path.startsWith(`schools/${sid}/`));
  assert.deepEqual(foreign('A', 'S1'), []);
  assert.deepEqual(foreign('C', 'S2'), []);
});

test('تبديل المدرسة على الجهاز نفسه: يُلغى اشتراك القديمة ولا تتسرب بياناتها', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 2, classes: 1 });
  server.seedSchool('S2', { students: 1, classes: 1 });
  const other = createDevice(server, 'O', 'S1');
  await other.login();
  const d = createDevice(server, 'D', 'S1');
  await d.login('S1');
  assert.equal(listenersOn(server, 'D').length >= 1, true);
  const s1Listeners = () => listenersOn(server, 'D').filter(l => l.path === 'schools/S1/private').length;
  assert.equal(s1Listeners(), 1);
  await d.login('S2');                                   // تبديل إلى S2
  assert.equal(s1Listeners(), 0, 'لا اشتراك متبقٍّ على S1');
  assert.equal(listenersOn(server, 'D').filter(l => l.path === 'schools/S2/private').length, 1);
  assert.equal(d.store.students.length, 1, 'المخزن يخص S2 فقط');
  // كتابة جديدة في S1 من جهاز آخر لا تؤثر على D بعد التبديل
  const reads0 = server.reads.D || 0;
  await other.edit(st => { st.students.push({ id: 'leak', name: 'تسريب', classId: 'c0' }); });
  assert.ok(!JSON.stringify(d.store).includes('leak'));
  assert.equal(server.reads.D || 0, reads0, 'D لم يقرأ شيئًا من S1');
  assert.deepEqual(server.denied, []);
});

test('لقطة متأخرة من اشتراك المدرسة السابقة تُتجاهل', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 2, classes: 1 });
  server.seedSchool('S2', { students: 1, classes: 1 });
  const d = createDevice(server, 'D', 'S1');
  await d.login('S1');
  const oldListener = listenersOn(server, 'D').find(l => l.path === 'schools/S1/private');
  await d.login('S2');
  const before = JSON.stringify(d.store);
  // نحاكي وصول رد متأخر من الاشتراك القديم
  oldListener.next({
    docChanges: () => [{ type: 'added', doc: { id: 'v2_students_zz', data: () => ({ kind: 'record', recordType: 'students', record: { id: 'zz' }, order: 0, schemaVersion: 2 }), metadata: {} } },
      { type: 'modified', doc: { id: 'appMeta', data: () => ({ kind: 'meta', schemaVersion: 2, revision: 999 }), metadata: {} } }],
    metadata: { fromCache: false }, docs: [], size: 0,
  });
  await d.clock.flush();
  assert.equal(JSON.stringify(d.store), before);
});

test('تسجيل الخروج: لا اشتراكات ولا مؤقتات ولا قراءات بعده', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 2, classes: 1 });
  const other = createDevice(server, 'O', 'S1'); await other.login();
  const d = createDevice(server, 'D', 'S1'); await d.login();
  assert.ok(d.clock.activeIntervals >= 1, 'مؤقت العدّاد يعمل قبل الخروج');
  d.logout();
  await d.clock.flush();
  assert.equal(listenersOn(server, 'D').length, 0, 'كل الاشتراكات أُلغيت');
  assert.equal(d.clock.activeIntervals, 0, 'لا مؤقتات متكررة');
  server.resetCounters();
  await other.edit(st => { st.students.push({ id: 'after', name: 'بعد الخروج', classId: 'c0' }); });
  await d.clock.advance(30 * 60 * 1000);
  assert.equal(server.reads.D || 0, 0, 'لا قراءات بعد الخروج');
  assert.equal(d.run('activeSchoolId'), null);
});

test('إعادة تشغيل المزامنة مرارًا لا تُراكم اشتراكات', async () => {
  const server = new FakeServer();
  server.seedSchool('S1', { students: 1, classes: 1 });
  const d = createDevice(server, 'D', 'S1'); await d.login();
  for (let i = 0; i < 5; i++) { d.run('startAutoSync()'); await d.clock.flush(); }
  assert.equal(listenersOn(server, 'D').length, 2, 'اشتراكان فقط: private وpublicAttendance');
  assert.equal(d.clock.activeIntervals, 1, 'مؤقت واحد (عدّاد الرسائل)');
});
