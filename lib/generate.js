const fs = require("fs");
const path = require("path");
const { getCategoriesBrief, getTheme, getExampleActivities, getCatalog } = require("./db");

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

function clip(value, max) {
  const text = value == null ? "" : String(value);
  return text.length <= max ? text : text.slice(0, max);
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
    activity_detection: theme.activity_detection || {},
    activity_specs: theme.activities && theme.activities.length
      ? theme.activities
      : shrinkSpecs(theme.activity_specs),
  };
}

function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch (__) {
        const inner = firstJsonObject(fenced[1]);
        if (inner) return JSON.parse(inner);
      }
    }
    const objectText = firstJsonObject(trimmed);
    if (objectText) return JSON.parse(objectText);
    throw new Error("The model did not return JSON");
  }
}

const SELECT_PROMPT = [
  "You find how a short topic can be played. You do not choose the final activity yet.",
  "Do not select a mechanic because the topic can be illustrated with it. Select a mechanic because an action, relationship, sequence, spatial structure, pattern, or claim inside the topic becomes the child's play.",
  "Read the topic's own verbs. Do not add explore, discover, navigate, or journey unless the paragraph itself describes movement from one place to another.",
  "A place name is not a path. A list of reasons something is special is not a journey. Those claims want matching, sorting, classifying, or choosing, not a route.",
  "Use a path, maze, or trace mechanic only when the paragraph describes something moving, flowing, or traveling through connected places. Water flowing through canals is a route. 'This city was a capital and a World Heritage site' is not.",
  "A strong idea makes the child do what the subject does. Water flows, so the child follows the flow. Distinct claims sit side by side, so the child matches each claim to its evidence. Pieces support each other, so the child connects them.",
  "A weak idea puts the topic on a generic puzzle, including a letter-collecting path used for every subject.",
  "Use only supplied catalog mechanics. Copy mechanic names exactly.",
  "Locks are mandatory. If a category or mechanic is locked, every candidate uses that lock.",
  "Work in this order:",
  "1. play_affordances from the topic only. Leave a list empty when the paragraph does not contain that kind of structure. Do not invent spatial_opportunities for a topic that has no route.",
  "2. Three to five candidate concepts. Each candidate must use a different catalog mechanic. Score topic_play_alignment as \"very high\", \"high\", \"medium\", or \"low\".",
  "very high = the child's action is a verb or structure written in the topic.",
  "high = the child manipulates a real relationship from the topic.",
  "low = the topic is decoration, or a path was chosen for a topic that does not travel.",
  "Include one low-alignment candidate so the contrast is explicit. Do not treat that candidate as the winner.",
  "3. The winning candidate is the highest alignment whose mechanic exists in the catalog. The code will reject a path, maze, or trace winner when the topic has no traversal, so do not mark those mechanics very high unless the paragraph describes movement through places.",
  "Return JSON only, with no markdown:",
  '{"play_affordances":{"entities":[],"actions":[],"relationships":[],"spatial_opportunities":[],"sequence_opportunities":[],"collection_opportunities":[],"hidden_fact_opportunities":[]},"candidates":[{"concept":"","category_id":0,"mechanic":"","topic_play_alignment":"very high","why":""}]}',
].join("\n");

