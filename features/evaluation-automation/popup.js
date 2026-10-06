
const RATING_MAP = {
  "Strongly Agree": "1",
  "Agree": "2",
  "Uncertain": "3",
  "Disagree": "4",
  "Strongly Disagree": "5"
};

// Individual evaluation forms (filled from here) and listing pages (bulk submit lives there)
const FORM_PAGES = {
  "teacherseval.php": "Teacher evaluation form",
  "courseeval.php": "Course evaluation form"
};
const LIST_PAGES = ["evalteacher.php", "evalcourse.php"];

const sheet = document.getElementById("answer-sheet");
const radios = [...document.querySelectorAll('input[name="rating"]')];
const choiceEl = document.getElementById("choice");
const commentEl = document.getElementById("comment");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");

let activeTabId = null;
let onFormPage = false;

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

function selectedRadio() {
  return radios.find(r => r.checked) || null;
}

function showChoice(radio, isPreview = false) {
  choiceEl.textContent = radio ? radio.dataset.label : "";
  choiceEl.classList.toggle("is-preview", isPreview);
}

function setStatus(text, state = "") {
  statusText.textContent = text;
  statusEl.className = "status" + (state ? " is-" + state : "");
}

// Hovering a bubble previews its label; leaving restores the chosen one
radios.forEach(radio => {
  const option = radio.closest(".option");
  option.addEventListener("mouseenter", () => {
    if (!radio.checked) showChoice(radio, true);
  });
  option.addEventListener("mouseleave", () => showChoice(selectedRadio()));
  radio.addEventListener("change", () => showChoice(radio));
});

// Load what was saved last time
chrome.storage.sync.get(["rating", "comment"], ({ rating, comment }) => {
  const saved = radios.find(r => r.value === rating);
  if (saved) saved.checked = true;
  showChoice(saved);
  if (comment) commentEl.value = comment;
});

// Work out what kind of page the active tab is. tab.url is only visible
// for LMS tabs (host permission), so any other tab reads as "no form here"
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  activeTabId = tab ? tab.id : null;

  let page = "";
  try {
    page = new URL(tab.url).pathname.split("/").pop();
  } catch (err) {
    // No URL access: not an LMS tab
  }

  if (FORM_PAGES[page]) {
    onFormPage = true;
    saveBtn.textContent = "Save and fill this page";
    setStatus(FORM_PAGES[page] + " open in this tab.", "form");
  } else if (LIST_PAGES.includes(page)) {
    setStatus("Evaluation list open. After saving, use “Complete all” on the page.");
  } else {
    setStatus("No evaluation form in this tab. Saved answers fill forms when you open them.");
  }
});

sheet.addEventListener("submit", async (e) => {
  e.preventDefault();

  const radio = selectedRadio();
  const comment = commentEl.value.trim();

  if (!radio) {
    setStatus("Pick a rating first.", "error");
    radios[0].focus();
    return;
  }
  if (!comment) {
    setStatus("Write a comment first. Forms need both a rating and a comment.", "error");
    commentEl.focus();
    return;
  }

  saveBtn.disabled = true;
  await chrome.storage.sync.set({ rating: radio.value, comment });

  if (!onFormPage) {
    setStatus("Saved. Open an evaluation form and it fills in automatically.", "done");
    saveBtn.disabled = false;
    return;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      args: [RATING_MAP[radio.value] || "2", comment],
      func: (selectedValue, comment) => {
        let questions = 0;
        let comments = 0;
        for (let i = 1; i <= 28; i++) {
          const radios = document.querySelectorAll(`input[name="q${i}"][value="${selectedValue}"]`);
          radios.forEach(r => r.checked = true);
          if (radios.length) questions++;
        }
        const commentFields = [];
        for (let i = 1; i <= 9; i++) {
          commentFields.push(document.getElementById("cat" + i));
        }
        commentFields.push(document.getElementById("teachercomment"), document.getElementById("coursecomment"));
        commentFields.forEach(field => {
          if (field) {
            field.value = comment;
            comments++;
          }
        });
        return { questions, comments };
      }
    });

    const { questions, comments } = injection.result;
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    setStatus(`Saved and filled ${count(questions, "question", "questions")} and ${count(comments, "comment box", "comment boxes")}. Review, then submit the form.`, "done");
  } catch (err) {
    setStatus("Saved, but this page couldn't be filled. Reload it and try again.", "error");
  }
  saveBtn.disabled = false;
});
