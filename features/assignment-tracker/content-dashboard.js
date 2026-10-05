// Content script for CULMS Assignment Tracker
// Injects pending assignments widget and header icon on dashboard

(function() {
  'use strict';

  let widgetInjected = false;
  let isRefreshing = false;
  let fetchInProgress = null;

  const ANNOUNCEMENT_CACHE_KEY = 'announcementCache';
  const ANNOUNCEMENTS_SEEN_KEY = 'announcementsSeen';
  const ANNOUNCEMENTS_SHOWN = 5;

  const CACHE_TTL = 3600000; // 1 hour in milliseconds
  // Use relative URLs to avoid CORS issues between www.cu.edu.pk and cu.edu.pk
  const LMS_BASE_URL = '/cpanelS/';

  // Initialize on page load
  async function init() {
    // On the upload page an assignment is about to be (or was just) submitted,
    // so mark the cache stale and let the next dashboard visit refetch
    if (window.location.pathname.endsWith('/asgupload.php')) {
      await markCacheStale();
      return;
    }

    // Check if we're on the dashboard page
    if (!isDashboardPage()) {
      return;
    }

    // Set up storage change listener for progressive updates
    setupStorageListener();

    // Show loading state
    showLoadingWidget();

    // Check cache first
    const cachedData = await getCachedAssignments();
    const announcementCache = (await chrome.storage.local.get(ANNOUNCEMENT_CACHE_KEY))[ANNOUNCEMENT_CACHE_KEY];

    // Announcements are fetched together with assignments, so both come from cache or neither
    if (cachedData && cachedData.isComplete && !cachedData.error && !isCacheStale(cachedData) && !isCacheSuspicious(cachedData) && announcementCache) {
      displayAssignments(cachedData.assignments);
      renderAnnouncements(announcementCache);
    } else {
      // Fetch directly from content script (has cookie access)
      fetchAllAssignments();
    }
  }

  // Set up listener for progressive storage updates
  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[ANNOUNCEMENT_CACHE_KEY]?.newValue) {
        renderAnnouncements(changes[ANNOUNCEMENT_CACHE_KEY].newValue);
      }

      if (areaName === 'local' && changes.assignmentCache?.newValue) {
        const cache = changes.assignmentCache.newValue;
        const { assignments, isComplete, progress } = cache;

        // Update progress in loading widget
        if (progress && progress.total > 0 && !isComplete) {
          updateLoadingProgress(progress.completed, progress.total, assignments.length);
        }

        // Display assignments progressively
        if (assignments && assignments.length > 0) {
          displayAssignments(assignments, !isComplete);
        }

        // If complete, finalize the display
        if (isComplete) {
          isRefreshing = false;
          if (cache.error) {
            removeLoadingWidget();
            injectErrorWidget(cache.error);
          } else if (assignments.length === 0) {
            removeLoadingWidget();
            injectEmptyWidget();
            updateHeaderIcon(0);
          } else {
            displayAssignments(assignments, false);
          }
        }
      }
    });
  }

  // Check if we're on the dashboard page
  function isDashboardPage() {
    // Look for the Internal Marks table as a marker
    const internalMarksTitle = document.querySelector('.box-title');
    return internalMarksTitle && internalMarksTitle.textContent.includes('Internal Marks');
  }

  // Get cached assignments
  async function getCachedAssignments() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['assignmentCache'], (result) => {
        resolve(result.assignmentCache || null);
      });
    });
  }

  // Check if cache is stale
  function isCacheStale(cache) {
    if (!cache.lastFetched || !cache.ttl) return true;
    const age = Date.now() - cache.lastFetched;
    return age >= cache.ttl;
  }

  // Keep cached assignments (View All still shows them) but force a refetch
  async function markCacheStale() {
    const cache = await getCachedAssignments();
    if (cache) {
      await chrome.storage.local.set({ assignmentCache: { ...cache, lastFetched: 0 } });
    }
  }

  // Check if cache is suspicious (likely from expired session)
  // Cache with 0 courses processed likely means session was invalid during fetch
  function isCacheSuspicious(cache) {
    return cache.isComplete &&
           cache.progress?.total === 0 &&
           cache.assignments?.length === 0;
  }

  // ========== FETCH FUNCTIONS (run in content script for cookie access) ==========

  // Fetch all assignments directly from content script
  // Dashboard load, Refresh and View All can all trigger a fetch, so reuse
  // one that is already running in this tab instead of starting another
  function fetchAllAssignments() {
    if (!fetchInProgress) {
      fetchInProgress = runFetchAllAssignments().finally(() => {
        fetchInProgress = null;
      });
    }
    return fetchInProgress;
  }

  async function runFetchAllAssignments() {
    try {
      // Step 1: Fetch course list
      const courses = await fetchCourses();

      // Announcements load alongside assignments and never affect their result
      const announcementsDone = fetchAllAnnouncements(courses);

      if (courses.length === 0) {
        await Promise.all([cacheAssignments([], true), announcementsDone]);
        return [];
      }

      // Step 2: Fetch assignments for each course with progressive updates
      let allAssignments = [];
      let completedCourses = 0;
      let sessionExpired = false;
      const totalCourses = courses.length;

      const assignmentPromises = courses.map(async (course) => {
        try {
          const courseAssignments = await fetchAssignmentsForCourse(course);
          allAssignments = [...allAssignments, ...courseAssignments];
          completedCourses++;
          const isComplete = completedCourses === totalCourses;
          await cacheAssignments(allAssignments, isComplete, completedCourses, totalCourses,
            isComplete && sessionExpired ? 'session-expired' : null);
          return courseAssignments;
        } catch (err) {
          if (err instanceof SessionExpiredError) sessionExpired = true;
          completedCourses++;
          const isComplete = completedCourses === totalCourses;
          await cacheAssignments(allAssignments, isComplete, completedCourses, totalCourses,
            isComplete && sessionExpired ? 'session-expired' : null);
          return [];
        }
      });

      await Promise.all([...assignmentPromises, announcementsDone]);
      return allAssignments;

    } catch (error) {
      console.error('Error fetching assignments:', error);
      const errorType = error instanceof SessionExpiredError ? 'session-expired' : 'fetch-failed';
      await chrome.storage.local.set({ [ANNOUNCEMENT_CACHE_KEY]: { lastFetched: Date.now(), items: [], error: errorType } });
      await cacheAssignments([], true, 0, 0, errorType);
      return [];
    }
  }

  // The LMS answers an expired session with a 200 redirect to /login.php,
  // which would otherwise parse as "no courses, no assignments"
  class SessionExpiredError extends Error {}

  async function fetchLmsPage(url) {
    const response = await fetch(url, {
      credentials: 'include'
    });

    if (new URL(response.url).pathname.endsWith('/login.php')) {
      throw new SessionExpiredError('LMS session expired');
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return response.text();
  }

  // Fetch course list from mycourses.php
  async function fetchCourses() {
    const html = await fetchLmsPage(`${LMS_BASE_URL}mycourses.php`);
    return parseCourses(html);
  }

  // Parse course list from HTML
  // Columns: Course ID | Title | Email | Section | Teacher
  function parseCourses(html) {
    const courses = [];
    const seenCourses = new Set();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const row of doc.querySelectorAll('tr')) {
      // Course code and title cells both link to the same outline.php URL,
      // so only read the link in the first (course code) cell
      const link = row.cells[0]?.querySelector('a[href^="outline.php?"]');
      if (!link) continue;

      const queryString = link.getAttribute('href').split('?')[1];
      if (seenCourses.has(queryString)) continue;
      seenCourses.add(queryString);

      const urlParams = new URLSearchParams(queryString);
      courses.push({
        courseId: link.textContent.trim(),
        courseTitle: row.cells[1]?.textContent.trim() || 'Unknown',
        section: urlParams.get('section') || '',
        teacherId: urlParams.get('teacherID'),
        session: urlParams.get('sess'),
        cpsess: urlParams.get('cpsess'),
        shift: 'Morning'
      });
    }

    return courses;
  }

  // Course pages (assignments.php, announcement.php, ...) share the same query parameters
  function coursePageUrl(page, course) {
    return `${LMS_BASE_URL}${page}?` +
      `courseid=${encodeURIComponent(course.courseId)}` +
      `&teacherID=${course.teacherId}` +
      `&section=${encodeURIComponent(course.section)}` +
      `&shift=${encodeURIComponent(course.shift)}` +
      `&sess=${encodeURIComponent(course.session)}` +
      `&cpsess=${course.cpsess}`;
  }

  // Fetch assignments for a specific course
  async function fetchAssignmentsForCourse(course) {
    const url = coursePageUrl('assignments.php', course);

    const html = await fetchLmsPage(url);
    // Store full URL for use in extension pages (view-all.html)
    const fullUrl = window.location.origin + url;
    return parseAssignments(html, course, fullUrl);
  }

  // Parse assignments from HTML
  // Columns: Asg No | Title | Description | Help File | Allow File Upload | Date Added | Last Date | Upload
  // Each assignment row is followed by a colspan "Evaluation Remarks" row
  function parseAssignments(html, course, assignmentPageUrl) {
    const pendingAssignments = [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table.table-hover');
    if (!table) return pendingAssignments;

    // table.rows skips rows of tables nested inside descriptions (pasted from Word)
    for (const row of table.rows) {
      const cells = row.cells;
      if (cells.length < 8 || cells[0].tagName !== 'TD') continue;

      // Only pending assignments have an upload link
      const uploadLink = cells[7].querySelector('a[href*="asgupload.php"]');
      if (!uploadLink) continue;

      const helpFileLink = cells[3].querySelector('a[href]');

      pendingAssignments.push({
        assignmentNo: cells[0].textContent.trim(),
        title: cells[1].textContent.trim(),
        description: cells[2].innerHTML,
        helpFile: helpFileLink ? helpFileLink.getAttribute('href') : null,
        helpFileName: helpFileLink ? helpFileLink.textContent.trim() : null,
        dateAdded: cells[5].textContent.trim(),
        lastDate: cells[6].textContent.trim(),
        uploadLink: uploadLink.getAttribute('href'),
        courseId: course.courseId,
        courseTitle: course.courseTitle,
        assignmentUrl: assignmentPageUrl
      });
    }

    return pendingAssignments;
  }

  // Cache assignments in chrome.storage
  // error is null, 'session-expired' or 'fetch-failed'
  async function cacheAssignments(assignments, isComplete = true, completedCourses = 0, totalCourses = 0, error = null) {
    await chrome.storage.local.set({
      assignmentCache: {
        lastFetched: Date.now(),
        ttl: CACHE_TTL,
        assignments: assignments,
        isComplete: isComplete,
        error: error,
        progress: {
          completed: completedCourses,
          total: totalCourses
        }
      }
    });
  }

  // ========== ANNOUNCEMENTS ==========

  // Fetch announcements for every course and cache them newest first
  async function fetchAllAnnouncements(courses) {
    const results = await Promise.allSettled(courses.map(fetchAnnouncementsForCourse));

    // An expired session is already explained by the Pending Assignments widget
    if (results.some(r => r.status === 'rejected' && r.reason instanceof SessionExpiredError)) {
      await chrome.storage.local.set({ [ANNOUNCEMENT_CACHE_KEY]: { lastFetched: Date.now(), items: [], error: 'session-expired' } });
      return;
    }

    const items = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => b.date.localeCompare(a.date));

    await chrome.storage.local.set({
      [ANNOUNCEMENT_CACHE_KEY]: {
        lastFetched: Date.now(),
        items,
        failedCourses: results.filter(r => r.status === 'rejected').length
      }
    });
  }

  async function fetchAnnouncementsForCourse(course) {
    const url = coursePageUrl('announcement.php', course);
    const html = await fetchLmsPage(url);
    return parseAnnouncements(html, course, window.location.origin + url);
  }

  // Columns: S.No | Announcement | Description | Date (YYYY-MM-DD)
  function parseAnnouncements(html, course, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = [...doc.querySelectorAll('table')].find(t =>
      [...t.querySelectorAll('th')].some(th => th.textContent.trim() === 'Announcement'));
    if (!table) return [];

    const heads = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
    const titleCol = heads.indexOf('Announcement');
    const descriptionCol = heads.indexOf('Description');
    const dateCol = heads.indexOf('Date');
    if (titleCol < 0 || dateCol < 0) return [];

    const announcements = [];
    for (const row of table.rows) {
      if (row.cells[0]?.tagName !== 'TD' || row.cells.length <= Math.max(titleCol, descriptionCol, dateCol)) continue;

      const title = row.cells[titleCol].textContent.trim();
      const date = row.cells[dateCol].textContent.trim();
      const description = descriptionCol >= 0 ? row.cells[descriptionCol] : null;

      announcements.push({
        id: `${course.courseId}|${date}|${title}`,
        courseId: course.courseId,
        courseTitle: course.courseTitle,
        title,
        date,
        text: description ? descriptionText(description) : '',
        links: description ? descriptionLinks(description) : [],
        pageUrl
      });
    }

    return announcements;
  }

  // Descriptions are teacher HTML; keep the text with its line breaks
  function descriptionText(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('p, div, li').forEach(el => el.append('\n'));
    return clone.textContent
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  // Only absolute web links (meeting links, forms), shown as plain anchors
  function descriptionLinks(cell) {
    return [...cell.querySelectorAll('a[href]')]
      .map(a => ({ href: a.getAttribute('href').trim(), text: a.textContent.trim() }))
      .filter(link => /^https?:\/\//i.test(link.href));
  }

  // ========== END FETCH FUNCTIONS ==========

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'assignmentsReady') {
      displayAssignments(message.assignments);
    }
    // Handle fetch trigger from view-all page (via background)
    if (message.action === 'triggerFetch') {
      fetchAllAssignments();
    }
  });

  // Display assignments (supports progressive updates)
  function displayAssignments(assignments, isLoading = false) {
    if (!assignments || assignments.length === 0) {
      if (!isLoading) {
        removeLoadingWidget();
        injectEmptyWidget();
        updateHeaderIcon(0);
      }
      return;
    }

    // injectWidget reuses the existing widget box, so it stays in place
    // across progressive updates instead of being removed and re-inserted
    injectWidget(assignments.slice(0, 5), assignments.length, isLoading);
    updateHeaderIcon(assignments.length);
  }

  // Update loading progress text
  function updateLoadingProgress(completed, total, assignmentCount) {
    const loadingText = document.querySelector('#culms-pending-assignments-widget .box-body p');
    if (loadingText) {
      loadingText.textContent = `Fetching course ${completed}/${total}... (${assignmentCount} found)`;
    }
  }

  // Show loading widget
  function showLoadingWidget() {
    if (widgetInjected) return;

    const targetBox = findInternalMarksBox();
    if (!targetBox) return;

    const widget = document.createElement('div');
    widget.className = 'box';
    widget.id = 'culms-pending-assignments-widget';
    widget.innerHTML = `
      <div class="box-header with-border">
        <h3 class="box-title">
          <i class="fa fa-exclamation-triangle" style="color: #dd4b39;"></i>
          Pending Assignments
        </h3>
      </div>
      <div class="box-body" style="text-align: center; padding: 20px;">
        <i class="fa fa-spinner fa-spin fa-2x" style="color: #3c8dbc;"></i>
        <p style="margin-top: 10px;">Loading pending assignments...</p>
      </div>
    `;

    insertPendingWidget(widget);
    widgetInjected = true;
  }

  // Remove loading widget
  function removeLoadingWidget() {
    const existingWidget = document.getElementById('culms-pending-assignments-widget');
    if (existingWidget) {
      existingWidget.remove();
      widgetInjected = false;
    }
  }

  // Inject empty state widget
  function injectEmptyWidget() {
    if (widgetInjected) return;

    const targetBox = findInternalMarksBox();
    if (!targetBox) return;

    const refreshBtnSpinClass = isRefreshing ? 'fa-spin' : '';
    const refreshBtnDisabled = isRefreshing ? 'disabled' : '';

    const widget = document.createElement('div');
    widget.className = 'box';
    widget.id = 'culms-pending-assignments-widget';
    widget.innerHTML = `
      <div class="box-header with-border">
        <h3 class="box-title">
          <i class="fa fa-check-circle" style="color: #00a65a;"></i>
          Pending Assignments
        </h3>
        <div class="box-tools pull-right">
          <button class="btn btn-default btn-sm" id="culms-refresh-btn" title="Refresh assignments" ${refreshBtnDisabled}>
            <i class="fa fa-refresh ${refreshBtnSpinClass}"></i> Refresh
          </button>
        </div>
      </div>
      <div class="box-body" style="text-align: center; padding: 20px;">
        <p><i class="fa fa-check-circle fa-3x" style="color: #00a65a;"></i></p>
        <p>No pending assignments! You're all caught up.</p>
      </div>
    `;

    insertPendingWidget(widget);
    widgetInjected = true;

    // Attach event listener to Refresh button
    const refreshBtn = document.getElementById('culms-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshAssignments);
    }
  }

  // Inject error state widget (expired session or LMS not responding)
  function injectErrorWidget(error) {
    if (widgetInjected) return;

    const targetBox = findInternalMarksBox();
    if (!targetBox) return;

    const isSessionExpired = error === 'session-expired';
    const message = isSessionExpired
      ? `<p><i class="fa fa-lock fa-3x" style="color: #f39c12;"></i></p>
         <p><strong>Your LMS session has expired.</strong><br>Log in again to see your pending assignments.</p>
         <a href="/login.php" class="btn btn-primary btn-sm">Log in</a>`
      : `<p><i class="fa fa-exclamation-circle fa-3x" style="color: #dd4b39;"></i></p>
         <p><strong>Couldn't load pending assignments.</strong><br>The LMS didn't respond. Try again in a moment.</p>
         <button class="btn btn-primary btn-sm" id="culms-retry-btn">Try again</button>`;

    const widget = document.createElement('div');
    widget.className = 'box';
    widget.id = 'culms-pending-assignments-widget';
    widget.innerHTML = `
      <div class="box-header with-border">
        <h3 class="box-title">
          <i class="fa fa-exclamation-triangle" style="color: #f39c12;"></i>
          Pending Assignments
        </h3>
      </div>
      <div class="box-body" style="text-align: center; padding: 20px;">
        ${message}
      </div>
    `;

    insertPendingWidget(widget);
    widgetInjected = true;

    const retryBtn = document.getElementById('culms-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', refreshAssignments);
    }
  }

  // ========== COURSE ANNOUNCEMENTS BOX ==========

  // Ids of announcements already seen. On first use everything current counts
  // as seen, so only announcements posted after installing are marked New
  async function getSeenAnnouncements(items) {
    const stored = (await chrome.storage.local.get(ANNOUNCEMENTS_SEEN_KEY))[ANNOUNCEMENTS_SEEN_KEY];
    if (Array.isArray(stored)) return new Set(stored);

    const seen = items.map(item => item.id);
    await chrome.storage.local.set({ [ANNOUNCEMENTS_SEEN_KEY]: seen });
    return new Set(seen);
  }

  async function renderAnnouncements(cache) {
    const internalMarks = findInternalMarksBox();
    if (!internalMarks) return;

    // Errors are shown by the Pending Assignments widget
    if (!cache || cache.error) {
      document.getElementById('cublitz-announcements')?.remove();
      return;
    }

    const items = cache.items || [];
    const seen = await getSeenAnnouncements(items);
    const newCount = items.filter(item => !seen.has(item.id)).length;

    const box = document.createElement('div');
    box.className = 'box';
    box.id = 'cublitz-announcements';
    box.innerHTML = `
      <div class="box-header with-border">
        <h3 class="box-title">
          <i class="fa fa-bullhorn" style="color: #3c8dbc;"></i>
          Course Announcements
          ${newCount > 0 ? `<span class="label label-primary" style="margin-left: 6px;">${newCount} new</span>` : ''}
        </h3>
        <div class="box-tools pull-right">
          ${newCount > 0 ? '<button class="btn btn-default btn-sm" id="cublitz-announcements-read">Mark all as read</button>' : ''}
        </div>
      </div>
      <div class="box-body"></div>
    `;

    const body = box.querySelector('.box-body');

    if (items.length === 0) {
      body.style.cssText = 'text-align: center; padding: 20px;';
      body.innerHTML = '<p style="margin: 0;">No announcements in your courses this semester.</p>';
    } else {
      body.innerHTML = `
        <table class="table table-bordered table-hover" style="margin-bottom: 0;">
          <thead>
            <tr>
              <th width="12%">Date</th>
              <th width="22%">Course</th>
              <th>Announcement</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `;
      const tbody = body.querySelector('tbody');
      items.forEach((item, index) => {
        const row = announcementRow(item, !seen.has(item.id));
        if (index >= ANNOUNCEMENTS_SHOWN) row.style.display = 'none';
        tbody.appendChild(row);
      });

      if (items.length > ANNOUNCEMENTS_SHOWN) {
        const more = document.createElement('p');
        more.style.cssText = 'margin: 10px 0 0; text-align: center;';
        more.innerHTML = `<a href="#" id="cublitz-announcements-more">Show all ${items.length} announcements</a>`;
        body.appendChild(more);
      }
    }

    if (cache.failedCourses > 0) {
      const failed = document.createElement('p');
      failed.className = 'text-muted';
      failed.style.cssText = 'font-size: 12px; margin: 10px 0 0;';
      failed.textContent = `Couldn't load announcements for ${cache.failedCourses} ` +
        `${cache.failedCourses === 1 ? 'course' : 'courses'}. Use Refresh in Pending Assignments to try again.`;
      body.appendChild(failed);
    }

    // Replace in place, otherwise place it under Pending Assignments
    const existing = document.getElementById('cublitz-announcements');
    const pending = document.getElementById('culms-pending-assignments-widget');
    if (existing) {
      existing.replaceWith(box);
    } else if (pending) {
      pending.after(box);
    } else {
      internalMarks.parentNode.insertBefore(box, internalMarks);
    }

    box.querySelector('#cublitz-announcements-read')?.addEventListener('click', async () => {
      const all = new Set([...seen, ...items.map(item => item.id)]);
      await chrome.storage.local.set({ [ANNOUNCEMENTS_SEEN_KEY]: [...all] });
      renderAnnouncements(cache);
    });

    box.querySelector('#cublitz-announcements-more')?.addEventListener('click', (e) => {
      e.preventDefault();
      const rows = [...box.querySelectorAll('tbody tr')];
      const expand = rows.some(row => row.style.display === 'none');
      rows.forEach((row, index) => {
        row.style.display = expand || index < ANNOUNCEMENTS_SHOWN ? '' : 'none';
      });
      e.target.textContent = expand ? 'Show fewer' : `Show all ${items.length} announcements`;
    });
  }

  // Built with DOM methods: titles and descriptions are teacher-written text
  function announcementRow(item, isNew) {
    const tr = document.createElement('tr');

    const date = document.createElement('td');
    date.style.whiteSpace = 'nowrap';
    date.textContent = item.date;

    const course = document.createElement('td');
    const courseId = document.createElement('strong');
    courseId.textContent = item.courseId;
    const courseTitle = document.createElement('small');
    courseTitle.textContent = item.courseTitle;
    course.append(courseId, document.createElement('br'), courseTitle);

    const announcement = document.createElement('td');
    const title = document.createElement('strong');
    title.textContent = item.title;
    announcement.appendChild(title);

    if (isNew) {
      const label = document.createElement('span');
      label.className = 'label label-primary';
      label.style.marginLeft = '6px';
      label.textContent = 'New';
      announcement.appendChild(label);
    }

    if (item.text) {
      const text = document.createElement('div');
      text.style.cssText = 'white-space: pre-line; margin-top: 4px;';
      text.textContent = item.text;
      announcement.appendChild(text);
    }

    const links = document.createElement('div');
    links.style.marginTop = '4px';
    item.links.forEach(link => {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.marginRight = '12px';
      a.innerHTML = '<i class="fa fa-external-link"></i> ';
      a.append(link.text || 'Open link');
      links.appendChild(a);
    });
    const view = document.createElement('a');
    view.href = item.pageUrl;
    view.target = '_blank';
    view.className = 'text-muted';
    view.style.fontSize = '12px';
    view.textContent = 'View on LMS';
    links.appendChild(view);
    announcement.appendChild(links);

    tr.append(date, course, announcement);
    return tr;
  }

  // Inject widget with assignments (supports progressive updates)
  function injectWidget(assignments, totalCount, isLoading = false) {
    const targetBox = findInternalMarksBox();
    if (!targetBox) {
      return;
    }

    // Check if widget already exists - update it instead of recreating
    let widget = document.getElementById('culms-pending-assignments-widget');
    const isNewWidget = !widget;

    if (isNewWidget) {
      widget = document.createElement('div');
      widget.className = 'box';
      widget.id = 'culms-pending-assignments-widget';
    }

    const loadingIndicator = isLoading ? 
      `<span style="margin-left: 10px; color: #3c8dbc;"><i class="fa fa-spinner fa-spin"></i> Loading...</span>` : '';

    const refreshBtnSpinClass = isRefreshing ? 'fa-spin' : '';
    const refreshBtnDisabled = isRefreshing ? 'disabled' : '';

    widget.innerHTML = `
      <div class="box-header with-border">
        <h3 class="box-title">
          <i class="fa fa-exclamation-triangle" style="color: #dd4b39;"></i>
          Pending Assignments
          ${loadingIndicator}
        </h3>
        <div class="box-tools pull-right">
          <button class="btn btn-default btn-sm" id="culms-refresh-btn" title="Refresh assignments" ${refreshBtnDisabled}>
            <i class="fa fa-refresh ${refreshBtnSpinClass}"></i>
          </button>
          <button class="btn btn-primary btn-sm" id="culms-view-all-btn">
            <i class="fa fa-list"></i> View All (${totalCount})
          </button>
        </div>
      </div>
      <div class="box-body">
        <table class="table table-bordered table-hover">
          <thead>
            <tr>
              <th width="5%">#</th>
              <th width="25%">Course</th>
              <th width="30%">Assignment</th>
              <th width="15%">Deadline</th>
              <th width="10%">Status</th>
              <th width="15%">Action</th>
            </tr>
          </thead>
          <tbody>
            ${assignments.map((a, i) => `
              <tr>
                <td>${i + 1}</td>
                <td><strong>${escapeHtml(a.courseId)}</strong><br><small>${escapeHtml(a.courseTitle)}</small></td>
                <td>${escapeHtml(a.title)}</td>
                <td><span style="color: #dd4b39;"><i class="fa fa-clock-o"></i> ${escapeHtml(a.lastDate)}</span></td>
                <td><span class="label label-danger">Pending</span></td>
                <td>
                  <a href="${escapeHtml(a.assignmentUrl)}" class="btn btn-primary btn-xs" target="_blank">
                    <i class="fa fa-external-link"></i> View
                  </a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    if (isNewWidget) {
      insertPendingWidget(widget);
    }
    widgetInjected = true;

    // Attach event listener to View All button
    const viewAllBtn = document.getElementById('culms-view-all-btn');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', openViewAll);
    }

    // Attach event listener to Refresh button
    const refreshBtn = document.getElementById('culms-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshAssignments);
    }
  }

  // Update or inject header icon
  function updateHeaderIcon(count) {
    const existingIcon = document.getElementById('culms-assignments-header-icon');
    
    if (existingIcon) {
      // Update existing icon badge
      const badge = existingIcon.querySelector('.label');
      if (count > 0) {
        if (badge) {
          badge.textContent = count;
        } else {
          existingIcon.insertAdjacentHTML('beforeend', `<span class="label label-danger">${count}</span>`);
        }
      } else if (badge) {
        badge.remove();
      }
      return;
    }

    // Create new icon
    const navMenu = document.querySelector('.navbar-custom-menu .nav.navbar-nav');
    if (!navMenu) {
      return;
    }

    const iconLi = document.createElement('li');
    iconLi.className = 'dropdown notifications-menu';
    iconLi.id = 'culms-assignments-header-li';
    iconLi.innerHTML = `
      <a href="#" id="culms-assignments-header-icon" title="Pending Assignments" style="color: #ffffff">
        <i class="fa fa-tasks"></i>
        ${count > 0 ? `<span class="label label-danger">${count}</span>` : ''}
      </a>
    `;

    navMenu.insertBefore(iconLi, navMenu.firstChild);

    // Attach event listener
    const icon = document.getElementById('culms-assignments-header-icon');
    if (icon) {
      icon.addEventListener('click', (e) => {
        e.preventDefault();
        openViewAll();
      });
    }
  }

  // Open View All page
  function openViewAll() {
    const url = chrome.runtime.getURL('features/assignment-tracker/view-all.html');
    window.open(url, '_blank');
  }

  // Refresh assignments (clear cache and fetch fresh data)
  async function refreshAssignments() {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshBtn = document.getElementById('culms-refresh-btn');
    const refreshIcon = refreshBtn?.querySelector('i');

    // Show loading state
    if (refreshIcon) {
      refreshIcon.classList.add('fa-spin');
    }
    if (refreshBtn) {
      refreshBtn.disabled = true;
    }

    // Clear cache
    await chrome.storage.local.remove('assignmentCache');

    // Remove existing widget
    widgetInjected = false;
    const existingWidget = document.getElementById('culms-pending-assignments-widget');
    if (existingWidget) {
      existingWidget.remove();
    }

    // Show loading widget
    showLoadingWidget();

    // Fetch directly from content script (has cookie access)
    fetchAllAssignments();
  }

  // Find the Internal Marks box
  function findInternalMarksBox() {
    const boxes = document.querySelectorAll('.box');
    for (const box of boxes) {
      const title = box.querySelector('.box-title');
      if (title && title.textContent.includes('Internal Marks')) {
        return box;
      }
    }
    return null;
  }

  // Pending Assignments sits above Course Announcements, both above Internal Marks.
  // The pending widget is re-inserted on every state change, so anchor it to the
  // announcements box when that exists to keep the order stable
  function insertPendingWidget(widget) {
    const anchor = document.getElementById('cublitz-announcements') || findInternalMarksBox();
    anchor.parentNode.insertBefore(widget, anchor);
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Start initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
