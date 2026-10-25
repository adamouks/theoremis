// A document's references, kept as BibTeX: read for showing and citing in Theoremis, written
// as they are beside the LaTeX export. Citations are numbered as amsplain numbers them, by
// author, so the numbers in Theoremis match the exported paper's.

export interface BibEntry {
  key: string;
  type: string;
  /** Field names in lower case; values as written, without their outer braces or quotes. */
  fields: Record<string, string>;
}

export interface Bibliography {
  entries: BibEntry[];
  problems: string[];
}

/** Reads at `at` a value in braces or quotes, with braces inside kept. */
function delimited(text: string, at: number): { value: string; end: number } | null {
  const open = text[at];
  const close = open === "{" ? "}" : open === '"' ? '"' : "";
  if (!close) return null;
  let depth = 0;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
    } else if (c === close && depth === 0) {
      return { value: text.slice(at + 1, i), end: i + 1 };
    }
  }
  return null;
}

const MONTHS: Record<string, string> = { jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June", jul: "July", aug: "August", sep: "September", oct: "October", nov: "November", dec: "December" };

export function parseBibtex(text: string): Bibliography {
  const entries: BibEntry[] = [];
  const problems: string[] = [];
  const strings: Record<string, string> = { ...MONTHS };
  let at = 0;
  while ((at = text.indexOf("@", at)) >= 0) {
    const head = /^@\s*([A-Za-z]+)\s*([{(])/.exec(text.slice(at));
    if (!head) {
      at++;
      continue;
    }
    const type = head[1].toLowerCase();
    const closer = head[2] === "{" ? "}" : ")";
    let i = at + head[0].length;
    if (type === "comment" || type === "preamble") {
      const skipped = delimited(text, i - 1);
      at = skipped ? skipped.end : i;
      continue;
    }
    // @string{name = value}, or an entry's key and its fields.
    let key = "";
    if (type !== "string") {
      const comma = text.indexOf(",", i);
      const end = text.indexOf(closer, i);
      if (comma < 0 || (end >= 0 && end < comma)) {
        problems.push(`An @${type} entry without fields near “${text.slice(at, at + 40).replace(/\s+/g, " ")}”.`);
        at = i;
        continue;
      }
      key = text.slice(i, comma).trim();
      i = comma + 1;
    }
    const fields: Record<string, string> = {};
    for (;;) {
      i = skip(text, i);
      if (i >= text.length || text[i] === closer) {
        i++;
        break;
      }
      const name = /^([A-Za-z][\w:.-]*)\s*=\s*/.exec(text.slice(i));
      if (!name) {
        problems.push(`Couldn’t read the fields of “${key || type}”.`);
        const end = text.indexOf("\n@", i);
        i = end < 0 ? text.length : end;
        break;
      }
      i += name[0].length;
      // A value is pieces joined with #: "text", {text}, a number or a @string name.
      let value = "";
      for (;;) {
        i = skip(text, i);
        const piece = delimited(text, i);
        if (piece) {
          value += piece.value;
          i = piece.end;
        } else {
          const word = /^[\w:.-]+/.exec(text.slice(i));
          if (!word) break;
          value += strings[word[0].toLowerCase()] ?? word[0];
          i += word[0].length;
        }
        i = skip(text, i);
        if (text[i] === "#") i++;
        else break;
      }
      fields[name[1].toLowerCase()] = value.replace(/\s+/g, " ").trim();
      i = skip(text, i);
      if (text[i] === ",") i++;
    }
    if (type === "string") Object.assign(strings, Object.fromEntries(Object.entries(fields)));
    else if (key) {
      if (entries.some((e) => e.key === key)) problems.push(`Two references have the key “${key}”; the first is used.`);
      else entries.push({ key, type, fields });
    }
    at = i;
  }
  return { entries, problems };
}

function skip(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

const ACCENTS: Record<string, string> = { '"': "̈", "'": "́", "`": "̀", "^": "̂", "~": "̃", "=": "̄", ".": "̇", c: "̧", v: "̌", H: "̋", u: "̆", r: "̊", k: "̨" };
const LETTERS: Record<string, string> = { ss: "ß", o: "ø", O: "Ø", aa: "å", AA: "Å", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", l: "ł", L: "Ł", i: "ı", j: "ȷ" };

/** BibTeX's LaTeX as plain text: accents to letters, braces dropped. Math in $…$ is kept. */
export function plainText(value: string): string {
  return value
    .split(/(\$[^$]*\$)/)
    .map((part, n) =>
      n % 2
        ? part
        : part
            .replace(/\\([`'^"~=.]|[cvHurk](?![A-Za-z]))\s*\{?\s*(\\?[A-Za-z])\s*\}?/g, (_, accent: string, letter: string) => (letter.replace("\\", "") + ACCENTS[accent]).normalize("NFC"))
            .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i|j)(?![A-Za-z])/g, (_, name: string) => LETTERS[name])
            .replace(/\\&/g, "&")
            .replace(/\\(?:emph|textit|textbf|textsc|mathrm|url)\s*/g, "")
            .replace(/[{}]/g, "")
            .replace(/---/g, "—")
            .replace(/--/g, "–")
            .replace(/~/g, " "),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

interface Name {
  first: string;
  last: string;
}

/** "Gauss, Carl Friedrich", "Carl Friedrich Gauss", "de la Vallée Poussin, C.". */
function names(field: string | undefined): Name[] {
  if (!field) return [];
  return splitTopLevel(field, /\s+and\s+/i).map((raw) => {
    const name = raw.trim();
    if (/^\{.*\}$/.test(name)) return { first: "", last: plainText(name) };
    const parts = splitTopLevel(name, /\s*,\s*/);
    if (parts.length >= 2) return { last: plainText(parts[0]), first: plainText(parts.slice(1).reverse().join(" ")) };
    const words = plainText(name).split(/\s+/);
    // "von" parts stay with the last name: "Charles de la Vallée Poussin".
    let at = words.length - 1;
    while (at > 1 && /^[a-z]/.test(words[at - 1])) at--;
    return { first: words.slice(0, at).join(" "), last: words.slice(at).join(" ") };
  });
}

/** Splits at `separator`, but not inside braces. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (depth === 0) {
      const match = new RegExp(`^(?:${separator.source})`, separator.flags).exec(text.slice(i));
      if (match && match[0]) {
        out.push(text.slice(start, i));
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  out.push(text.slice(start));
  return out.filter((part) => part.trim());
}

/** "Carl Friedrich Gauss", "André Weil and Jean-Pierre Serre", "A, B, and C", as amsplain names them. */
function authorList(entry: BibEntry): string {
  const people = names(entry.fields.author ?? entry.fields.editor).map((n) => `${n.first ? `${n.first} ` : ""}${n.last}`);
  if (people.length <= 2) return people.join(" and ");
  return `${people.slice(0, -1).join(", ")}, and ${people[people.length - 1]}`;
}

/**
 * A title as BibTeX's styles set it: lower case after the first letter, except what's in braces
 * ("{F}ermat") and math. That's why careful .bib files brace proper names.
 */
export function sentenceCase(title: string): string {
  let out = "";
  let depth = 0;
  let math = false;
  let first = true;
  for (let i = 0; i < title.length; i++) {
    const c = title[i];
    if (c === "\\" && depth === 0 && !math) {
      // A command keeps its name: \emph, \'e.
      const command = /^\\(?:[A-Za-z]+|.)/.exec(title.slice(i))![0];
      out += command;
      i += command.length - 1;
      continue;
    }
    if (c === "$") math = !math;
    if (c === "{") depth++;
    if (c === "}") depth--;
    const free = depth === 0 && !math;
    out += free && !first ? c.toLowerCase() : c;
    // ": " starts a new sentence, as in "Primes: a survey".
    if (/[A-Za-z]/.test(c) || depth > 0) first = false;
    if (free && c === ":") first = true;
  }
  return out;
}

/** An entry as amsplain would set it, in Markdown: “Carl Friedrich Gauss, *Disquisitiones arithmeticae*, 1801.” */
export function formatEntry(entry: BibEntry): string {
  const f = entry.fields;
  const parts: string[] = [];
  const who = authorList(entry);
  if (who) parts.push(who + (!f.author && f.editor ? " (ed.)" : ""));
  if (f.title) parts.push(`*${plainText(sentenceCase(f.title))}*`);
  const year = f.year ? plainText(f.year) : "";
  switch (entry.type) {
    case "article": {
      const journal = [f.journal && plainText(f.journal), f.volume && `**${plainText(f.volume)}**`, year && `(${year})`].filter(Boolean).join(" ");
      if (journal) parts.push(journal);
      if (f.number) parts.push(`no. ${plainText(f.number)}`);
      if (f.pages) parts.push(plainText(f.pages));
      break;
    }
    case "book":
    case "booklet":
      parts.push(...[f.publisher, f.address].filter(Boolean).map((v) => plainText(v!)), ...(year ? [year] : []));
      break;
    case "inproceedings":
    case "incollection":
    case "inbook":
      if (f.booktitle) parts.push(plainText(f.booktitle));
      parts.push(...[f.publisher, f.address].filter(Boolean).map((v) => plainText(v!)), ...(year ? [year] : []));
      if (f.pages) parts.push(`pp. ${plainText(f.pages)}`);
      break;
    default: {
      // amsplain shows howpublished, not eprint: references looked up on arXiv carry both.
      if (f.howpublished) parts.push(plainText(f.howpublished));
      if (f.school || f.institution) parts.push(plainText(f.school ?? f.institution!));
      if (year) parts.push(year);
    }
  }
  if (f.note) parts.push(plainText(f.note));
  return `${parts.join(", ")}.`.replace(/\.\.$/, ".");
}

/** How amsplain orders references: by authors' last names, then first names, year and title. */
function sortKey(entry: BibEntry): string {
  const people = names(entry.fields.author ?? entry.fields.editor);
  const who = people.map((n) => `${n.last} ${n.first}`).join("  ") || entry.key;
  return `${who}   ${entry.fields.year ?? ""}   ${plainText(entry.fields.title ?? "")}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** The numbers of the cited references, 1, 2, … in amsplain's order; uncited ones get none. */
export function citationNumbers(entries: BibEntry[], cited: Set<string>): Map<string, number> {
  const used = entries.filter((e) => cited.has(e.key)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return new Map(used.map((e, i) => [e.key, i + 1]));
}

/**
 * Braces a looked-up entry's title, so styles keep its capitals: Crossref and arXiv give
 * titles as written ("Fermat's Last Theorem"), which sentence case would spoil ("fermat's").
 */
export function protectTitle(bibtex: string): string {
  const field = /\btitle\s*=\s*/i.exec(bibtex);
  if (!field) return bibtex;
  const at = field.index + field[0].length;
  const value = delimited(bibtex, at);
  if (!value || /^\{[\s\S]*\}$/.test(value.value.trim())) return bibtex;
  return `${bibtex.slice(0, at)}{{${value.value}}}${bibtex.slice(value.end)}`;
}

/** A key for a new reference: the first author's last name and the year, e.g. "gauss1801". */
export function suggestKey(entry: BibEntry, taken: Set<string>): string {
  const last = names(entry.fields.author ?? entry.fields.editor)[0]?.last ?? "ref";
  const base =
    last
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "") + (entry.fields.year ?? "");
  let key = base || "ref";
  for (let n = 2; taken.has(key); n++) key = `${base}${String.fromCharCode(95 + n)}`;
  return key;
}

/** The key of the entry for an arXiv id or a DOI, if `bibliography` has one. */
export function findReference(bibliography: string | undefined, id: string): string | undefined {
  // "arXiv:2301.01234v2", "https://doi.org/10.1/X" and "10.1/x" name what they name.
  const bare = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/^(?:arxiv:|https?:\/\/(?:dx\.)?doi\.org\/|doi:)/, "")
      .replace(/(\d)v\d+$/, "$1");
  const want = bare(id);
  return parseBibtex(bibliography ?? "").entries.find((e) => [e.fields.doi, e.fields.eprint].some((value) => value && bare(value) === want))?.key;
}

/**
 * Adds a looked-up entry to `bibliography` under a fresh key (its first author and year), with
 * its title braced so it keeps its capitals. Null if the entry can't be read.
 */
export function withReference(bibliography: string | undefined, bibtex: string): { bibliography: string; key: string; entry: BibEntry } | null {
  const entry = parseBibtex(bibtex).entries[0];
  if (!entry) return null;
  const key = suggestKey(entry, new Set(parseBibtex(bibliography ?? "").entries.map((e) => e.key)));
  const keyed = protectTitle(bibtex.replace(/^(\s*@\s*\w+\s*\{)\s*[^,]*,/, `$1${key},`)).trim();
  const next = bibliography?.trim() ? `${bibliography.trimEnd()}\n\n${keyed}\n` : `${keyed}\n`;
  return { bibliography: next, key, entry: parseBibtex(keyed).entries[0] ?? entry };
}
