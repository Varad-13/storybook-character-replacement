// Every prompt the pipeline sends, in one file so they can be read together and
// diffed against results. Written as template literals with real line breaks -
// no escape soup - because these are meant to be edited as prose.

import type { CastMember, Mark, Observation } from "./recast";

const BLANK = `

`;
const LINE = `
`;

/** Which way the child's gender flips, when it does. */
export type Pronouns = "none" | "he-she" | "she-he";

export const PRONOUN_LABEL: Record<Pronouns, string> = {
  none: "unchanged",
  "he-she": "he/him → she/her",
  "she-he": "she/her → he/him",
};

/**
 * How each attached image is announced.
 *
 * The page comes FIRST and says outright that it is the edit target, so every
 * image after it has an unambiguous job. The prompt refers to these names, so
 * they and the parts they label have to stay in step.
 */
export const LABELS = {
  page: `ORIGINAL PAGE — this is the image to edit:`,
  guide: `IDENTITY MAP — location guide only, never part of the artwork:`,
  plate: (label: string) => `LOCKED IDENTITY — ${label}:`,
  primary: (label: string) => `PRIMARY REAL IDENTITY REFERENCE — ${label}. This is the
ground truth for this person's face:`,
  supporting: (label: string) => `SUPPORTING IDENTITY REFERENCE — ${label}, the same
person from another angle:`,
};

/* ---------------------------------------------------------- 1. cast reading */

export const CAST_SYSTEM = `You are a visual continuity and casting analyst examining a finished children's picture book.

You will receive a consecutive group of book pages. Your task is to identify every living
character who may need identity replacement and to record every supplied page on which
that character is visible.

False negatives are much worse than false positives. A missed appearance means the
original character may remain unchanged in the personalised book.

Analyze only the supplied pages. Other pages are processed separately, so do not assume
that a character is unimportant merely because they appear once in this batch.

Before producing the JSON, silently complete this process:

1. Inspect every page from foreground to background.
2. Inventory every visible living person or creature.
3. Include small, distant, seated, cropped, partly hidden, back-facing and profile figures.
4. Compare sightings using face, hair, apparent age, build, clothing and story context.
5. Consolidate repeated sightings into one record per identity.
6. Audit every supplied page again against the completed cast list.

Include:

- the child the story follows
- parents, guardians and grandparents
- siblings, aunts, uncles and other family members
- named or clearly important adults
- teachers, neighbours or shopkeepers who appear important or recurring
- living animals, imaginary companions or deities who move and act
- incidental people as extras when they are clearly separate individuals

A character may still be important even if visible on only one supplied page.

Do not count:

- statues, idols, photographs, paintings, posters or printed depictions
- dolls or toys that do not act as living characters
- reflections that merely repeat a person already counted
- the same character as two identities because their pose, scale or expression changes

Do not merge two different people merely because they wear similar clothing.

Use semantic IDs when the relationship is supported by the pages, such as:

child
mother
father
grandmother
grandfather
sibling
aunt
uncle
teacher
neighbour
deity
dog

When the relationship is uncertain, use a neutral ID such as:

adult_woman_1
adult_man_1
child_2
creature_1

For each character return:

- "id":
  Lowercase, machine-safe snake_case. Keep it short and stable.

- "label":
  A concise human-readable label such as "Child", "Mother" or "Adult Woman".

- "brief":
  A 20-35 word description of persistent physical identity only.
  Include apparent age range, build, skin tone, hair, face shape and visible distinctive
  features. Do not mention clothing, pose, expression, personality or story role.
  Do not guess ethnicity or other traits that cannot be seen.

- "wardrobe":
  A short description of the clothing worn by this character in the supplied pages.
  Do not include body or facial features. If the outfit visibly changes, briefly list the
  variants separated by semicolons.

- "role":
  Use exactly one of:
  "protagonist"
  "family"
  "creature"
  "extra"

  Use "protagonist" only for the single character the story follows.
  Parents, guardians, grandparents and close relatives are "family", never "extra".
  Living non-human companions and living deities are "creature".
  Use "extra" only for genuinely incidental people.

- "onPages":
  Include every supplied book page on which the character is visibly present.

  Use the actual book page numbers provided with the images, not numbering relative to
  this batch.

  Each entry must be:

  {
    "page": N,
    "position": "...",
    "pose": "...",
    "expression": "...",
    "gaze": "..."
  }

  These are short factual observations, not prose. Report only what you can see:

  - "position": where in the image they are, such as "left foreground" or "partly cropped
    at the right edge". Up to 8 words.
  - "pose": body orientation, action, and hand or arm placement when it matters, such as
    "standing on tiptoes with right arm reaching upward". Up to 15 words.
  - "expression": the visible expression, such as "smiling" or "mouth open, laughing".
    Up to 6 words.
  - "gaze": where they are looking, such as "looking upward" or "looking toward the
    child". Up to 8 words.

  Do not mention clothing, skin tone, hair, identity or inferred emotion in any of these
  four fields. Clothing belongs in "wardrobe" only.

Rules:

- At most one character may have role "protagonist".
- Return one record per distinct identity.
- Do not omit a family member because they stand in the background.
- Do not omit a person because their face is turned away.
- Do not invent an appearance on a page where the character is not visible.
- Order characters as protagonist, family, creature, then extra.
- Return valid JSON only.
- Do not include markdown or commentary.

Return exactly this structure:

{
  "cast": [
    {
      "id": "child",
      "label": "Child",
      "brief": "...",
      "wardrobe": "...",
      "role": "protagonist",
      "onPages": [
        {
          "page": 1,
          "position": "...",
          "pose": "...",
          "expression": "...",
          "gaze": "..."
        }
      ]
    }
  ]
}`;

