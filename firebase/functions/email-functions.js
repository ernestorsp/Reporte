const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const db = getFirestore();
const REPORT_EMAIL = defineSecret('REPORT_EMAIL');
const REPORT_EMAIL_APP_PASSWORD = defineSecret('REPORT_EMAIL_APP_PASSWORD');

const DEFAULT_SCORING = {packages:0.15,rescueYes:-0.20,rescuePositive:0,ncns:0,co:0,lateMorning:0,complaints:0,safety:0,pickups:0,dsb:0,dvic:0,otherInfra:0};

function clean(v){return String(v??'').trim();}
function lower(v){return clean(v).toLowerCase();}
function norm(v){return lower(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function round2(v){return Math.round((Number(v)||0)*100)/100;}
function fmt(v){const n=round2(v);return `${n>0?'+':''}${n.toFixed(2)}`;}
function canonicalCategory(v){const s=clean(v).toUpperCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');if(s==='NCNS'||s.includes('NO CALL NO SHOW'))return'NCNS';if(s==='CO'||s==='CALL OUT'||s==='CALLOUT')return'CO';if(s.includes('LATE MORNING'))return'LATE_MORNING';return'OTHER';}

function scoreRecord(r,scoring){
  if(r.kind==='COMPLAINT')return Number(scoring.complaints||0);
  if(r.kind==='INFRACTION')return Number(scoring.safety||0);
  if(r.kind==='FAILED_PICKUP')return Number(r.extra?.count||1)*Number(scoring.pickups||0);
  if(r.kind==='DSB')return Number(scoring.dsb||0);
  if(r.kind==='DVIC')return Number(scoring.dvic||0);
  if(r.kind==='RESCUE'){
    const affects=lower(r.extra?.affects),base=Number(r.extra?.stops||0)+Number(r.extra?.packages||0);
    if(affects==='yes')return base*Number(scoring.rescueYes||0);
    if(affects==='positive')return base*Number(scoring.rescuePositive||0);
    return 0;
  }
  if(r.kind==='LOG_INFRA'){
    if(lower(r.extra?.affects)==='no')return 0;
    const cat=canonicalCategory(r.extra?.category||r.label),key=cat==='NCNS'?'ncns':cat==='CO'?'co':cat==='LATE_MORNING'?'lateMorning':'otherInfra';
    return Number(scoring[key]||0);
  }
  return 0;
}

function summarize(records,scoring){
  const overview=records.find(r=>r.kind==='OVERVIEW');
  const packages=Number(overview?.extra?.packages||0);
  const out={packages,rescues:0,rescueStops:0,rescuePackages:0,ncns:0,co:0,late:0,complaints:0,safety:0,pickups:0,dsb:0,dvic:0,total:packages*Number(scoring.packages||0)};
  for(const r of records.filter(x=>x.kind!=='OVERVIEW')){
    out.total+=scoreRecord(r,scoring);
    if(r.kind==='RESCUE'){out.rescues++;out.rescueStops+=Number(r.extra?.stops||0);out.rescuePackages+=Number(r.extra?.packages||0);}
    else if(r.kind==='COMPLAINT')out.complaints++;
    else if(r.kind==='INFRACTION')out.safety++;
    else if(r.kind==='FAILED_PICKUP')out.pickups+=Number(r.extra?.count||1);
    else if(r.kind==='DSB')out.dsb++;
    else if(r.kind==='DVIC')out.dvic++;
    else if(r.kind==='LOG_INFRA'){
      const c=canonicalCategory(r.extra?.category||r.label);
      if(c==='NCNS')out.ncns++;else if(c==='CO')out.co++;else if(c==='LATE_MORNING')out.late++;
    }
  }
  out.total=round2(out.total);return out;
}

function buildPdf({name,transporterId,email,week,station,records,summary,scoring}){
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'LETTER',margin:48,info:{Title:`AAXI Xpress Driver Report ${week}`,Author:'AAXI Xpress'}});
    const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);

    doc.font('Helvetica-Bold').fontSize(24).text('AAXI Xpress');
    doc.font('Helvetica').fontSize(10).fillColor('#667085').text('Weekly Driver Performance Report');
    doc.moveDown(0.6);doc.strokeColor('#D0D5DD').moveTo(48,102).lineTo(564,102).stroke();
    doc.fillColor('#101828').font('Helvetica-Bold').fontSize(16).text(name||'Driver',48,120);
    doc.font('Helvetica').fontSize(9).fillColor('#667085').text(`Transporter ID: ${transporterId||'-'}   |   Station: ${station}   |   Week: ${week}`);
    if(email)doc.text(`Email: ${email}`);

    doc.moveDown(1.2);doc.roundedRect(48,178,516,70,8).fillAndStroke('#F8FAFC','#E4E7EC');
    doc.fillColor('#344054').font('Helvetica-Bold').fontSize(10).text('TOTAL SCORE',64,194);
    doc.fillColor(summary.total>=0?'#067647':'#B42318').fontSize(22).text(fmt(summary.total),64,211);
    doc.fillColor('#344054').font('Helvetica-Bold').fontSize(10).text('PACKAGES',210,194).fontSize(18).text(String(summary.packages),210,211);
    doc.fontSize(10).text('RESCUES',330,194).fontSize(18).text(String(summary.rescues),330,211);
    doc.fontSize(10).text('INCIDENTS',445,194).fontSize(18).text(String(summary.ncns+summary.co+summary.late+summary.complaints+summary.safety+summary.pickups+summary.dsb+summary.dvic),445,211);

    doc.fillColor('#101828').font('Helvetica-Bold').fontSize(13).text('Performance summary',48,270);
    const metrics=[['Packages Delivered',summary.packages],['Rescues',summary.rescues],['Rescue Stops',summary.rescueStops],['Rescue Packages',summary.rescuePackages],['NCNS',summary.ncns],['Call Out (CO)',summary.co],['Late Morning',summary.late],['Complaints',summary.complaints],['Safety',summary.safety],['Pickups',summary.pickups],['DSB',summary.dsb],['DVIC',summary.dvic]];
    let y=296;
    metrics.forEach((m,i)=>{const x=i%2===0?48:306;if(i%2===0&&i>0)y+=27;doc.font('Helvetica').fontSize(9).fillColor('#667085').text(m[0],x,y,{width:150});doc.font('Helvetica-Bold').fillColor('#101828').text(String(m[1]),x+165,y,{width:70,align:'right'});});

    y+=48;doc.font('Helvetica-Bold').fontSize(13).fillColor('#101828').text('Scoring detail',48,y);y+=22;
    const rows=[{label:'Packages Delivered',detail:`${summary.packages} x ${Number(scoring.packages||0)}`,points:summary.packages*Number(scoring.packages||0)}];
    for(const r of records.filter(x=>x.kind!=='OVERVIEW')){
      let label=r.kind||'Event',detail=r.label||'';
      if(r.kind==='INFRACTION'){
        const metricType=clean(r.extra?.metricType||r.label)||'Safety Violation';
        label='INFRACTION';
        detail=`Safety Violation · ${metricType}`;
      }
      if(r.kind==='RESCUE'){
        label='Rescue';
        detail=`Stops ${Number(r.extra?.stops||0)} · Packages ${Number(r.extra?.packages||0)} · Affects ${clean(r.extra?.affects)||'-'}`;
      }
      if(r.kind==='COMPLAINT'){
        label='COMPLAINT';
        detail=clean(r.extra?.details||r.label)||'Customer Delivery Feedback';
      }
      if(r.kind==='LOG_INFRA')detail=`${clean(r.extra?.category||r.label)} · Affects ${clean(r.extra?.affects)||'-'}`;
      rows.push({label,date:clean(r.date),detail,points:scoreRecord(r,scoring)});
    }
    if(rows.length===1)rows.push({label:'No incidents',detail:'No additional events recorded for this week.',points:0});

    for(const r of rows){
      if(y>700){doc.addPage();y=55;}
      doc.strokeColor('#EAECF0').moveTo(48,y-5).lineTo(564,y-5).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#101828').text(r.label,48,y,{width:155});
      doc.font('Helvetica').fontSize(8).fillColor('#667085').text(`${r.date?`${r.date} · `:''}${r.detail||''}`,205,y,{width:285});
      doc.font('Helvetica-Bold').fontSize(9).fillColor(r.points>0?'#067647':r.points<0?'#B42318':'#667085').text(fmt(r.points),495,y,{width:69,align:'right'});
      y+=28;
    }

    if(y>690){doc.addPage();y=55;}else y+=10;
    doc.strokeColor('#D0D5DD').moveTo(48,y).lineTo(564,y).stroke();y+=14;
    doc.font('Helvetica').fontSize(8).fillColor('#667085').text('This report is generated by AAXI Xpress for weekly performance communication. Metrics marked as non-affecting remain visible but contribute 0 points.',48,y,{width:516,align:'center'});
    doc.end();
  });
}