const ANALYZE_PROMPT = [
  "A category and mechanic have already been chosen. Do not switch them, and do not turn every mechanic into a path that collects letters.",
  "Choose a theme only if theme_slug is not locked. Each theme lists activity_detection and activities. Prefer the theme whose playerAction and preserve list can carry this topic. Once chosen, that preserved play is the activity. Do not rewrite it into a different game.",
  "If the theme preserves pair matching, the child finds exact visual twins in an open field of similar objects. That is not matching a picture to a written description, and it is not a cause-and-effect sort. how_the_child_recovers_the_fact must name every identical pair. The question asks the child to find those pairs.",
  "The fact must be supported by the topic. Do not invent extra facts.",
  "The blank answer is a short concrete word or name copied from the topic. It is not a label for the question. Spelling CAPITAL to answer 'what was the capital' is invalid. The question must not already contain the answer word.",
  "fact_question asks about the action the child just performed. Good: Which empire did this city rule for? Bad: What did you discover? Bad: What was the capital of the Vijayanagar Empire? when the letters only spell CAPITAL.",
  "how_the_child_recovers_the_fact must match the locked mechanic:",
  "Route, maze, or path trace: name the correct stops and the dead ends. Add one letter per stop only when those letters spell a name from the topic that the question does not already show.",
  "Matching or classifying: name each pair or group and the word or name the correct set produces.",
  "Sequence or ordering: name the correct order and the fact that order reveals.",
  "Counting or spotting: name every item and the exact count or selection.",
  "Do not describe a winding path, base camp, or collected letters unless the locked mechanic is a path, maze, or trace.",
  "One mechanic only. Tokens gathered by that mechanic are part of it, not a second game.",
  "why names the topic structure the child manipulates, and why this mechanic realizes it. Do not justify a path by saying the child explores.",
  "Return JSON only, with no markdown:",
  '{"theme_slug":"","why":"","analysis":{"core_subject":"","fact":"","play_affordance":"","play_concept":"","fact_question":"","how_the_child_recovers_the_fact":""}}',
].join("\n");

const REVIEW_PROMPT = [
  "You are a skeptical checker, not an editor.",
  "The activity you receive is an untrusted draft from another model.",
  "Approval is binary. If mechanic, topic facts, puzzle logic, category mapping, fact-through-play, or illustrator reconstruction fails, do not polish the draft—replace the broken parts before returning it.",
  "INDEPENDENT SOLVE: Do not approve a puzzle because it sounds plausible. Actually solve it independently. Work every clue yourself and compare your result with answer_or_solution. If you cannot solve it from the written puzzle, or your result disagrees, rebuild it before approval.",
  "VAGUE VISUAL FAILURE: Words such as \"may include\", \"can include\", \"for example\", \"various\", or unspecified visual placements are automatic failures for fixed-answer visual puzzles. Replace them with the exact objects, counts, and placements.",
  "Artwork has not been generated yet.",
  "ONE MECHANIC: A valid activity must implement exactly one coherent mechanic. If instructions + puzzle_prompt describe a different game than the mechanic field, reject and rebuild it—even if the activity itself sounds fun. Tokens, letters, or marks gathered by performing the mechanic are part of that mechanic, not a second game. An unrelated extra game stacked on the mechanic is a failure.",
  "FACT THROUGH PLAY: The activity must implement the supplied analysis. Performing the named mechanic must produce analysis.fact. Child-facing text (title, instructions, puzzle_prompt, rules, components, setup) must not reveal that fact. The question must refer to what the child just did. A school comprehension question, or a question that can be answered without doing the mechanic, is a failure — rebuild so the fact is recovered only by play. The recovery must match analysis.how_the_child_recovers_the_fact.",
  "DETERMINISM: Every count, letter, difference, stop, and keyword claimed in the instructions must be listed exactly in components, puzzle_prompt, or solution. If the text says 11 letters, list all 11 in order and show that they produce the answer. If it says 8 differences, list all 8 and what each one reveals. Phrases such as \"differences reveal keywords\", \"rearrange the keywords\", or \"uncover letters\" without that exact mapping are automatic failures. Rebuild with the full specification.",
  "MECHANIC SIMULATION TEST: Ignore the title and explanation. Look only at the actual child actions in instructions + puzzle_prompt. Perform those actions mentally. If those actions do not literally implement the named mechanic, the activity MUST be rebuilt so those actions implement required_mechanic. Never approve based on thematic similarity.",
  "CONTRADICTION TEST: Compare rules, components, puzzle_prompt, and answer_or_solution against each other and against the topic. Any contradiction requires repair before approval.",
  "TOPIC FACTS: Do not contradict the topic, and do not add a fact the solution requires if the topic does not support it. The analyzed fact must be supported by the topic. If it is not, replace the broken parts.",
  "PUZZLE LOGIC: For every fixed-answer puzzle, independently evaluate every clue and every candidate possibility. Do not trust the proposed answer. If more than one answer satisfies the rules, or the stated answer does not follow, rebuild the puzzle until one answer follows and the others do not.",
  "CATEGORY MAPPING: category_id, category_name, and mechanic must stay the supplied selection. The answer form must fit that mechanic's output_types.",
  "ILLUSTRATOR RECONSTRUCTION: Because artwork has not been generated, answer-critical counts, positions, statements, and paths must be written in the activity. Reject phrases that assume the artwork will decide those details. Specify both states, positions, counts, and relationships explicitly.",
  "Open-ended activities do not need one fixed answer. For those, still run the mechanic simulation test, the fact-through-play check, and the contradiction test, and state a success condition instead of inventing a single answer.",
  "Return the full activity object, not a patch.",
  "Return JSON only, with no markdown:",
  '{"activities":[],"review":[{"title":"","passed":true,"fixes":[]}]}',
  "passed is true only when fixes is empty. A failed check comes back as a replaced activity plus a fix that names the failed check. Use an empty fixes array only after the activity survives the one-mechanic rule, the fact-through-play check, the determinism check, the independent solve, the vague-visual failure check, the mechanic simulation test, the contradiction test, and the other checks.",
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

function ageNote(input) {
  return input.ageMin || input.ageMax
    ? `Target ages ${input.ageMin || "?"} to ${input.ageMax || "?"}.`
    : "Choose a sensible age range for the topic.";
}

function difficultyNote(input) {
  return input.difficulty
    ? `Difficulty: ${input.difficulty}.`
    : "Choose a difficulty of easy, easy-medium, medium, or medium-hard.";
}

function lookupLocks(input, categories, themes) {
  const userLocked = { category: false, mechanic: false, theme: false };

  let theme = null;
  const slug = String(input.themeSlug || "").trim();
  if (slug) {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("That theme was not found.");
    theme = themes.find((item) => item.slug === slug) || null;
    if (!theme) throw new Error("That theme was not found.");
    userLocked.theme = true;
  }

  let category = null;
  if (input.categoryId) {
    category = categories.find((item) => Number(item.category_id) === Number(input.categoryId)) || null;
    if (!category) throw new Error("That category was not found.");
    userLocked.category = true;
  }

  let mechanicName = String(input.mechanic || "").trim();
  if (mechanicName) {
    userLocked.mechanic = true;
    const owns = (item) => item.mechanics.some((mechanic) => mechanic.name === mechanicName);
    if (category) {
      if (!owns(category)) throw new Error("That mechanic is not in the chosen category.");
    } else {
      category = categories.find(owns) || null;
      if (!category) throw new Error("That mechanic was not found.");
    }
  } else {
    mechanicName = "";
  }

  return { theme, category, mechanicName, userLocked };
}

function itemText(item) {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number") return String(item).trim();
  if (typeof item === "object") {
    return String(
      item.name || item.text || item.label || item.value || item.verb || item.action || item.entity || item.relationship || ""
    ).trim();
  }
  return "";
}

function asList(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return asList(JSON.parse(trimmed));
      } catch (_) {
        // A plain sentence is still one affordance.
      }
    }
    return trimmed.split(/[,;\n|]/).map((part) => part.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) return value.map(itemText).filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).map(itemText).filter(Boolean);
  return [];
}

