const fs = require("fs");
const path = require("path");
const { getCategoriesBrief, getTheme, getCatalog, getActivityRecords, getThemeRecords } = require("./db");
const {
  shortlistActivities,
  rankActivities,
  shortlistThemes,
  themeSelectionBrief,
  activityConstruction,
  buildGenerationPayload,
  constructionProblems,
  outputShape,
  themeCanShow,
  pickReference,
} = require("./brief");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "system-prompt.md");

function loadSystemPrompt() {
  return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim();
}

function clip(value, max) {
  const text = value == null ? "" : String(value);
  return text.length <= max ? text : text.slice(0, max);
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
  "activity_references are construction methods, retrieved by the action inside the topic. A river should surface route, flow, connection, and collection methods, not only records that mention the noun.",
  "Choose activity_id from that list only when that activity uses the same operation as the mechanic. A lookup-table password is not an acrostic. The code drops a reference whose method does not match. Do not copy its subject.",
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
  '{"play_affordances":{"entities":[],"actions":[],"relationships":[],"spatial_opportunities":[],"sequence_opportunities":[],"collection_opportunities":[],"hidden_fact_opportunities":[]},"candidates":[{"concept":"","category_id":0,"mechanic":"","activity_id":"","topic_play_alignment":"very high","why":""}]}',
].join("\n");

