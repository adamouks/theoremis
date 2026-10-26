// Prints the long test document (src/lib/fixtures/quartic.ts) to PDF, laid out as the app lays out
// a document for its print dialog (src/e2e/printCheck.tsx), and checks that the copy is complete
// and readable:
//
// - every block prints, once, in order, through the prose after the Lean file;
// - the Lean file, over a page long, continues across pages, every line of it;
// - no displayed equation runs outside the column, and no equation number overlaps its equation;
// - nothing scrolls or clips, so nothing is hidden;
// - both graphs print as pictures drawn for paper;
// - pages are filled: no page but the last ends with much of it empty, unless the next page
//   starts with a figure too tall for the space left (figures are kept whole).
//
// Chromium prints the PDFs (A4 and US Letter). With --webkit, WebKitGTK prints them too, the
// engine Tauri uses on Linux and the nearest to macOS's (needs python3-gi, gir1.2-webkit2-4.1 and
// xvfb-run; PYTHON names the interpreter with those bindings). The PDFs are written to e2e/out
// for a look.
//
//   npm run test:print            # Chromium
//   npm run test:print -- --webkit

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const webkit = process.argv.includes("--webkit");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const server = await createServer({ root: join(here, ".."), server: { port: 14290, strictPort: false }, logLevel: "warn" });
await server.listen();
const url = `${server.resolvedUrls.local[0]}e2e/print.html`;

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let expected;
try {
  await page.goto(url);
  await page.waitForSelector("html[data-print-ready]", { timeout: 60_000 });
  expected = await page.evaluate(() => window.__printCheck);
  await page.emulateMedia({ media: "print" });

  // The laid-out copy, as it prints.
  const layout = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const blocks = [...document.querySelectorAll(".print-root [data-block]")].map((el) => el.dataset.block);
    const equations = [...document.querySelectorAll(".print-root .katex-display")].map((display, index) => {
      const html = display.querySelector(":scope > .katex > .katex-html");
      const bases = [...(html?.children ?? [])].filter((c) => c.classList.contains("katex-base") || c.classList.contains("base")).map(rect);
      const box = rect(display);
      const left = Math.min(...bases.map((r) => r.left));
      const right = Math.max(...bases.map((r) => r.right));
      const tag = html?.querySelector(":scope > .katex-tag, :scope > .tag");
      const t = tag ? rect(tag) : null;
      const below = display.classList.contains("is-tag-below");
      // On a line of its own, the number may not sit over the equation's last line; beside it, not over any of it.
      const lastTop = Math.max(...bases.map((r) => r.top));
      const overlap = t && !(below ? t.top >= lastTop + 1 || t.left >= right + 1 : t.left >= right + 2 || t.top >= Math.max(...bases.map((r) => r.bottom)) - 1);
      return { index, inside: left >= box.left - 0.5 && right <= box.right + 0.5 && (!t || t.right <= box.right + 0.5), overlap: Boolean(overlap), fit: display.style.getPropertyValue("--fit") || "1" };
    });
    const clipped = [...document.querySelectorAll(".print-root *")]
      .filter((el) => !el.closest(".katex-mathml"))
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.overflowX !== "visible" || s.overflowY !== "visible" ? el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 : false;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    const graphs = [...document.querySelectorAll(".print-root .figure--graph img")].map((img) => ({ complete: img.complete, width: img.naturalWidth, shown: Math.round(rect(img).width) }));
    const column = Math.round(rect(document.querySelector(".print-doc")).width);
    return { blocks, equations, clipped, graphs, column, pending: document.querySelectorAll("[data-graph-pending]").length };
  });

  check(JSON.stringify(layout.blocks) === JSON.stringify(expected.blocks), `blocks printed ${layout.blocks.length}, expected ${expected.blocks.length}, in order`);
  for (const e of layout.equations) {
    check(e.inside, `equation ${e.index + 1} runs outside the column (scale ${e.fit})`);
    check(!e.overlap, `equation ${e.index + 1}'s number overlaps it`);
  }
  check(layout.clipped.length === 0, `content clipped by ${layout.clipped.slice(0, 5).join(", ")}`);
  check(layout.pending === 0, `${layout.pending} graphs still waiting for pictures`);
  check(layout.graphs.length === 2, `${layout.graphs.length} graph pictures, expected 2`);
  for (const g of layout.graphs) check(g.complete && g.width >= 1200 && g.shown >= layout.column - 2, `a graph picture is ${g.width}px, shown ${g.shown}px of ${layout.column}px`);
  check(errors.length === 0, `page errors: ${errors.slice(0, 3).join(" | ")}`);

  for (const format of ["A4", "Letter"]) {
    const file = join(out, `quartic-chromium-${format.toLowerCase()}.pdf`);
    await page.pdf({ path: file, format });
    await checkPdf(file, `Chromium ${format}`);
  }
} finally {
  await browser.close();
}

