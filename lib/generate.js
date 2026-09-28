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

async function callOpenRouter({ apiKey, model, messages }) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3847",
      "X-Title": "Activity Maker",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages,
    }),
    signal: AbortSignal.timeout(120000),
  });
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

  const catalogBlock = category
    ? {
        use_this_category: {
          category_id: category.category_id,
          name: category.name,
          description: category.description,
          mechanics: category.mechanics,
        },
        required_mechanic: mechanicName || null,
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
        format_examples_from_library: examples,
        output_shape: {
          activities: [
            {
              title: "short title",
              category_id: 1,
              category_name: "exact category name",
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
  const activities = Array.isArray(parsed.activities) ? parsed.activities : [];
  if (!activities.length) {
    throw new Error("The model returned no activities. Try again.");
  }

  return {
    theme: { name: theme.name, slug: theme.slug },
    model,
    activities: activities.slice(0, count),
  };
}

module.exports = { generateActivities };
