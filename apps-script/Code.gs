const SHEET_ATLETI = 'Atleti';
const SHEET_PRESENZE = 'Presenze';
const SHEET_CONFIG = 'Config';
const SHEET_LOG = 'Import_Log';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Romatletica')
    .addItem('Importa report Golee', 'showImportDialog')
    .addSeparator()
    .addItem('Controlla configurazione', 'checkConfiguration')
    .addToUi();
}

function showImportDialog() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('Import').setWidth(520).setHeight(520),
    'Importa report Golee'
  );
}

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || 'person');
    if (action === 'health') return json_({ ok: true, service: 'Romatletica Presenze' });
    if (action !== 'person') throw new Error('Azione non valida');
    return json_(getPublicPerson_(String(e.parameter.id || '')));
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (payload.action !== 'register') throw new Error('Azione non valida');
    return json_(registerPresence_(payload));
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function getPublicPerson_(id) {
  const record = findAthlete_(id);
  if (!record) return { ok: false, error: 'QR non riconosciuto' };
  const config = readConfig_();
  return {
    ok: true,
    person: {
      id: record.ID_ROMATLETICA,
      name: `${record.Nome || ''} ${record.Cognome || ''}`.trim(),
      state: String(record.Stato || 'PROVA').toUpperCase(),
      trials: Number(record['Prove effettuate'] || 0),
      maxTrials: Number(config.MAX_PROVE || 2),
      signupUrl: String(config.LINK_ISCRIZIONE_GOLEE || '')
    }
  };
}

function registerPresence_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const id = String(payload.id || '').trim().toUpperCase();
    const record = findAthlete_(id);
    if (!record) throw new Error('QR non riconosciuto');
    const config = readConfig_();
    const maxTrials = Number(config.MAX_PROVE || 2);
    const state = String(record.Stato || 'PROVA').toUpperCase();
    const trials = Number(record['Prove effettuate'] || 0);
    if (state !== 'ISCRITTO' && trials >= maxTrials) {
      return { ok: false, blocked: true, error: 'Prove gratuite terminate', person: getPublicPerson_(id).person };
    }
    const presenze = SpreadsheetApp.getActive().getSheetByName(SHEET_PRESENZE);
    if (!presenze) throw new Error('Foglio Presenze mancante');
    const now = new Date();
    if (isRecentDuplicate_(presenze, id, now)) {
      return { ok: true, duplicate: true, message: 'Presenza già registrata', person: getPublicPerson_(id).person };
    }
    const type = state === 'ISCRITTO' ? 'ALLENAMENTO' : 'PROVA';
    const nextTrial = type === 'PROVA' ? trials + 1 : '';
    presenze.appendRow([now,id,record.Cognome || '',record.Nome || '',type,nextTrial,String(payload.operator || ''),'']);
    const atleti = SpreadsheetApp.getActive().getSheetByName(SHEET_ATLETI);
    const headers = headerMap_(atleti);
    if (type === 'PROVA') atleti.getRange(record.__row, headers['Prove effettuate'] + 1).setValue(nextTrial);
    atleti.getRange(record.__row, headers['Ultima presenza'] + 1).setValue(now);
    SpreadsheetApp.flush();
    return { ok: true, message: type === 'PROVA' ? `Prova ${nextTrial} registrata` : 'Presenza registrata', person: getPublicPerson_(id).person };
  } finally {
    lock.releaseLock();
  }
}

function importGolee(payload) {
  if (!payload || !Array.isArray(payload.headers) || !Array.isArray(payload.rows)) throw new Error('File non valido');
  const type = String(payload.type || 'PROVE').toUpperCase();
  if (!['PROVE','ISCRITTI'].includes(type)) throw new Error('Tipo di importazione non valido');
  const normalizedHeaders = payload.headers.map(normalizeHeader_);
  const cfIndex = normalizedHeaders.indexOf('codicefiscale');
  if (cfIndex < 0) throw new Error('Manca la colonna “Codice fiscale”');
  const atleti = SpreadsheetApp.getActive().getSheetByName(SHEET_ATLETI);
  if (!atleti) throw new Error('Foglio Atleti mancante');
  const map = headerMap_(atleti);
  const existing = athleteIndexByCf_(atleti, map);
  let created = 0;
  let updated = 0;
  payload.rows.forEach(row => {
    const cf = String(row[cfIndex] || '').trim().toUpperCase();
    if (!cf) return;
    const source = rowObject_(payload.headers, row);
    const currentRow = existing[cf];
    if (currentRow) {
      updateAthleteRow_(atleti, map, currentRow, source, type);
      updated++;
    } else {
      const id = uniqueId_(atleti, map);
      appendAthlete_(atleti, map, id, source, type);
      existing[cf] = atleti.getLastRow();
      created++;
    }
  });
  writeRawImport_(payload.headers, payload.rows, type);
  logImport_(type, payload.rows.length, created, updated);
  return { ok: true, read: payload.rows.length, created, updated };
}