if (webkit) {
  for (const paper of ["a4", "letter"]) {
    const file = join(out, `quartic-webkit-${paper}.pdf`);
    // Not execFileSync: the page is served from this process, which must keep answering.
    await promisify(execFile)("xvfb-run", ["-a", process.env.PYTHON ?? "python3", join(here, "print-webkit.py"), url, file, paper], { timeout: 180_000 });
    await checkPdf(file, `WebKit ${paper === "a4" ? "A4" : "Letter"}`);
  }
}
await server.close();

/** Reads a PDF's pages: their text, top to bottom, and how many pictures each draws. */
async function readPdf(file) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(file)), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const p = await pdf.getPage(n);
    const { height } = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const items = content.items.filter((i) => i.str.trim());
    const ops = await p.getOperatorList();
    const firstImage = ops.fnArray.indexOf(OPS.paintImageXObject);
    const firstText = ops.fnArray.findIndex((f) => f === OPS.showText || f === OPS.showSpacedText);
    pages.push({
      text: items.map((i) => i.str).join(" ").replace(/\s+/g, " "),
      // How far down the page its content reaches, as a fraction of the page.
      reach: items.length ? 1 - Math.min(...items.map((i) => i.transform[5])) / height : 0,
      images: ops.fnArray.filter((f) => f === OPS.paintImageXObject).length,
      startsWithFigure: firstImage >= 0 && (firstText < 0 || firstImage < firstText),
    });
  }
  return pages;
}

async function checkPdf(file, name) {
  const pages = await readPdf(file);
  const text = pages.map((p) => p.text).join(" ");
  const squash = (s) => s.replace(/\s+/g, "");
  const all = squash(text);

  // Every phrase once, in order.
  let at = -1;
  for (const phrase of expected.phrases) {
    const p = squash(phrase);
    const first = all.indexOf(p);
    check(first >= 0, `${name}: missing "${phrase}"`);
    check(first < 0 || all.indexOf(p, first + 1) < 0, `${name}: "${phrase}" printed twice`);
    check(first < 0 || first > at, `${name}: "${phrase}" out of order`);
    if (first >= 0) at = first;
  }
  // Every line of the Lean file, in order (its start: long lines wrap at the column).
  let from = 0;
  let missing = 0;
  for (const line of expected.lean) {
    const start = squash(line).slice(0, 28);
    const found = all.indexOf(start, from);
    if (found < 0) missing++;
    else from = found + start.length;
  }
  check(missing === 0, `${name}: ${missing} of ${expected.lean.length} Lean lines missing`);
  const pageOf = (phrase) => pages.findIndex((p) => squash(p.text).includes(squash(phrase)));
  check(pageOf("import Mathlib") >= 0 && pageOf("end Quartic") > pageOf("import Mathlib"), `${name}: the Lean file doesn't continue across pages`);
  check(pageOf("This is the last paragraph") === pages.length - 1, `${name}: the last paragraph isn't on the last page`);
  check(pages.reduce((n, p) => n + p.images, 0) >= 2, `${name}: ${pages.reduce((n, p) => n + p.images, 0)} pictures, expected the 2 graphs`);
  // The page area ends about 92% of the way down. A short block kept whole may leave a quarter of
  // a page; a figure kept whole, more.
  for (let i = 0; i < pages.length - 1; i++) {
    const least = pages[i + 1].startsWithFigure ? 0.4 : 0.65;
    check(pages[i].reach >= least, `${name}: page ${i + 1} of ${pages.length} ends ${Math.round((1 - pages[i].reach) * 100)}% empty`);
  }
  console.log(`${name}: ${pages.length} pages; content reaches ${pages.map((p) => `${Math.round(p.reach * 100)}%`).join(", ")}`);
}

if (failures.length) {
  console.error(`\n${failures.length} print check${failures.length === 1 ? "" : "s"} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Print checks passed.");
