// Prints a page to PDF with macOS's WebKit, the way Theoremis prints on a Mac (src-tauri/src/
// print.rs): through WKWebView.printOperation(with:) on the shared print info with the page's
// margins, run modally for the window and allowed its own thread. It saves to a file instead of
// showing the dialog. Used by print-check.mjs --macos, which compiles it.
//
//   swiftc print-macos.swift -o print-macos && ./print-macos URL OUT.pdf a4|letter
//
// After printing it lists the PDF's pages, how each begins and ends, so a short PDF shows where
// it stops.

import AppKit
import PDFKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, let url = URL(string: arguments[1]) else {
  FileHandle.standardError.write("usage: print-macos URL OUT.pdf a4|letter\n".data(using: .utf8)!)
  exit(2)
}

final class Printer: NSObject {
  let url: URL
  let out: URL
  let paper: String
  let window: NSWindow
  let webView: WKWebView

  init(url: URL, out: URL, paper: String) {
    self.url = url
    self.out = out
    self.paper = paper
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
        self.printPage()
      }
    }
  }

  func printPage() {
    // As Theoremis does: the shared print info, with the page's margins (22mm, and 20mm at the sides).
    let info = NSPrintInfo.shared
    let mm = 72.0 / 25.4
    info.topMargin = 22 * mm
    info.rightMargin = 20 * mm
    info.bottomMargin = 22 * mm
    info.leftMargin = 20 * mm
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
    print("\(pdf.pageCount) pages")
    for n in 0..<pdf.pageCount {
      let text = (pdf.page(at: n)?.string ?? "").replacingOccurrences(of: "\n", with: " ")
      print("  page \(n + 1): \(text.prefix(60)) … \(text.suffix(60))")
    }
    exit(0)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let printer = Printer(url: url, out: URL(fileURLWithPath: arguments[2]), paper: arguments[3])
printer.start()
Timer.scheduledTimer(withTimeInterval: 150, repeats: false) { _ in
  print("timed out")
  exit(1)
}
app.run()
