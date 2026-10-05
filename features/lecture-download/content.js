// Content script for Lecture Download
// Adds a "Download all" button above the lectures table on lectures.php

(function() {
  'use strict';

  const FILE_PATTERN = /\.(pdf|pptx?|docx?|xlsx?|zip|rar|txt)$/i;
  // Gap between downloads so Chrome handles them one by one
  const DOWNLOAD_GAP_MS = 400;

  function init() {
    // Columns: Week No | Topics | Delivery Plan | Assessment Plan | Status
    const table = [...document.querySelectorAll('table')].find(t =>
      [...t.querySelectorAll('th')].some(th => th.textContent.trim() === 'Delivery Plan'));
    if (!table) return;

    const files = collectFiles(table);
    if (files.length === 0) return;

    const courseCode = (document.querySelector('.content-wrapper')?.textContent
      .match(/Course Code\s*:\s*([A-Z]{2,5}-\d{3}\S*)/) || [])[1] || '';

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-bottom: 10px;';
    toolbar.innerHTML = `
      <small class="text-muted" id="cublitz-download-status"></small>
      <button type="button" class="btn btn-primary btn-sm" id="cublitz-download-all"></button>
    `;
    table.before(toolbar);

    const button = toolbar.querySelector('#cublitz-download-all');
    const status = toolbar.querySelector('#cublitz-download-status');
    setIdle(button, files.length);
    button.addEventListener('click', () => downloadAll(button, status, files, courseCode));
  }

  // Unique lecture files on this page, in table order
  function collectFiles(table) {
    const seen = new Set();
    const files = [];

    for (const link of table.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href').trim();
      if (!FILE_PATTERN.test(href.split('?')[0])) continue;

      // A "#" in a file name would otherwise be read as a link fragment
      const url = new URL(href.replace(/#/g, '%23'), window.location.href);
      if (url.origin !== window.location.origin || seen.has(url.href)) continue;
      seen.add(url.href);

      files.push({ url: url.href, name: fileName(url) });
    }

    return files;
  }

  function fileName(url) {
    const last = url.pathname.split('/').pop();
    try {
      return decodeURIComponent(last);
    } catch (err) {
      return last;
    }
  }

  function setIdle(button, count) {
    button.disabled = false;
    button.innerHTML = `<i class="fa fa-download"></i> Download all (${count} ${count === 1 ? 'file' : 'files'})`;
  }

  async function downloadAll(button, status, files, courseCode) {
    button.disabled = true;
    status.textContent = 'If Chrome asks, allow cu.edu.pk to download multiple files.';

    for (let i = 0; i < files.length; i++) {
      button.innerHTML = `<i class="fa fa-spinner fa-spin"></i> Starting download ${i + 1} of ${files.length}`;
      startDownload(files[i], courseCode);
      await new Promise(resolve => setTimeout(resolve, DOWNLOAD_GAP_MS));
    }

    // The page can't see whether Chrome finished or blocked them, only that they started
    status.textContent = `Started ${files.length} ${files.length === 1 ? 'download' : 'downloads'}. Check your Downloads folder.`;
    setIdle(button, files.length);
  }

  // Same-origin files, so the download attribute is honoured and sets the name.
  // Prefix the course code so files from different courses stay apart
  function startDownload(file, courseCode) {
    const a = document.createElement('a');
    a.href = file.url;
    a.download = (courseCode ? `${courseCode} - ` : '') + file.name.replace(/[\\/:*?"<>|]/g, '_');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
