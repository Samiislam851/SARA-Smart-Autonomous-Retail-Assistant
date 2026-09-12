/**
 * Books need a fundamentally different title/description composer than the
 * generic "{brand} {adjective} {noun}" formula used everywhere else — a
 * book's "brand" is its author, and its title is evocative rather than
 * descriptive. `generate.ts` special-cases `categorySlug === "books"` and
 * reads from this file instead of the generic fragment pools.
 *
 * Genre keys here match `noun` on each Books `ProductLineTemplate` in
 * `categories.ts` exactly — that's the join key between the two files.
 */

export const AUTHOR_FIRST_NAMES = [
  "Eleanor", "Marcus", "Priya", "Daniel", "Sofia", "James", "Hannah", "Miles",
  "Clara", "Nathaniel", "Ava", "Thomas", "Yusuf", "Ingrid", "Marisol", "Owen",
];

export const AUTHOR_LAST_NAMES = [
  "Whitfield", "Okafor", "Bennett", "Ramirez", "Chen", "Sinclair", "Hawthorne",
  "Delgado", "Voss", "Marlow", "Tanaka", "Okonkwo", "Reyes", "Petrov", "Lindqvist",
];

const EVOCATIVE_ADJECTIVES = [
  "Quiet", "Hidden", "Long", "Last", "Golden", "Silent", "Distant", "Forgotten",
  "Wild", "Endless", "Amber", "Restless", "Northern", "Secret",
];

const EVOCATIVE_NOUNS = [
  "Harbor", "River", "Garden", "Mountain", "Ember", "Shadow", "Orchard",
  "Horizon", "Lantern", "Meadow", "Coast", "Forest", "Storm", "Valley", "Hollow",
  "Bridge", "Tide", "Field", "Compass",
];

const PLACES = [
  "Cedar Falls", "Alderbrook", "Port Mira", "Hollow Creek", "Bellhaven",
  "Winter's End", "the North Shore", "Willow Bend",
];

const CUISINES = [
  "Mediterranean", "Weeknight", "Farmhouse", "Coastal", "Harvest", "Sunday",
  "Family", "Rustic", "Everyday", "Fireside",
];

const CONCEPTS = [
  "Focus", "Discipline", "Momentum", "Clarity", "Growth", "Balance", "Habits",
  "Leadership", "Resilience", "Purpose", "Strategy", "Confidence",
];

const CHILD_NAMES = [
  "Luna", "Milo", "Zoe", "Oscar", "Nina", "Theo", "Ruby", "Sam", "Ivy", "Leo",
  "Maya", "Jack",
];

const REGIONS = [
  "North America", "the Pacific Northwest", "the Eastern Seaboard",
  "the Rocky Mountains", "the British Isles", "Southeast Asia",
  "the Mediterranean", "the Great Lakes",
];

const SUBJECTS = [
  "Birds", "Wildflowers", "Trees", "Mushrooms", "Insects", "Constellations",
  "Coastal Fish", "Native Plants",
];

const POETIC_WORDS = [
  "Salt", "Starlight", "Ash", "Bone", "Rain", "Smoke", "Glass", "Thistle",
  "Moonlight", "Dust", "Wildfire", "Feather",
];

const TRAVEL_PLACES = [
  "Portugal", "Northern Italy", "Kyoto", "Iceland", "the Scottish Highlands",
  "Vietnam", "Patagonia", "the Greek Islands", "Morocco", "New Zealand",
];

const HISTORY_TOPICS = [
  "the Fur Trade", "the Railroad Age", "the Silk Road",
  "the Industrial Revolution", "the Age of Sail", "the Cold War",
  "the Printing Press", "Ancient Trade Routes", "the Great Migration",
  "the Steel Industry",
];

/**
 * Closers for Books. The generic `CLOSING_FRAGMENTS` pool talks about
 * warranties and surviving daily use, which reads as absurd under a novel;
 * Books draw from here instead.
 */
export const BOOK_CLOSING_FRAGMENTS = [
  "A strong pick for a book club looking for something to argue about.",
  "Reads well in a single weekend, or a chapter at a time on the commute.",
  "One of those books people quietly press into a friend's hands.",
  "Printed on heavy stock with a sewn binding that will survive a few rereads.",
];

/**
 * Sentence frames that name the genre in plain English. `{label}` is the
 * genre's `searchLabel`; one of these is always appended so a shopper
 * searching "cookbook" or "novel" gets `$text` hits for titles that never
 * contain the genre word. Several frames, rather than one, so 30 books do
 * not all end on the same sentence.
 */
