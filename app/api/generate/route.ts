import { NextRequest, NextResponse } from "next/server";

// One image per request. Generation runs for minutes, well past any budget for a
// whole book in a single call, so the browser owns the queue and progress.
export const maxDuration = 300;
export const runtime = "nodejs";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_GEN_URL = "https://api.openai.com/v1/images/generations";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface Body {
  parts: Part[];
  provider?: "openrouter" | "openai";
  apiKey?: string;
  model?: string;
  quality?: "low" | "medium" | "high" | "auto";
  size?: string;
}

function dataUrlToBlob(url: string): { blob: Blob; name: string } {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!m) throw new Error("reference image is not a base64 data URL");
  const [, mime, b64] = m;
  const bytes = Buffer.from(b64, "base64");
  const ext = mime.split("/")[1].replace("jpeg", "jpg");
  return { blob: new Blob([bytes], { type: mime }), name: `ref.${ext}` };
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed request body" }, { status: 400 });
  }

  const { parts } = body;
  if (!Array.isArray(parts) || parts.length === 0) {
    return NextResponse.json({ error: "parts must be a non-empty array" }, { status: 400 });
  }

  const provider = body.provider === "openai" ? "openai" : "openrouter";
  const quality = body.quality || "low";
  const size = body.size || "1024x1024";

  // A key typed into the UI wins; the server env is the fallback so a deployment
  // can work without anyone pasting one.
  const key =
    body.apiKey?.trim() ||
    (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.OPENROUTER_API_KEY) ||
    "";

  if (!key) {
    const envName = provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY";
    return NextResponse.json(
      { error: `No key for ${provider}. Paste one in Settings, or set ${envName} on the server.` },
      { status: 401 }
    );
  }

  const model =
    body.model?.trim() ||
    (provider === "openai"
      ? process.env.OPENAI_IMAGE_MODEL || "gpt-image-2"
      : process.env.IMAGE_MODEL || "openai/gpt-5.4-image-2");

  try {
    const image =
      provider === "openai"
        ? await viaOpenAI(parts, key, model, quality, size)
        : await viaOpenRouter(parts, key, model, quality, size, req);
    return NextResponse.json({ image, provider, model, quality });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 502 });
  }
}

/**
 * OpenAI Images API. `quality` and `size` are real parameters here.
 *
 * Models differ in which extras they accept - gpt-image-2 rejects
 * `input_fidelity`, gpt-image-1 wants it. Rather than keep a table of which
 * model takes what and watch it rot, send the useful ones and drop whichever the
 * API names as unsupported.
 */
const OPTIONAL_FIELDS = ["input_fidelity", "quality", "size"] as const;

async function viaOpenAI(
  parts: Part[],
  key: string,
  model: string,
  quality: string,
  size: string
): Promise<string> {
  const prompt = parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const images = parts.filter(
    (p): p is Extract<Part, { type: "image_url" }> => p.type === "image_url"
  );

  // Keeps a real face from drifting when a reference is a photograph.
  const optional: Record<string, string> = {
    input_fidelity: "high",
    quality,
    size,
  };
  const dropped: string[] = [];

  for (let attempt = 0; attempt <= OPTIONAL_FIELDS.length; attempt++) {
    let res: Response;

    if (images.length) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("n", "1");
      for (const [k, v] of Object.entries(optional)) form.append(k, v);
      for (const img of images) {
        const { blob, name } = dataUrlToBlob(img.image_url.url);
        form.append("image[]", blob, name);
      }
      res = await fetch(OPENAI_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } else {
      res = await fetch(OPENAI_GEN_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, n: 1, ...optional }),
      });
    }

    if (res.ok) {
      const payload = await res.json();
      const b64 = payload?.data?.[0]?.b64_json;
      if (!b64) {
        throw new Error(`openai returned no image: ${JSON.stringify(payload).slice(0, 300)}`);
      }
      return `data:image/png;base64,${b64}`;
    }

    const text = await res.text();

    // A 400 that names one of our optional fields means this model does not take
    // it. Drop that one and try again rather than failing the whole page.
    if (res.status === 400) {
      const offender = OPTIONAL_FIELDS.find(
        (f) => f in optional && (text.includes(`"${f}"`) || text.includes(`'${f}'`))
      );
      if (offender) {
        delete optional[offender];
        dropped.push(offender);
        continue;
      }
    }

    const note = dropped.length ? ` (already dropped: ${dropped.join(", ")})` : "";
    throw new Error(`openai ${res.status}${note}: ${text.slice(0, 400)}`);
  }

  throw new Error(`openai rejected every optional parameter for ${model}`);
}

/**
 * OpenRouter chat-completions. Image models here often do NOT accept size or
 * quality as parameters, so they are asked for in the prompt instead — a
 * request, not a guarantee. Use the OpenAI provider when it must be enforced.
 */
async function viaOpenRouter(
  parts: Part[],
  key: string,
  model: string,
  quality: string,
  size: string,
  req: NextRequest
): Promise<string> {
  const content: Part[] = [
    ...parts,
    { type: "text", text: `\n--- OUTPUT ---\nRender at ${size}, ${quality} quality preset.` },
  ];

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": req.headers.get("origin") || "https://localhost:3002",
      "X-Title": "Storybook Character Replacement",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
  });

  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const payload = await res.json();
  const msg = payload?.choices?.[0]?.message;
  const url: string | undefined = msg?.images?.[0]?.image_url?.url;
  if (!url) {
    const said = String(msg?.content || "").slice(0, 300);
    throw new Error(`no image from ${model}. Model said: ${said || "(nothing)"}`);
  }
  return url;
}
