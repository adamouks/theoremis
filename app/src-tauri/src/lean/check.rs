//! Turning a Lean file into a verdict: what may be run, which theorems to ask about, and what
//! Lean's answers mean.

use serde::{Deserialize, Serialize};

/// Axioms every Mathlib proof may use. Anything else is reported alongside the result.
const STANDARD_AXIOMS: &[&str] = &["propext", "Classical.choice", "Quot.sound"];

/// Libraries a formalization may import. Importing is harmless in itself, but keeping to these
/// keeps checks to mathematics.
const ALLOWED_IMPORTS: &[&str] = &[
    "Mathlib",
    "Batteries",
    "Aesop",
    "Qq",
    "Plausible",
    "ProofWidgets",
    "Std",
    "Init",
    "Lean",
];

/// Commands and features through which a Lean file can run programs on the computer checking
/// it, directly or by defining syntax that expands to them. Proofs don't need any of them.
const FORBIDDEN: &[(&str, &str)] = &[
    ("#eval", "#eval runs code"),
    ("#exec", "#exec runs code"),
    ("run_cmd", "run_cmd runs code"),
    ("run_elab", "run_elab runs code"),
    ("run_meta", "run_meta runs code"),
    ("run_tac", "run_tac runs code"),
    ("elab", "a custom elaborator runs code"),
    ("elab_rules", "a custom elaborator runs code"),
    ("macro", "a macro can expand into commands that run code"),
    (
        "macro_rules",
        "a macro can expand into commands that run code",
    ),
    (
        "syntax",
        "new syntax can expand into commands that run code",
    ),
    (
        "declare_syntax_cat",
        "new syntax can expand into commands that run code",
    ),
    ("initialize", "an initializer runs code"),
    ("builtin_initialize", "an initializer runs code"),
    ("unsafe", "unsafe definitions run unchecked code"),
    ("implemented_by", "implemented_by swaps in other code"),
    ("extern", "extern links outside code"),
    ("IO", "IO actions touch the computer"),
    ("System", "System functions touch the computer"),
];

/// Attributes that run or expose code, wherever they appear in an attribute list.
const FORBIDDEN_ATTRIBUTES: &[&str] = &["init", "builtin_init", "export"];

/// Why the file shouldn't be run, if it does something beyond stating and proving things.
pub fn refusal(code: &str) -> Option<String> {
    let refuse = |why: &str| {
        Some(format!(
            "{why}. Theoremis only checks statements and proofs, so remove it and check again."
        ))
    };
    let Some(code) = without_comments(code) else {
        return refuse("It uses raw string literals, which proofs don't need");
    };
    for line in code.lines() {
        if let Some(modules) = line.trim_start().strip_prefix("import ") {
            for module in modules.split_whitespace() {
                let root = module.split('.').next().unwrap_or(module);
                if !ALLOWED_IMPORTS.contains(&root) {
                    return refuse(&format!(
                        "It imports {module}; checks are limited to Mathlib and Lean's own libraries"
                    ));
                }
            }
        }
    }
    if let Some((word, why)) = FORBIDDEN
        .iter()
        .find(|(word, _)| contains_word(&code, word))
    {
        return refuse(&format!("It uses {word}: {why} on your computer"));
    }
    for list in attribute_lists(&code) {
        if let Some(attr) = FORBIDDEN_ATTRIBUTES.iter().find(|a| contains_word(list, a)) {
            return refuse(&format!(
                "It uses the {attr} attribute, which runs or exposes code"
            ));
        }
    }
    None
}