const ANALYZE_PROMPT = [
  "A category and mechanic have already been chosen. Do not switch them, and do not turn every mechanic into a path that collects letters.",
  "Choose a theme only if theme_slug is not locked. The theme dresses the topic. It does not replace the topic's verb with the theme's old puzzle.",
  "Read the topic's verbs first. Make, name, give powers, and hang means the child makes, names, gives powers, and hangs. That is not pair matching. Pair matching is allowed only when the topic itself is about finding identical things.",
  "Do not choose the same play for every topic. A making or creature topic wants a making or creature theme. A route topic wants a route theme. A topic about identical twins wants a pair-matching theme.",
  "If you do choose a pair-matching theme, the child finds exact visual twins, and the question asks them to find those pairs. Do not use that theme for a topic about making something.",
  "The fact must be supported by the topic. Do not invent extra facts.",
  "The blank answer is a short concrete word or name copied from the topic. It is not a label for the question. Spelling CAPITAL to answer 'what was the capital' is invalid. The question must not already contain the answer word.",
  "fact_question asks for the word, number, or route the mechanic just produced. Good: What word do the first letters spell? Good: What word do the letters on the correct path spell? Bad: What empire was this city the capital of? Bad: What did you discover? The child must not be able to answer from memory.",
  "how_the_child_recovers_the_fact must match the locked mechanic:",
  "Route, maze, or path trace: name the correct stops and the dead ends. Add one letter per stop only when those letters spell a name from the topic that the question does not already show.",
  "Matching or classifying: name each pair or group and the word or name the correct set produces.",
  "Sequence or ordering: name the correct order and the fact that order reveals.",
  "Counting or spotting: name every item and the exact count or selection.",
  "Do not describe a winding path, base camp, or collected letters unless the locked mechanic is a path, maze, or trace.",
  "One mechanic only. Tokens gathered by that mechanic are part of it, not a second game.",
  "why names the topic structure the child manipulates, and why this mechanic realizes it. Do not justify a path by saying the child explores.",
  "activity_reference is the construction method. Use its transformation, generation_constraints, and variation_hooks. Do not copy its subject, names, numbers, or answer.",
  "Choose a theme that can display this mechanic. A doodle, drawing, or craft theme cannot host an acrostic, code, table, or maze. Use core_idea, concept_style, story_adaptation, and usage_rules. Return theme_slug and activity_spec_id from that theme.",
  "Acrostic or first letters: name every word in order. Those first letters spell the answer. Do not add doodling. Do not ask the child to recall the fact.",
  "known_gaps are missing puzzle data. The new activity must construct those details. Do not inherit an empty path, an empty token list, a source slot count, or one aggregate object as a finished puzzle.",
  "how_the_child_recovers_the_fact must name the child action and the exact new items that reveal one fact from the topic. 'Reinforces understanding' is not a recovery.",
  "Return JSON only, with no markdown:",
  '{"theme_slug":"","activity_spec_id":"","why":"","analysis":{"core_subject":"","fact":"","play_affordance":"","play_concept":"","fact_question":"","how_the_child_recovers_the_fact":""}}',
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
  "DETERMINISM: Every count, letter, difference, stop, and keyword claimed in the instructions must be listed exactly in components, puzzle_prompt, solution, or playable_state. If the text says 11 letters, list all 11 in order and show that they produce the answer. If it says 8 differences, list all 8 and what each one reveals. Phrases such as \"differences reveal keywords\", \"rearrange the keywords\", or \"uncover letters\" without that exact mapping are automatic failures. Rebuild with the full specification.",
  "PLAYABLE STATE: playable_state.items must name each answer-critical object, stop, pair, letter, or clue. One object with a quantity, or a sentence such as \"24 objects forming 12 pairs\", is a failure until every item is named.",
  "ACROSTIC: an ordered word list whose first letters spell the answer, in solution.words. Letters that do not spell the answer fail. A doodle added on top fails. A question such as \"what empire was it the capital of\" fails, because the child can answer it without the list.",
  "SPOT THE DIFFERENCE: two panels, and every difference sits on an object whose name is a word. Those words, in order, produce the answer. One picture of objects that do not belong is a different mechanic. An odd-one-out row is a different mechanic.",
  "FACT CONNECTION: fact_connection.child_action, fact, and evidence are required. The fact must come from the topic. Generic claims such as \"reinforces understanding\" fail.",
  "ARTWORK: artwork_instructions must restate the finished puzzle's counts, labels, relationships, and answer space. Do not leave those choices to a later illustrator.",
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
  "passed is true only when fixes is empty. A failed check comes back as a replaced activity plus a fix that names the failed check. Use an empty fixes array only after the activity survives the one-mechanic rule, the fact-through-play check, the determinism check, the playable-state check, the fact-connection check, the artwork check, the independent solve, the vague-visual failure check, the mechanic simulation test, the contradiction test, and the other checks.",
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

function topicWantsExactPairs(topic) {
  return /\b(identical|exact match|look-?alikes?|twins?|pairs of|the same picture|spot the same)\b/i.test(String(topic || ""));
}

function readAffordances(parsed, topic) {
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
  fillAffordances(affordances, topic);
  if (!affordances.entities.length || !affordances.actions.length || !affordances.relationships.length) {
    throw new Error("play_affordances must include entities, actions, and relationships taken from the topic. Use the topic's own nouns and verbs. Do not leave those lists empty.");
  }
  return affordances;
}

function fillAffordances(affordances, topic) {
  const text = String(topic || "");
  const tokens = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "its", "it", "what", "your", "where", "when", "this", "that", "from", "into", "can", "be", "look"]);
  const verbs = ["make", "makes", "give", "gives", "hang", "play", "name", "become", "build", "create", "flow", "follow", "match", "sort", "count", "connect", "carry", "store", "find", "draw", "write", "place"];
  if (!affordances.actions.length) {
    const found = tokens.map((word) => word.toLowerCase()).filter((word) => verbs.includes(word));
    affordances.actions = [...new Set(found)].slice(0, 6);
    if (!affordances.actions.length) {
      const first = tokens.map((word) => word.toLowerCase()).find((word) => !stop.has(word) && word.length > 3);
      if (first) affordances.actions = [first];
    }
  }
  if (!affordances.entities.length) {
    const phrases = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    const nouns = tokens.filter((word) => {
      const lower = word.toLowerCase();
      return !stop.has(lower) && !verbs.includes(lower) && lower.length > 3;
    });
    affordances.entities = [...new Set([...phrases, ...nouns])].slice(0, 6);
  }
  if (!affordances.relationships.length) {
    const sentence = text.split(/[.!?]/).map((part) => part.trim()).find(Boolean);
    if (sentence) affordances.relationships = [sentence.slice(0, 180)];
  }
}

