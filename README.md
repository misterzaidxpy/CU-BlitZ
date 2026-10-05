# CU-BlitZ

A feature-packed Chrome Extension designed for **City University of Science and Information Technology (CUSIT)** students. It combines multiple productivity tools to streamline your university experience.

**150+ users** on the [Chrome Web Store](https://chromewebstore.google.com/detail/cu-blitz/lpmieknliegdccpflcpdooimjlgpceih).

---

## Features

### Evaluation Automation
- **One-Click Bulk Submission** - Complete all teacher or course evaluations at once without visiting each page individually
- Auto-fill evaluation forms with your preferred rating and comment
- Live progress tracking with per-course status updates
- Works on both teacher evaluation and course evaluation pages
- Customizable ratings and comments via the popup interface

### Assignment Tracker
- **Dashboard Widget** - View up to 5 pending assignments on your LMS dashboard
- **Header Icon** - Quick access with assignment count badge
- **View All Page** - Comprehensive list of all pending assignments organized by course
- **Smart Caching** - Auto-updates every hour to minimize server load
- **Direct Links** - Jump straight to assignment or upload pages

### Privacy and Security
- 100% local processing, no remote code execution
- No data collection or external tracking
- Uses your existing browser session (no password storage)
- Open source and auditable

---

## Project Structure

```
CU-BlitZ/
├── manifest.json
├── icons/
├── features/
│   ├── evaluation-automation/
│   │   ├── content.js            # Auto-fill + bulk submission logic
│   │   ├── page-fetch.js         # Main-world fetch helper for bulk submissions
│   │   ├── popup.html            # Settings popup UI
│   │   └── popup.js              # Popup logic
│   └── assignment-tracker/
│       ├── background.js         # Relays View All refresh requests to an open LMS tab
│       ├── content-dashboard.js  # Fetch, parse and cache assignments; inject dashboard widget
│       ├── injected-styles.css   # Widget styling
│       ├── view-all.html         # Full assignments page
│       ├── view-all.js           # View all page logic
│       └── view-all.css          # View all page styling
└── README.md
```

---

## How It Works

### Evaluation Automation

**Individual Auto-Fill:**
1. Click the CU-BlitZ icon in the toolbar
2. Select your preferred rating and enter a comment
3. Click "Save & Auto-Fill"
4. Visit any evaluation page and the form fills instantly

**One-Click Bulk Submission:**
1. Set your rating and comment in the popup
2. Visit the Teacher Evaluation or Course Evaluation listing page
3. Click "Complete All Evaluations in One Click"
4. Watch the progress bar as each evaluation is submitted automatically

### Assignment Tracker
1. Log in to CUSIT LMS (`https://cu.edu.pk/cpanelS/`)
2. Navigate to your dashboard
3. See pending assignments displayed above the Internal Marks table
4. Click the header icon or "View All" for detailed information
5. Use the refresh button to update assignment status anytime

---

## Installation

### From Chrome Web Store

Install directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/cu-blitz/lpmieknliegdccpflcpdooimjlgpceih).

### For Development

1. Clone the repository:
   ```bash
   git clone https://github.com/misterzaidxpy/CU-BlitZ.git
   ```
2. Go to `chrome://extensions` in Chrome
3. Enable **Developer Mode** (toggle in top-right)
4. Click **Load Unpacked**
5. Select the `CU-BlitZ` folder

---

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store rating/comment preferences and cache assignment data |
| `scripting` | Inject evaluation automation scripts on active tab |
| `host_permissions` (`cu.edu.pk`) | Access the CUSIT LMS domain only |

No data is collected or sent anywhere. Everything runs locally in your browser.

---

## Troubleshooting

**Evaluation automation not working:**
- Ensure you are on an evaluation page (`evalteacher.php` or `evalcourse.php`)
- Verify your settings are saved in the popup
- Try refreshing the page after saving settings

**Bulk submission failing:**
- Refresh the evaluation listing page and try again
- Ensure your LMS session has not expired
- Check the browser console for specific error messages

**Assignments not showing:**
- Verify you are logged in to the LMS
- Click the refresh button to clear cache
- Ensure you have pending assignments

---

## Built With

- **JavaScript (Vanilla)** - No external dependencies
- **Chrome Manifest V3** - Latest extension standard
- **HTML/CSS** - Bootstrap 3.x compatible styling

---

## Privacy Policy

[View Privacy Policy](https://misterzaid.com/privacy.html)

---

## Changelog

### v2.1.1 (Current)
- Fixed Assignment Tracker sending two requests per course (12 instead of 6 for 6 courses)
- Updated author links to the new portfolio domain and GitHub username

### v2.1.0
- Added one-click bulk submission for teacher and course evaluations
- Live progress bar with per-course status tracking
- Info note for individual vs bulk submission options

### v2.0.0
- Added Assignment Tracker feature
- Reorganized into feature-based directory structure
- Optimized permissions for Chrome Web Store compliance

### v1.0.1
- Bug fixes and improvements
- Initial evaluation automation feature

---

## Feedback and Support

- Email: **contact@misterzaid.com**
- Issues: [GitHub Issues](https://github.com/misterzaidxpy/CU-BlitZ/issues)
- Star this repo if you find it helpful!

---

## License

This project is open-source and free under the [MIT License](LICENSE).

---

**Made for CUSIT students. By a CUSIT student.**
