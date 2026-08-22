# BookOrbit open library plugins

Indexer plugins for [BookOrbit](https://github.com/bookorbit/bookorbit) covering open libraries:
sources that publish public domain works and ask nothing for them. BookOrbit ships the loader; these
are plugins, maintained separately.

| Plugin                | Media      | Credential | Source                                                           |
| --------------------- | ---------- | ---------- | ---------------------------------------------------------------- |
| **librivox**          | audiobooks | none       | Public domain audiobooks read by volunteers                      |
| **project-gutenberg** | ebooks     | none       | Around 75,000 public domain ebooks, produced rather than scanned |

Each file's header comment says what its source expects of a client. Read it before installing.

## Installing

Copy a plugin's directory into BookOrbit's app data and restart:

```
<APP_DATA_PATH>/plugins/indexers/<name>/index.mjs
```

`APP_DATA_PATH` is `/data` in the container, already mounted as a writable volume. Only `index.mjs`
is needed at runtime; `verify.mjs` and `fixtures/` are development files.

After the restart the plugin appears in the indexer type list under **Settings > System > Requests**
and is configured like any other indexer. Nothing is enabled until you add it there. There is no hot
reload, and a plugin that fails to load is reported at the top of that page.

## Trust

**A plugin runs inside the BookOrbit process, with that process's access:** your database, your
library files, your encryption key. Each plugin is a single dependency-free file so you can read it
before installing it.

BookOrbit enforces regardless: network access only through the host (private-address policy and
per-request deadline), no claiming a built-in adapter's name, refusal of a mismatched contract
version, re-validation of resolved URLs before a download client sees them, and plugin errors
surfacing as ordinary per-indexer failures.

## The plugins

**librivox** searches a published API. It matches on a title prefix with the leading article
stripped, so the plugin tries the stripped title first, then the title as it stands, then a
shortened form; it cannot search title and author together, so the author is left to BookOrbit's
scoring. A project arrives as one zip of per-chapter MP3s, which BookOrbit imports as a single
audiobook of ordered tracks. Sizes are estimated from the stated duration at 64kbps rather than
requested, which measured within 0.3% of the real file.

**project-gutenberg** searches the OPDS catalogue and confirms each result against its own record,
because roughly a fifth offer no file at all. It prefers the illustrated EPUB3; turn
`preferIllustrated` off for the smaller plain edition. Gutenberg asks not to be accessed by automated
tools, so installing it is a decision about your own address.

## Verifying

```bash
cd indexers/<name> && node verify.mjs
```

No network, no BookOrbit; exits non-zero on failure. Fixtures are live responses saved byte for byte,
line endings included, so a parser is tested against the markup it really has to survive. The one
edit made to them is that third-party contact addresses in page footers are replaced with
`redacted@example.invalid`.

## Contract

Plugins target `PLUGIN_API_VERSION` 1. Type definitions live in `@bookorbit/plugin-api` in the
BookOrbit repository; a plugin default-exports one object declaring what it is and how to search it.
The loader refuses a version it does not speak, so a contract bump means updating both repositories
together.