/// The code with comments removed, so prose in them can't trip the checks. Strings and character
/// literals are kept (interpolated strings hold code) but can't open or close a comment. Returns
/// `None` for raw string literals, whose quoting this doesn't follow.
fn without_comments(code: &str) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::with_capacity(code.len());
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let prev_ident = out.chars().next_back().is_some_and(is_ident);
        if depth > 0 {
            match (c, next) {
                ('/', Some('-')) => {
                    depth += 1;
                    i += 2;
                }
                ('-', Some('/')) => {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        out.push(' ');
                    }
                }
                _ => {
                    if c == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            continue;
        }
        match (c, next) {
            ('/', Some('-')) => {
                depth = 1;
                i += 2;
            }
            ('-', Some('-')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            ('r', Some('"' | '#')) if !prev_ident => return None,
            ('"', _) => {
                out.push('"');
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' {
                        out.push(chars[i]);
                        i += 1;
                    }
                    if let Some(&ch) = chars.get(i) {
                        out.push(ch);
                    }
                    i += 1;
                }
                out.push('"');
                i += 1;
            }
            // A character literal such as '"' or '\n'; a quote after a name is part of the name.
            ('\'', Some(_)) if !prev_ident => {
                let close = (i + 2..chars.len().min(i + 12)).find(|&j| chars[j] == '\'');
                let end = close.unwrap_or(i);
                out.extend(&chars[i..=end]);
                i = end + 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    Some(out)
}

/// The contents of every `@[…]` and `attribute […]` list.
fn attribute_lists(code: &str) -> Vec<&str> {
    let mut lists = Vec::new();
    for opener in ["@[", "attribute ["] {
        for (at, _) in code.match_indices(opener) {
            let rest = &code[at + opener.len()..];
            lists.push(rest.split_once(']').map_or(rest, |(inside, _)| inside));
        }
    }
    lists
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '\'' || c == '!' || c == '?'
}

/// Whether `word` occurs as a whole token (`IO` matches `IO.println` but not `RatIO`).
fn contains_word(code: &str, word: &str) -> bool {
    code.match_indices(word).any(|(at, _)| {
        let before = code[..at].chars().next_back();
        let after = code[at + word.len()..].chars().next();
        let starts = word.starts_with('#') || before.is_none_or(|c| !is_ident(c) && c != '.');
        starts && after.is_none_or(|c| !is_ident(c))
    })
}

/// The fully qualified names of the theorems and lemmas the file declares, so each can be asked
/// which axioms its proof rests on.
pub fn theorem_names(code: &str) -> Vec<String> {
    let mut scopes: Vec<String> = Vec::new();
    let mut names = Vec::new();
    for line in code.lines() {
        let mut rest = line.trim();
        // Attributes like @[simp] can sit on the same line as the declaration.
        while let Some(after) = rest.strip_prefix("@[") {
            rest = after.split_once(']').map_or("", |(_, r)| r.trim_start());
        }
        let mut words = rest.split_whitespace();
        let Some(mut keyword) = words.next() else {
            continue;
        };
        while matches!(
            keyword,
            "private" | "protected" | "noncomputable" | "nonrec"
        ) {
            keyword = words.next().unwrap_or("");
        }
        match keyword {
            "namespace" => scopes.push(words.next().unwrap_or("").to_string()),
            "section" => scopes.push(String::new()),
            "end" => {
                scopes.pop();
            }
            "theorem" | "lemma" => {
                let Some(raw) = words.next() else { continue };
                let name: String = raw
                    .chars()
                    .take_while(|c| !matches!(c, '(' | '{' | '[' | ':' | '⦃'))
                    .collect();
                if name.is_empty() {
                    continue;
                }
                if let Some(root) = name.strip_prefix("_root_.") {
                    names.push(root.to_string());
                } else {
                    let prefix: Vec<&str> = scopes
                        .iter()
                        .filter(|s| !s.is_empty())
                        .map(String::as_str)
                        .collect();
                    names.push(if prefix.is_empty() {
                        name
                    } else {
                        format!("{}.{name}", prefix.join("."))
                    });
                }
            }
            _ => {}
        }
    }
    names
}

/// One line of `lean --json` output.
#[derive(Deserialize, Debug)]
struct RawMessage {
    severity: String,
    pos: Position,
    #[serde(default, rename = "endPos")]
    end_pos: Option<Position>,
    data: String,
    /// What kind of message it is, e.g. `hasSorry`, in recent versions of Lean.
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Copy)]
struct Position {
    line: u32,
    column: u32,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Lean accepted every proof, and none rests on `sorry`.
    Proved,
    /// It compiles, but something is left as `sorry`.
    Incomplete,
    /// Lean reported errors.
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "error", "warning" or "information".
    pub severity: String,
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Theorem {
    pub name: String,
    /// Axioms beyond the standard three (propext, choice, quotient soundness).
    pub extra_axioms: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub outcome: Outcome,
    pub messages: Vec<Message>,
    pub theorems: Vec<Theorem>,
    pub seconds: f32,
}

/// Reads Lean's messages for a file whose first `code_lines` lines are the code being checked
/// and whose remaining lines ask `#print axioms` about `names`.
pub fn interpret(
    output: &str,
    code_lines: u32,
    names: &[String],
    exit_ok: bool,
    seconds: f32,
) -> CheckResult {
    let mut messages = Vec::new();
    let mut axioms: Vec<(String, Vec<String>)> = Vec::new();
    let mut unparsed = Vec::new();
    let mut saw_sorry = false;
    for line in output.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(raw) = serde_json::from_str::<RawMessage>(line) else {
            unparsed.push(line.trim().to_string());
            continue;
        };
        if raw.pos.line > code_lines {
            if let Some(found) = parse_axioms(&raw.data) {
                axioms.push(found);
            }
            continue;
        }
        // Older Lean quotes it 'sorry', newer `sorry` and tags the message.
        saw_sorry |= raw.kind.as_deref() == Some("hasSorry")
            || (raw.data.contains("declaration uses") && raw.data.contains("sorry"));
        messages.push(Message {
            severity: raw.severity,
            line: raw.pos.line,
            column: raw.pos.column,
            end_line: raw.end_pos.map(|p| p.line),
            end_column: raw.end_pos.map(|p| p.column),
            text: raw.data.trim_end().to_string(),
        });
    }
    if !exit_ok && messages.iter().all(|m| m.severity != "error") {
        // Lean stopped without saying why in JSON, e.g. a missing import; pass on what it printed.
        messages.push(Message {
            severity: "error".into(),
            line: 1,
            column: 0,
            end_line: None,
            end_column: None,
            text: if unparsed.is_empty() {
                "Lean stopped unexpectedly.".into()
            } else {
                unparsed.join("\n")
            },
        });
    }

