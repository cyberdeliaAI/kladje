# Markdown compatibility check

Copy this entire folder to a writable location and open `kladje-markdown-test.md` in Kladje. Keep `media/`, `notes/` and `fixtures/` beside it so the relative links work. The images are already included. [Open the test document](kladje-markdown-test.md)

1. Start with remote images disabled. Compare the source and preview using the **Look for** notes. Some examples deliberately refer to missing files or contain unsupported syntax.
2. Export the copy to HTML and PDF for part K. For the encoding and line-ending checks in J4, edit copies of the individual fixture files and keep the originals for comparison.
3. Fill in the scorecard in your copy. Record the Kladje version, operating system and single-Return setting so someone else can repeat the run. Leave untested rows blank or mark them **–**.

The optional `make-fixtures.py` script regenerates the image cards, sample notes and encoding fixtures. It uses Pillow and the macOS Helvetica font. Give it a scratch directory as its argument because it writes files there.
