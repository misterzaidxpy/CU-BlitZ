// Content script for GPA Calculator
// Adds a collapsed "GPA Calculator" box under "SGPA Semester Wise" on the dashboard

(function() {
  'use strict';

  const LMS_BASE_URL = '/cpanelS/';
  const STORAGE_KEY = 'gpaCalculator';

  // Student Handbook, Examination regulations 8a. "W" is not counted (8b)
  const GRADE_POINTS = {
    'A': 4.00, 'A-': 3.67, 'B+': 3.33, 'B': 3.00, 'B-': 2.67, 'C+': 2.33,
    'C': 2.00, 'C-': 1.67, 'D+': 1.30, 'D': 1.00, 'F': 0.00
  };
  const CREDIT_HOUR_OPTIONS = [1, 2, 3, 4, 5, 6];

  let loaded = false;
  let official = null;   // { cgpa, creditHours, label } from the latest finished transcript
  let saved = { creditHours: {}, grades: {}, repeating: {} };

  function init() {
    const sgpaBox = findBox('SGPA Semester Wise');
    if (!sgpaBox || document.getElementById('cublitz-gpa-calculator')) return;

    const box = document.createElement('div');
    box.className = 'box box-primary';
    box.id = 'cublitz-gpa-calculator';
    box.innerHTML = `
      <div class="box-header with-border" style="cursor: pointer;">
        <h3 class="box-title"><i class="fa fa-calculator"></i> GPA Calculator</h3>
        <div class="box-tools pull-right">
          <button type="button" class="btn btn-box-tool" aria-expanded="false" title="Show calculator">
            <i class="fa fa-plus"></i>
          </button>
        </div>
      </div>
      <div class="box-body" style="display: none;"></div>
      <div class="box-footer" style="display: none;"></div>
    `;
    sgpaBox.after(box);

    box.querySelector('.box-header').addEventListener('click', () => toggle(box));
  }

  function findBox(titleText) {
    return [...document.querySelectorAll('.box')].find(b =>
      b.querySelector('.box-title')?.textContent.includes(titleText));
  }

  // Loads data on first open, so the dashboard makes no extra requests until then
  function toggle(box) {
    const body = box.querySelector('.box-body');
    const footer = box.querySelector('.box-footer');
    const button = box.querySelector('.btn-box-tool');
    const open = body.style.display === 'none';

    body.style.display = open ? '' : 'none';
    footer.style.display = open && loaded ? '' : 'none';
    button.querySelector('i').className = open ? 'fa fa-minus' : 'fa fa-plus';
    button.setAttribute('aria-expanded', String(open));
    button.title = open ? 'Hide calculator' : 'Show calculator';

    if (open && !loaded) load(box);
  }

  async function load(box) {
    const body = box.querySelector('.box-body');
    body.innerHTML = `
      <p class="text-center text-muted" style="padding: 20px 0; margin: 0;">
        <i class="fa fa-spinner fa-spin"></i> Loading your courses and latest transcript...
      </p>`;

    try {
      const [courses, totals, stored] = await Promise.all([
        fetchCurrentCourses(),
        fetchOfficialTotals(),
        chrome.storage.local.get(STORAGE_KEY)
      ]);
      official = totals;
      saved = { creditHours: {}, grades: {}, repeating: {}, ...stored[STORAGE_KEY] };
      loaded = true;
      render(box, courses);
    } catch (err) {
      const expired = err.message === 'session-expired';
      body.innerHTML = `
        <p class="text-center" style="padding: 20px 0; margin: 0;">
          ${expired
            ? 'Your LMS session has expired. <a href="/login.php">Log in again</a> to use the calculator.'
            : 'Couldn\'t load your courses. <a href="#" id="cublitz-gpa-retry">Try again</a>'}
        </p>`;
      document.getElementById('cublitz-gpa-retry')?.addEventListener('click', (e) => {
        e.preventDefault();
        load(box);
      });
    }
  }

  // ========== DATA ==========

  async function fetchPage(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (new URL(response.url).pathname.endsWith('/login.php')) throw new Error('session-expired');
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    return new DOMParser().parseFromString(await response.text(), 'text/html');
  }

  // Columns: Course ID | Title | Email | Section | Teacher
  async function fetchCurrentCourses() {
    const doc = await fetchPage(`${LMS_BASE_URL}mycourses.php`);
    const courses = [];
    for (const row of doc.querySelectorAll('tr')) {
      const link = row.cells[0]?.querySelector('a[href^="outline.php?"]');
      if (!link) continue;
      const id = link.textContent.trim();
      if (courses.some(c => c.id === id)) continue;
      courses.push({ id, title: row.cells[1]?.textContent.trim() || '', outline: link.getAttribute('href') });
    }

    // Each course page header shows "Credit Hrs : 3"
    await Promise.all(courses.map(async course => {
      try {
        const outline = await fetchPage(LMS_BASE_URL + course.outline);
        const match = outline.body.textContent.match(/Credit\s*Hrs\s*:\s*(\d+(?:\.\d+)?)/i);
        course.creditHours = match ? Number(match[1]) : null;
      } catch (err) {
        if (err.message === 'session-expired') throw err;
        course.creditHours = null;
      }
    }));

    return courses;
  }

  // Official CGPA and total credit hours from the newest transcript that is not the
  // current session. These already include courses the transcript pages don't list,
  // so the projection starts from them instead of rebuilding past semesters.
  async function fetchOfficialTotals() {
    const currentSession = (findBox('Internal Marks')?.querySelector('.box-title').textContent.match(/\(([^)]+)\)/) || [])[1];
    const transcript = [...document.querySelectorAll('.sidebar-menu a[href^="transcriptpre.php"]')]
      .map(a => ({ href: a.getAttribute('href'), label: (a.textContent.match(/\(([^)]+)\)/) || [])[1] }))
      .find(t => t.label && t.label !== currentSession);

    if (!transcript) return { cgpa: null, creditHours: 0, label: null };

    const doc = await fetchPage(LMS_BASE_URL + transcript.href);
    const cells = [...doc.querySelectorAll('th, td')].map(cell => cell.textContent.trim());
    const valueAfter = label => parseFloat(cells[cells.findIndex(text => text.startsWith(label)) + 1]);

    const cgpa = valueAfter('Cummulative Grade Point');
    const creditHours = valueAfter('Total Credit Hours');
    if (!(cgpa >= 0 && cgpa <= 4) || !(creditHours > 0)) {
      return { cgpa: null, creditHours: 0, label: transcript.label, unreadable: true };
    }
    return { cgpa, creditHours, label: transcript.label };
  }

  // ========== UI ==========

  function render(box, courses) {
    const body = box.querySelector('.box-body');
    const footer = box.querySelector('.box-footer');

    if (courses.length === 0) {
      body.innerHTML = '<p class="text-center text-muted" style="padding: 20px 0; margin: 0;">No current courses found on the LMS.</p>';
      return;
    }

    body.innerHTML = `
      <p class="text-muted" style="margin: 0 0 10px;">
        Choose the grade you expect in each course. Credit hours come from your course pages. Your choices are saved in this browser only.
      </p>
      <table class="table table-bordered" style="margin-bottom: 0;">
        <thead>
          <tr>
            <th>Course</th>
            <th style="width: 18%;">Credit Hours</th>
            <th style="width: 18%;">Expected Grade</th>
            <th style="width: 18%;" class="text-center" title="Repeating this course to improve an earlier grade">Improving a grade</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;

    const tbody = body.querySelector('tbody');
    courses.forEach(course => tbody.appendChild(courseRow(course)));

    footer.innerHTML = `
      <div class="row">
        <div class="col-sm-6 border-right">
          <div class="description-block">
            <h5 class="description-header" id="cublitz-sgpa">-</h5>
            <span class="description-text">Semester GPA</span>
          </div>
        </div>
        <div class="col-sm-6">
          <div class="description-block">
            <h5 class="description-header" id="cublitz-cgpa">-</h5>
            <span class="description-text">Projected CGPA (&plusmn;0.01)</span>
          </div>
        </div>
      </div>
      <p class="text-muted" id="cublitz-gpa-note" style="font-size: 12px; margin: 10px 0 0;"></p>
    `;
    footer.style.display = '';

    tbody.addEventListener('change', () => {
      saveChoices(tbody);
      calculate(tbody);
    });
    calculate(tbody);
  }

  function courseRow(course) {
    const tr = document.createElement('tr');
    tr.dataset.course = course.id;

    const name = document.createElement('td');
    const id = document.createElement('strong');
    id.textContent = course.id;
    const title = document.createElement('small');
    title.className = 'text-muted';
    title.textContent = course.title;
    name.append(id, document.createElement('br'), title);

    // Credit hours come from the LMS when the course page shows them; otherwise the student picks
    let creditHours;
    if (course.creditHours > 0) {
      tr.dataset.creditHours = String(course.creditHours);
      creditHours = document.createElement('span');
      creditHours.textContent = String(course.creditHours);
      creditHours.title = 'From the course page on the LMS';
    } else {
      creditHours = select('creditHours', CREDIT_HOUR_OPTIONS.map(h => [String(h), String(h)]), saved.creditHours[course.id]);
    }
    const grade = select('grade', [...Object.keys(GRADE_POINTS).map(g => [g, `${g} (${GRADE_POINTS[g].toFixed(2)})`]), ['W', 'W (withdrawn, not counted)']], saved.grades[course.id]);

    const repeating = document.createElement('td');
    repeating.className = 'text-center';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.field = 'repeating';
    checkbox.checked = !!saved.repeating[course.id];
    checkbox.setAttribute('aria-label', `Improving a grade in ${course.id}`);
    repeating.appendChild(checkbox);

    tr.append(name, wrapCell(creditHours), wrapCell(grade), repeating);
    return tr;
  }

  function select(field, options, value) {
    const el = document.createElement('select');
    el.className = 'form-control input-sm';
    el.dataset.field = field;
    el.add(new Option('Choose', ''));
    options.forEach(([optionValue, label]) => el.add(new Option(label, optionValue)));
    el.value = value || '';
    return el;
  }

  function wrapCell(el) {
    const td = document.createElement('td');
    td.appendChild(el);
    return td;
  }

  function readRows(tbody) {
    return [...tbody.rows].map(tr => ({
      id: tr.dataset.course,
      creditHours: Number(tr.dataset.creditHours || tr.querySelector('[data-field="creditHours"]')?.value) || 0,
      grade: tr.querySelector('[data-field="grade"]').value,
      repeating: tr.querySelector('[data-field="repeating"]').checked
    }));
  }

  function saveChoices(tbody) {
    readRows(tbody).forEach(row => {
      saved.creditHours[row.id] = row.creditHours || undefined;
      saved.grades[row.id] = row.grade || undefined;
      saved.repeating[row.id] = row.repeating || undefined;
    });
    chrome.storage.local.set({ [STORAGE_KEY]: saved });
  }

  // ========== CALCULATION ==========

  // LMS shows SGPA/CGPA rounded to 2 decimals
  const round2 = value => (Math.round(value * 100 + 1e-9) / 100).toFixed(2);

  function calculate(tbody) {
    const rows = readRows(tbody);
    const sgpaEl = document.getElementById('cublitz-sgpa');
    const cgpaEl = document.getElementById('cublitz-cgpa');
    const noteEl = document.getElementById('cublitz-gpa-note');

    const show = (sgpa, cgpa, note) => {
      sgpaEl.textContent = sgpa;
      cgpaEl.textContent = cgpa;
      noteEl.textContent = note;
    };

    if (rows.some(r => r.repeating)) {
      show('-', '-', 'Courses taken to improve a grade aren\'t supported: the Student Handbook doesn\'t say how ' +
        'an improved grade replaces the earlier one in CGPA. Untick it to calculate the other courses.');
      return;
    }

    const missing = rows.filter(r => !r.creditHours || !r.grade).length;
    if (missing > 0) {
      show('-', '-', `Choose a grade${rows.some(r => !r.creditHours) ? ' and credit hours' : ''} for every course (${missing} left).`);
      return;
    }

    // SGPA = sum(credit hours x grade points) / total credit hours, W not counted
    const counted = rows.filter(r => r.grade !== 'W');
    const semesterHours = counted.reduce((sum, r) => sum + r.creditHours, 0);
    const semesterPoints = counted.reduce((sum, r) => sum + r.creditHours * GRADE_POINTS[r.grade], 0);

    if (semesterHours === 0) {
      show('-', '-', 'Every course is marked withdrawn, so there is nothing to calculate.');
      return;
    }

    const sgpa = round2(semesterPoints / semesterHours);

    if (official.unreadable) {
      show(sgpa, '-', `Couldn't read the CGPA on your ${official.label} transcript, so only Semester GPA is shown.`);
      return;
    }

    if (official.cgpa === null) {
      show(sgpa, sgpa, 'No earlier transcript found, so projected CGPA equals semester GPA.');
      return;
    }

    const cgpa = round2((official.cgpa * official.creditHours + semesterPoints) / (official.creditHours + semesterHours));
    show(sgpa, cgpa,
      `Starts from your official CGPA ${official.cgpa.toFixed(2)} over ${official.creditHours} credit hours ` +
      `(${official.label} transcript). The LMS rounds that CGPA to 2 decimals, so the projection can differ by 0.01.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