export const BOOK_GENRE_SENTENCES = [
  "Shelved under {label}.",
  "A {label} that earns a spot on your shelf.",
  "Filed with our staff-pick {label} selection.",
  "If you are browsing {label}, start here.",
  "A {label} we come back to recommending again and again.",
];

export interface BookGenreConfig {
  /** Title templates. Tokens are resolved by `resolveBookTemplate` in generate.ts. */
  titleTemplates: string[];
  /** Word pools available to this genre's templates, keyed by token name. */
  tokens: Record<string, string[]>;
  descriptionFragments: string[];
  /**
   * Plain-English genre name, e.g. "cookbook". Evocative titles like "The
   * Weeknight Kitchen" never contain the genre word itself, so
   * `generate.ts` always appends one sentence naming it — otherwise a
   * shopper searching "cookbook" or "novel" would get zero `$text` hits
   * despite matching products existing.
   */
  searchLabel: string;
}

export const BOOK_GENRES: Record<string, BookGenreConfig> = {
  novel: {
    titleTemplates: [
      "The {Adj} {Noun}",
      "{Adj} {Noun}",
      "The {Noun} of {Place}",
      "A {Adj} {Noun}",
      "The Last {Noun}",
      "{Place}",
      "The {Noun} We Left Behind",
      "Everything After the {Noun}",
      "The {Adj} Hour",
      "What the {Noun} Remembers",
      "The Year of the {Noun}",
      "{Adj} Ground",
    ],
    tokens: { Adj: EVOCATIVE_ADJECTIVES, Noun: EVOCATIVE_NOUNS, Place: PLACES },
    descriptionFragments: [
      "A quiet, character-driven story about family, memory, and the choices that shape a life.",
      "Spare, atmospheric prose carries this story from its first page to its last.",
      "A slow-burning story that rewards readers willing to sit with its characters.",
      "Told across two timelines, it gradually reveals what really happened.",
    ],
    searchLabel: "novel",
  },
  cookbook: {
    titleTemplates: [
      "The {Cuisine} Table",
      "The {Cuisine} Kitchen",
      "{Cuisine} Cooking, Simplified",
      "The {Adj} Cookbook",
      "Cooking for {Cuisine} Nights",
      "The Art of {Cuisine} Cooking",
      "{Cuisine} Suppers",
      "The Complete {Cuisine} Cookbook",
    ],
    tokens: { Cuisine: CUISINES, Adj: EVOCATIVE_ADJECTIVES },
    descriptionFragments: [
      "Over 100 tested recipes built around ingredients you can actually find at a regular grocery store.",
      "Each recipe includes make-ahead notes and simple substitutions for weeknight cooking.",
      "Organized by season, with full-colour photos for nearly every recipe.",
      "Written for home cooks who want reliable results without a pantry full of specialty ingredients.",
    ],
    searchLabel: "cookbook",
  },
  "self-help and business": {
    titleTemplates: [
      "Deep {Concept}",
      "The {Concept} Advantage",
      "Mastering {Concept}",
      "{Concept} by Design",
      "The Art of {Concept}",
      "Small Steps, Big {Concept}",
      "Rethinking {Concept}",
      "The {Concept} Mindset",
    ],
    tokens: { Concept: CONCEPTS },
    descriptionFragments: [
      "Drawing on research and real-world case studies, it offers a practical framework you can apply immediately.",
      "Short chapters and clear takeaways make it easy to put into practice one habit at a time.",
      "A no-nonsense guide for anyone who feels busy but not productive.",
      "Backed by interviews with founders, coaches, and everyday readers who tested the ideas themselves.",
    ],
    searchLabel: "self-help book",
  },
  "children's picture book": {
    titleTemplates: [
      "{Name} and the {Noun}",
      "{Name}'s Big {Adj} Day",
      "The {Adj} Adventures of {Name}",
      "{Name} and the {Adj} {Noun}",
      "Goodnight, {Name}",
      "{Name} Finds a {Noun}",
    ],
    tokens: { Name: CHILD_NAMES, Adj: EVOCATIVE_ADJECTIVES, Noun: EVOCATIVE_NOUNS },
    descriptionFragments: [
      "A gentle, richly illustrated story perfect for bedtime reading aloud.",
      "Bright, playful artwork on every page keeps little readers engaged start to finish.",
      "A warm story about curiosity and kindness, told in simple, rhythmic language.",
      "Recommended for ages 3 to 7, and a favourite for repeat read-alouds.",
    ],
    searchLabel: "picture book",
  },
  "biography and memoir": {
    titleTemplates: [
      "The {Adj} Years",
      "{Adj} Ground: A Memoir",
      "Notes from the {Noun}",
      "The Long Way Home",
      "A {Adj} Life",
      "Becoming {Adj}",
      "The {Noun} and Me: A Memoir",
      "Out of the {Noun}",
    ],
    tokens: { Adj: EVOCATIVE_ADJECTIVES, Noun: EVOCATIVE_NOUNS },
    descriptionFragments: [
      "A candid, unflinching account told in the author's own voice.",
      "Part memoir, part reflection on family, ambition, and starting over.",
      "Praised for its honesty about failure as much as success.",
      "A moving portrait of an ordinary life shaped by extraordinary circumstances.",
    ],
    searchLabel: "memoir",
  },
  "field guide and reference": {
    titleTemplates: [
      "The {Subject} of {Region}",
      "A Field Guide to the {Subject} of {Region}",
      "{Subject}: A Field Guide",
      "The Backyard {Subject} of {Region}",
    ],
    tokens: { Subject: SUBJECTS, Region: REGIONS },
    descriptionFragments: [
      "Full-colour illustrations and clear identification notes make this ideal for beginners and experts alike.",
      "Organized for quick reference in the field, with range maps and seasonal notes.",
      "A trusted companion for hikers, naturalists, and curious backyard observers.",
      "Includes a durable, water-resistant cover built for outdoor use.",
    ],
    searchLabel: "field guide",
  },
  "graphic novel": {
    titleTemplates: [
      "{Adj} {Noun}: Book One",
      "The {Noun} Chronicles",
      "{Noun}fall",
      "{Adj} {Noun}: Volume One",
      "The Last {Noun}: Book One",
    ],
    tokens: { Adj: EVOCATIVE_ADJECTIVES, Noun: EVOCATIVE_NOUNS },
    descriptionFragments: [
      "Bold, atmospheric artwork drives this first volume of an ongoing series.",
      "A fast-paced story with striking panel work and a cliffhanger ending.",
      "Collects the first arc in full colour, with bonus concept art.",
      "A fresh entry point for readers new to the series and longtime fans alike.",
    ],
    searchLabel: "graphic novel",
  },
  "poetry collection": {
    titleTemplates: [
      "{Word1} and {Word2}",
      "The Weight of {Word1}",
      "{Adj} {Word1}",
      "What the {Word1} Knows",
    ],
    tokens: { Word1: POETIC_WORDS, Word2: POETIC_WORDS, Adj: EVOCATIVE_ADJECTIVES },
    descriptionFragments: [
      "A collection of spare, image-driven poems about memory, distance, and home.",
      "Quiet and precise, these poems reward slow reading and rereading.",
      "A debut collection that has drawn comparisons to some of the genre's most understated voices.",
      "Best read in small doses, one or two poems at a sitting.",
    ],
    searchLabel: "poetry collection",
  },
  "travel guide": {
    titleTemplates: [
      "The Hidden Coast: A Traveler's Guide to {Place2}",
      "{Place2}: The Complete Traveler's Guide",
      "Off the Beaten Path in {Place2}",
      "A Traveler's Guide to {Place2}",
      "{Adj} Roads: Exploring {Place2}",
    ],
    tokens: { Place2: TRAVEL_PLACES, Adj: EVOCATIVE_ADJECTIVES },
    descriptionFragments: [
      "Includes neighbourhood maps, day-trip itineraries, and up-to-date practical advice.",
      "Written by a local contributor, with recommendations well beyond the usual tourist stops.",
      "Covers where to stay, where to eat, and how to get around without overspending.",
      "Updated with current transit information and seasonal travel tips.",
    ],
    searchLabel: "travel guide",
  },
  history: {
    titleTemplates: [
      "The {Adj} Winter: A History of {Topic}",
      "A History of {Topic}",
      "The Rise and Fall of {Topic}",
      "{Adj} Empire: The Story of {Topic}",
      "The Long Road: A History of {Topic}",
    ],
    tokens: { Adj: EVOCATIVE_ADJECTIVES, Topic: HISTORY_TOPICS },
    descriptionFragments: [
      "Drawing on original archives and firsthand accounts, it traces a turning point often left out of the standard narrative.",
      "A meticulously researched account written for general readers, not just historians.",
      "Balances big-picture context with the small, human stories that usually get lost.",
      "Includes maps, timelines, and photographs throughout.",
    ],
    searchLabel: "history book",
  },
};