function alignmentRank(value) {
  const text = String(value || "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (text === "very high") return 4;
  if (text === "high") return 3;
  if (text === "medium") return 2;
  if (text === "low") return 1;
  return 0;
}

function isRouteMechanic(name) {
  return /\b(path|maze|route|trace|labyrinth)\b/i.test(String(name || ""));
}

function topicHasTraversal(topic) {
  return /\b(flows?|flowed|flowing|canal|aqueduct|migrat\w*|travels?|traveled|travelled|journey|route|network|channel|winds?|winding)\b/i.test(String(topic || ""));
}

function readAffordances(parsed) {
  const root = parsed && typeof parsed === "object" ? parsed : {};
  let source = root.play_affordances || root.playAffordances || root.affordances || {};
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch (_) {
      source = {};
    }
  }
  const bag = source && typeof source === "object" ? source : {};
  const affordances = {
    entities: asList(bag.entities || bag.entity),
    actions: asList(bag.actions || bag.action),
    relationships: asList(bag.relationships || bag.relationship),
    spatial_opportunities: asList(bag.spatial_opportunities || bag.spatialOpportunities),
    sequence_opportunities: asList(bag.sequence_opportunities || bag.sequenceOpportunities),
    collection_opportunities: asList(bag.collection_opportunities || bag.collectionOpportunities),
    hidden_fact_opportunities: asList(bag.hidden_fact_opportunities || bag.hiddenFactOpportunities),
  };
  if (!affordances.entities.length || !affordances.actions.length || !affordances.relationships.length) {
    throw new Error("play_affordances must include entities, actions, and relationships taken from the topic. Use the topic's own nouns and verbs. Do not leave those lists empty.");
  }
  return affordances;
}

