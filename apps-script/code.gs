// ============================================================
// TCE DESK BOOKING — Apps Script Backend
// Called by Cloudflare Worker — no direct browser access
// User identity comes from workerEmail/workerToken params
//
// This file is a REFERENCE COPY for version control and diffing only.
// Committing to this repo does NOT deploy it. The live backend runs from
// whatever is pasted into the Apps Script editor (script.google.com) for
// this project, and only goes live after: Deploy -> Manage deployments ->
// edit the existing deployment -> New version -> Deploy. See
// ARCHITECTURE.md section 8 for the full deploy procedure and why editor
// content and the live deployment can silently drift out of sync.
// ============================================================

const SHEET_ID = '1C1k-ZMmizDFf357fAQvKdKgjmgaP8V_zmGrie-KR0vI';
const GLASS_BOX_CALENDAR = 'c_1880lps1iqdbajhuggvb8tlc8i36g@resource.calendar.google.com';
const SOCIAL_CALENDAR_ID = 'c_41272cd4467c35eed3257bd6912351aeeb5f781d00f7eafdf345ba6ebf7ea08c@group.calendar.google.com';
// Sage HR's calendar-sync feed (Settings > Calendar sync in Sage) — a plain
// iCal (.ics) file, not a Google Calendar. https:// works identically to the
// webcal:// scheme it's given out as; UrlFetchApp doesn't understand webcal.
//
// The URL itself is a bearer secret — anyone who has it can read the whole
// company's leave/birthday/anniversary data with no further auth — so it's
// a Script Property (Project Settings > Script Properties in the Apps
// Script editor), not a hardcoded constant in this file. This file is
// committed to a repo; a Script Property isn't.
function getSageIcsUrl() {
  const url = PropertiesService.getScriptProperties().getProperty('SAGE_ICS_URL');
  if (!url) throw new Error('SAGE_ICS_URL script property not set — see ARCHITECTURE.md section 8.');
  return url;
}
const DOMAIN = 'thecontentemporium.co.uk';
const TOTAL_CORE_DESKS = 12;
const OFFICE_START_HOUR = 8;
const OFFICE_END_HOUR = 19;

// ============================================================
// PERFORMANCE: shared cache + single spreadsheet open
// ------------------------------------------------------------
// Week bookings, social events, glass-box and the admin list are IDENTICAL for
// every user, so we cache them in the script-wide CacheService. Under load (each
// page load prefetches several weeks) this turns ~10 cold Apps Script + Sheets
// round-trips into cheap cache hits, which is what stops the 30s timeouts and the
// HTML error pages the worker was choking on. Writes invalidate the affected week.
// ============================================================

const CACHE = CacheService.getScriptCache();
const WEEK_TTL = 90;    // bookings — short; invalidated immediately on write
const SOCIAL_TTL = 300; // social calendar — changes rarely
const GLASS_TTL = 45;   // glass box — invalidated on book/cancel
const ADMIN_TTL = 600;  // admin list — changes almost never

// Memoized per-execution spreadsheet handle so getSheet() doesn't re-open the
// file for every sheet (previously 3 openById calls per getAll).
let __ss = null;
function getSpreadsheet() {
  if (!__ss) __ss = SpreadsheetApp.openById(SHEET_ID);
  return __ss;
}

