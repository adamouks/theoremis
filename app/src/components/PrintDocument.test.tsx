import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { numberBlocks } from "../lib/doc";
import { QUARTIC_LEAN, quarticDocument } from "../lib/fixtures/quartic";
import { printedBlocks } from "../lib/printLayout";
import type { GraphPicture } from "./graph/graphPicture";
import { GraphContext, type PrintPictures } from "./Markdown";
import { PrintArticle } from "./PrintDocument";

const doc = quarticDocument();
const numbered = numberBlocks(doc.blocks);

const picture: GraphPicture = {
  src: "data:image/png;base64,AAAA",
  width: 640,
  height: 377,
  legend: [{ color: "#e03131", label: "P_a", latex: "y = x^4", dashed: false }],
  values: ["a = 0.6"],
};

function render(print: PrintPictures) {
  return renderToStaticMarkup(
    <GraphContext.Provider value={{ editable: false, compact: false, print }}>
      <PrintArticle doc={doc} numbered={numbered} author="Élise Moreau" references={[]} />
    </GraphContext.Provider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

describe("the printed copy", () => {
  const html = render({ get: () => picture, request: () => {} });

  it("holds every block, once each, in the document's order", () => {
    const ids = [...html.matchAll(/data-block="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(printedBlocks(numbered).map((n) => n.block.id));
  });

  it("holds the whole Lean file and the prose after it", () => {
    const lean = /<pre[^>]*><code class="[^"]*language-lean[^"]*">([\s\S]*?)<\/code><\/pre>/.exec(html);
    expect(lean).not.toBeNull();
    const code = text(lean![1]);
    for (const line of QUARTIC_LEAN.split("\n")) expect(code).toContain(line);
    const after = html.slice(html.indexOf("end Quartic"));
    expect(after).toContain("Verification status.");
    expect(after).toContain("4 Discussion");
    expect(after).toContain("This is the last paragraph of the document");
  });

  it("numbers its equations as the document does", () => {
    const tags = [...text(html).matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
    for (const n of numbered.flatMap((b) => b.numbers)) expect(tags).toContain(n);
  });

  it("shows each graph as its paper picture, with a key and the sliders' values", () => {
    expect(html.match(/<img src="data:image\/png;base64,AAAA" width="640" height="377"/g)).toHaveLength(2);
    expect(html.match(/class="graph-legend"/g)).toHaveLength(2);
    expect(html).toContain("P_a");
    // No interactive graph is left in a printed copy.
    expect(html).not.toContain("graph-block");
  });

  it("waits for graphs that aren't pictured yet, and shows the code of one that can't be", () => {
    const waiting = render({ get: () => undefined, request: () => {} });
    expect(waiting.match(/data-graph-pending/g)).toHaveLength(2);
    const failed = render({ get: () => null, request: () => {} });
    expect(failed).toContain("z = x^4 - 2 y x^2 + 1");
    expect(failed).toContain("needs WebGL");
  });
});