function readCandidates(parsed, locks) {
  const list = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates = list.map((item) => ({
    concept: String(item && (item.concept || item.play || item.idea) || "").trim(),
    mechanic: String(item && item.mechanic || "").trim(),
    topic_play_alignment: String(item && (item.topic_play_alignment || item.alignment) || "").trim().toLowerCase(),
    why: String(item && item.why || "").trim(),
  })).filter((item) => item.mechanic && item.topic_play_alignment)
    .map((item) => ({ ...item, concept: item.concept || item.why || item.mechanic }));
  if (candidates.length < 3) throw new Error("The selection did not compare play ideas. Try again.");
  const distinct = new Set(candidates.map((item) => item.mechanic.toLowerCase()));
  if (!locks.mechanicName && distinct.size < 3) {
    throw new Error("Candidates must use three different catalog mechanics. Do not offer three versions of the same path.");
  }
  return candidates;
}

function pickWinner(candidates, categories, locks, topic) {
  const routeLocked = Boolean(locks.mechanicName) && isRouteMechanic(locks.mechanicName);
  const allowRoute = routeLocked || topicHasTraversal(topic);
  const known = [];
  for (const candidate of candidates) {
    const owner = categories.find((category) =>
      category.mechanics.some((mechanic) => mechanic.name === candidate.mechanic)
    );
    if (!owner) continue;
    if (locks.category && Number(owner.category_id) !== Number(locks.category.category_id)) continue;
    if (locks.mechanicName && candidate.mechanic !== locks.mechanicName) continue;
    let rank = alignmentRank(candidate.topic_play_alignment);
    if (!allowRoute && isRouteMechanic(candidate.mechanic)) rank = 0;
    known.push({ ...candidate, category: owner, rank });
  }
  if (!known.length) throw new Error("The selection did not match a catalog mechanic. Try again.");
  const playable = known.filter((item) => item.rank > 0);
  if (!playable.length) {
    throw new Error("This topic does not describe movement through places. Do not choose a path, maze, or trace. Propose three different catalog mechanics that match, sort, classify, order, or test the claims in the topic.");
  }
  playable.sort((a, b) => b.rank - a.rank);
  return playable[0];
}

function spelledToken(recovery) {
  const spaced = String(recovery || "").match(/\b(?:[A-Za-z]\s+){3,}[A-Za-z]\b/);
  if (spaced) return spaced[0].replace(/\s+/g, "").toLowerCase();
  const word = String(recovery || "").match(/\bspell(?:s|ed)?\s+(?:out\s+|the\s+)?(?:word\s+|name\s+|fact\s+)?([A-Za-z]{4,})/i);
  return word ? word[1].toLowerCase() : "";
}

function themePlayFrom(theme) {
  const activity = theme && Array.isArray(theme.activities) ? theme.activities[0] : null;
  if (!activity) return null;
  const mechanic = activity.mechanic && typeof activity.mechanic === "object" ? activity.mechanic : {};
  const playable = activity.playableState || {};
  const preserve = activity.adaptation && Array.isArray(activity.adaptation.preserve) ? activity.adaptation.preserve : [];
  const blob = [mechanic.name, mechanic.mechanicSummary, playable.playerAction, preserve.join(" ")].join(" ");
  const objects = Array.isArray(playable.objects) ? playable.objects : [];
  const objectCount = objects.reduce((sum, item) => sum + (Number(item && item.quantity) || 0), 0);
  return {
    name: mechanic.name || "Pair Matching",
    summary: mechanic.mechanicSummary || "",
    playerAction: playable.playerAction || "",
    preserve,
    validationRule: activity.solutionShape && activity.solutionShape.validationRule || "",
    exactPairs: /exact|identical|pair matching/i.test(blob),
    objectCount: objectCount || null,
    pairCount: objectCount ? objectCount / 2 : null,
  };
}

