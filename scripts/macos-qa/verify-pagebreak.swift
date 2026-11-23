// Print the actual standalone export with the same WKWebView print engine as
// Kladje. Use a private output URL and suppress all system print dialogs.
import AppKit
import PDFKit
import WebKit

guard CommandLine.arguments.count == 2 else { exit(2) }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = input.deletingLastPathComponent().appendingPathComponent("page-break-proof.pdf")
final class Proof: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.printPages(webView) }
    }
    private func printPages(_ webView: WKWebView) {
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.paperSize = NSSize(width: 595, height: 842)
        info.topMargin = 42
        info.bottomMargin = 42
        info.leftMargin = 42
        info.rightMargin = 42
        info.horizontalPagination = .fit
        info.dictionary()[NSPrintInfo.AttributeKey.allPages] = false
        info.dictionary()[NSPrintInfo.AttributeKey.firstPage] = 1
        info.dictionary()[NSPrintInfo.AttributeKey.lastPage] = 3
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = output
        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        operation.view?.frame = webView.bounds
        operation.canSpawnSeparateThread = true
        operation.runModal(for: window, delegate: self,
            didRun: #selector(finished(_:success:context:)), contextInfo: nil)
    }
    @objc func finished(_ operation: NSPrintOperation, success: Bool, context: UnsafeMutableRawPointer?) {
        guard success, let pdf = PDFDocument(url: output), pdf.pageCount == 2,
              pdf.page(at: 0)?.string?.contains("First proof page") == true,
              pdf.page(at: 0)?.string?.contains("Second proof page") == false,
              pdf.page(at: 1)?.string?.contains("Second proof page") == true else {
            fputs("Expected each proof heading on a separate PDF page.\n", stderr)
            exit(1)
        }
        print("Native WebKit printed both proof pages.")
        exit(0)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let bounds = NSRect(x: 0, y: 0, width: 650, height: 800)
let view = WKWebView(frame: bounds)
let window = NSWindow(contentRect: bounds, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = view
window.orderFront(nil)
let proof = Proof()
view.navigationDelegate = proof
view.loadFileURL(input, allowingReadAccessTo: input.deletingLastPathComponent())
_ = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { _ in exit(1) }
app.run()
