// Every prompt the pipeline sends, in one file so they can be read together and
// diffed against results. Written as template literals with real newlines - no
// escape soup - because these are meant to be edited as prose.

import type { CastMember, Mark } from "./recast";

/* ------------------------------------------------------------------ shared */

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

/** How each attached image is announced, so the prompt can refer to it by name. */
export const LABELS = {
  page: `Original page — this is the image to edit:`,
  guide: `Identity map only — this is the original page with temporary numbered markers.
Use it only to locate people. Do not reproduce any marker in the finished page:`,
  photo: (label: string) => `Identity reference — ${label}.
The first image is the primary identity reference. Any later images are supporting views
of the same person:`,
  plate: (label: string) => `Locked identity reference — ${label}.
Every view on this sheet shows the same character:`,
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
    "doing": "..."
  }

  "doing" must be a concrete 10-20 word visual observation containing only:

  - position in the image
  - body orientation
  - pose or action
  - hand or arm placement when important
  - visible expression
  - gaze direction

  Do not mention clothing, skin tone, hair, identity or inferred emotion in "doing".

Examples of suitable observations:

"left foreground, standing on tiptoes with right arm raised, smiling and looking upward"

"seated behind the child, body facing forward, hands in lap, looking toward the table"

"partly cropped at the right edge, walking left and looking toward the child"

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
          "doing": "..."
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

The character must have exactly the same:

- face shape
- facial features
- skin tone
- apparent age
- hairstyle
- hair colour
- build
- body proportions
- costume
- costume colours

in every view.

This is one character shown from four angles, not four similar people or relatives.

Keep the design practical and easy to reuse in later illustrations. Show the face clearly.
Keep hands visible where possible. Use a neutral expression with a slight natural smile.

Do not add:

- another character
- alternate costumes
- props
- scenery
- text
- labels
- numbers
- borders
- decorative frames
- dramatic shadows

Output only the finished square character sheet.`;
}

/* ---------------------------------------------------------- 3. page recast */

/** A plain way to point at a character in the original artwork. */
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
function newLabel(c: CastMember, rename?: { from: string; to: string }): string {
  return c.role === "protagonist" && rename?.to ? rename.to : c.label;
}

function locator(c: CastMember, pin?: number): string {
  if (pin !== undefined) {
    return `The target is the existing person marked ${pin} in the temporary identity map.`;
  }
  return c.wardrobe
    ? `The target is the ${describe(c)} in ${c.wardrobe}.`
    : `The target is the ${describe(c)}.`;
}

function characterBlock(
  c: CastMember,
  rename: { from: string; to: string } | undefined,
  pin: number | undefined,
  doing: string | undefined
): string {
  const label = newLabel(c, rename);
  const observation = doing ? BLANK + `  Page observation:${LINE}  ${doing}` : "";
  const head = `- ${label}

  Target:
  Transform the existing ${c.label} in place.
  ${locator(c, pin)}`;

  if (c.photo) {
    return `${head}

  Identity source:
  Use the attached images labelled "Identity reference — ${label}".

  The first image is the primary identity reference. Any additional images are supporting
  views of the same person.

  Preserve the person's recognisable face shape, facial features, skin tone, hairstyle,
  hair colour, apparent age and broad build.

  Ignore differences in the reference photos caused by:

  - lighting
  - facial expression
  - camera angle
  - camera distortion
  - background
  - pose
  - clothing
  - temporary accessories

  Preserve from the original page:

  - exact location and scale
  - body orientation
  - pose
  - arm and hand placement
  - expression
  - gaze
  - interaction with other characters or objects
  - clothing${observation}

  Replace the one existing target instance. Do not add another ${label}.`;
  }

  return `${head}

  Identity source:
  Use the attached sheet labelled "Locked identity reference — ${label}".

  Every view on the sheet represents the same character. Preserve that character's
  consistent face, facial features, skin tone, hair, apparent age and broad build.

  Use the sheet only as an identity and design reference.

  Preserve from the original page:

  - exact location and scale
  - body orientation
  - pose
  - arm and hand placement
  - expression
  - gaze
  - interaction with other characters or objects
  - clothing visible on this page

  Do not copy the sheet's neutral pose, sheet layout or off-white background.${observation}

  Replace the one existing target instance. Do not add another ${label}.`;
}

function pinsBlock(marks: Mark[], cast: CastMember[], rename?: { from: string; to: string }): string {
  const rows = marks
    .map((m, i) => {
      const c = cast.find((x) => x.id === m.id);
      return `${i + 1} = ${c ? newLabel(c, rename) : m.id}`;
    })
    .join(LINE);

  return `A temporary identity map is attached.