function applyThemePlay(chosen, theme, categories, locks) {
  const play = themePlayFrom(theme);
  if (!play || !play.exactPairs) return play;
  if (!locks.userLocked.mechanic) chosen.selection.mechanic = play.name;
  if (!locks.userLocked.category) {
    const visual = categories.find((category) => /visual perception/i.test(category.name));
    if (visual) {
      chosen.selection.category_id = visual.category_id;
      chosen.selection.category_name = visual.name;
      chosen.category = visual;
    }
  }
  if (!/exactly the same/i.test(chosen.selection.why)) {
    chosen.selection.why = `${chosen.selection.why} The theme is an open field of similar objects, and the child finds the ones that are exactly the same.`.trim();
  }
  return play;
}

function pairLogicProblems(activity, play) {
  if (!play || !play.exactPairs) return [];
  const text = [activity.goal, activity.instructions, activity.puzzle_prompt, activity.components, activity.setup, activity.rules]
    .filter(Boolean)
    .join("\n");
  const problems = [];
  if (/descri/i.test(text)) {
    problems.push("This theme is exact visual pairs. A written description is not a partner. Each object has one identical twin.");
  }
  if (!/identical|exactly the same|exact match/i.test(text)) {
    problems.push("The child must be finding objects that are exactly the same.");
  }
  const pairs = activity.solution && Array.isArray(activity.solution.pairs) ? activity.solution.pairs : [];
  const needed = play.pairCount || 0;
  if (needed && pairs.length !== needed) {
    problems.push(`solution.pairs must list all ${needed} identical pairs. Each entry names the shared object and the visible trait the twins share.`);
  } else if (!pairs.length) {
    problems.push("solution.pairs must list every identical pair.");
  }
  return problems;
}

function settlePairQuestion(analysis, themePlay) {
  if (!themePlay || !themePlay.exactPairs) return;
  const question = analysis.fact_question.toLowerCase();
  if (/pair|match|twin|same|identical/.test(question)) return;
  const count = themePlay.pairCount ? `all ${themePlay.pairCount} pairs` : "every pair";
  analysis.fact_question = `Each object has an exact match. Can you find ${count}?`;
}

function analysisProblems(analysis, mechanic, themePlay) {
  const problems = [];
  const question = analysis.fact_question.toLowerCase();
  const recovery = analysis.how_the_child_recovers_the_fact;
  const route = isRouteMechanic(mechanic);
  if (/what did you (discover|learn)|why (is|was|were)|how important|what do you (think|understand|notice)/.test(question)) {
    problems.push("fact_question asks for a reflection. Ask about the action the child just performed, and leave a short blank.");
  }
  if (route) {
    if (!/\b(path|route|stops?)\b/i.test(recovery)) {
      problems.push("A route mechanic must name the correct stops and how they produce the answer.");
    }
  } else if (/\b(winding path|base camp|letters on that path|collected letters)\b/i.test(recovery)) {
    problems.push("This mechanic is not a route. Do not recover the fact by walking a path and collecting letters.");
  }
  if (themePlay && themePlay.exactPairs) {
    if (/written description|their descriptions|matching descriptions/i.test(recovery)) {
      problems.push("This theme pairs identical objects. Do not match features to written descriptions. Name every identical pair.");
    }
    if (!/identical|exactly the same|exact match/i.test(recovery)) {
      problems.push("Name the identical pairs the child finds, and how those pairs produce the fact.");
    }
  }
  if (recovery.length < 40) {
    problems.push("how_the_child_recovers_the_fact must name the exact items, matches, order, or count that produce the answer.");
  }
  const token = spelledToken(recovery);
  if (token && question.includes(token)) {
    problems.push(`The letters spell "${token}", which the question already shows. The blank must be a name from the topic that the question does not contain.`);
  }
  if (/^the child\b/i.test(analysis.fact) || analysis.fact.length > 240) {
    problems.push("fact must be a short claim from the topic, such as the name or structure the play produces, not a description of the child.");
  }
  return problems;
}

