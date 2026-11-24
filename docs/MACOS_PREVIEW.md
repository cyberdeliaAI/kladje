# macOS preview qualification

The first preview candidate targets Apple silicon. Keep the signed disk image local until the owner approves distribution. Windows and Linux have CI compile coverage. Native use on either platform and Intel macOS remain unverified.

## Build and check a candidate

Install the prerequisites in the README, run `npm ci`, and run the JavaScript and Rust suites. On a logged-in Mac, also run the mounted exFAT test and the two isolated native workflows.

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml --all-targets --locked
scripts/test-exfat.sh
node scripts/macos-qa/run.mjs --paste --links
node scripts/macos-qa/run.mjs --windows
```

For a local distribution build, find the full **Developer ID Application** certificate name using `security find-identity -v -p codesigning`. The corresponding private key must be available in the build user's keychain. Set the name in the shell and run

```sh
export APPLE_SIGNING_IDENTITY='Developer ID Application: …'
node scripts/build-macos-preview.mjs
```

The script builds the app and DMG, signs the container, requires a Developer ID signature on both, verifies the disk image, mounts it read-only and compares a temporary installed copy with the build output. It checks the Applications shortcut. The usual README build still produces an ad-hoc development app. A fresh distribution build needs access to Apple's timestamp service. The signing script omits notarization credentials from the bundler environment. [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) · [Apple distribution packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

## Before sharing the disk image

1. Select a release commit and approve the distribution terms. Rebuild from that commit and record its SHA, architecture and disk-image checksum.
2. Submit the final signed DMG to Apple's notary service with the team's chosen keychain profile. Retain the submission ID and require an **Accepted** result. Staple and validate the ticket on that same DMG. Recompute its SHA-256 after stapling. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
3. Download a copy through a quarantine-aware browser on a clean Apple silicon Mac or fresh account. Check the published checksum, install through the Applications shortcut and launch normally with Gatekeeper enabled. In Finder choose Kladje as the default for a disposable Markdown file, open two files, and verify each arrives in its own document. Relaunch and verify a save and recovery. Repeat launch offline to exercise the stapled ticket.
4. With VoiceOver enabled, listen to editor, outline, divider and successive dirty-document prompts. Verify source/preview and sheet navigation with the keyboard. Exercise Japanese marked text while changing native tabs, mixed-direction caret movement and increased-contrast legibility. Record the OS, input method and actual outcome.

For an approved submission with credentials already stored in Keychain, use the following commands. Replace the path and profile with the intended artifact and local profile name.

```sh
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
# Continue only after Apple reports Accepted.
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
shasum -a 256 "$DMG"
```

## Scope of the evidence

The acceptance log records native and measured results. Physical unplug or power loss, network filesystems, extended writing sessions and first launch on other macOS versions remain unqualified. A mounted exFAT image verifies in-place saving without atomic exchange; it cannot reproduce the loss of a physical device. Populated telephone handoff and the complete recipient round-trip through a user's mail client also remain open. [Acceptance evidence](planning/P1_ACCEPTANCE.md#macos-preview-qualification)
