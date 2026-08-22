"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CastMember,
  Mark,
  Observation,
  Pronouns,
  DEFAULT_SETTINGS,
  FALLBACK_CAST,
  detectCast,
  MODEL_HINTS,
  Settings,
  generate,
  image,
  annotate,
  LABELS,
  PRONOUN_LABEL,
  faceCrop,
  identityRefs,
  refineFace,
  refineRefs,
  photosOf,
  IDENTITY_PROMPT,
  platePrompt,
  pool,
  pronounNote,
  replaceOnePrompt,
  text,
} from "@/lib/recast";
import { buildPdf, download, fileToDataUrl, pagesFromImages, pagesFromPdf } from "@/lib/book";

type PageState = {
  src: string;
  out?: string;
  status: "idle" | "running" | "done" | "failed";
  error?: string;
  /** cast member ids to replace on this page - seeded by detection, yours to fix */
  cast?: string[];
  /** pins saying which person in the artwork is which cast member */
  marks?: Mark[];
  /** hand-edited prompt, used instead of the built one for this page */
  prompt?: string;
  /** quality for this page only - "finalise" after a cheaper first look */
  quality?: "medium" | "high";
};

export default function Home() {
  const [pages, setPages] = useState<PageState[]>([]);
  const [cast, setCast] = useState<CastMember[]>([]);
  const [title, setTitle] = useState("Recast Book");
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [pronouns, setPronouns] = useState<Pronouns>("none");
  /** which page is open full-screen, and who the next pin belongs to */
  const [viewing, setViewing] = useState<number | null>(null);
  const [pinning, setPinning] = useState<string>("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  // Keys stay in this browser: sent to our own API route per request, never
  // written down server-side.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("scr.settings");
      // Older builds stored "low" or "auto"; medium is the floor now.
      if (saved) {
        const s = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        if (s.quality !== "high") s.quality = "medium";
        setSettings(s);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("scr.settings", JSON.stringify(settings));
    } catch {}
  }, [settings]);

  const concurrency = settings.concurrency;
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const bookRef = useRef<HTMLInputElement>(null);

  const say = useCallback(
    (m: string) => setLog((l) => [...l.slice(-200), `${new Date().toLocaleTimeString()}  ${m}`]),
    []
  );

  const activeCast = useMemo(
    () => cast.filter((c) => (c.photo || c.plate) && c.replace !== false),
    [cast]
  );
  /** Photographed people whose identity sheet exists but has not been accepted. */
  const unapproved = useMemo(
    () => cast.filter((c) => c.replace !== false && c.identity && !c.identityLocked),
    [cast]
  );
  // Pinning and badging are planning, not rendering: you should be able to say
  // who is who while the sheets are still building, or before you start them.
  const replaceCast = useMemo(() => cast.filter((c) => c.replace !== false), [cast]);
  const doneCount = pages.filter((p) => p.out).length;

  /* ------------------------------------------------------------ load book */

  async function loadBook(files: FileList | null) {
    if (!files?.length) return;
    setBusy("Reading book");
    try {
      const list = Array.from(files);
      const srcs = list[0].type === "application/pdf"
        ? await pagesFromPdf(list[0], (d, t) => say(`page ${d}/${t} extracted`))
        : await pagesFromImages(list);
      setPages(srcs.map((src) => ({ src, status: "idle" })));
      say(`loaded ${srcs.length} pages`);

      setBusy("Reading the cast");
      say("working out who appears in this book");
      try {
        const found = await detectCast(srcs, settings, (d, t) =>
          setBusy(`Reading the cast — ${d}/${t} pages`)
        );
        setCast(found);
        setPages((ps) => ps.map((x, i) => ({ ...x, cast: seedPageCast(found, i) })));
        say(
          `found ${found.length}: ` +
            found.map((c) => `${c.label}${c.role === "extra" ? " (extra)" : ""}`).join(", ")
        );
      } catch (e) {
        setCast(FALLBACK_CAST);
        say(`cast detection failed, using a blank starting point — ${(e as Error).message}`);
      }
    } catch (e) {
      say(`load failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /* ---------------------------------------------------------- cast plates */

  async function makePlates(only?: string) {
    // A photographed person gets a canonical identity sheet built from their
    // photos; an invented one gets a character sheet drawn from their brief.
    // Both are built once and then reused unchanged on every page - that
    // constancy is the whole point, and rebuilding between pages would put the
    // drift back exactly where it was.
    const targets = cast.filter((c) => {
      if (only) return c.id === only;
      if (c.replace === false) return false;
      return c.photo ? !c.identity && !c.identityLocked : !c.plate;
    });
    if (!targets.length) return say("every character already has a locked reference");

    setBusy("Building identity references");
    try {
      await pool(targets, concurrency, async (m) => {
        const fromPhoto = !!m.photo;
        say(`${m.label}: building ${fromPhoto ? "identity sheet" : "character sheet"}`);
        try {
          if (fromPhoto) {
            const { primary, supporting } = identityRefs(m);
            const parts = [
              text("Primary identity photograph:"),
              image(primary!, "high"),
              ...supporting.flatMap((src) => [
                text("The same person, another angle:"),
                image(src, "high"),
              ]),
              text(IDENTITY_PROMPT),
            ];
            // Paid for once against twenty-odd page renders: the one place in
            // the pipeline where the high preset is unambiguously worth it.
            const img = await generate(parts, { ...settings, quality: "high" });
            setCast((c) =>
              c.map((x) => (x.id === m.id ? { ...x, identity: img, identityLocked: false } : x))
            );
            say(`${m.label}: identity ready — check it against the photo, then accept`);
          } else {
            const img = await generate([text(platePrompt(m))], settings);
            setCast((c) => c.map((x) => (x.id === m.id ? { ...x, plate: img } : x)));
            say(`${m.label}: sheet ready`);
          }
        } catch (e) {
          say(`${m.label}: FAILED — ${(e as Error).message}`);
        }
      });
    } finally {
      setBusy(null);
    }
  }

  const rename = renameFrom.trim() ? { from: renameFrom.trim(), to: renameTo.trim() } : undefined;
  const labelOf = useCallback(
    (id: string) => cast.find((c) => c.id === id)?.label || id,
    [cast]
  );

  const newLabelOf = useCallback(
    (c: CastMember) => (c.role === "protagonist" && rename?.to ? rename.to : c.label),
    [rename]
  );

  /**
   * The passes page `i` will run, one per character.
   *
   * A hand-edited prompt replaces the whole sequence with a single pass, so the
   * prompt panel still means "this is what gets sent".
   */
  const passesFor = useCallback(
    (i: number): { c?: CastMember; badge?: number; prompt: string }[] => {
      const page = pages[i];
      if (!page) return [];
      const onPage = castOnPage(replaceCast, page, i);
      if (!onPage.length) return [];
      if (page.prompt !== undefined) return [{ prompt: page.prompt }];

      const marks = (page.marks || []).filter((m) => onPage.some((c) => c.id === m.id));
      const words = [
        rename?.from ? `in the printed text, write "${rename.to}" wherever it says "${rename.from}"` : "",
        pronounNote(pronouns, rename?.to || onPage.find((c) => c.role === "protagonist")?.label),
      ]
        .filter(Boolean)
        .join("; ");

      return onPage.map((c, k) => {
        const at = marks.findIndex((m) => m.id === c.id);
        return {
          c,
          badge: at === -1 ? undefined : at + 1,
          prompt: replaceOnePrompt(c, {
            badge: at === -1 ? undefined : at + 1,
            note: c.notes?.[i],
            // Text edits ride on the last pass only - asking for them on every
            // pass invites the text to be redrawn once per character.
            lettering: k === onPage.length - 1 && words ? words : undefined,
          }),
        };
      });
    },
    [pages, replaceCast, rename, pronouns]
  );

  /** What the prompt panel shows: every pass, in order. */
  const promptFor = useCallback(
    (i: number) =>
      passesFor(i)
        .map((p, k, all) =>
          all.length > 1 ? `— pass ${k + 1} of ${all.length} —

${p.prompt}` : p.prompt
        )
        .join("\n\n\n"),
    [passesFor]
  );

  /* -------------------------------------------------------------- recast */

  async function recast(indices?: number[]) {
    if (!activeCast.length) return say("attach a photo, or build a sheet, for at least one character");
    // Asking for specific pages means redo them, done or not. Clearing `out`
    // and calling straight through would otherwise read the pre-clear state and
    // filter the page right back out - which is why redo did nothing.
    const targets = (indices ?? pages.map((_, i) => i).filter((i) => !pages[i].out)).filter(
      (i) => pages[i]
    );
    if (!targets.length) return say("nothing left to recast");
    if (unapproved.length) {
      say(
        `accept or redo the identity for ${unapproved
          .map((c) => c.label)
          .join(", ")} first — locking it is what keeps the face the same across pages`
      );
      return;
    }

    setBusy(`Recasting ${targets.length} pages`);

    try {
      await pool(targets, concurrency, async (i) => {
        setPages((p) => p.map((x, j) => (j === i ? { ...x, status: "running" } : x)));
        try {
          // Only the people the badges say are on this page. Nine reference
          // images for a two-person page divides the model's attention, which
          // is how faces average out and how one character's headwear lands on
          // another.
          const onPage = castOnPage(replaceCast, pages[i], i);
          const unbuilt = onPage.filter((c) => !c.plate && !c.photo);
          if (unbuilt.length) {
            throw new Error(
              `${unbuilt.map((c) => c.label).join(", ")} has neither a photo nor a sheet`
            );
          }
          if (!onPage.length) {
            setPages((p) =>
              p.map((x, j) => (j === i ? { ...x, out: x.src, status: "done" } : x))
            );
            say(`page ${i + 1} kept as-is — no cast badged`);
            return;
          }
          // Pins for people who are still badged; unbadging someone drops theirs.
          const marks = (pages[i].marks || []).filter((m) =>
            onPage.some((c) => c.id === m.id)
          );
          const quality = pages[i].quality
            ? { ...settings, quality: pages[i].quality }
            : settings;

          // One character per generation, each pass editing the last one's
          // output. Replacing everyone at once asks the model to hold several
          // identities and a whole room simultaneously, and the faces average
          // out; this way every generation has exactly one job and the work
          // accumulates instead of being redone.
          const passes = passesFor(i);
          let img = pages[i].src;
          for (const [k, pass] of passes.entries()) {
            const guide = marks.length
              ? [text(LABELS.guide), image(await annotate(img, marks, labelOf), "high")]
              : [];
            const ref = pass.c ? pass.c.identity || pass.c.plate : undefined;
            const parts = [
              text(LABELS.page),
              image(img),
              ...guide,
              ...(ref && pass.c
                ? [text(LABELS.plate(newLabelOf(pass.c))), image(ref, "high")]
                : onPage.flatMap((c) => [
                    text(LABELS.plate(newLabelOf(c))),
                    image((c.identity || c.plate)!, "high"),
                  ])),
              text(pass.prompt),
            ];
            img = await generate(parts, quality);
            // Shown as it goes, so a run that fails halfway still leaves the
            // characters it did finish.
            setPages((p) =>
              p.map((x, j) =>
                j === i ? { ...x, out: img, status: k === passes.length - 1 ? "done" : "running" } : x
              )
            );
            say(
              passes.length > 1
                ? `page ${i + 1}: ${pass.c?.label || "edit"} replaced (${k + 1}/${passes.length})`
                : `page ${i + 1} done`
            );
          }

          // The page render spends its capacity on the whole room, so a person
          // in the middle distance gets very few pixels of face. Give each of
          // them their own frame when they came out small.
          if (settings.refineFaces) {
            let current = img;
            for (const c of onPage) {
              const at = marks.find((m) => m.id === c.id);
              // With several people in shot, the pin is the only thing that
              // says which head is theirs - guessing would refine the wrong
              // person against this one's reference.
              if (!at && onPage.length > 1) {
                say(`page ${i + 1}: ${c.label} not pinned, skipping refinement`);
                continue;
              }
              try {
                const better = await refineFace(
                  current,
                  refineRefs(c, settings.refineWith),
                  // Same preset as the page it came from, including a per-page
                  // "finalise" override.
                  pages[i].quality ? { ...settings, quality: pages[i].quality } : settings,
                  { at }
                );
                if (!better) continue;
                current = better;
                setPages((p) => p.map((x, j) => (j === i ? { ...x, out: better } : x)));
                say(`page ${i + 1}: ${c.label}'s face refined`);
              } catch (e) {
                say(`page ${i + 1}: ${c.label} refinement skipped — ${(e as Error).message}`);
              }
            }
          }
        } catch (e) {
          const error = (e as Error).message;
          setPages((p) => p.map((x, j) => (j === i ? { ...x, status: "failed", error } : x)));
          say(`page ${i + 1} FAILED — ${error}`);
        }
      });
    } finally {
      setBusy(null);
    }
  }

  async function exportPdf() {
    const done = pages.filter((p) => p.out).map((p) => p.out!);
    if (!done.length) return say("no recast pages yet");
    setBusy("Building PDF");
    try {
      const blob = await buildPdf(done, title);
      download(blob, `${title.replace(/[^a-z0-9]+/gi, "-")}.pdf`);
      say(`PDF built — ${done.length} pages`);
      if (done.length < pages.length) say(`note: ${pages.length - done.length} pages not recast yet`);
    } catch (e) {
      say(`PDF failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  /* ----------------------------------------------------------------- ui */

  return (
    <main className="mx-auto max-w-[1500px] px-6 pb-32">
      <header className="sticky top-0 z-30 -mx-6 mb-8 border-b border-edge bg-ink/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-marigold">Dots &amp; Tales</div>
            <div className="text-sm font-semibold">Storybook Recast</div>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-lg border border-edge bg-panel px-3 py-2 text-xs outline-none focus:border-marigold"
          />
          <div className="mono text-[11px] text-muted">
            {pages.length} pages ·{" "}
            {cast.filter((c) => c.identityLocked || (!c.photo && c.plate)).length}/
            {cast.filter((c) => c.replace !== false).length} locked · {doneCount} recast
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Btn onClick={() => setShowSettings((v) => !v)}>
              {settings.apiKey ? "Settings OK" : "Settings"}
            </Btn>
            <Btn onClick={() => makePlates()} disabled={!!busy}>Build identities</Btn>
            <Btn onClick={() => recast()} disabled={!!busy || !pages.length} primary>
              Recast all
            </Btn>
            <Btn onClick={exportPdf} disabled={!!busy || !doneCount}>Export PDF</Btn>
          </div>
        </div>
        {busy && (
          <div className="mt-3 flex items-center gap-2 text-xs text-marigold">
            <span className="h-2 w-2 animate-pulse rounded-full bg-marigold" />
            {busy}… {doneCount > 0 && `${doneCount}/${pages.length}`}
          </div>
        )}
      </header>

      {showSettings && (
        <div className="mb-8 rounded-xl border border-edge bg-panel p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">Provider and key</h2>
            <span className="text-[11px] text-muted">
              Your key stays in this browser. It is sent with each request and never stored on the
              server.
            </span>
            <button
              onClick={() => setShowSettings(false)}
              className="ml-auto text-muted hover:text-cream"
            >
              close
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Provider</div>
              <select
                value={settings.provider}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    provider: e.target.value as Settings["provider"],
                    model: "",
                  }))
                }
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI direct</option>
              </select>
            </label>

            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={settings.refineFaces}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, refineFaces: e.target.checked }))
                }
                className="mt-0.5"
              />
              <span>
                <b>Refine small faces</b>
                <span className="block text-[10px] leading-relaxed text-muted">
                  After a page renders, if a replaced face came out small, crop to the head,
                  enlarge it to a full canvas and redraw it. Runs at the same quality preset as the
                  page, so &ldquo;finalise&rdquo; carries it too. One extra generation per affected
                  person. Pages with several people need pins so the right head is picked.
                </span>
              </span>
            </label>

            {settings.refineFaces && (
              <label className="block">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                  Refine against
                </div>
                <select
                  value={settings.refineWith}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      refineWith: e.target.value as Settings["refineWith"],
                    }))
                  }
                  className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
                >
                  <option value="sheet">the locked identity sheet</option>
                  <option value="photo">the real photograph</option>
                  <option value="both">both</option>
                </select>
                <p className="mt-1 text-[10px] leading-relaxed text-muted">
                  Worth an A/B. The sheet is consistent across pages but is one generation removed
                  from the person; the photo is ground truth but only one angle. Keep the prompt
                  fixed and change only this.
                </p>
              </label>
            )}

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">API key</div>
              <input
                type="password"
                value={settings.apiKey}
                placeholder="leave empty to use the server key"
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              />
            </label>

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Image model</div>
              <input
                value={settings.model}
                placeholder={MODEL_HINTS[settings.provider]}
                onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              />
            </label>

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                Vision model
              </div>
              <input
                value={settings.visionModel}
                placeholder={settings.provider === "openai" ? "gpt-4o" : "google/gemini-2.5-flash"}
                onChange={(e) => setSettings((s) => ({ ...s, visionModel: e.target.value }))}
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              />
            </label>

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Quality</div>
              <select
                value={settings.quality}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, quality: e.target.value as Settings["quality"] }))
                }
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              >
                <option value="medium">medium — the floor</option>
                <option value="high">high</option>
              </select>
            </label>

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Size</div>
              <select
                value={settings.size}
                onChange={(e) => setSettings((s) => ({ ...s, size: e.target.value }))}
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              >
                <option value="1024x1024">1024 x 1024</option>
                <option value="1536x1024">1536 x 1024</option>
                <option value="1024x1536">1024 x 1536</option>
              </select>
            </label>

            <label className="block">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                Pages at once
              </div>
              <input
                type="number"
                min={1}
                max={8}
                value={settings.concurrency}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    concurrency: Math.max(1, Math.min(8, +e.target.value || 1)),
                  }))
                }
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2 text-xs outline-none focus:border-marigold"
              />
            </label>
          </div>

          {settings.provider === "openrouter" && (
            <p className="mt-3 text-[11px] text-muted">
              Most image models on OpenRouter do not accept quality or size as parameters, so they
              are requested in the prompt rather than enforced. Switch to OpenAI direct when the
              preset has to be guaranteed.
            </p>
          )}
        </div>
      )}

      {/* 1. book */}
      <Section n={1} title="The finished book" note="A PDF of the original, or its page images.">
        <div className="flex flex-wrap items-center gap-3">
          <Btn onClick={() => bookRef.current?.click()} disabled={!!busy}>
            {pages.length ? "Replace book" : "Upload book"}
          </Btn>
          <input
            ref={bookRef}
            type="file"
            accept="application/pdf,image/*"
            multiple
            hidden
            onChange={(e) => loadBook(e.target.files)}
          />
          <span className="text-xs text-muted">
            {pages.length ? `${pages.length} pages loaded` : "nothing loaded yet"}
          </span>
        </div>
      </Section>

      {/* 2. cast */}
      <Section
        n={2}
        title="The new cast"
        note="Read from the book you uploaded. Attach a photo for a real person; leave it empty and an original character is invented — use that for anyone whose likeness you do not have rights to. Untick a character to leave them exactly as the book drew them."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Btn
            onClick={async () => {
              if (!pages.length) return say("upload a book first");
              setBusy("Reading the cast");
              try {
                const found = await detectCast(
                  pages.map((p) => p.src),
                  settings,
                  (d, t) => setBusy(`Reading the cast — ${d}/${t} pages`)
                );
                setCast(found);
                setPages((ps) => ps.map((x, i) => ({ ...x, cast: seedPageCast(found, i) })));
                say(`found ${found.length}: ${found.map((c) => c.label).join(", ")}`);
              } catch (e) {
                say(`cast detection failed — ${(e as Error).message}`);
              } finally {
                setBusy(null);
              }
            }}
            disabled={!!busy || !pages.length}
          >
            Re-read cast
          </Btn>
          <Btn
            onClick={() =>
              setCast((c) => [
                ...c,
                {
                  id: `char${c.length + 1}`,
                  label: `Character ${c.length + 1}`,
                  brief: "",
                  role: "family",
                  replace: true,
                },
              ])
            }
            disabled={!!busy}
          >
            Add character
          </Btn>
          <span className="text-xs text-muted">
            {cast.length ? `${cast.filter((c) => c.replace !== false).length} to replace` : "none yet"}
          </span>
        </div>
        {!cast.length && (
          <p className="text-sm text-muted">
            Upload a book and its cast is read automatically.
          </p>
        )}
        {cast.length > 0 && !cast.some((c) => c.role === "family") && (
          <p className="mb-3 rounded-lg border border-terracotta/40 bg-terracotta/10 px-3 py-2 text-xs">
            No parents or other family were found — only{" "}
            {cast.map((c) => c.label).join(", ")}. Most family books have more. Try{" "}
            <b>Re-read cast</b>, or add them by hand.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {cast.map((m) => (
            <CastCard
              key={m.id}
              member={m}
              busy={!!busy}
              onToggle={() =>
                setCast((c) =>
                  c.map((x) => (x.id === m.id ? { ...x, replace: x.replace === false } : x))
                )
              }
              onRemove={() => setCast((c) => c.filter((x) => x.id !== m.id))}
              onPhoto={async (files) => {
                const added = await Promise.all(files.map(fileToDataUrl));
                let all: string[] = [];
                setCast((c) =>
                  c.map((x) => {
                    if (x.id !== m.id) return x;
                    all = [...(x.photo ? [x.photo, ...(x.photos || [])] : []), ...added];
                    // The sheet was drawn from the old set, so it is now stale.
                    return { ...x, photo: all[0], photos: all.slice(1), plate: undefined };
                  })
                );
                if (!all.length) return;
                const { crop, problems } = await faceCrop(all[0], settings);
                if (problems.length) say(`${m.label} photo: ${problems.join(", ")}`);
                if (crop) {
                  setCast((c) => c.map((x) => (x.id === m.id ? { ...x, faceCrop: crop } : x)));
                  say(`${m.label}: cropped to the face`);
                } else {
                  say(`${m.label}: no face found, using the whole photo`);
                }
              }}
              onDropPhoto={(at) =>
                setCast((c) =>
                  c.map((x) => {
                    if (x.id !== m.id) return x;
                    const rest = (x.photos || []).filter((_, k) => k !== at);
                    return { ...x, photos: rest, plate: undefined };
                  })
                )
              }
              onLock={() =>
                setCast((c) =>
                  c.map((x) => (x.id === m.id ? { ...x, identityLocked: true } : x))
                )
              }
              onUnlock={() =>
                setCast((c) =>
                  c.map((x) => (x.id === m.id ? { ...x, identityLocked: false } : x))
                )
              }
              onRecrop={async () => {
                if (!m.photo) return;
                const { crop, problems } = await faceCrop(m.photo, settings);
                if (problems.length) say(`${m.label} photo: ${problems.join(", ")}`);
                setCast((c) => c.map((x) => (x.id === m.id ? { ...x, faceCrop: crop } : x)));
                say(crop ? `${m.label}: re-cropped` : `${m.label}: no face found`);
              }}
              onBrief={(brief) =>
                setCast((c) => c.map((x) => (x.id === m.id ? { ...x, brief } : x)))
              }
              onRedraw={() => {
                setCast((c) =>
                  c.map((x) =>
                    x.id === m.id
                      ? { ...x, plate: undefined, identity: undefined, identityLocked: false }
                      : x
                  )
                );
                makePlates(m.id);
              }}
            />
          ))}
        </div>
      </Section>

      {/* 3. rename */}
      <Section n={3} title="Rename in the artwork" note="Optional. The text is drawn into each page, so this is a redraw, not a find-and-replace — check the result.">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            value={renameFrom}
            onChange={(e) => setRenameFrom(e.target.value)}
            placeholder="old name in the book"
            className="w-52 rounded-lg border border-edge bg-panel px-3 py-2 outline-none focus:border-marigold"
          />
          <span className="text-muted">→</span>
          <input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            placeholder="new name"
            className="w-52 rounded-lg border border-edge bg-panel px-3 py-2 outline-none focus:border-marigold"
          />
          <label className="ml-4 flex items-center gap-2 text-sm text-muted">
            Pronouns in the text
            <select
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value as Pronouns)}
              className="rounded-lg border border-edge bg-panel px-3 py-2 text-fg outline-none focus:border-marigold"
            >
              {(Object.keys(PRONOUN_LABEL) as Pronouns[]).map((k) => (
                <option key={k} value={k}>
                  {PRONOUN_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">
          Set this when the new child&apos;s gender differs from the original. The printed text is
          rewritten with it — pronouns, possessives, and words like boy/girl and son/daughter.
        </p>
      </Section>

      {/* 4. pages */}
      <Section
        n={4}
        title="Pages"
        note="Original on the left of each pair, recast on the right. L/M/H sets the quality for that page alone — highlighted means it overrides the preset, click again to clear. The badges are the characters that page will be given; detection fills them in, correct any it got wrong before you recast."
      >
        {!pages.length ? (
          <p className="text-sm text-muted">Upload a book to begin.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            {pages.map((p, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-edge bg-panel">
                <div
                  className="grid cursor-zoom-in grid-cols-2"
                  onClick={() => {
                    setViewing(i);
                    setPinning(castOnPage(replaceCast, p, i)[0]?.id || "");
                  }}
                  title="Open full screen to pin who is who"
                >
                  <img src={p.src} alt={`original ${i + 1}`} className="aspect-square w-full object-cover opacity-50" />
                  {p.out ? (
                    <img src={p.out} alt={`recast ${i + 1}`} className="aspect-square w-full object-cover" />
                  ) : (
                    <div className={`aspect-square w-full ${p.status === "running" ? "shimmer" : "bg-ink"}`} />
                  )}
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2 text-[11px]">
                  <span className="mono text-muted">p{i + 1}</span>
                  <span
                    className={
                      p.status === "done"
                        ? "text-sage"
                        : p.status === "failed"
                        ? "text-terracotta"
                        : p.status === "running"
                        ? "text-marigold"
                        : "text-muted"
                    }
                  >
                    {p.status}
                  </span>
                  {p.marks?.length ? (
                    <span className="mono text-[10px] text-marigold" title="pinned people">
                      {p.marks.length}📍
                    </span>
                  ) : null}
                  <span className="ml-auto flex overflow-hidden rounded border border-edge">
                    {(["medium", "high"] as const).map((q) => {
                      const on = (p.quality || settings.quality) === q;
                      return (
                        <button
                          key={q}
                          onClick={() =>
                            setPages((x) =>
                              x.map((y, j) =>
                                j === i ? { ...y, quality: y.quality === q ? undefined : q } : y
                              )
                            )
                          }
                          disabled={!!busy}
                          title={
                            p.quality === q
                              ? `set for this page — click to fall back to ${settings.quality}`
                              : `render this page at ${q}`
                          }
                          className={`px-1.5 py-0.5 text-[10px] leading-none transition disabled:opacity-40 ${
                            on
                              ? p.quality
                                ? "bg-marigold/20 text-marigold"
                                : "bg-edge/40 text-fg"
                              : "text-muted hover:text-marigold"
                          }`}
                        >
                          {q[0].toUpperCase()}
                        </button>
                      );
                    })}
                  </span>
                  <button
                    onClick={() => {
                      setPages((x) => x.map((y, j) => (j === i ? { ...y, out: undefined } : y)));
                      recast([i]);
                    }}
                    disabled={!!busy}
                    className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted transition hover:border-marigold hover:text-marigold disabled:opacity-40"
                  >
                    redo
                  </button>
                </div>
                {replaceCast.length > 0 && (
                  <div className="flex flex-wrap gap-1 border-t border-edge px-2.5 py-2">
                    {replaceCast.map((c) => {
                      const on = (p.cast ?? seedPageCast(replaceCast, i)).includes(c.id);
                      return (
                        <button
                          key={c.id}
                          title={`${on ? "Remove" : "Add"} ${c.label} on page ${i + 1}`}
                          onClick={() =>
                            setPages((x) =>
                              x.map((y, j) => {
                                if (j !== i) return y;
                                const now = y.cast ?? seedPageCast(replaceCast, j);
                                return {
                                  ...y,
                                  cast: on ? now.filter((id) => id !== c.id) : [...now, c.id],
                                };
                              })
                            )
                          }
                          className={`rounded-full border px-1.5 py-0.5 text-[9px] leading-none transition ${
                            on
                              ? "border-marigold bg-marigold/15 text-marigold"
                              : "border-edge text-muted hover:border-muted"
                          }`}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                    {p.cast?.length === 0 && (
                      <span className="text-[9px] leading-none text-muted">
                        nobody badged — original page kept as-is
                      </span>
                    )}
                  </div>
                )}
                {p.error && <p className="px-2.5 pb-2 text-[10px] text-terracotta">{p.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Section>

      {viewing !== null && pages[viewing] && (
        <PageViewer
          index={viewing}
          page={pages[viewing]}
          cast={replaceCast}
          pinning={pinning}
          setPinning={setPinning}
          prompt={promptFor(viewing)}
          edited={pages[viewing].prompt !== undefined}
          onPrompt={(v) =>
            setPages((x) => x.map((y, j) => (j === viewing ? { ...y, prompt: v } : y)))
          }
          onAdd={() => {
            const label = window.prompt("Name this character (e.g. Father)")?.trim();
            if (!label) return;
            const id = `char${cast.length + 1}`;
            setCast((c) => [...c, { id, label, brief: "", role: "family", replace: true }]);
            setPinning(id);
          }}
          onClose={() => setViewing(null)}
          onStep={(d) => {
            const next = Math.min(pages.length - 1, Math.max(0, viewing + d));
            setViewing(next);
            setPinning(castOnPage(replaceCast, pages[next], next)[0]?.id || "");
          }}
          onPin={(mark) =>
            setPages((x) =>
              x.map((y, j) => {
                if (j !== viewing) return y;
                // A pinned person is by definition on this page, so badge them.
                const badged = y.cast ?? seedPageCast(replaceCast, j);
                return {
                  ...y,
                  marks: [...(y.marks || []), mark],
                  cast: badged.includes(mark.id) ? badged : [...badged, mark.id],
                };
              })
            )
          }
          onUnpin={(at) =>
            setPages((x) =>
              x.map((y, j) =>
                j === viewing ? { ...y, marks: (y.marks || []).filter((_, k) => k !== at) } : y
              )
            )
          }
          onRecast={(quality) => {
            setPages((x) =>
              x.map((y, j) =>
                j === viewing
                  ? { ...y, out: undefined, quality: quality ?? y.quality }
                  : y
              )
            );
            recast([viewing]);
          }}
          busy={!!busy}
        />
      )}

      {log.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl">
          <div className="border-b border-edge px-3 py-2 text-[11px] uppercase tracking-wider text-muted">
            Activity
          </div>
          <div className="mono max-h-52 overflow-y-auto p-2 text-[10px] leading-relaxed">
            {log.slice(-60).map((l, i) => (
              <div key={i} className="py-0.5">{l}</div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------- bits */

function Section({
  n,
  title,
  note,
  children,
}: {
  n: number;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="mb-4 border-b border-edge pb-2">
        <h2 className="text-base font-medium">
          <span className="mr-2 text-marigold">{n}</span>
          {title}
        </h2>
        {note && <p className="mt-0.5 max-w-3xl text-xs text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3.5 py-2 text-xs font-medium transition disabled:opacity-40 ${
        primary
          ? "bg-marigold text-ink hover:brightness-110"
          : "border border-edge bg-panel hover:border-marigold/50"
      }`}
    >
      {children}
    </button>
  );
}