function plainText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") return String(item.instruction || item.text || item.step || "").trim();
      return String(item ?? "").trim();
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") return "";
  return value;
}

function normalizeActivity(activity) {
  const next = { ...activity };
  for (const key of ["instructions", "rules", "setup", "components", "puzzle_prompt", "answer_or_solution", "goal"]) {
    if (key in next) next[key] = plainText(next[key]);
  }
  return next;
}

function readAnalysis(parsed, affordances) {
  const source = parsed && parsed.analysis && typeof parsed.analysis === "object" && !Array.isArray(parsed.analysis)
    ? parsed.analysis
    : {};
  const analysis = {
    core_subject: String(source.core_subject || "").trim(),
    fact: String(source.fact || "").trim(),
    play_affordance: String(source.play_affordance || "").trim(),
    play_concept: String(source.play_concept || "").trim(),
    fact_question: String(source.fact_question || "").trim(),
    how_the_child_recovers_the_fact: String(source.how_the_child_recovers_the_fact || "").trim(),
    play_affordances: affordances,
  };
  const missing = ["core_subject", "fact", "play_affordance", "play_concept", "fact_question", "how_the_child_recovers_the_fact"]
    .filter((key) => !analysis[key]);
  if (missing.length) throw new Error("The analysis was incomplete. Try again.");
  return analysis;
}

function catalogBrief(categories) {
  return categories.map((category) => ({
    category_id: category.category_id,
    name: category.name,
    description: clip(category.description, 400),
    mechanics: category.mechanics.map((item) => ({
      name: item.name,
      blurb: item.blurb,
      output_types: item.output_types,
    })),
  }));
}

function themeCatalog(themes) {
  return themes.map((theme) => ({
    slug: theme.slug,
    name: theme.name,
    description: clip(theme.description, 400),
    core_idea: clip(theme.core_idea, 400),
    tags: theme.tags,
    activity_detection: theme.activity_detection || {},
    activities: (theme.activities || []).map((activity) => ({
      mechanic: activity.mechanic,
      playerAction: activity.playableState && activity.playableState.playerAction,
      preserve: activity.adaptation && activity.adaptation.preserve,
    })),
  }));
}

async function selectAndAnalyze({ apiKey, model, topic, input, categories, themes, locks }) {
  let played = null;
  let affordances = null;
  let winner = null;
  let selectError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    played = await callOpenRouter({
      apiKey,
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SELECT_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            topic,
            age: ageNote(input),
            difficulty: difficultyNote(input),
            locks: {
              category_id: locks.category ? locks.category.category_id : null,
              category_name: locks.category ? locks.category.name : null,
              mechanic: locks.mechanicName || null,
            },
            categories: catalogBrief(categories),
            ...(attempt > 1 ? { repair: selectError } : {}),
          }),
        },
      ],
    });
    try {
      affordances = readAffordances(played, topic);
      winner = pickWinner(readCandidates(played, locks), categories, locks, topic);
      selectError = null;
      break;
    } catch (error) {
      selectError = error.message;
    }
  }
  if (selectError) throw new Error(selectError);

  let analyzed = null;
  let analysis = null;
  let theme = locks.theme;
  let problems = ["Write the analysis."];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    analyzed = await callOpenRouter({
      apiKey,
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: ANALYZE_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            topic,
            age: ageNote(input),
            difficulty: difficultyNote(input),
            play_affordances: affordances,
            winning_concept: {
              concept: winner.concept,
              why: winner.why,
              topic_play_alignment: winner.topic_play_alignment,
            },
            locks: {
              category_id: winner.category.category_id,
              category_name: winner.category.name,
              mechanic: winner.mechanic,
              theme_slug: locks.theme ? locks.theme.slug : null,
            },
            themes: themeCatalog(themes),
            ...(attempt > 1 ? { repair: problems } : {}),
          }),
        },
      ],
    });
    analysis = readAnalysis(analyzed, affordances);
    problems = [];
    if (!locks.theme) {
      const slug = String(analyzed.theme_slug || "").trim().toLowerCase();
      theme = themes.find((item) => item.slug.toLowerCase() === slug)
        || themes.find((item) => String(item.name || "").trim().toLowerCase() === slug)
        || null;
      if (!theme) problems.push("theme_slug must be copied exactly from the supplied theme list.");
    }
    const themePlay = themePlayFrom(theme);
    settlePairQuestion(analysis, themePlay);
    problems = problems.concat(analysisProblems(analysis, winner.mechanic, themePlay));
    if (!problems.length) break;
  }
  if (problems.length) {
    throw new Error(`The analysis did not turn the topic into play. ${problems[0]} Recovery was: ${analysis.how_the_child_recovers_the_fact.slice(0, 220)}`);
  }

  if (!theme) throw new Error("The model chose a theme that is not in the catalog.");
  const why = String(analyzed.why || winner.why || "").trim();
  if (!why) throw new Error("The selection did not explain its choice. Try again.");

  return {
    selection: {
      category_id: winner.category.category_id,
      category_name: winner.category.name,
      mechanic: winner.mechanic,
      theme: { name: theme.name, slug: theme.slug },
      why,
      locked_by_user: locks.userLocked,
    },
    analysis,
    category: winner.category,
  };
}

