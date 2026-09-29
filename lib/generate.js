const fs = require("fs");
const path = require("path");
const { getCategory, getCategoriesBrief, getTheme, getExampleActivities } = require("./db");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "system-prompt.md");

function loadSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
}

function shrinkSpecs(specs) {
  if (!Array.isArray(specs)) return specs;
  if (JSON.stringify(specs).length <= 6000) return specs;
  return specs.slice(0, 1);
}

function themeBrief(theme) {
  return {
    name: theme.name,
    slug: theme.slug,
    description: theme.description,
    core_idea: theme.core_idea,
    tags: theme.tags,
    visual_summary: typeof theme.visual_summary === "string"
      ? theme.visual_summary.slice(0, 700)
      : theme.visual_summary,
    content_style: theme.content_style,
    content_patterns: theme.content_patterns,
    story_adaptation: theme.story_adaptation,
    concept_style: theme.concept_style,
    usage_rules: theme.usage_rules,
    activity_specs: shrinkSpecs(theme.activity_specs),
  };
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return JSON");
  }
}

const REVIEW_PROMPT = [
  "You are a skeptical checker, not an editor.",
  "The activities you receive are an untrusted draft from another model.",
  "Approval is binary. If mechanic, source canon, puzzle logic, category mapping, or illustrator reconstruction fails, do not polish the draft—replace the broken parts before returning it.",
  "INDEPENDENT SOLVE: Do not approve a puzzle because it sounds plausible. Actually solve it independently. Work every clue yourself and compare your result with answer_or_solution. If you cannot solve it from the written puzzle, or your result disagrees, rebuild it before approval.",
  "VAGUE VISUAL FAILURE: Words such as \"may include\", \"can include\", \"for example\", \"various\", or unspecified visual placements are automatic failures for fixed-answer visual puzzles. Replace them with the exact objects, counts, and placements.",
  "Artwork has not been generated yet.",
  "ONE MECHANIC: A valid activity must implement exactly one coherent mechanic. If instructions + puzzle_prompt describe a different game than the mechanic field, reject and rebuild it—even if the activity itself sounds fun. Do not leave a riddle, an invention task, and a named mechanic stacked on the same activity.",
  "MECHANIC SIMULATION TEST: Ignore the title and explanation. Look only at the actual child actions in instructions + puzzle_prompt. Perform those actions mentally. If those actions do not literally implement the named mechanic, the activity MUST be rebuilt or reassigned to a valid catalog mechanic. Never approve based on thematic similarity. If required_mechanic is set, rebuild so those actions implement that mechanic. Otherwise reassign to another mechanic from the same category and rebuild the actions.",
  "CONTRADICTION TEST: Compare rules, components, puzzle_prompt, and answer_or_solution against each other and against source canon. Any contradiction requires repair before approval.",
  "SOURCE CANON: Do not contradict the supplied source content, and do not add a fact the solution requires if the source does not support it. If it does, replace the broken parts.",
  "PUZZLE LOGIC: For every fixed-answer puzzle, independently evaluate every clue and every candidate possibility. Do not trust the proposed answer. If more than one answer satisfies the rules, or the stated answer does not follow, rebuild the puzzle until one answer follows and the others do not.",
  "CATEGORY MAPPING: category_id, category_name, and mechanic must be an exact triple from puzzle_catalog. category_id is the catalog id of that category, not a copied sample. The answer form must fit that mechanic's output_types. If the name and id disagree, replace both from the category that owns the mechanic.",
  "ILLUSTRATOR RECONSTRUCTION: Because artwork has not been generated, answer-critical counts, positions, statements, and paths must be written in the activity. Reject phrases that assume the artwork will decide those details. Specify both states, positions, counts, and relationships explicitly.",
  "Open-ended activities do not need one fixed answer. For those, still run the mechanic simulation test and the contradiction test, and state a success condition instead of inventing a single answer.",
  "Return each full activity object, not a patch.",
  "Return JSON only, with no markdown:",
  '{"activities":[],"review":[{"title":"","passed":true,"fixes":[]}]}',
  "passed is true only when fixes is empty. A failed check comes back as a replaced activity plus a fix that names the failed check. Use an empty fixes array only after the activity survives the one-mechanic rule, the independent solve, the vague-visual failure check, the mechanic simulation test, the contradiction test, and the other checks.",
].join("\n");

