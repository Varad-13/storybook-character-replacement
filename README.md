# Storybook Character Replacement

Take a finished children's picture book and re-issue it for a different family. Upload the original,
define the new cast, and every page is redrawn with the new characters in place of the old ones —
same composition, same room, same lettering.

Next.js, deploys to Vercel as one piece. No database, no Python, no server storage.

---

## Deploy

Import the repo on Vercel. Nothing else is required — the app works with a key pasted into the UI.

To give the deployment a default key so nobody has to paste one, set any of:

```
OPENROUTER_API_KEY=sk-or-v1-...
IMAGE_MODEL=openai/gpt-5.4-image-2

OPENAI_API_KEY=sk-...
OPENAI_IMAGE_MODEL=gpt-image-2
```

Locally:

```bash
npm install
cp .env.example .env.local     # optional
npm run dev                    # http://localhost:3002
```

---

## Providers and keys

Open **Settings** in the header to choose a provider, paste a key, pick a model, and set the quality
preset. Everything is remembered in the browser's local storage.

A key typed into the UI is sent with each request and **never stored on the server** — the route
forwards it upstream and forgets it. If the field is empty, the server's environment key is used
instead, so a deployment can work with no key in the browser at all.

| | OpenRouter | OpenAI direct |
|---|---|---|
| default model | `openai/gpt-5.4-image-2` | `gpt-image-2` |
| endpoint | chat completions | `/v1/images/edits` |
| `quality` honoured | **no** — asked for in the prompt | **yes** |
| `size` honoured | **no** — asked for in the prompt | **yes** |
| `input_fidelity=high` | n/a | sent when the model takes it (gpt-image-1); dropped automatically when it does not (gpt-image-2) |
| cast detection | `google/gemini-2.5-flash` | `gpt-4o` |

Quality defaults to **low** — fastest and cheapest, and enough to prove out a recast. Raise it for a
final run.

The OpenRouter caveat is real and worth understanding: most image models there do not expose
`quality` or `size` as parameters, so the app appends them to the prompt as a request. It is not
enforced. Use OpenAI direct when the preset has to be guaranteed.

---

## How it works

**The problem.** Swapping a face page-by-page gives you a different child on every page. Consistency
has to come from a fixed reference, not from each page's imagination.

**The approach.** Each cast member gets ONE character sheet — front, three-quarter, profile and a
head study on a single plate — and that sheet is attached to every page render. It locks the body as
much as the face: build, height, head-to-body proportion, limb length, hand size. A swapped head on
the old body is the failure this is designed to avoid.

Four steps in the UI:

1. **Upload the finished book** — a PDF, or its page images. Rasterised in the browser at 1254px.
2. **The cast reads itself** — when the book loads, a vision model reads every page and works out
   who recurs, returning each character with a description and a role (protagonist,
   family, creature, extra). You then attach a photo for a real person, or leave it empty and let an
   original character be invented. Untick anyone who should stay exactly as the book drew them —
   extras default to untouched. Then build the sheets.
3. **Optional rename** — change a character's name where it is printed in the artwork.
4. **Recast** — every page is redrawn with the sheets attached, several at a time. Export a PDF.

### Where the work happens

Generation takes minutes per page, far past a serverless request budget for a whole book. So
`/api/generate` handles exactly **one** image and returns it; the browser owns the queue, the
concurrency and the progress. Pages, sheets and outputs stay in browser memory.

`maxDuration` is 300s (see `vercel.json`). Vercel Hobby caps invocations well below that, so a single
page render can be cut off — use a plan that allows long invocations.

---

## Likeness

Leave a cast member's photo empty and the app invents an original character, with the prompt
explicitly instructing that they must not resemble any real or well-known person.

Use real photographs only for people who have agreed to appear — normally the family commissioning
the book. Do not use photographs of public figures: putting a real person's likeness into a
personalised book as someone's family is a commercial use of that likeness without consent, whatever
the demo is for. Invented characters demonstrate consistency exactly as well, and the sheets are
reusable across pitches.

---

## Known limits

- **Lettering is redrawn, not copied.** The text is baked into the artwork, so every recast page
  re-renders it. Usually right, sometimes not — check pages that carry a name before shipping.
- **Nothing is pixel-identical.** Pages are redrawn from the original, so fine background detail can
  shift slightly.
- **State is in the tab.** A refresh loses loaded pages and sheets. Export the PDF before closing.
- **Only the named cast is replaced.** Other people in a scene keep their own faces — deliberate, and
  the prompt says so, because an earlier version cloned the protagonist onto a cousin.
- **Cast detection reads every page**, in batches of about ten, and merges what each batch found.
  It is still a first draft - check it, and edit or add by hand.
- **Faces drift at low quality.** The `low` preset is fine for proving out a recast; raise it before
  shipping. Note that OpenRouter ignores the preset entirely, and `gpt-image-2` does not accept
  `input_fidelity`, so on that combination the prompt is the only thing holding a face steady.

---

## Layout

```
app/
  page.tsx              the whole UI: settings, upload, cast, rename, pages
  api/generate/route.ts one image per call, both providers, key handling
lib/
  recast.ts             prompts, settings, the generate call, the concurrency pool
  book.ts               PDF in, page images out, PDF back out
```

The two prompts worth tuning are `platePrompt` and `recastPrompt` in `lib/recast.ts` — they carry the
whole consistency argument.
