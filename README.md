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

**The approach.** Every page render carries a fixed reference for each replaced character, and that
reference is the same on every page.

For a real person the reference is **their photographs, used directly** — an earlier version drew a
character sheet from the photo first, which drifted twice: once on the way into the sheet, and again
within it (four views on one plate came back as four different children).

On upload a vision model locates the head and the client crops to it, and **that crop leads**. A face
occupying 350px of a 4032px family snap is about 110px once the whole frame is scaled to 1280 — far
too little to describe the geometry the renderer is asked to reproduce. The crop spends the image
budget on the part that carries identity; the uncropped photo follows as context, plus at most one
alternate angle. More references dilute rather than reinforce.

Those photographs then build **one canonical identity sheet per person**, generated once at high
quality: four head-and-shoulders views on a plain background, front, three-quarter, profile and a
close-up. That sheet — the *same* sheet — is attached to every page, alongside the face crop and the
photo. Without it each page performs its own photo-to-illustration interpretation and arrives at a
slightly different child, which is exactly the failure. The sheet gives consistency; the photograph
guards against the sheet itself having drifted.

The sheet is framed tightly on the head, in a plain neutral garment. Clothing is not identity, and a
sheet showing a navy suit would force every page to work out that the suit is to be ignored while the
kurta is kept. A head covering that is part of who someone is — a patka, turban, hijab — *is* identity
and is kept.

**You approve it before it is used.** A generated identity sheet is unlocked until you compare it
with the photo and accept, and recasting is blocked until you do. Once locked it is never regenerated
between pages — otherwise the inconsistency has simply moved one stage earlier.

A page render then carries **the page and one locked sheet per person, and nothing else** — no
photographs. Sheet plus photographs is several representations of one face for the model to reconcile
while it is also rebuilding a room, and the sheet already supplies all four angles.

**Then a second pass, when the face is small.** A page render spends its capacity across the whole
room, so a child in the middle distance ends up with perhaps eighty pixels of face — too few to carry
the relationships that make someone recognisable, however well the reference was understood. When the
replaced head comes out under about a third of the frame, the app crops to it, redraws that crop alone
against the locked sheet at high quality, and composites it back with a feathered edge. Prompt wording
cannot manufacture detail the pixel budget never had. Toggle it in Settings.

Characters with **no** photograph get a full-body character sheet instead — front, three-quarter,
profile and a head study — because there is nothing else for them to be consistent against.

Quality matters here in a way it does not elsewhere: identity lives in small facial detail, and `low`
cannot manufacture detail the generation budget does not pay for. Preview at `low`, then **finalise
(high)** on the pages that ship.

Four steps in the UI:

1. **Upload the finished book** — a PDF, or its page images. Rasterised in the browser at 1254px.
2. **The cast reads itself** — when the book loads, a vision model reads every page and works out
   who recurs, returning each character with a description and a role (protagonist, family,
   creature, extra). Attach photos for a real person — several is much better than one — or leave
   it empty and let an original character be invented. Untick anyone who should stay exactly as the
   book drew them; extras default to untouched. **Build sheets** then draws sheets for the invented
   characters only; anyone with a photo needs nothing.
3. **Optional rename and pronouns** — change a character's name where it is printed in the artwork,
   and flip the pronouns if the new child's gender differs from the original. The printed text is
   rewritten with it: pronouns, possessives, and words like boy/girl and son/daughter.
4. **Check the page badges, and pin who is who** — each page shows a badge per cast member: the
   characters that page will be given. Detection fills them in; correct any it got wrong. A page
   carries references only for its badged characters, which is what stops one child being handed two
   children's sheets, and a page with no badges is passed through untouched rather than redrawn.

   Click a page to open it full screen. **prompt** there shows the exact text that page will be sent,
   built from the cast, the pins and the observations — editable, and an edit applies to that page
   only until you reset it. Pick a character, then click that person in the picture to drop a pin. Words stop being able to point once two children are dressed alike — pins do not. The
   pinned page is attached to the render as a numbered guide, and the positions are written out in
   the prompt as well.
5. **Recast** — every page is redrawn with the references attached, several at a time. The page goes
   up first and announces itself as the edit target, so every image after it has an unambiguous job.
   Export a PDF.

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
  re-renders it. Usually right, sometimes not — check pages that carry a name or a pronoun before
  shipping.
- **Nothing is pixel-identical.** Pages are redrawn from the original, so fine background detail can
  shift slightly.
- **State is in the tab.** A refresh loses loaded pages and sheets. Export the PDF before closing.
- **Only the named cast is replaced.** Other people in a scene keep their own faces — deliberate, and
  the prompt says so, because an earlier version cloned the protagonist onto a cousin.
- **Cast detection reads every page**, in batches of about ten, and merges what each batch found.
  It is still a first draft - check it, and edit or add by hand.
- **Faces are held by the references, not the preset.** Three things do the work at `low`: a photo
  goes to the page untouched by any redrawing step, a page carries references only for the people
  who are on it, and photographs are compressed far more gently than artwork. Attaching every
  character to every page is what makes faces average out.

---

## Layout

```
app/
  page.tsx              the whole UI: settings, upload, cast, rename, pages
  api/analyze/route.ts  reads the cast, in batches, every page
  api/generate/route.ts one image per call, both providers, key handling
lib/
  prompts.ts            every prompt, in one place
  recast.ts             settings, the generate call, the concurrency pool, pins
  book.ts               PDF in, page images out, PDF back out
```

Every prompt lives in `lib/prompts.ts` — the cast reader's system prompt, the character sheet, the
page recast and its conditional blocks, and the labels each attached image is announced with. They
are written as template literals with real line breaks so they read as prose and diff cleanly.

One rule governs `recastPrompt`: **it may contain only what the model cannot read off its input
images.** The page already shows the room, the clothing, the pose, the light, the composition and the
body proportions. Describing any of that again spends attention and creates opportunities for
contradiction. It grew to six hundred words of preservation rules once and likeness measurably
dropped; it is about twenty lines now, and nearly all of them are about identity.

When something drifts — a pose, an eyeline, an expression — the fix is usually **not** another rule.
A rule has to be applied; an observation only has to be drawn. The cast reader already looks at every
page, so it also writes down what each character is doing there, and that sentence goes into the page's
own prompt: *"On this page: on tiptoes, right arm reaching up, smiling, looking up at the covered
idol, cream kurta and white pyjama."* One clause, specific to the page, instead of three paragraphs of
general instruction that apply everywhere and land nowhere.
