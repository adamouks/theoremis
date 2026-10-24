//! A one-shot HTTP server for exercising the streaming clients end to end in tests.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub struct Captured {
    pub head: String,
    pub body: String,
}

/// Serves a single request, replying with `status` and sending each chunk as its own
/// HTTP chunk so the client sees the body split exactly where the test says.
pub async fn serve_once(
    status: u16,
    content_type: &'static str,
    chunks: Vec<&'static str>,
) -> (String, JoinHandle<Captured>) {
    let (url, handle) = serve_each(vec![(status, content_type, chunks)]).await;
    (
        url,
        tokio::spawn(async move { handle.await.unwrap().remove(0) }),
    )
}

/// Serves one request per reply, in order, on the same address.
pub async fn serve_each(
    replies: Vec<(u16, &'static str, Vec<&'static str>)>,
) -> (String, JoinHandle<Vec<Captured>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let mut captured = Vec::new();
        for (status, content_type, chunks) in replies {
            let (socket, _) = listener.accept().await.unwrap();
            captured.push(reply(socket, status, content_type, chunks).await);
        }
        captured
    });
    (url, handle)
}

async fn reply(
    mut socket: TcpStream,
    status: u16,
    content_type: &str,
    chunks: Vec<&str>,
) -> Captured {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = socket.read(&mut tmp).await.unwrap();
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        assert!(n > 0, "client closed before sending headers");
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while buf.len() < header_end + length {
        let n = socket.read(&mut tmp).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = String::from_utf8_lossy(&buf[header_end..]).to_string();

    let head_out = format!(
        "HTTP/1.1 {status} Test\r\ncontent-type: {content_type}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
    );
    socket.write_all(head_out.as_bytes()).await.unwrap();
    for chunk in chunks {
        let framed = format!("{:x}\r\n{chunk}\r\n", chunk.len());
        socket.write_all(framed.as_bytes()).await.unwrap();
        socket.flush().await.unwrap();
        tokio::task::yield_now().await;
    }
    let _ = socket.write_all(b"0\r\n\r\n").await;
    Captured { head, body }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}