function networkDetail(error) {
  const cause = error && error.cause;
  if (!cause) return "";
  const bits = [cause.code, cause.message];
  if (Array.isArray(cause.errors)) {
    for (const item of cause.errors) bits.push(item.code || item.message);
  }
  return bits.filter((bit) => bit && bit !== error.message).join("; ");
}

function isTransient(error) {
  if (!error) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError") return true;
  const detail = `${error.message} ${networkDetail(error)}`;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR|socket|network/i.test(detail);
}

async function callOpenRouterOnce({ apiKey, model, messages, temperature = 0.7 }) {
  let response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3847",
        "X-Title": "Activity Maker",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages,
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    const detail = networkDetail(error);
    const wrapped = new Error(
      detail ? `OpenRouter connection failed (${detail}).` : "OpenRouter connection failed."
    );
    wrapped.name = error.name === "TimeoutError" || error.name === "AbortError"
      ? "TimeoutError"
      : "TypeError";
    wrapped.cause = error;
    throw wrapped;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && body.error && body.error.message
      ? body.error.message
      : `OpenRouter request failed (${response.status})`;
    throw new Error(message);
  }
  const text = body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : "";
  return parseModelJson(text);
}

async function callOpenRouter(options) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await callOpenRouterOnce(options);
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

function catalogEntries(puzzleCatalog) {
  if (!puzzleCatalog) return [];
  const blocks = puzzleCatalog.use_this_category
    ? [puzzleCatalog.use_this_category]
    : (puzzleCatalog.choose_from_categories || []);
  const entries = [];
  for (const block of blocks) {
    for (const mechanic of block.mechanics || []) {
      if (!mechanic || !mechanic.name) continue;
      entries.push({
        category_id: block.category_id,
        category_name: block.name,
        mechanic: mechanic.name,
      });
    }
  }
  return entries;
}

function lockCategory(activity, puzzleCatalog) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return activity;
  const mechanic = String(activity.mechanic || "").trim();
  const match = catalogEntries(puzzleCatalog).find((entry) => entry.mechanic === mechanic);
  if (!match) return activity;
  return {
    ...activity,
    category_id: match.category_id,
    category_name: match.category_name,
  };
}

function lockCategories(activities, puzzleCatalog) {
  return activities.map((activity) => lockCategory(activity, puzzleCatalog));
}

function applyReview(original, parsed) {
  const repaired = parsed && Array.isArray(parsed.activities) ? parsed.activities : null;
  if (!repaired || repaired.length !== original.length) {
    throw new Error("The review returned a different number of activities.");
  }
  const activities = original.map((item, index) => {
    const next = repaired[index];
    if (!next || typeof next !== "object" || Array.isArray(next)) return item;
    return { ...item, ...next };
  });
  const review = Array.isArray(parsed.review) ? parsed.review : [];
  return { activities, review };
}

async function reviewActivities({ apiKey, model, sourceContent, activities, puzzleCatalog }) {
  const parsed = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: REVIEW_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "These activities are an untrusted draft. Approval is binary. A valid activity must implement exactly one coherent mechanic. If instructions + puzzle_prompt describe a different game than the mechanic field, reject and rebuild it—even if the activity itself sounds fun. Do not approve a puzzle because it sounds plausible. Actually solve it independently. If the stated answer is not the only result of those actions, rebuild it. Words such as \"may include\", \"can include\", \"for example\", \"various\", or unspecified visual placements are automatic failures for fixed-answer visual puzzles. category_id and category_name must be the catalog pair that owns mechanic. Do not copy a sample category id. Run the contradiction test across rules, components, puzzle_prompt, answer_or_solution, and source canon. Any failure requires repair. Do not polish a failed draft. Artwork has not been generated.",
          source_content: sourceContent,
          puzzle_catalog: puzzleCatalog,
          activities,
        }),
      },
    ],
  });
  const checked = applyReview(activities, parsed);
  return {
    activities: lockCategories(checked.activities, puzzleCatalog),
    review: checked.review,
  };
}