function readCandidates(parsed, locks) {
  const list = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates = list.map((item) => ({
    concept: String(item && (item.concept || item.play || item.idea) || "").trim(),
    mechanic: String(item && item.mechanic || "").trim(),
    activity_id: String(item && (item.activity_id || item.activityId) || "").trim(),
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

function applyThemePlay(chosen, theme, categories, locks, topic) {
  const play = themePlayFrom(theme);
  if (!play || !play.exactPairs) return play;
  if (!locks.userLocked.theme && !topicWantsExactPairs(topic)) return null;
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
  return {
    ...play,
    pairCount: null,
    source_gap: play.pairCount
      ? `The source claimed ${play.pairCount} pairs without naming them. Name each new pair.`
      : null,
  };
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
  if (!pairs.length) {
    problems.push("solution.pairs must list every identical pair. Each entry names the shared object and the visible trait the twins share.");
  } else if (pairs.some((pair) => !pair || !pair.object || !pair.trait)) {
    problems.push("Each solution.pairs entry needs the shared object and the visible trait that makes the twins identical.");
  }
  return problems;
}

function settlePairQuestion(analysis, themePlay, topic, themeLocked) {
  if (!themePlay || !themePlay.exactPairs) return;
  if (!themeLocked && !topicWantsExactPairs(topic)) return;
  const question = analysis.fact_question.toLowerCase();
  if (/pair|match|twin|same|identical/.test(question)) return;
  analysis.fact_question = "Each object has an exact match. Can you find every pair?";
}

const RECALL_QUESTION = /what did you (discover|learn)|why (is|was|were)|how important|what do you (think|understand|notice)|what (empire|city|river|kingdom|dynasty) was|which (empire|city|river|kingdom|dynasty)|what was the capital/;

function playQuestion(mechanic) {
  const name = String(mechanic || "");
  if (isRouteMechanic(name)) return "What word do the letters on the correct path spell?";
  if (/acrostic|harvest|first letter|initial/i.test(name)) return "What word do the first letters spell?";
  if (/count/i.test(name)) return "How many did you count?";
  if (/pair|match/i.test(name)) return "Which pairs are exactly the same?";
  if (/difference/i.test(name)) return "What do the differences spell when you read them in order?";
  if (/hidden|spot|search|scene/i.test(name)) return "What do the found objects spell when you read them in order?";
  return "What word or number did the puzzle just give you?";
}

function vagueRecovery(recovery) {
  return /unique elements|historical features|discovers that|significance/i.test(String(recovery || ""))
    && !spelledToken(recovery);
}

function analysisProblems(analysis, mechanic, themePlay) {
  const problems = [];
  const question = analysis.fact_question.toLowerCase();
  const recovery = analysis.how_the_child_recovers_the_fact;
  const route = isRouteMechanic(mechanic);
  if (RECALL_QUESTION.test(question)) {
    problems.push(`fact_question asks the child to recall or reflect. Replace it with: ${playQuestion(mechanic)}`);
  }
  if (vagueRecovery(recovery)) {
    problems.push("Name the words, letters, stops, or objects in order. 'Unique elements' and 'discovers that it was the capital' are not a puzzle.");
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
  if (typeof next.artwork_instructions !== "string") {
    next.artwork_instructions = plainText(next.artwork_instructions);
  }
  if (typeof next.playable_state === "string") {
    try {
      next.playable_state = JSON.parse(next.playable_state);
    } catch (_) {
      next.playable_state = { items: [] };
    }
  }
  if (typeof next.fact_connection === "string") {
    next.fact_connection = { child_action: "", fact: "", evidence: next.fact_connection };
  }
  if (typeof next.solution === "string") {
    next.solution = { final_answer: next.solution, correct_route: "", collected_letters: "", pairs: [] };
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
      ...(item.section ? { section: item.section } : {}),
    })),
  }));
}

function normalizeThemeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findTheme(themes, raw) {
  const key = normalizeThemeKey(raw);
  if (!key) return null;
  const exact = themes.find((item) => normalizeThemeKey(item.slug) === key || normalizeThemeKey(item.name) === key);
  if (exact) return exact;
  const words = key.split("-").filter((word) => word.length > 3);
  let best = null;
  let bestScore = 0;
  for (const item of themes) {
    const hay = `${normalizeThemeKey(item.slug)}-${normalizeThemeKey(item.name)}`;
    const score = words.filter((word) => hay.includes(word)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function themeForTopic(themes, topic) {
  const making = /\b(make|creat\w*|name|powers?|invent|build|hang)\b/i.test(String(topic || ""));
  const ranked = themes.filter((item) => {
    const play = themePlayFrom(item);
    return !(play && play.exactPairs && !topicWantsExactPairs(topic));
  });
  const pool = ranked.length ? ranked : themes;
  if (!making) return pool[0] || null;
  return pool.find((item) => /creat|invent|notebook|mess|make/i.test(`${item.slug} ${item.name}`)) || pool[0] || null;
}

function themeIsExactPairs(theme) {
  if (theme && theme.exact_pairs) return true;
  const play = themePlayFrom(theme);
  return Boolean(play && play.exactPairs);
}

function mechanicTextOf(category, mechanicName) {
  const mechanic = (category && category.mechanics || []).find((item) => item.name === mechanicName);
  return `${mechanicName} ${mechanic && mechanic.blurb ? mechanic.blurb : ""}`.trim();
}

async function selectAndAnalyze({ apiKey, model, topic, input, categories, themes, activityRows, themeRows, locks }) {
  const allowRoute = (Boolean(locks.mechanicName) && isRouteMechanic(locks.mechanicName)) || topicHasTraversal(topic);
  const allowPairs = Boolean(locks.userLocked.theme) || topicWantsExactPairs(topic);
  const activityRanked = shortlistActivities(activityRows, topic, {
    allowRoute,
    categoryId: locks.category ? locks.category.category_id : null,
    mechanicName: locks.mechanicName,
    limit: 8,
    perFamily: 3,
  });
  if (!activityRanked.length) throw new Error("No library activities were available.");
  const themeRanked = locks.theme
    ? []
    : shortlistThemes(themeRows, topic, { allowRoute, allowPairs, limit: 6, perFamily: 2 });
  const lockedRecord = locks.theme
    ? themeRows.find((row) => row.slug === locks.theme.slug) || locks.theme
    : null;
  let themeChoices = lockedRecord
    ? [themeSelectionBrief(lockedRecord)]
    : themeRanked.map((item) => item.brief);
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
            activity_references: activityRanked.map((item) => item.brief),
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
  const mechanicText = mechanicTextOf(winner.category, winner.mechanic);
  if (!locks.theme) {
    let showing = themeChoices.filter((theme) => themeCanShow(theme, mechanicText));
    if (!showing.length) {
      showing = themeRows.map((row) => themeSelectionBrief(row)).filter((theme) => themeCanShow(theme, mechanicText)).slice(0, 6);
    }
    if (showing.length) themeChoices = showing;
  }
  const references = pickReference(
    rankActivities(activityRows, topic, {
      allowRoute,
      categoryId: locks.category ? locks.category.category_id : null,
      mechanicName: locks.mechanicName,
    }),
    mechanicText,
    winner.activity_id
  );
  const referenceBrief = references[0] ? activityConstruction(references[0]) : null;

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
            activity_reference: referenceBrief,
            themes: themeChoices,
            ...(attempt > 1 ? {
              repair: problems,
              rejected_question: analysis.fact_question,
              replace_fact_question_with: playQuestion(winner.mechanic),
            } : {}),
          }),
        },
      ],
    });
    analysis = readAnalysis(analyzed, affordances);
    problems = [];
    if (!locks.theme) {
      const raw = analyzed.theme_slug || analyzed.themeSlug || analyzed.theme_name || analyzed.theme || "";
      theme = findTheme(themeChoices, raw) || themeChoices[0] || themeForTopic(themes, topic);
    }
    const themePlay = themeIsExactPairs(theme) ? { exactPairs: true, pairCount: null } : themePlayFrom(theme);
    if (!locks.theme && !themeCanShow(theme, mechanicText)) {
      problems.push("This theme cannot display the locked mechanic. Do not choose a doodle, drawing, or craft theme for a word, code, table, or maze. Choose a theme that can show the puzzle.");
    } else if (themePlay && themePlay.exactPairs && !locks.userLocked.theme && !topicWantsExactPairs(topic)) {
      problems.push("This topic is not about finding identical things. Do not choose a pair-matching theme. Choose a theme whose play uses the topic's own verb, such as making, naming, building, or placing.");
    } else {
      settlePairQuestion(analysis, themePlay, topic, locks.userLocked.theme);
      problems = problems.concat(analysisProblems(analysis, winner.mechanic, themePlay));
    }
    if (!problems.length) break;
  }
  const recallOnly = problems.length > 0 && problems.every((problem) => /fact_question asks the child to recall|Name the words, letters/.test(problem));
  if (recallOnly) {
    analysis.fact_question = playQuestion(winner.mechanic);
    if (vagueRecovery(analysis.how_the_child_recovers_the_fact)) {
      analysis.how_the_child_recovers_the_fact = `The child finishes ${winner.mechanic}. List every word, object, or stop in order. Those items alone produce the answer. The question is "${analysis.fact_question}" The child cannot reach the fact by remembering it.`;
    }
    problems.length = 0;
  }
  if (problems.length) {
    throw new Error(`The analysis did not turn the topic into play. ${problems[0]} Question was: ${analysis.fact_question} Recovery was: ${analysis.how_the_child_recovers_the_fact.slice(0, 220)}`);
  }

  if (!theme) throw new Error("The model chose a theme that is not in the catalog.");
  const why = String(analyzed.why || winner.why || "").trim();
  if (!why) throw new Error("The selection did not explain its choice. Try again.");

  const specId = String(analyzed.activity_spec_id || analyzed.activitySpecId || "").trim();
  return {
    selection: {
      category_id: winner.category.category_id,
      category_name: winner.category.name,
      mechanic: winner.mechanic,
      theme: { name: theme.name, slug: theme.slug },
      activity_reference: references[0]
        ? { activity_id: references[0].activity_id, title: references[0].title }
        : null,
      construction_method: mechanicText,
      activity_spec_id: specId || null,
      why,
      locked_by_user: locks.userLocked,
    },
    analysis,
    category: winner.category,
    referenceRows: references,
    specId,
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

function draftProblems(activity, topic, puzzleCatalog, mechanicText, analysis) {
  return [
    ...pairLogicProblems(activity, puzzleCatalog && puzzleCatalog.theme_play),
    ...constructionProblems(activity, {
      topic,
      mechanic: activity && activity.mechanic,
      mechanicText,
      analysis,
    }),
  ];
}

async function reviewActivity({ apiKey, model, topic, activity, puzzleCatalog, analysis, mechanicText }) {
  let current = activity;
  let review = [];
  let previousFixes = draftProblems(current, topic, puzzleCatalog, mechanicText, analysis);
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
            instruction: "This activity is an untrusted draft. Approval is binary. Keep the locked mechanic. Do not rebuild an acrostic into a visual search, or a spot-the-difference into a hidden-object hunt. If the mechanic is an acrostic, replace the word list so the first letters spell the answer exactly, and remove the answer from the title, puzzle, instructions, and artwork. If theme_play.exactPairs is true, the child finds identical visual twins. Performing the play must produce analysis.fact. Rebuild the activity. Artwork has not been generated.",
            topic,
            analysis,
            puzzle_catalog: puzzleCatalog,
            activities: [current],
            ...(previousFixes.length ? { code_checks: previousFixes, repair: "The draft failed these checks. Return a replaced activity in which they are already fixed." } : {}),
          }),
        },
      ],
    });
    const checked = applyReview([current], parsed);
    current = checked.activities[0];
    review = checked.review;
    const logic = draftProblems(current, topic, puzzleCatalog, mechanicText, analysis);
    const modelFixes = review[0] && Array.isArray(review[0].fixes) ? review[0].fixes.filter(Boolean) : [];
    if (logic.length) {
      review = [{ title: current.title || "", passed: false, fixes: [...new Set([...logic, ...modelFixes])] }];
      previousFixes = logic;
      continue;
    }
    previousFixes = modelFixes;
    if (reviewPassed(review)) break;
  }
  return { activities: [current], review, problems: draftProblems(current, topic, puzzleCatalog, mechanicText, analysis) };
}

