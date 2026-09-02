const SHEET_ATLETI = 'Atleti';
const SHEET_PRESENZE = 'Presenze';
const SHEET_CONFIG = 'Config';
const SHEET_LOG = 'Import_Log';
const MAIL_HEADERS = ['Stato invio tessera', 'Data invio tessera', 'Email invio', 'Esito invio'];
const MAIL_STATUS_PENDING = 'DA INVIARE';
const MAIL_STATUS_SENT = 'INVIATA';
const MAIL_STATUS_ERROR = 'ERRORE';

function onOpen() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
  SpreadsheetApp.getUi().createMenu('Romatletica')
    .addItem('Importa richieste Golee', 'showImportDialog')
    .addItem('Gestisci invio tessere', 'showMailDialog')
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

function showMailDialog() {
  ensureMailSystem_();
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('Mail').setWidth(760).setHeight(650),
    'Invio tessere personali'
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
    if (payload.action === 'register') return json_(registerPresence_(payload));
    if (payload.action === 'sync') return json_(getScannerRoster_(payload));
    throw new Error('Azione non valida');
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
      trials: totalTrialsForCf_(record['Codice fiscale']),
      maxTrials: Number(config.MAX_PROVE || 2),
      requestedDate: publicDate_(record['Data richiesta prova'] || ''),
      signupUrl: String(config.LINK_ISCRIZIONE_GOLEE || '')
    }
  };
}

function verifyScannerPin_(payload, config) {
  const expectedPin = String(config.SCANNER_PIN || '').trim();
  const suppliedPin = String(payload.pin || '').trim();
  if (!expectedPin || expectedPin === 'DA_IMPOSTARE' || suppliedPin !== expectedPin) throw new Error('PIN operatore non valido');
}

function getScannerRoster_(payload) {
  const config = readConfig_();
  verifyScannerPin_(payload, config);
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, people: [], syncedAt: new Date().toISOString() };
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const map = headers.reduce((acc,h,i) => { acc[h] = i; return acc; }, {});
  const trialTotals = trialTotalsByCf_(values.slice(1), map);
  const people = values.slice(1).filter(row => String(row[map.ID_ROMATLETICA] || '').trim()).map(row => {
    const cf = normalizeCf_(row[map['Codice fiscale']]);
    return {
      id: String(row[map.ID_ROMATLETICA] || '').trim().toUpperCase(),
      name: `${row[map.Nome] || ''} ${row[map.Cognome] || ''}`.trim(),
      state: String(row[map.Stato] || 'PROVA').toUpperCase(),
      trials: Number(trialTotals[cf] || 0),
      maxTrials: Number(config.MAX_PROVE || 2),
      requestedDate: publicDate_(row[map['Data richiesta prova']] || ''),
      signupUrl: String(config.LINK_ISCRIZIONE_GOLEE || '')
    };
  });
  return { ok: true, people, syncedAt: new Date().toISOString() };
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
    verifyScannerPin_(payload, config);
    const state = String(record.Stato || 'PROVA').toUpperCase();
    const trials = totalTrialsForCf_(record['Codice fiscale']);
    if (state !== 'ISCRITTO' && trials >= maxTrials) {
      return { ok: false, blocked: true, error: 'Prove gratuite terminate', person: getPublicPerson_(id).person };
    }
    const presenze = spreadsheet_().getSheetByName(SHEET_PRESENZE);
    if (!presenze) throw new Error('Foglio Presenze mancante');
    const now = new Date();
    const eventId = String(payload.eventId || '').trim();
    if ((eventId && isProcessedEvent_(presenze, eventId)) || isRecentDuplicate_(presenze, id, now)) {
      return { ok: true, duplicate: true, message: 'Presenza già registrata', person: getPublicPerson_(id).person };
    }
    const type = state === 'ISCRITTO' ? 'ALLENAMENTO' : 'PROVA';
    const nextTrial = type === 'PROVA' ? trials + 1 : '';
    presenze.appendRow([now,id,record.Cognome || '',record.Nome || '',type,nextTrial,String(payload.operator || ''),eventId]);
    const atleti = spreadsheet_().getSheetByName(SHEET_ATLETI);
    const headers = headerMap_(atleti);
    if (type === 'PROVA') {
      const rowTrials = Number(record['Prove effettuate'] || 0);
      atleti.getRange(record.__row, headers['Prove effettuate'] + 1).setValue(rowTrials + 1);
    }
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
  const atleti = spreadsheet_().getSheetByName(SHEET_ATLETI);
  if (!atleti) throw new Error('Foglio Atleti mancante');
  ensureMailSystem_(atleti);
  const map = headerMap_(atleti);
  const existingByCf = athleteRowsByCf_(atleti, map);
  const existingRequests = athleteIndexByRequest_(atleti, map);
  let created = 0;
  let updated = 0;
  let mailQueued = 0;
  payload.rows.forEach(row => {
    const cf = normalizeCf_(row[cfIndex]);
    if (!cf) return;
    const source = rowObject_(payload.headers, row);
    if (type === 'PROVE') {
      const requestedTrialDate = requestedTrialDateFromSource_(source);
      const requestKey = athleteRequestKey_(cf, requestedTrialDate);
      const currentRow = existingRequests[requestKey];
      if (currentRow) {
        updateAthleteRow_(atleti, map, currentRow, source, type);
        updated++;
      } else {
        const id = uniqueId_(atleti, map);
        appendAthlete_(atleti, map, id, source, type);
        const newRow = atleti.getLastRow();
        existingRequests[requestKey] = newRow;
        if (!existingByCf[cf]) existingByCf[cf] = [];
        existingByCf[cf].push(newRow);
        created++;
        mailQueued++;
      }
      return;
    }
    const matchingRows = existingByCf[cf] || [];
    if (matchingRows.length) {
      matchingRows.forEach(rowNumber => updateAthleteRow_(atleti, map, rowNumber, source, type));
      updated += matchingRows.length;
    } else {
      const id = uniqueId_(atleti, map);
      appendAthlete_(atleti, map, id, source, type);
      existingByCf[cf] = [atleti.getLastRow()];
      created++;
    }
  });
  writeRawImport_(payload.headers, payload.rows, type);
  logImport_(type, payload.rows.length, created, updated);
  return { ok: true, read: payload.rows.length, created, updated, mailQueued };
}

