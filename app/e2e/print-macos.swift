// Prints a page to PDF with macOS's WebKit, the way Theoremis prints on a Mac: through
// WKWebView.printOperation(with:) on the shared print info with zero margins, run modally for the
// window and allowed its own thread, as wry (Tauri) does (wry's wkwebview print_with_options). It
// saves to a file instead of showing the dialog. Used by print-check.mjs --macos.
//
//   swift print-macos.swift URL OUT.pdf a4|letter [--after SHORT_URL] [--last-page N]
//
// --after prints SHORT_URL first, with the same shared print info, as a person who printed a
// shorter document earlier in the session would; --last-page leaves that page number in the
// shared print info, as a print dialog may.
//
// Before printing it reports how tall the page is laid out for print, and after, how many pages
// the PDF has and how its last page ends, so a short PDF can be told from a short page.

import AppKit
import PDFKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, let url = URL(string: arguments[1]) else {
  FileHandle.standardError.write("usage: swift print-macos.swift URL OUT.pdf a4|letter\n".data(using: .utf8)!)
  exit(2)
}
func option(_ name: String) -> String? {
  guard let at = arguments.firstIndex(of: name), at + 1 < arguments.count else { return nil }
  return arguments[at + 1]
}

final class Printer: NSObject {
  let url: URL
  let out: URL
  let paper: String
  let window: NSWindow
  let webView: WKWebView

  var queue: [(URL, URL)]
  var current: (URL, URL)

  init(url: URL, out: URL, paper: String, before: URL?) {
    self.url = url
    self.out = out
    self.paper = paper
    queue = [(url, out)]
    if let before { queue.insert((before, out.deletingPathExtension().appendingPathExtension("first.pdf")), at: 0) }
    current = queue[0]
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    webView = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
    super.init()
    webView.autoresizingMask = [.width, .height]
    window.contentView!.addSubview(webView)
    window.makeKeyAndOrderFront(nil)
  }

  func start() {
    current = queue.removeFirst()
    webView.load(URLRequest(url: current.0))
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { timer in
      self.webView.evaluateJavaScript("document.documentElement.hasAttribute('data-print-ready')") { ready, _ in
        guard (ready as? Bool) == true else { return }
        timer.invalidate()
        self.report()
      }
    }
  }

  /// What the page holds, and how tall it is laid out on screen.
  func report() {
    let script = """
      JSON.stringify({
        blocks: document.querySelectorAll('.print-root [data-block]').length,
        printRoot: Math.round(document.querySelector('.print-root')?.getBoundingClientRect().height ?? -1),
        scrollHeight: document.documentElement.scrollHeight,
        measuring: document.querySelectorAll('.print-root.is-measuring').length,
        marker: document.body.innerText.includes('END_OF_DOCUMENT_EXPORT_TEST'),
      })
      """
    webView.evaluateJavaScript(script) { value, _ in
      print("page before printing: \(value ?? "nil")")
      self.printPage()
    }
  }

  func printPage() {
    // As wry does: the shared print info, its margins set to the defaults (zero).
    let info = NSPrintInfo.shared
    if let last = option("--last-page").flatMap(Int.init) {
      info.dictionary()[NSPrintInfo.AttributeKey.allPages] = true
      info.dictionary()[NSPrintInfo.AttributeKey.firstPage] = 1
      info.dictionary()[NSPrintInfo.AttributeKey.lastPage] = last
    }
    let keys: [NSPrintInfo.AttributeKey] = [.allPages, .firstPage, .lastPage]
    print("print info before: " + keys.map { "\($0.rawValue)=\(info.dictionary()[$0] ?? "nil")" }.joined(separator: " "))
    info.topMargin = 0
    info.rightMargin = 0
    info.bottomMargin = 0
    info.leftMargin = 0
    info.paperSize = paper == "a4" ? NSSize(width: 595.28, height: 841.89) : NSSize(width: 612, height: 792)
    info.jobDisposition = .save
    info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = current.1
    let operation = webView.printOperation(with: info)
    operation.showsPrintPanel = false
    operation.showsProgressPanel = false
    operation.canSpawnSeparateThread = true
    operation.runModal(for: window, delegate: self, didRun: #selector(printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
  }

  @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
    guard success, let pdf = PDFDocument(url: current.1) else {
      print("printing failed")
      exit(1)
    }
    print("PDF \(current.1.lastPathComponent): \(pdf.pageCount) pages")
    for n in 0..<pdf.pageCount {
      let text = (pdf.page(at: n)?.string ?? "").replacingOccurrences(of: "\n", with: " ")
      print("  page \(n + 1): \(text.prefix(70)) … \(text.suffix(70))")
    }
    let keys: [NSPrintInfo.AttributeKey] = [.allPages, .firstPage, .lastPage]
    print("shared print info after: " + keys.map { "\($0.rawValue)=\(NSPrintInfo.shared.dictionary()[$0] ?? "nil")" }.joined(separator: " "))
    if queue.isEmpty { exit(0) }
    start()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let printer = Printer(url: url, out: URL(fileURLWithPath: arguments[2]), paper: arguments[3], before: option("--after").flatMap(URL.init(string:)))
printer.start()
Timer.scheduledTimer(withTimeInterval: 150, repeats: false) { _ in
  print("timed out")
  exit(1)
}
app.run()
