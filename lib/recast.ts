export {
  platePrompt,
  recastPrompt,
  PRONOUN_LABEL,
  LABELS,
  type Pronouns,
} from "./prompts";

// Everything the recast needs, on the client. The API route is a thin proxy so
// the key never reaches the browser; orchestration, concurrency and progress
// live here because a single serverless call can only carry one image.

export type Part =
  | { type: "text"; text: string }
  /** `fidelity: "high"` survives compression intact - use it for faces. */
  | { type: "image_url"; image_url: { url: string }; fidelity?: "high" };


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
  /** page index -> what the cast reader saw them doing there */
  notes?: Record<number, string>;
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
          firstPage: offsets[i] + 1,
        }),
      });
      const body = await res.json();
      done += images.length;
      onProgress?.(done, shrunk.length);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Page numbers come back as real book pages now - each image was labelled
      // with its own - so there is nothing to shift, only to range-check.
      type Raw = Omit<CastMember, "onPages"> & {
        onPages?: (number | { page?: number; doing?: string })[];
      };
      return ((body.cast || []) as Raw[]).map((c) => {
        const onPages: number[] = [];
        const notes: Record<number, string> = {};
        for (const entry of c.onPages || []) {
          const raw = typeof entry === "number" ? entry : Number(entry?.page);
          const page = raw - 1;
          if (!Number.isFinite(page) || page < 0 || page >= shrunk.length) continue;
          onPages.push(page);
          const doing = typeof entry === "object" ? entry?.doing : undefined;
          if (doing) notes[page] = String(doing);
        }
        return { ...c, onPages, notes } as CastMember;
      });
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
        notes: { ...(raw.notes || {}) },
        replace: raw.role !== "extra",
      });
      continue;
    }

    seen.onPages = [...new Set([...(seen.onPages || []), ...(raw.onPages || [])])].sort(
      (a, b) => a - b
    );
    seen.notes = { ...(seen.notes || {}), ...(raw.notes || {}) };
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
