// A document as one file to send a co-author: `.theoremis`, a ZIP of the document and its
// media. It leaves out what is the sender's own: collaborator threads, suggestions awaiting a
// decision, and the history. Opening one adds it to the workspace as a new document.

import { api, assetUrl } from "./api";
import { unzip } from "./docx";
import { withSummary } from "./doc";
import { exportName } from "./latexExport";
import { newId } from "./text";
import type { Doc } from "./types";
import { zip } from "./zip";

const FORMAT = "theoremis-document";

/** The document as it is shared: its text, statuses, notation and origin, nothing personal. */
export function sharedCopy(doc: Doc): Doc {
  const { activeThreadId: _active, ...rest } = doc;
  return {
    ...rest,
    threads: [],
    blocks: doc.blocks.filter((b) => !b.suggestion).map(({ byAgent: _agent, ...b }) => b),
  };
}

/** Saves `doc` as a .theoremis file where the person chooses; resolves to where, or null. */
export async function shareDocument(doc: Doc): Promise<string | null> {
  const encoder = new TextEncoder();
  const files = [
    { name: "manifest.json", data: encoder.encode(JSON.stringify({ format: FORMAT, version: 1, sharedAt: new Date().toISOString() }, null, 2)) },
    { name: "document.json", data: encoder.encode(JSON.stringify(sharedCopy(doc))) },
  ];
  for (const name of await api.listAssets(doc.id)) {
    const response = await fetch(assetUrl(doc.id, name));
    if (response.ok) files.push({ name: `assets/${name}`, data: new Uint8Array(await response.arrayBuffer()) });
  }
  return api.saveFile(`${exportName(doc.title)}.theoremis`, "Theoremis document", await zip(files));
}

/** Reads a .theoremis file into a new document in `projectId`, its media saved beside it. */
export async function readShared(bytes: Uint8Array, projectId: string): Promise<Doc> {
  const files = await unzip(bytes, () => true);
  const decoder = new TextDecoder();
  const manifest = files.get("manifest.json");
  const body = files.get("document.json");
  if (!manifest || !body || JSON.parse(decoder.decode(manifest)).format !== FORMAT) {
    throw new Error("That isn’t a document shared from Theoremis.");
  }
  const shared = JSON.parse(decoder.decode(body)) as Doc;
  if (!Array.isArray(shared.blocks)) throw new Error("The shared document couldn’t be read.");
  const id = newId();
  for (const [path, data] of files) {
    const name = /^assets\/([\w.-]+)$/.exec(path)?.[1];
    if (name) await api.saveAsset(id, name, data);
  }
  const now = Date.now();
  return withSummary({ ...sharedCopy(shared), id, projectId, revision: 1, createdAt: now, updatedAt: now });
}