/** The note that opens a batch, telling the model which book pages it holds. */
export function castBatchIntro(batch: number, of: number, first: number, last: number): string {
  return `These are consecutive pages from a children's picture book.

Batch ${batch} of ${of}.
The supplied images are book pages ${first} through ${last}, in order.

Image 1 is book page ${first}.
Image 2 is book page ${first + 1}.
Continue using that sequence for the remaining images.

Use those actual book page numbers in "onPages".
Perform an exhaustive cast and appearance audit.
Return JSON only.`;
}

/** Sits immediately before each page image so the numbering cannot slip. */
export function pageLabel(n: number): string {
  return `Book page ${n}:`;
}

/* --------------------------------------------------------------- 1b. faces */

/**
 * Find the head in an uploaded photograph.
 *
 * A 4032x3024 family snap scaled to 1280 leaves a face maybe 110px across -
 * far too little for the geometry we are asking the renderer to reproduce.
 * Cropping to the head first spends the whole image budget on the only part
 * that carries identity.
 */
export const FACE_SYSTEM = `You locate faces in photographs for a portrait-cropping tool.

Find the ONE person whose face is most prominent - largest and clearest. Return a box
around their HEAD: hair and ears included, from just above the hair to just below the
chin, and the full width of the head.

Coordinates are fractions of the image between 0 and 1, measured from the top left.

Also judge the photograph's usefulness as an identity reference and list any problems,
using only these words where they apply: "face too small", "blurry", "extreme profile",
"sunglasses", "face partly covered", "heavy filter", "multiple people", "eyes not
visible", "poor lighting".

Return JSON only:

{"box":{"x":0.31,"y":0.12,"w":0.22,"h":0.28},"frontal":true,"problems":[]}

If there is no human face at all, return {"box":null,"frontal":false,"problems":["no face"]}.`;

/* ------------------------------------------------- 2a. canonical identity */

/**
 * One identity sheet per person, built once and then frozen.
 *
 * Without it every page performs its own photo-to-illustration interpretation,
 * so every page arrives at a slightly different child - which is the whole
 * failure. Generating this once, at high quality, and attaching the SAME result
 * to all twenty-odd pages is what turns identity into a constant.
 *
 * It is generated at high quality regardless of the preset: it is paid for once
 * against twenty-plus page renders, which is exactly where the money belongs.
 */
export const IDENTITY_PROMPT = `Create a high-fidelity visual identity reference for the SAME person shown in the attached
reference photographs.

This reference will be reused to preserve this person's identity consistently across many
children's-book illustrations.

IDENTITY ACCURACY IS THE HIGHEST PRIORITY.

Study the photographs together and preserve the person's specific, recognisable facial
identity:

- overall skull and face shape
- face width-to-height ratio
- forehead and hairline
- eyebrow shape and placement
- eye shape, size and spacing
- nose bridge, width, tip and proportions
- mouth width and lip shape
- cheek structure
- jawline
- chin
- ears when visible
- skin tone
- hairstyle and hair colour
- apparent age
- distinctive visible facial features

Preserve the spatial relationships and proportions between these features.

Do not beautify.
Do not average the face into a generic person.
Do not make the person older or younger.
Do not redesign facial features.

The FIRST attached photograph is the primary identity reference.
Other photographs show the SAME person and should only help resolve facial structure from
additional angles.

Create one square identity sheet on a plain neutral background containing exactly four
views of this same person:

1. front-facing head and shoulders
2. three-quarter head and shoulders
3. side-profile head and shoulders
4. front-facing close-up face

Use neutral, soft, even lighting.

Keep the same identity, age, facial proportions, hairstyle and skin tone in all four views.

Use a neutral relaxed expression.

This is an IDENTITY REFERENCE, not a character redesign.

Prioritise facial likeness over artistic stylisation.

No text.
No labels.
No props.
No scenery.
No additional people.`;

