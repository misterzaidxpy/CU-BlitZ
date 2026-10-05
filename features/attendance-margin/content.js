// Content script for Attendance Margin
// Adds a "75% margin" column to the LMS attendance tables (dashboard and attendance.php)

(function() {
  'use strict';

  const LMS_BASE_URL = '/cpanelS/';
  const SLOT_CACHE_KEY = 'timetableSlots';

  // Attendance on CULMS is counted in class hours (a 1.5 h lecture adds 1.5 to
  // Total Classes), so the length of each class comes from the timetable

  async function init() {
    const tables = findAttendanceTables();
    if (tables.length === 0) return;

    const slots = await getSlotHours();
    if (!slots) return;

    tables.forEach(table => addMarginColumn(table, slots));
  }

  // Tables whose header row has Total Classes and Presents columns
  function findAttendanceTables() {
    return [...document.querySelectorAll('table')].filter(table => {
      const heads = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
      return heads.includes('Total Classes') && heads.includes('Presents');
    });
  }

  // ========== TIMETABLE (class length per course) ==========

  // Slot lengths per course, cached for the day
  async function getSlotHours() {
    const today = new Date().toDateString();
    const stored = await chrome.storage.local.get(SLOT_CACHE_KEY);
    if (stored[SLOT_CACHE_KEY]?.day === today) {
      return stored[SLOT_CACHE_KEY].slots;
    }

    const response = await fetch(`${LMS_BASE_URL}timetable.php`, { credentials: 'include' });
    // Expired session redirects to login.php; leave the table untouched
    if (!response.ok || new URL(response.url).pathname.endsWith('/login.php')) return null;

    const slots = parseTimetable(await response.text());
    await chrome.storage.local.set({ [SLOT_CACHE_KEY]: { day: today, slots } });
    return slots;
  }

  // One table per weekday. Columns: Course ID | Course Name | Time | Location
  // Time looks like "8:30 AM to 10:00 AM"
  function parseTimetable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const slots = {};

    for (const table of doc.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
      const idCol = heads.indexOf('Course ID');
      const timeCol = heads.indexOf('Time');
      if (idCol < 0 || timeCol < 0) continue;

      for (const row of table.rows) {
        if (row.cells[0]?.tagName !== 'TD' || row.cells.length <= timeCol) continue;
        const courseId = row.cells[idCol].textContent.trim();
        const hours = slotLength(row.cells[timeCol].textContent);
        if (!courseId || !hours) continue;
        (slots[courseId] ||= []).push(hours);
      }
    }

    return slots;
  }

  function slotLength(text) {
    const times = [...text.matchAll(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi)].map(m => {
      let hour = Number(m[1]) % 12;
      if (m[3].toUpperCase() === 'PM') hour += 12;
      return hour * 60 + Number(m[2]);
    });
    if (times.length !== 2 || times[1] <= times[0]) return null;
    return (times[1] - times[0]) / 60;
  }

  // ========== MARGIN ==========

  // Work in hundredths so 13.5 and 1.5 become exact integers
  const toHundredths = value => Math.round(parseFloat(value) * 100);

  // Rule: attendance must stay at or above 75%, i.e. 4 * present >= 3 * total.
  // Missing k classes of length L adds k*L to total only:
  //   4P >= 3(T + kL)  =>  k = floor((4P - 3T) / 3L)
  // Attending n classes adds n*L to both:
  //   4(P + nL) >= 3(T + nL)  =>  n = ceil((3T - 4P) / L)
  function calculateMargin(total, present, slotHours) {
    const T = toHundredths(total);
    const P = toHundredths(present);
    if (!(T > 0) || !(P >= 0) || P > T) return { state: 'none' };
    if (!slotHours || slotHours.length === 0) return { state: 'unknown' };

    const surplus = 4 * P - 3 * T;
    if (surplus >= 0) {
      // Longest class costs the most hours when missed: count with that
      const longest = toHundredths(Math.max(...slotHours));
      return { state: surplus >= 3 * longest ? 'safe' : 'limit', classes: Math.floor(surplus / (3 * longest)), hours: longest / 100 };
    }

    // Shortest class adds the fewest hours when attended: count with that
    const shortest = toHundredths(Math.min(...slotHours));
    return { state: 'below', classes: Math.ceil(-surplus / shortest), hours: shortest / 100 };
  }

  function marginCell(margin) {
    const plural = n => (n === 1 ? 'class' : 'classes');
    const each = margin.hours ? `<br><small class="text-muted">${margin.hours} h per class</small>` : '';

    switch (margin.state) {
      case 'safe':
        return `<span class="label label-success">Can miss ${margin.classes} ${plural(margin.classes)}</span>${each}`;
      case 'limit':
        return `<span class="label label-warning">At the limit</span><br><small class="text-muted">Next absence drops below 75%</small>`;
      case 'below':
        return `<span class="label label-danger">Attend next ${margin.classes} ${plural(margin.classes)}</span>${each}`;
      case 'unknown':
        return '<small class="text-muted">Class length not found in timetable</small>';
      default:
        return '<small class="text-muted">No classes recorded yet</small>';
    }
  }

  function addMarginColumn(table, slots) {
    if (table.dataset.cublitzMargin) return;
    table.dataset.cublitzMargin = 'true';

    const headRow = [...table.rows].find(row => row.cells[0]?.tagName === 'TH');
    const heads = [...headRow.cells].map(cell => cell.textContent.trim());
    const idCol = heads.indexOf('Course ID');
    const totalCol = heads.indexOf('Total Classes');
    const presentCol = heads.indexOf('Presents');

    const th = document.createElement('th');
    th.textContent = '75% Margin';
    th.title = 'Classes you can miss in a row and still have at least 75% attendance';
    headRow.appendChild(th);

    for (const row of table.rows) {
      if (row === headRow || row.cells[0]?.tagName !== 'TD' || row.cells.length <= presentCol) continue;
      const courseId = row.cells[idCol].textContent.trim();
      const margin = calculateMargin(row.cells[totalCol].textContent, row.cells[presentCol].textContent, slots[courseId]);

      const td = document.createElement('td');
      td.innerHTML = marginCell(margin);
      row.appendChild(td);
    }

    // attendance.php already has the LMS's own 75% rule note; the dashboard does not
    const pageHasRuleNote = /less than 75% attendance/i.test(table.parentElement.textContent);

    const note = document.createElement('p');
    note.className = 'text-muted cublitz-margin-note';
    note.style.cssText = 'font-size: 12px; margin: 8px 0 0;';
    note.innerHTML = '<i class="fa fa-info-circle"></i> 75% Margin counts classes missed in a row from now, ' +
      'based on classes recorded on the LMS so far. Recently held classes may not be added yet.' +
      (pageHasRuleNote ? '' : ' Below 75% in a course means no final exam for that course.');
    table.after(note);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
