//! Looking up a reference as BibTeX from what a mathematician has at hand: an arXiv id (or its
//! abs/pdf link) or a DOI (or its doi.org link). arXiv's API answers in Atom, which is turned
//! into a @misc entry; doi.org answers in BibTeX itself, through content negotiation served by
//! Crossref and DataCite. Both are free and need no account.

use crate::error::{AppError, AppResult};

#[derive(Debug, PartialEq, Eq)]
pub enum Identifier {
    Arxiv(String),
    Doi(String),
}

/// What `text` names, if it's an arXiv id or a DOI, in any of the usual spellings.
pub fn identify(text: &str) -> Option<Identifier> {
    let text = text.trim().trim_end_matches(['.', ',', ';']);
    let lower = text.to_ascii_lowercase();
    let strip = |prefixes: &[&str]| {
        prefixes
            .iter()
            .find(|p| lower.starts_with(*p))
            .map(|p| &text[p.len()..])
    };
    if let Some(rest) = strip(&[
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi.org/",
        "doi:",
    ])
    .or_else(|| lower.starts_with("10.").then_some(text))
    {
        let doi = rest.trim();
        let (prefix, suffix) = doi.split_once('/')?;
        let registrant = prefix.strip_prefix("10.")?;
        let valid = registrant.len() >= 4
            && registrant.chars().all(|c| c.is_ascii_digit() || c == '.')
            && !suffix.is_empty()
            && !suffix.chars().any(char::is_whitespace);
        return valid.then(|| Identifier::Doi(doi.to_string()));
    }
    let id = strip(&[
        "https://arxiv.org/abs/",
        "http://arxiv.org/abs/",
        "https://arxiv.org/pdf/",
        "http://arxiv.org/pdf/",
        "arxiv.org/abs/",
        "arxiv.org/pdf/",
        "arxiv:",
    ])
    .unwrap_or(text);
    let id = id.trim_end_matches(".pdf").trim();
    is_arxiv_id(id).then(|| Identifier::Arxiv(id.to_string()))
}

/// `2301.01234`, `2301.01234v2`, or the old style `math/0601001` and `math.NT/0601001`.
fn is_arxiv_id(id: &str) -> bool {
    let base = match id.rsplit_once('v') {
        Some((base, version))
            if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()) =>
        {
            base
        }
        _ => id,
    };
    if let Some((year_month, number)) = base.split_once('.')
        && !base.contains('/')
    {
        return year_month.len() == 4
            && year_month.chars().all(|c| c.is_ascii_digit())
            && (4..=5).contains(&number.len())
            && number.chars().all(|c| c.is_ascii_digit());
    }
    if let Some((archive, number)) = base.split_once('/') {
        let archive_ok = !archive.is_empty()
            && archive
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '-' || c == '.');
        return archive_ok && number.len() == 7 && number.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Looks `text` up and returns BibTeX for it. The entry's key is a placeholder to be replaced.
pub async fn lookup(http: &reqwest::Client, text: &str) -> AppResult<String> {
    match identify(text) {
        Some(Identifier::Arxiv(id)) => {
            let response = http
                // The id was checked to be letters, digits, dots, dashes and a slash.
                .get(format!("https://export.arxiv.org/api/query?id_list={id}"))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|_| AppError::msg("Couldn't reach arXiv. Check your connection."))?;
            arxiv_bibtex(&response.text().await?, &id)
        }
        Some(Identifier::Doi(doi)) => {
            let response = http
                .get(format!("https://doi.org/{doi}"))
                .header(
                    reqwest::header::ACCEPT,
                    "application/x-bibtex; charset=utf-8",
                )
                .send()
                .await
                .map_err(|_| AppError::msg("Couldn't reach doi.org. Check your connection."))?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(AppError::msg(format!("No work has the DOI {doi}.")));
            }
            let body = response
                .error_for_status()
                .map_err(|_| AppError::msg("doi.org couldn't give a reference for that DOI."))?
                .text()
                .await?;
            if !body.trim_start().starts_with('@') {
                return Err(AppError::msg(
                    "doi.org didn't answer with BibTeX for that DOI.",
                ));
            }
            Ok(body.trim().to_string())
        }
        None => Err(AppError::msg(
            "That isn't an arXiv id or a DOI. Try 2301.01234, arXiv:math/0601001 or 10.4007/annals.2005.162.1.",
        )),
    }
}

