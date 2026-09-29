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
    SELECT slug, name, description, core_idea, tags, status
    FROM themes
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
    themes: themes.rows,
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
           usage_rules, activity_specs
    FROM themes
    WHERE slug = $1
    `,
    [slug]
  );
  return result.rows[0] || null;
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
