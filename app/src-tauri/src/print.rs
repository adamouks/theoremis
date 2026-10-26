//! Printing the page: the system's print dialog, which can also save a PDF, for the copy of the
//! document the page lays out for print (components/PrintDocument.tsx).
//!
//! The page's margins are given to the print settings, and not only to the page's style (`@page`
//! in styles.css). WebKit, on macOS and on Linux, measures the printed page from the print
//! settings before it applies the page's print styles, where `@page` is. With no margins in the
//! settings it measured pages larger than the ones it then drew: on macOS it counted too few, and
//! printed only those, so a long document lost its last pages; on Linux it drew them to the
//! paper's own narrow margins. With the margins in both, every measure agrees. Windows' engine
//! reads `@page`.

use tauri::Webview;
use tauri::webview::PlatformWebview;

/// The page's margins, as in styles.css: 22mm at the top and bottom, 20mm at the sides.
const TOP_AND_BOTTOM_MM: f64 = 22.0;
const SIDES_MM: f64 = 20.0;

/// Opens the print dialog for the webview's page.
pub fn print(webview: &Webview) -> tauri::Result<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        webview.with_webview(print_with_margins)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        webview.print()
    }
}

/// As wry prints, with the shared print info (so the dialog's choices, such as the paper, stay
/// for the next print) and its own thread, in a sheet on the window; but with the page's margins.
#[cfg(target_os = "macos")]
fn print_with_margins(platform: PlatformWebview) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};

    const POINTS_PER_MM: f64 = 72.0 / 25.4;
    // SAFETY: the pointer is the webview's WKWebView, alive while Tauri runs this on the main thread.
    let webview = unsafe { &*platform.inner().cast::<AnyObject>() };
    // Before macOS 11 WebKit can't print a WKWebView; wry doesn't print there either.
    let can_print: bool =
        unsafe { msg_send![webview, respondsToSelector: sel!(printOperationWithPrintInfo:)] };
    if !can_print {
        return;
    }
    let info = NSPrintInfo::sharedPrintInfo();
    info.setTopMargin(TOP_AND_BOTTOM_MM * POINTS_PER_MM);
    info.setBottomMargin(TOP_AND_BOTTOM_MM * POINTS_PER_MM);
    info.setLeftMargin(SIDES_MM * POINTS_PER_MM);
    info.setRightMargin(SIDES_MM * POINTS_PER_MM);
    // SAFETY: WKWebView's printOperationWithPrintInfo: (macOS 11 and later) and NSView's window.
    let operation: Retained<NSPrintOperation> =
        unsafe { msg_send![webview, printOperationWithPrintInfo: &*info] };
    let window: Option<Retained<NSWindow>> = unsafe { msg_send![webview, window] };
    operation.setCanSpawnSeparateThread(true);
    if let Some(window) = window {
        // SAFETY: no delegate, no selector, no context.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                None,
                None,
                std::ptr::null_mut(),
            )
        };
    }
}

/// As wry prints, with WebKit's print dialog, but with the page's margins in its page setup. A
/// paper chosen in the dialog comes with the paper's own margins, and prints with those.
#[cfg(target_os = "linux")]
fn print_with_margins(platform: PlatformWebview) {
    use gtk::prelude::*;
    use webkit2gtk::PrintOperationExt;

    let webview = platform.inner();
    let setup = gtk::PageSetup::new();
    setup.set_top_margin(TOP_AND_BOTTOM_MM, gtk::Unit::Mm);
    setup.set_bottom_margin(TOP_AND_BOTTOM_MM, gtk::Unit::Mm);
    setup.set_left_margin(SIDES_MM, gtk::Unit::Mm);
    setup.set_right_margin(SIDES_MM, gtk::Unit::Mm);
    let operation = webkit2gtk::PrintOperation::new(&webview);
    operation.set_page_setup(&setup);
    let window = webview
        .toplevel()
        .and_then(|w| w.downcast::<gtk::Window>().ok());
    operation.run_dialog(window.as_ref());
}
