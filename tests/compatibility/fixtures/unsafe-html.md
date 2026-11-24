# Unsafe HTML

Open this file on its own. Every tag below tries to take over the preview: navigate away, change the base for links, restyle the page or load something from the internet. A safe preview shows the text after each tag and nothing else happens. The targets are example.org and placehold.co, so nothing harmful loads even if a tag gets through.

## Navigation

<meta http-equiv="refresh" content="3; url=https://example.org/meta-refresh-ran">

<base href="https://example.org/base-tag-ran/">

[A relative link that a base tag would redirect](notes.md)

<a href="https://example.org/new-window" target="_blank">A link that asks for a new window</a>

## Embedded content

<object data="https://example.org/object-ran"></object>

<embed src="https://example.org/embed-ran">

<iframe srcdoc="<p>An iframe built from srcdoc</p><script>parent.document.title='srcdoc script ran'</script>"></iframe>

<svg width="200" height="40"><script>document.title = "SVG script ran";</script><text x="0" y="25">An SVG with a script</text></svg>

## Event handlers

<details open ontoggle="document.title='ontoggle ran'"><summary>A details element with ontoggle</summary>Text inside.</details>

<input autofocus onfocus="document.title='onfocus ran'" value="An autofocus input">

<div onmouseover="document.title='onmouseover ran'">Move the pointer over this line.</div>

## Requests to the internet

<img src="https://placehold.co/200x40/png?text=remote+img+tag" alt="A remote image through an HTML tag">

<img srcset="https://placehold.co/200x40/png?text=srcset 1x" alt="A remote image through srcset">

<div style="background-image: url('https://placehold.co/200x40/png?text=css+background'); height: 40px">A CSS background image</div>

<video poster="https://placehold.co/200x40/png?text=video+poster" width="200"></video>

<link rel="stylesheet" href="https://example.org/remote-stylesheet.css">

## Tags that swallow the rest

<xmp>An xmp element shows its content as raw text.</xmp>

<noembed>A noembed element.</noembed>

This line comes after the swallowing tags. If it is missing or shown as raw source, a tag took over the rest of the document.

<plaintext>A plaintext element turns everything after it into raw text in a browser.

This is the last line of the file.