function issueType(text) {
  const value = String(text || "");
  if (/first letters|must spell|collected_letters/i.test(value)) return "ACROSTIC_INVALID";
  if (/one mechanic|seek-and-find|different mechanic|two panels/i.test(value)) return "MECHANIC_MIXING";
  if (/child-facing|artwork tells|recall the fact/i.test(value)) return "ANSWER_LEAK";
  if (/not things a child can find|concrete words/i.test(value)) return "UNPLAYABLE_ITEMS";
  return "VALIDATION";
}

function issueRecords(problems) {
  return problems.map((details) => ({
    type: issueType(details),
    severity: "critical",
    details,
  }));
}

async function authorRepair({ apiKey, model, topic, activity, analysis, problems, selection }) {
  const drafted = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: loadSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          task: "The activity below is rejected. Write a replacement that passes every code_check. Keep the locked mechanic. Do not switch to another mechanic. For an acrostic, print an ordered list of concrete words whose first letters spell final_answer exactly. Do not put that answer in the title, puzzle, instructions, components, or artwork.",
          code_checks: problems,
          locked_mechanic: selection.mechanic,
          topic,
          analysis,
          rejected_activity: activity,
          output_shape: outputShape(),
        }),
      },
    ],
  });
  return normalizeActivity(forceSelection(takeActivity(drafted), selection));
}