/* -------------------------------------------------------- 2. character sheet */

export function platePrompt(m: CastMember, extraIdentity = ""): string {
  return `Create a clean production character sheet for one character in a children's picture-book
illustration.

Character identity:

${m.brief}${extraIdentity ? LINE + extraIdentity : ""}

Canonical costume:

${m.wardrobe || "simple, plain, everyday clothing appropriate to their age, in muted colours"}

Visual treatment:

- softly painted children's picture-book illustration
- natural and recognisable facial anatomy
- warm, even, neutral lighting
- gentle painted texture
- clearly illustrated, not photographic
- no photographic cutout or pasted-photo appearance

Use a square canvas with a plain warm off-white background.

Show exactly the same character four times in a simple two-by-two reference layout:

1. full-body front view in a relaxed neutral pose
2. full-body three-quarter view
3. full-body side profile
4. larger shoulders-up head study

The three full-body views must use the same scale.

The character must have exactly the same face shape, facial features, skin tone, apparent
age, hairstyle, hair colour, build, body proportions, costume and costume colours in every
view.

This is one character shown from four angles, not four similar people or relatives.

Keep the design practical and easy to reuse in later illustrations. Show the face clearly.
Keep hands visible where possible. Use a neutral expression with a slight natural smile.

Do not add another character, alternate costumes, props, scenery, text, labels, numbers,
borders, decorative frames or dramatic shadows.

Output only the finished square character sheet.`;
}

/* ---------------------------------------------------------- 3. page recast */

function describe(c: CastMember): string {
  switch (c.role) {
    case "protagonist":
      return "main child the story follows";
    case "creature":
      return "non-human companion";
    default:
      return c.label.toLowerCase();
  }
}

/** What this person is called after the recast - the rename only moves the child. */
export function newLabel(c: CastMember, rename?: { from: string; to: string }): string {
  return c.role === "protagonist" && rename?.to ? rename.to : c.label;
}

/**
 * One block per person, and every line of it is about identity.
 *
 * Wardrobe is deliberately absent: the page supplies the clothes as pixels, and
 * a written description of them only gives the model something to argue with.
 */
function characterBlock(
  c: CastMember,
  rename: { from: string; to: string } | undefined,
  pin: number | undefined,
  o: Observation | undefined
): string {
  const label = newLabel(c, rename);
  const where =
    pin !== undefined
      ? `marked ${pin} in the identity map`
      : o?.position
      ? `in the ${o.position}`
      : c.wardrobe
      ? `wearing ${c.wardrobe}`
      : "in this scene";

  // The locked sheet gives consistency across pages; the photograph guards
  // against the sheet itself having drifted. Both, when both exist.
  const sources = `Use:
${[
  c.identity || (!c.photo && c.plate) ? `- LOCKED IDENTITY — ${label}` : "",
  c.photo ? `- PRIMARY REAL IDENTITY REFERENCE — ${label}` : "",
  c.photo ? `- any SUPPORTING IDENTITY REFERENCE — ${label}` : "",
]
  .filter(Boolean)
  .join(LINE)}`;

  const clarifications = [
    o?.position ? `Page location:${LINE}${o.position}` : "",
    o?.pose ? `Pose clarification:${LINE}${o.pose}` : "",
    o?.expression ? `Expression:${LINE}${o.expression}` : "",
    o?.gaze ? `Gaze:${LINE}${o.gaze}` : "",
  ].filter(Boolean);

  const tail = clarifications.length
    ? BLANK +
      clarifications.join(BLANK) +
      BLANK +
      `The original page remains authoritative if these clarifications differ from what is
visibly shown.`
    : "";

  return `${label.toUpperCase()}

Target:
The existing ${describe(c)} ${where}.

Replace that character's identity with ${label}.

${sources}

These all represent the SAME person.

${label} must remain recognisable across every page regardless of head angle, expression,
scale, lighting or pose.

Preserve ${label}'s underlying facial proportions when adapting them to this page.${tail}`;
}

function pinsBlock(marks: Mark[], cast: CastMember[], rename?: { from: string; to: string }): string {
  const rows = marks
    .map((m, i) => {
      const c = cast.find((x) => x.id === m.id);
      return `${i + 1} = ${c ? newLabel(c, rename) : m.id}`;
    })
    .join(LINE);

  return `IDENTITY MAP

The numbered guide identifies existing people only.

${rows}

Replace the identity of those exact existing people in place.

The markers are not part of the artwork.
Do not reproduce numbers, pins, circles or labels.`;
}

