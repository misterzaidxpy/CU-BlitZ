// Content script for CULMS Assignment Tracker
// Injects pending assignments widget and header icon on dashboard

(function() {
  'use strict';

  let widgetInjected = false;
  let isRefreshing = false;

  const CACHE_TTL = 3600000; // 1 hour in milliseconds
  // Use relative URLs to avoid CORS issues between www.cu.edu.pk and cu.edu.pk
  const LMS_BASE_URL = '/cpanelS/';

  // Initialize on page load
  async function init() {
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

    if (cachedData && cachedData.isComplete && !isCacheStale(cachedData) && !isCacheSuspicious(cachedData)) {
      displayAssignments(cachedData.assignments);
    } else {
      // Fetch directly from content script (has cookie access)
      fetchAllAssignments();
    }
  }

  // Set up listener for progressive storage updates
  function setupStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
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
          if (assignments.length === 0) {
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

  // Check if cache is suspicious (likely from expired session)
  // Cache with 0 courses processed likely means session was invalid during fetch
  function isCacheSuspicious(cache) {
    return cache.isComplete &&
           cache.progress?.total === 0 &&
           cache.assignments?.length === 0;
  }

  // ========== FETCH FUNCTIONS (run in content script for cookie access) ==========

  // Fetch all assignments directly from content script
  async function fetchAllAssignments() {
    try {
      // Step 1: Fetch course list
      const courses = await fetchCourses();

      if (courses.length === 0) {
        await cacheAssignments([], true);
        return [];
      }

      // Step 2: Fetch assignments for each course with progressive updates
      let allAssignments = [];
      let completedCourses = 0;
      const totalCourses = courses.length;

      const assignmentPromises = courses.map(async (course) => {
        try {
          const courseAssignments = await fetchAssignmentsForCourse(course);
          allAssignments = [...allAssignments, ...courseAssignments];
          completedCourses++;
          const isComplete = completedCourses === totalCourses;
          await cacheAssignments(allAssignments, isComplete, completedCourses, totalCourses);
          return courseAssignments;
        } catch (err) {
          completedCourses++;
          const isComplete = completedCourses === totalCourses;
          await cacheAssignments(allAssignments, isComplete, completedCourses, totalCourses);
          return [];
        }
      });

      await Promise.all(assignmentPromises);
      return allAssignments;

    } catch (error) {
      console.error('Error fetching assignments:', error);
      await cacheAssignments([], true);
      return [];
    }
  }

  // Fetch course list from mycourses.php
  async function fetchCourses() {
    const url = `${LMS_BASE_URL}mycourses.php`;

    const response = await fetch(url, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch courses: ${response.status}`);
    }

    const html = await response.text();
    return parseCourses(html);
  }

  // Parse course list from HTML
  function parseCourses(html) {
    const courses = [];
    const seenCourses = new Set();

    const linkPattern = /<a\s+href=['"]outline\.php\?([^'"]+)['"]\s*>([^<]+)<\/a>/gi;

    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const queryString = match[1];
      const courseId = match[2].trim();

      try {
        const urlParams = new URLSearchParams(queryString);
        const section = urlParams.get('section') || '';
        const teacherId = urlParams.get('teacherID');
        const session = urlParams.get('sess');
        const cpsess = urlParams.get('cpsess');

        // Course code and title cells both link to the same outline.php URL,
        // so key on the query string to keep only the first (course code) link
        if (seenCourses.has(queryString)) continue;
        seenCourses.add(queryString);

        const titleMatch = html.substring(match.index).match(/<\/a><\/td>\s*<td[^>]*><a[^>]*>([^<]+)<\/a>/);
        const courseTitle = titleMatch ? titleMatch[1].trim() : 'Unknown';

        courses.push({
          courseId, courseTitle, section, teacherId, session, cpsess,
          shift: 'Morning'
        });
      } catch (err) {
        // Skip malformed entries
      }
    }

    return courses;
  }

  // Fetch assignments for a specific course
  async function fetchAssignmentsForCourse(course) {
    const url = `${LMS_BASE_URL}assignments.php?` +
      `courseid=${encodeURIComponent(course.courseId)}` +
      `&teacherID=${course.teacherId}` +
      `&section=${encodeURIComponent(course.section)}` +
      `&shift=${encodeURIComponent(course.shift)}` +
      `&sess=${encodeURIComponent(course.session)}` +
      `&cpsess=${course.cpsess}`;

    const response = await fetch(url, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch assignments for ${course.courseId}: ${response.status}`);
    }

    const html = await response.text();
    // Store full URL for use in extension pages (view-all.html)
    const fullUrl = window.location.origin + url;
    return parseAssignments(html, course, fullUrl);
  }

  // Parse assignments from HTML
  function parseAssignments(html, course, assignmentPageUrl) {
    const pendingAssignments = [];
    const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = trPattern.exec(html)) !== null) {
      const rowHtml = rowMatch[1];

      if (rowHtml.includes('colspan')) continue;

      if (rowHtml.includes('asgupload.php')) {
        const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let cellMatch;

        while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
          cells.push(cellMatch[1]);
        }

        if (cells.length < 7) continue;

        const assignmentNo = extractText(cells[0]);
        const title = extractText(cells[1]);
        const description = cells[2];
        const dateAdded = extractText(cells[5]);
        const lastDate = extractText(cells[6]);

        const helpFileMatch = cells[3].match(/<a\s+href=['"]([^'"]+)['"][^>]*>([^<]+)<\/a>/);
        const helpFile = helpFileMatch ? helpFileMatch[1] : null;
        const helpFileName = helpFileMatch ? helpFileMatch[2].trim() : null;

        const uploadLinkMatch = cells[7].match(/<a\s+href=['"]([^'"]+)['"]/);
        const uploadLink = uploadLinkMatch ? uploadLinkMatch[1] : null;

        pendingAssignments.push({
          assignmentNo, title, description, helpFile, helpFileName,
          dateAdded, lastDate, uploadLink,
          courseId: course.courseId,
          courseTitle: course.courseTitle,
          assignmentUrl: assignmentPageUrl
        });
      }
    }

    return pendingAssignments;
  }

  // Helper to extract text from HTML
  function extractText(html) {
    if (!html) return '';
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  // Cache assignments in chrome.storage
  async function cacheAssignments(assignments, isComplete = true, completedCourses = 0, totalCourses = 0) {
    await chrome.storage.local.set({
      assignmentCache: {
        lastFetched: Date.now(),
        ttl: CACHE_TTL,
        assignments: assignments,
        isComplete: isComplete,
        progress: {
          completed: completedCourses,
          total: totalCourses
        }
      }
    });
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
    removeLoadingWidget();

    if (!assignments || assignments.length === 0) {
      if (!isLoading) {
        injectEmptyWidget();
        updateHeaderIcon(0);
      }
      return;
    }

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

    targetBox.parentNode.insertBefore(widget, targetBox);
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

    targetBox.parentNode.insertBefore(widget, targetBox);
    widgetInjected = true;

    // Attach event listener to Refresh button
    const refreshBtn = document.getElementById('culms-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshAssignments);
    }
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
      targetBox.parentNode.insertBefore(widget, targetBox);
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
    await chrome.storage.local.clear();

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