// Monday (yyyy-MM-dd) of whatever date/weekStart is passed. Cache keys are keyed
// on this so a booking's date maps to the same key the frontend requests.
function mondayStr(dateInput) {
  const d = new Date(dateInput);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function invalidateWeek(dateInput) {
  try { CACHE.remove('wk_' + mondayStr(dateInput)); } catch (e) {}
}
function invalidateGlass(dateInput) {
  try { CACHE.remove('gb_' + mondayStr(dateInput)); } catch (e) {}
}
// Month summary is cached per-user (the `mine` field is user-specific); a user's
// own booking/cancel invalidates their view of the affected month immediately.
function monthKeyOf(dateInput) {
  const d = new Date(dateInput);
  return d.getFullYear() + '-' + d.getMonth();
}
function invalidateMonth(dateInput, email) {
  try { CACHE.remove('ms_' + normEmail(email) + '_' + monthKeyOf(dateInput)); } catch (e) {}
}

// ============================================================
// HTTP HANDLERS
// ============================================================

function doGet(e) {
  const action = e.parameter.action;
  const email = e.parameter.workerEmail || '';
  const name = e.parameter.workerName || '';
  const picture = e.parameter.workerPicture || '';
  const token = e.parameter.workerToken || '';

  if (!email || !normEmail(email).endsWith('@' + DOMAIN)) {
    return jsonResponse({ error: 'unauthenticated' });
  }

  const user = { email, name, picture, access_token: token };

  try {
    switch (action) {
      case 'getAll':
        return jsonResponse(getAllData(e.parameter.weekStart, user));
      case 'getGlassBox':
        return jsonResponse(getGlassBoxWeek(e.parameter.weekStart, user));
      case 'getMonthSummary':
        return jsonResponse(getMonthSummary(e.parameter.monthStart, user));
      case 'getHolidays': {
        const cal = getHolidaysThisWeek();
        return jsonResponse({ success: true, holidays: cal.holidays, birthdays: cal.birthdays, anniversaries: cal.anniversaries });
      }
      default:
        return jsonResponse({ error: 'Unknown action: ' + action });
    }
  } catch(err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const email = data.workerEmail || '';
  const name = data.workerName || '';
  const token = data.workerToken || '';

  if (!email || !normEmail(email).endsWith('@' + DOMAIN)) {
    return jsonResponse({ error: 'unauthenticated' });
  }

  const user = { email, name, access_token: token };

  try {
    switch (data.action) {
      case 'bookDesk': return jsonResponse(withLock(() => bookDesk(data, user)));
      case 'toggleDog': return jsonResponse(withLock(() => toggleDog(data, user)));
      case 'cancelDesk': return jsonResponse(withLock(() => cancelDesk(data, user)));
      case 'adminCancelDesk': return jsonResponse(withLock(() => adminCancelDesk(data, user)));
      case 'bookMyWeek': return jsonResponse(withLock(() => bookMyWeek(data, user)));
      case 'cancelMyWeek': return jsonResponse(withLock(() => cancelMyWeek(data, user)));
      case 'bookGlassBox': return jsonResponse(bookGlassBox(data, user));
      case 'cancelGlassBox': return jsonResponse(cancelGlassBox(data, user));
      case 'searchPeople': return jsonResponse(searchPeopleByQuery(data.query));
      default: return jsonResponse({ error: 'Unknown action: ' + data.action });
    }
  } catch(err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// EMAIL / LOCK HELPERS
// ============================================================

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Prevents Sheets/Excel formula injection: a name starting with =,+,-,@ would
// otherwise be evaluated as a formula when the sheet is opened.
function sanitizeSheetValue(raw) {
  const s = String(raw || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function normSlot(raw) {
  const s = String(raw || '').trim();
  return (s === 'AM' || s === 'PM') ? s : 'full';
}

// Dog flag lives in the last Bookings column (index 6). Old rows predate the
// column, so anything falsy/absent reads as "no dog".
function truthyDog(raw) {
  return raw === true || raw === 'true' || raw === 'TRUE' || raw === 1 || raw === 'yes';
}

// Core-desk bookings for a date, as {desk, slot} pairs (overflow desks excluded).
// Desk numbers are coerced to Number here since Sheets can return them as strings
// for manually-entered/imported rows, and every occupancy check below uses strict
// (===/!==) comparison against the numeric desk loop variable.
function getDayCoreRows(allData, date) {
  return allData.slice(1)
    .filter(row => parseRowDate(row[0]) === date && Number(row[1]) <= TOTAL_CORE_DESKS)
    .map(row => ({ desk: Number(row[1]), slot: normSlot(row[5]) }));
}

function getDeskOccupancy(dayCoreRows, desk) {
  let full = false, am = false, pm = false;
  dayCoreRows.forEach(r => {
    if (r.desk !== desk) return;
    if (r.slot === 'full') full = true;
    else if (r.slot === 'AM') am = true;
    else if (r.slot === 'PM') pm = true;
  });
  return { full, amTaken: full || am, pmTaken: full || pm, isFullyFree: !full && !am && !pm };
}

function isSlotAvailable(dayCoreRows, desk, slot) {
  const occ = getDeskOccupancy(dayCoreRows, desk);
  if (slot === 'full') return occ.isFullyFree;
  if (slot === 'AM') return !occ.amTaken;
  if (slot === 'PM') return !occ.pmTaken;
  return false;
}

function findOwnBookingRow(allData, date, email) {
  const target = normEmail(email);
  for (let i = 1; i < allData.length; i++) {
    if (parseRowDate(allData[i][0]) === date && normEmail(allData[i][3]) === target) return i;
  }
  return -1;
}

// Shared auto-assign logic used by bookDesk (no desk given) and bookMyWeek.
function assignDeskForSlot(allData, date, slot) {
  const dayCoreRows = getDayCoreRows(allData, date);
  for (let d = 1; d <= TOTAL_CORE_DESKS; d++) {
    if (isSlotAvailable(dayCoreRows, d, slot)) return d;
  }
  const takenDesks = allData.slice(1)
    .filter(row => parseRowDate(row[0]) === date)
    .map(row => Number(row[1]));
  let ov = 1;
  while (takenDesks.includes(TOTAL_CORE_DESKS + ov)) ov++;
  return TOTAL_CORE_DESKS + ov;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return { error: 'Another booking change is in progress — please try again.' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ADMIN
// ============================================================

function isAdmin(email) {
  const target = normEmail(email);
  if (!target) return false;

  // Cache the admin list (changes almost never) instead of reading the sheet
  // on every getAll.
  let admins;
  const cached = CACHE.get('admins');
  if (cached) {
    admins = JSON.parse(cached);
  } else {
    const values = getSheet('Admins').getDataRange().getValues();
    admins = [];
    for (let i = 1; i < values.length; i++) admins.push(normEmail(values[i][0]));
    try { CACHE.put('admins', JSON.stringify(admins), ADMIN_TTL); } catch (e) {}
  }
  return admins.indexOf(target) !== -1;
}

function adminCancelDesk(data, user) {
  if (!isAdmin(user.email)) {
    return { error: 'Not authorized.' };
  }
  // calendarUser=null: no way to clear the *target* user's calendar event with the
  // admin's own OAuth token, so their stale working-location entry is left in place.
  const result = cancelBookingForEmail(data.date, data.targetEmail, null);
  if (result.error) return { error: 'No booking found for that person on that date.' };
  return { success: true };
}

// ============================================================
// SHEET HELPERS
// ============================================================

function getSheet(name) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === 'Bookings') sheet.appendRow(['Date', 'Desk', 'Name', 'Email', 'BookedAt', 'Slot', 'Dog']);
    if (name === 'DayNotes') sheet.appendRow(['Date', 'Note', 'UpdatedAt', 'UpdatedBy']);
    if (name === 'Admins') sheet.appendRow(['Email']);
    if (name === 'SageEvents') sheet.appendRow(['Name', 'Kind', 'Start', 'End']);
  }
  return sheet;
}

function parseRowDate(raw) {
  if (raw instanceof Date) return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(raw).trim();
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.substring(0, 10);
  if (s.match(/^\d{2}\/\d{2}\/\d{4}/)) {
    const p = s.substring(0, 10).split('/');
    return p[2] + '-' + p[1] + '-' + p[0];
  }
  return Utilities.formatDate(new Date(raw), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getBookingsForRange(startDate, endDate) {
  const sheet = getSheet('Bookings');
  const data = sheet.getDataRange().getValues();
  const bookings = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowDate = parseRowDate(row[0]);
    if (rowDate >= startDate && rowDate <= endDate) {
      if (!bookings[rowDate]) bookings[rowDate] = [];
      bookings[rowDate].push({ desk: Number(row[1]), name: row[2], email: row[3], slot: normSlot(row[5]), dog: truthyDog(row[6]) });
    }
  }
  return bookings;
}

function getNotesForRange(startDate, endDate) {
  const sheet = getSheet('DayNotes');
  const data = sheet.getDataRange().getValues();
  const notes = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowDate = parseRowDate(row[0]);
    if (rowDate >= startDate && rowDate <= endDate) {
      notes[rowDate] = { note: row[1], updatedBy: row[3] };
    }
  }
  return notes;
}

// ============================================================
// WEEK DATA
// ============================================================

function getWeekData(weekStart) {
  // Identical for every user → cache it. Booking writes call invalidateWeek() so
  // a just-booked desk shows up immediately; the 90s TTL is only a safety backstop.
  const cacheKey = 'wk_' + mondayStr(weekStart);
  const cached = CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const start = new Date(weekStart);
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 4);

  const startStr = Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const bookings = getBookingsForRange(startStr, endStr);
  const notes = getNotesForRange(startStr, endStr);

  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const dayBookings = bookings[dateStr] || [];

    const desks = [];
    for (let desk = 1; desk <= TOTAL_CORE_DESKS; desk++) {
      const deskBookings = dayBookings.filter(b => b.desk === desk);
      const fullB = deskBookings.find(b => b.slot === 'full') || null;
      const amB = deskBookings.find(b => b.slot === 'AM') || null;
      const pmB = deskBookings.find(b => b.slot === 'PM') || null;
      desks.push({
        desk,
        full: fullB ? { name: fullB.name, email: fullB.email, dog: fullB.dog } : null,
        am: amB ? { name: amB.name, email: amB.email, dog: amB.dog } : null,
        pm: pmB ? { name: pmB.name, email: pmB.email, dog: pmB.dog } : null
      });
    }
    const overflow = dayBookings
      .filter(b => b.desk > TOTAL_CORE_DESKS)
      .map(b => ({ desk: b.desk, name: b.name, email: b.email, slot: b.slot, dog: b.dog }));
    days.push({ date: dateStr, desks, overflow, note: notes[dateStr] || null });
  }
  const result = { success: true, days };
  try { CACHE.put(cacheKey, JSON.stringify(result), WEEK_TTL); } catch (e) {}
  return result;
}

// ============================================================
// BATCHED LOAD
// ============================================================

function getAllData(weekStart, user) {
  const weekResult = getWeekData(weekStart);
  const prefs = { name: user.name, email: user.email, picture: user.picture || '', isAdmin: isAdmin(user.email) };

  const start = new Date(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);

  // Glass Box loaded separately via getGlassBox action (deferred)
  const glassBox = {};

  const social = getSocialEvents(
    Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    Utilities.formatDate(weekEnd, Session.getScriptTimeZone(), 'yyyy-MM-dd')
  );

  return { success: true, days: weekResult.days, glassBox, prefs, socialEvents: social.events || [] };
}

// ============================================================
// GLASS BOX WEEK FETCH (deferred load)
// ============================================================

function getGlassBoxWeek(weekStart, user) {
  // Shared resource calendar → same for all users; cache per week.
  // Invalidated by bookGlassBox/cancelGlassBox.
  const cacheKey = 'gb_' + mondayStr(weekStart);
  const cached = CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const start = new Date(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 4);

  const rangeStart = new Date(start);
  rangeStart.setHours(OFFICE_START_HOUR, 0, 0, 0);
  const rangeEnd = new Date(weekEnd);
  rangeEnd.setHours(OFFICE_END_HOUR, 0, 0, 0);

  let glassBox = {};
  try {
    const eventsRes = UrlFetchApp.fetch(
      'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(GLASS_BOX_CALENDAR) +
      '/events?timeMin=' + rangeStart.toISOString() +
      '&timeMax=' + rangeEnd.toISOString() +
      '&singleEvents=true&orderBy=startTime',
      { headers: { Authorization: 'Bearer ' + user.access_token } }
    );
    const events = JSON.parse(eventsRes.getContentText());
    (events.items || []).forEach(ev => {
      const dateKey = ev.start.dateTime
        ? Utilities.formatDate(new Date(ev.start.dateTime), Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : ev.start.date;
      if (!glassBox[dateKey]) glassBox[dateKey] = [];
      glassBox[dateKey].push({
        id: ev.id,
        title: ev.summary || 'Booked',
        organizer: ev.organizer ? ev.organizer.email : null,
        start: ev.start.dateTime,
        end: ev.end.dateTime
      });
    });
    const result = { success: true, glassBox };
    try { CACHE.put(cacheKey, JSON.stringify(result), GLASS_TTL); } catch (e) {}
    return result;
  } catch(e) {}

  return { success: true, glassBox };
}

// ============================================================
// DESK BOOKING
// ============================================================

function bookDesk(data, user) {
  const { date } = data;
  const desk = data.desk ? Number(data.desk) : null;
  const slot = normSlot(data.slot);
  const dog = truthyDog(data.dog);
  const { name, email } = user;

  const sheet = getSheet('Bookings');
  const allData = sheet.getDataRange().getValues();

  const existingIdx = findOwnBookingRow(allData, date, email);
  if (existingIdx !== -1) {
    return { error: 'You already have desk ' + allData[existingIdx][1] + ' booked on this day.' };
  }

  if (desk) {
    if (desk <= TOTAL_CORE_DESKS) {
      const dayCoreRows = getDayCoreRows(allData, date);
      if (!isSlotAvailable(dayCoreRows, desk, slot)) {
        return { error: 'Desk ' + desk + ' is not available for that slot on this day.' };
      }
    } else {
      const clash = allData.slice(1).some(row => parseRowDate(row[0]) === date && Number(row[1]) === desk);
      if (clash) return { error: 'Desk ' + desk + ' is already taken.' };
    }
    sheet.appendRow([date, desk, sanitizeSheetValue(name), email, new Date(), slot, dog]);
    setWorkingLocation(date, user);
    invalidateWeek(date);
    invalidateMonth(date, email);
    return { success: true, desk, slot };
  }

  const assignedDesk = assignDeskForSlot(allData, date, slot);
  sheet.appendRow([date, assignedDesk, sanitizeSheetValue(name), email, new Date(), slot, dog]);
  setWorkingLocation(date, user);
  invalidateWeek(date);
  invalidateMonth(date, email);
  return { success: true, desk: assignedDesk, slot };
}

// Flip the dog flag on the caller's own booking for a day. The dog is tied to the
// booking row, so cancelling the desk removes it automatically (no separate store).
function toggleDog(data, user) {
  const { date } = data;
  const sheet = getSheet('Bookings');
  const allData = sheet.getDataRange().getValues();

  const idx = findOwnBookingRow(allData, date, user.email);
  if (idx === -1) return { error: 'You need a desk booked on this day before adding a dog.' };

  const next = !truthyDog(allData[idx][6]);
  // Sheet rows are 1-based and include the header, so the sheet row = idx + 1.
  // Column 7 (Dog) is the 7th column.
  sheet.getRange(idx + 1, 7).setValue(next);
  invalidateWeek(date);
  return { success: true, dog: next };
}

// Shared by cancelDesk/adminCancelDesk/cancelMyWeek. calendarUser is the caller's
// `user` object when clearing their own working-location event is appropriate
// (self-cancel), or null to skip it (admin cancelling someone else's booking —
// there's no way to clear the target's calendar with the admin's own OAuth token).
function cancelBookingForEmail(date, email, calendarUser) {
  const sheet = getSheet('Bookings');
  const allData = sheet.getDataRange().getValues();
  const target = normEmail(email);

  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    if (parseRowDate(row[0]) === date && normEmail(row[3]) === target) {
      const deskNum = Number(row[1]);
      const slot = normSlot(row[5]);
      sheet.deleteRow(i + 1);
      if (calendarUser) clearWorkingLocation(date, calendarUser);
      if (deskNum <= TOTAL_CORE_DESKS) promoteOverflow(sheet, date, deskNum, slot);
      invalidateWeek(date);
      invalidateMonth(date, target);
      return { success: true, desk: deskNum, slot };
    }
  }
  return { error: 'No booking found for that date.' };
}

function cancelDesk(data, user) {
  const result = cancelBookingForEmail(data.date, user.email, user);
  if (result.error) return { error: 'No booking found for your account on that date.' };
  return { success: true };
}

// ============================================================
// MONTH SUMMARY / BULK WEEK ACTIONS
// ============================================================

// Per day in the month: `mine` is 'core'|'overflow'|null (the caller's own booking
// that day, if any) and `full` is true when every core desk (1-TOTAL_CORE_DESKS) is
// completely occupied that day (either a 'full' row, or both an AM and a PM row).
function getMonthSummary(monthStart, user) {
  // Per-user cache: the whole-sheet read + occupancy calc is the slow part, and
  // the header calendar re-requests it on every page load. TTL is a backstop —
  // the user's own writes invalidate it via invalidateMonth() for instant freshness.
  const cacheKey = 'ms_' + normEmail(user.email) + '_' + monthKeyOf(monthStart);
  const cached = CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const start = new Date(monthStart);
  const year = start.getFullYear();
  const monthIndex = start.getMonth();
  const rangeStartStr = Utilities.formatDate(new Date(year, monthIndex, 1), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rangeEndStr = Utilities.formatDate(new Date(year, monthIndex + 1, 0), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const sheet = getSheet('Bookings');
  const allData = sheet.getDataRange().getValues();
  const target = normEmail(user.email);

  const coreRowsByDate = {};
  const mineByDate = {};

  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowDate = parseRowDate(row[0]);
    if (rowDate < rangeStartStr || rowDate > rangeEndStr) continue;

    const desk = Number(row[1]);
    if (desk <= TOTAL_CORE_DESKS) {
      if (!coreRowsByDate[rowDate]) coreRowsByDate[rowDate] = [];
      coreRowsByDate[rowDate].push({ desk, slot: normSlot(row[5]) });
    }
    if (normEmail(row[3]) === target) {
      mineByDate[rowDate] = desk <= TOTAL_CORE_DESKS ? 'core' : 'overflow';
    }
  }

  const allDates = new Set([...Object.keys(coreRowsByDate), ...Object.keys(mineByDate)]);
  const days = {};
  allDates.forEach(date => {
    const coreRows = coreRowsByDate[date] || [];
    let full = true;
    for (let d = 1; d <= TOTAL_CORE_DESKS; d++) {
      const occ = getDeskOccupancy(coreRows, d);
      if (!(occ.amTaken && occ.pmTaken)) { full = false; break; }
    }
    days[date] = { mine: mineByDate[date] || null, full };
  });

  const out = { success: true, days };
  try { CACHE.put(cacheKey, JSON.stringify(out), 120); } catch (e) {}
  return out;
}

function bookMyWeek(data, user) {
  const start = new Date(data.weekStart);
  const results = [];

  // Read once — withLock() already serializes this against other writers, and
  // each iteration below only appends a row for a distinct date, so a single
  // snapshot read at the top stays accurate for every day's own-booking/assign
  // check without re-reading the whole sheet 5 times.
  const sheet = getSheet('Bookings');
  const allData = sheet.getDataRange().getValues();

  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    if (findOwnBookingRow(allData, dateStr, user.email) !== -1) {
      results.push({ date: dateStr, status: 'already-booked' });
      continue;
    }

    const assignedDesk = assignDeskForSlot(allData, dateStr, 'full');
    sheet.appendRow([dateStr, assignedDesk, sanitizeSheetValue(user.name), user.email, new Date(), 'full', false]);
    setWorkingLocation(dateStr, user);
    results.push({ date: dateStr, status: 'booked', desk: assignedDesk });
  }

  invalidateWeek(data.weekStart);
  const wkEnd = new Date(start); wkEnd.setDate(wkEnd.getDate() + 4);
  invalidateMonth(data.weekStart, user.email);
  invalidateMonth(wkEnd, user.email);
  return { success: true, results };
}

function cancelMyWeek(data, user) {
  const start = new Date(data.weekStart);
  const results = [];

  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dateStr = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    const result = cancelBookingForEmail(dateStr, user.email, user);
    results.push(result.error
      ? { date: dateStr, status: 'no-booking' }
      : { date: dateStr, status: 'cancelled', desk: result.desk });
  }

  return { success: true, results };
}

// ============================================================
// OVERFLOW AUTO-CLAIM
// ============================================================

function getFreedCapacity(sheet, date, desk) {
  const allData = sheet.getDataRange().getValues();
  const dayCoreRows = getDayCoreRows(allData, date);
  const occ = getDeskOccupancy(dayCoreRows, desk);
  if (occ.isFullyFree) return 'full';
  if (!occ.amTaken) return 'AM';
  if (!occ.pmTaken) return 'PM';
  return null; // fully occupied already — nothing to promote into
}

// Re-reads fresh; finds the earliest-BookedAt overflow row (desk > TOTAL_CORE_DESKS)
// for `date` whose slot matches requiredSlot (any slot if null), and moves it onto
// `desk` in place (preserves BookedAt and Slot). Returns the promoted slot, or null.
function promoteEarliestOverflow(sheet, date, desk, requiredSlot) {
  const values = sheet.getDataRange().getValues();
  let bestRowIdx = -1, bestTime = null, bestSlot = null;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (parseRowDate(row[0]) !== date) continue;
    if (row[1] <= TOTAL_CORE_DESKS) continue;
    const slot = normSlot(row[5]);
    if (requiredSlot && slot !== requiredSlot) continue;
    const bookedAt = new Date(row[4]);
    if (bestRowIdx === -1 || bookedAt < bestTime) {
      bestRowIdx = i; bestTime = bookedAt; bestSlot = slot;
    }
  }
  if (bestRowIdx === -1) return null;

  sheet.getRange(bestRowIdx + 1, 2).setValue(desk);
  return bestSlot;
}

function promoteOverflow(sheet, date, freedDesk, freedSlot) {
  const capacity = getFreedCapacity(sheet, date, freedDesk);
  if (!capacity) return;

  if (capacity === 'full') {
    const promotedSlot = promoteEarliestOverflow(sheet, date, freedDesk, null);
    if (!promotedSlot || promotedSlot === 'full') return;
    const complementSlot = promotedSlot === 'AM' ? 'PM' : 'AM';
    promoteEarliestOverflow(sheet, date, freedDesk, complementSlot);
    return;
  }

  // Only one specific half was freed — only an exact-matching overflow slot qualifies.
  promoteEarliestOverflow(sheet, date, freedDesk, capacity);
}

// ============================================================
// WORKING LOCATION
// ============================================================

function setWorkingLocation(date, user) {
  try {
    UrlFetchApp.fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          start: { date: date },
          end: { date: date },
          summary: 'In Office',
          eventType: 'workingLocation',
          workingLocationProperties: {
            type: 'officeOrOtherLocation',
            officeLocation: { label: 'TCE Office' }
          },
          transparency: 'transparent',
          visibility: 'public'
        }),
        headers: { Authorization: 'Bearer ' + user.access_token }
      }
    );
  } catch(e) {}
}