function forceSelection(activity, selection) {
  return {
    ...activity,
    category_id: selection.category_id,
    category_name: selection.category_name,
    mechanic: selection.mechanic,
  };
}

function takeActivity(parsed) {
  if (parsed && parsed.activity && typeof parsed.activity === "object" && !Array.isArray(parsed.activity)) {
    return parsed.activity;
  }
  if (parsed && Array.isArray(parsed.activities) && parsed.activities[0]) return parsed.activities[0];
  if (parsed && parsed.title) return parsed;
  throw new Error("The model returned no activity. Try again.");
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

function catalogBlockFor(category, mechanicName, themePlay) {
  if (themePlay && themePlay.exactPairs) {
    return {
      use_this_category: {
        category_id: category.category_id,
        name: category.name,
        description: category.description,
        mechanics: [],
      },
      required_mechanic: { name: themePlay.name, output_types: ["exact visual pairs"] },
      theme_play: themePlay,
    };
  }
  const chosen = category.mechanics.find((item) => item.name === mechanicName) || null;
  return {
    use_this_category: {
      category_id: category.category_id,
      name: category.name,
      description: category.description,
      mechanics: chosen ? [chosen] : category.mechanics,
    },
    required_mechanic: chosen
      ? { name: chosen.name, output_types: chosen.output_types }
      : null,
    theme_play: themePlay,
  };
}

function reviewPassed(review) {
  const item = Array.isArray(review) ? review[0] : null;
  if (!item || item.passed !== true) return false;
  return !Array.isArray(item.fixes) || item.fixes.filter(Boolean).length === 0;
}

async function reviewActivity({ apiKey, model, topic, activity, puzzleCatalog, analysis }) {
  let current = activity;
  let review = [];
  let previousFixes = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const parsed = await callOpenRouter({
      apiKey,
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: REVIEW_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "This activity is an untrusted draft. Approval is binary. It must implement required_mechanic and theme_play when theme_play is present. If theme_play.exactPairs is true, the child finds identical visual twins in an open field. A written description is not a partner. solution.pairs must list every identical pair, and the count must match theme_play.pairCount. Do not rebuild that into cause-and-effect sorting or caption matching. Do not rebuild a non-route mechanic into a winding path that collects letters. Performing the play must produce analysis.fact. The question must refer to what the child just did. DETERMINISM: every claimed pair, letter, difference, stop, or keyword must be listed exactly. Rebuild the activity. Keep category_id, category_name, and mechanic as in the selection. Artwork has not been generated.",
            topic,
            analysis,
            puzzle_catalog: puzzleCatalog,
            activities: [current],
            ...(attempt > 1 ? { previous_fixes: previousFixes, repair: "The last draft failed. Return a replaced activity in which those fixes are already done." } : {}),
          }),
        },
      ],
    });
    const checked = applyReview([current], parsed);
    current = checked.activities[0];
    review = checked.review;
    previousFixes = review[0] && Array.isArray(review[0].fixes) ? review[0].fixes : [];
    const logic = pairLogicProblems(current, puzzleCatalog && puzzleCatalog.theme_play);
    if (logic.length) {
      review = [{ title: current.title || "", passed: false, fixes: logic }];
      previousFixes = logic;
      continue;
    }
    if (reviewPassed(review)) break;
  }
  return { activities: [current], review };
}

