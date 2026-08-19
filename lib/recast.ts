// Everything the recast needs, on the client. The API route is a thin proxy so
// the key never reaches the browser; orchestration, concurrency and progress
// live here because a single serverless call can only carry one image.

export type Part =
  | { type: "text"; text: string }
  /** `fidelity: "high"` survives compression intact - use it for faces. */
  | { type: "image_url"; image_url: { url: string }; fidelity?: "high" };

export const STYLE =
  "Premium children's picture-book illustration: photographic faces in a softly painted, warm, " +
  "brightly lit world. Natural skin tones, gentle painterly edges, no cartoon styling, no glossy 3D.";

export type CastRole = "protagonist" | "family" | "creature" | "extra";

export interface CastMember {
  id: string;
  label: string;
  /** data URL of a real photograph, when the character is a real person */
  photo?: string;
  /**
   * Further photographs of the same person.
   *
   * One photograph is one angle under one light, and a model asked to draw a
   * face from three-quarter view has to invent the rest. Several - a close-up,
   * a profile, a different day - pin down what is actually constant about the
   * face instead of what was true of one frame.
   */
  photos?: string[];
  /** what this character looks like and wears */
  brief: string;
  /** rendered character sheet, once generated */
  plate?: string;
  role?: CastRole;
  /** what the book dresses them in - safe to keep even when a photo replaces the face */
  wardrobe?: string;
  /** zero-based indices of the pages they appear on */
  onPages?: number[];
  /** false leaves this character exactly as the original book drew them */
  replace?: boolean;
}

/** Used only if you skip detection — a plain starting point, not this book's cast. */
export const FALLBACK_CAST: CastMember[] = [
  {
    id: "child",
    label: "Child",
    role: "protagonist",
    replace: true,
    brief:
      "the child the story follows. Keep their real face exactly as the photograph shows: face " +
      "shape, cheeks, jaw, eye shape and spacing, brows, nose, mouth, ears, skin tone, apparent " +
      "age. Dress them as the book already dresses them.",
  },
];

/** Ask a vision model who recurs in this book, looking at every page. */
export async function detectCast(
  pageImages: string[],
  settings?: Partial<Settings>,
  onProgress?: (done: number, total: number) => void
): Promise<CastMember[]> {
  const shrunk = await Promise.all(pageImages.map((p) => shrink(p, 768)));

  // Every page gets looked at - a character who only appears on the pages a
  // sample skipped is a character the recast silently leaves as the old family.
  // They go up in batches because a whole book exceeds the request body limit.
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  const LIMIT = 2_800_000; // comfortably under the ~4.5MB body ceiling
  for (const img of shrunk) {
    if (current.length && (bytes + img.length > LIMIT || current.length >= 10)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(img);
    bytes += img.length;
  }
  if (current.length) batches.push(current);

  const offsets: number[] = [];
  let seen = 0;
  for (const b of batches) {
    offsets.push(seen);
    seen += b.length;
  }

  let done = 0;
  const results = await Promise.all(
    batches.map(async (images, i) => {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images,
          provider: settings?.provider,
          apiKey: settings?.apiKey,
          model: settings?.visionModel,
          batch: { index: i + 1, of: batches.length },
        }),
      });
      const body = await res.json();
      done += images.length;
      onProgress?.(done, shrunk.length);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Each batch counts its own pages from 1; shift them onto the real book.
      return ((body.cast || []) as CastMember[]).map((c) => ({
        ...c,
        onPages: (c.onPages || [])
          .map((n) => offsets[i] + Number(n) - 1)
          .filter((n) => n >= 0 && n < shrunk.length),
      }));
    })
  );

  return mergeCast(results.flat());
}

/**
 * Fold each batch's findings together. The same person is described separately
 * in every batch they appear in, so match on label and keep the fullest account.
 */
