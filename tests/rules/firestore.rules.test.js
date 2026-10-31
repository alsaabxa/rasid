'use strict';
// اختبار قواعد Firestore بمُحاكي Firebase (يتطلب Java وFirebase CLI):
//   npm install && npm run test:rules
// يتحقق من عزل المدارس، ومن أن المستمع اللحظي (list على private) مسموح للمدرسة المعتمدة لمدرستها فقط.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, getDocs, updateDoc, deleteDoc, collection, serverTimestamp, Timestamp } = require('firebase/firestore');

const OWNER = { email: 'ahiixd6@gmail.com', email_verified: true };
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rasid-rules',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8') },
  });
});
test.after(async () => { await env.cleanup(); });
test.beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const meta = { kind: 'meta', schemaVersion: 2, schoolType: 'girls', teacherNames: [], reportSignatures: { manager: '', attendance: '' }, revision: 1 };
    const rec = { kind: 'record', recordType: 'students', record: { id: '1', name: 'x' }, order: 0, schemaVersion: 2 };
    for (const sid of ['schoolA', 'schoolB']) {
      await setDoc(doc(db, 'users', 'u_' + sid), { email: sid + '@x.com', schoolName: sid, schoolId: sid, schoolType: 'girls', status: 'approved' });
      await setDoc(doc(db, 'schools', sid), { name: sid });
      await setDoc(doc(db, 'schools', sid, 'private', 'appMeta'), meta);
      await setDoc(doc(db, 'schools', sid, 'private', 'v2_students_1'), rec);
      await setDoc(doc(db, 'schools', sid, 'publicAttendance', 'v1'), { classId: 'c', date: '2026-10-31', absentIds: [] });
      await setDoc(doc(db, 'schools', sid, 'messages', 'm1'), { subject: 's', body: 'b', category: 'update', senderRole: 'support', senderLabel: 'دعم راصد', sentAt: Timestamp.now(), readAt: null, schemaVersion: 1 });
    }
    await setDoc(doc(db, 'users', 'u_pending'), { email: 'p@x.com', schoolName: 'P', schoolId: 'schoolP', schoolType: 'girls', status: 'pending' });
    await setDoc(doc(db, 'schools', 'schoolP'), { name: 'P' });
    await setDoc(doc(db, 'schools', 'schoolP', 'private', 'appMeta'), meta);
    await setDoc(doc(db, 'schools', 'schoolExpired'), { name: 'E', trialEndsAt: Timestamp.fromMillis(Date.now() - 86400000) });
    await setDoc(doc(db, 'users', 'u_expired'), { email: 'e@x.com', schoolName: 'E', schoolId: 'schoolExpired', schoolType: 'girls', status: 'approved' });
    await setDoc(doc(db, 'schools', 'schoolExpired', 'private', 'appMeta'), meta);
    await setDoc(doc(db, 'schools', 'schoolA', 'publicClasses', 'c1'), { classId: 'c1', className: 'ف', schoolName: 'A', schoolType: 'girls', students: { s1: 'x' }, updatedAt: Timestamp.now() });
  });
});

