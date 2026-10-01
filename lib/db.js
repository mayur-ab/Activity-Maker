const { Pool } = require("pg");

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

async function read(text, params) {
  const head = text.trim().slice(0, 16).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error("Only read queries are allowed");
  }
  return getPool().query(text, params);
}

function stripImageScrap(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#\s*Image\b/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(?:\s*---\s*)+$/g, "")
    .trim();
}

function clipText(text, max) {
  const value = stripImageScrap(text);
  if (!value) return "";
  return value.length <= max ? value : value.slice(0, max);
}

function compactPlayable(play) {
  if (!play || typeof play !== "object" || Array.isArray(play)) return null;
  const objects = Array.isArray(play.objects) ? play.objects : [];
  return {
    playerAction: clipText(play.playerAction, 320),
    startState: clipText(play.startState, 240),
    endState: clipText(play.endState, 240),
    completionCondition: clipText(play.completionCondition, 320),
    path: play.path || null,
    sequence: play.sequence || null,
    matchingPairs: Array.isArray(play.matchingPairs) ? play.matchingPairs.slice(0, 8) : [],
    answerSlots: Array.isArray(play.answerSlots) ? play.answerSlots : [],
    tokens: Array.isArray(play.tokens) ? play.tokens.slice(0, 12) : [],
    objects: objects.slice(0, 12).map((item) => ({
      id: item && item.id,
      role: item && item.role,
      type: clipText(item && item.type, 120),
      quantity: item && item.quantity,
      requiredForSolution: Boolean(item && item.requiredForSolution),
    })),
    choices: Array.isArray(play.choices) ? play.choices.slice(0, 8).map((item) => ({
      id: item && item.id,
      label: clipText(item && item.label, 120),
      isCorrect: item ? item.isCorrect : null,
    })) : [],
    clues: Array.isArray(play.clues) ? play.clues.slice(0, 8).map((item) => ({
      id: item && item.id,
      clueType: clipText(item && item.clueType, 80),
      pointsTo: item && item.pointsTo,
    })) : [],
  };
}

function compactActivity(spec) {
  if (!spec || typeof spec !== "object") return null;
  const mechanic = spec.mechanic && typeof spec.mechanic === "object"
    ? spec.mechanic
    : { name: clipText(spec.type, 120) };
  return {
    id: spec.id || "",
    name: clipText(spec.name, 160),
    activityType: clipText(spec.activityType || spec.type, 120),
    category: clipText(spec.category, 120),
    subcategory: clipText(spec.subcategory, 120),
    mechanic,
    goal: clipText(spec.goal, 320),
    childOutcome: clipText(spec.childOutcome, 320),
    childFacing: spec.childFacing && typeof spec.childFacing === "object" ? {
      prompt: clipText(spec.childFacing.prompt, 240),
      instruction: clipText(spec.childFacing.instruction, 240),
    } : null,
    playableState: compactPlayable(spec.playableState) || {
      playerAction: "",
      completionCondition: clipText(spec.completionState, 320),
    },
    adaptation: spec.adaptation || null,
    responseArea: spec.responseArea || null,
    solutionShape: spec.solution && typeof spec.solution === "object" ? {
      answerType: clipText(spec.solution.answerType, 80),
      validationRule: clipText(spec.solution.validationRule, 320),
      showOnChildPage: spec.solution.showOnChildPage,
      answerSheetRequired: spec.solution.answerSheetRequired,
      hasCorrectPath: Array.isArray(spec.solution.correctPathNodeIds) && spec.solution.correctPathNodeIds.length > 0,
      hasCorrectChoices: Array.isArray(spec.solution.correctChoiceIds) && spec.solution.correctChoiceIds.length > 0,
    } : null,
    steps: Array.isArray(spec.steps) ? spec.steps.slice(0, 8).map((step) => ({
      id: step && step.id,
      instruction: clipText(step && step.instruction, 220),
      playerAction: clipText(step && step.playerAction, 180),
      visualRequired: Boolean(step && step.visualRequired),
    })) : [],
    activityIntegrity: spec.activityIntegrity || null,
    difficulty: clipText(spec.difficulty, 40),
    ageMin: spec.ageMin == null ? null : spec.ageMin,
    ageMax: spec.ageMax == null ? null : spec.ageMax,
    estimatedMinutes: spec.estimatedMinutes == null ? null : spec.estimatedMinutes,
  };
}