function mergeCast(found: CastMember[]): CastMember[] {
  const byKey = new Map<string, CastMember>();

  for (const raw of found) {
    const label = (raw.label || raw.id || "").trim();
    if (!label) continue;
    const key = label.toLowerCase().replace(/[^a-z]/g, "");
    const seen = byKey.get(key);

    if (!seen) {
      byKey.set(key, {
        id: String(raw.id || key).toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
        label,
        brief: raw.brief || "",
        wardrobe: raw.wardrobe || "",
        role: (raw.role as CastRole) || "family",
        onPages: [...(raw.onPages || [])],
        replace: raw.role !== "extra",
      });
      continue;
    }

    seen.onPages = [...new Set([...(seen.onPages || []), ...(raw.onPages || [])])].sort(
      (a, b) => a - b
    );
    if ((raw.brief || "").length > (seen.brief || "").length) seen.brief = raw.brief!;
    if ((raw.wardrobe || "").length > (seen.wardrobe || "").length) seen.wardrobe = raw.wardrobe!;
    // Any batch that saw them as central outranks one that saw them in a crowd.
    const rank: Record<string, number> = { protagonist: 3, creature: 2, family: 1, extra: 0 };
    if (rank[raw.role || "family"] > rank[seen.role || "family"]) {
      seen.role = raw.role as CastRole;
      seen.replace = raw.role !== "extra";
    }
  }

  const order: Record<string, number> = { protagonist: 0, family: 1, creature: 2, extra: 3 };
  return [...byKey.values()].sort(
    (a, b) =>
      (order[a.role || "family"] ?? 9) - (order[b.role || "family"] ?? 9) ||
      (b.onPages?.length || 0) - (a.onPages?.length || 0)
  );
}

/**
 * A pin the user dropped on a page, saying which cast member that person is.
 *
 * Coordinates are fractions of the page, so they survive any rescaling between
 * the viewer, the reference copy and the render.
 */
export interface Mark {
  /** cast member id */
  id: string;
  x: number;
  y: number;
}

/**
 * Draw the pins onto a copy of the page.
 *
 * Naming a person in words - "the child in the cream kurta" - falls apart the
 * moment two children are dressed alike. Pointing does not. This copy is
 * attached as a guide and is never the page being redrawn.
 */