async function generateActivities(input) {
  const content = String(input.content || "").trim();
  if (content.length < 20) {
    throw new Error("Paste a bit more content (at least a few sentences).");
  }
  const count = Math.min(5, Math.max(1, Number(input.count) || 3));
  const slug = String(input.themeSlug || "").trim();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Choose a theme.");
  }

  const theme = await getTheme(slug);
  if (!theme) throw new Error("That theme was not found.");

  let category = null;
  let categories = null;
  if (input.categoryId) {
    category = await getCategory(Number(input.categoryId));
    if (!category) throw new Error("That category was not found.");
  } else {
    categories = await getCategoriesBrief();
  }

  let mechanicName = String(input.mechanic || "").trim();
  if (mechanicName && category) {
    const known = category.mechanics.some((item) => item.name === mechanicName);
    if (!known) mechanicName = "";
  } else if (!category) {
    mechanicName = "";
  }

  const examples = await getExampleActivities(category ? category.category_id : null);

  const ageNote = input.ageMin || input.ageMax
    ? `Target ages ${input.ageMin || "?"} to ${input.ageMax || "?"}.`
    : "Choose a sensible age range for the content.";
  const difficultyNote = input.difficulty
    ? `Difficulty: ${input.difficulty}.`
    : "Choose a difficulty of easy, easy-medium, medium, or medium-hard.";

  const chosenMechanic = mechanicName && category
    ? category.mechanics.find((item) => item.name === mechanicName)
    : null;
  const catalogBlock = category
    ? {
        use_this_category: {
          category_id: category.category_id,
          name: category.name,
          description: category.description,
          mechanics: category.mechanics,
        },
        required_mechanic: chosenMechanic
          ? { name: chosenMechanic.name, output_types: chosenMechanic.output_types }
          : null,
      }
    : {
        choose_from_categories: categories,
        required_mechanic: null,
      };

  const messages = [
    {
      role: "system",
      content: loadSystemPrompt(),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: `Create ${count} original activities/puzzles.`,
        source_content: content,
        age: ageNote,
        difficulty: difficultyNote,
        theme: themeBrief(theme),
        puzzle_catalog: catalogBlock,
        construction_patterns_from_library: {
          how_to_use: "Copy the method, never the subject, title, or clues. play_pattern describes how the play works. It is not a catalog mechanic name. Output mechanic must be an exact name from puzzle_catalog, and the answer form must match that mechanic's output_types.",
          examples,
        },
        output_shape: {
          activities: [
            {
              title: "short title",
              category_id: "the catalog category_id that owns mechanic",
              category_name: "the catalog name of that same category",
              mechanic: "exact mechanic name from the catalog",
              subcategory: "short label",
              goal: "what the child is trying to do",
              age_min: 6,
              age_max: 10,
              difficulty: "easy-medium",
              player_count: "1",
              duration_minutes: 15,
              components: "what appears on the page or in the scene",
              materials: "physical materials, or an empty string",
              setup: "how to lay it out",
              instructions: "numbered steps the child follows",
              rules: "constraints that make the puzzle fair",
              puzzle_prompt: "the actual clues, items, or scene the child works with",
              answer_or_solution: "the concrete solution and why it is correct",
              skills: ["skill"],
              story_integration: "how this sits in the theme voice",
              theme_note: "which theme pattern you used, in one sentence",
            },
          ],
        },
      }),
    },
  ];

  const apiKey = input.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Add an OpenRouter API key.");
  }
  const model = String(input.model || process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();

  const parsed = await callOpenRouter({ apiKey, model, messages });
  const drafted = Array.isArray(parsed.activities) ? parsed.activities.slice(0, count) : [];
  if (!drafted.length) {
    throw new Error("The model returned no activities. Try again.");
  }

  let activities = lockCategories(drafted, catalogBlock);
  let review = [];
  let reviewError = "";
  try {
    const checked = await reviewActivities({
      apiKey,
      model,
      sourceContent: content,
      activities,
      puzzleCatalog: catalogBlock,
    });
    activities = checked.activities;
    review = checked.review;
  } catch (error) {
    reviewError = error.name === "TimeoutError"
      ? "The review took too long."
      : error.message;
  }

  return {
    theme: { name: theme.name, slug: theme.slug },
    model,
    activities,
    review,
    ...(reviewError ? { review_error: reviewError } : {}),
  };
}

module.exports = { generateActivities };