function clearWorkingLocation(date, user) {
  try {
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?eventTypes=workingLocation&timeMin=' + date + 'T00:00:00Z&timeMax=' + date + 'T23:59:59Z',
      { headers: { Authorization: 'Bearer ' + user.access_token } }
    );
    const events = JSON.parse(res.getContentText());
    (events.items || []).forEach(ev => {
      UrlFetchApp.fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + ev.id,
        { method: 'delete', headers: { Authorization: 'Bearer ' + user.access_token } }
      );
    });
  } catch(e) {}
}

// ============================================================
// GLASS BOX
// ============================================================

function bookGlassBox(data, user) {
  const { date, startTime, endTime, title, invitees } = data;
  const { email, name } = user;

  const newStart = new Date(date + 'T' + startTime + ':00');
  const newEnd = new Date(date + 'T' + endTime + ':00');

  if (newEnd <= newStart) return { error: 'End time must be after start time.' };

  // Check conflicts
  const startOfDay = new Date(date);
  startOfDay.setHours(OFFICE_START_HOUR, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(OFFICE_END_HOUR, 0, 0, 0);

  const existingRes = UrlFetchApp.fetch(
    'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(GLASS_BOX_CALENDAR) +
    '/events?timeMin=' + startOfDay.toISOString() +
    '&timeMax=' + endOfDay.toISOString() +
    '&singleEvents=true',
    { headers: { Authorization: 'Bearer ' + user.access_token } }
  );
  const existing = JSON.parse(existingRes.getContentText());

  for (const ev of (existing.items || [])) {
    const bStart = new Date(ev.start.dateTime);
    const bEnd = new Date(ev.end.dateTime);
    if (newStart < bEnd && newEnd > bStart) {
      return { error: 'The Glass Box is already booked from ' + formatTime(bStart) + ' to ' + formatTime(bEnd) + '.' };
    }
  }

  const attendees = [{ email: GLASS_BOX_CALENDAR, resource: true }];
  if (invitees && invitees.length > 0) {
    invitees.forEach(inv => { if (inv && inv.trim() && inv.trim() !== email) attendees.push({ email: inv.trim() }); });
  }

  const event = {
    summary: title || 'Glass Box — ' + name,
    start: { dateTime: newStart.toISOString(), timeZone: Session.getScriptTimeZone() },
    end: { dateTime: newEnd.toISOString(), timeZone: Session.getScriptTimeZone() },
    attendees
  };

  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(event),
      headers: { Authorization: 'Bearer ' + user.access_token }
    }
  );

  const created = JSON.parse(res.getContentText());
  invalidateGlass(date);
  return { success: true, eventId: created.id };
}

