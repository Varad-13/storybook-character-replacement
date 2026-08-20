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
              { type: "text", text: "Locate every head in this image." },
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

    const clean = (h: unknown): { box: FaceBox; frontal: boolean; problems: string[] } | null => {
      const o = h as { box?: FaceBox; frontal?: boolean; problems?: unknown[] };
      const bx = o?.box;
      if (!bx || ![bx.x, bx.y, bx.w, bx.h].every((n) => typeof n === "number")) return null;
      return {
        box: { x: bx.x, y: bx.y, w: bx.w, h: bx.h },
        frontal: !!o.frontal,
        problems: Array.isArray(o.problems) ? o.problems.map(String) : [],
      };
    };

    // Accept the older single-box shape too, so a model that answers in the
    // previous format still returns something usable.
    const list = Array.isArray(parsed?.heads) ? parsed.heads : parsed?.box ? [parsed] : [];
    const heads = list.map(clean).filter(Boolean);

    return NextResponse.json({
      heads,
      box: heads[0]?.box || null,
      frontal: heads[0]?.frontal || false,
      problems: heads[0]?.problems || [],
    });
  } catch (e) {
    // A missed crop is a downgrade, not a failure - the uncropped photo still works.
    return NextResponse.json({
      heads: [],
      box: null,
      problems: [],
      error: String((e as Error).message || e),
    });
  }
}