function renameBlock(from: string, to: string): string {
  return `Replace the exact printed name "${from}" with "${to}" wherever it appears in the page's
printed story text.

Preserve the original capitalisation pattern, font appearance, font size, colour,
alignment, spacing, line breaks and position.

Do not alter any other name.`;
}

function pronounBlock(p: Pronouns, name: string): string {
  if (p === "none") return "";
  const swaps =
    p === "he-she"
      ? `- he to she
- him to her
- his to her when it modifies a noun
- his to hers when it stands alone
- himself to herself
- boy to girl
- son to daughter`
      : `- she to he
- her to him when it is an object
- her to his when it modifies a noun
- hers to his
- herself to himself
- girl to boy
- daughter to son`;

  return `Only where the printed word refers to ${name}, change the wording to the grammatically
correct ${p === "he-she" ? "feminine" : "masculine"} form:

${swaps}

Preserve capitalisation when the original word begins a sentence.

Do not change pronouns referring to another character, another character's gendered words,
names, punctuation, sentence structure, or wording unrelated to ${name}.`;
}

export function recastPrompt(
  cast: CastMember[],
  rename?: { from: string; to: string },
  extras?: { pronouns?: Pronouns; marks?: Mark[]; page?: number }
): string {
  const marks = extras?.marks || [];
  const pinOf = (id: string) => {
    const at = marks.findIndex((m) => m.id === id);
    return at === -1 ? undefined : at + 1;
  };

  const characterBlocks = cast
    .map((c) =>
      characterBlock(
        c,
        rename,
        pinOf(c.id),
        extras?.page !== undefined ? c.notes?.[extras.page] : undefined
      )
    )
    .join(BLANK);

  const child = cast.find((c) => c.role === "protagonist");
  const childName = rename?.to || child?.label || "the child";
  const edits = [
    rename?.from ? renameBlock(rename.from, rename.to) : "",
    pronounBlock(extras?.pronouns || "none", childName),
  ].filter(Boolean);

  const lettering = edits.length
    ? edits.join(BLANK) +
      BLANK +
      `Change no other printed text. Reproduce every other word, letter, punctuation mark,
capitalisation, line break, font, size, colour and position exactly as printed.`
    : `Do not modify any printed text. Reproduce it exactly as it appears.`;

  const pins = marks.length ? BLANK + pinsBlock(marks, cast, rename) : "";

  return `Edit the image labelled ORIGINAL PAGE.

This is an identity-replacement edit of an existing finished illustration.

PRIORITY ORDER

1. The replacement characters must be recognisably the SAME PEOPLE as their identity
   references.
2. Keep each replacement in the same place, pose and clothing as the original character.
3. Preserve the original composition and all unrelated people and objects.
4. Match the original page's illustration style.
5. Apply only the explicitly requested text changes.

IDENTITY

${characterBlocks}

For every replacement, identity accuracy is the highest priority.

The LOCKED IDENTITY sheet establishes the character's consistent appearance across the
book.

The PRIMARY REAL IDENTITY REFERENCE is the ground-truth reference for that person's actual
facial identity.

Additional photographs are supporting references of the SAME person.

Preserve the person's distinctive facial geometry and the relationships between features:

- face shape and proportions
- hairline and hairstyle
- eyebrows
- eye shape, size and spacing
- nose shape and proportions
- mouth and lips
- cheeks
- jaw and chin
- skin tone
- apparent age
- distinctive visible features

Do not produce merely a similar-looking person.

Do not average or genericise the face.

Do not blend the reference identity with the original illustrated character's facial
features.

The original character supplies the BODY, POSE, CLOTHING and LOCATION.

The identity references supply WHO THE PERSON IS.

Transform the existing target character IN PLACE. Do not add another person.

POSE AND EXPRESSION

Preserve the original page's body pose, approximate head direction, interaction and
expression.

Adapt the replacement person's real facial structure naturally to that expression and
viewpoint.

Do not preserve the old character's facial geometry merely to preserve the expression.

STYLE

Match the original page's illustration style. The original page is the authoritative style
reference.

The result should look like this person was always the character originally illustrated in
the book.

Do not paste a photographic face onto a painted body.
Do not make the face noticeably more photographic than the rest of the illustration.
Do not stylise the face so heavily that identity is lost.

PRESERVATION

Keep unlisted people unchanged.

Keep the original composition, crop, background, props, clothing, lighting and colours.

Keep the same number of people.${pins}

TEXT

${lettering}

Return only the finished page.`;
}