async function generateActivities(input) {
  const topic = String(input.content || "").trim();
  if (topic.length < 20) {
    throw new Error("Write a short paragraph about the topic.");
  }

  const apiKey = input.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Add an OpenRouter API key.");
  const model = String(input.model || process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();

  const [categories, catalog, activityRows, themeRows] = await Promise.all([
    getCategoriesBrief(),
    getCatalog(),
    getActivityRecords(),
    getThemeRecords(),
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
    activityRows,
    themeRows,
    locks,
  });

  const theme = await getTheme(chosen.selection.theme.slug);
  if (!theme) throw new Error("That theme was not found.");
  const themePlay = applyThemePlay(chosen, theme, categories, locks, topic);
  const specs = Array.isArray(theme.activity_specs) ? theme.activity_specs : [];
  const resolvedSpec = specs.find((spec) => spec && spec.id === chosen.specId) || specs[0] || null;
  if (resolvedSpec && resolvedSpec.id) chosen.selection.activity_spec_id = resolvedSpec.id;
  const mechanic = (chosen.category.mechanics || []).find((item) => item.name === chosen.selection.mechanic) || {
    name: chosen.selection.mechanic,
    blurb: themePlay && themePlay.summary || "",
    output_types: themePlay && themePlay.exactPairs ? ["exact visual pairs"] : [],
  };
  const puzzleCatalog = catalogBlockFor(chosen.category, chosen.selection.mechanic, themePlay);
  const payload = buildGenerationPayload({
    topic,
    age: ageNote(input),
    difficulty: difficultyNote(input),
    analysis: chosen.analysis,
    selection: chosen.selection,
    category: chosen.category,
    mechanic,
    theme,
    activityRows: chosen.referenceRows,
    specId: chosen.selection.activity_spec_id,
  });
  if (themePlay) payload.theme_play = themePlay;

  const drafted = await callOpenRouter({
    apiKey,
    model,
    messages: [
      { role: "system", content: loadSystemPrompt() },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  let activity = normalizeActivity(forceSelection(takeActivity(drafted), chosen.selection));
  let review = [];
  let reviewError = "";
  let problems = draftProblems(activity, topic, puzzleCatalog, chosen.selection.construction_method, chosen.analysis);
  try {
    const checked = await reviewActivity({
      apiKey,
      model,
      topic,
      activity,
      puzzleCatalog,
      analysis: chosen.analysis,
      mechanicText: chosen.selection.construction_method,
    });
    activity = normalizeActivity(forceSelection(checked.activities[0], chosen.selection));
    review = checked.review;
    problems = checked.problems;
    for (let repair = 1; repair <= 2 && problems.length; repair += 1) {
      activity = await authorRepair({
        apiKey,
        model,
        topic,
        activity,
        analysis: chosen.analysis,
        problems,
        selection: chosen.selection,
      });
      problems = draftProblems(activity, topic, puzzleCatalog, chosen.selection.construction_method, chosen.analysis);
      review = [{ title: activity.title || "", passed: problems.length === 0, fixes: problems }];
    }
  } catch (error) {
    reviewError = error.name === "TimeoutError"
      ? "The review took too long."
      : error.message;
    if (!problems.length) problems = [reviewError];
  }

  const accepted = problems.length === 0 && !reviewError;
  return {
    status: accepted ? "VALIDATED" : "REJECTED",
    ready_for_rendering: accepted,
    issues: issueRecords(problems),
    selection: chosen.selection,
    analysis: chosen.analysis,
    activity: accepted ? activity : null,
    rejected_activity: accepted ? null : activity,
    review,
    model,
    ...(reviewError ? { review_error: reviewError } : {}),
  };
}

module.exports = { generateActivities };