async function generateActivities(input) {
  const topic = String(input.content || "").trim();
  if (topic.length < 20) {
    throw new Error("Write a short paragraph about the topic.");
  }

  const apiKey = input.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Add an OpenRouter API key.");
  const model = String(input.model || process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();

  const [categories, catalog] = await Promise.all([
    getCategoriesBrief(),
    getCatalog(),
  ]);
  const themes = catalog.themes || [];
  const locks = lookupLocks(input, categories, themes);
  const chosen = await selectAndAnalyze({
    apiKey,
    model,
    topic,
    input,
    categories,
    themes,
    locks,
  });

  const theme = await getTheme(chosen.selection.theme.slug);
  if (!theme) throw new Error("That theme was not found.");
  const themePlay = applyThemePlay(chosen, theme, categories, locks);
  const examples = await getExampleActivities(chosen.selection.category_id);
  const puzzleCatalog = catalogBlockFor(chosen.category, chosen.selection.mechanic, themePlay);

  const drafted = await callOpenRouter({
    apiKey,
    model,
    messages: [
      { role: "system", content: loadSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          task: "Create one original activity. If theme_play.exactPairs is true, follow that play exactly: an open field of similar objects, each with one identical twin. Replace only the object subject with this topic. Do not match pictures to written descriptions. Do not use cause-and-effect sorting. List every pair in solution.pairs. The child-facing question asks them to find the pairs. Otherwise follow the locked mechanic and analysis.how_the_child_recovers_the_fact. Specify every token the instructions mention. Do not ask the child what they learned.",
          topic,
          age: ageNote(input),
          difficulty: difficultyNote(input),
          theme: themeBrief(theme),
          puzzle_catalog: puzzleCatalog,
          analysis: chosen.analysis,
          selection: {
            category_id: chosen.selection.category_id,
            category_name: chosen.selection.category_name,
            mechanic: chosen.selection.mechanic,
            why: chosen.selection.why,
          },
          construction_patterns_from_library: {
            how_to_use: "Copy the method, never the subject, title, or clues. play_pattern describes how the play works. It is not a catalog mechanic name. The activity mechanic must be the locked mechanic, and performing it must produce the analyzed fact.",
            examples,
          },
          output_shape: {
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
              components: "what appears on the page or in the scene, including every answer-critical token",
              materials: "physical materials, or an empty string",
              setup: "how to lay it out",
              instructions: "numbered steps the child follows",
              rules: "constraints that make the puzzle fair",
              puzzle_prompt: "the playable scene, ending with the fact question and a blank. The question refers to what the child just did.",
              answer_or_solution: "the fact first, then why the play produces it",
              solution: {
                correct_route: "every stop on the correct path, or an empty string when the mechanic is not a route",
                collected_letters: "letters in exact order, or an empty string when letters are not collected",
                pairs: [{ object: "the shared subject", trait: "the visible detail that makes the twins identical" }],
                final_answer: "what the blank must contain",
              },
              learning_through_play: ["a fact the child meets by playing, not a lecture"],
              skills: ["skill"],
              story_integration: "how the topic action and the mechanic are the same play",
              theme_note: "which theme pattern you used, in one sentence",
            },
          },
        }),
      },
    ],
  });

  let activity = normalizeActivity(forceSelection(takeActivity(drafted), chosen.selection));
  let review = [];
  let reviewError = "";
  try {
    const checked = await reviewActivity({
      apiKey,
      model,
      topic,
      activity,
      puzzleCatalog,
      analysis: chosen.analysis,
    });
    activity = normalizeActivity(forceSelection(checked.activities[0], chosen.selection));
    review = checked.review;
  } catch (error) {
    reviewError = error.name === "TimeoutError"
      ? "The review took too long."
      : error.message;
  }

  return {
    selection: chosen.selection,
    analysis: chosen.analysis,
    activity,
    review,
    model,
    ...(reviewError ? { review_error: reviewError } : {}),
  };
}

module.exports = { generateActivities };
