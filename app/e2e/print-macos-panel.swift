// Diagnosis only: prints a page with macOS's WebKit through the print dialog, as a person does
// (the dialog's preview, then PDF ▸ Save as PDF), driving the dialog from inside the process.
//
//   swift print-macos-panel.swift URL OUT.pdf a4|letter panel|preview
//
// "preview" instead asks for the page range on the main thread first, as the dialog's preview
// does, then prints without the dialog.

import AppKit
import PDFKit
import WebKit


func describe(_ info: NSPrintInfo) -> String {
  let keys: [NSPrintInfo.AttributeKey] = [.allPages, .firstPage, .lastPage, .scalingFactor, .jobDisposition]
  let values = keys.map { "\($0.rawValue)=\(info.dictionary()[$0] ?? "nil")" }.joined(separator: " ")
  return "paper=\(info.paperSize) margins t\(info.topMargin) b\(info.bottomMargin) l\(info.leftMargin) r\(info.rightMargin) imageable=\(info.imageablePageBounds) \(values)"
}

func walk(_ view: NSView, _ visit: (NSView, Int) -> Void, _ depth: Int = 0) {
  visit(view, depth)
  for sub in view.subviews { walk(sub, visit, depth + 1) }
}

func dump(_ view: NSView) {
  walk(view) { v, depth in
    let pad = String(repeating: " ", count: depth)
    if let b = v as? NSPopUpButton {
      print("\(pad)\(type(of: v)) popup [\(b.itemTitles.joined(separator: " | "))] selected=\(b.titleOfSelectedItem ?? "-") enabled=\(b.isEnabled)")
    } else if let b = v as? NSButton, !b.title.isEmpty {
      print("\(pad)\(type(of: v)) button '\(b.title)' enabled=\(b.isEnabled)")
    } else if let t = v as? NSTextField, !t.stringValue.isEmpty {
      print("\(pad)\(type(of: v)) text '\(t.stringValue)'")
    } else if depth < 3 {
      print("\(pad)\(type(of: v))")
    }
  }
}

func report(_ file: URL) {
  guard let pdf = PDFDocument(url: file) else { print("no PDF at \(file.path)"); return }
  print("PDF \(file.lastPathComponent): \(pdf.pageCount) pages, page 1 \(pdf.page(at: 0)?.bounds(for: .mediaBox) ?? .zero)")
  for n in 0..<pdf.pageCount {
    let text = (pdf.page(at: n)?.string ?? "").replacingOccurrences(of: "\n", with: " ")
    print("  page \(n + 1): \(text.prefix(60)) … \(text.suffix(60))")
  }
  print("  has marker: \(pdf.string?.contains("END_OF_DOCUMENT_EXPORT_TEST") ?? false)")
}

final class Runner: NSObject {
  let url: URL
  let out: URL
  let paper: String
  let mode: String
  let window: NSWindow
  let webView: WKWebView
  var operation: NSPrintOperation?

  init(url: URL, out: URL, paper: String, mode: String) {
    self.url = url
    self.out = out
    self.paper = paper
    self.mode = mode
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
        self.go()
      }
    }
  }

  func go() {
    let info = NSPrintInfo.shared
    info.topMargin = 0
    info.rightMargin = 0
    info.bottomMargin = 0
    info.leftMargin = 0
    info.paperSize = paper == "a4" ? NSSize(width: 595.28, height: 841.89) : NSSize(width: 612, height: 792)
    if mode == "preview" {
      info.jobDisposition = .save
      info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = out
    }
    print("print info before: \(describe(info))")
    let operation = webView.printOperation(with: info)
    self.operation = operation
    operation.canSpawnSeparateThread = true
    operation.showsProgressPanel = false
    if mode == "preview" {
      operation.showsPrintPanel = false
      var range = NSRange()
      let known = operation.view!.knowsPageRange(&range)
      print("preview: knowsPageRange=\(known) range=\(range)")
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        var again = NSRange()
        _ = operation.view!.knowsPageRange(&again)
        print("preview after 3s: range=\(again) view frame=\(operation.view!.frame)")
        operation.runModal(for: self.window, delegate: self, didRun: #selector(self.didRun(_:success:contextInfo:)), contextInfo: nil)
      }
    } else {
      operation.showsPrintPanel = true
      operation.runModal(for: window, delegate: self, didRun: #selector(didRun(_:success:contextInfo:)), contextInfo: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self.drivePanel() }
    }
  }

  func drivePanel() {
    for w in NSApp.windows { print("window \(type(of: w)) '\(w.title)' visible=\(w.isVisible) sheet=\(w.isSheet)") }
    guard let sheet = window.attachedSheet, let content = sheet.contentView else {
      print("no print dialog sheet")
      return
    }
    print("print dialog: \(type(of: sheet))")
    dump(content)
    if let info = operation?.printInfo { print("operation print info in dialog: \(describe(info))") }
    var pdfButton: NSPopUpButton?
    walk(content) { v, _ in
      if let b = v as? NSPopUpButton, b.itemTitles.contains(where: { $0.hasPrefix("Save as PDF") }) { pdfButton = b }
    }
    guard let pdf = pdfButton, let menu = pdf.menu, let index = menu.items.firstIndex(where: { $0.title.hasPrefix("Save as PDF") }) else {
      print("no PDF ▸ Save as PDF in the dialog")
      return
    }
    print("choosing PDF ▸ \(menu.items[index].title)")
    menu.performActionForItem(at: index)
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.driveSave() }
  }

  func driveSave() {
    for w in NSApp.windows { print("window \(type(of: w)) '\(w.title)' visible=\(w.isVisible) sheet=\(w.isSheet)") }
    let save = NSApp.windows.compactMap { $0 as? NSSavePanel }.first(where: { $0.isVisible })
    guard let save else {
      print("no save panel")
      return
    }
    save.directoryURL = out.deletingLastPathComponent()
    save.nameFieldStringValue = out.lastPathComponent
    print("saving to \(save.directoryURL?.path ?? "?") / \(save.nameFieldStringValue)")
    save.ok(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
      // Save as PDF hands the job to the print system, which may finish after the dialog.
      report(self.out)
      exit(0)
    }
  }

  @objc func didRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
    print("print operation finished: success=\(success)")
    print("operation print info after: \(describe(operation.printInfo))")
    if mode == "preview" {
      report(out)
      exit(0)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
      report(self.out)
      exit(0)
    }
  }
}

let arguments = CommandLine.arguments
let out = URL(fileURLWithPath: arguments[2])
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let runner = Runner(url: URL(string: arguments[1])!, out: out, paper: arguments[3], mode: arguments.count > 4 ? arguments[4] : "panel")
runner.start()
Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in
  print("timed out")
  report(out)
  exit(1)
}
app.run()