export async function annotate(
  dataUrl: string,
  marks: Mark[],
  labelOf: (id: string) => string
): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("could not read a page image"));
    el.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const unit = Math.max(canvas.width, canvas.height) / 40;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  marks.forEach((m, i) => {
    const x = m.x * canvas.width;
    const y = m.y * canvas.height;
    const n = String(i + 1);

    ctx.beginPath();
    ctx.arc(x, y, unit, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(220, 38, 38, 0.9)";
    ctx.fill();
    ctx.lineWidth = unit * 0.16;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${unit * 1.15}px sans-serif`;
    ctx.fillText(n, x, y + unit * 0.05);

    // The name under the pin, so the guide reads on its own.
    const label = labelOf(m.id).toUpperCase();
    ctx.font = `bold ${unit * 0.8}px sans-serif`;
    ctx.lineWidth = unit * 0.28;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(label, x, y + unit * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x, y + unit * 2);
  });

  return canvas.toDataURL("image/jpeg", 0.9);
}

/** The same pins written out, because position in words survives a resize. */
export function markLines(marks: Mark[], labelOf: (id: string) => string): string {
  return marks
    .map((m, i) => {
      const across = m.x < 0.34 ? "left" : m.x > 0.66 ? "right" : "centre";
      const down = m.y < 0.34 ? "upper" : m.y > 0.66 ? "lower" : "middle";
      return `  ${i + 1}. ${labelOf(m.id)} — the person marked ${i + 1}, ${down} ${across} of the ` +
        `page (about ${Math.round(m.x * 100)}% across, ${Math.round(m.y * 100)}% down).`;
    })
    .join("\n");
}

/** Downscale a page before sending it to the vision model. */
async function shrink(dataUrl: string, max: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("could not read a page image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Every photograph attached to a character, primary first.
 *
 * Capped, because these ride along uncompressed: a page carrying three people
 * with five photographs each would blow the request body limit outright.
 */
export function photosOf(m: CastMember, max = 8): string[] {
  return ([m.photo, ...(m.photos || [])].filter(Boolean) as string[]).slice(0, max);
}

export function platePrompt(m: CastMember, extraIdentity = ""): string {
  // With a photograph in hand, the book's description of the OLD character is
  // actively harmful - it describes someone else, and the model splits the
  // difference. Say nothing about how they look and let the photo speak.
  const shots = photosOf(m);
  const many = shots.length > 1;
  const identity = shots.length
    ? `Build a CHARACTER SHEET of the person in the attached ${
        many ? `${shots.length} photographs, which are all the SAME person` : "photograph"
      }.\n\n` +
      "Their face is the whole point: keep the face shape, cheeks, jaw, eye shape and spacing, " +
      "brows, nose, mouth, ears, hairline, hair texture, skin tone and apparent age exactly as " +
      (many ? "the photographs show" : "the photograph shows") +
      " them. Keep any head covering, glasses or distinguishing feature they wear in " +
      (many ? "all of them" : "it") +
      ". Draw THIS person, not a similar-looking one, and do not adjust their age.\n\n" +
      (many
        ? "Read the face from ALL of them together. What stays the same across the photographs IS " +
          "the face; what changes between them is only the light, the angle, the expression and " +
          "the day. Keep the first and discard the second. Do not average them into a blurred " +
          "compromise, and do not simply follow whichever one is largest or sharpest.\n\n"
        : "") +
      `Take nothing else from the ${many ? "photographs" : "photograph"} - ignore ` +
      "clothing, background, lighting, angle and expression." +
      (m.wardrobe ? `\n\nDress them in ${m.wardrobe}` : "\n\nDress them in simple, plain, " +
        "everyday clothing appropriate to their age, in muted colours.")
    : `Build a CHARACTER SHEET for ${m.brief}` +
      (extraIdentity ? `\n${extraIdentity}` : "");

  return (
    `${STYLE}\n\n` +
    identity +
    "\n\nOn one square plate against a plain flat off-white background, draw the SAME character " +
    "four times at the same height: full-body front, full-body three-quarter, full-body profile, " +
    "and a larger head study. Keep build, height, head-to-body proportion, limb length and hand " +
    "size identical across all four - this sheet is what every page copies the BODY from, not only " +
    "the face. Even neutral lighting. No lettering anywhere in the image."
  );
}

/** Which way the child's gender flips, when it does. */
export type Pronouns = "none" | "he-she" | "she-he";

export const PRONOUN_LABEL: Record<Pronouns, string> = {
  none: "unchanged",
  "he-she": "he/him → she/her",
  "she-he": "she/her → he/him",
};

/**
 * The words that have to move when the child's gender changes.
 *
 * The naive version - swap every "he" for "she" - wrecks the book: Papa smiles,
 * Bappa laughs, and suddenly both are women. Pronouns have to be resolved to
 * whoever they actually refer to before any of them move, which is a reading
 * task, so the instruction is written as one.
 */
function pronounRule(p: Pronouns, childName?: string): string {
  if (p === "none") return "";
  const to = p === "he-she" ? "she" : "he";
  const from = p === "he-she" ? "he" : "she";
  const swaps =
    p === "he-she"
      ? [
          'he -> she',
          'him -> her',
          'his -> her before a noun ("his hands" -> "her hands"), hers when it stands alone',
          'himself -> herself',
          'boy -> girl, son -> daughter, brother -> sister, nephew -> niece, grandson -> granddaughter',
        ]
      : [
          'she -> he',
          'her -> him as an object ("told her" -> "told him")',
          'her -> his before a noun ("her hands" -> "his hands"); hers -> his',
          'herself -> himself',
          'girl -> boy, daughter -> son, sister -> brother, niece -> nephew, granddaughter -> grandson',
        ];
  const child = childName ? `the main child (${childName})` : "the main child";

  return (
    `PRONOUNS. The main child's gender has changed, so the words about THEM change with it - and ` +
    `nothing else does.\n\n` +
    `Work it out before you write anything. Read the printed text on this page. For every ` +
    `gendered word in it - ${from}, ${from === "he" ? "him, his, himself" : "her, hers, herself"}, ` +
    `and words like boy, girl, son, daughter, brother, sister - decide WHO it refers to. A pronoun ` +
    `usually refers to the nearest person named before it, and the sentence has to still make ` +
    `sense once you have decided.\n\n` +
    `Change it ONLY if it refers to ${child}. Then:\n` +
    swaps.map((r) => `  - ${r}`).join("\n") +
    `\n\nLeave it exactly as printed if it refers to anyone else. Fathers, grandfathers, uncles, ` +
    `brothers, male friends and male deities keep every one of their own pronouns, and so do all ` +
    `the women and girls in the book. Names and titles never change gender: Papa, Dadi, Chachu, ` +
    `Bappa, Mumma and every other name stay exactly as printed.\n\n` +
    `Worked example. "Papa smiled. He gave ${childName || "the child"} a modak, and ${
      childName || "the child"
    } held it in ${from === "he" ? "his" : "her"} hands." Here the first pronoun is Papa's and ` +
    `does not move; the second belongs to the child and becomes "${
      to === "she" ? "her" : "his"
    }". If a sentence mentions nobody but other people, reproduce it untouched.\n\n` +
    `Finally, read your rewritten text back. Every sentence must be grammatical - "${to}" has to ` +
    `agree with the verbs and possessives around it - and no other word may have changed.`
  );
}

export function recastPrompt(
  cast: CastMember[],
  rename?: { from: string; to: string },
  extras?: { pronouns?: Pronouns; markGuide?: string }
): string {
  const renameLine = rename?.from
    ? `LETTERING. Reproduce every word of the printed text exactly as it appears - same typeface, ` +
      `size, colour and position - with ONE change: wherever the name "${rename.from}" appears, ` +
      `write "${rename.to}" instead. Change nothing else about the words. Keep the text crisp and ` +
      `correctly spelled.`
    : `LETTERING. Reproduce every word of the printed text exactly as it appears - same typeface, ` +
      `size, colour, spelling and position. Do not reword, add or drop anything.`;

  // Naming who each sheet replaces, by the clothes the book already puts them
  // in, is what stops the model spreading one character across several people.
  const roster = cast
    .map((c) => {
      const who = c.wardrobe
        ? `the ${describe(c)} wearing ${c.wardrobe}`
        : `the ${describe(c)}`;
      return `- ${c.label.toUpperCase()} replaces ONE person only: ${who}. There is exactly ONE ` +
        `${c.label} in the finished page, never two.`;
    })
    .join("\n");

  // The rename tells us what the child is called in the new text, which is what
  // the pronoun pass needs to resolve references against.
  const child = cast.find((c) => c.role === 'protagonist');
  const pronouns = pronounRule(
    extras?.pronouns || 'none',
    rename?.to || child?.label
  );

  // A guide image only exists when the user actually pinned someone.
  const marked = extras?.markGuide
    ? `

WHO IS WHO IN THIS PAGE. One attached image is a GUIDE: the same page with numbered red pins on it.
It tells you which person is which, nothing more.

${extras.markGuide}

The pins are instructions to you, not part of the artwork. The finished page must contain NO pins,
numbers, circles, labels or any other marking that is not in the original page. Redraw the page from
the clean copy.`
    : "";

  return `${STYLE}

You are re-issuing one finished page of an existing children's picture book for a different family.

The LAST attached image is the finished page. Everything before it is reference for the new cast:
for each character either a photograph of the real person or, where there is no photograph, a
locked character sheet drawn for them.

Redraw this exact page with the new cast in place of the old one.

WHO IS REPLACED, AND WHO IS NOT.

${roster}${marked}

Every other person in the picture - cousins, other children, visiting relatives, neighbours, anyone
in the background - is NOT part of the new cast. They keep their own face, their own hair, their own
build and the exact clothes the original page gives them. A cousin in a blue kurta stays a different
child in a blue kurta.

ONE OF EACH. Count the people in the original page. The finished page has the same number, each a
distinct individual standing where they stood. If the original page shows several children, only the
one described above becomes the new child; the others are other children and must look nothing like
him. Never draw the same character twice. A sheet, where one is attached, shows its character from
several angles only so you can see them properly - that is reference, never an instruction to
repeat anyone in the scene.

NOTHING CROSSES BETWEEN CHARACTERS. Each reference applies to its own person and to nobody else. Do not
put one character's headwear, hair, crown, cloth, turban, jewellery, ornaments, clothing, markings
or facial features on any other person in the picture, whether they are cast or not. Whatever a
person wears on their head in the ORIGINAL page is what they wear in the new one - if only one
character has a white head cloth in the original, only that same character has it now.

THE FACE IS THE POINT. For each replaced character, copy the face feature by feature: face shape,
cheeks, jaw, brow, eye shape and spacing, nose, mouth, ears, hairline, hair texture, skin tone and
apparent age. It must be recognisably the SAME person as on every other page of this book - not
someone of the same age and colouring. Do not restyle, idealise, age, prettify or soften the face,
and do not let the painterly finish of the page smooth it into a generic child.

THE PHOTOGRAPH IS THE FACE. Where a photograph of a real person is attached, that photograph is
the likeness - not an inspiration for one. Reproduce the face it shows. Take nothing else from it:
ignore its clothing, background, lighting, angle and expression, which all come from the page
instead. Where several photographs of one person are attached they are the same person on different
days; what is CONSTANT across them is the face. Do not blend them into a soft average.

REPLACE COMPLETELY, not just the head. The whole person is the new one - face, head, hair and any
head covering, skin tone, build, height, body proportions, hands and feet, drawn at the age their
reference shows. A swapped head on the old body is wrong.

KEEP EVERYTHING ELSE IDENTICAL. Same composition and camera. Each character stands exactly where
they stood, at the same size in frame, in the same pose, doing the same thing, looking the same way.
Same clothing design and colour as the page already shows. Same room, furniture, props, decoration,
light, shadows and palette. Nothing enters or leaves the picture.

${renameLine}
${pronouns ? `\n${pronouns}\n` : ""}
Match the original page's finish: photographic faces, softly painted surroundings, the same bright
warm light.`;
}

/** A short, plain way to point at a character in the original artwork. */
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

export function text(t: string): Part {
  return { type: "text", text: t };
}
export function image(dataUrl: string, fidelity?: "high"): Part {
  return { type: "image_url", image_url: { url: dataUrl }, fidelity };
}

export interface Settings {
  provider: "openrouter" | "openai";
  apiKey: string;
  model: string;
  /** vision model used to read the book and work out its cast */
  visionModel: string;
  quality: "low" | "medium" | "high" | "auto";
  size: string;
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  apiKey: "",
  model: "",
  visionModel: "",
  quality: "low",
  size: "1024x1024",
  concurrency: 4,
};

export const MODEL_HINTS: Record<Settings["provider"], string> = {
  openrouter: "openai/gpt-5.4-image-2",
  openai: "gpt-image-2",
};

/** Shrink a data URL so a whole reference stack fits in one request body. */
export async function compress(dataUrl: string, max = 1024, quality = 0.82): Promise<string> {
  if (typeof document === "undefined") return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("unreadable image"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && dataUrl.startsWith("data:image/jpeg")) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    // JPEG has no alpha, so lay down white rather than letting it go black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return dataUrl;
  }
}

