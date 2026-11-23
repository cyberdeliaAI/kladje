// Check a PDF saved by the system print dialog from the native QA fixture.
import Foundation
import PDFKit

guard CommandLine.arguments.count == 2, let pdf = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(2) }
func hasEmbeddedImage(_ page: PDFPage) -> Bool {
    guard let pageDictionary = page.pageRef?.dictionary else { return false }
    var resources: CGPDFDictionaryRef?
    var objects: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(pageDictionary, "Resources", &resources), let resources,
          CGPDFDictionaryGetDictionary(resources, "XObject", &objects), let objects else { return false }
    var found = false
    CGPDFDictionaryApplyBlock(objects, { _, object, _ in
        var stream: CGPDFStreamRef?
        var kind: UnsafePointer<CChar>?
        if CGPDFObjectGetValue(object, .stream, &stream), let stream,
           let dict = CGPDFStreamGetDictionary(stream), CGPDFDictionaryGetName(dict, "Subtype", &kind),
           let kind, String(cString: kind) == "Image" { found = true }
        return !found
    }, nil)
    return found
}

let text = (0..<pdf.pageCount).compactMap { pdf.page(at: $0)?.string }.joined(separator: "\n")
let links = (0..<pdf.pageCount).flatMap { pdf.page(at: $0)?.annotations ?? [] }
let printedWebsite = links.contains { $0.url?.host == "example.com" || ($0.action as? PDFActionURL)?.url?.host == "example.com" }
guard pdf.pageCount > 1, let first = pdf.page(at: 0), hasEmbeddedImage(first), text.contains("Native print check"), text.contains("End of document."),
      printedWebsite, text.contains("CODE_END"), text.contains("Data 8"),
      (1...70).allSatisfy({ text.contains("Paragraph \($0).") }), !text.contains("](figure.png)") else {
    print("Incomplete print output across \(pdf.pageCount) pages.")
    exit(1)
}
print("Verified the external URL, table, code, image and all 70 paragraphs across \(pdf.pageCount) pages.")