    let theorems: Vec<Theorem> = names
        .iter()
        .filter_map(|name| {
            let (_, used) = axioms
                .iter()
                .find(|(n, _)| n == name || n.ends_with(&format!(".{name}")))?;
            Some(Theorem {
                name: name.clone(),
                extra_axioms: used
                    .iter()
                    .filter(|a| !STANDARD_AXIOMS.contains(&a.as_str()))
                    .cloned()
                    .collect(),
            })
        })
        .collect();
    let uses_sorry = saw_sorry
        || theorems
            .iter()
            .any(|t| t.extra_axioms.iter().any(|a| a == "sorryAx"));
    let outcome = if messages.iter().any(|m| m.severity == "error") {
        Outcome::Failed
    } else if uses_sorry {
        Outcome::Incomplete
    } else {
        Outcome::Proved
    };
    CheckResult {
        outcome,
        messages,
        theorems,
        seconds,
    }
}

/// Reads `'foo' depends on axioms: [propext, sorryAx]` or `'foo' does not depend on any axioms`.
fn parse_axioms(text: &str) -> Option<(String, Vec<String>)> {
    let text = text.trim();
    let rest = text.strip_prefix('\'')?;
    let (name, rest) = rest.split_once('\'')?;
    if rest.contains("does not depend on any axioms") {
        return Some((name.to_string(), Vec::new()));
    }
    let list = rest.split_once('[')?.1.split_once(']')?.0;
    Some((
        name.to_string(),
        list.split(',')
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_comments_but_not_code_hidden_after_strings() {
        assert_eq!(
            refusal(
                "-- #eval would run code\n/- IO and System /- nested -/ -/\ntheorem t : True := trivial"
            ),
            None
        );
        assert_eq!(
            refusal("/-- A System of equations. -/\ntheorem t : True := trivial"),
            None
        );
        // A string or char literal can't open a comment that hides what follows.
        assert!(refusal("def s := \"/-\"\n#eval 1\n-- -/").is_some());
        assert!(refusal("def c := '\"' #eval 1 -- \"").is_some());
        assert!(refusal("def s := s!\"{IO.getStdin}\"").is_some());
        assert!(refusal("def s := r#\"x\"#").is_some());
        assert!(refusal("macro \"go\" : command => `(#check 1)").is_some());
        assert!(refusal("@[simp, export lean_foo] def f := 1").is_some());
        assert!(refusal("attribute [init foo] bar").is_some());
        assert_eq!(refusal("theorem h' (init : ℕ) : init = init := rfl"), None);
    }

    #[test]
    fn refuses_files_that_run_programs() {
        let proof = "import Mathlib\n\ntheorem two : 1 + 1 = 2 := by norm_num\n";
        assert_eq!(refusal(proof), None);
        assert!(
            refusal("#eval IO.println \"hi\"")
                .unwrap()
                .contains("#eval")
        );
        assert!(refusal("run_cmd do pure ()").is_some());
        assert!(
            refusal("elab \"pwn\" : tactic => do\n  let _ ← IO.Process.run {cmd := \"ls\"}")
                .is_some()
        );
        assert!(refusal("@[implemented_by foo] def bar := 1").is_some());
        assert!(
            refusal("import Mathlib\nimport Evil.Stuff")
                .unwrap()
                .contains("Evil.Stuff")
        );
        // Whole words only: these are ordinary identifiers.
        assert_eq!(refusal("theorem RatIO_ok : True := trivial"), None);
        assert_eq!(refusal("theorem initial_seg : True := trivial"), None);
        assert_eq!(
            refusal("open Mathlib.Tactic in example : True := trivial"),
            None
        );
    }

    #[test]
    fn finds_qualified_theorem_names() {
        let code = "import Mathlib\n\
            theorem top : True := trivial\n\
            namespace Odd\n\
            @[simp] lemma sum_odd (n : ℕ) : True := trivial\n\
            section\n\
            private theorem helper {x : ℕ} : True := trivial\n\
            end\n\
            theorem _root_.global : True := trivial\n\
            end Odd\n\
            example : True := trivial\n";
        assert_eq!(
            theorem_names(code),
            vec!["top", "Odd.sum_odd", "Odd.helper", "global"]
        );
    }

    #[test]
    fn interprets_lean_output() {
        let names = vec!["sum_odd".to_string(), "Foo.bar".to_string()];
        let proved = r#"{"severity":"information","pos":{"line":12,"column":0},"endPos":{"line":12,"column":6},"data":"'sum_odd' depends on axioms: [propext, Classical.choice, Quot.sound]"}
{"severity":"information","pos":{"line":13,"column":0},"endPos":null,"data":"'Foo.bar' does not depend on any axioms"}"#;
        let result = interpret(proved, 10, &names, true, 1.0);
        assert_eq!(result.outcome, Outcome::Proved);
        assert!(result.messages.is_empty());
        assert_eq!(result.theorems.len(), 2);
        assert!(result.theorems.iter().all(|t| t.extra_axioms.is_empty()));

        // Verbatim from Lean 4.36.
        let sorry = r#"{"caption":"","data":"declaration uses `sorry`","endPos":{"column":18,"line":3},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"hasSorry","pos":{"column":8,"line":3},"severity":"warning"}
{"caption":"","data":"'sum_odd' depends on axioms: [sorryAx]","endPos":{"column":6,"line":12},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":0,"line":12},"severity":"information"}"#;
        let result = interpret(sorry, 10, &names, true, 1.0);
        assert_eq!(result.outcome, Outcome::Incomplete);
        assert_eq!(result.messages[0].line, 3);

        let failed = r#"{"severity":"error","pos":{"line":4,"column":2},"endPos":{"line":4,"column":9},"data":"unknown identifier 'foo'\n"}
{"severity":"error","pos":{"line":12,"column":0},"data":"unknown constant 'sum_odd'"}"#;
        let result = interpret(failed, 10, &names, false, 1.0);
        assert_eq!(result.outcome, Outcome::Failed);
        assert_eq!(result.messages.len(), 1);
        assert_eq!(result.messages[0].text, "unknown identifier 'foo'");

        // A sorry the axioms check can't see (in an example) still counts.
        let older = r#"{"severity":"warning","pos":{"line":2,"column":0},"data":"declaration uses 'sorry'"}"#;
        assert_eq!(
            interpret(older, 10, &[], true, 1.0).outcome,
            Outcome::Incomplete
        );

        let crashed = interpret("unknown module prefix 'Mathlib'\n", 10, &names, false, 1.0);
        assert_eq!(crashed.outcome, Outcome::Failed);
        assert!(crashed.messages[0].text.contains("unknown module prefix"));
    }

    #[test]
    fn notes_unusual_axioms() {
        let out = r#"{"severity":"information","pos":{"line":5,"column":0},"data":"'fast' depends on axioms: [propext, Lean.ofReduceBool]"}"#;
        let result = interpret(out, 4, &["fast".into()], true, 0.5);
        assert_eq!(result.outcome, Outcome::Proved);
        assert_eq!(result.theorems[0].extra_axioms, vec!["Lean.ofReduceBool"]);
    }
}
