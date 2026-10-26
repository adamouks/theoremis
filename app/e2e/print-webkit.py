# Prints a page to PDF with WebKitGTK, the engine Tauri uses on Linux, once the page says it's
# ready (<html data-print-ready>), through WebKit's own print operation as the print dialog would.
# Used by print-check.mjs --webkit.  Usage: xvfb-run -a python3 print-webkit.py URL OUT.pdf a4|letter

import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

url, out, paper = sys.argv[1], sys.argv[2], sys.argv[3]

window = Gtk.OffscreenWindow()
view = WebKit2.WebView()
view.get_settings().set_enable_webgl(True)
window.add(view)
window.set_default_size(1280, 900)
window.show_all()
result = {"code": 1}


def finish(code):
    result["code"] = code
    Gtk.main_quit()


def print_page():
    operation = WebKit2.PrintOperation.new(view)
    settings = Gtk.PrintSettings()
    settings.set_printer("Print to File")
    settings.set(Gtk.PRINT_SETTINGS_OUTPUT_URI, "file://" + out)
    settings.set(Gtk.PRINT_SETTINGS_OUTPUT_FILE_FORMAT, "pdf")
    operation.set_print_settings(settings)
    # As Theoremis prints on Linux (src-tauri/src/print.rs): the page's margins in the page setup.
    setup = Gtk.PageSetup()
    setup.set_paper_size(Gtk.PaperSize.new(Gtk.PAPER_NAME_A4 if paper == "a4" else Gtk.PAPER_NAME_LETTER))
    setup.set_top_margin(22, Gtk.Unit.MM)
    setup.set_bottom_margin(22, Gtk.Unit.MM)
    setup.set_left_margin(20, Gtk.Unit.MM)
    setup.set_right_margin(20, Gtk.Unit.MM)
    operation.set_page_setup(setup)
    operation.connect("finished", lambda *_: finish(0))
    operation.connect("failed", lambda _op, error: (print("print failed:", error, file=sys.stderr), finish(1)))
    operation.print_()


def poll():
    def done(webview, task):
        try:
            ready = webview.evaluate_javascript_finish(task).to_boolean()
        except GLib.Error:
            ready = False
        if ready:
            print_page()
        else:
            GLib.timeout_add(250, poll)

    view.evaluate_javascript("document.documentElement.hasAttribute('data-print-ready')", -1, None, None, None, done)
    return False


view.load_uri(url)
GLib.timeout_add(500, poll)
GLib.timeout_add(150_000, lambda: (print("timed out", file=sys.stderr), finish(1)))
Gtk.main()
sys.exit(result["code"])
