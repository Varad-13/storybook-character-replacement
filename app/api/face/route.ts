import { NextRequest, NextResponse } from "next/server";
import { FACE_SYSTEM } from "@/lib/prompts";

// Locates the head in an uploaded photograph so the client can crop to it. Text
// out, one small image in, so this is quick and cheap.
export const maxDuration = 60;
export const runtime = "nodejs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

interface Body {
  image: string;
  provider?: "openrouter" | "openai";
  apiKey?: string;
  model?: string;
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }
  if (!body.image) return NextResponse.json({ error: "no image supplied" }, { status: 400 });

  const provider = body.provider === "openai" ? "openai" : "openrouter";
  const key =
    body.apiKey?.trim() ||
    (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY) ||
    "";
  if (!key) {
    return NextResponse.json({ error: `No key for ${provider}.` }, { status: 401 });
  }

  const model =
    body.model?.trim() ||
    (provider === "openai"
      ? process.env.OPENAI_VISION_MODEL || "gpt-4o"
      : process.env.VISION_MODEL || "google/gemini-2.5-flash");

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
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: FACE_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Locate the head in this photograph." },
              { type: "image_url", image_url: { url: body.image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const payload = await res.json();
    const raw = String(payload?.choices?.[0]?.message?.content || "");
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());

    const b = parsed?.box;
    const box: FaceBox | null =
      b && [b.x, b.y, b.w, b.h].every((n: unknown) => typeof n === "number")
        ? { x: b.x, y: b.y, w: b.w, h: b.h }
        : null;

    return NextResponse.json({
      box,
      frontal: !!parsed?.frontal,
      problems: Array.isArray(parsed?.problems) ? parsed.problems.map(String) : [],
    });
  } catch (e) {
    // A missed crop is a downgrade, not a failure - the uncropped photo still works.
    return NextResponse.json({ box: null, problems: [], error: String((e as Error).message || e) });
  }
}
