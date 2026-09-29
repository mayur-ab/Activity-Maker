const form = document.querySelector("#maker");
const themeSelect = document.querySelector("#theme");
const categorySelect = document.querySelector("#category");
const mechanicSelect = document.querySelector("#mechanic");
const themeNote = document.querySelector("#themeNote");
const errorBox = document.querySelector("#error");
const results = document.querySelector("#results");
const go = document.querySelector("#go");
const apiKeyInput = document.querySelector("#apiKey");
const modelInput = document.querySelector("#model");
const remember = document.querySelector("#remember");

let catalog = { categories: [], themes: [] };
const KEY_STORAGE = "activity-maker-openrouter-key";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function option(value, label) {
  const node = el("option", "", label);
  node.value = value;
  return node;
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
}

function fillThemes() {
  themeSelect.innerHTML = "";
  for (const theme of catalog.themes) {
    const option = el("option", "", theme.name);
    option.value = theme.slug;
    themeSelect.appendChild(option);
  }
  showTheme();
}

function fillCategories() {
  for (const category of catalog.categories) {
    const option = el("option", "", `${category.code} · ${category.name}`);
    option.value = String(category.category_id);
    categorySelect.appendChild(option);
  }
}

function fillMechanics() {
  const category = catalog.categories.find(
    (item) => String(item.category_id) === categorySelect.value
  );
  mechanicSelect.innerHTML = "";
  mechanicSelect.appendChild(option("", category ? "Any in the category" : "Pick a category first"));
  mechanicSelect.disabled = !category;
  if (!category) return;
  for (const name of category.mechanics) {
    mechanicSelect.appendChild(option(name, name));
  }
}

function showTheme() {
  const theme = catalog.themes.find((item) => item.slug === themeSelect.value);
  if (!theme) {
    themeNote.textContent = "";
    return;
  }
  const tags = Array.isArray(theme.tags) ? theme.tags.slice(0, 6).join(", ") : "";
  themeNote.textContent = [theme.core_idea || theme.description || "", tags]
    .filter(Boolean)
    .join(" · ");
}

function field(card, label, value) {
  if (!value) return;
  card.appendChild(el("h3", "", label));
  card.appendChild(el("p", "", String(value)));
}

function renderActivities(payload) {
  results.innerHTML = "";
  const bar = el("div", "toolbar");
  const reviewStatus = payload.review_error
    ? `Review skipped: ${payload.review_error}`
    : "Reviewed";
  bar.appendChild(el("p", "meta", `${payload.theme.name} · ${payload.model} · ${reviewStatus}`));
  const copy = el("button", "", "Copy JSON");
  copy.type = "button";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(JSON.stringify(payload.activities, null, 2));
    copy.textContent = "Copied";
  });
  bar.appendChild(copy);
  results.appendChild(bar);

  payload.activities.forEach((activity, index) => {
    const card = el("article", "card");
    card.appendChild(el("h2", "", activity.title || `Activity ${index + 1}`));
    const meta = [
      activity.category_name,
      activity.mechanic,
      activity.difficulty,
      activity.age_min && activity.age_max ? `ages ${activity.age_min}–${activity.age_max}` : "",
      activity.duration_minutes ? `${activity.duration_minutes} min` : "",
    ].filter(Boolean).join(" · ");
    card.appendChild(el("p", "meta", meta));
    const review = Array.isArray(payload.review) ? payload.review[index] : null;
    const fixes = review && Array.isArray(review.fixes) ? review.fixes.filter(Boolean) : [];
    if (fixes.length) field(card, "Review", fixes.map(String).join("\n"));
    field(card, "Goal", activity.goal);
    field(card, "Puzzle", activity.puzzle_prompt);
    field(card, "Setup", activity.setup);
    field(card, "Instructions", activity.instructions);
    field(card, "Rules", activity.rules);
    field(card, "Components", activity.components);
    field(card, "Materials", activity.materials);
    if (activity.answer_or_solution) {
      card.appendChild(el("h3", "", "Answer"));
      card.appendChild(el("p", "answer", String(activity.answer_or_solution)));
    }
    if (Array.isArray(activity.skills) && activity.skills.length) {
      card.appendChild(el("p", "skills", activity.skills.join(" · ")));
    }
    field(card, "Theme", activity.theme_note || activity.story_integration);
    results.appendChild(card);
  });
}

categorySelect.addEventListener("change", fillMechanics);
themeSelect.addEventListener("change", showTheme);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  go.disabled = true;
  go.textContent = "Generating…";
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
  if (remember) {
    if (remember.checked && apiKey) localStorage.setItem(KEY_STORAGE, apiKey);
    if (!remember.checked) localStorage.removeItem(KEY_STORAGE);
  }

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: document.querySelector("#content").value,
        themeSlug: themeSelect.value,
        categoryId: categorySelect.value || null,
        mechanic: mechanicSelect.value || null,
        count: Number(document.querySelector("#count").value),
        ageMin: document.querySelector("#ageMin").value || null,
        ageMax: document.querySelector("#ageMax").value || null,
        difficulty: document.querySelector("#difficulty").value || null,
        model: modelInput ? modelInput.value.trim() : "",
        apiKey,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Generation failed");
    renderActivities(payload);
  } catch (error) {
    showError(error.message);
  } finally {
    go.disabled = false;
    go.textContent = "Generate activities";
  }
});

async function boot() {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (saved && apiKeyInput) {
    apiKeyInput.value = saved;
    if (remember) remember.checked = true;
  }
  const response = await fetch("/api/catalog");
  const payload = await response.json();
  if (!response.ok) {
    showError(payload.error || "Could not read the database.");
    return;
  }
  catalog = payload;
  if (payload.model && modelInput) modelInput.value = payload.model;
  const keyInput = document.querySelector("#keyLabel input");
  if (payload.hasServerKey && keyInput) {
    keyInput.placeholder = "Using the key from .env — paste here only to override";
  }
  fillThemes();
  fillCategories();
  fillMechanics();
}

boot().catch((error) => showError(error.message));
