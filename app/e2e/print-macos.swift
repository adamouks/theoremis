// Prints a page to PDF with macOS's WebKit, the way Theoremis prints on a Mac: through
// WKWebView.printOperation(with:) on the shared print info with zero margins, run modally for the
// window and allowed its own thread, as wry (Tauri) does (wry's wkwebview print_with_options). It
// saves to a file instead of showing the dialog. Used by print-check.mjs --macos.
//
//   swift print-macos.swift URL OUT.pdf a4|letter
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
let out = URL(fileURLWithPath: arguments[2])
let paper = arguments[3]

final class Printer: NSObject {
  let window: NSWindow
  let webView: WKWebView

  override init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 900), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    webView = WKWebView(frame: window.contentView!.bounds, configuration: WKWebViewConfiguration())
    super.init()
    webView.autoresizingMask = [.width, .height]
    window.contentView!.addSubview(webView)
    window.makeKeyAndOrderFront(nil)
  }

  func start() {
    webView.load(URLRequest(url: url))
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
    info.topMargin = 0
    info.rightMargin = 0
    info.bottomMargin = 0
    info.leftMargin = 0
    info.paperSize = paper == "a4" ? NSSize(width: 595.28, height: 841.89) : NSSize(width: 612, height: 792)
    info.jobDisposition = .save
    info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = out
    let operation = webView.printOperation(with: info)
    operation.showsPrintPanel = false
    operation.showsProgressPanel = false
    operation.canSpawnSeparateThread = true
    operation.runModal(for: window, delegate: self, didRun: #selector(printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
  }

  @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
    guard success, let pdf = PDFDocument(url: out) else {
      print("printing failed")
      exit(1)
    }
    let last = pdf.page(at: pdf.pageCount - 1)?.string ?? ""
    print("PDF: \(pdf.pageCount) pages; last page ends: \(last.suffix(160).replacingOccurrences(of: "\n", with: " "))")
    exit(0)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let printer = Printer()
printer.start()
Timer.scheduledTimer(withTimeInterval: 150, repeats: false) { _ in
  print("timed out")
  exit(1)
}
app.run()
