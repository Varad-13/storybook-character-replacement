import { NextRequest, NextResponse } from "next/server";
import { CAST_SYSTEM, castBatchIntro, pageLabel } from "@/lib/prompts";

// Reads a run of pages and works out who recurs. Text out, not images, so
// this is quick and cheap compared with a render.
export const maxDuration = 120;
export const runtime = "nodejs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface Body {
  images: string[];
  /** 1-based book page number of the first image in this batch */
  firstPage?: number;
  provider?: "openrouter" | "openai";
  apiKey?: string;
  model?: string;
  /** which slice of the book this is, when the book is read in several calls */
  batch?: { index: number; of: number };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }

  const images = (body.images || []).filter(Boolean).slice(0, 12);
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

  const first = Number(body.firstPage) > 0 ? Number(body.firstPage) : 1;

  // A label before each image is what makes "use the actual book page numbers"
  // answerable - otherwise the model counts attachments and guesses.
  const content = [
    {
      type: "text",
      text: castBatchIntro(
        body.batch?.index || 1,
        body.batch?.of || 1,
        first,
        first + images.length - 1
      ),
    },
    ...images.flatMap((url, k) => [
      { type: "text", text: pageLabel(first + k) },
      { type: "image_url", image_url: { url } },
    ]),
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
          { role: "system", content: CAST_SYSTEM },
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
