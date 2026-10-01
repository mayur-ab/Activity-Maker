const FAMILIES = [
  {
    id: "route",
    topic: /\b(flows?|flowing|flowed|canal|aqueduct|navigat\w*|travels?|traveled|travelled|journey|route|channel|winds?|winding|maze|reaches?|reached|network)\b/i,
    needles: ["route", "path", "maze", "navigat", "checkpoint", "coordinate", "flow", "canal", "branch", "journey"],
  },
  {
    id: "connection",
    topic: /\b(connect\w*|reach\w*|distribut\w*|link\w*|network|canal|aqueduct)\b/i,
    needles: ["connect", "network", "path", "link", "join", "branch"],
  },
  {
    id: "collection",
    topic: /\b(collect\w*|gather\w*|clues?|tokens?|letters?)\b/i,
    needles: ["collect", "letter", "token", "checkpoint", "clue"],
  },
  {
    id: "match",
    topic: /\b(identical|exact match|look-?alikes?|twins?|pairs?|matching|compare)\b/i,
    needles: ["match", "pair", "identical", "compare", "twin"],
  },
  {
    id: "decode",
    topic: /\b(codes?|decode|cipher|secret message|initials?)\b/i,
    needles: ["decode", "code-breaker", "cipher", "initial", "symbol"],
  },
  {
    id: "sequence",
    topic: /\b(sequence|in order|timeline|first, then)\b/i,
    needles: ["sequence", "order", "timeline", "next item"],
  },
  {
    id: "make",
    topic: /\b(make|creat\w*|invent|build|craft|hang|papier)\b/i,
    needles: ["make", "craft", "build", "create", "invent", "draw"],
  },
  {
    id: "count",
    topic: /\b(how many|count\w*|number of)\b/i,
    needles: ["count", "how many", "tally"],
  },
];

const STOP_WORDS = new Set(`
  the a an and or of to in on for with its it what your where when this that from into
  can be look make makes give gives they them their there these those was were are been
  have has had not but about after before while during other another every each some
  importance challenge landscape functioning ancient today still spread page oops famous
  time which would could should because through over under
`.split(/\s+/).filter(Boolean));

const GENERIC_LEARNING = /reinforces understanding|deepens (their|the) connection|engages children|helps children connect|explores the whimsical|encourages children to engage|learn about the importance/i;

const VAGUE = /\b(various|several clues|the illustrator should|depending on the illustration|one possible answer|may include|can include|uncover keywords|rearrange the keywords|verified from the (illustration|image|artwork))\b/i;

function clip(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || /^null$/i.test(text)) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function parseValue(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || /^null$/i.test(trimmed)) return null;
    const wrapped = (trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"));
    if (!wrapped) return trimmed;
    try {
      return parseValue(JSON.parse(trimmed));
    } catch (_) {
      if (trimmed.startsWith("{") && trimmed.endsWith("}") && !trimmed.includes(":")) {
        const inner = trimmed.slice(1, -1).trim();
        if (!inner) return [];
        return inner.split(",").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean);
      }
      return trimmed;
    }
  }
  if (Array.isArray(value)) return value.map(parseValue);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = parseValue(item);
    return out;
  }
  return value;
}

function textOrNull(value) {
  const parsed = parseValue(value);
  if (parsed == null) return null;
  if (typeof parsed === "string") {
    const text = parsed.trim();
    return text && !/^null$/i.test(text) ? text : null;
  }
  return parsed;
}

