const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db = getFirestore();
const VERSION = 1;

function clean(v){ return String(v ?? '').trim(); }
function norm(v){
  return clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
function packagesOf(r){ return Number(r?.extra?.packages || 0) || 0; }

function identityMaps(records){
  const groups = new Map();
  const byTid = new Map();
  const byName = new Map();

  for(const r of records.filter(x=>x.kind==='OVERVIEW')){
    const tid=clean(r.transporterId);
    const nameKey=norm(r.driverName);
    const id=tid ? `tid:${tid}` : `name:${nameKey}`;
    if(!id || id==='name:') continue;

    let g=groups.get(id);
    if(!g){
      g={id,transporterId:tid,driverKey:clean(r.driverKey)||tid||nameKey.replace(/\s+/g,'_'),driverName:clean(r.driverName),totalPackages:0,stationPackages:{DJX3:0,DJX4:0},overviews:[]};
      groups.set(id,g);
    }
    if(!g.transporterId && tid) g.transporterId=tid;
    if(!g.driverName && r.driverName) g.driverName=clean(r.driverName);
    g.totalPackages += packagesOf(r);
    if(r.station==='DJX3'||r.station==='DJX4') g.stationPackages[r.station]+=packagesOf(r);
    g.overviews.push(r);
    if(tid) byTid.set(tid,g);
    if(nameKey) byName.set(nameKey,g);
  }

  for(const g of groups.values()){
    const p3=g.stationPackages.DJX3||0, p4=g.stationPackages.DJX4||0;
    g.station = p4>p3 ? 'DJX4' : 'DJX3';
    const dominant=g.overviews.find(r=>r.station===g.station) || g.overviews[0];
    g.driverName=clean(dominant?.driverName)||g.driverName;
    g.transporterId=clean(dominant?.transporterId)||g.transporterId;
    g.driverKey=clean(dominant?.driverKey)||g.driverKey;
    g.dominantOverview=dominant;
  }
  return {groups,byTid,byName};
}

function groupFor(r,maps){
  const tid=clean(r.transporterId);
  if(tid && maps.byTid.has(tid)) return maps.byTid.get(tid);
  const nameKey=norm(r.driverName);
  if(nameKey && maps.byName.has(nameKey)) return maps.byName.get(nameKey);
  return null;
}

async function replaceWeekRecords(week,records){
  const snap=await db.collection('records').where('week','==',week).get();
  for(let i=0;i<snap.docs.length;i+=400){
    const batch=db.batch();
    snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
  for(let i=0;i<records.length;i+=400){
    const batch=db.batch();
    for(const r of records.slice(i,i+400)){
      batch.set(db.collection('records').doc(),{...r,consolidatedAt:FieldValue.serverTimestamp()});
    }
    await batch.commit();
  }
}

async function consolidateWeek(week){
  const snap=await db.collection('records').where('week','==',week).get();
  const records=snap.docs.map(d=>d.data());
  const maps=identityMaps(records);
  if(!maps.groups.size) return {records:records.length,driverCounts:{DJX3:0,DJX4:0},mergedDrivers:0};

  const output=[];
  let mergedDrivers=0;
  for(const g of maps.groups.values()){
    if(g.overviews.length>1) mergedDrivers++;
    const o={...g.dominantOverview};
    o.station=g.station;
    o.driverName=g.driverName;
    o.transporterId=g.transporterId;
    o.driverKey=g.driverKey;
    o.extra={...(o.extra||{}),packages:g.totalPackages,stationPackages:{...g.stationPackages}};
    output.push(o);
  }

  for(const r of records){
    if(r.kind==='OVERVIEW') continue;
    const g=groupFor(r,maps);
    if(!g){ output.push(r); continue; }
    output.push({...r,station:g.station,driverName:g.driverName,transporterId:g.transporterId,driverKey:g.driverKey});
  }

  await replaceWeekRecords(week,output);
  const driverCounts={DJX3:0,DJX4:0};
  for(const g of maps.groups.values()) driverCounts[g.station]++;
  return {records:output.length,driverCounts,mergedDrivers};
}

exports.consolidateGeneratedWeek = onDocumentWritten({region:'us-east1',document:'generations/{week}',timeoutSeconds:540,memory:'1GiB'},async event=>{
  const after=event.data?.after;
  if(!after?.exists) return;
  const data=after.data()||{};
  if(data.status!=='generated') return;
  if(Number(data.consolidatedVersion||0)>=VERSION) return;

  const week=event.params.week;
  const result=await consolidateWeek(week);
  await after.ref.set({
    consolidatedVersion:VERSION,
    consolidatedAt:FieldValue.serverTimestamp(),
    records:result.records,
    driverCounts:result.driverCounts,
    mergedDrivers:result.mergedDrivers
  },{merge:true});
});
