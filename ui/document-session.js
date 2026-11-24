// One document identity per load. File commands share an ordered queue, while
// typing remains synchronous and can continue during disk I/O.
class DocumentSession {
  constructor(readText, readLength = null) {
    this.readText = readText;
    this.readLength = readLength;
    this.queue = Promise.resolve();
    this.reset("");
  }

  reset(content, dirty = false, revision = 0) {
    this.document = { revision, saved: dirty ? null : content };
    this.cachedDirty = dirty;
    this.pending = null;
  }

  requireSave() {
    this.document.saved = null;
    this.cachedDirty = true;
  }

  changed() {
    this.document.revision++;
    this.cachedDirty = undefined;
  }

  beginWrite(snapshot) {
    this.pending = snapshot;
  }

  endWrite() {
    this.pending = null;
  }

  isDirty() {
    // An in-flight write can replace the old baseline even after Undo returns
    // to its text. Keep a recovery copy of that text until the writer settles.
    if (this.pending && !this.isCurrent(this.pending) && this.pending.content !== this.readText()) return true;
    if (this.cachedDirty === undefined) {
      const saved = this.document.saved;
      // Typing nearly always changes the length, which settles the question
      // without copying a large document out of the editor.
      this.cachedDirty = saved === null || (this.readLength !== null && saved.length !== this.readLength()) || saved !== this.readText();
    }
    return this.cachedDirty;
  }

  snapshot() {
    return { document: this.document, revision: this.document.revision, content: this.readText() };
  }

  isCurrent(snapshot) {
    return snapshot.document === this.document && snapshot.revision === this.document.revision;
  }

  acknowledge(snapshot) {
    if (snapshot.document !== this.document) return false;
    this.document.saved = snapshot.content;
    this.cachedDirty = this.isCurrent(snapshot) ? false : undefined;
    return !this.isDirty();
  }

  run(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
}

if (typeof module !== "undefined") module.exports = { DocumentSession };
