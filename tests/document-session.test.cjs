const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DocumentSession } = require("../ui/document-session.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let text = "original";
  const session = new DocumentSession(() => text);
  session.reset(text);
  return { session, edit(value) { text = value; session.changed(); } };
}

test("save A, type B, queue another Save and Quit", async () => {
  const { session, edit } = fixture();
  const started = deferred(), finish = deferred();
  const writes = [];
  edit("A");
  const first = session.run(async () => {
    const snapshot = session.snapshot();
    started.resolve();
    await finish.promise;
    writes.push(snapshot.content);
    assert.equal(session.acknowledge(snapshot), false);
    assert.equal(session.isDirty(), true);
  });
  await started.promise;
  edit("B");
  const second = session.run(() => {
    const snapshot = session.snapshot();
    writes.push(snapshot.content);
    assert.equal(session.acknowledge(snapshot), true);
  });
  const quit = session.run(() => {
    assert.equal(session.isDirty(), false);
    assert.deepEqual(writes, ["A", "B"]);
  });
  assert.deepEqual(writes, []);
  finish.resolve();
  await Promise.all([first, second, quit]);
});

test("failed writes stay dirty, undo compares to disk and other identities cannot be acknowledged", async () => {
  const { session, edit } = fixture();
  edit("changed");
  const stale = session.snapshot();
  await assert.rejects(session.run(() => { throw Error("disk full"); }));
  assert.equal(session.isDirty(), true);
  edit("original");
  assert.equal(session.isDirty(), false);
  session.reset("other", true);
  assert.equal(session.acknowledge(stale), false);
  assert.equal(session.isDirty(), true);
});