function cancelGlassBox(data, user) {
  const { eventId } = data;

  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId,
    { headers: { Authorization: 'Bearer ' + user.access_token } }
  );
  const ev = JSON.parse(res.getContentText());
  if (ev.error) return { error: 'Booking not found.' };
  if (!ev.organizer || normEmail(ev.organizer.email) !== normEmail(user.email)) {
    return { error: 'Only the organizer can cancel this booking.' };
  }

  UrlFetchApp.fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId + '?sendUpdates=all',
    { method: 'delete', headers: { Authorization: 'Bearer ' + user.access_token } }
  );

  if (ev.start && ev.start.dateTime) invalidateGlass(ev.start.dateTime);
  return { success: true };
}

// ============================================================
// SOCIAL CALENDAR
// ============================================================

function getSocialEvents(startDate, endDate) {
  // CalendarApp is slow (seconds) and the result is the same for everyone, so
  // cache per week. Social events don't change on desk bookings → no invalidation.
  const cacheKey = 'soc_' + mondayStr(startDate);
  const cached = CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const start = new Date(startDate); start.setHours(0, 0, 0, 0);
  const end = new Date(endDate); end.setHours(23, 59, 59, 0);
  try {
    const cal = CalendarApp.getCalendarById(SOCIAL_CALENDAR_ID);
    if (!cal) return { events: [] };
    const gcalEvents = cal.getEvents(start, end);
    const events = gcalEvents.map(ev => ({
      title: ev.getTitle(),
      date: Utilities.formatDate(ev.getStartTime(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    }));
    const result = { success: true, events };
    try { CACHE.put(cacheKey, JSON.stringify(result), SOCIAL_TTL); } catch (e) {}
    return result;
  } catch(e) {
    return { events: [], error: e.message };
  }
}

// ============================================================
// HOLIDAYS / BIRTHDAYS / ANNIVERSARIES (Sage HR calendar-sync feed)
// ------------------------------------------------------------
// Sage exposes one iCal feed mixing absences, birthdays, and work
// anniversaries, distinguished only by a keyword in each event's title (no
// separate feed, no field to key off — see classifyCalendarEvent). Fetching
// and parsing that feed live on every request would mean a slow or
// unreachable Sage directly breaks the app, so instead:
//
//   refreshHolidaysFromSage() — fetches + parses the feed, writes every
//     event into the SageEvents sheet tab. Runs weekly via a trigger (see
//     installSageWeeklyTrigger), never per-request.
//   getHolidaysThisWeek() — reads SageEvents (fast local sheet read),
//     filtered to the current Mon–Fri window. This is what actually serves
//     the getHolidays API action; it never talks to Sage directly.
//
// If a week goes by without the trigger firing (quota issue, feed down,
// etc.), the app just keeps serving last week's SageEvents snapshot rather
// than breaking — stale is preferable to broken here.
// ============================================================

function classifyCalendarEvent(title) {
  const t = String(title || '');
  if (/\banniversary\b/i.test(t)) return 'anniversary';
  if (/\bbirthday\b/i.test(t)) return 'birthday';
  return 'holiday';
}

// Sage titles are consistently "<Name> - <Category>" (e.g. "Jane Smith -
// Birthday", "Jane Smith - Employment anniversary", "Jane Smith - TOIL,
// Full day"); company-wide bank holidays ("Christmas Day") have no " - " at
// all and come back unchanged. Splitting on the first " - " is far more
// reliable than stripping category keywords, since categories vary freely
// and a few multi-part-day summaries have a known Sage-side glitch where the
// text repeats itself after the category — that repeat lands after the
// split point either way, so it's discarded along with the category.
function sageEventName(summary) {
  const idx = summary.indexOf(' - ');
  return (idx === -1 ? summary : summary.substring(0, idx)).trim();
}

function unfoldIcsLines(text) {
  // RFC5545 line folding: a continuation line starts with a single space or
  // tab and should be joined to the previous line before parsing anything.
  return String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function unescapeIcsText(s) {
  return String(s || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// value is either 'YYYYMMDD' (all-day) or 'YYYYMMDDTHHMMSS' (timed, always
// local Europe/London time in this feed — no UTC/Z-suffixed values appear on
// real VEVENTs, only on DTSTAMP, which this doesn't parse).
function parseIcsDateValue(value, isAllDay) {
  const y = Number(value.substr(0, 4));
  const mo = Number(value.substr(4, 2)) - 1;
  const d = Number(value.substr(6, 2));
  if (isAllDay) return new Date(y, mo, d);
  return new Date(y, mo, d, Number(value.substr(9, 2) || 0), Number(value.substr(11, 2) || 0), Number(value.substr(13, 2) || 0));
}

// Fetches the whole Sage feed and replaces SageEvents in one go. Intended to
// run weekly via a trigger, not per-request. Parses fully into `rows` before
// touching the sheet, so a failed fetch or a feed that suddenly parses to
// nothing leaves the existing (still-useful) sheet data untouched rather
// than wiping it.
function refreshHolidaysFromSage() {
  const res = UrlFetchApp.fetch(getSageIcsUrl(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;

  const text = unfoldIcsLines(res.getContentText());
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  const rows = [];

  // Sage's own feed spans well over a year (past + future events); the app
  // only ever looks at the current Mon-Fri week, so mirroring all of it just
  // makes SageEvents — and every getHolidaysThisWeek() read of it — bigger
  // for no benefit. Keeping a few weeks of slack on each side (rather than
  // exactly this week) means a missed weekly refresh — Sage down, quota,
  // whatever — doesn't immediately blank the widget; it just serves a
  // slightly stale window until the next successful refresh.
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 7);
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + 30);
  const windowStartStr = Utilities.formatDate(windowStart, 'Europe/London', 'yyyy-MM-dd');
  const windowEndStr = Utilities.formatDate(windowEnd, 'Europe/London', 'yyyy-MM-dd');

  blocks.forEach(function (block) {
    const dtstartMatch = block.match(/DTSTART(;[^:\r\n]*)?:([^\r\n]+)/);
    const dtendMatch = block.match(/DTEND(;[^:\r\n]*)?:([^\r\n]+)/);
    const summaryMatch = block.match(/SUMMARY:([^\r\n]+)/);
    if (!dtstartMatch || !summaryMatch) return;

    const isAllDay = /VALUE=DATE/.test(dtstartMatch[1] || '');
    const start = parseIcsDateValue(dtstartMatch[2].trim(), isAllDay);
    let end = dtendMatch ? parseIcsDateValue(dtendMatch[2].trim(), isAllDay) : start;
    // All-day DTEND is exclusive (the day after the last day off) — pull back
    // one day so "end" means the last actual day, matching the date-range
    // convention used everywhere else in this file.
    if (isAllDay) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);

    const startStr = Utilities.formatDate(start, 'Europe/London', 'yyyy-MM-dd');
    const endStr = Utilities.formatDate(end, 'Europe/London', 'yyyy-MM-dd');
    if (startStr > windowEndStr || endStr < windowStartStr) return; // outside the window we care about

    const summary = unescapeIcsText(summaryMatch[1].trim());
    rows.push([sageEventName(summary), classifyCalendarEvent(summary), startStr, endStr]);
  });

  if (!rows.length) return; // parsed nothing (or nothing in-window) — don't wipe good data

  const sheet = getSheet('SageEvents');
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 4).clearContent();
  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
}

// One-time setup — run this once from the Apps Script editor (pick it in the
// function dropdown, click Run) to install the weekly refresh. Safe to
// re-run: it removes any existing trigger for this function first, so
// running it again (e.g. to change the day/time below) never leaves
// duplicates.
function installSageWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshHolidaysFromSage') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshHolidaysFromSage')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(3)
    .create();
}

// This week's (Mon–Fri) events, read from the SageEvents sheet (populated
// weekly by refreshHolidaysFromSage — this function never touches Sage
// directly). Cached 5 min purely so concurrent requests in the same window
// share one sheet read; the underlying data itself only changes weekly.
function getHolidaysThisWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (day === 0 ? -6 : 1 - day));
  const mondayStr_ = Utilities.formatDate(monday, 'Europe/London', 'yyyy-MM-dd');
  const cacheKey = 'hol_' + mondayStr_;

  const cached = CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const friday = new Date(monday);
  friday.setDate(friday.getDate() + 4);
  const fridayStr = Utilities.formatDate(friday, 'Europe/London', 'yyyy-MM-dd');

  const holidays = [];
  const birthdays = [];
  const anniversaries = [];
  try {
    const values = getSheet('SageEvents').getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const name = values[i][0];
      const kind = values[i][1];
      if (!name) continue;
      const start = parseRowDate(values[i][2]);
      const end = parseRowDate(values[i][3]);
      if (start > fridayStr || end < mondayStr_) continue; // no overlap with this week

      const entry = { name, start, end };
      if (kind === 'birthday') birthdays.push(entry);
      else if (kind === 'anniversary') anniversaries.push(entry);
      else holidays.push(entry);
    }
  } catch (e) {}

  const result = { holidays, birthdays, anniversaries };
  try { CACHE.put(cacheKey, JSON.stringify(result), 300); } catch (e) {}
  return result;
}