function findAthlete_(id) {
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
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
  const sheet = spreadsheet_().getSheetByName(SHEET_CONFIG);
  const values = sheet.getDataRange().getValues();
  return values.slice(1).reduce((acc,row) => { acc[String(row[0])] = row[1]; return acc; }, {});
}

function headerMap_(sheet) {
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(String);
  return headers.reduce((acc,h,i) => { acc[h] = i; return acc; }, {});
}

function normalizeCf_(value) {
  return String(value || '').trim().toUpperCase();
}

function requestDateKey_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, 'Europe/Rome', 'yyyy-MM-dd');
  const text = String(value).trim();
  const italian = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (italian) return `${italian[3]}-${italian[2].padStart(2, '0')}-${italian[1].padStart(2, '0')}`;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return normalizeHeader_(text);
}

function athleteRequestKey_(cf, requestedDate) {
  return `${normalizeCf_(cf)}|${requestDateKey_(requestedDate)}`;
}

function athleteRowsByCf_(sheet, map) {
  if (sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return values.reduce((acc, row, index) => {
    const cf = normalizeCf_(row[map['Codice fiscale']]);
    if (cf) {
      if (!acc[cf]) acc[cf] = [];
      acc[cf].push(index + 2);
    }
    return acc;
  }, {});
}

function athleteIndexByRequest_(sheet, map) {
  if (sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return values.reduce((acc, row, index) => {
    const cf = normalizeCf_(row[map['Codice fiscale']]);
    if (!cf) return acc;
    const key = athleteRequestKey_(cf, row[map['Data richiesta prova']]);
    acc[key] = index + 2;
    return acc;
  }, {});
}

function trialTotalsByCf_(rows, map) {
  return rows.reduce((acc, row) => {
    const cf = normalizeCf_(row[map['Codice fiscale']]);
    if (cf) acc[cf] = Number(acc[cf] || 0) + Number(row[map['Prove effettuate']] || 0);
    return acc;
  }, {});
}

function totalTrialsForCf_(cf) {
  const normalizedCf = normalizeCf_(cf);
  if (!normalizedCf) return 0;
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const map = headerMap_(sheet);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return Number(trialTotalsByCf_(rows, map)[normalizedCf] || 0);
}

function requestedTrialDateFromSource_(source) {
  if (source['Data richiesta per la prova'] !== undefined) return source['Data richiesta per la prova'];
  return source['Data richiesta'];
}

function updateAthleteRow_(sheet, map, rowNumber, source, type) {
  const pairs = [['Cognome','Cognome'],['Nome','Nome'],['Codice fiscale','Codice fiscale'],['Email','Email'],['Telefono','Telefono'],['Data di nascita','Data di Nascita']];
  pairs.forEach(([target,key]) => { if (source[key] !== undefined && map[target] !== undefined) sheet.getRange(rowNumber,map[target]+1).setValue(source[key]); });
  const requestedTrialDate = requestedTrialDateFromSource_(source);
  if (requestedTrialDate !== undefined && map['Data richiesta prova'] !== undefined) {
    sheet.getRange(rowNumber, map['Data richiesta prova'] + 1).setValue(requestedTrialDate);
  }
  if (type === 'PROVE' && map['Stato invio tessera'] !== undefined) {
    const mailStatus = String(sheet.getRange(rowNumber, map['Stato invio tessera'] + 1).getDisplayValue() || '').trim();
    if (mailStatus !== MAIL_STATUS_SENT) {
      sheet.getRange(rowNumber, map['Stato invio tessera'] + 1).setValue(MAIL_STATUS_PENDING);
      if (map['Email invio'] !== undefined && source.Email !== undefined) sheet.getRange(rowNumber, map['Email invio'] + 1).setValue(source.Email);
      if (map['Esito invio'] !== undefined) sheet.getRange(rowNumber, map['Esito invio'] + 1).clearContent();
    }
  }
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
  if (map['Data richiesta prova'] !== undefined) row[map['Data richiesta prova']] = requestedTrialDateFromSource_(source) || '';
  row[map.Stato] = type === 'ISCRITTI' ? 'ISCRITTO' : 'PROVA';
  row[map['Prove effettuate']] = 0;
  row[map['Link tessera']] = `${config.BASE_SITE_URL}?view=card&id=${encodeURIComponent(id)}`;
  if (map['Stato invio tessera'] !== undefined) row[map['Stato invio tessera']] = type === 'PROVE' ? MAIL_STATUS_PENDING : '';
  if (map['Email invio'] !== undefined) row[map['Email invio']] = source.Email || '';
  sheet.appendRow(row);
}

function uniqueId_(sheet, map) {
  const existing = sheet.getLastRow() < 2 ? [] : sheet.getRange(2,map.ID_ROMATLETICA+1,sheet.getLastRow()-1,1).getDisplayValues().flat();
  let id;
  do id = `RA-${Utilities.getUuid().replace(/-/g,'').slice(0,24).toUpperCase()}`; while (existing.includes(id));
  return id;
}

function rowObject_(headers,row) {
  return headers.reduce((acc,h,i) => { acc[String(h).trim()] = row[i]; return acc; }, {});
}

function writeRawImport_(headers, rows, type) {
  const ss = spreadsheet_();
  const name = type === 'ISCRITTI' ? 'Ultimo_Import_Iscritti' : 'Ultimo_Import_Prove';
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (headers.length) sheet.getRange(1,1,rows.length+1,headers.length).setValues([headers,...rows]);
  sheet.setFrozenRows(1);
}

function logImport_(type, read, created, updated) {
  const sheet = spreadsheet_().getSheetByName(SHEET_LOG);
  sheet.appendRow([new Date(),type,read,created,updated]);
}

function isProcessedEvent_(sheet,eventId) {
  const lastRow = sheet.getLastRow();
  if (!eventId || lastRow < 2) return false;
  const start = Math.max(2,lastRow-500);
  return sheet.getRange(start,8,lastRow-start+1,1).getDisplayValues().flat().some(value => String(value).trim() === eventId);
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

function spreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
    return active;
  }
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Archivio non inizializzato: esegui una volta la funzione setupArchive dall’editor.');
  return SpreadsheetApp.openById(id);
}

function setupArchive() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Apri Apps Script dal foglio Archivio_Presenze_Romatletica.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
  onOpen();
  return `Archivio collegato: ${active.getName()}`;
}

