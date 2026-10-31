'use strict';
// اختبارات المستمع اللحظي على الدوال الحقيقية في public/index.html
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeServer } = require('./helpers/fake-firestore');
const { createDevice } = require('./helpers/load-app');

async function twoDevices(seed = { students: 3, classes: 1 }) {
  const server = new FakeServer();
  server.seedSchool('S1', seed);
  const a = createDevice(server, 'A', 'S1'), b = createDevice(server, 'B', 'S1');
  await a.login(); await b.login();
  server.resetCounters();
  return { server, a, b };
}

test('إضافة سجل من جهاز تظهر على الجهاز الآخر دون سحب كامل', async () => {
  const { server, a, b } = await twoDevices();
  await a.edit(st => st.students.push({ id: 'new', name: 'جديدة', classId: 'c0' }));
  assert.ok(b.store.students.some(s => s.id === 'new'), 'السجل المضاف يصل إلى B');
  assert.equal(b.store.students.length, 4);
  assert.equal(server.queries.B || 0, 0, 'B لم ينفّذ أي استعلام قراءة (get)');
});

test('تعديل سجل يصل، وترتيب السجلات محفوظ', async () => {
  const { a, b } = await twoDevices();
  await a.edit(st => { st.students[1].name = 'معدّلة'; });
  assert.equal(b.store.students[1].name, 'معدّلة');
  assert.deepEqual(b.store.students.map(s => s.id), ['s0', 's1', 's2']);
});

test('حذف سجل يصل إلى الجهاز الآخر', async () => {
  const { a, b } = await twoDevices();
  await a.edit(st => { st.students = st.students.filter(s => s.id !== 's1'); });
  assert.deepEqual(b.store.students.map(s => s.id), ['s0', 's2']);
});

test('تغييرات appMeta (التواقيع وأسماء المعلمات) تصل', async () => {
  const { a, b } = await twoDevices();
  await a.edit(st => { st.reportSignatures.manager = 'المديرة'; st.teacherNames.push('أ. سارة'); });
  assert.equal(b.store.reportSignatures.manager, 'المديرة');
  assert.deepEqual(b.store.teacherNames, ['أ. سارة']);
});

test('حماية التعديل المحلي: لا يُستبدل ما دام غير محفوظ، ثم يُدمج ما وصل بعد الحفظ', async () => {
  const { a, b } = await twoDevices();
  // B لديه تعديل محلي لم يُرسَل بعد (نمنع المؤقت من الإرسال)
  b.run('store.students[0].name="محلي"; localRevision++; cloudDirty=true;');
  await a.edit(st => { st.students[2].name = 'بعيد'; });
  assert.equal(b.store.students[0].name, 'محلي', 'التعديل المحلي لم يُمسح');
  assert.equal(b.store.students[2].name, 'طالبة 2', 'التغيير البعيد ما زال معلّقًا');
  // يكتمل حفظ B
  b.run('cloudDirty=false;');
  await b.clock.advance(1500);
  assert.equal(b.store.students[2].name, 'بعيد', 'طُبّق التغيير المعلّق بعد زوال حالة التعديل');
});

test('صدى كتابة الجهاز نفسه لا يعيد الرسم ولا يغيّر الحالة', async () => {
  const { a } = await twoDevices();
  const r0 = a.renders;
  await a.edit(st => { st.students[0].name = 'أنا'; });
  await a.clock.advance(2000);
  assert.equal(a.renders, r0, 'لا إعادة رسم لكتابة الجهاز نفسه');
  assert.equal(a.store.students[0].name, 'أنا');
  assert.equal(a.dirty, false);
});

test('تعديلان متتاليان من A يصلان إلى B بالترتيب ويبقى B بلا تعديل متروك', async () => {
  const { a, b } = await twoDevices();
  await a.edit(st => { st.students[0].name = 'x1'; });
  await a.edit(st => { st.students[0].name = 'x2'; st.students.push({ id: 'n1', name: 'ن', classId: 'c0' }); });
  assert.equal(b.store.students[0].name, 'x2');
  assert.equal(b.store.students.length, 4);
  assert.equal(b.revision, a.revision);
});

test('إعادة الرسم لا تحدث أثناء كتابة المستخدم في حقل إدخال', async () => {
  const { a, b } = await twoDevices();
  b.ctx.document.activeElement = { tagName: 'INPUT' };
  const r0 = b.renders;
  await a.edit(st => { st.students[0].name = 'تغيير'; });
  assert.equal(b.renders, r0, 'لم يُعد الرسم أثناء الإدخال');
  assert.equal(b.store.students[0].name, 'تغيير', 'لكن البيانات حُدّثت');
});

test('لا يوجد استطلاع دوري: مرور ساعة بلا تغييرات = لا قراءة من private', async () => {
  const { server, b } = await twoDevices();
  await b.clock.advance(60 * 60 * 1000);
  const privateReads = server.log.filter(x => x.device === 'B' && x.path.endsWith('/private') && x.op !== 'listen');
  assert.equal(privateReads.length, 0, 'لا get على private');
  assert.ok((server.reads.B || 0) <= 13, `فقط عدّاد الرسائل: ${server.reads.B}`);
});

test('الاستماع مستمر بعد انتهاء المزامنة: ما يصل أثناء حفظ طويل لا يضيع', async () => {
  const { a, b } = await twoDevices();
  b.run('cloudDirty=true;');
  await a.edit(st => { st.students.push({ id: 'p1', name: 'ص', classId: 'c0' }); });
  await a.edit(st => { st.students.push({ id: 'p2', name: 'ص', classId: 'c0' }); });
  b.run('cloudDirty=false;');
  await b.clock.advance(1500);
  assert.deepEqual(b.store.students.map(s => s.id).slice(-2), ['p1', 'p2']);
});

test('رفض الصلاحيات يُظهر «منقطع» ثم يعود «محدّث» عند وصول لقطة سليمة', async () => {
  const { a, b } = await twoDevices();
  b.run('setSyncIndicator("disconnected")');
  await a.edit(st => { st.students[0].name = 'يعود'; });
  assert.equal(b.indicator, 'synced');
});
