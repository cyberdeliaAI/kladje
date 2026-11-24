"""Create the image and encoding fixtures for the Kladje Markdown test bundle.

Every image shows its own format and purpose, so a wrong or missing file is
obvious at a glance.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

root = sys.argv[1]
media = os.path.join(root, "media")
notes = os.path.join(root, "notes")
fixtures = os.path.join(root, "fixtures")
for folder in (media, os.path.join(media, "nested", "deeper"), notes, fixtures):
    os.makedirs(folder, exist_ok=True)

FONT = "/System/Library/Fonts/Helvetica.ttc"


def font(size, bold=False):
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def card(label, detail, colour, size=(480, 200)):
    width, height = size
    image = Image.new("RGB", size, colour)
    draw = ImageDraw.Draw(image)
    # A light grid so scaling and cropping are easy to spot.
    for x in range(0, width, 40):
        draw.line([(x, 0), (x, height)], fill=tuple(min(255, c + 18) for c in colour))
    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=tuple(min(255, c + 18) for c in colour))
    draw.rectangle([6, 6, width - 7, height - 7], outline="white", width=4)
    draw.ellipse([24, height // 2 - 34, 92, height // 2 + 34], fill="white")
    draw.text((58, height // 2), "K", font=font(44, True), fill=colour, anchor="mm")
    draw.text((112, height // 2 - 22), label, font=font(30, True), fill="white", anchor="lm")
    draw.text((112, height // 2 + 22), detail, font=font(18), fill="white", anchor="lm")
    draw.text((width - 16, height - 16), f"{width} × {height}", font=font(14), fill="white", anchor="rb")
    return image


TEAL, ORANGE, PURPLE = (18, 120, 120), (196, 92, 20), (102, 60, 160)
GREEN, GREY, BLUE, RED, OLIVE = (40, 128, 64), (88, 92, 100), (30, 90, 170), (170, 40, 50), (120, 110, 30)

card("PNG", "media/format-png.png", TEAL).save(os.path.join(media, "format-png.png"))
card("JPEG", "media/format-jpeg.jpg", ORANGE).save(os.path.join(media, "format-jpeg.jpg"), quality=85)
card("WebP", "media/format-webp.webp", PURPLE).save(os.path.join(media, "format-webp.webp"), quality=85)
frames = [card("GIF frame 1", "media/format-gif.gif", GREY), card("GIF frame 2", "animated, two frames", BLUE)]
frames[0].save(os.path.join(media, "format-gif.gif"), save_all=True, append_images=frames[1:], duration=700, loop=0)
card("Spaces", "media/photo with spaces.png", GREEN).save(os.path.join(media, "photo with spaces.png"))
card("Pasted", "Pasted image 20261124101500.png", GREY).save(os.path.join(media, "Pasted image 20261124101500.png"))
card("Unicode", "media/café-ünïcode.png", BLUE).save(os.path.join(media, "café-ünïcode.png"))
card("Nested", "media/nested/deeper/inner.png", RED).save(os.path.join(media, "nested", "deeper", "inner.png"))
card("HTML img", "width and height from HTML", OLIVE).save(os.path.join(media, "html-sized.png"))
card("Reference", "reference-style image", TEAL).save(os.path.join(media, "reference.png"))
card("Wide banner", "3000 px wide, should scale down", ORANGE, (3000, 220)).save(os.path.join(media, "wide-banner.png"))
card("Linked", "image inside a link", PURPLE).save(os.path.join(media, "linked.png"))

with open(os.path.join(media, "vector.svg"), "w", encoding="utf-8") as svg:
    svg.write(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">'
        '<rect width="480" height="200" rx="16" fill="#1e5aaa"/>'
        '<text x="240" y="110" fill="#fff" font-family="Helvetica" font-size="30" text-anchor="middle">SVG vector</text>'
        "</svg>\n"
    )
with open(os.path.join(media, "not-really.png"), "w", encoding="utf-8") as fake:
    fake.write("This is plain text with a .png extension. An application should not render it as an image.\n")

# Notes for relative links and wiki-links.
with open(os.path.join(notes, "Project Kestrel.md"), "w", encoding="utf-8") as note:
    note.write(
        "# Project Kestrel\n\nA small note that the main test document links to.\n\n"
        "## Field notes\n\nThe heading above is the target of a heading link.\n\n"
        "A paragraph that ends with a block identifier. ^kestrel-sighting\n\n"
        "## Équipe & planning\n\nA heading with an accent and an ampersand.\n"
    )
with open(os.path.join(notes, "meeting notes.md"), "w", encoding="utf-8") as note:
    note.write("# Meeting notes\n\nA file name with a space.\n")
with open(os.path.join(notes, "überblick.md"), "w", encoding="utf-8") as note:
    note.write("# Überblick\n\nA file name with a non-ASCII letter.\n")

# Encoding and line-ending fixtures, written as raw bytes on purpose.
def raw(name, data):
    with open(os.path.join(fixtures, name), "wb") as out:
        out.write(data)

body = "# {title}\n\nFirst line.\nSecond line with é, ü and 東京.\n\n- item one\n- item two\n"
raw("lf.md", body.format(title="LF line endings").encode("utf-8"))
raw("crlf.md", body.format(title="CRLF line endings").replace("\n", "\r\n").encode("utf-8"))
raw("cr-only.md", body.format(title="Classic Mac CR line endings").replace("\n", "\r").encode("utf-8"))
raw("mixed-endings.md", b"# Mixed line endings\r\n\nThis line ends with LF.\nThis line ends with CRLF.\r\nThis one with CR only.\rLast line.\n")
raw("utf8-bom.md", b"\xef\xbb\xbf" + body.format(title="UTF-8 with byte-order mark").encode("utf-8"))
raw("latin1.md", body.format(title="Latin-1 (ISO-8859-1) without CJK").replace(" en 東京", "").replace(" and 東京", "").encode("latin-1"))
raw("utf16le-bom.md", b"\xff\xfe" + body.format(title="UTF-16 little-endian").encode("utf-16-le"))
raw("no-final-newline.md", b"# No final newline\n\nThe last line has no line ending.")
raw("empty.md", b"")
raw("only-front-matter.md", b"---\ntitle: Only front matter\ntags: [empty, body]\n---\n")
raw("nul-byte.md", b"# Binary content\n\nA NUL byte follows: \x00 and the text continues.\n")

print("written to", root)