function transporter(){const user=REPORT_EMAIL.value(),pass=REPORT_EMAIL_APP_PASSWORD.value();if(!user||!pass)throw new HttpsError('failed-precondition','El correo remitente todavía no está configurado.');return{user,tx:nodemailer.createTransport({service:'gmail',auth:{user,pass}})};}
async function loadScoring(){const s=await db.collection('settings').doc('scoring').get();return{...DEFAULT_SCORING,...(s.exists?s.data():{})};}

async function loadDriver(week,station,transporterId,{requireEmail=true}={}){
  const snap=await db.collection('records').where('week','==',week).get();
  const all=snap.docs.map(d=>d.data());
  const overview=all.find(r=>r.kind==='OVERVIEW'&&r.station===station&&(clean(r.transporterId)===transporterId||clean(r.driverKey)===transporterId));
  if(!overview)throw new HttpsError('not-found','No encontré el reporte del driver para esa semana.');
  const overviewName=norm(overview.driverName);
  const records=all.filter(r=>
    clean(r.transporterId)===transporterId ||
    clean(r.driverKey)===transporterId ||
    (overviewName&&norm(r.driverName)===overviewName)
  );
  const directory=await db.collection('driverDirectory').doc(transporterId).get();
  const email=clean(directory.exists?directory.data()?.email:'');
  if(requireEmail&&!email)throw new HttpsError('failed-precondition','Este driver no tiene email guardado en Directorio.');
  return{records,name:clean(overview.driverName),email};
}