function findAthlete_(id) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ATLETI);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idIndex = headers.indexOf('ID_ROMATLETICA');
  const rowIndex = values.slice(1).findIndex(row => String(row[idIndex]).trim().toUpperCase() === id.trim().toUpperCase());
  if (rowIndex < 0) return null;
  const result = { __row: rowIndex + 2 };
  headers.forEach((header, i) => result[header] = values[rowIndex + 1][i]);
  return result;
}

function readConfig_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_CONFIG);
  const values = sheet.getDataRange().getValues();
  return values.slice(1).reduce((acc,row) => { acc[String(row[0])] = row[1]; return acc; }, {});
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(String);
  return headers.reduce((acc,h,i) => { acc[h] = i; return acc; }, {});
}

function athleteIndexByCf_(sheet, map) {
  if (sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  return values.reduce((acc,row,i) => {
    const cf = String(row[map['Codice fiscale']] || '').trim().toUpperCase();
    if (cf) acc[cf] = i + 2;
    return acc;
  }, {});
}

function updateAthleteRow_(sheet, map, rowNumber, source, type) {
  const pairs = [['Cognome','Cognome'],['Nome','Nome'],['Codice fiscale','Codice fiscale'],['Email','Email'],['Telefono','Telefono'],['Data di nascita','Data di Nascita']];
  pairs.forEach(([target,key]) => { if (source[key] !== undefined && map[target] !== undefined) sheet.getRange(rowNumber,map[target]+1).setValue(source[key]); });
  if (type === 'ISCRITTI') sheet.getRange(rowNumber,map.Stato+1).setValue('ISCRITTO');
}

function appendAthlete_(sheet, map, id, source, type) {
  const config = readConfig_();
  const row = new Array(sheet.getLastColumn()).fill('');
  row[map.ID_ROMATLETICA] = id;
  row[map.Cognome] = source.Cognome || '';
  row[map.Nome] = source.Nome || '';
  row[map['Codice fiscale']] = source['Codice fiscale'] || '';
  row[map.Email] = source.Email || '';
  row[map.Telefono] = source.Telefono || '';
  row[map['Data di nascita']] = source['Data di Nascita'] || '';
  row[map.Stato] = type === 'ISCRITTI' ? 'ISCRITTO' : 'PROVA';
  row[map['Prove effettuate']] = 0;
  row[map['Link tessera']] = `${config.BASE_SITE_URL}?view=card&id=${encodeURIComponent(id)}`;
  sheet.appendRow(row);
}

function uniqueId_(sheet, map) {
  const existing = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,map.ID_ROMATLETICA+1,sheet.getLastRow()-1,1).getDisplayValues().flat();
  let id;
  do id = `RA-P-${Utilities.getUuid().replace(/-/g,'').slice(0,6).toUpperCase()}`; while (existing.includes(id));
  return id;
}

function rowObject_(headers,row) {
  return headers.reduce((acc,h,i) => { acc[String(h).trim()] = row[i]; return acc; }, {});
}

function writeRawImport_(headers, rows, type) {
  const ss = SpreadsheetApp.getActive();
  const name = type === 'ISCRITTI' ? 'Ultimo_Import_Iscritti' : 'Ultimo_Import_Prove';
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (headers.length) sheet.getRange(1,1,rows.length+1,headers.length).setValues([headers,...rows]);
  sheet.setFrozenRows(1);
}

function logImport_(type, read, created, updated) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  sheet.appendRow([new Date(),type,read,created,updated]);
}

function isRecentDuplicate_(sheet,id,now) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const start = Math.max(2,lastRow-20);
  return sheet.getRange(start,1,lastRow-start+1,2).getValues().some(row => String(row[1]) === id && row[0] instanceof Date && now-row[0] < 30000);
}

function normalizeHeader_(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

function checkConfiguration() {
  const config = readConfig_();
  const missing = ['BACKEND_URL','LINK_ISCRIZIONE_GOLEE'].filter(key => !config[key] || String(config[key]).startsWith('DA_INSERIRE'));
  SpreadsheetApp.getUi().alert(missing.length ? `Da completare: ${missing.join(', ')}` : 'Configurazione completa.');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
