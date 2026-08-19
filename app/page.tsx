"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CastMember,
  Mark,
  Pronouns,
  DEFAULT_SETTINGS,
  FALLBACK_CAST,
  detectCast,
  MODEL_HINTS,
  Settings,
  generate,
  image,
  annotate,
  markLines,
  PRONOUN_LABEL,
  photosOf,
  platePrompt,
  pool,
  recastPrompt,
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
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
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
    // Only characters with no photograph. A real face needs no sheet drawn of it.
    const targets = cast.filter((c) =>
      only ? c.id === only : !c.plate && !c.photo && c.replace !== false
    );
    if (!targets.length) {
      return say("nothing to draw — characters with a photo use the photo directly");
    }
    setBusy("Building character sheets");
    try {
      await pool(targets, concurrency, async (m) => {
        say(`${m.label}: drawing sheet`);
        try {
          const parts = [
            ...(photosOf(m).length
              ? [
                  text(
                    photosOf(m).length > 1
                      ? `${photosOf(m).length} photographs of the same real person:`
                      : "Reference photograph of the real person:"
                  ),
                  ...photosOf(m).map((src) => image(src, "high")),
                ]
              : []),
            text(platePrompt(m)),
          ];
          const img = await generate(parts, settings);
          setCast((c) => c.map((x) => (x.id === m.id ? { ...x, plate: img } : x)));
          say(`${m.label}: sheet ready`);
        } catch (e) {
          say(`${m.label}: FAILED — ${(e as Error).message}`);
        }
      });
    } finally {
      setBusy(null);
    }
  }

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

    setBusy(`Recasting ${targets.length} pages`);
    const rename = renameFrom.trim() ? { from: renameFrom.trim(), to: renameTo.trim() } : undefined;
    const labelOf = (id: string) => cast.find((c) => c.id === id)?.label || id;

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
          const parts = [
            ...onPage.flatMap((c) => [
              ...(c.plate && !c.photo
                ? [
                    text(`Locked character sheet — ${c.label.toUpperCase()}:`),
                    image(c.plate),
                  ]
                : []),
              // Last, and uncompressed: the sheet is itself a redrawing and
              // drifts, so the photograph has to be the more recent reference.
              ...(photosOf(c).length
                ? [
                    text(
                      photosOf(c, 3).length > 1
                        ? `${c.label} — photos of the real person, this is their face:`
                        : `${c.label} — photo of the real person, this is their face:`
                    ),
                    ...photosOf(c, 3).map((src) => image(src, "high")),
                  ]
                : []),
            ]),
            ...(marks.length
              ? [
                  text("Guide — the same page with pins:"),
                  image(await annotate(pages[i].src, marks, labelOf), "high"),
                ]
              : []),
            text("The page to redraw:"),
            image(pages[i].src),
            text(
              recastPrompt(onPage, rename, {
                page: i,
                pronouns,
                markGuide: marks.length ? markLines(marks, labelOf) : undefined,
              })
            ),
          ];
          const img = await generate(parts, settings);
          setPages((p) => p.map((x, j) => (j === i ? { ...x, out: img, status: "done" } : x)));
          say(`page ${i + 1} done`);
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
            {pages.length} pages · {activeCast.length}/{cast.length} sheets · {doneCount} recast
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Btn onClick={() => setShowSettings((v) => !v)}>
              {settings.apiKey ? "Settings OK" : "Settings"}
            </Btn>
            <Btn onClick={() => makePlates()} disabled={!!busy}>Build sheets</Btn>
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
                <option value="low">low - fastest and cheapest</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="auto">auto</option>
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
                setCast((c) =>
                  c.map((x) => {
                    if (x.id !== m.id) return x;
                    const all = [...(x.photo ? [x.photo, ...(x.photos || [])] : []), ...added];
                    // The sheet was drawn from the old set, so it is now stale.
                    return { ...x, photo: all[0], photos: all.slice(1), plate: undefined };
                  })
                );
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
              onBrief={(brief) =>
                setCast((c) => c.map((x) => (x.id === m.id ? { ...x, brief } : x)))
              }
              onRedraw={() => {
                setCast((c) => c.map((x) => (x.id === m.id ? { ...x, plate: undefined } : x)));
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
        note="Original on the left of each pair, recast on the right. The badges under each page are the characters that page will be given — detection fills them in, correct any it got wrong before you recast."
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
                  <button
                    onClick={() => {
                      setPages((x) => x.map((y, j) => (j === i ? { ...y, out: undefined } : y)));
                      recast([i]);
                    }}
                    disabled={!!busy}
                    className="ml-auto rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted transition hover:border-marigold hover:text-marigold disabled:opacity-40"
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
          onRecast={() => {
            setPages((x) => x.map((y, j) => (j === viewing ? { ...y, out: undefined } : y)));
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
  onBrief,
  onRedraw,
  onToggle,
  onRemove,
}: {
  member: CastMember;
  busy: boolean;
  onPhoto: (files: File[]) => void;
  onDropPhoto: (at: number) => void;
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
          {member.plate ? (
            <img src={member.plate} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-16 items-center justify-center px-2 text-center text-[10px] text-muted">
              {member.photo ? "photo used directly — no sheet needed" : "no sheet yet"}
            </div>
          )}
        </div>
      </div>

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
  onAdd: () => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  onPin: (mark: Mark) => void;
  onUnpin: (at: number) => void;
  onRecast: () => void;
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
          onClick={onRecast}
          disabled={busy}
          className="ml-auto rounded border border-edge px-2.5 py-1 text-muted transition hover:border-marigold hover:text-marigold disabled:opacity-40"
        >
          recast this page
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

      {cast.some((c) => c.notes?.[index]) && (
        <div className="border-t border-edge px-4 py-2 text-[11px]">
          <span className="text-muted">Read from this page: </span>
          {cast
            .filter((c) => c.notes?.[index])
            .map((c) => (
              <span key={c.id} className="mr-3">
                <b className="text-marigold">{c.label}</b>{" "}
                <span className="text-muted">{c.notes![index]}</span>
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