/// The text of the first `<name>…</name>` in `xml`, whatever its namespace prefix.
fn element<'a>(xml: &'a str, name: &'a str) -> Option<&'a str> {
    elements(xml, name).next()
}

/// The text of every `<name>…</name>` in `xml`, prefixed or not.
fn elements<'a>(xml: &'a str, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let mut rest = xml;
    std::iter::from_fn(move || {
        loop {
            let open = rest.find('<')?;
            let after = &rest[open + 1..];
            let tag_end = after.find(['>', ' ', '/', '\n', '\t'])?;
            let tag = &after[..tag_end];
            let local = tag.rsplit(':').next().unwrap_or(tag);
            if local == name && !tag.starts_with('/') {
                let start = open + 1 + after.find('>')? + 1;
                if after[..after.find('>')?].ends_with('/') {
                    rest = &rest[start..];
                    return Some("");
                }
                let close = rest[start..].find(&format!("</{tag}>"))?;
                let text = &rest[start..start + close];
                rest = &rest[start + close..];
                return Some(text);
            }
            rest = &rest[open + 1..];
        }
    })
}

/// The value of `attribute` on the first `<name …>` tag in `xml`.
fn attribute<'a>(xml: &'a str, name: &str, attribute: &str) -> Option<&'a str> {
    let mut rest = xml;
    loop {
        let open = rest.find('<')?;
        let after = &rest[open + 1..];
        let end = after.find('>')?;
        let tag = &after[..end];
        let tag_name = tag.split_whitespace().next().unwrap_or("");
        if tag_name.rsplit(':').next() == Some(name) {
            let key = format!("{attribute}=\"");
            let at = tag.find(&key)? + key.len();
            let len = tag[at..].find('"')?;
            return Some(&tag[at..at + len]);
        }
        rest = &after[end..];
    }
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let Some(semi) = tail.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn tidy(text: &str) -> String {
    unescape(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// BibTeX's special characters outside math, escaped, so a title like "Sums & differences" compiles.
fn bibtex_text(text: &str) -> String {
    let mut out = String::new();
    let mut math = false;
    for c in text.chars() {
        if c == '$' {
            math = !math;
        }
        if !math && matches!(c, '&' | '%' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A @misc entry for the paper in arXiv's Atom answer for `id`.
pub fn arxiv_bibtex(atom: &str, id: &str) -> AppResult<String> {
    let entry = element(atom, "entry").ok_or_else(|| {
        AppError::msg(format!(
            "arXiv has no paper {id}. Check the number and try again."
        ))
    })?;
    let title = element(entry, "title").map(tidy).unwrap_or_default();
    if title.is_empty() || title == "Error" {
        return Err(AppError::msg(format!(
            "arXiv has no paper {id}. Check the number and try again."
        )));
    }
    let authors: Vec<String> = elements(entry, "author")
        .filter_map(|author| element(author, "name").map(tidy))
        .filter(|name| !name.is_empty())
        .collect();
    let year = element(entry, "published")
        .map(str::trim)
        .and_then(|p| p.get(..4))
        .unwrap_or("");
    let base = id
        .rsplit_once('v')
        .filter(|(_, v)| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
        .map_or(id, |(base, _)| base);
    let category = attribute(entry, "primary_category", "term");
    // amsplain prints howpublished, and biblatex reads eprint, so both are given.
    let published = match category {
        Some(category) => format!("arXiv:{base} [{category}]"),
        None => format!("arXiv:{base}"),
    };
    let mut fields = vec![
        ("author", authors.join(" and ")),
        ("title", bibtex_text(&title)),
        ("howpublished", published),
        ("year", year.to_string()),
        ("eprint", base.to_string()),
        ("archivePrefix", "arXiv".to_string()),
    ];
    if let Some(category) = category {
        fields.push(("primaryClass", category.to_string()));
    }
    if let Some(doi) = element(entry, "doi").map(tidy).filter(|d| !d.is_empty()) {
        fields.push(("doi", doi));
    }
    if let Some(journal) = element(entry, "journal_ref")
        .map(tidy)
        .filter(|j| !j.is_empty())
    {
        fields.push(("note", bibtex_text(&journal)));
    }
    let body = fields
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(name, value)| format!("  {name} = {{{value}}}"))
        .collect::<Vec<_>>()
        .join(",\n");
    Ok(format!("@misc{{new,\n{body}\n}}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3D%26id_list%3D2301.01234" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=&amp;id_list=2301.01234&amp;start=0&amp;max_results=10</title>
  <id>http://arxiv.org/api/abc</id>
  <updated>2023-01-04T00:00:00-05:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2301.01234v2</id>
    <updated>2023-02-01T12:00:00Z</updated>
    <published>2023-01-03T18:59:58Z</published>
    <title>Sums of $k$-th powers &amp; the
  circle method</title>
    <summary>  We study sums.
</summary>
    <author>
      <name>Terence Tao</name>
    </author>
    <author>
      <name>Ben Green</name>
      <arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Oxford</arxiv:affiliation>
    </author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.4007/annals.2024.1</arxiv:doi>
    <link title="doi" href="http://dx.doi.org/10.4007/annals.2024.1" rel="related"/>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">40 pages</arxiv:comment>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Ann. of Math. 199 (2024) 1-40</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/2301.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2301.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="math.NT" scheme="http://arxiv.org/schemas/atom"/>
    <category term="math.NT" scheme="http://arxiv.org/schemas/atom"/>
    <category term="math.CA" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>"#;

    #[test]
    fn makes_bibtex_from_arxiv() {
        let bib = arxiv_bibtex(ATOM, "2301.01234v2").unwrap();
        assert_eq!(
            bib,
            "@misc{new,\n  author = {Terence Tao and Ben Green},\n  title = {Sums of $k$-th powers \\& the circle method},\n  howpublished = {arXiv:2301.01234 [math.NT]},\n  year = {2023},\n  eprint = {2301.01234},\n  archivePrefix = {arXiv},\n  primaryClass = {math.NT},\n  doi = {10.4007/annals.2024.1},\n  note = {Ann. of Math. 199 (2024) 1-40}\n}"
        );
    }

    #[test]
    fn says_when_arxiv_has_no_such_paper() {
        let empty =
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title></feed>"#;
        assert!(arxiv_bibtex(empty, "2301.99999").is_err());
        let error = r#"<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id><title>Error</title><summary>incorrect id format for 1234</summary></entry></feed>"#;
        let err = arxiv_bibtex(error, "1234").unwrap_err().to_string();
        assert!(err.contains("arXiv has no paper 1234"), "{err}");
    }

    #[test]
    fn recognizes_ids_and_dois_as_people_write_them() {
        let arxiv = |s: &str| Some(Identifier::Arxiv(s.to_string()));
        let doi = |s: &str| Some(Identifier::Doi(s.to_string()));
        assert_eq!(identify("2301.01234"), arxiv("2301.01234"));
        assert_eq!(identify(" arXiv:2301.01234v3 "), arxiv("2301.01234v3"));
        assert_eq!(
            identify("https://arxiv.org/abs/math/0601001"),
            arxiv("math/0601001")
        );
        assert_eq!(
            identify("https://arxiv.org/pdf/2301.01234.pdf"),
            arxiv("2301.01234")
        );
        assert_eq!(identify("math.NT/0601001"), arxiv("math.NT/0601001"));
        assert_eq!(
            identify("10.4007/annals.2005.162.1"),
            doi("10.4007/annals.2005.162.1")
        );
        assert_eq!(
            identify("https://doi.org/10.2307/2118559"),
            doi("10.2307/2118559")
        );
        assert_eq!(
            identify("doi:10.1090/S0002-9947-1949-0028821-5."),
            doi("10.1090/S0002-9947-1949-0028821-5")
        );
        assert_eq!(identify("Fermat's Last Theorem"), None);
        assert_eq!(identify("2301.123"), None);
        assert_eq!(identify("10.12/x"), None);
    }

    #[test]
    fn decodes_xml_text() {
        assert_eq!(
            unescape("a &amp; b &lt;c&gt; &#233; &#x3b1; &bogus; & d"),
            "a & b <c> é α &bogus; & d"
        );
    }
}
