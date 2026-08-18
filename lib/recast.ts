// Everything the recast needs, on the client. The API route is a thin proxy so
// the key never reaches the browser; orchestration, concurrency and progress
// live here because a single serverless call can only carry one image.

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const STYLE =
  "Premium children's picture-book illustration: photographic faces in a softly painted, warm, " +
  "brightly lit world. Natural skin tones, gentle painterly edges, no cartoon styling, no glossy 3D.";

export interface CastMember {
  id: string;
  label: string;
  /** data URL of a real photograph, when the character is a real person */
  photo?: string;
  /** what this character looks like and wears */
  brief: string;
  /** rendered character sheet, once generated */
  plate?: string;
}

export const DEFAULT_CAST: CastMember[] = [
  {
    id: "child",
    label: "Child",
    brief:
      "a boy of about 5-6. Keep his real face exactly as the photograph shows: face shape, cheeks, " +
      "jaw, eye shape and spacing, brows, nose, mouth, ears, skin tone, apparent age. Dress him in " +
      "a plain cream cotton kurta with matching pyjama, barefoot.",
  },
  {
    id: "papa",
    label: "Father",
    brief:
      "an ORIGINAL, INVENTED father who must not resemble any real or well-known person. An Indian " +
      "man of about 38: medium build, warm brown skin, open friendly face, short neat black hair " +
      "with a little grey at the temples, clean-shaven. Dress him in a deep red festive cotton " +
      "kurta with cream pyjama, barefoot.",
  },
  {
    id: "mumma",
    label: "Mother",
    brief:
      "an ORIGINAL, INVENTED mother who must not resemble any real or well-known person. An Indian " +
      "woman of about 34: warm brown skin, round kind face, long dark wavy hair worn loosely back, " +
      "a warm unforced smile. Dress her in a magenta-pink cotton salwar kameez with a soft dupatta, " +
      "barefoot.",
  },
  {
    id: "dadi",
    label: "Grandmother",
    brief:
      "an ORIGINAL, INVENTED grandmother who must not resemble any real or well-known person. An " +
      "Indian woman of about 70: warm brown skin, soft lined face, silver-grey hair in a neat low " +
      "bun, small red bindi. Dress her in a pale sage cotton saree with a thin gold border, barefoot.",
  },
];

export function platePrompt(m: CastMember, extraIdentity = ""): string {
  return (
    `${STYLE}\n\n` +
    `Build a CHARACTER SHEET for ${m.brief}\n` +
    (extraIdentity ? `${extraIdentity}\n` : "") +
    (m.photo
      ? "Take the face from the attached photograph. Ignore its clothing, background and lighting.\n"
      : "") +
    "\nOn one square plate against a plain flat off-white background, draw the SAME character four " +
    "times at the same height: full-body front, full-body three-quarter, full-body profile, and a " +
    "larger head study. Keep build, height, head-to-body proportion, limb length and hand size " +
    "identical across all four — this sheet is what every page copies the BODY from, not only the " +
    "face. Even neutral lighting. No lettering anywhere in the image."
  );
}

export function recastPrompt(names: string[], rename?: { from: string; to: string }): string {
  const cast = names.join(", ");
  const renameLine = rename?.from
    ? `LETTERING. Reproduce every word of the printed text exactly as it appears — same typeface, ` +
      `size, colour and position — with ONE change: wherever the name "${rename.from}" appears, ` +
      `write "${rename.to}" instead. Change nothing else about the words. Keep the text crisp and ` +
      `correctly spelled.`
    : `LETTERING. Reproduce every word of the printed text exactly as it appears — same typeface, ` +
      `size, colour, spelling and position. Do not reword, add or drop anything.`;

  return `${STYLE}

You are re-issuing one finished page of an existing children's picture book for a different family.

The LAST attached image is the finished page. The images before it are locked character sheets for
the new cast: ${cast}.

Redraw this exact page with the new cast in place of the old one.

WHO IS REPLACED. Only the characters named above are replaced. Everyone else in the picture —
cousins, other children, visiting relatives, anyone in the background — is NOT part of the new cast.
They keep their own face, their own hair, their own build and the exact clothes the original page
gives them. A cousin in a blue kurta stays a different child in a blue kurta.

REPLACE COMPLETELY, not just the face. For the characters who ARE replaced, the whole person comes
from their sheet — face, head, hair and any head covering, skin tone, build, height, body
proportions, hands and feet. A swapped head on the old body is wrong.

COUNT THE PEOPLE. The finished page must contain exactly the same number of people as the original,
each a distinct individual standing where they stood. Never draw two of the same character. The
character sheets show each person several times only so you can see them from different angles —
that is reference, never an instruction to repeat anyone in the scene.

KEEP EVERYTHING ELSE IDENTICAL. Same composition and camera. Each character stands exactly where
they stood, at the same size in frame, in the same pose, doing the same thing, looking the same way.
Same clothing design and colour as the page already shows. Same room, furniture, props, decoration,
light, shadows and palette. Nothing enters or leaves the picture.

${renameLine}

Match the original page's finish: photographic faces, softly painted surroundings, the same bright
warm light.`;
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
  quality: "low" | "medium" | "high" | "auto";
  size: string;
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  apiKey: "",
  model: "",
  quality: "low",
  size: "1024x1024",
  concurrency: 4,
};

export const MODEL_HINTS: Record<Settings["provider"], string> = {
  openrouter: "openai/gpt-5.4-image-2",
  openai: "gpt-image-1",
};

export async function generate(
  parts: Part[],
  settings?: Partial<Settings>,
  retries = 2
): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts,
          provider: settings?.provider,
          apiKey: settings?.apiKey,
          model: settings?.model,
          quality: settings?.quality,
          size: settings?.size,
        }),
      });
      const body = await res.json();
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