function CastCard({
  member,
  busy,
  onPhoto,
  onDropPhoto,
  onRecrop,
  onLock,
  onUnlock,
  onBrief,
  onRedraw,
  onToggle,
  onRemove,
}: {
  member: CastMember;
  busy: boolean;
  onPhoto: (files: File[]) => void;
  onDropPhoto: (at: number) => void;
  onRecrop: () => void;
  onLock: () => void;
  onUnlock: () => void;
  onBrief: (v: string) => void;
  onRedraw: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const keep = member.replace === false;
  return (
    <div className={`rounded-xl border bg-panel p-3 ${keep ? "border-edge opacity-60" : "border-edge"}`}>
      <div className="mb-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={!keep}
          onChange={onToggle}
          title="replace this character"
          className="accent-[#e8973a]"
        />
        <span className="text-xs font-medium">{member.label}</span>
        {member.role && member.role !== "family" && (
          <span className="mono text-[9px] text-muted">{member.role}</span>
        )}
        {member.onPages?.length ? (
          <span
            className="mono text-[9px] text-muted"
            title={`pages ${member.onPages.map((n) => n + 1).join(", ")}`}
          >
            {member.onPages.length}p
          </span>
        ) : null}
        {member.photo ? (
          <span className="mono text-[9px] text-marigold">from photo</span>
        ) : (
          <span className="mono text-[9px] text-sage">invented</span>
        )}
        <button
          onClick={onRedraw}
          disabled={busy || keep}
          className="ml-auto rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted transition hover:border-marigold hover:text-marigold disabled:opacity-40"
        >
          {member.plate ? "redraw" : "draw"}
        </button>
        <button
          onClick={onRemove}
          disabled={busy}
          className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted transition hover:border-terracotta hover:text-terracotta disabled:opacity-40"
        >
          remove
        </button>
      </div>

      <div className="mb-2 flex gap-2">
        <button
          onClick={() => ref.current?.click()}
          className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-dashed border-edge text-[9px] text-muted transition hover:border-marigold hover:text-marigold"
        >
          {member.photo ? (
            <img src={member.photo} alt="" className="h-full w-full object-cover" />
          ) : (
            "+ photo"
          )}
        </button>
        {member.faceCrop && (
          <button
            onClick={onRecrop}
            title="the head crop sent as the primary identity reference — click to redo"
            className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-marigold"
          >
            <img src={member.faceCrop} alt="" className="h-full w-full object-cover" />
          </button>
        )}
        {(member.photos || []).map((src, k) => (
          <button
            key={k}
            onClick={() => onDropPhoto(k)}
            title="remove this photo"
            className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-edge transition hover:border-terracotta"
          >
            <img src={src} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
        <input
          ref={ref}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => e.target.files?.length && onPhoto(Array.from(e.target.files))}
        />
        <div className="min-h-16 flex-1 overflow-hidden rounded-lg border border-edge bg-ink">
          {member.identity || member.plate ? (
            <img
              src={member.identity || member.plate}
              alt=""
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-16 items-center justify-center px-2 text-center text-[10px] text-muted">
              {member.photo ? "no identity sheet yet — build it" : "no sheet yet"}
            </div>
          )}
        </div>
      </div>

      {member.identity && (
        <div
          className={`mb-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed ${
            member.identityLocked ? "border-sage text-sage" : "border-marigold text-marigold"
          }`}
        >
          {member.identityLocked ? (
            <span>
              Identity locked — the same sheet goes on every page.{" "}
              <button onClick={onUnlock} className="underline hover:no-underline">
                unlock
              </button>
            </span>
          ) : (
            <span>
              Does this look like them? Compare it with the photo before you spend a run — this
              sheet becomes the face on every page.{" "}
              <button onClick={onLock} className="underline hover:no-underline">
                accept
              </button>{" "}
              ·{" "}
              <button onClick={onRedraw} className="underline hover:no-underline">
                redo
              </button>
            </span>
          )}
        </div>
      )}

      {member.photo ? (
        <p className="rounded border border-edge bg-ink px-2 py-1 text-[10px] leading-relaxed text-muted">
          The {(member.photos?.length || 0) + 1 > 1 ? "photos go" : "photo goes"} straight onto every
          page — no sheet is drawn, because drawing one only adds a round of interpretation for the
          face to drift in.{" "}
          {(member.photos?.length || 0) === 0 &&
            "Add two or three more — a close-up, a profile, a different day — and the likeness holds far better."}
          {member.wardrobe ? ` Wardrobe kept: ${member.wardrobe}` : ""}
        </p>
      ) : (
        <textarea
          value={member.brief}
          onChange={(e) => onBrief(e.target.value)}
          rows={4}
          placeholder="what this invented character looks like"
          className="w-full resize-y rounded border border-edge bg-ink px-2 py-1 text-[10px] leading-relaxed outline-none focus:border-marigold"
        />
      )}
    </div>
  );
}

/**
 * Which cast members belong on a given page.
 *
 * Detection can miss a sighting, and a missing sheet means that character keeps
 * the old family's face - a worse failure than one spare reference. So the
 * protagonist always comes along, anyone detection said nothing about comes
 * along, and a page that resolves to nobody falls back to the whole cast.
 */
function castOnPage(cast: CastMember[], page: PageState, index: number): CastMember[] {
  if (page.cast) return cast.filter((c) => page.cast!.includes(c.id));
  return cast.filter(
    (c) => c.role === "protagonist" || !c.onPages?.length || c.onPages.includes(index)
  );
}

/**
 * What detection thinks is on a page, as a starting set of badges.
 *
 * The protagonist always comes along and so does anyone detection said nothing
 * about: a missing sheet leaves the old family's face on the page, which is a
 * worse failure than one spare reference. Correct it with the badges.
 */
function seedPageCast(cast: CastMember[], index: number): string[] {
  return cast
    .filter(
      (c) =>
        c.replace !== false &&
        (c.role === "protagonist" || !c.onPages?.length || c.onPages.includes(index))
    )
    .map((c) => c.id);
}

/**
 * A page, full screen, with pins on it.
 *
 * Words cannot reliably point at one person in a crowded frame - "the child in
 * the cream kurta" stops working the moment two children are dressed alike, and
 * that is exactly how the protagonist got cloned onto a cousin. Pinning is
 * unambiguous, and the pins are handed to the model as a marked-up guide copy
 * alongside the clean page.
 */
function PageViewer({
  index,
  page,
  cast,
  pinning,
  setPinning,
  prompt,
  edited,
  onPrompt,
  onAdd,
  onClose,
  onStep,
  onPin,
  onUnpin,
  onRecast,
  busy,
}: {
  index: number;
  page: PageState;
  cast: CastMember[];
  pinning: string;
  setPinning: (id: string) => void;
  prompt: string;
  edited: boolean;
  onPrompt: (v: string | undefined) => void;
  onAdd: () => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  onPin: (mark: Mark) => void;
  onUnpin: (at: number) => void;
  onRecast: (quality?: "medium" | "high") => void;
  busy: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onStep(1);
      if (e.key === "ArrowLeft") onStep(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  const labelOf = (id: string) => cast.find((c) => c.id === id)?.label || id;
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5 text-xs">
        <span className="mono text-muted">page {index + 1}</span>
        <button
          onClick={() => onStep(-1)}
          className="rounded border border-edge px-2 py-1 text-muted transition hover:border-marigold hover:text-marigold"
        >
          ←
        </button>
        <button
          onClick={() => onStep(1)}
          className="rounded border border-edge px-2 py-1 text-muted transition hover:border-marigold hover:text-marigold"
        >
          →
        </button>

        <span className="ml-3 text-muted">Pin as:</span>
        {!cast.length && <span className="text-muted">no characters yet —</span>}
        {cast.map((c) => (
          <button
            key={c.id}
            onClick={() => setPinning(c.id)}
            className={`rounded-full border px-2 py-1 text-[11px] leading-none transition ${
              pinning === c.id
                ? "border-marigold bg-marigold/15 text-marigold"
                : "border-edge text-muted hover:border-muted"
            }`}
          >
            {c.label}
          </button>
        ))}
        <button
          onClick={onAdd}
          className="rounded-full border border-dashed border-edge px-2 py-1 text-[11px] leading-none text-muted transition hover:border-marigold hover:text-marigold"
        >
          + add
        </button>

        <button
          onClick={() => setShowPrompt((v) => !v)}
          className={`ml-auto rounded border px-2.5 py-1 transition ${
            showPrompt || edited
              ? "border-marigold text-marigold"
              : "border-edge text-muted hover:border-marigold hover:text-marigold"
          }`}
        >
          prompt{edited ? " (edited)" : ""}
        </button>
        <button
          onClick={() => onRecast(undefined)}
          disabled={busy}
          className="rounded border border-edge px-2.5 py-1 text-muted transition hover:border-marigold hover:text-marigold disabled:opacity-40"
        >
          recast this page
        </button>
        <button
          onClick={() => onRecast("high")}
          disabled={busy}
          title="re-render this page at high quality — identity lives in small facial detail"
          className="rounded border border-marigold px-2.5 py-1 text-marigold transition hover:bg-marigold/15 disabled:opacity-40"
        >
          finalise (high)
        </button>
        <button
          onClick={onClose}
          className="rounded border border-edge px-2.5 py-1 text-muted transition hover:border-terracotta hover:text-terracotta"
        >
          close
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center gap-4 overflow-auto p-4">
        <div className="relative">
          <img
            src={page.src}
            alt={`page ${index + 1}`}
            onClick={(e) => {
              if (!pinning) return;
              const r = e.currentTarget.getBoundingClientRect();
              onPin({
                id: pinning,
                x: (e.clientX - r.left) / r.width,
                y: (e.clientY - r.top) / r.height,
              });
            }}
            className={`max-h-[80vh] rounded-lg ${pinning ? "cursor-crosshair" : ""}`}
          />
          {(page.marks || []).map((m, k) => (
            <button
              key={k}
              onClick={() => onUnpin(k)}
              title={`${labelOf(m.id)} — click to remove`}
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-terracotta text-[11px] font-bold text-white shadow-lg">
                {k + 1}
              </span>
              <span className="mono mt-0.5 block whitespace-nowrap rounded bg-ink/80 px-1 text-[9px] text-white">
                {labelOf(m.id)}
              </span>
            </button>
          ))}
        </div>

        {page.out && (
          <img src={page.out} alt={`recast ${index + 1}`} className="max-h-[80vh] rounded-lg" />
        )}
      </div>

      {showPrompt && (
        <div className="border-b border-edge px-4 py-2">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
            <span>Sent with this page, exactly as written{edited ? " (edited)" : ""}.</span>
            <button
              onClick={() => navigator.clipboard?.writeText(prompt)}
              className="rounded border border-edge px-1.5 py-0.5 transition hover:border-marigold hover:text-marigold"
            >
              copy
            </button>
            {edited && (
              <button
                onClick={() => onPrompt(undefined)}
                className="rounded border border-edge px-1.5 py-0.5 transition hover:border-terracotta hover:text-terracotta"
              >
                reset to built
              </button>
            )}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => onPrompt(e.target.value)}
            spellCheck={false}
            className="mono h-44 w-full resize-y rounded-lg border border-edge bg-panel p-2 text-[11px] leading-relaxed outline-none focus:border-marigold"
          />
        </div>
      )}
      {cast.some((c) => c.notes?.[index]) && (
        <div className="border-t border-edge px-4 py-2 text-[11px]">
          <span className="text-muted">Read from this page: </span>
          {cast
            .filter((c) => c.notes?.[index])
            .map((c) => (
              <span key={c.id} className="mr-3">
                <b className="text-marigold">{c.label}</b>{" "}
                <span className="text-muted">
                  {[
                    c.notes![index].clothing,
                    c.notes![index].pose,
                    c.notes![index].expression,
                    c.notes![index].gaze,
                    c.notes![index].position,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            ))}
        </div>
      )}
      <p className="border-t border-edge px-4 py-2 text-[11px] text-muted">
        {pinning
          ? `Click each ${labelOf(pinning)} in the picture to pin them. Click a pin to remove it.`
          : "Pick a character above, then click them in the picture."}{" "}
        Pins tell the model which person is which — they are never drawn into the finished page.
        Arrow keys move between pages, Esc closes.
      </p>
    </div>
  );
}