The markers identify these existing people:

${rows}

Use the map only to determine which existing person receives each identity.

Do not reproduce any pin, number, circle, label, arrow, outline or marker in the finished
page.`;
}

function renameBlock(from: string, to: string): string {
  return `Replace the exact printed name "${from}" with "${to}" wherever it appears in the
page's printed story text.

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
  const form = p === "he-she" ? "feminine" : "masculine";

  return `Only where the printed word refers to ${name}, change the wording to the grammatically
correct ${form} form:

${swaps}

Preserve capitalisation when the original word begins a sentence.

Do not change:

- pronouns referring to another character
- another character's gendered words
- names
- punctuation
- sentence structure
- wording unrelated to ${name}`;
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
    ? `Apply only these requested lettering changes:

${edits.join(BLANK)}

Do not rewrite, paraphrase, correct or restyle any other text.
Do not add captions, labels or new lettering.`
    : `No printed lettering may change.
Copy all text exactly from the original page.`;

  const pins = marks.length ? BLANK + pinsBlock(marks, cast, rename) : "";

  return `Edit the image labelled "Original page".

This is a constrained identity replacement inside an existing finished illustration.
It is not a request for a new composition.

SOURCE-OF-TRUTH RULES

1. The original page controls:

   - composition
   - crop
   - camera angle
   - number of people
   - each person's location and scale
   - pose and body orientation
   - hand and arm placement
   - expression and gaze
   - clothing
   - props
   - background
   - lighting and shadows
   - colours
   - linework
   - painted texture
   - all printed lettering that is not explicitly changed below

2. An identity reference controls only the listed character's identity:

   - recognisable face shape
   - facial features
   - skin tone
   - hairstyle and hair colour
   - apparent age
   - broad physical build

   Adapt those identity traits to the original character's illustrated pose and stylised
   body proportions.

   Do not copy the reference image's pose, clothing, background, lighting, camera angle,
   expression or photographic rendering.

3. A numbered identity map, when attached, is only a correspondence guide.

   Do not reproduce its pins, circles, numbers, labels, arrows, outlines or other marks.

4. Written page observations only clarify what is already visible.

   If an observation conflicts with the original page, follow the original page.

5. The lettering instructions below are the only permitted changes to printed text.

CHARACTERS TO RECAST

${characterBlocks}

For every listed character:

- transform the existing target person in place
- replace the old identity rather than inserting a new person
- keep the target's original location, scale, pose, hands, expression, gaze and interaction
- keep the exact clothing visible on the original page
- make the replacement identity recognisable
- render the identity in the exact painted style of the original illustration
- do not paste a photograph into the illustration
- do not make the face more photographic than the surrounding artwork
- do not leave the old face underneath or elsewhere
- do not draw the replacement character twice

PRESERVE EVERYTHING ELSE

Only the listed character identities may change.

Every unlisted person must retain their original:

- face
- hair
- skin tone
- apparent age
- build
- clothing
- pose
- expression
- gaze
- scale
- location

Keep exactly the same number of people as the original page.

Do not:

- add or remove people
- duplicate a person
- combine two people
- swap identities
- move a character
- redesign clothing
- change the crop
- change the room or landscape
- add or remove props
- alter lighting or colours
- add extra fingers, limbs or faces
- redraw an unlisted person's identity${pins}

LETTERING

Treat all printed lettering as protected artwork.

Preserve every unchanged:

- word
- letter
- punctuation mark
- capitalisation
- line break
- font appearance
- font size
- colour
- alignment
- position

${lettering}

Return one finished page only.

Do not include guides, pins, labels, borders, annotations, explanations or alternate
versions.`;
}
