import { NextRequest, NextResponse } from "next/server";

// Reads a sample of pages and works out who recurs. Text out, not images, so
// this is quick and cheap compared with a render.
export const maxDuration = 120;
export const runtime = "nodejs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM = `You are a casting director reading a finished children's picture book.

You will be shown pages sampled across the book. Your job is to list EVERY recurring character, so
that a personalised edition knows who it has to replace. Missing someone is the worst outcome here —
a parent who is left off the list silently keeps the old family's face through the whole book.

Work through it properly before you answer:

1. Go page by page and note every person you can see, including anyone standing at the back, partly
   out of frame, seated, turned away, or holding something.
2. Group the sightings: the same person usually appears on many pages in the same clothes.
3. Only then decide who is recurring.

A family picture book almost always contains more than the child. Look specifically for:

- the child the story follows
- a mother and a father, or whichever parents or guardians appear
- grandparents, an uncle or aunt, an older sibling
- a non-human companion — a deity, animal or imaginary friend
- a teacher, neighbour or shopkeeper if they come back

Do not stop at the two or three most prominent faces. An adult who stands in the background of
several pages is still a recurring character and still needs replacing.

For each one return:

- "id": short, lowercase, machine-safe, e.g. "child", "father", "mother", "grandmother", "uncle".
- "label": how a person would refer to them, e.g. "Child", "Father", "Mother", "Grandmother".
- "brief": what they look like, written so an illustrator could draw them from the words alone.
  Age, build, skin tone, hair, face. 30-60 words, concrete and visual. Describe respectfully and
  plainly. Do NOT put clothing in here.
- "wardrobe": only what this character wears in this book, e.g. "a plain cream cotton kurta with
  matching pyjama, barefoot". One short phrase. Kept separate because a replacement may bring their
  own face but should keep the book's costume.
- "role": "protagonist" for the single character the story follows, "family" for the other people
  who would be personalised, "creature" for a non-human character, "extra" for cousins, classmates,
  crowd and passers-by.
- "pages": roughly how many of the pages you were shown they appear on.

Rules:

- Exactly ONE character may be "protagonist".
- Parents and grandparents are "family", never "extra", even when they only stand in the background.
- Mark someone "extra" only if they are genuinely incidental — a child in a crowd, a passer-by.
- An idol, statue or picture is NOT a character. A LIVING version of a deity that walks and acts IS
  one — mark it "creature".
- Order: protagonist, then family, then creature, then extra.

Return JSON only, in this shape:

{"cast":[{"id":"child","label":"Child","brief":"...","wardrobe":"...","role":"protagonist","pages":8}]}`;

interface Body {
  images: string[];
  provider?: "openrouter" | "openai";
  apiKey?: string;
  model?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }

  const images = (body.images || []).filter(Boolean).slice(0, 16);
  if (!images.length) {
    return NextResponse.json({ error: "no page images supplied" }, { status: 400 });
  }

  const provider = body.provider === "openai" ? "openai" : "openrouter";
  const key =
    body.apiKey?.trim() ||
    (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY) ||
    "";
  if (!key) {
    return NextResponse.json(
      { error: `No key for ${provider}. Paste one in Settings.` },
      { status: 401 }
    );
  }

  const model =
    body.model?.trim() ||
    (provider === "openai"
      ? process.env.OPENAI_VISION_MODEL || "gpt-4o"
      : process.env.VISION_MODEL || "google/gemini-2.5-flash");

  const content = [
    { type: "text", text: `Here are ${images.length} pages sampled across the book.` },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  try {
    const res = await fetch(provider === "openai" ? OPENAI_URL : OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(provider === "openrouter"
          ? {
              "HTTP-Referer": req.headers.get("origin") || "https://localhost:3002",
              "X-Title": "Storybook Character Replacement",
            }
          : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const payload = await res.json();
    const raw = payload?.choices?.[0]?.message?.content || "";
    const parsed = extractJson(raw);
    const cast = Array.isArray(parsed?.cast) ? parsed.cast : [];
    if (!cast.length) throw new Error("the model found no recurring characters");
    return NextResponse.json({ cast, model });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 502 });
  }
}

/** Models wrap JSON in prose and fences however firmly you ask them not to. */
function extractJson(text: string): { cast?: unknown[] } | null {
  const trimmed = String(text).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