function hardenArchive() {
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
  let map = headerMap_(sheet);
  if (map['Data richiesta prova'] === undefined) {
    sheet.getRange(1,sheet.getLastColumn()+1).setValue('Data richiesta prova');
    map = headerMap_(sheet);
  }
  const config = readConfig_();
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount < 1) throw new Error('Nessun atleta presente');
  const ids = [];
  const links = [];
  for (let i = 0; i < rowCount; i++) {
    const id = `RA-${Utilities.getUuid().replace(/-/g,'').slice(0,24).toUpperCase()}`;
    ids.push([id]);
    links.push([`${config.BASE_SITE_URL}?view=card&id=${encodeURIComponent(id)}`]);
  }
  sheet.getRange(2,map.ID_ROMATLETICA+1,rowCount,1).setValues(ids);
  sheet.getRange(2,map['Link tessera']+1,rowCount,1).setValues(links);
  populateRequestedDates_(sheet,map,rowCount);
  setConfigValue_('SCANNER_PIN','DA_IMPOSTARE');
  SpreadsheetApp.flush();
  return `${rowCount} ID protetti generati. Imposta SCANNER_PIN nel foglio Config.`;
}

function populateRequestedDates_(athletesSheet,map,rowCount) {
  const raw = spreadsheet_().getSheetByName('Import_Richieste');
  if (!raw || raw.getLastRow() < 2) return;
  const rawValues = raw.getDataRange().getValues();
  const rawHeaders = rawValues[0].map(normalizeHeader_);
  const cfIndex = rawHeaders.indexOf('codicefiscale');
  const dateIndex = rawHeaders.indexOf('datarichiesta');
  if (cfIndex < 0 || dateIndex < 0) return;
  const datesByCf = {};
  rawValues.slice(1).forEach(row => {
    const cf = String(row[cfIndex] || '').trim().toUpperCase();
    if (cf) datesByCf[cf] = row[dateIndex] || '';
  });
  const cfs = athletesSheet.getRange(2,map['Codice fiscale']+1,rowCount,1).getDisplayValues();
  athletesSheet.getRange(2,map['Data richiesta prova']+1,rowCount,1).setValues(cfs.map(row => [datesByCf[String(row[0]).trim().toUpperCase()] || '']));
  athletesSheet.getRange(2,map['Data richiesta prova']+1,rowCount,1).setNumberFormat('dd/MM/yyyy');
}