// ============================================================
// CACHE WARMING
// ------------------------------------------------------------
// The shared CacheService entries above (wk_/gb_/soc_/hol_/admins) have
// short TTLs (45s-600s) by design — they exist to coalesce near-simultaneous
// requests, not to survive idle periods, and CacheService caps out at 6
// hours even if asked for longer. Left alone, anyone loading the app after
// it's sat idle for hours/days hits every one of these fully cold and pays
// the full cost on that one request: two sheet reads, one Glass Box Calendar
// API call, and one CalendarApp call for social events (CalendarApp is
// genuinely slow — see getSocialEvents) — this combination is what caused
// the original 30s timeouts. Proactively refreshing on a schedule means no
// one has to be "the first person of the day" who eats that cost.
//
// Scoped to the current week only, not the ±2-week window the frontend
// prefetches in the background — that prefetch is already non-blocking, so
// warming it wouldn't fix anything a user actually feels, and getSocialEvents
// specifically is expensive enough that multiplying it by 5 weeks on every
// warming run isn't worth the added Apps Script execution quota.
// ============================================================

function warmSharedCaches() {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (day === 0 ? -6 : 1 - day));
  const weekEnd = new Date(monday);
  weekEnd.setDate(weekEnd.getDate() + 4);

  const weekStartStr = Utilities.formatDate(monday, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const weekEndStr = Utilities.formatDate(weekEnd, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // getGlassBoxWeek only uses user.access_token (to call the Calendar API as
  // whoever's asking) — the trigger runs as the account that installed it,
  // so ScriptApp.getOAuthToken() stands in for a real signed-in user's token.
  try { getWeekData(weekStartStr); } catch (e) {}
  try { getGlassBoxWeek(weekStartStr, { access_token: ScriptApp.getOAuthToken() }); } catch (e) {}
  try { getSocialEvents(weekStartStr, weekEndStr); } catch (e) {}
  try { getHolidaysThisWeek(); } catch (e) {}
  try { isAdmin(''); } catch (e) {}
}

// One-time setup — run this once from the Apps Script editor (pick it in the
// function dropdown, click Run) to install the warming schedule. Safe to
// re-run: removes any existing trigger for this function first, so changing
// the interval below and re-running never leaves duplicates.
function installCacheWarmingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'warmSharedCaches') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmSharedCaches')
    .timeBased()
    .everyMinutes(5)
    .create();
}

// ============================================================
// PEOPLE SEARCH
// ============================================================

function searchPeopleByQuery(query) {
  try {
    const results = People.People.searchDirectoryPeople({
      query: query,
      readMask: 'names,emailAddresses',
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      pageSize: 8
    });
    const people = [];
    (results.people || []).forEach(person => {
      const nameObj = person.names && person.names[0];
      const emailObj = person.emailAddresses && person.emailAddresses[0];
      if (nameObj && emailObj) people.push({ name: nameObj.displayName, email: emailObj.value });
    });
    return { success: true, people };
  } catch(e) {
    return { people: [], error: e.message };
  }
}

// ============================================================
// UTILS
// ============================================================

function formatTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}