async function renderOne({week,station,transporterId,requireEmail=true}){const scoring=await loadScoring();const {records,name,email}=await loadDriver(week,station,transporterId,{requireEmail});const summary=summarize(records,scoring);const pdf=await buildPdf({name,transporterId,email,week,station,records,summary,scoring});return{pdf,name,email,summary};}
async function sendOne({week,station,transporterId}){const {pdf,name,email,summary}=await renderOne({week,station,transporterId,requireEmail:true});const {user,tx}=transporter();await tx.sendMail({from:`\"AAXI Xpress\" <${user}>`,to:email,subject:`AAXI Xpress · Weekly Driver Report · ${week}`,html:`<div style=\"font-family:Arial,sans-serif;color:#101828;line-height:1.55\"><h2 style=\"margin-bottom:4px\">AAXI Xpress</h2><p>Hello ${name},</p><p>Your weekly performance report for <b>${week}</b> at <b>${station}</b> is attached as a PDF.</p><p><b>Total score: ${fmt(summary.total)}</b></p><p>Please review the attached report. If you have questions, reply to this email.</p><p style=\"color:#667085;font-size:12px\">AAXI Xpress · Driver Performance Report</p></div>`,attachments:[{filename:`AAXI_Xpress_${week}_${transporterId}.pdf`,content:pdf,contentType:'application/pdf'}]});await db.collection('reportSends').doc(`${week}_${station}_${transporterId}`).set({week,station,transporterId,email,sent:true,sentAt:FieldValue.serverTimestamp(),delivery:'email_pdf'},{merge:true});return{ok:true,email,name,total:summary.total};}

exports.previewDriverReport=onCall({region:'us-east1',timeoutSeconds:120,memory:'512MiB'},async request=>{if(!request.auth)throw new HttpsError('unauthenticated','Acceso no preparado.');const week=clean(request.data?.week),station=clean(request.data?.station).toUpperCase(),transporterId=clean(request.data?.transporterId);if(!/^\d{4}-W\d{2}$/.test(week)||!['DJX3','DJX4'].includes(station)||!transporterId)throw new HttpsError('invalid-argument','Datos del reporte inválidos.');const {pdf,name,email,summary}=await renderOne({week,station,transporterId,requireEmail:false});return{ok:true,name,email,total:summary.total,fileName:`AAXI_Xpress_${week}_${transporterId}.pdf`,pdfBase64:pdf.toString('base64')}});
exports.sendDriverReport=onCall({region:'us-east1',timeoutSeconds:120,memory:'512MiB',secrets:[REPORT_EMAIL,REPORT_EMAIL_APP_PASSWORD]},async request=>{if(!request.auth)throw new HttpsError('unauthenticated','Acceso no preparado.');const week=clean(request.data?.week),station=clean(request.data?.station).toUpperCase(),transporterId=clean(request.data?.transporterId);if(!/^\d{4}-W\d{2}$/.test(week)||!['DJX3','DJX4'].includes(station)||!transporterId)throw new HttpsError('invalid-argument','Datos del reporte inválidos.');return sendOne({week,station,transporterId})});
exports.sendStationReports=onCall({region:'us-east1',timeoutSeconds:900,memory:'1GiB',secrets:[REPORT_EMAIL,REPORT_EMAIL_APP_PASSWORD]},async request=>{if(!request.auth)throw new HttpsError('unauthenticated','Acceso no preparado.');const week=clean(request.data?.week),station=clean(request.data?.station).toUpperCase();if(!/^\d{4}-W\d{2}$/.test(week)||!['DJX3','DJX4'].includes(station))throw new HttpsError('invalid-argument','Semana o estación inválida.');const snap=await db.collection('records').where('week','==',week).where('station','==',station).get();const ids=[...new Set(snap.docs.map(d=>d.data()).filter(r=>r.kind==='OVERVIEW').map(r=>clean(r.transporterId||r.driverKey)).filter(Boolean))];const sent=[],failed=[];for(const id of ids){try{sent.push(await sendOne({week,station,transporterId:id}))}catch(err){failed.push({transporterId:id,error:err.message||String(err)})}}return{ok:true,total:ids.length,sent:sent.length,failed:failed.length,failures:failed.slice(0,20)}});
