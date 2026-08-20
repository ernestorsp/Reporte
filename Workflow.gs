function uploadReportFileFast(payload) {
  ensureStorage_();
  if (!payload || !payload.name || !payload.base64) throw new Error('Archivo inválido.');
  const meta = detectFileMeta_(payload.name);
  if (!meta.station) throw new Error('Archivo rechazado: el nombre debe indicar DJX3 o DJX4.');
  if (!meta.week) throw new Error('Archivo rechazado: no pude identificar la semana (ej. 2026-W33).');
  if (!meta.type) throw new Error('Archivo rechazado: no corresponde a OVERVIEW, SAFETY, CDF, DSB, PSB o DVIC.');

  const bytes = Utilities.base64Decode(payload.base64);
  const blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', payload.name);
  let rows;
  let tempId = null;
  try {
    if (/\.csv$/i.test(payload.name)) {
      rows = Utilities.parseCsv(blob.getDataAsString());
    } else if (/\.xlsx?$/i.test(payload.name)) {
      const converted = Drive.Files.insert({title:'TMP_' + Date.now(), mimeType:MimeType.GOOGLE_SHEETS}, blob, {convert:true});
      tempId = converted.id;
      rows = SpreadsheetApp.openById(tempId).getSheets()[0].getDataRange().getDisplayValues();
    } else {
      throw new Error('Formato no soportado. Usa CSV, XLS o XLSX.');
    }

    if (!rows || rows.length < 2) throw new Error('El archivo no contiene datos suficientes.');
    const validation = validateUploadedFile_(rows, meta);
    if (!validation.ok) throw new Error('Archivo incorrecto para ' + meta.type + ' ' + meta.station + ': ' + validation.message);

    const normalized = normalizeUploadedRows_(rows, meta);
    replaceSourceData_(meta, normalized);
    recordUpload_(meta, payload.name, normalized.length, 'LOADED', '');
    updateDocumentChecklistRow_(meta, 'LOADED', payload.name, validation.message);
    syncDocumentChecklist_(meta.week);

    return {
      ok:true,
      week:meta.week,
      station:meta.station,
      type:meta.type,
      uploads:uploadStatus_(meta.week),
      weeks:getWeeks_()
    };
  } catch (err) {
    recordUpload_(meta, payload.name, 0, 'ERROR', err.message);
    updateDocumentChecklistRow_(meta, 'ERROR', payload.name, err.message);
    throw err;
  } finally {
    if (tempId) {
      try { DriveApp.getFileById(tempId).setTrashed(true); } catch (e) {}
    }
  }
}

function generateReports(request) {
  ensureStorage_();
  const week = request && request.week ? request.week : getLatestWeek_();
  if (!week) throw new Error('Primero carga documentos de una semana.');
  syncDocumentChecklist_(week);
  return buildDashboard_(week);
}