export async function generate(
  parts: Part[],
  settings?: Partial<Settings>,
  retries = 2
): Promise<string> {
  // Raw PNGs are megabytes each; five of them exceed the request body limit on
  // most hosts and come back as a 413 with an HTML body.
  const slim: Part[] = await Promise.all(
    parts.map(async (p) =>
      p.type === "image_url"
        ? {
            ...p,
            image_url: {
              url:
                p.fidelity === "high"
                  ? await compress(p.image_url.url, 1280, 0.94)
                  : await compress(p.image_url.url),
            },
          }
        : p
    )
  );

  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: slim,
          provider: settings?.provider,
          apiKey: settings?.apiKey,
          model: settings?.model,
          quality: settings?.quality,
          size: settings?.size,
        }),
      });
      if (res.status === 413) {
        throw new Error(
          "Request too large for the server (413). Reduce pages-at-once, or untick a character " +
            "so fewer sheets are attached."
        );
      }
      const raw = await res.text();
      let body: { error?: string; image?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        // Proxies and platform limits answer with HTML, not JSON.
        throw new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`);
      }
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      return body.image as string;
    } catch (e) {
      last = String((e as Error).message || e);
      if (/(401|403)|No key for/i.test(last)) break; // credentials will not fix themselves
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error(last);
}

/** Run tasks with a fixed number in flight, reporting each completion. */
export async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