function publicDate_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, 'Europe/Rome', 'dd/MM/yyyy');
  return String(value);
}

function setConfigValue_(key, value) {
  const sheet = spreadsheet_().getSheetByName(SHEET_CONFIG);
  const rows = sheet.getDataRange().getValues();
  const index = rows.findIndex((row,i) => i > 0 && String(row[0]).trim() === key);
  if (index >= 0) sheet.getRange(index+1,2).setValue(value);
  else sheet.appendRow([key,value]);
}


function ensureMailSystem_(athletesSheet) {
  const sheet = athletesSheet || spreadsheet_().getSheetByName(SHEET_ATLETI);
  if (!sheet) throw new Error('Foglio Atleti mancante');
  let map = headerMap_(sheet);
  MAIL_HEADERS.forEach(header => {
    if (map[header] !== undefined) return;
    const column = sheet.getLastColumn() + 1;
    sheet.getRange(1, column).setValue(header);
    sheet.getRange(1, 1).copyTo(sheet.getRange(1, column), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    if (sheet.getMaxRows() > 1 && column > 1) {
      sheet.getRange(2, column - 1, sheet.getMaxRows() - 1, 1)
        .copyTo(sheet.getRange(2, column, sheet.getMaxRows() - 1, 1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    map = headerMap_(sheet);
  });
  if (map['Data invio tessera'] !== undefined) {
    sheet.getRange(2, map['Data invio tessera'] + 1, Math.max(1, sheet.getMaxRows() - 1), 1)
      .setNumberFormat('dd/MM/yyyy HH:mm');
  }
  const config = readConfig_();
  if (!config.LINK_LOCANDINE) {
    setConfigValue_('LINK_LOCANDINE', 'https://drive.google.com/drive/folders/1jq340d9ebFmfffUcqirUp4_JqTfQ8ACQ?usp=sharing');
  }
  return headerMap_(sheet);
}

function getMailQueue() {
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
  const map = ensureMailSystem_(sheet);
  if (sheet.getLastRow() < 2) return { items: [], remainingQuota: MailApp.getRemainingDailyQuota() };
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const items = values.map((row, index) => ({
    row: index + 2,
    id: String(row[map.ID_ROMATLETICA] || '').trim(),
    name: `${row[map.Nome] || ''} ${row[map.Cognome] || ''}`.trim(),
    email: String(row[map['Email invio']] || row[map.Email] || '').trim(),
    status: String(row[map['Stato invio tessera']] || MAIL_STATUS_PENDING).trim(),
    requestedDate: publicDate_(row[map['Data richiesta prova']] || ''),
    sentAt: publicDateTime_(row[map['Data invio tessera']] || ''),
    result: String(row[map['Esito invio']] || '').trim(),
    state: String(row[map.Stato] || '').toUpperCase()
  })).filter(item => item.id && item.state === 'PROVA' && item.status !== MAIL_STATUS_SENT);
  return { items, remainingQuota: MailApp.getRemainingDailyQuota() };
}

function getTrialEmailPreview(id) {
  const record = findAthlete_(String(id || ''));
  if (!record) throw new Error('Atleta non trovato');
  const message = buildTrialEmail_(record);
  return { to: message.to, subject: message.subject, html: message.htmlBody };
}

function sendTrialCardEmails(ids) {
  const selected = [...new Set((ids || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!selected.length) throw new Error('Seleziona almeno una tessera');
  const available = MailApp.getRemainingDailyQuota();
  if (selected.length > available) throw new Error(`Quota giornaliera insufficiente: restano ${available} invii`);
  const sheet = spreadsheet_().getSheetByName(SHEET_ATLETI);
  const map = ensureMailSystem_(sheet);
  const result = { sent: 0, skipped: 0, errors: [] };
  selected.forEach(id => {
    const record = findAthlete_(id);
    if (!record) {
      result.errors.push(`${id}: atleta non trovato`);
      return;
    }
    const statusCell = sheet.getRange(record.__row, map['Stato invio tessera'] + 1);
    const currentStatus = String(statusCell.getDisplayValue() || '').trim();
    if (currentStatus === MAIL_STATUS_SENT) {
      result.skipped++;
      return;
    }
    try {
      const message = buildTrialEmail_(record);
      statusCell.setValue('IN INVIO');
      SpreadsheetApp.flush();
      MailApp.sendEmail({
        to: message.to,
        subject: message.subject,
        body: message.plainBody,
        htmlBody: message.htmlBody,
        name: 'ASD Romatletica',
        replyTo: 'segreteriaromatletica@gmail.com'
      });
      statusCell.setValue(MAIL_STATUS_SENT);
      sheet.getRange(record.__row, map['Data invio tessera'] + 1).setValue(new Date());
      sheet.getRange(record.__row, map['Email invio'] + 1).setValue(message.to);
      sheet.getRange(record.__row, map['Esito invio'] + 1).setValue('Tessera inviata correttamente');
      result.sent++;
    } catch (error) {
      statusCell.setValue(MAIL_STATUS_ERROR);
      sheet.getRange(record.__row, map['Esito invio'] + 1).setValue(String(error.message || error));
      result.errors.push(`${record.Nome || ''} ${record.Cognome || ''}: ${error.message || error}`);
    }
  });
  SpreadsheetApp.flush();
  return result;
}

function buildTrialEmail_(record) {
  const config = readConfig_();
  const to = String(record['Email invio'] || record.Email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('Indirizzo email mancante o non valido');
  const fullName = `${record.Nome || ''} ${record.Cognome || ''}`.trim();
  const cardUrl = String(record['Link tessera'] || '').trim();
  if (!cardUrl) throw new Error('Link tessera mancante');
  const requestedDate = publicDate_(record['Data richiesta prova'] || '');
  const season = String(config.STAGIONE || '2026/27');
  const flyersUrl = String(config.LINK_LOCANDINE || '').trim();
  const subject = `ASD Romatletica – Tessera QR per le prove di ${fullName}`;
  const dateLine = requestedDate ? `<p style="margin:0 0 16px"><strong>Data indicata nella richiesta:</strong> ${escapeHtml_(requestedDate)}</p>` : '';
  const flyersLine = flyersUrl ? `<p style="margin:18px 0 0;font-size:14px">Per consultare giorni, orari e informazioni sui corsi: <a href="${escapeHtml_(flyersUrl)}" style="color:#123d73;font-weight:700">apri le locandine ${escapeHtml_(season)}</a>.</p>` : '';
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#172033">
  <div style="max-width:620px;margin:0 auto;padding:24px 12px">
    <div style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid #dce5f0">
      <div style="padding:20px 28px;border-bottom:5px solid #123d73">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <tr>
            <td style="padding:0 18px 0 0;vertical-align:middle">
              <img src="https://ricimarino.github.io/Presenze_Romatletica/logo.png" width="92" alt="Logo ASD Romatletica" style="display:block;width:92px;max-width:92px;height:auto;border:0">
            </td>
            <td style="vertical-align:middle">
              <div style="font-size:28px;font-weight:800;color:#123d73;letter-spacing:.3px">ASD Romatletica</div>
              <div style="margin-top:4px;color:#667085">Atletica leggera a Roma · Stagione ${escapeHtml_(season)}</div>
            </td>
          </tr>
        </table>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 16px">Buongiorno,</p>
        <p style="margin:0 0 16px">abbiamo preparato la <strong>tessera personale per le prove di ${escapeHtml_(fullName)}</strong>.</p>
        ${dateLine}
        <p style="margin:0 0 20px">Conserva questa email e mostra il QR presente nella tessera all’ingresso del campo. Le prove gratuite permettono di conoscere il corso, gli allenatori e il gruppo prima dell’iscrizione; in base alla categoria sono previste una o due giornate di prova.</p>
        <div style="margin:20px 0;padding:16px 18px;background:#eef5fb;border-left:4px solid #123d73;border-radius:8px">
          <strong style="color:#123d73">Una piccola attenzione per Caracalla</strong>
          <p style="margin:8px 0 0;line-height:1.5">Nell’impianto operano numerose società sportive. Per svolgere la prova prenotata con <strong>ASD Romatletica</strong>, all’arrivo chiedi espressamente di <strong>ASD Romatletica o di Anna</strong> e mostra questa tessera: sarai così indirizzato al nostro gruppo e ai nostri tecnici, evitando equivoci. La scelta del percorso sportivo resta naturalmente libera; desideriamo semplicemente che la prova richiesta con noi si svolga con la società che hai contattato.</p>
        </div>
        <div style="text-align:center;margin:28px 0">
          <a href="${escapeHtml_(cardUrl)}" style="display:inline-block;background:#123d73;color:#fff;text-decoration:none;font-weight:800;padding:15px 24px;border-radius:10px">APRI LA TESSERA PERSONALE</a>
        </div>
        <p style="margin:0;font-size:13px;color:#667085">Il collegamento è personale: non inoltrarlo ad altre famiglie.</p>
        ${flyersLine}
        <p style="margin:26px 0 0">A presto al campo!<br><strong>La Segreteria ASD Romatletica</strong></p>
      </div>
    </div>
  </div></body></html>`;
  const plainBody = `Buongiorno,\n\nabbiamo preparato la tessera personale per le prove di ${fullName}.${requestedDate ? `\nData indicata nella richiesta: ${requestedDate}.` : ''}\n\nApri la tessera personale:\n${cardUrl}\n\nConserva questa email e mostra il QR all’ingresso del campo.\n\nUna piccola attenzione per Caracalla: nell’impianto operano numerose società sportive. Per svolgere la prova prenotata con ASD Romatletica, all’arrivo chiedi espressamente di ASD Romatletica o di Anna e mostra questa tessera, così sarai indirizzato al nostro gruppo e ai nostri tecnici evitando equivoci. La scelta del percorso sportivo resta naturalmente libera; desideriamo semplicemente che la prova richiesta con noi si svolga con la società che hai contattato.\n\nA presto al campo!\nLa Segreteria ASD Romatletica`;
  return { to, subject, htmlBody, plainBody };
}

function publicDateTime_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, 'Europe/Rome', 'dd/MM/yyyy HH:mm');
  return String(value);
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function checkConfiguration() {
  const config = readConfig_();
  const missing = ['BACKEND_URL','LINK_ISCRIZIONE_GOLEE'].filter(key => !config[key] || String(config[key]).startsWith('DA_INSERIRE'));
  SpreadsheetApp.getUi().alert(missing.length ? `Da completare: ${missing.join(', ')}` : 'Configurazione completa.');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