function themeActivity(row) {
  const specs = Array.isArray(row.activity_specs) ? row.activity_specs : [];
  return {
    activity_detection: row.activity_detection && typeof row.activity_detection === "object"
      ? row.activity_detection
      : {},
    activities: specs.slice(0, 3).map(compactActivity).filter(Boolean),
  };
}

function clipMechanics(mechanics) {
  if (!Array.isArray(mechanics)) return [];
  return mechanics.map((item) => ({
    name: item && item.name ? String(item.name) : "",
    blurb: item && item.blurb ? String(item.blurb).slice(0, 280) : "",
    output_types: Array.isArray(item && item.output_types) ? item.output_types : [],
  })).filter((item) => item.name);
}

async function getCatalog() {
  const categories = await read(`
    SELECT category_id, code, name, description, mechanics
    FROM categories
    WHERE active = true
    ORDER BY category_id
  `);
  const themes = await read(`
    SELECT slug, name, description, core_idea, tags, status,
           activity_detection, activity_specs
    FROM theme_analyzer.themes
    WHERE status = 'active'
    ORDER BY name
  `);
  return {
    categories: categories.rows.map((row) => ({
      category_id: row.category_id,
      code: row.code,
      name: row.name,
      description: row.description,
      mechanics: clipMechanics(row.mechanics).map((item) => item.name),
    })),
    themes: themes.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      core_idea: row.core_idea,
      tags: row.tags,
      status: row.status,
      ...themeActivity(row),
    })),
  };
}

async function getCategory(categoryId) {
  const result = await read(
    `
    SELECT category_id, code, name, description, mechanics
    FROM categories
    WHERE category_id = $1
    `,
    [categoryId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    category_id: row.category_id,
    code: row.code,
    name: row.name,
    description: row.description,
    mechanics: clipMechanics(row.mechanics),
  };
}

async function getCategoriesBrief() {
  const result = await read(`
    SELECT category_id, code, name, description, mechanics
    FROM categories
    WHERE active = true
    ORDER BY category_id
  `);
  return result.rows.map((row) => ({
    category_id: row.category_id,
    code: row.code,
    name: row.name,
    description: row.description,
    mechanics: clipMechanics(row.mechanics).map((item) => ({
      name: item.name,
      blurb: item.blurb,
      output_types: item.output_types,
    })),
  }));
}

async function getTheme(slug) {
  const result = await read(
    `
    SELECT name, slug, description, core_idea, tags, visual_summary,
           content_style, content_patterns, story_adaptation, concept_style,
           usage_rules, activity_specs, activity_detection
    FROM theme_analyzer.themes
    WHERE slug = $1
    `,
    [slug]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, ...themeActivity(row) };
}

async function getExampleActivities(categoryId) {
  const result = await read(
    `
    SELECT mechanic, goal, components, instructions,
           answer_or_solution, transformation,
           generation_constraints, variation_hooks
    FROM activities
    WHERE ($1::int IS NULL OR category_id = $1)
    ORDER BY random()
    LIMIT 2
    `,
    [categoryId]
  );
  return result.rows.map((row) => {
    const example = {
      play_pattern: clipText(row.mechanic, 400),
      goal: clipText(row.goal, 400),
      components: clipText(row.components, 500),
      instructions: clipText(row.instructions, 500),
      transformation: clipText(row.transformation, 800),
      generation_constraints: clipText(row.generation_constraints, 800),
      variation_hooks: clipText(row.variation_hooks, 600),
    };
    const answer = clipText(row.answer_or_solution, 400);
    if (answer) example.answer_or_solution = answer;
    return example;
  });
}

module.exports = {
  getCatalog,
  getCategory,
  getCategoriesBrief,
  getTheme,
  getExampleActivities,
};
