// مرجع للمقارنة فقط: نسخة حرفية من آلية الاستطلاع القديمة (فحص appMeta كل 4 ثوانٍ، وعدّاد الرسائل كل 20 ثانية).
// تُحمَّل بعد الكود الجديد لتحلّ محلّه في اختبار قياس القراءات.
let syncTimer = null;
async function checkCloudMetaAndPull(){
  if(!db||!activeSchoolId||cloudDirty)return false;
  const requestedSchoolId=activeSchoolId;
  try{
    const snap=await db.collection('schools').doc(requestedSchoolId).collection('private').doc('appMeta').get();
    if(activeSchoolId!==requestedSchoolId||cloudDirty||!snap.exists)return false;
    const data=snap.data()||{},revision=Number(data.revision)||0;
    if(revision!==cloudRevision){
      const pulled=await pullFromServer(true);
      // Pulling silently updates the in-memory store, but the current view also
      // needs a repaint to show changes made in another device/session. Avoid
      // interrupting a form or modal the user is currently editing.
      const active=document.activeElement;
      const editing=active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName);
      if(pulled&&!editing&&!document.querySelector('.overlay'))render();
      return pulled;
    }
  }catch(e){setSyncIndicator('disconnected');console.error('Cloud revision check failed',e);}
  return false;
}
function startAutoSync(){
  if(syncTimer) clearInterval(syncTimer);
  if(messageCountTimer) clearInterval(messageCountTimer);
  if(publicAttendanceUnsubscribe){publicAttendanceUnsubscribe();publicAttendanceUnsubscribe=null;}
  if(!db || !activeSchoolId){setSyncIndicator('disconnected');return;}
  if(!navigator.onLine){setSyncIndicator('disconnected');return;}
  setSyncIndicator('synced');
  syncTimer = setInterval(()=>checkCloudMetaAndPull(), 4000);
  if(session&&session.type==='admin'){
    const schoolId=activeSchoolId;
    publicAttendanceUnsubscribe=db.collection('schools').doc(schoolId).collection('publicAttendance').onSnapshot(snapshot=>{
      if(activeSchoolId!==schoolId||!session||session.type!=='admin')return;
      const before=store.attendance.length;mergePublicAttendanceIntoStore(schoolId,snapshot);
      if(store.attendance.length!==before){localStorage.setItem(STORAGE_KEY,JSON.stringify(store));const active=document.activeElement;const editing=active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName);if(!editing&&!document.querySelector('.overlay'))render();}
    },error=>console.warn('Public attendance updates unavailable',error));
    refreshMessageBadge();
    messageCountTimer=setInterval(refreshMessageBadge,20000);
  }
  if(!syncListenersBound){
    syncListenersBound = true;
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden){checkCloudMetaAndPull();refreshMessageBadge();} });
    window.addEventListener('focus', ()=>{checkCloudMetaAndPull();refreshMessageBadge();});
  }
}