const school = uid => env.authenticatedContext(uid, { email: uid + '@x.com', email_verified: true }).firestore();
const anon = () => env.authenticatedContext('anon1', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const noAuth = () => env.unauthenticatedContext().firestore();
const owner = () => env.authenticatedContext('owner', OWNER).firestore();
const validMeta = () => ({ kind: 'meta', schemaVersion: 2, schoolType: 'girls', teacherNames: [], reportSignatures: { manager: '', attendance: '' }, revision: 2, updatedAt: serverTimestamp() });
const validRecord = (type = 'students', id = '2') => ({ kind: 'record', recordType: type, record: { id }, order: 1, schemaVersion: 2, updatedAt: serverTimestamp() });

// ---------- عزل المدارس ----------
test('مدرسة معتمدة تقرأ وتكتب بياناتها الخاصة', async () => {
  const db = school('u_schoolA');
  await assertSucceeds(getDoc(doc(db, 'schools/schoolA/private/appMeta')));
  await assertSucceeds(setDoc(doc(db, 'schools/schoolA/private/appMeta'), validMeta()));
  await assertSucceeds(setDoc(doc(db, 'schools/schoolA/private/v2_students_2'), validRecord()));
  await assertSucceeds(deleteDoc(doc(db, 'schools/schoolA/private/v2_students_2')));
});

test('المستمع اللحظي: list على private مسموح للمدرسة لمدرستها فقط', async () => {
  const db = school('u_schoolA');
  await assertSucceeds(getDocs(collection(db, 'schools/schoolA/private')));
  await assertFails(getDocs(collection(db, 'schools/schoolB/private')));
});

test('مدرسة A لا تقرأ ولا تكتب ولا تحذف بيانات B', async () => {
  const db = school('u_schoolA');
  await assertFails(getDoc(doc(db, 'schools/schoolB/private/appMeta')));
  await assertFails(getDoc(doc(db, 'schools/schoolB/private/v2_students_1')));
  await assertFails(setDoc(doc(db, 'schools/schoolB/private/v2_students_9'), validRecord('students', '9')));
  await assertFails(setDoc(doc(db, 'schools/schoolB/private/appMeta'), validMeta()));
  await assertFails(deleteDoc(doc(db, 'schools/schoolB/private/v2_students_1')));
  await assertFails(getDocs(collection(db, 'schools/schoolB/messages')));
  await assertFails(getDocs(collection(db, 'schools/schoolB/publicAttendance')));
  await assertFails(getDoc(doc(db, 'schools/schoolB')));
});

test('غير المسجّل والحساب المعلّق والمنتهية تجربته لا يصلون إلى private', async () => {
  await assertFails(getDoc(doc(noAuth(), 'schools/schoolA/private/appMeta')));
  await assertFails(getDocs(collection(noAuth(), 'schools/schoolA/private')));
  await assertFails(getDoc(doc(school('u_pending'), 'schools/schoolP/private/appMeta')));
  await assertFails(getDocs(collection(school('u_expired'), 'schools/schoolExpired/private')));
});

test('كتابات private غير الصالحة مرفوضة حتى لمدرسة معتمدة', async () => {
  const db = school('u_schoolA');
  await assertFails(setDoc(doc(db, 'schools/schoolA/private/appData'), { store: {} }));
  await assertFails(setDoc(doc(db, 'schools/schoolA/private/v2_hack_1'), validRecord('hack')));
  await assertFails(setDoc(doc(db, 'schools/schoolA/private/v2_students_3'), Object.assign(validRecord(), { order: -1 })));
  await assertFails(setDoc(doc(db, 'schools/schoolA/private/v2_students_3'), Object.assign(validRecord(), { extra: 1 })));
  await assertFails(setDoc(doc(db, 'schools/schoolA/private/appMeta'), Object.assign(validMeta(), { schemaVersion: 1 })));
});

// ---------- الروابط العامة (تصويت الفصول) ----------
test('الناخب المجهول لا يصل إلى private ولا يعدّد الفصول', async () => {
  const db = anon();
  await assertFails(getDoc(doc(db, 'schools/schoolA/private/appMeta')));
  await assertFails(getDocs(collection(db, 'schools/schoolA/private')));
  await assertFails(getDocs(collection(db, 'schools/schoolA/publicClasses')));
  await assertFails(getDocs(collection(db, 'schools/schoolA/publicAttendance')));
  await assertSucceeds(getDoc(doc(db, 'schools/schoolA/publicClasses/c1')));
});

test('الناخب المجهول يُنشئ تصويتًا صالحًا فقط ولا يعدّله', async () => {
  const db = anon();
  const vote = { classId: 'c1', date: '2026-10-31', absentIds: ['s1'], votedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(db, 'schools/schoolA/publicAttendance/c1_2026-10-31'), vote));
  await assertFails(updateDoc(doc(db, 'schools/schoolA/publicAttendance/c1_2026-10-31'), { absentIds: [] }));
  await assertFails(setDoc(doc(db, 'schools/schoolA/publicAttendance/wrong'), vote));
  await assertFails(setDoc(doc(db, 'schools/schoolA/publicAttendance/c1_2026-10-30'), Object.assign({}, vote, { absentIds: ['not-a-student'], date: '2026-10-30' })));
});

// ---------- الرسائل ----------
test('المدرسة تقرأ رسائلها وتحدّد «مقروءة» فقط ولا تُنشئ رسائل', async () => {
  const db = school('u_schoolA');
  await assertSucceeds(getDocs(collection(db, 'schools/schoolA/messages')));
  await assertSucceeds(updateDoc(doc(db, 'schools/schoolA/messages/m1'), { readAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'schools/schoolA/messages/m1'), { body: 'تعديل' }));
  await assertFails(setDoc(doc(db, 'schools/schoolA/messages/new'), { subject: 's', body: 'b' }));
});

// ---------- التسجيل والمالك ----------
test('لا يمكن إنشاء ملف تسجيل «معتمد» أو بمعرّف مدرسة غير معرّف المستخدم', async () => {
  const db = env.authenticatedContext('newuid', { email: 'n@x.com', email_verified: true }).firestore();
  const base = { email: 'n@x.com', schoolName: 'مدرسة', schoolType: 'girls', createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'users/newuid'), Object.assign({}, base, { schoolId: 'newuid', status: 'approved' })));
  await assertFails(setDoc(doc(db, 'users/newuid'), Object.assign({}, base, { schoolId: 'schoolA', status: 'pending' })));
  await assertSucceeds(setDoc(doc(db, 'users/newuid'), Object.assign({}, base, { schoolId: 'newuid', status: 'pending' })));
});

test('المالك فقط (بريد موثّق) يصل إلى أي مدرسة', async () => {
  await assertSucceeds(getDocs(collection(owner(), 'schools/schoolA/private')));
  await assertSucceeds(getDocs(collection(owner(), 'schools/schoolB/private')));
  const fake = env.authenticatedContext('x', { email: 'ahiixd6@gmail.com', email_verified: false }).firestore();
  await assertFails(getDocs(collection(fake, 'schools/schoolA/private')));
});
