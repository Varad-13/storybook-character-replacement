// Turning an uploaded book into page images, and finished pages back into a PDF.
// Both run in the browser so nothing large ever crosses the network.

export async function pagesFromPdf(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  // Pinned to the installed version so the worker can never drift from the API.
  pdfjs.GlobalWorkerOptions.workerSrc =
    "https://unpkg.com/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs";

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const out: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // 1254px matches the source artwork these books ship at.
    const base = page.getViewport({ scale: 1 });
    const scale = 1254 / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    out.push(canvas.toDataURL("image/png"));
    onProgress?.(i, doc.numPages);
  }
  return out;
}

export async function pagesFromImages(files: File[]): Promise<string[]> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return Promise.all(
    sorted.map(
      (f) =>
        new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`could not read ${f.name}`));
          r.readAsDataURL(f);
        })
    )
  );
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export async function buildPdf(pages: string[], title: string, inches = 8): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const size = await imageSize(pages[0]);
  const landscape = size.w > size.h;
  const h = inches * (landscape ? size.h / size.w : 1);
  const w = inches * (landscape ? 1 : size.w / size.h);

  const doc = new jsPDF({ unit: "in", format: [w, h], orientation: landscape ? "l" : "p" });
  doc.setProperties({ title });

  pages.forEach((p, i) => {
    if (i > 0) doc.addPage([w, h], landscape ? "l" : "p");
    doc.addImage(p, "PNG", 0, 0, w, h, undefined, "FAST");
  });
  return doc.output("blob");
}

function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("could not measure page"));
    img.src = dataUrl;
  });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
