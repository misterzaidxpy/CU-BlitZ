// JavaScript for View All Assignments page

(function() {
  'use strict';

  // Load assignments when page loads
  document.addEventListener('DOMContentLoaded', () => {
    loadAssignments();

    // Attach retry button handler
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', loadAssignments);
    }

    // Attach refresh button handler
    const refreshBtn = document.getElementById('refresh-assignments-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', refreshAssignments);
    }
  });

  // Load assignments from chrome.storage
  async function loadAssignments() {
    try {
      // Show loading state
      showLoading();

      const result = await chrome.storage.local.get(['assignmentCache']);

      // If cache is suspicious (likely from expired session), auto-refresh
      if (result.assignmentCache && isCacheSuspicious(result.assignmentCache)) {
        refreshAssignments();
        return;
      }

      if (result.assignmentCache?.assignments) {
        const assignments = result.assignmentCache.assignments;

        if (assignments.length === 0) {
          showEmptyState();
        } else {
          displayAssignments(assignments);
        }
      } else {
        showEmptyState();
      }
    } catch (error) {
      console.error('Error loading assignments:', error);
      showError('Failed to load assignments. Please try again.');
    }
  }

  // Refresh assignments - clear cache and reload
  async function refreshAssignments() {
    const refreshBtn = document.getElementById('refresh-assignments-btn');
    const refreshIcon = refreshBtn?.querySelector('i');

    // Disable button and show spinning icon
    if (refreshBtn) {
      refreshBtn.disabled = true;
    }
    if (refreshIcon) {
      refreshIcon.classList.add('fa-spin');
    }

    // Helper to reset button state
    const resetButton = () => {
      if (refreshBtn) {
        refreshBtn.disabled = false;
      }
      if (refreshIcon) {
        refreshIcon.classList.remove('fa-spin');
      }
    };

    try {
      // Clear the cache
      await chrome.storage.local.remove('assignmentCache');

      // Show loading state with progress
      showLoading('Fetching courses...');

      // Set up a listener for progressive updates
      const storageListener = (changes, areaName) => {
        if (areaName === 'local' && changes.assignmentCache?.newValue) {
          const cache = changes.assignmentCache.newValue;
          const { assignments, isComplete, progress } = cache;

          // Update progress text
          if (progress && progress.total > 0) {
            updateLoadingProgress(progress.completed, progress.total, assignments.length);
          }

          // Show assignments progressively (even if not complete)
          if (assignments && assignments.length > 0) {
            displayAssignments(assignments, !isComplete);
          }

          // If complete, clean up
          if (isComplete) {
            chrome.storage.onChanged.removeListener(storageListener);
            clearTimeout(timeoutId);
            resetButton();
            
            // Final display (removes loading indicator)
            if (assignments.length === 0) {
              showEmptyState();
            } else {
              displayAssignments(assignments, false);
            }
          }
        }
      };

      // Add the storage change listener
      chrome.storage.onChanged.addListener(storageListener);

      // Set a timeout in case something goes wrong (60 seconds max)
      const timeoutId = setTimeout(() => {
        chrome.storage.onChanged.removeListener(storageListener);
        resetButton();
        loadAssignments();
      }, 60000);

      // Send message to background script to fetch fresh data
      chrome.runtime.sendMessage({ action: 'fetchAssignments' });

    } catch (error) {
      console.error('Error refreshing assignments:', error);
      resetButton();
      showError('Failed to refresh assignments. Please try again.');
    }
  }

  // Display assignments grouped by course
  function displayAssignments(assignments, isLoading = false) {
    hideAllStates();

    // Update count
    const countElement = document.getElementById('assignment-count');
    if (countElement) {
      const loadingText = isLoading ? ' - loading...' : '';
      countElement.textContent = `(${assignments.length} total${loadingText})`;
    }

    // Group assignments by course
    const groupedByCourse = groupByCourse(assignments);

    // Render assignments
    const container = document.getElementById('assignments-container');
    
    // Add loading indicator at top if still loading
    const loadingBanner = isLoading ? `
      <div class="box box-info" id="progressive-loading-banner">
        <div class="box-body text-center" style="padding: 15px;">
          <i class="fa fa-spinner fa-spin" style="color: #3c8dbc;"></i>
          <span style="margin-left: 10px;" id="progressive-loading-text">Loading more courses...</span>
        </div>
      </div>
    ` : '';

    container.innerHTML = loadingBanner + Object.entries(groupedByCourse)
      .map(([courseKey, courseAssignments]) => createCourseBox(courseKey, courseAssignments))
      .join('');

    container.style.display = 'block';
  }

  // Group assignments by course
  function groupByCourse(assignments) {
    return assignments.reduce((acc, assignment) => {
      const key = assignment.courseId || 'Unknown';
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(assignment);
      return acc;
    }, {});
  }

  // Create a course box with its assignments
  function createCourseBox(courseKey, assignments) {
    const firstAssignment = assignments[0];

    return `
      <div class="box box-primary">
        <div class="box-header with-border">
          <h3 class="box-title">
            <strong>${escapeHtml(firstAssignment.courseId)}</strong> - ${escapeHtml(firstAssignment.courseTitle)}
          </h3>
          <span class="pull-right badge bg-red">${assignments.length} pending</span>
        </div>
        <div class="box-body">
          ${assignments.map((assignment, index) => createAssignmentCard(assignment, index, assignments.length)).join('')}
        </div>
      </div>
    `;
  }

  // Create an assignment card
  function createAssignmentCard(assignment, index, total) {
    const uploadLinkHtml = assignment.uploadLink ? `
      <a href="https://cu.edu.pk/cpanelS/${escapeHtml(assignment.uploadLink)}"
         class="btn btn-success btn-sm"
         target="_blank"
         title="Upload Assignment">
        <i class="fa fa-upload"></i> Upload Now
      </a>
    ` : '';

    return `
      <div class="assignment-card">
        <div class="row">
          <div class="col-md-1 col-sm-2 col-xs-12">
            <div class="assignment-number">${escapeHtml(assignment.assignmentNo)}</div>
          </div>
          <div class="col-md-11 col-sm-10 col-xs-12">
            <h4 class="assignment-title">${escapeHtml(assignment.title)}</h4>

            <div class="assignment-meta">
              <span>
                <i class="fa fa-calendar"></i>
                <strong>Date Added:</strong> ${escapeHtml(assignment.dateAdded)}
              </span>
              <span class="deadline">
                <i class="fa fa-clock-o"></i>
                <strong>Deadline:</strong> ${escapeHtml(assignment.lastDate)}
              </span>
            </div>

            <div class="assignment-description">
              <strong><i class="fa fa-file-text-o"></i> Description:</strong>
              <div class="description-content">
                ${assignment.description || '<em>No description available</em>'}
              </div>
            </div>

            <div class="assignment-actions">
              <a href="${escapeHtml(assignment.assignmentUrl)}"
                 class="btn btn-primary"
                 target="_blank"
                 title="View Assignment Page">
                <i class="fa fa-external-link"></i> View Assignment Page
              </a>
              ${uploadLinkHtml}
            </div>
          </div>
        </div>
        ${index < total - 1 ? '<hr>' : ''}
      </div>
    `;
  }

  // Show loading state
  function showLoading(message = 'Loading your pending assignments...') {
    hideAllStates();
    const loadingState = document.getElementById('loading-state');
    const loadingText = loadingState.querySelector('p');
    if (loadingText) {
      loadingText.textContent = message;
    }
    loadingState.style.display = 'block';
  }

  // Update loading progress text
  function updateLoadingProgress(completed, total, assignmentCount) {
    // Update the progressive loading banner if it exists
    const progressText = document.getElementById('progressive-loading-text');
    if (progressText) {
      progressText.textContent = `Fetching course ${completed}/${total}... (${assignmentCount} assignments found)`;
    }
    
    // Also update the main loading state if visible
    const loadingState = document.getElementById('loading-state');
    if (loadingState.style.display === 'block') {
      const loadingText = loadingState.querySelector('p');
      if (loadingText) {
        loadingText.textContent = `Fetching course ${completed}/${total}...`;
      }
    }
  }

  // Show empty state
  function showEmptyState() {
    hideAllStates();
    document.getElementById('empty-state').style.display = 'block';
  }

  // Show error state
  function showError(message) {
    hideAllStates();
    const errorState = document.getElementById('error-state');
    const errorMessage = document.getElementById('error-message');

    if (errorMessage) {
      errorMessage.textContent = message;
    }

    errorState.style.display = 'block';
  }

  // Hide all states
  function hideAllStates() {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('error-state').style.display = 'none';
    document.getElementById('assignments-container').style.display = 'none';
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Check if cache is suspicious (likely from expired session)
  // Cache with 0 courses processed likely means session was invalid during fetch
  function isCacheSuspicious(cache) {
    return cache.isComplete &&
           cache.progress?.total === 0 &&
           cache.assignments?.length === 0;
  }

})();
