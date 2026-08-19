// Everything the recast needs, on the client. The API route is a thin proxy so
// the key never reaches the browser; orchestration, concurrency and progress
// live here because a single serverless call can only carry one image.

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const STYLE =
  "Premium children's picture-book illustration: photographic faces in a softly painted, warm, " +
  "brightly lit world. Natural skin tones, gentle painterly edges, no cartoon styling, no glossy 3D.";

export type CastRole = "protagonist" | "family" | "creature" | "extra";

export interface CastMember {
  id: string;
  label: string;
  /** data URL of a real photograph, when the character is a real person */
  photo?: string;
  /** what this character looks like and wears */
  brief: string;
  /** rendered character sheet, once generated */
  plate?: string;
  role?: CastRole;
  /** what the book dresses them in - safe to keep even when a photo replaces the face */
  wardrobe?: string;
  /** roughly how many sampled pages they were seen on */
  pages?: number;
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
      return (body.cast || []) as CastMember[];
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
        pages: typeof raw.pages === "number" ? raw.pages : 0,
        replace: raw.role !== "extra",
      });
      continue;
    }

    seen.pages = (seen.pages || 0) + (typeof raw.pages === "number" ? raw.pages : 0);
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
      (b.pages || 0) - (a.pages || 0)
  );
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

export function platePrompt(m: CastMember, extraIdentity = ""): string {
  // With a photograph in hand, the book's description of the OLD character is
  // actively harmful - it describes someone else, and the model splits the
  // difference. Say nothing about how they look and let the photo speak.
  const identity = m.photo
    ? "Build a CHARACTER SHEET of the person in the attached photograph.\n\n" +
      "Their face is the whole point: keep the face shape, cheeks, jaw, eye shape and spacing, " +
      "brows, nose, mouth, ears, hairline, hair texture, skin tone and apparent age exactly as the " +
      "photograph shows them. Keep any head covering, glasses or distinguishing feature they wear " +
      "in it. Draw THIS person, not a similar-looking one, and do not adjust their age.\n\n" +
      "Take nothing else from the photograph - ignore its clothing, background, lighting, angle " +
      "and expression." +
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

export function recastPrompt(cast: CastMember[], rename?: { from: string; to: string }): string {
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

  return `${STYLE}

You are re-issuing one finished page of an existing children's picture book for a different family.

The LAST attached image is the finished page. Everything before it is reference for the new cast:
each character's locked sheet, and for some of them a photograph of the real person.

Redraw this exact page with the new cast in place of the old one.

WHO IS REPLACED, AND WHO IS NOT.

${roster}

Every other person in the picture - cousins, other children, visiting relatives, neighbours, anyone
in the background - is NOT part of the new cast. They keep their own face, their own hair, their own
build and the exact clothes the original page gives them. A cousin in a blue kurta stays a different
child in a blue kurta.

ONE OF EACH. Count the people in the original page. The finished page has the same number, each a
distinct individual standing where they stood. If the original page shows several children, only the
one described above becomes the new child; the others are other children and must look nothing like
him. Never draw the same character twice. A sheet shows its character from several angles only so
you can see them properly - that is reference, never an instruction to repeat anyone in the scene.

NOTHING CROSSES BETWEEN CHARACTERS. Each sheet applies to its own person and to nobody else. Do not
put one character's headwear, hair, crown, cloth, turban, jewellery, ornaments, clothing, markings
or facial features on any other person in the picture, whether they are cast or not. Whatever a
person wears on their head in the ORIGINAL page is what they wear in the new one - if only one
character has a white head cloth in the original, only that same character has it now.

THE FACE IS THE POINT. For each replaced character, copy the face from their reference: the head
study on the sheet, and the photograph where one is attached. Match face shape, cheeks, jaw, brow,
eye shape and spacing, nose, mouth, ears, hairline, hair texture, skin tone and apparent age feature
by feature. It must be recognisably the SAME person as on every other page - not someone of the same
age and colouring. Do not restyle, idealise, age or soften the face.

REPLACE COMPLETELY, not just the head. The whole person comes from their sheet - build, height,
head-to-body proportion, limb length, hands and feet. A swapped head on the old body is wrong.

KEEP EVERYTHING ELSE IDENTICAL. Same composition and camera. Each character stands exactly where
they stood, at the same size in frame, in the same pose, doing the same thing, looking the same way.
Same clothing design and colour as the page already shows. Same room, furniture, props, decoration,
light, shadows and palette. Nothing enters or leaves the picture.

${renameLine}

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
export function image(dataUrl: string): Part {
  return { type: "image_url", image_url: { url: dataUrl } };
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
        ? { ...p, image_url: { url: await compress(p.image_url.url) } }
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