function normText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function omitEmpty(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;
    if (value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

function contentWords(text) {
  const words = String(text || "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
}

function topicNeedles(topic) {
  return contentWords(topic).filter((word) => word.length >= 5).slice(0, 24);
}

function scoreAgainst(text, needles) {
  const hay = String(text || "").toLowerCase();
  let score = 0;
  const seen = new Set();
  for (const needle of needles) {
    const key = String(needle || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (hay.includes(key)) score += key.length >= 6 ? 3 : 2;
  }
  return score;
}

function bestFamily(text) {
  let winner = "other";
  let best = 0;
  for (const family of FAMILIES) {
    const score = scoreAgainst(text, family.needles);
    if (score > best) {
      best = score;
      winner = family.id;
    }
  }
  return winner;
}

function activeFamilies(topic) {
  const matched = FAMILIES.filter((family) => family.topic.test(String(topic || "")));
  const ids = new Set(matched.map((family) => family.id));
  if (ids.has("route") || ids.has("connection")) {
    ids.add("route");
    ids.add("connection");
    ids.add("collection");
  }
  return FAMILIES.filter((family) => ids.has(family.id));
}

function takeDiverse(ranked, limit, perFamily) {
  const picked = [];
  const counts = {};
  const consider = (requireScore) => {
    for (const item of ranked) {
      if (picked.includes(item)) continue;
      if (requireScore && item.score <= 0) continue;
      const count = counts[item.family] || 0;
      if (count >= perFamily) continue;
      picked.push(item);
      counts[item.family] = count + 1;
      if (picked.length >= limit) return;
    }
  };
  consider(true);
  if (picked.length < limit) consider(false);
  if (picked.length < limit) {
    for (const item of ranked) {
      if (picked.includes(item)) continue;
      picked.push(item);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

function activityHaystack(row) {
  const skills = Array.isArray(row.skills) ? row.skills.join(" ") : textOrNull(row.skills) || "";
  return [
    row.title, row.mechanic, row.goal, row.transformation, row.variation_hooks,
    row.generation_constraints, skills,
  ].filter(Boolean).join("\n");
}

function mechanicLabel(spec) {
  if (!spec) return "";
  if (spec.mechanic && typeof spec.mechanic === "object") {
    return spec.mechanic.name || spec.mechanic.mechanicSummary || "";
  }
  if (typeof spec.mechanic === "string") return spec.mechanic;
  return spec.activityType || spec.type || "";
}

function specBlob(spec) {
  const play = spec && spec.playableState;
  return [
    spec && spec.name,
    spec && spec.category,
    mechanicLabel(spec),
    play && play.playerAction,
    JSON.stringify((spec && spec.adaptation && spec.adaptation.preserve) || ""),
    JSON.stringify((spec && spec.adaptation && spec.adaptation.adaptableVariables) || ""),
  ].filter(Boolean).join(" ");
}

function themeHaystack(row) {
  const specs = Array.isArray(row.activity_specs) ? row.activity_specs : [];
  const tags = Array.isArray(row.tags) ? row.tags.join(" ") : "";
  return [
    row.name, row.core_idea, row.description, tags,
    specs.map(specBlob).join("\n"),
    row.content_patterns ? JSON.stringify(row.content_patterns) : "",
    row.story_adaptation ? JSON.stringify(row.story_adaptation) : "",
  ].filter(Boolean).join("\n");
}

function statusAdjust(status) {
  const text = String(status || "").toLowerCase();
  if (/support|embed|aside|optional/.test(text)) return -1;
  if (/primary|explicit|standalone|core/.test(text)) return 1;
  return 0;
}

function exactPairText(text) {
  return /exact|identical|pair matching|exact match/i.test(String(text || ""));
}

function activitySelectionBrief(row) {
  return omitEmpty({
    activity_id: row.activity_id,
    title: row.title,
    category_id: row.category_id,
    subcategory: textOrNull(row.subcategory),
    printed_play_status: row.printed_play_status || null,
    mechanic: clip(row.mechanic, 420),
    goal: clip(row.goal, 320),
    transformation: clip(row.transformation, 520),
    generation_constraints: clip(row.generation_constraints, 420),
    variation_hooks: clip(row.variation_hooks, 420),
    skills: Array.isArray(row.skills) ? row.skills.slice(0, 6) : [],
  });
}

function activityConstruction(row) {
  const rules = textOrNull(row.rules);
  const validation = textOrNull(row.validation_method);
  const qa = textOrNull(row.qa_checks);
  const hooks = textOrNull(row.variation_hooks);
  const applications = textOrNull(row.applications);
  const brief = {
    activity_id: row.activity_id,
    title: row.title,
    category_id: row.category_id,
    subcategory: textOrNull(row.subcategory),
    printed_play_status: row.printed_play_status || null,
    mechanic: textOrNull(row.mechanic),
    goal: textOrNull(row.goal),
    age_min: row.age_min == null ? null : row.age_min,
    age_max: row.age_max == null ? null : row.age_max,
    difficulty: textOrNull(row.difficulty),
    skills: Array.isArray(row.skills) ? row.skills : [],
    components: clip(row.components, 700),
    setup: clip(row.setup, 500),
    instructions: clip(row.instructions, 700),
    rules: typeof rules === "string" ? rules : null,
    transformation: textOrNull(row.transformation),
    generation_constraints: textOrNull(row.generation_constraints),
    variation_hooks: typeof hooks === "string" ? hooks : null,
    source_example_answer: clip(row.answer_or_solution, 400),
    source_example_note: "This answer belongs to the library activity. It is not the answer of the new activity.",
  };
  if (typeof validation === "string" && normText(validation) !== normText(rules)) {
    brief.validation_method = validation;
  }
  if (typeof qa === "string" && normText(qa) !== normText(rules) && normText(qa) !== normText(validation)) {
    brief.qa_checks = qa;
  }
  if (typeof applications === "string" && normText(applications) !== normText(hooks)) {
    brief.applications = applications;
  }
  const materials = textOrNull(row.materials);
  if (materials) brief.materials = materials;
  const players = textOrNull(row.player_count);
  if (players) brief.player_count = players;
  return omitEmpty(brief);
}

function listOf(value, max) {
  if (!Array.isArray(value)) return value == null ? null : value;
  return value.slice(0, max);
}

function specGaps(spec) {
  const gaps = [];
  if (!spec || typeof spec !== "object") {
    gaps.push("No activity specification. Construct the playable state.");
    return gaps;
  }
  const legacy = !spec.activityType && (spec.type || spec.completionState);
  if (legacy) {
    gaps.push("Legacy specification has no modern playable state. Construct the objects, the steps, and the success condition.");
  }
  const play = spec.playableState || {};
  const objects = Array.isArray(play.objects) ? play.objects : [];
  const pairs = Array.isArray(play.matchingPairs) ? play.matchingPairs : [];
  const tokens = Array.isArray(play.tokens) ? play.tokens : [];
  const path = play.path && typeof play.path === "object" ? play.path : null;
  const integrity = spec.activityIntegrity || {};
  if (integrity.solutionResolvable === false) {
    gaps.push("The stored solution is not resolvable. Build a new solution and do not treat that flag as proof.");
  }
  if (Array.isArray(integrity.issues)) {
    for (const issue of integrity.issues) {
      if (issue) gaps.push(`Stored gap: ${issue}`);
    }
  }
  if (path && Array.isArray(path.nodeIds) && path.nodeIds.length === 0) {
    gaps.push("Path nodeIds are empty. Name every node, the correct route, and each dead end.");
  }
  const collectText = [
    play.playerAction,
    play.completionCondition,
    mechanicLabel(spec),
    JSON.stringify((spec.adaptation && spec.adaptation.preserve) || ""),
  ].join(" ");
  if (!tokens.length && /letter|token|collect/i.test(collectText)) {
    gaps.push("Tokens are empty. Name each collectible and the order in which the correct route records it.");
  }
  if (objects.length === 1 && Number(objects[0] && objects[0].quantity) > 1 && !pairs.length) {
    gaps.push("One aggregate object stands in for many, and matchingPairs is empty. Name each object and each pair.");
  }
  if (/various|etc\./i.test(JSON.stringify(objects))) {
    gaps.push("Source objects use vague labels. Replace them with named items.");
  }
  const slots = Array.isArray(play.answerSlots) ? play.answerSlots : [];
  for (const slot of slots) {
    if (slot && slot.slotCount) {
      gaps.push(`The source answer has ${slot.slotCount} slots. Set a new slot count that matches the new answer.`);
      break;
    }
  }
  if (!spec.solution || (typeof spec.solution === "object" && !spec.solution.answer && !(spec.solution.correctPathNodeIds || []).length)) {
    if (!legacy) gaps.push("The source has no answer. Construct a fresh answer and the evidence that proves it.");
  }
  return [...new Set(gaps)];
}

function normalizeSpec(spec, theme) {
  if (!spec || typeof spec !== "object") return null;
  const parsed = parseValue(spec);
  const legacy = !parsed.activityType && (parsed.type || parsed.completionState);
  const solution = parsed.solution && typeof parsed.solution === "object" ? parsed.solution : {};
  return omitEmpty({
    theme_id: theme && theme.id ? String(theme.id) : null,
    theme_slug: theme && theme.slug,
    spec_id: parsed.id || null,
    schema: legacy ? "legacy" : "rich",
    category_note: "spec.category is free text on the theme. It is not categories.category_id.",
    name: clip(parsed.name, 160),
    category: clip(parsed.category, 120),
    subcategory: clip(parsed.subcategory, 120),
    activityType: clip(parsed.activityType || parsed.type, 120),
    mechanic: parsed.mechanic || null,
    goal: clip(parsed.goal, 400),
    designerIntent: clip(parsed.designerIntent, 320),
    childOutcome: clip(parsed.childOutcome, 320),
    rules: listOf(parsed.rules, 8),
    setup: clip(parsed.setup, 400),
    steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 8).map((step) => ({
      id: step && (step.id || step.step),
      instruction: clip(step && (step.instruction || step.text), 240),
      playerAction: clip(step && step.playerAction, 180),
    })) : [],
    adaptation: parsed.adaptation || null,
    playableState: parsed.playableState || (legacy ? {
      completionCondition: textOrNull(parsed.completionState),
    } : null),
    requiredArtwork: parsed.requiredArtwork || null,
    solution_shape: omitEmpty({
      answerType: clip(solution.answerType, 80),
      validationRule: clip(solution.validationRule, 320),
      hasAnswer: Boolean(solution.answer),
      hasCorrectPath: Array.isArray(solution.correctPathNodeIds) && solution.correctPathNodeIds.length > 0,
    }),
    childFacing: parsed.childFacing && typeof parsed.childFacing === "object" ? {
      prompt: clip(parsed.childFacing.prompt, 240),
      instruction: clip(parsed.childFacing.instruction, 240),
    } : null,
    responseArea: parsed.responseArea || null,
    activityIntegrity: parsed.activityIntegrity || null,
    known_gaps: specGaps(parsed),
    ageMin: parsed.ageMin == null ? null : parsed.ageMin,
    ageMax: parsed.ageMax == null ? null : parsed.ageMax,
    difficulty: clip(parsed.difficulty, 40),
    estimatedMinutes: parsed.estimatedMinutes == null ? null : parsed.estimatedMinutes,
    materials: parsed.materials || null,
    adultHelp: clip(parsed.adultHelp, 200),
    safetyNotes: clip(parsed.safetyNotes, 200),
  });
}

function usageCompact(rules) {
  if (!rules || typeof rules !== "object") return null;
  return omitEmpty({
    preserve: listOf(rules.preserve, 8),
    avoid: listOf(rules.avoid, 8),
    flexible: listOf(rules.flexible, 8),
  });
}

function themeSelectionBrief(row) {
  const parsed = parseValue(row);
  const specs = Array.isArray(parsed.activity_specs) ? parsed.activity_specs : [];
  const summaries = specs.slice(0, 3).map((spec) => ({
    spec_id: spec.id || null,
    name: clip(spec.name, 120),
    category: clip(spec.category || spec.type, 80),
    mechanic: clip(mechanicLabel(spec), 160),
    preserve: spec.adaptation && spec.adaptation.preserve ? listOf(spec.adaptation.preserve, 6) : null,
    known_gaps: specGaps(spec).slice(0, 4),
  }));
  const blob = specs.map(specBlob).join(" ");
  return omitEmpty({
    id: parsed.id ? String(parsed.id) : null,
    slug: parsed.slug,
    name: parsed.name,
    core_idea: clip(parsed.core_idea, 420),
    concept_style: parsed.concept_style || null,
    story_adaptation: parsed.story_adaptation || null,
    usage_rules: usageCompact(parsed.usage_rules),
    activity_summaries: summaries,
    exact_pairs: exactPairText(blob),
    analysis_version: parsed.analysis_version == null ? null : parsed.analysis_version,
  });
}

function rankActivities(rows, topic, options = {}) {
  const families = activeFamilies(topic);
  const needles = families.flatMap((family) => family.needles);
  const words = topicNeedles(topic);
  const allowRoute = options.allowRoute !== false;
  const categoryId = options.categoryId == null ? null : Number(options.categoryId);
  const mechanicWords = contentWords(options.mechanicName || "");
  return rows.map((row) => {
    const text = activityHaystack(row);
    let score = scoreAgainst(text, needles);
    score += Math.min(6, scoreAgainst(text, words));
    const family = bestFamily(text);
    if (!allowRoute && family === "route") score -= 6;
    score += statusAdjust(row.printed_play_status);
    if (categoryId != null && Number(row.category_id) === categoryId) score += 4;
    if (mechanicWords.length) {
      const overlap = contentWords(row.mechanic).filter((word) => mechanicWords.includes(word)).length;
      score += overlap * 2;
    }
    return { row, score, family, brief: activitySelectionBrief(row) };
  }).sort((left, right) => right.score - left.score || String(left.row.title).localeCompare(String(right.row.title)));
}

function shortlistActivities(rows, topic, options = {}) {
  const ranked = rankActivities(rows, topic, options);
  return takeDiverse(ranked, options.limit || 8, options.perFamily || 3);
}

function rankThemes(rows, topic, options = {}) {
  const families = activeFamilies(topic);
  const needles = families.flatMap((family) => family.needles);
  const words = topicNeedles(topic);
  const allowRoute = options.allowRoute !== false;
  const allowPairs = Boolean(options.allowPairs);
  return rows.map((row) => {
    const text = themeHaystack(row);
    let score = scoreAgainst(text, needles);
    score += Math.min(6, scoreAgainst(text, words));
    const family = bestFamily(text);
    if (!allowRoute && family === "route") score -= 6;
    if (!allowPairs && exactPairText(text)) score -= 8;
    return { row, score, family, brief: themeSelectionBrief(row) };
  }).sort((left, right) => right.score - left.score || String(left.row.name).localeCompare(String(right.row.name)));
}

function shortlistThemes(rows, topic, options = {}) {
  const ranked = rankThemes(rows, topic, options);
  return takeDiverse(ranked, options.limit || 6, options.perFamily || 2);
}

function pageSummary(blueprint) {
  if (!blueprint || typeof blueprint !== "object") return null;
  const regions = Array.isArray(blueprint.regions) ? blueprint.regions.slice(0, 12).map((region) => omitEmpty({
    id: region && region.id,
    role: region && (region.role || region.type || region.name),
    label: region && (region.label || region.title),
  })) : [];
  return omitEmpty({
    pageType: blueprint.pageType || null,
    primaryFocus: blueprint.primaryFocus || null,
    repeatablePageFormula: blueprint.repeatablePageFormula || null,
    instructionPresentation: blueprint.instructionPresentation || null,
    contentFlow: blueprint.contentFlow || null,
    regions,
  });
}

function linkedIds(value, found = []) {
  if (typeof value === "string" || typeof value === "number") found.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => linkedIds(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => linkedIds(item, found));
  return found;
}

function linkedBlocks(spec, blocks) {
  const ids = new Set(linkedIds(spec && spec.blockLinkage));
  const list = Array.isArray(blocks) ? blocks : (blocks && typeof blocks === "object" ? Object.values(blocks) : []);
  if (!ids.size || !list.length) return [];
  return list.filter((block) => block && ids.has(String(block.id))).slice(0, 6).map((block) => omitEmpty({
    id: block.id,
    role: block.role || block.type || null,
    text: clip(block.text || block.content || block.body || block.copy, 300),
  }));
}

function chainNote(blurb) {
  if (/\b(prior|previous|earned|another puzzle|prerequisite)\b/i.test(String(blurb || ""))) {
    return "This mechanic assumes an earlier puzzle. Put every required input on this page.";
  }
  return null;
}

function replaceList(spec, activities) {
  const replace = [];
  const adaptation = spec && spec.adaptation;
  if (adaptation && Array.isArray(adaptation.replace)) replace.push(...adaptation.replace);
  for (const activity of activities) {
    if (activity && activity.title) replace.push(`library title: ${activity.title}`);
    if (activity && activity.source_example_answer) replace.push("library answer and its numbers");
  }
  return [...new Set(replace)];
}

function buildGenerationPayload({
  topic,
  age,
  difficulty,
  analysis,
  selection,
  category,
  mechanic,
  theme,
  activityRows,
  specId,
}) {
  const parsedTheme = parseValue(theme);
  const specs = Array.isArray(parsedTheme.activity_specs) ? parsedTheme.activity_specs : [];
  const chosenSpec = specs.find((spec) => spec && spec.id === specId) || specs[0] || null;
  const normalized = normalizeSpec(chosenSpec, parsedTheme);
  const references = (activityRows || []).slice(0, 2).map(activityConstruction);
  const gaps = normalized && normalized.known_gaps ? normalized.known_gaps : ["Construct a complete playable state for the new puzzle."];
  const illustration = parsedTheme.illustration_system || {};
  const format = /\bspread\b/i.test(topic) ? "printed spread" : "printed page";
  return {
    task: "Author one playable activity. Use the construction brief. Preserve the topic facts, the locked mechanic, and the theme's voice. Replace the source subjects, names, numbers, and answers. Construct every missing puzzle detail before you write the child-facing copy.",
    request: {
      topic,
      age,
      difficulty,
      format,
      activity_count: 1,
      materials: "Printed page. Looking, tracing, marking, and writing are available. Do not require animation, dragging, or unlabeled physical props.",
    },
    topic_facts: {
      source: "The topic paragraph is the only source of facts.",
      paragraph: topic,
    },
    selected_mechanic: omitEmpty({
      category_id: category && category.category_id,
      category_name: category && category.name,
      category_description: clip(category && category.description, 400),
      name: mechanic && mechanic.name,
      blurb: mechanic && mechanic.blurb,
      output_types: mechanic && mechanic.output_types,
      section: mechanic && mechanic.section,
      standalone_note: chainNote(mechanic && mechanic.blurb),
      why: selection && selection.why,
    }),
    activity_references: references,
    theme_concept: omitEmpty({
      id: parsedTheme.id ? String(parsedTheme.id) : null,
      slug: parsedTheme.slug,
      name: parsedTheme.name,
      analysis_version: parsedTheme.analysis_version,
      core_idea: parsedTheme.core_idea,
      concept_style: parsedTheme.concept_style,
      story_adaptation: parsedTheme.story_adaptation,
      content_patterns: parsedTheme.content_patterns,
      content_style: parsedTheme.content_style,
    }),
    source_activity_reference: normalized ? omitEmpty({
      ...normalized,
      linked_blocks: linkedBlocks(chosenSpec, parsedTheme.content_blocks),
      source_content_reference: clip(
        typeof parsedTheme.source_content === "string"
          ? parsedTheme.source_content
          : JSON.stringify(parsedTheme.source_content || ""),
        700
      ),
      reference_note: "Copy the interaction and the adaptation rules. Source content is reference only. Do not copy its subjects, tokens, counts, or answer.",
    }) : {
      theme_id: parsedTheme.id ? String(parsedTheme.id) : null,
      theme_slug: parsedTheme.slug,
      known_gaps: gaps,
      reference_note: "This theme has no activity specification. Construct the playable state from the activity references.",
    },
    presentation_requirements: omitEmpty({
      usage_rules: usageCompact(parsedTheme.usage_rules),
      page: pageSummary(parsedTheme.page_blueprint),
      response_area: chosenSpec && chosenSpec.responseArea,
      illustration_subject_rules: illustration.subjectAdaptationRules || null,
      illustration_consistency: illustration.consistencyRules || null,
      visual_summary: clip(parsedTheme.visual_summary, 280),
      layout_note: clip(parsedTheme.layout_style && (parsedTheme.layout_style.summary || parsedTheme.layout_style.description), 240),
    }),
    generation_requirements: {
      facts_to_preserve: ["Only claims supported by the topic paragraph."],
      mechanic_rules_to_preserve: [
        mechanic && mechanic.blurb,
        references[0] && references[0].transformation,
        normalized && normalized.adaptation && normalized.adaptation.preserve,
      ].filter(Boolean),
      theme_characteristics_to_preserve: [
        parsedTheme.core_idea,
        parsedTheme.usage_rules && parsedTheme.usage_rules.preserve,
      ].filter(Boolean),
      source_subjects_to_replace: replaceList(normalized, references),
      missing_details_to_construct: gaps,
      operation: (mechanic && (mechanic.blurb || mechanic.name)) || "the locked mechanic",
      one_operation: "Implement that operation only. Spot-the-difference is two panels: each difference sits on an object whose name is a word, and those words produce the answer. An odd-one-out row is not two panels. An acrostic is an ordered word list whose first letters spell the answer. Do not swap in the theme's old hunt, and do not add doodling.",
      playable_state: "Name every answer-critical object, stop, pair, letter, clue, or choice. A count without the items is not a puzzle.",
      fact_connection: "Say which child action reveals which fact from the topic, and which named items prove it. The child must not be able to answer by remembering the fact.",
      artwork: "Write artwork_instructions from the finished puzzle. Repeat the exact counts, labels, relationships, and the answer space.",
    },
    analysis,
    output_shape: outputShape(),
  };
}

function outputShape() {
  return {
    activity: {
      title: "short title that does not reveal the fact",
      category_id: "the locked category_id",
      category_name: "the locked category name",
      mechanic: "the locked mechanic name",
      subcategory: "short label",
      goal: "what the child is trying to do",
      age_min: 6,
      age_max: 10,
      difficulty: "easy-medium",
      player_count: "1",
      duration_minutes: 15,
      components: "what appears on the page, including every answer-critical token",
      materials: "physical materials, or an empty string",
      setup: "how to lay it out",
      instructions: "numbered steps the child follows",
      rules: "constraints that make the puzzle fair",
      puzzle_prompt: "the playable scene, ending with the fact question and a blank",
      answer_or_solution: "the fact first, then why the play produces it",
      solution: {
        correct_route: "every correct stop, or an empty string when this is not a route",
        dead_ends: "each dead end and why it fails, or an empty string",
        collected_letters: "letters in exact order, or an empty string when letters are not collected",
        words: ["each word in order, when the mechanic takes first letters"],
        pairs: [{ object: "the shared subject", trait: "the visible detail that makes the twins identical" }],
        differences: ["each difference and what it reveals, when the mechanic is spot-the-difference"],
        final_answer: "what the blank must contain",
      },
      playable_state: {
        items: [{ name: "the specific item", role: "stop, dead-end, letter, pair, clue, decoy, or object", detail: "the answer-critical fact about it" }],
      },
      fact_connection: {
        child_action: "the action that reveals the fact",
        fact: "the topic fact that action reveals",
        evidence: "the named items that prove it",
      },
      artwork_instructions: "exact objects, counts, relationships, labels, and the blank answer space",
      learning_through_play: ["the child action and the fact it reveals"],
      skills: ["skill"],
      story_integration: "how the topic action and the mechanic are the same play",
      theme_note: "which theme pattern you used, in one sentence",
    },
  };
}

function childText(activity) {
  return ["title", "instructions", "rules", "setup", "components", "puzzle_prompt"]
    .map((key) => activity && activity[key])
    .filter(Boolean)
    .join("\n");
}

function itemLabel(item) {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number") return String(item).trim();
  return String(
    item.name || item.label || item.object || item.letter || item.stop || item.text || item.content || item.clue || ""
  ).trim();
}

function vagueLabel(label) {
  return !label || /^(various|several|some|objects?|items?|clues?|letters?|keywords?)$/i.test(label) || /various|etc\.|and so on/i.test(label);
}

function stateItems(state) {
  if (!state || typeof state !== "object") return [];
  if (Array.isArray(state.items) && state.items.length) return state.items;
  const items = [];
  for (const key of ["pairs", "stops", "letters", "clues", "objects", "differences", "choices"]) {
    if (Array.isArray(state[key])) items.push(...state[key]);
  }
  return items;
}

function lettersOf(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z]/g, "");
}

const ABSTRACT_ITEMS = /^(cool|deal|about|special|unique|importance|significance|general|nice|good|great|fun|awesome|important)$/i;

function orderedWords(activity) {
  const solution = activity && activity.solution && typeof activity.solution === "object" ? activity.solution : {};
  const listed = Array.isArray(solution.words) ? solution.words : [];
  const fromState = stateItems(activity && activity.playable_state).map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return item.word || item.name || item.label || "";
  });
  const seen = new Set();
  const words = [];
  for (const value of [...listed, ...fromState]) {
    const word = String(value || "").trim();
    if (!/^[A-Za-z][A-Za-z' -]{1,40}$/.test(word) || word.split(/\s+/).length > 3) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

function sameLetterBag(left, right) {
  const sort = (value) => value.split("").sort().join("");
  return sort(left) === sort(right);
}

function claimedCount(text, word) {
  const match = String(text || "").match(new RegExp(`\\b(\\d+)\\s+${word}\\b`, "i"));
  return match ? Number(match[1]) : null;
}

function isOpenActivity(activity, mechanic) {
  return /\b(open-ended|craft|draw|invent|imaginative|no single correct|no wrong)\b/i.test(
    `${mechanic} ${activity && activity.goal} ${activity && activity.answer_or_solution}`
  );
}

function isRoute(mechanic) {
  return /\b(path|maze|route|trace|labyrinth)\b/i.test(String(mechanic || ""));
}

function methodTags(text) {
  const tags = new Set();
  const value = String(text || "");
  if (/acrostic|first letters?|initial letters?/i.test(value)) tags.add("acrostic");
  if (/lookup table|code fragment|concatenate|password/i.test(value)) tags.add("lookup");
  if (/anagram|rearrang|unscrambl/i.test(value)) tags.add("anagram");
  if (/decode|cipher|code-breaker|symbol/i.test(value)) tags.add("decode");
  if (/\b(maze|route|path|trace|navigat)/i.test(value)) tags.add("route");
  if (/identical|\bpairs?\b|matching sock|exact match/i.test(value)) tags.add("match");
  if (/\bcount|how many/i.test(value)) tags.add("count");
  if (/two panels|spot-the-difference|altered copy|reference artwork/i.test(value)) tags.add("panels");
  if (/nearly identical|odd-one-out|the single one|one plate that differs/i.test(value)) tags.add("odd-one");
  return tags;
}

const EXCLUSIVE_METHODS = ["panels", "odd-one", "acrostic", "lookup", "route", "match"];

function methodsCompatible(mechanicText, activityText) {
  const mechanicTags = methodTags(mechanicText);
  const activityTags = methodTags(activityText);
  const exclusive = [...mechanicTags].filter((tag) => EXCLUSIVE_METHODS.includes(tag));
  if (exclusive.length) return exclusive.some((tag) => activityTags.has(tag));
  if (mechanicTags.size && activityTags.size) {
    for (const tag of mechanicTags) {
      if (activityTags.has(tag)) return true;
    }
    return false;
  }
  const words = contentWords(mechanicText).filter((word) => word.length > 4);
  const hay = String(activityText || "").toLowerCase();
  return words.filter((word) => hay.includes(word)).length >= 1;
}

function activityMethodText(row) {
  return [row && row.title, row && row.mechanic, row && row.transformation, row && row.goal].filter(Boolean).join("\n");
}

function pickReference(ranked, mechanicText, activityId) {
  const compatible = (ranked || []).filter((item) => methodsCompatible(mechanicText, activityMethodText(item.row)));
  const wanted = String(activityId || "").trim();
  const primary = compatible.find((item) => item.row.activity_id === wanted) || compatible[0] || null;
  if (!primary) return [];
  const extra = compatible.find((item) => item.row.activity_id !== primary.row.activity_id);
  return extra ? [primary.row, extra.row] : [primary.row];
}

function themeCanShow(theme, mechanicText) {
  const text = `${theme && theme.name} ${theme && theme.slug} ${theme && theme.core_idea}`;
  const drawing = /\b(doodle|sketch|draw|craft|notebook)\b/i.test(text);
  const closed = /\b(acrostic|anagram|cipher|code|maze|crossword|harvest|grid|lookup|password)\b/i.test(String(mechanicText || ""));
  if (drawing && closed && !/\b(draw|doodle|sketch)\b/i.test(String(mechanicText || ""))) return false;
  return true;
}

function isAcrostic(text) {
  return /acrostic|first letters?/i.test(String(text || ""));
}

function differenceNames(activity) {
  const listed = activity && activity.solution && Array.isArray(activity.solution.differences)
    ? activity.solution.differences
    : [];
  return listed.map((item) => {
    const text = typeof item === "string" ? item : itemLabel(item);
    const name = String(text).split(/\s+[-–:]\s+/)[0].trim().split(/\s+/)[0];
    return /^[A-Za-z]/.test(name) ? name : "";
  }).filter((name) => name.length > 1);
}

function factConnectionProblems(activity, topic) {
  const link = activity && activity.fact_connection;
  const problems = [];
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    problems.push("fact_connection must name the child action, the fact from the topic, and the evidence on the page.");
    return problems;
  }
  const action = String(link.child_action || "").trim();
  const fact = String(link.fact || "").trim();
  const evidence = String(link.evidence || "").trim();
  if (action.length < 12) problems.push("fact_connection.child_action must name what the child does.");
  if (fact.length < 8) problems.push("fact_connection.fact must be a claim supported by the topic.");
  if (evidence.length < 12) problems.push("fact_connection.evidence must name the page items that prove the fact.");
  const combined = `${action} ${fact} ${evidence} ${activity.story_integration || ""} ${(activity.learning_through_play || []).join(" ")}`;
  if (GENERIC_LEARNING.test(combined)) {
    problems.push("Replace generic learning claims with the child action and the fact it reveals.");
  }
  const topicWords = contentWords(topic);
  const factWords = contentWords(fact);
  const shares = factWords.some((word) => topicWords.some((topicWord) => {
    if (word === topicWord) return true;
    return word.length >= 5 && topicWord.length >= 5 && (word.startsWith(topicWord) || topicWord.startsWith(word));
  }));
  if (factWords.length && !shares) {
    problems.push("fact_connection.fact must use a fact from the topic paragraph.");
  }
  return problems;
}

function constructionProblems(activity, context = {}) {
  const mechanic = context.mechanic || (activity && activity.mechanic) || "";
  const topic = context.topic || "";
  const problems = [];
  if (!activity || typeof activity !== "object") return ["The activity is missing."];
  const facing = `${childText(activity)}\n${activity.answer_or_solution || ""}\n${activity.artwork_instructions || ""}`;
  if (VAGUE.test(facing)) {
    problems.push("Replace vague puzzle language with the named items, counts, and placements.");
  }
  problems.push(...factConnectionProblems(activity, topic));

  const open = isOpenActivity(activity, mechanic);
  const items = stateItems(activity.playable_state);
  const named = items.map(itemLabel).filter((label) => !vagueLabel(label));
  if (!open && named.length < 2) {
    problems.push("playable_state.items must name each answer-critical object, stop, pair, letter, or clue.");
  }
  if (open && named.length < 1 && !activity.answer_or_solution) {
    problems.push("An open activity needs a clear invitation, the materials or space, and a completion condition.");
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const quantity = Number(item.quantity || item.count || 0);
    if (quantity > 1) {
      problems.push(`"${itemLabel(item) || "An object"}" is one entry with quantity ${quantity}. Name each one.`);
      break;
    }
  }

  const solution = activity.solution && typeof activity.solution === "object" ? activity.solution : {};
  const instructions = `${activity.instructions || ""}\n${activity.puzzle_prompt || ""}`;
  if (isRoute(mechanic)) {
    const stops = String(solution.correct_route || "").split(/\n|→|->|,|;|\bthen\b/i).map((part) => part.trim()).filter((part) => part.length > 1);
    if (stops.length < 2) problems.push("A route needs every correct stop in solution.correct_route.");
    const deadEnds = String(solution.dead_ends || "").trim();
    const deadInState = /\bdead\b/i.test(JSON.stringify(activity.playable_state || {}));
    if (deadEnds.length < 8 && !deadInState) problems.push("Name each dead end and why it fails.");
  }
  const mechanicText = `${mechanic} ${context.mechanicText || ""}`;
  const answerLetters = lettersOf(solution.final_answer);
  const collected = lettersOf(solution.collected_letters);
  const letterTask = /collect\w*\s+letters|letter on each|letters along|first letter|acrostic/i.test(`${instructions}\n${mechanicText}`);
  if (letterTask && !collected && orderedWords(activity).length < 3) {
    problems.push("The instructions take letters, but the word list and solution.collected_letters are missing.");
  }
  if (collected && answerLetters) {
    const anagram = /rearrang|anagram|unscrambl/i.test(`${instructions}\n${mechanicText}`) && !isAcrostic(mechanicText);
    if (anagram && !sameLetterBag(collected, answerLetters)) {
      problems.push(`The letters ${collected} cannot be rearranged into ${answerLetters}.`);
    } else if (!anagram && collected !== answerLetters) {
      problems.push(`collected_letters "${collected}" must spell final_answer "${answerLetters}" in order.`);
    }
  }
  if (/spot-the-difference|two panels/i.test(mechanicText)) {
    const scene = `${instructions}\n${activity.artwork_instructions || ""}\n${activity.setup || ""}`;
    const twoPanels = /\b(two|2|both)\b.{0,30}\b(panels?|pictures?|scenes?|copies)\b|\baltered copy\b|\breference (picture|artwork)\b/i.test(scene);
    if (!twoPanels) {
      problems.push("Spot-the-difference needs two panels. A single scene of hidden or out-of-place objects is a different mechanic.");
    }
    const names = differenceNames(activity);
    if (names.length < 2) {
      problems.push("Name every difference and the object it changes. Each object name is a word, and those words produce the answer.");
    } else if (answerLetters) {
      const initials = names.map((name) => name[0].toUpperCase()).join("");
      const joined = lettersOf(names.join(" "));
      const spelled = initials === answerLetters || joined === answerLetters || names.some((name) => lettersOf(name) === answerLetters);
      if (!spelled) {
        problems.push(`The object names spell "${initials}", not "${answerLetters}". Order objects whose names produce the answer.`);
      }
    }
  }
  if (/\bat least\b/i.test(instructions) && !open) {
    problems.push("Use an exact count. 'At least' leaves the puzzle unfinished.");
  }
  if (/what is the capital|what was the capital|which empire|what empire was/i.test(activity.puzzle_prompt || "")) {
    problems.push("The question asks the child to recall the fact. Ask for the word the mechanic just produced.");
  }
  const factWords = contentWords(context.analysis && context.analysis.fact).filter((word) => word.length >= 6);
  if (factWords.length) {
    const child = childText(activity).toLowerCase();
    const hits = factWords.filter((word) => child.includes(word));
    if (hits.length >= Math.ceil(factWords.length * 0.5)) {
      problems.push("The fact is written in the child-facing text. The child should reach it only by playing.");
    }
  }
  if (isAcrostic(mechanicText)) {
    const facing = `${activity.goal || ""} ${instructions}`;
    if (/\b(doodle|sketch|draw)\b/i.test(facing)) {
      problems.push("This mechanic is an ordered word list. Do not add a separate doodling or drawing task.");
    }
    if (/\b(circle|search the|look at the illustration|find and circle)\b/i.test(facing)) {
      problems.push("Acrostic Harvest is one mechanic: read the ordered words and take their first letters. Do not add a seek-and-find on top.");
    }
    const words = orderedWords(activity);
    const abstract = words.filter((word) => ABSTRACT_ITEMS.test(word));
    if (abstract.length) {
      problems.push(`These words are not things a child can find or read as puzzle items: ${abstract.join(", ")}. Use concrete words.`);
    }
    if (words.length < 3) {
      problems.push("Write every word in order. The first letter of each word is the puzzle.");
    } else if (answerLetters) {
      const initials = words.map((word) => word[0].toUpperCase()).join("");
      if (initials !== answerLetters) {
        problems.push(`The first letters are "${initials}". They must spell "${answerLetters}" in that order.`);
      }
      if (collected && collected !== initials) {
        problems.push(`solution.collected_letters is "${collected}", but the word list produces "${initials}".`);
      }
    }
    if (/what (empire|city|river|kingdom|dynasty) was|what was the capital|what is the capital/i.test(activity.puzzle_prompt || "")) {
      problems.push("The question asks the child to recall the fact. Ask for the word the first letters spell.");
    }
  }
  const pairClaim = claimedCount(instructions, "pairs");
  const pairs = Array.isArray(solution.pairs) ? solution.pairs : [];
  if (pairClaim && pairs.length !== pairClaim) {
    problems.push(`The instructions say ${pairClaim} pairs. solution.pairs must list all ${pairClaim}.`);
  }
  const differenceClaim = claimedCount(instructions, "differences");
  const differences = Array.isArray(solution.differences) ? solution.differences : [];
  if (differenceClaim && differences.length !== differenceClaim) {
    problems.push(`The instructions say ${differenceClaim} differences. solution.differences must list all ${differenceClaim}, and what each one reveals.`);
  }
  const answer = String(solution.final_answer || "").trim();
  if (answer.length >= 4 && answer.split(/\s+/).length <= 3) {
    const token = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const visible = new RegExp(`\\b${token}\\b`, "i");
    if (visible.test(childText(activity))) {
      problems.push(`The answer "${answer}" is written in the child-facing text. The child should reach it only by playing.`);
    }
    if (visible.test(String(activity.artwork_instructions || ""))) {
      problems.push(`The artwork tells the page to show "${answer}". That word belongs only in the solution.`);
    }
  }
  const artwork = String(activity.artwork_instructions || "").trim();
  if (artwork.length < 40) {
    problems.push("artwork_instructions must restate the puzzle's objects, counts, relationships, and answer space.");
  }
  if (collected && artwork && !isAcrostic(mechanicText) && !artwork.toUpperCase().includes(collected) && !artwork.includes(String(collected.length))) {
    problems.push("artwork_instructions must include the collected letters or their count.");
  }
  return [...new Set(problems)];
}

module.exports = {
  parseValue,
  activeFamilies,
  activityConstruction,
  specGaps,
  normalizeSpec,
  themeSelectionBrief,
  rankActivities,
  shortlistActivities,
  rankThemes,
  shortlistThemes,
  buildGenerationPayload,
  constructionProblems,
  methodsCompatible,
  themeCanShow,
  pickReference,
  outputShape,
};
