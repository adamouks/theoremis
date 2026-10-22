use futures_util::StreamExt;

use crate::error::AppResult;

/// Reassembles newline-delimited text from arbitrarily split byte chunks.
///
/// Splitting on `\n` at the byte level is safe for UTF-8: the byte never occurs
/// inside a multi-byte sequence, so a character split across chunks stays intact.
#[derive(Default)]
pub struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    /// Adds a chunk and returns every line it completed, without line terminators.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    /// Returns any trailing text that wasn't terminated by a newline.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        let text = String::from_utf8_lossy(&rest)
            .trim_end_matches('\r')
            .to_string();
        (!text.is_empty()).then_some(text)
    }
}

/// What a line handler wants the reader to do next.
pub enum Flow {
    Continue,
    Stop,
}

/// Reads a streaming HTTP body line by line until the body ends or the handler stops.
pub async fn for_each_line(
    response: reqwest::Response,
    mut handle: impl FnMut(&str) -> AppResult<Flow>,
) -> AppResult<()> {
    let mut stream = response.bytes_stream();
    let mut lines = LineBuffer::default();
    while let Some(chunk) = stream.next().await {
        for line in lines.push(&chunk?) {
            if let Flow::Stop = handle(&line)? {
                return Ok(());
            }
        }
    }
    if let Some(line) = lines.finish() {
        handle(&line)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_lines_split_across_chunks() {
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"{\"a\":").is_empty());
        assert_eq!(buf.push(b"1}\n{\"b\""), vec!["{\"a\":1}"]);
        assert_eq!(buf.push(b":2}\r\n\n"), vec!["{\"b\":2}", ""]);
        assert_eq!(buf.finish(), None);
    }

    #[test]
    fn keeps_multibyte_characters_intact() {
        let text = "∀ε>0 ∃δ\n";
        let bytes = text.as_bytes();
        let mut buf = LineBuffer::default();
        let mut out = Vec::new();
        for byte in bytes {
            out.extend(buf.push(std::slice::from_ref(byte)));
        }
        assert_eq!(out, vec!["∀ε>0 ∃δ"]);
    }

    #[test]
    fn returns_unterminated_tail() {
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"data: [DONE]").is_empty());
        assert_eq!(buf.finish().as_deref(), Some("data: [DONE]"));
    }
}
